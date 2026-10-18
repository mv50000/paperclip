/**
 * The activate_ad gate handler (A9, RK9-517): the only code that sets an ad,
 * ad set or campaign ACTIVE (G1). It runs once, after an approver tapped
 * "📣 Aktivoi mainos" and the card moved pending -> approved (the kit's
 * callback router has checked the chat, the approver allowlist against the
 * saved config, and the card's validity).
 *
 * Order:
 * 1. the brand config and the card's binding (publication, ad, creative).
 *    The publication that owns the ad now must be the card's, with the same
 *    contentHash and Meta creative (RK9-557);
 * 2. preflight, re-run now (assertLaunchReady with no cache);
 * 3. fresh Meta reads: the ad set's ads, the ad set, the campaign. The ad
 *    must still carry the creative the card showed (a swap since the card
 *    was sent refuses). ⚠ states (ARCHIVED, DELETED, an effective_status
 *    outside the allowed set) refuse and are reported, never fixed;
 * 4. the spend guard (checkSpend) for every object this run activates;
 *    then the halt in force (RK9-557, RK9-561): the kill switch's, the
 *    scheduled pause's or the cap pause's, and the ad's own pause-ad halt
 *    (RK9-566). While one is set, or when the halts cannot be read, nothing
 *    is written;
 * 5. writes: the ad ACTIVE, every other ACTIVE ad of the ad set PAUSED
 *    (newest wins), the ad set and then the campaign ACTIVE when PAUSED.
 *    Each write passes the spend guard hook again, and the hook lets
 *    through only ACTIVE writes on the objects this run named;
 *    Every ACTIVE write reads the halt again first;
 * 6. a last read: the ad must still carry the approved creative, otherwise
 *    (or when the read fails) it is paused again and the card fails;
 * 7. the halt once more: a pause that started during the writes set
 *    it before its own first pause, so either its listing sees this run's
 *    ACTIVE objects, or this read sees the halt. Every halt read counts a
 *    halt that has been in force at any time since the handler started,
 *    so a run that stalls past a timed halt's end (the 30-minute pause-ad
 *    halt) still sees it (RK9-567). A halt seen during or after
 *    the writes pauses again everything this run set ACTIVE (an ad that was
 *    ACTIVE already is not this run's, RK9-565). When Meta refuses one of
 *    those PAUSED writes, the object is stored for the scheduled-pause job's
 *    retry and one Telegram alert goes out (spend-guard/pending-undo.ts).
 *    The retry goes on after the halt ends, until Meta confirms, a newer
 *    activation supersedes it or a board user acknowledges it.
 *
 * A refusal in 1-4 makes no Meta write and ends the card `denied`. A failed
 * write ends it `failed` with the step reached; nothing is retried, except a
 * failed undo after a halt (step 7). Meta's
 * steps are not one transaction, so a failure part way can leave two ads of
 * the ad set ACTIVE or the ad ACTIVE under a PAUSED ad set: the card and the
 * outcome name exactly what was done.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import type { Ledger } from "../db.js";
import { checkSpend as defaultCheckSpend, type GuardResult, type ProposedChange } from "../features/spend-guard/guard.js";
import { AD_HALT_RULE, type AdHaltState, type HaltRule, type HaltState } from "../features/spend-guard/halt.js";
import type { UndoFailure, UndoReport } from "../features/spend-guard/pending-undo.js";
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

export type ActivationStep = "ad_active" | "pause_others" | "adset_active" | "campaign_active" | "verify_creative" | "verify_halt";

/** The publication that owns an ad now (publish/store.ts findByAd). */
export interface AdOwner {
  id: string;
  contentHash: string;
  metaCreativeId: string | null;
}

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
  /**
   * The halt in force (spend-guard/halt.ts), or with `since` one that has
   * been in force at any time since then: one that ended after `since`
   * counts. Throws when it cannot be read.
   */
  haltOf(companyId: string, since?: Date): Promise<HaltState | null>;
  /** The ad's pause-ad halt (spend-guard/halt.ts readAdHalt), read like `haltOf`. Throws when it cannot be read. */
  adHaltOf?(companyId: string, adId: string, since?: Date): Promise<AdHaltState | null>;
  /** The latest published or swapped publication of the ad, or null. */
  publicationOf(companyId: string, adId: string): Promise<AdOwner | null>;
  /**
   * An undo PAUSED write after a halt failed: store the objects for the
   * retry and alert (spend-guard/pending-undo.ts). Must not throw.
   */
  onUndoFailed?(
    companyId: string,
    config: BrandConfig,
    input: { gateRequestId: string; haltRule: HaltRule | null; failed: readonly UndoFailure[] },
  ): Promise<UndoReport>;
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
  /** The card's head text, when the reason's own text is not specific enough. */
  head?: string;
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
  publication_unavailable: "mainoksen julkaisua ei voitu lukea",
  content_changed: "mainoksen julkaisu tai sisältö on vaihtunut kortin lähettämisen jälkeen",
  halted: "hätäkatkaisin on painettu: pysäytystila on päällä, kunnes board poistaa sen",
  "halted:scheduled_pause": "ajastettu pysäytys on päällä: pysäytystila on voimassa aamuun asti, ellei board poista sitä",
  "halted:pause_all_cap": "kulutuskatto 90 % ylittyi: pysäytystila on voimassa kuun loppuun, ellei board poista sitä",
  "halted:pause_ad": "mainos pysäytettiin käyttöliittymästä: sen pysäytystila on voimassa hetken, ellei board poista sitä",
  halt_unreadable: "pysäytystilaa ei voitu lukea",
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

