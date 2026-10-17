/**
 * The activation card's life cycle outside a tap (A9, RK9-517):
 * - `openActivationCard`: the publish hand-off (G15). Posts the staging card
 *   (photo or video preview, copy, ad name, ad set, daily budget, MTD against
 *   monthlyCapEur) with "📣 Aktivoi mainos" and "🗑 Ohita" to the brand's
 *   chat. An older open card of the same ad is closed first.
 * - `closeCardsForSwap`: a creative swap closes the ad's open cards, and
 *   refuses while an approved activation of the ad is running.
 * - `closeCardsForPause`: the kill switch, the 90 % cap pause and the
 *   scheduled pause close every open card of the company, so a tap after a
 *   pause cannot undo it (RK9-557).
 * - `expireDueCards`: the gate-expiry job. Cards past valid_until move to
 *   `expired` and lose their buttons. A tap re-checks valid_until itself, so
 *   the job's cadence never stretches a card's life.
 * - `resendActivationCard`: a lost card is posted again with a new token; the
 *   old card's buttons stop working.
 *
 * Nothing here writes to Meta. Reads use the brand's read-only client.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import { DEFAULT_GATE_TTL_HOURS } from "../config.js";
import { checkSpend as defaultCheckSpend, type GuardResult } from "../features/spend-guard/guard.js";
import { safeError } from "../features/spend-guard/support.js";
import { localDate, localTime } from "../kit/local-time.js";
import { storedCard, type GateDenyDecision, type GateRequestRecord, type GateStore } from "../kit/gate/state-machine.js";
import { editCard, type BotApi, type CardMedia } from "../kit/telegram/bot-api.js";
import type { MetaGraphClient } from "../meta/graph.js";
import { getAdSet } from "../meta/methods.js";
import type { CreativeSwap, PublishedPublication } from "../publish/handoff.js";
import { ACTIVATE_AD_KIND, activationOf, type ActivationBinding, type ActivationGateRepo } from "./gate-requests.js";

export const ACTIVATION_LABELS = { approve: "📣 Aktivoi mainos", deny: "🗑 Ohita" } as const;
export const ACTIVATION_DENY_DECISION: GateDenyDecision = "skipped";
export const GATE_CARD_ACTIVITY = "rk9-ads gate: card";
/** A handler that started this long ago no longer blocks a swap (a crashed worker leaves `started`). */
export const ACTIVATION_IN_FLIGHT_MINUTES = 30;
const EXPIRY_BATCH = 200;

/** The pauses that close a company's open activation cards (RK9-557). The data gate does not. */
export const CARD_CLOSING_PAUSES = ["kill_switch", "pause_all_cap", "scheduled_pause"] as const;
export type CardClosingPause = (typeof CARD_CLOSING_PAUSES)[number];

const PAUSE_CLOSE_TEXT: Record<CardClosingPause, string> = {
  kill_switch: "⛔ Hätäkatkaisin painettu: kortti mitätöity. Mainos jäi PAUSED-tilaan. Aktivointi on estetty, kunnes board poistaa pysäytystilan.",
  pause_all_cap: "⛔ Kulutuskatto 90 % ylittyi: kortti mitätöity. Mainos jäi PAUSED-tilaan.",
  scheduled_pause: "⛔ Ajastettu pysäytys: kortti mitätöity. Mainos jäi PAUSED-tilaan.",
};
const COPY_MAX_CHARS = 400;

/** The part of the Telegram controller the card life cycle uses. */
export interface GateCardTransport {
  botFor(companyId: string): { api: BotApi; chatId: string; brandCode: string } | null;
  sendGateCard(input: {
    companyId: string;
    kind: "activate_ad";
    validUntil: Date;
    card: { media: CardMedia; text: string; mediaUrl?: string };
    payload?: Record<string, unknown>;
    labels?: { approve?: string; deny?: string };
    denyDecision?: GateDenyDecision;
  }): Promise<{ id: string; messageId: number }>;
  resendGateCard(input: {
    request: GateRequestRecord;
    mediaUrl?: string;
    labels?: { approve?: string; deny?: string };
    denyDecision?: GateDenyDecision;
  }): Promise<{ messageId: number; chatId: string }>;
}

