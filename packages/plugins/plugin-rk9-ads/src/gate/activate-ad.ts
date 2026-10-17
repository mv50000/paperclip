/**
 * The activate_ad gate handler (A9, RK9-517): the only code that sets an ad,
 * ad set or campaign ACTIVE (G1). It runs once, after an approver tapped
 * "📣 Aktivoi mainos" and the card moved pending -> approved (the kit's
 * callback router has checked the chat, the approver allowlist against the
 * saved config, and the card's validity).
 *
 * Order:
 * 1. the brand config and the card's binding (publication, ad, creative);
 * 2. preflight, re-run now (assertLaunchReady with no cache);
 * 3. fresh Meta reads: the ad set's ads, the ad set, the campaign. The ad
 *    must still carry the creative the card showed (a swap since the card
 *    was sent refuses). ⚠ states (ARCHIVED, DELETED, an effective_status
 *    outside the allowed set) refuse and are reported, never fixed;
 * 4. the spend guard (checkSpend) for every object this run activates;
 * 5. writes: the ad ACTIVE, every other ACTIVE ad of the ad set PAUSED
 *    (newest wins), the ad set and then the campaign ACTIVE when PAUSED.
 *    Each write passes the spend guard hook again, and the hook lets
 *    through only ACTIVE writes on the objects this run named;
 * 6. a last read: the ad must still carry the approved creative, otherwise
 *    it is paused again and the card fails.
 *
 * A refusal in 1-4 makes no Meta write and ends the card `denied`. A failed
 * write ends it `failed` with the step reached; nothing is retried. Meta's
 * steps are not one transaction, so a failure part way can leave two ads of
 * the ad set ACTIVE or the ad ACTIVE under a PAUSED ad set: the card and the
 * outcome name exactly what was done.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import type { Ledger } from "../db.js";
import { checkSpend as defaultCheckSpend, type GuardResult, type ProposedChange } from "../features/spend-guard/guard.js";
import { brandClient, safeError, type Initiator } from "../features/spend-guard/support.js";
import type { GateHandler, GateHandlerResult } from "../kit/gate/registry.js";
import type { GateRequestRecord } from "../kit/gate/state-machine.js";
import type { MetaGraphClient } from "../meta/graph.js";
import { isDryRun } from "../meta/types.js";
import { getAdSet, getCampaign, listAdSetAds, setObjectStatus } from "../meta/methods.js";
import type { Ad, StatusRow } from "../meta/types.js";
import { activationOf, type ActivationBinding, type ActivationGateRepo } from "./gate-requests.js";

export const GATE_ACTIVATION_ACTIVITY = "rk9-ads gate: activate_ad";

/** effective_status values an object may have when it is activated. Anything else is a ⚠ state. */
export const ACTIVATABLE_EFFECTIVE_STATUS = {
  ad: ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED"],
  adset: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS"],
  campaign: ["ACTIVE", "PAUSED", "IN_PROCESS"],
} as const;
const GONE_STATUSES = new Set(["ARCHIVED", "DELETED"]);

export type ActivationStep = "ad_active" | "pause_others" | "adset_active" | "campaign_active" | "verify_creative";

export interface ActivateAdDeps {
  ctx: Pick<PluginContext, "activity" | "logger">;
  repo: ActivationGateRepo;
  loadConfig(companyId: string): Promise<{ ok: true; config: BrandConfig } | { ok: false; error: string }>;
  /** Preflight (A4), re-run without a cache. Throws when the brand is not launch-ready. */
  assertLaunchReady(companyId: string, config: BrandConfig): Promise<void>;
  readClient(companyId: string, config: BrandConfig): MetaGraphClient;
  /**
   * The write client of one activation. `allowed` names the objects this run
   * may set ACTIVE; the spend guard hook still checks each write.
   */
  activationClient(companyId: string, config: BrandConfig, initiator: Initiator, allowed: ReadonlySet<string>): MetaGraphClient;
  checkSpend?: typeof defaultCheckSpend;
  now?: () => Date;
}

/**
 * The brand's write client for one activation (the only `authorizeSpend` in
 * the plugin): ACTIVE on the named objects, no budget field, nothing else.
 */
export function createActivationClient(
  deps: { ctx: PluginContext; ledger: Ledger },
  companyId: string,
  config: BrandConfig,
  initiator: Initiator,
  allowed: ReadonlySet<string>,
): MetaGraphClient {
  const objects = new Set(allowed);
  return brandClient(deps, companyId, config, "live", {
    initiator,
    authorizeSpend: (_plan, change) => {
      const budget = change.dailyBudgetCents !== undefined || change.lifetimeBudgetCents !== undefined;
      if (change.activate && !budget && change.objectId !== null && objects.has(change.objectId)) return { allow: true };
      return { allow: false, reason: "the activation gate allows only ACTIVE on the approved ad, its ad set and its campaign" };
    },
  });
}

