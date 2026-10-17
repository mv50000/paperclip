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
 *   pause cannot undo it (RK9-557). The rows close at once; the card edits
 *   wait for `announce`, so Telegram never holds back the Meta pauses. A row
 *   whose close fails does not stop the others: the result names the error
 *   and the rows that did close (RK9-561).
 * - `closeCardsForAdPause`: a pause of one ad from the UI closes that ad's
 *   open cards the same way, so an old card cannot activate it again
 *   (RK9-562).
 * - `expireDueCards`: the gate-expiry job. Cards past valid_until move to
 *   `expired` and lose their buttons. A tap re-checks valid_until itself, so
 *   the job's cadence never stretches a card's life.
 * - `resendActivationCard`: a lost card is posted again with a new token; the
 *   old card's buttons stop working.
 *
 * While a pause's halt is in force, a new card says so (RK9-561): its tap
 * refuses until the halt ends or a board user clears it.
 *
 * Nothing here writes to Meta. Reads use the brand's read-only client.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import { DEFAULT_GATE_TTL_HOURS } from "../config.js";
import { checkSpend as defaultCheckSpend, type GuardResult } from "../features/spend-guard/guard.js";
import type { HaltState } from "../features/spend-guard/halt.js";
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

/** Cards a pause closed. `announce` edits them and writes the audit entries; it never throws. */
export interface PauseCardClose {
  ids: string[];
  /** Set when some open cards could not be listed or closed; `ids` are the ones that did close. */
  error?: string;
  announce(): Promise<void>;
}

const PAUSE_CLOSE_TEXT: Record<CardClosingPause, string> = {
  kill_switch: "⛔ Hätäkatkaisin painettu: kortti mitätöity. Mainos jäi PAUSED-tilaan. Aktivointi on estetty, kunnes board poistaa pysäytystilan.",
  pause_all_cap: "⛔ Kulutuskatto 90 % ylittyi: kortti mitätöity. Mainos jäi PAUSED-tilaan. Aktivointi on estetty kuun loppuun, ellei board poista pysäytystilaa.",
  scheduled_pause: "⛔ Ajastettu pysäytys: kortti mitätöity. Mainos jäi PAUSED-tilaan. Aktivointi on estetty aamuun asti.",
};
/** The card status after a pause of the ad from the UI (RK9-562). */
export const AD_PAUSE_CLOSE_TEXT = "⛔ Mainos pysäytetään käyttöliittymästä: kortti mitätöity. Aktivointi vaatii uuden kortin.";
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
  /** The halt in force (spend-guard/halt.ts). A new card names it; a read failure only leaves the line out. */
  haltOf?(companyId: string): Promise<HaltState | null>;
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
  /** The halt in force when the card was sent. */
  halt?: HaltState | null;
}

