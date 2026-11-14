/**
 * Callback router (A5, RK9-509): turns a Telegram tap into a gate transition.
 *
 * Order per callback_query, fast part first (Telegram's callback window is
 * about 10 s, the target is about 1 s):
 *   1. parse callback_data, find the card by token hash;
 *   2. check the brand served by this bot: chat id and approver allowlist.
 *      A refused tap gets "ei oikeutta", a warning and an audit event, and
 *      the database stays unchanged;
 *   3. refuse a kind without a handler (state unchanged);
 *   4. record the update_id (a redelivered update stops here);
 *   5. compare-and-set pending -> approved|denied; a card past valid_until
 *      moves to expired and shows "vanhentunut";
 *   6. answerCallbackQuery, then edit the card to the hourglass and drop the
 *      buttons;
 * then, off the poll loop: mark the handler as started (outcome
 * `{ handler: "started" }`), run the kind handler and edit the final outcome
 * into the card. `idle()` waits for those handler runs.
 *
 * Only an approval runs the kind handler. A denial or a skip is final at
 * step 5. A handler may end the card `denied` (it refused before it acted)
 * or `failed` (it stopped part way) instead of `approved`.
 *
 * Deny reasons (RK9-832): a kind registered with `denyReasons` gets its
 * preset reason buttons on the card after a deny tap, and a reply to the card
 * message counts as a typed reason. The same chat, message and approver
 * checks apply; the first reason wins (`claimDenyReason`), and nothing but
 * the card is edited. A reason never moves the card out of `denied` and never
 * runs the kind handler.
 *
 * The handler runs at most once. A worker that dies during the handler leaves
 * the card `approved` with outcome `{ handler: "started" }`: the handler may
 * or may not have acted. A reconciler must check the real state (for example
 * the ad's status at Meta) and must not re-run the handler blindly. A store
 * error on the final outcome leaves the same `started`, so that write is
 * tried again (`outcomeRetryDelaysMs`) before the router gives up and logs
 * it (RK9-567): the activation gate reads `started` as a card that may still
 * be running, and an old one as a card with an unknown result.
 */

import type { PluginLogger } from "@paperclipai/plugin-sdk";
import {
  editCard,
  messageMedia,
  redactSecrets,
  type BotApi,
  type CardMedia,
  type InlineKeyboardMarkup,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "../telegram/bot-api.js";
import type { GateDenyReasons, GateHandlerResult, GateRegistry } from "./registry.js";
import {
  gateTokenHash,
  parseGateCallbackData,
  parseReasonCallbackData,
  reasonButtons,
  storedCard,
  type GateDecision,
  type GateRequestRecord,
  type GateStore,
} from "./state-machine.js";

/** A brand (tenant) this bot serves. */
export interface GateBrand {
  companyId: string;
  chatId: string;
  allowedUserIds: readonly string[];
  /** When set, only cards of these kinds can be decided (e.g. a brand whose config is unreadable). */
  allowedKinds?: readonly string[];
}

export type GateAuditEvent =
  | { type: "unauthorized"; companyId: string; gateRequestId: string; tgUserId: number; chatId: string | null; reason: RefusalReason }
  | { type: "unknown_kind"; companyId: string; gateRequestId: string; kind: string }
  | { type: "expired"; companyId: string; gateRequestId: string; tgUserId: number }
  | { type: "decided"; companyId: string; gateRequestId: string; kind: string; decision: GateDecision; tgUserId: number }
  | { type: "handler_failed"; companyId: string; gateRequestId: string; kind: string; errorName: string }
  | { type: "deny_reason"; companyId: string; gateRequestId: string; kind: string; code: string; typed: boolean; tgUserId: number };

/** "stale": the approver list could not be confirmed against the saved config. */
export type RefusalReason = "chat" | "user" | "bot" | "kind" | "stale";

export const GATE_TEXT = {
  unauthorized: "ei oikeutta",
  unknownCard: "Tuntematon kortti",
  unknownKind: "Tuntematon toiminto",
  expired: "vanhentunut",
  alreadyDecided: "Jo käsitelty",
  processing: "⏳ Käsitellään…",
  approved: "✅ Hyväksytty",
  denied: "❌ Hylätty",
  skipped: "🗑 Ohitettu",
  failed: "⚠️ Epäonnistui",
  reasonSaved: "Syy tallennettu",
  reasonTaken: "Syy on jo tallennettu",
  reasonLabel: "Syy",
} as const;

/** A typed reason is stored at most this long (UTF-16 units). */
export const DENY_REASON_TEXT_MAX = 500;

/** Trims a typed reason, drops control characters and clips it. Empty means no reason. */
export function cleanReasonText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= DENY_REASON_TEXT_MAX ? flat : `${flat.slice(0, DENY_REASON_TEXT_MAX - 1)}…`;
}