/** The halt was set (or could not be read: `halt` null) after the first write began. */
class HaltedError extends Error {
  constructor(
    message: string,
    readonly halt: HaltState | AdHaltState | null,
  ) {
    super(message);
  }
}

function haltLine(halt: HaltState | AdHaltState): string {
  return `Pysäytystila ${halt.since}${halt.until ? `–${halt.until}` : ""}: ${halt.reason}`.slice(0, 300);
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
    const head = `⛔ Ei aktivoitu: ${denial.head ?? REASON_TEXT[denial.reason.split(":")[0]!] ?? denial.reason}`;
    return {
      status: "denied",
      statusText: [head, ...denial.lines, "Mainos jäi PAUSED-tilaan."].join("\n"),
      outcome,
      error: `${denial.reason}: ${denial.detail}`.slice(0, 300),
    };
  }

  return async ({ request, tgUserId }) => {
    // The halt reads look back to here: a halt that ended while this run stalled still stops it (RK9-567).
    const startedAt = now();
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

    // The approval is bound to the publication's content, not only to the Meta creative id.
    let owner: AdOwner | null;
    try {
      owner = await deps.publicationOf(companyId, binding.adId);
    } catch (error) {
      return deny(request, decidedBy, binding, { reason: "publication_unavailable", detail: safeError(error), lines: [] });
    }
    if (
      !owner ||
      owner.id !== binding.publicationId ||
      owner.contentHash !== binding.contentHash ||
      (owner.metaCreativeId !== null && owner.metaCreativeId !== binding.creativeId)
    ) {
      return deny(request, decidedBy, binding, {
        reason: "content_changed",
        detail: owner
          ? `ad ${binding.adId} belongs to publication ${owner.id} (content ${owner.contentHash.slice(0, 12)}), the card showed ${binding.publicationId} (content ${binding.contentHash.slice(0, 12)})`
          : `no published publication owns ad ${binding.adId}`,
        lines: ["Lähetä uusi kortti nykyisestä julkaisusta."],
      });
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

    // The company's halts and the ad's own, read right before the first write.
    const haltNow = async (): Promise<HaltState | AdHaltState | null> => {
      try {
        // The earlier of the start and now: a worker clock stepped back must not skip a halt that is in force now.
        const since = new Date(Math.min(startedAt.getTime(), now().getTime()));
        return (await deps.haltOf(companyId, since)) ?? (deps.adHaltOf ? await deps.adHaltOf(companyId, binding.adId, since) : null);
      } catch (error) {
        throw new HaltedError(`the halt could not be read (${safeError(error)})`, null);
      }
    };
    try {
      const halt = await haltNow();
      if (halt) {
        return deny(request, decidedBy, binding, {
          reason: "halted",
          detail: `${halt.rule} halt since ${halt.since}${halt.until ? ` until ${halt.until}` : ""}: ${halt.reason}`,
          lines: [haltLine(halt)],
          head: REASON_TEXT[`halted:${halt.rule}`] ?? REASON_TEXT.halted,
        });
      }
    } catch (error) {
      return deny(request, decidedBy, binding, { reason: "halt_unreadable", detail: safeError(error), lines: [] });
    }
    const assertNotHalted = async () => {
      const halt = await haltNow();
      if (halt) throw new HaltedError(`the ${halt.rule} halt was set during the activation (${halt.since})`, halt);
    };

    const initiator: Initiator = { source: "telegram", tgUserId };
    const write = deps.activationClient(companyId, config, initiator, new Set(activate.map((object) => object.id)));
    const done: ActivationStep[] = [];
    const pausedAdIds: string[] = [];
    let step: ActivationStep = "ad_active";
    const setStatus = async (objectId: string, next: "ACTIVE" | "PAUSED") => {
      if (next === "ACTIVE") await assertNotHalted();
      const result = await setObjectStatus(write, objectId, next);
      if (isDryRun(result)) throw new Error("the activation client is in dry-run mode");
      if (!result.success) throw new Error(`Meta did not confirm status ${next} on ${objectId}`);
    };
    let creativeAfter: string | null | undefined;
    try {
      // An ad that was ACTIVE already is not this run's: an undo leaves it as it was.
      if (target.status !== "ACTIVE") {
        await setStatus(target.id, "ACTIVE");
        done.push("ad_active");
      }
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
      try {
        creativeAfter = (await listAdSetAds(read, binding.adsetId)).find((ad) => ad.id === target.id)?.creativeId;
      } catch (error) {
        // The approved content cannot be confirmed: stop the ad rather than leave it running unchecked.
        let paused = "it was paused again";
        try {
          await setStatus(target.id, "PAUSED");
        } catch (pauseError) {
          paused = `pausing it failed too (${safeError(pauseError)})`;
        }
        throw new Error(`the creative of ad ${target.id} could not be read after activation (${safeError(error)}); ${paused}`);
      }
      if (creativeAfter !== binding.creativeId) {
        // A swap raced the activation: the approved content is not what runs. Stop it.
        await setStatus(target.id, "PAUSED");
        throw new Error(`ad ${target.id} carries creative ${creativeAfter ?? "none"} after activation, not the approved ${binding.creativeId}; it was paused again`);
      }
      done.push("verify_creative");
      step = "verify_halt";
      await assertNotHalted();
      done.push("verify_halt");
    } catch (error) {
      let detail = safeError(error);
      const undoFailed: UndoFailure[] = [];
      let undoReport: UndoReport | null = null;
      if (error instanceof HaltedError) {
        // A pause won the race: pause what this run set ACTIVE (campaign first),
        // rather than leave it to the pause's listing, which may have run before these writes.
        const undo: Array<[string, UndoFailure["kind"], string]> = [];
        if (done.includes("campaign_active") && campaign) undo.push(["campaign", "campaign", campaign.id]);
        if (done.includes("adset_active")) undo.push(["ad set", "adset", adset.id]);
        if (done.includes("ad_active")) undo.push(["ad", "ad", target.id]);
        for (const [label, kind, objectId] of undo) {
          try {
            await setStatus(objectId, "PAUSED");
            detail = `${detail}; the ${label} was paused again`;
          } catch (pauseError) {
            detail = `${detail}; pausing the ${label} ${objectId} failed too (${safeError(pauseError)})`;
            undoFailed.push({ kind, objectId, error: safeError(pauseError) });
          }
        }
        // It may stay ACTIVE: the pause that won does not run again (RK9-565).
        if (undoFailed.length > 0) {
          // The pause-ad halt is the operator's manual stop: its undo rows are kill_switch rows, like the pause's own (ui-pause-ad).
          const haltRule = error.halt ? (error.halt.rule === AD_HALT_RULE ? "kill_switch" : error.halt.rule) : null;
          const report = deps.onUndoFailed?.(companyId, config, { gateRequestId: request.id, haltRule, failed: undoFailed });
          undoReport = report
            ? await report.catch((reportError: unknown): UndoReport => ({ stored: false, telegram: "failed", error: safeError(reportError) }))
            : { stored: false, telegram: "skipped", error: "no undo retry is wired" };
        }
      }
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
        ...(undoFailed.length > 0 ? { undoFailed, undoRetry: undoReport } : {}),
      };
      deps.ctx.logger.error("rk9-ads gate: activation failed part way", { companyId, gateRequestId: request.id, step, done, detail, undoFailed, undoRetry: undoReport });
      await audit(request, "failed", outcome);
      const undoLines =
        undoFailed.length === 0
          ? ["Tarkista tila Metassa. Mitään ei yritetä uudelleen automaattisesti."]
          : [
              `⚠️ Peruutus epäonnistui, voi olla yhä ACTIVE: ${undoFailed.map((entry) => entry.objectId).join(", ")}`,
              undoReport?.stored
                ? "Peruutusta yritetään uudelleen 5 minuutin välein, kunnes Meta vahvistaa pysäytyksen, uudempi aktivointi hyväksytään tai board kuittaa sen. Tarkista tila Metassa."
                : "Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa.",
            ];
      return {
        status: "failed",
        statusText: [
          `⚠️ Aktivointi keskeytyi vaiheessa ${step}: ${detail.slice(0, 200)}`,
          `Tehty: ${done.length > 0 ? done.join(", ") : "ei mitään"}`,
          `Pysäytetyt mainokset: ${pausedAdIds.length > 0 ? pausedAdIds.join(", ") : "ei yhtään"}`,
          ...undoLines,
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