const HALT_RULE_TEXT: Record<string, string> = {
  kill_switch: "hätäkatkaisin",
  scheduled_pause: "ajastettu pysäytys",
  pause_all_cap: "kulutuskatto 90 %",
};

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
  if (facts.halt) {
    const why = HALT_RULE_TEXT[facts.halt.rule] ?? facts.halt.rule;
    const until = facts.halt.until ? new Date(facts.halt.until) : null;
    lines.push(
      until && Number.isFinite(until.getTime())
        ? `⛔ Pysäytystila päällä (${why}) ${localDate(until, facts.timeZone)} klo ${localTime(until, facts.timeZone)} asti: napautus ei aktivoi ennen sitä, ellei board poista tilaa.`
        : `⛔ Pysäytystila päällä (${why}): napautus ei aktivoi mitään, kunnes board poistaa tilan.`,
    );
  }
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

  /**
   * Closes the given open activate_ad rows (no Telegram call). A row whose
   * close throws does not stop the others; `error` names the first failure.
   */
  async function closeRows(
    companyId: string,
    open: GateRequestRecord[],
    outcome: Record<string, unknown>,
    status: string,
  ): Promise<{ closed: GateRequestRecord[]; error?: string }> {
    const closed: GateRequestRecord[] = [];
    const failed: string[] = [];
    let first: string | undefined;
    for (const request of open) {
      try {
        if (await deps.repo.close(companyId, request.id, { handler: "not_run", ...outcome, statusText: status, closedAt: now().toISOString() })) closed.push(request);
      } catch (error) {
        failed.push(request.id);
        first ??= safeError(error);
      }
    }
    return failed.length > 0 ? { closed, error: `${failed.length} card(s) not closed (${failed.join(", ")}): ${first}`.slice(0, 500) } : { closed };
  }

  /** Edits closed cards and audits them. Never throws. */
  async function announceClosed(companyId: string, closed: GateRequestRecord[], outcome: Record<string, unknown>, status: string): Promise<void> {
    for (const request of closed) {
      await editClosed(request, status);
      await audit(companyId, request.id, "closed", { adId: activationOf(request)?.adId ?? null, ...outcome });
    }
  }

  /** Closes the given open activate_ad cards, then edits the ones that closed. Throws when a close failed. */
  async function closeEach(companyId: string, open: GateRequestRecord[], outcome: Record<string, unknown>, status: string): Promise<string[]> {
    const { closed, error } = await closeRows(companyId, open, outcome, status);
    await announceClosed(companyId, closed, outcome, status);
    if (error) throw new Error(error);
    return closed.map((request) => request.id);
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
      let halt: HaltState | null = null;
      try {
        halt = (await deps.haltOf?.(companyId)) ?? null;
      } catch (error) {
        // The tap reads the halt again and refuses when it cannot; the card only loses the line.
        deps.ctx.logger.warn("rk9-ads gate: halt read for the card failed", { companyId, detail: safeError(error) });
      }

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
        halt,
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
        ...(halt ? { halt: { rule: halt.rule, since: halt.since, until: halt.until ?? null } } : {}),
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
     * The pause hook (RK9-557): closes every open card row of the company
     * now; `announce` edits the cards with the pause's reason later. A tap
     * that approved a card before this close is not stopped here; the pause's
     * halt stops it (activate-ad.ts). Throws only when the open cards cannot
     * be listed; a failed row close is in `error`.
     */
    async closeCardsForPause(companyId: string, input: { rule: CardClosingPause; reason: string }): Promise<PauseCardClose> {
      const outcome = { reason: input.rule, pauseReason: input.reason.slice(0, 300) };
      const status = PAUSE_CLOSE_TEXT[input.rule];
      const { closed, error } = await closeRows(companyId, await deps.repo.openForCompany(companyId), outcome, status);
      return {
        ids: closed.map((request) => request.id),
        ...(error ? { error } : {}),
        announce: () => announceClosed(companyId, closed, outcome, status),
      };
    },

    /**
     * The pause-ad hook (RK9-562): closes the open card rows of one ad now;
     * `announce` edits the cards later. A tap that approved a card before
     * this close is not stopped here: `error` then says that an approved
     * activation of the ad may still be running. Throws only when the open
     * cards cannot be listed.
     */
    async closeCardsForAdPause(companyId: string, adId: string, input: { reason: string }): Promise<PauseCardClose> {
      const outcome = { reason: "ad_paused", pauseReason: input.reason.slice(0, 300) };
      const { closed, error } = await closeRows(companyId, await deps.repo.openForAd(companyId, adId), outcome, AD_PAUSE_CLOSE_TEXT);
      const errors = error ? [error] : [];
      try {
        if (await deps.repo.activationInFlight(companyId, adId, ACTIVATION_IN_FLIGHT_MINUTES)) {
          errors.push(`an approved activation of ad ${adId} is running; check the ad's status after it has finished`);
        }
      } catch (cause) {
        errors.push(`running activations could not be read: ${safeError(cause)}`);
      }
      return {
        ids: closed.map((request) => request.id),
        ...(errors.length > 0 ? { error: errors.join("; ").slice(0, 500) } : {}),
        announce: () => announceClosed(companyId, closed, outcome, AD_PAUSE_CLOSE_TEXT),
      };
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