export interface CallbackRouterOptions {
  api: BotApi;
  store: GateStore;
  registry: GateRegistry;
  /** The brand this bot serves for `companyId`, or null when it serves none. */
  brandFor(companyId: string): GateBrand | null;
  /**
   * The brand as saved right now. When set, an approval of a kind outside
   * `cachedKinds` is checked again against it before anything is written: the
   * list in memory can be stale. Null or a throw refuses the tap.
   */
  freshBrandFor?(companyId: string): Promise<GateBrand | null>;
  /** Kinds that may be approved on the brand in memory (stopping kinds). */
  cachedKinds?: readonly string[];
  logger: PluginLogger;
  audit?(event: GateAuditEvent): Promise<void>;
  /** Waits before each repeat of a failed final outcome write; default OUTCOME_RETRY_DELAYS_MS. */
  outcomeRetryDelaysMs?: readonly number[];
}

/** Two repeats of a failed final outcome write, after 250 ms and 1 s (RK9-567). */
export const OUTCOME_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

export interface CallbackRouter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** Resolves when every handler run started so far has finished. */
  idle(): Promise<void>;
}

export function createCallbackRouter(options: CallbackRouterOptions): CallbackRouter {
  const { api, store, registry, logger } = options;
  const outcomeRetryDelays = options.outcomeRetryDelaysMs ?? OUTCOME_RETRY_DELAYS_MS;
  const running = new Set<Promise<void>>();

  async function audit(event: GateAuditEvent): Promise<void> {
    if (!options.audit) return;
    try {
      await options.audit(event);
    } catch (error) {
      logger.warn("gate: audit write failed", { type: event.type, detail: safe(error) });
    }
  }

  async function answer(query: TelegramCallbackQuery, text: string, showAlert = false): Promise<void> {
    try {
      await api.answerCallbackQuery({ callback_query_id: query.id, text, ...(showAlert ? { show_alert: true } : {}) });
    } catch (error) {
      logger.warn("gate: answerCallbackQuery failed", { botKey: api.botKey, detail: safe(error) });
    }
  }

  async function edit(
    request: GateRequestRecord,
    query: TelegramCallbackQuery | null,
    status: string,
    buttons: InlineKeyboardMarkup | null = null,
  ): Promise<void> {
    const chatId = request.chatId ?? (query?.message ? String(query.message.chat.id) : null);
    const messageId = request.messageId ?? query?.message?.message_id ?? null;
    if (!chatId || !messageId) return;
    const card = storedCard(request);
    const media: CardMedia = query?.message ? messageMedia(query.message) : (card?.media ?? "text");
    const original = card?.text ?? query?.message?.caption ?? query?.message?.text ?? "";
    try {
      await editCard(api, { chatId, messageId, media, original, status, buttons });
    } catch (error) {
      logger.warn("gate: card edit failed", { botKey: api.botKey, gateRequestId: request.id, detail: safe(error) });
    }
  }

  function authorize(request: GateRequestRecord, query: TelegramCallbackQuery, brand: GateBrand | null): RefusalReason | null {
    if (!brand) return "bot";
    const chatId = query.message ? String(query.message.chat.id) : null;
    if (!chatId || chatId !== brand.chatId || (request.chatId !== null && request.chatId !== chatId)) return "chat";
    if (request.messageId !== null && query.message && query.message.message_id !== request.messageId) return "chat";
    if (!brand.allowedUserIds.includes(String(query.from?.id))) return "user";
    if (brand.allowedKinds && !brand.allowedKinds.includes(request.kind)) return "kind";
    return null;
  }

  async function runHandler(request: GateRequestRecord, query: TelegramCallbackQuery): Promise<void> {
    const handler = registry.get(request.kind);
    const tgUserId = query.from.id;
    // The chat sees a generic line; the redacted message is in the log and the error column.
    // The outcome tells a reconciler whether the handler may have acted:
    // "not_run" never acted, "threw" may have acted before it failed.
    async function fail(message: string, errorName: string, handlerState: "not_run" | "threw"): Promise<void> {
      try {
        await store.settle(request.companyId, request.id, { from: "approved", to: "failed", outcome: { handler: handlerState }, error: message });
      } catch (settleError) {
        logger.error("gate: could not record handler failure", { gateRequestId: request.id, detail: safe(settleError) });
      }
      await audit({ type: "handler_failed", companyId: request.companyId, gateRequestId: request.id, kind: request.kind, errorName });
      await edit(request, query, GATE_TEXT.failed);
    }

    // Without the marker a crash during the handler would look like "never
    // ran", and a reconciler could act twice. No marker, no handler.
    let marked = false;
    try {
      marked = await store.settle(request.companyId, request.id, { from: "approved", to: "approved", outcome: { handler: "started" } });
    } catch (error) {
      logger.error("gate: could not mark the handler as started", { gateRequestId: request.id, detail: safe(error) });
    }
    if (!marked) {
      logger.error("gate: handler not run because its start was not recorded", { gateRequestId: request.id, kind: request.kind });
      await fail("handler start was not recorded; the handler did not run", "HandlerStartNotRecorded", "not_run");
      return;
    }
    let result: GateHandlerResult;
    try {
      if (!handler) throw new Error(`No handler for gate kind ${request.kind}`);
      result = (await handler({ request: { ...request, status: "approved" }, tgUserId })) ?? {};
    } catch (error) {
      const message = safe(error);
      logger.error("gate: handler failed", { gateRequestId: request.id, kind: request.kind, detail: message });
      await fail(message, error instanceof Error ? error.name : "Error", "threw");
      return;
    }
    // The handler has acted: a later storage error must not show the card as failed.
    const to: "approved" | "denied" | "failed" = result.status === "denied" || result.status === "failed" ? result.status : "approved";
    const final = { from: "approved" as const, to, outcome: result.outcome ?? { handler: "done" }, error: to === "approved" ? null : (result.error ?? null) };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await store.settle(request.companyId, request.id, final);
        break;
      } catch (error) {
        const delay = outcomeRetryDelays[attempt];
        if (delay === undefined) {
          logger.error("gate: handler succeeded but its outcome was not stored", { gateRequestId: request.id, attempts: attempt + 1, detail: safe(error) });
          break;
        }
        logger.warn("gate: handler outcome not stored, trying again", { gateRequestId: request.id, attempt: attempt + 1, detail: safe(error) });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    await edit(request, query, result.statusText ?? (to === "approved" ? GATE_TEXT.approved : GATE_TEXT[to]));
  }

  /** Stores the first reason, edits the card and tells the kind. False when a reason was already stored. */
  async function storeReason(
    request: GateRequestRecord,
    reasons: GateDenyReasons,
    input: { code: string; label: string; text: string | null; tgUserId: number; query: TelegramCallbackQuery | null },
  ): Promise<boolean> {
    const reason = { denyReason: { code: input.code, ...(input.text !== null ? { text: input.text } : {}), byTgUserId: input.tgUserId } };
    if (!(await store.claimDenyReason!(request.companyId, request.id, reason))) return false;
    await edit(request, input.query, `${GATE_TEXT.denied} · ${GATE_TEXT.reasonLabel}: ${input.label}`);
    await audit({
      type: "deny_reason",
      companyId: request.companyId,
      gateRequestId: request.id,
      kind: request.kind,
      code: input.code,
      typed: input.text !== null,
      tgUserId: input.tgUserId,
    });
    try {
      await reasons.onReason({ request, tgUserId: input.tgUserId, code: input.code, text: input.text });
    } catch (error) {
      logger.warn("gate: onReason failed", { gateRequestId: request.id, kind: request.kind, detail: safe(error) });
    }
    return true;
  }

  async function handleReasonTap(update: TelegramUpdate, query: TelegramCallbackQuery, parsed: { index: number; token: string }): Promise<void> {
    const request = await store.findByTokenHash(gateTokenHash(parsed.token));
    if (!request) {
      await answer(query, GATE_TEXT.unknownCard);
      return;
    }
    const refused = authorize(request, query, options.brandFor(request.companyId));
    if (refused) {
      logger.warn("gate: reason tap refused", { botKey: api.botKey, companyId: request.companyId, gateRequestId: request.id, reason: refused });
      await answer(query, GATE_TEXT.unauthorized, true);
      await audit({
        type: "unauthorized",
        companyId: request.companyId,
        gateRequestId: request.id,
        tgUserId: query.from?.id ?? 0,
        chatId: query.message ? String(query.message.chat.id) : null,
        reason: refused,
      });
      return;
    }
    const reasons = store.claimDenyReason ? registry.denyReasons(request.kind) : undefined;
    const option = reasons?.options[parsed.index];
    if (!reasons || !option || request.status !== "denied") {
      await answer(query, `${GATE_TEXT.alreadyDecided} (${request.status})`);
      return;
    }
    if (!(await store.markUpdateProcessed(request.companyId, api.botKey, update.update_id, "callback_query"))) return;
    const stored = await storeReason(request, reasons, { code: option.code, label: option.label, text: null, tgUserId: query.from.id, query });
    await answer(query, stored ? GATE_TEXT.reasonSaved : GATE_TEXT.reasonTaken);
  }

  /** A reply to a denied card is its typed reason. Anything else is left alone. */
  async function handleReply(update: TelegramUpdate, message: TelegramMessage): Promise<void> {
    const target = message.reply_to_message;
    if (!target || typeof message.text !== "string" || !store.findByMessage || !store.claimDenyReason) return;
    const chatId = String(message.chat.id);
    const request = await store.findByMessage(chatId, target.message_id);
    if (!request) return;
    const reasons = registry.denyReasons(request.kind);
    if (!reasons?.freeText) return;
    const brand = options.brandFor(request.companyId);
    const fromId = message.from?.id;
    const refusal: RefusalReason | null = !brand
      ? "bot"
      : chatId !== brand.chatId || request.chatId !== chatId
        ? "chat"
        : !brand.allowedUserIds.includes(String(fromId))
          ? "user"
          : brand.allowedKinds && !brand.allowedKinds.includes(request.kind)
            ? "kind"
            : null;
    if (refusal) {
      // No reply is sent: a refused reply changes nothing and adds no message to the chat.
      logger.warn("gate: reason reply refused", { botKey: api.botKey, companyId: request.companyId, gateRequestId: request.id, reason: refusal });
      await audit({ type: "unauthorized", companyId: request.companyId, gateRequestId: request.id, tgUserId: fromId ?? 0, chatId, reason: refusal });
      return;
    }
    if (request.status !== "denied") return;
    const text = cleanReasonText(message.text);
    if (text.length === 0) return;
    if (!(await store.markUpdateProcessed(request.companyId, api.botKey, update.update_id, "message"))) return;
    await storeReason(request, reasons, { code: reasons.freeTextCode ?? "other", label: text, text, tgUserId: fromId!, query: null });
  }

  async function handleCallback(update: TelegramUpdate, query: TelegramCallbackQuery): Promise<void> {
    const reasonTap = parseReasonCallbackData(query.data);
    if (reasonTap) {
      await handleReasonTap(update, query, reasonTap);
      return;
    }
    const parsed = parseGateCallbackData(query.data);
    if (!parsed) {
      // Not a gate button. Leave it alone: it may belong to another consumer.
      logger.debug("gate: callback is not a gate button", { botKey: api.botKey, updateId: update.update_id });
      return;
    }
    const tokenHash = gateTokenHash(parsed.token);
    const request = await store.findByTokenHash(tokenHash);
    if (!request) {
      logger.warn("gate: tap on an unknown card", { botKey: api.botKey, updateId: update.update_id });
      await answer(query, GATE_TEXT.unknownCard);
      return;
    }

    let refused = authorize(request, query, options.brandFor(request.companyId));
    if (!refused && parsed.decision === "approved" && options.freshBrandFor && !options.cachedKinds?.includes(request.kind)) {
      let fresh: GateBrand | null = null;
      try {
        fresh = await options.freshBrandFor(request.companyId);
      } catch (error) {
        logger.warn("gate: could not re-read the brand config", { companyId: request.companyId, gateRequestId: request.id, detail: safe(error) });
      }
      refused = fresh ? authorize(request, query, fresh) : "stale";
    }
    if (refused) {
      logger.warn("gate: tap refused", {
        botKey: api.botKey,
        companyId: request.companyId,
        gateRequestId: request.id,
        tgUserId: query.from?.id,
        reason: refused,
      });
      await answer(query, GATE_TEXT.unauthorized, true);
      await audit({
        type: "unauthorized",
        companyId: request.companyId,
        gateRequestId: request.id,
        tgUserId: query.from?.id ?? 0,
        chatId: query.message ? String(query.message.chat.id) : null,
        reason: refused,
      });
      return;
    }

    if (!registry.has(request.kind)) {
      logger.warn("gate: card kind has no handler, tap refused", { gateRequestId: request.id, kind: request.kind });
      await answer(query, GATE_TEXT.unknownKind, true);
      await audit({ type: "unknown_kind", companyId: request.companyId, gateRequestId: request.id, kind: request.kind });
      return;
    }

    if (!(await store.markUpdateProcessed(request.companyId, api.botKey, update.update_id, "callback_query"))) {
      logger.debug("gate: update already processed", { botKey: api.botKey, updateId: update.update_id });
      return;
    }

    const tgUserId = query.from.id;
    if (!(await store.decide(request.companyId, tokenHash, parsed.decision, tgUserId))) {
      const expiredNow = await store.expire(request.companyId, tokenHash);
      const current = expiredNow ? null : await store.findByTokenHash(tokenHash);
      if (expiredNow || current?.status === "expired" || (current?.status === "pending" && !current.live)) {
        // A card closed by its owner (a pause, a swap) keeps the reason it was closed for.
        const closed = !expiredNow && current?.status === "expired" ? current.closedStatus : null;
        await answer(query, GATE_TEXT.expired, true);
        await edit(request, query, closed ?? `⌛ ${GATE_TEXT.expired}`);
        if (expiredNow) await audit({ type: "expired", companyId: request.companyId, gateRequestId: request.id, tgUserId });
        return;
      }
      await answer(query, `${GATE_TEXT.alreadyDecided} (${current?.status ?? "?"})`);
      return;
    }

    const reasons = parsed.decision === "denied" && store.claimDenyReason ? registry.denyReasons(request.kind) : undefined;
    if (parsed.decision !== "approved") {
      await answer(query, GATE_TEXT[parsed.decision]);
      if (reasons) {
        await edit(request, query, `${GATE_TEXT.denied}\n${reasons.prompt}`, reasonButtons(parsed.token, reasons.options));
      } else {
        await edit(request, query, GATE_TEXT[parsed.decision]);
      }
    } else {
      await answer(query, GATE_TEXT.processing);
      await edit(request, query, GATE_TEXT.processing);
    }
    await audit({
      type: "decided",
      companyId: request.companyId,
      gateRequestId: request.id,
      kind: request.kind,
      decision: parsed.decision,
      tgUserId,
    });

    if (reasons?.onDenied) {
      try {
        await reasons.onDenied({ request: { ...request, status: "denied" }, tgUserId });
      } catch (error) {
        logger.warn("gate: onDenied failed", { gateRequestId: request.id, kind: request.kind, detail: safe(error) });
      }
    }
    if (parsed.decision !== "approved") return;
    const run = runHandler(request, query).finally(() => {
      running.delete(run);
    });
    running.add(run);
  }

  return {
    async handleUpdate(update) {
      const query = update.callback_query;
      if (!query) {
        if (update.message?.reply_to_message) {
          await handleReply(update, update.message);
          return;
        }
        logger.debug("gate: non-callback update ignored", { botKey: api.botKey, updateId: update.update_id });
        return;
      }
      await handleCallback(update, query);
    },
    async idle() {
      while (running.size > 0) {
        await Promise.allSettled([...running]);
      }
    },
  };
}

function safe(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
}