interface Denial {
  reason: string;
  detail: string;
  /** Card lines (Finnish). */
  lines: string[];
  warnings?: string[];
  guard?: Partial<GuardResult>;
}

const REASON_TEXT: Record<string, string> = {
  invalid_binding: "kortin tiedot ovat puutteelliset",
  config_unavailable: "brändin asetuksia ei voitu lukea",
  brand_changed: "kortti kuuluu toiselle brändille",
  preflight_failed: "esitarkistus (preflight) ei mennyt läpi",
  meta_read_failed: "Metan tilaa ei voitu lukea",
  ad_not_in_adset: "mainosta ei löydy ad setistä",
  object_not_in_account: "ad set ei kuulu brändin mainostiliin",
  campaign_changed: "ad set on siirtynyt toiseen kampanjaan",
  creative_changed: "mainoksen creative on vaihtunut kortin lähettämisen jälkeen",
  blocked_state: "mainoksen, ad setin tai kampanjan tila estää aktivoinnin",
  spend_guard: "kulutusvahti esti aktivoinnin",
};

function eur(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} €` : "?";
}

/** The ⚠ states of the objects, as card lines. Empty when activation may go on. */
export function blockedStates(ad: StatusRow, adset: StatusRow, campaign: StatusRow | null): string[] {
  const out: string[] = [];
  const check = (label: string, object: StatusRow, allowed: readonly string[]) => {
    if (GONE_STATUSES.has(object.status)) out.push(`⚠️ ${label} ${object.id}: status ${object.status}`);
    else if (!allowed.includes(object.effectiveStatus)) out.push(`⚠️ ${label} ${object.id}: effective_status ${object.effectiveStatus}`);
  };
  check("Mainos", ad, ACTIVATABLE_EFFECTIVE_STATUS.ad);
  check("Ad set", adset, ACTIVATABLE_EFFECTIVE_STATUS.adset);
  if (campaign) check("Kampanja", campaign, ACTIVATABLE_EFFECTIVE_STATUS.campaign);
  return out;
}

function guardSummary(result: GuardResult): Partial<GuardResult> {
  return {
    reason: result.reason,
    month: result.month,
    monthlyCapEur: result.monthlyCapEur,
    mtdEur: result.mtdEur,
    projectedMonthEndEur: result.projectedMonthEndEur,
    spendCapEur: result.spendCapEur,
    headroomEur: result.headroomEur,
  };
}

export function createActivateAdHandler(deps: ActivateAdDeps): GateHandler {
  const check = deps.checkSpend ?? defaultCheckSpend;
  const now = deps.now ?? (() => new Date());

  async function audit(request: GateRequestRecord, result: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await deps.ctx.activity.log({
        companyId: request.companyId,
        message: `${GATE_ACTIVATION_ACTIVITY} ${result}`,
        entityType: "gate_request",
        entityId: request.id,
        metadata,
      });
    } catch (error) {
      deps.ctx.logger.warn("rk9-ads gate: activity log failed", { gateRequestId: request.id, detail: safeError(error) });
    }
  }

  async function deny(request: GateRequestRecord, decidedBy: Record<string, unknown>, binding: ActivationBinding | null, denial: Denial): Promise<GateHandlerResult> {
    const outcome = {
      handler: "done",
      result: "denied",
      reason: denial.reason,
      detail: denial.detail,
      decidedBy,
      decidedAt: now().toISOString(),
      adId: binding?.adId ?? null,
      pausedAdIds: [],
      ...(denial.warnings?.length ? { warnings: denial.warnings } : {}),
      ...(denial.guard ? { guard: denial.guard } : {}),
    };
    const meta = { companyId: request.companyId, gateRequestId: request.id, reason: denial.reason, detail: denial.detail };
    if (denial.warnings?.length) deps.ctx.logger.warn("rk9-ads gate: activation refused", meta);
    else deps.ctx.logger.info("rk9-ads gate: activation refused", meta);
    await audit(request, "denied", outcome);
    const head = `⛔ Ei aktivoitu: ${REASON_TEXT[denial.reason.split(":")[0]!] ?? denial.reason}`;
    return {
      status: "denied",
      statusText: [head, ...denial.lines, "Mainos jäi PAUSED-tilaan."].join("\n"),
      outcome,
      error: `${denial.reason}: ${denial.detail}`.slice(0, 300),
    };
  }

  return async ({ request, tgUserId }) => {
    // No pairing source maps a Telegram user to a company member in the plugin (core owns chat pairing).
    const decidedBy = { tgUserId, memberUserId: null };
    const binding = activationOf(request);
    if (!binding) return deny(request, decidedBy, null, { reason: "invalid_binding", detail: "payload.activation is missing or malformed", lines: [] });
    const { companyId } = request;

    const loaded = await deps.loadConfig(companyId);
    if (!loaded.ok) return deny(request, decidedBy, binding, { reason: "config_unavailable", detail: loaded.error, lines: [] });
    const config = loaded.config;
    if (config.brandCode !== request.brandCode) {
      return deny(request, decidedBy, binding, { reason: "brand_changed", detail: `card ${request.brandCode}, config ${config.brandCode}`, lines: [] });
    }

    try {
      await deps.assertLaunchReady(companyId, config);
    } catch (error) {
      return deny(request, decidedBy, binding, { reason: "preflight_failed", detail: safeError(error), lines: [safeError(error).slice(0, 200)] });
    }

    const read = deps.readClient(companyId, config);
    let ads: Ad[];
    let adset: Awaited<ReturnType<typeof getAdSet>>;
    let campaign: Awaited<ReturnType<typeof getCampaign>> | null = null;
    try {
      ads = await listAdSetAds(read, binding.adsetId);
      adset = await getAdSet(read, binding.adsetId);
      const campaignId = adset.campaignId ?? binding.campaignId;
      if (campaignId) campaign = await getCampaign(read, campaignId);
    } catch (error) {
      return deny(request, decidedBy, binding, { reason: "meta_read_failed", detail: safeError(error), lines: [] });
    }
    const target = ads.find((ad) => ad.id === binding.adId);
    if (!target) {
      return deny(request, decidedBy, binding, {
        reason: "ad_not_in_adset",
        detail: `ad ${binding.adId} is not listed in ad set ${binding.adsetId}`,
        lines: [`⚠️ Mainos ${binding.adId} puuttuu ad setistä ${binding.adsetId}`],
        warnings: ["ad_not_in_adset"],
      });
    }
    if (adset.accountId !== config.meta.adAccountId) {
      return deny(request, decidedBy, binding, { reason: "object_not_in_account", detail: `ad set ${adset.id} account ${adset.accountId ?? "?"}`, lines: [] });
    }
    if (binding.campaignId && adset.campaignId && adset.campaignId !== binding.campaignId) {
      return deny(request, decidedBy, binding, {
        reason: "campaign_changed",
        detail: `ad set ${adset.id} is under campaign ${adset.campaignId}, the card named ${binding.campaignId}`,
        lines: [],
      });
    }
    if (target.creativeId !== binding.creativeId) {
      return deny(request, decidedBy, binding, {
        reason: "creative_changed",
        detail: `ad ${target.id} carries creative ${target.creativeId ?? "none"}, the card showed ${binding.creativeId}`,
        lines: ["Lähetä uusi kortti uudesta creativesta."],
      });
    }
    const warnings = blockedStates(target, adset, campaign);
    if (warnings.length > 0) {
      return deny(request, decidedBy, binding, { reason: "blocked_state", detail: warnings.join("; "), lines: warnings, warnings });
    }

    // Every object this run activates, budget holders first: the guard projects each.
    const activate: Array<{ id: string; level: ProposedChange["level"]; step: ActivationStep }> = [];
    if (adset.status === "PAUSED") activate.push({ id: adset.id, level: "adset", step: "adset_active" });
    if (campaign && campaign.status === "PAUSED") activate.push({ id: campaign.id, level: "campaign", step: "campaign_active" });
    activate.push({ id: target.id, level: "ad", step: "ad_active" });
    let lastGuard: GuardResult | null = null;
    for (const object of activate) {
      const result = await check({ config, client: read, now: now(), change: { objectId: object.id, level: object.level, activate: true } });
      lastGuard = result;
      if (!result.allow) {
        return deny(request, decidedBy, binding, {
          reason: `spend_guard:${result.reason}`,
          detail: result.detail,
          lines: [
            `${result.reason}: ${result.detail}`.slice(0, 300),
            `Kulutus ${result.month ?? ""}: ${eur(result.mtdEur)} / ${eur(result.monthlyCapEur)}, ennuste ${eur(result.projectedMonthEndEur)}`,
          ],
          guard: guardSummary(result),
        });
      }
    }

    const initiator: Initiator = { source: "telegram", tgUserId };
    const write = deps.activationClient(companyId, config, initiator, new Set(activate.map((object) => object.id)));
    const done: ActivationStep[] = [];
    const pausedAdIds: string[] = [];
    let step: ActivationStep = "ad_active";
    const setStatus = async (objectId: string, next: "ACTIVE" | "PAUSED") => {
      const result = await setObjectStatus(write, objectId, next);
      if (isDryRun(result)) throw new Error("the activation client is in dry-run mode");
      if (!result.success) throw new Error(`Meta did not confirm status ${next} on ${objectId}`);
    };
    let creativeAfter: string | null | undefined;
    try {
      if (target.status !== "ACTIVE") await setStatus(target.id, "ACTIVE");
      done.push("ad_active");
      step = "pause_others";
      for (const other of ads) {
        if (other.id === target.id || other.status !== "ACTIVE") continue;
        await setStatus(other.id, "PAUSED");
        pausedAdIds.push(other.id);
      }
      done.push("pause_others");
      step = "adset_active";
      if (adset.status === "PAUSED") {
        await setStatus(adset.id, "ACTIVE");
        done.push("adset_active");
      }
      step = "campaign_active";
      if (campaign && campaign.status === "PAUSED") {
        await setStatus(campaign.id, "ACTIVE");
        done.push("campaign_active");
      }
      step = "verify_creative";
      creativeAfter = (await listAdSetAds(read, binding.adsetId)).find((ad) => ad.id === target.id)?.creativeId;
      if (creativeAfter !== binding.creativeId) {
        // A swap raced the activation: the approved content is not what runs. Stop it.
        await setStatus(target.id, "PAUSED");
        throw new Error(`ad ${target.id} carries creative ${creativeAfter ?? "none"} after activation, not the approved ${binding.creativeId}; it was paused again`);
      }
      done.push("verify_creative");
    } catch (error) {
      const detail = safeError(error);
      await saveSafely(request, pausedAdIds);
      const outcome = {
        handler: "done",
        result: "failed",
        step,
        done,
        detail,
        decidedBy,
        decidedAt: now().toISOString(),
        adId: target.id,
        pausedAdIds,
        creativeId: binding.creativeId,
      };
      deps.ctx.logger.error("rk9-ads gate: activation failed part way", { companyId, gateRequestId: request.id, step, done, detail });
      await audit(request, "failed", outcome);
      return {
        status: "failed",
        statusText: [
          `⚠️ Aktivointi keskeytyi vaiheessa ${step}: ${detail.slice(0, 200)}`,
          `Tehty: ${done.length > 0 ? done.join(", ") : "ei mitään"}`,
          `Pysäytetyt mainokset: ${pausedAdIds.length > 0 ? pausedAdIds.join(", ") : "ei yhtään"}`,
          "Tarkista tila Metassa. Mitään ei yritetä uudelleen automaattisesti.",
        ].join("\n"),
        outcome,
        error: `${step}: ${detail}`.slice(0, 300),
      };
    }

    await saveSafely(request, pausedAdIds);
    const outcome = {
      handler: "done",
      result: "activated",
      decidedBy,
      decidedAt: now().toISOString(),
      adId: target.id,
      adsetId: adset.id,
      campaignId: campaign?.id ?? null,
      creativeId: binding.creativeId,
      contentHash: binding.contentHash,
      publicationId: binding.publicationId,
      pausedAdIds,
      activated: done.filter((entry) => entry === "ad_active" || entry === "adset_active" || entry === "campaign_active"),
      ...(lastGuard ? { guard: guardSummary(lastGuard) } : {}),
    };
    await audit(request, "activated", outcome);
    const lines = [
      `✅ Mainos aktivoitu: ${target.id}`,
      `Pysäytetyt mainokset: ${pausedAdIds.length > 0 ? pausedAdIds.join(", ") : "ei yhtään"}`,
    ];
    if (done.includes("adset_active")) lines.push(`Ad set ${adset.id} aktivoitu`);
    if (done.includes("campaign_active") && campaign) lines.push(`Kampanja ${campaign.id} aktivoitu`);
    return { statusText: lines.join("\n"), outcome };
  };

  async function saveSafely(request: GateRequestRecord, pausedAdIds: string[]): Promise<void> {
    try {
      await deps.repo.setPausedAdIds(request.companyId, request.id, pausedAdIds);
    } catch (error) {
      deps.ctx.logger.error("rk9-ads gate: paused_ad_ids not stored", { gateRequestId: request.id, detail: safeError(error) });
    }
  }
}
