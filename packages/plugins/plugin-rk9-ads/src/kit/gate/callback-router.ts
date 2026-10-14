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
 * Only an approval runs the kind handler. A denial is final at step 5.
 *
 * The handler runs at most once. A worker that dies during the handler leaves
 * the card `approved` with outcome `{ handler: "started" }`: the handler may
 * or may not have acted. A reconciler must check the real state (for example
 * the ad's status at Meta) and must not re-run the handler blindly.
 */

import type { PluginLogger } from "@paperclipai/plugin-sdk";
import {
  editCard,
  messageMedia,
  redactSecrets,
  type BotApi,
  type CardMedia,
  type TelegramCallbackQuery,
  type TelegramUpdate,
} from "../telegram/bot-api.js";
import type { GateHandlerResult, GateRegistry } from "./registry.js";
import {
  gateTokenHash,
  parseGateCallbackData,
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
  | { type: "unauthorized"; companyId: string; gateRequestId: string; tgUserId: number; chatId: string | null; reason: "chat" | "user" | "bot" | "kind" }
  | { type: "unknown_kind"; companyId: string; gateRequestId: string; kind: string }
  | { type: "expired"; companyId: string; gateRequestId: string; tgUserId: number }
  | { type: "decided"; companyId: string; gateRequestId: string; kind: string; decision: GateDecision; tgUserId: number }
  | { type: "handler_failed"; companyId: string; gateRequestId: string; kind: string; errorName: string };

export const GATE_TEXT = {
  unauthorized: "ei oikeutta",
  unknownCard: "Tuntematon kortti",
  unknownKind: "Tuntematon toiminto",
  expired: "vanhentunut",
  alreadyDecided: "Jo käsitelty",
  processing: "⏳ Käsitellään…",
  approved: "✅ Hyväksytty",
  denied: "❌ Hylätty",
  failed: "⚠️ Epäonnistui",
} as const;

export interface CallbackRouterOptions {
  api: BotApi;
  store: GateStore;
  registry: GateRegistry;
  /** The brand this bot serves for `companyId`, or null when it serves none. */
  brandFor(companyId: string): GateBrand | null;
  logger: PluginLogger;
  audit?(event: GateAuditEvent): Promise<void>;
}

export interface CallbackRouter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** Resolves when every handler run started so far has finished. */
  idle(): Promise<void>;
}

export function createCallbackRouter(options: CallbackRouterOptions): CallbackRouter {
  const { api, store, registry, logger } = options;
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

  async function edit(request: GateRequestRecord, query: TelegramCallbackQuery, status: string): Promise<void> {
    const chatId = request.chatId ?? (query.message ? String(query.message.chat.id) : null);
    const messageId = request.messageId ?? query.message?.message_id ?? null;
    if (!chatId || !messageId) return;
    const card = storedCard(request);
    const media: CardMedia = query.message ? messageMedia(query.message) : (card?.media ?? "text");
    const original = card?.text ?? query.message?.caption ?? query.message?.text ?? "";
    try {
      await editCard(api, { chatId, messageId, media, original, status, buttons: null });
    } catch (error) {
      logger.warn("gate: card edit failed", { botKey: api.botKey, gateRequestId: request.id, detail: safe(error) });
    }
  }

  function authorize(request: GateRequestRecord, query: TelegramCallbackQuery): "chat" | "user" | "bot" | "kind" | null {
    const brand = options.brandFor(request.companyId);
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
    try {
      await store.settle(request.companyId, request.id, { from: "approved", to: "approved", outcome: { handler: "started" } });
    } catch (error) {
      logger.warn("gate: could not mark the handler as started", { gateRequestId: request.id, detail: safe(error) });
    }
    let result: GateHandlerResult;
    try {
      if (!handler) throw new Error(`No handler for gate kind ${request.kind}`);
      result = (await handler({ request: { ...request, status: "approved" }, tgUserId })) ?? {};
    } catch (error) {
      const message = safe(error);
      logger.error("gate: handler failed", { gateRequestId: request.id, kind: request.kind, detail: message });
      try {
        await store.settle(request.companyId, request.id, { from: "approved", to: "failed", error: message });
      } catch (settleError) {
        logger.error("gate: could not record handler failure", { gateRequestId: request.id, detail: safe(settleError) });
      }
      await audit({
        type: "handler_failed",
        companyId: request.companyId,
        gateRequestId: request.id,
        kind: request.kind,
        errorName: error instanceof Error ? error.name : "Error",
      });
      // The chat sees a generic line; the redacted message is in the log and the error column.
      await edit(request, query, GATE_TEXT.failed);
      return;
    }
    // The handler has acted: a later storage error must not show the card as failed.
    try {
      await store.settle(request.companyId, request.id, { from: "approved", to: "approved", outcome: result.outcome ?? { handler: "done" } });
    } catch (error) {
      logger.error("gate: handler succeeded but its outcome was not stored", { gateRequestId: request.id, detail: safe(error) });
    }
    await edit(request, query, result.statusText ?? GATE_TEXT.approved);
  }

  async function handleCallback(update: TelegramUpdate, query: TelegramCallbackQuery): Promise<void> {
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

    const refused = authorize(request, query);
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
        await answer(query, GATE_TEXT.expired, true);
        await edit(request, query, `⌛ ${GATE_TEXT.expired}`);
        if (expiredNow) await audit({ type: "expired", companyId: request.companyId, gateRequestId: request.id, tgUserId });
        return;
      }
      await answer(query, `${GATE_TEXT.alreadyDecided} (${current?.status ?? "?"})`);
      return;
    }

    if (parsed.decision === "denied") {
      await answer(query, GATE_TEXT.denied);
      await edit(request, query, GATE_TEXT.denied);
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