export interface StagingCardDeps {
  ctx: Pick<PluginContext, "activity" | "logger">;
  store: GateStore;
  repo: ActivationGateRepo;
  transport(): GateCardTransport | null;
  loadConfig(companyId: string): Promise<{ ok: true; config: BrandConfig } | { ok: false; error: string }>;
  readClient(companyId: string, config: BrandConfig): MetaGraphClient;
  checkSpend?: typeof defaultCheckSpend;
  now?: () => Date;
}

/** What a card can show, best first: the media itself, a video's poster, then text only. */
export function previewCandidates(preview: PublishedPublication["preview"]): Array<{ media: CardMedia; mediaUrl: string | null }> {
  const out: Array<{ media: CardMedia; mediaUrl: string | null }> = [];
  out.push({ media: preview.kind === "video" ? "video" : "photo", mediaUrl: preview.mediaUrl });
  if (preview.kind === "video" && preview.posterUrl) out.push({ media: "photo", mediaUrl: preview.posterUrl });
  out.push({ media: "text", mediaUrl: null });
  return out;
}

function eur(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} €` : "?";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface StagingCardFacts {
  brandCode: string;
  adName: string;
  adId: string;
  adsetId: string;
  adsetName: string | null;
  dailyBudgetCents: number | null;
  guard: Pick<GuardResult, "allow" | "reason" | "mtdEur" | "monthlyCapEur" | "projectedMonthEndEur"> | null;
  monthlyCapEur: number;
  copy: { message: string; title?: string };
  validUntil: Date;
  timeZone: string;
}

/** The card text (Finnish). Pure: tests pin it. */
export function stagingCardText(facts: StagingCardFacts): string {
  const lines = [
    `📣 Uusi mainos odottaa aktivointia (${facts.brandCode})`,
    `Mainos: ${facts.adName} (${facts.adId})`,
    `Ad set: ${facts.adsetName ? `${facts.adsetName} ` : ""}(${facts.adsetId})`,
    `Päiväbudjetti: ${facts.dailyBudgetCents === null ? "?" : eur(facts.dailyBudgetCents / 100)}`,
  ];
  if (facts.guard && facts.guard.mtdEur !== null) {
    lines.push(`Kulutus tässä kuussa: ${eur(facts.guard.mtdEur)} / ${eur(facts.monthlyCapEur)} (ennuste ${eur(facts.guard.projectedMonthEndEur)})`);
  } else {
    lines.push(`Kulutus tässä kuussa: ? / ${eur(facts.monthlyCapEur)}`);
  }
  if (facts.guard && !facts.guard.allow) lines.push(`⚠️ Kulutusvahti nyt: ${facts.guard.reason}. Aktivointi tarkistetaan uudelleen napautuksella.`);
  lines.push("");
  if (facts.copy.title) lines.push(clip(facts.copy.title, 120));
  lines.push(clip(facts.copy.message, COPY_MAX_CHARS));
  lines.push("");
  lines.push(`Voimassa ${localDate(facts.validUntil, facts.timeZone)} klo ${localTime(facts.validUntil, facts.timeZone)} asti.`);
  return lines.join("\n");
}

export function createStagingCards(deps: StagingCardDeps) {
  const now = deps.now ?? (() => new Date());
  const check = deps.checkSpend ?? defaultCheckSpend;

  async function audit(companyId: string, gateRequestId: string, event: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await deps.ctx.activity.log({ companyId, message: `${GATE_CARD_ACTIVITY} ${event}`, entityType: "gate_request", entityId: gateRequestId, metadata });
    } catch (error) {
      deps.ctx.logger.warn("rk9-ads gate: activity log failed", { gateRequestId, detail: safeError(error) });
    }
  }

  /** Edits a card that no tap is answering (job, swap, re-send): status line, no buttons. */
  async function editClosed(request: GateRequestRecord, status: string): Promise<void> {
    const card = storedCard(request);
    const bot = deps.transport()?.botFor(request.companyId);
    if (!card || !bot || !request.chatId || request.messageId === null) return;
    try {
      await editCard(bot.api, { chatId: request.chatId, messageId: request.messageId, media: card.media, original: card.text, status, buttons: null });
    } catch (error) {
      deps.ctx.logger.warn("rk9-ads gate: card edit failed", { gateRequestId: request.id, detail: safeError(error) });
    }
  }

  /** Closes the given open activate_ad cards. */
  async function closeEach(companyId: string, open: GateRequestRecord[], outcome: Record<string, unknown>, status: string): Promise<string[]> {
    const closed: string[] = [];
    for (const request of open) {
      if (!(await deps.repo.close(companyId, request.id, { handler: "not_run", ...outcome, statusText: status, closedAt: now().toISOString() }))) continue;
      closed.push(request.id);
      await editClosed(request, status);
      await audit(companyId, request.id, "closed", { adId: activationOf(request)?.adId ?? null, ...outcome });
    }
    return closed;
  }

  /** Closes open activate_ad cards of one ad. */
  async function closeOpen(companyId: string, adId: string, outcome: Record<string, unknown>, status: string): Promise<string[]> {
    return closeEach(companyId, await deps.repo.openForAd(companyId, adId), outcome, status);
  }

  return {
    /** The publish hand-off. Throws when no card could be posted: the publish service then hands off again on the next publish call. */
    async openActivationCard(publication: PublishedPublication): Promise<{ id: string; messageId: number }> {
      const { companyId } = publication;
      const loaded = await deps.loadConfig(companyId);
      if (!loaded.ok) throw new Error(`activation card not sent: ${loaded.error}`);
      const config = loaded.config;
      if (!config.telegram) throw new Error("activation card not sent: Telegram is not configured for the brand; the ad stays PAUSED");
      const transport = deps.transport();
      if (!transport) throw new Error("activation card not sent: the Telegram controller is not running");

      const read = deps.readClient(companyId, config);
      let adsetName: string | null = null;
      let dailyBudgetCents: number | null = null;
      try {
        const adset = await getAdSet(read, publication.adsetId);
        adsetName = adset.name || null;
        dailyBudgetCents = adset.dailyBudgetCents;
      } catch (error) {
        deps.ctx.logger.warn("rk9-ads gate: ad set read for the card failed", { companyId, adsetId: publication.adsetId, detail: safeError(error) });
      }
      // The card shows where the month stands; the tap checks again.
      const guard = await check({ config, client: read, now: now(), change: { objectId: publication.adsetId, level: "adset", activate: true } });

      const validUntil = new Date(now().getTime() + (config.telegram.gateTtlHours ?? DEFAULT_GATE_TTL_HOURS) * 3_600_000);
      const binding: Omit<ActivationBinding, "media" | "mediaUrl"> = {
        publicationId: publication.publicationId,
        adId: publication.adId,
        adsetId: publication.adsetId,
        campaignId: publication.campaignId,
        creativeId: publication.creativeId,
        contentHash: publication.contentHash,
        adName: publication.adName,
      };
      const text = stagingCardText({
        brandCode: config.brandCode,
        adName: publication.adName,
        adId: publication.adId,
        adsetId: publication.adsetId,
        adsetName,
        dailyBudgetCents,
        guard,
        monthlyCapEur: config.monthlyCapEur,
        copy: publication.preview.copy,
        validUntil,
        timeZone: config.timeZone,
      });

      // Newest card wins: an older open card of the same ad stops working.
      await closeOpen(companyId, publication.adId, { reason: "superseded", byPublicationId: publication.publicationId }, "↪️ Korvattu uudella kortilla");
      // Telegram fetches media by URL with size limits (about 5 MB photo, 20 MB video):
      // fall back to the poster, then to a text card. Each failed send leaves a `failed` row.
      const previews = previewCandidates(publication.preview);
      let sent: { id: string; messageId: number } | null = null;
      let lastError: unknown = null;
      for (const preview of previews) {
        try {
          sent = await transport.sendGateCard({
            companyId,
            kind: ACTIVATE_AD_KIND,
            validUntil,
            card: { media: preview.media, ...(preview.mediaUrl ? { mediaUrl: preview.mediaUrl } : {}), text },
            payload: { activation: { ...binding, media: preview.media, mediaUrl: preview.mediaUrl } },
            labels: ACTIVATION_LABELS,
            denyDecision: ACTIVATION_DENY_DECISION,
          });
          break;
        } catch (error) {
          lastError = error;
          deps.ctx.logger.warn("rk9-ads gate: card send failed, trying the next preview", { companyId, media: preview.media, detail: safeError(error) });
        }
      }
      if (!sent) {
        deps.ctx.logger.error("rk9-ads gate: activation card not sent; the ad stays PAUSED", { companyId, adId: publication.adId, detail: safeError(lastError) });
        try {
          await deps.ctx.activity.log({
            companyId,
            message: `${GATE_CARD_ACTIVITY} send failed`,
            entityType: "rk9_ads_publication",
            entityId: publication.publicationId,
            metadata: { adId: publication.adId, error: safeError(lastError) },
          });
        } catch {
          // The thrown error below is what the caller needs.
        }
        throw lastError instanceof Error ? lastError : new Error("activation card not sent");
      }
      await audit(companyId, sent.id, "sent", {
        publicationId: publication.publicationId,
        adId: publication.adId,
        creativeId: publication.creativeId,
        validUntil: validUntil.toISOString(),
        guardReason: guard.reason,
      });
      return sent;
    },

    /**
     * The swap hook. Closes the ad's open cards first, so no new approval can
     * start; then throws when an approval won before the close and its
     * activation may still be running, or when a card is still open.
     */
    async closeCardsForSwap(swap: CreativeSwap): Promise<string[]> {
      const closed = await closeOpen(
        swap.companyId,
        swap.adId,
        { reason: "creative_swapped", swapPublicationId: swap.publicationId },
        "⚠️ Creative vaihdettu: kortti mitätöity. Uusi kortti lähetetään uudesta creativesta.",
      );
      if (await deps.repo.activationInFlight(swap.companyId, swap.adId, ACTIVATION_IN_FLIGHT_MINUTES)) {
        throw new Error(`an approved activation of ad ${swap.adId} is running; swap the creative after it has finished`);
      }
      if ((await deps.repo.openForAd(swap.companyId, swap.adId)).length > 0) {
        throw new Error(`an activation card of ad ${swap.adId} is still open; swap again`);
      }
      return closed;
    },

    /**
     * The pause hook (RK9-557): closes every open card of the company and
     * edits it with the pause's reason. A tap that approved a card before
     * this close is not stopped here; for the kill switch the standing halt
     * stops it (activate-ad.ts).
     */
    async closeCardsForPause(companyId: string, input: { rule: CardClosingPause; reason: string }): Promise<string[]> {
      return closeEach(
        companyId,
        await deps.repo.openForCompany(companyId),
        { reason: input.rule, pauseReason: input.reason.slice(0, 300) },
        PAUSE_CLOSE_TEXT[input.rule],
      );
    },

    /** The gate-expiry job. Returns the number of cards this run expired. */
    async expireDueCards(): Promise<number> {
      let expired = 0;
      for (const due of await deps.repo.dueForExpiry(EXPIRY_BATCH)) {
        if (!(await deps.store.expire(due.companyId, due.tokenHash))) continue;
        expired += 1;
        const request = await deps.store.findById(due.companyId, due.id);
        if (!request) continue;
        const kind = request.kind === ACTIVATE_AD_KIND ? "Mainos jäi PAUSED-tilaan." : "Ei toimenpiteitä.";
        await editClosed(request, `⌛ Vanhentunut. ${kind}`);
        await audit(due.companyId, due.id, "expired", { kind: request.kind, adId: activationOf(request)?.adId ?? null });
      }
      return expired;
    },

    /** The `resend_gate_card` action. */
    async resendActivationCard(companyId: string, input: { gateRequestId?: string; publicationId?: string }): Promise<{ gateRequestId: string; messageId: number }> {
      const request = input.gateRequestId
        ? await deps.store.findById(companyId, input.gateRequestId)
        : input.publicationId
          ? await deps.repo.pendingForPublication(companyId, input.publicationId)
          : null;
      if (!request) throw new Error("no such activation card for this company");
      const binding = activationOf(request);
      if (!binding) throw new Error("the gate request is not an activation card");
      if (request.status !== "pending" || !request.live) throw new Error(`the activation card is ${request.live ? request.status : "expired"}; only a pending, unexpired card can be re-sent`);
      const transport = deps.transport();
      if (!transport) throw new Error("the Telegram controller is not running");
      let sent: { messageId: number };
      try {
        sent = await transport.resendGateCard({
          request,
          ...(binding.mediaUrl ? { mediaUrl: binding.mediaUrl } : {}),
          labels: ACTIVATION_LABELS,
          denyDecision: ACTIVATION_DENY_DECISION,
        });
      } finally {
        // The old message: once the token is rotated its buttons no longer match; drop them.
        if ((await deps.store.findById(companyId, request.id))?.messageId !== request.messageId) {
          await editClosed(request, "↪️ Lähetetty uudelleen");
        }
      }
      await audit(companyId, request.id, "resent", { adId: binding.adId, previousMessageId: request.messageId, messageId: sent.messageId });
      return { gateRequestId: request.id, messageId: sent.messageId };
    },
  };
}

export type StagingCards = ReturnType<typeof createStagingCards>;
