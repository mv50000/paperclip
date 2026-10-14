/**
 * In-process fake of the Telegram Bot API, served through a `fetch` stub.
 *
 * It keeps an update queue with Telegram's confirmation rule (an update is
 * dropped only when a later getUpdates passes a higher offset), long-polls
 * until an update arrives or the timeout passes (it ignores AbortSignal, like
 * ctx.http.fetch), and
 * enforces the caption/text split of edits and "message is not modified".
 * Every call is recorded with the bot key of its token, never the token.
 */

import type {
  InlineKeyboardMarkup,
  TelegramFetch,
  TelegramMessage,
  TelegramUpdate,
} from "../../src/kit/telegram/bot-api.js";
import { telegramBotKey } from "../../src/kit/telegram/bot-api.js";

export interface FakeCall {
  method: string;
  botKey: string;
  params: Record<string, any>;
  at: number;
}

interface FakeError {
  status: number;
  description: string;
  retryAfter?: number;
}

export class FakeTelegram {
  readonly calls: FakeCall[] = [];
  readonly messages = new Map<number, TelegramMessage>();
  /** Webhook URL per bot key ("" = none). */
  readonly webhooks = new Map<string, { url: string; secret: string | null }>();
  /** getUpdates answers 409 for these bot keys. */
  readonly conflicts = new Set<string>();
  /** Fails the next call of a method once. */
  readonly failNext = new Map<string, FakeError>();
  /** Highest number of parallel getUpdates per bot key. */
  readonly maxInflight = new Map<string, number>();
  /** Upper bound for one long-poll wait, so tests stay fast. */
  maxWaitMs = 5_000;

  private readonly queues = new Map<string, TelegramUpdate[]>();
  private readonly inflight = new Map<string, number>();
  private waiters: Array<() => void> = [];
  private nextUpdateId = 5000;
  private nextMessageId = 1;

  readonly fetch: TelegramFetch = async (url, init) => {
    const match = /\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    if (!match) return json(404, { ok: false, error_code: 404, description: "Not Found" });
    const botKey = telegramBotKey(decodeURIComponent(match[1]!));
    const method = match[2]!;
    const params = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push({ method, botKey, params, at: Date.now() });
    const failure = this.failNext.get(method);
    if (failure) {
      this.failNext.delete(method);
      return json(failure.status, {
        ok: false,
        error_code: failure.status,
        description: failure.description,
        ...(failure.retryAfter ? { parameters: { retry_after: failure.retryAfter } } : {}),
      });
    }
    return this.dispatch(botKey, method, params);
  };

  /** Resolves when no getUpdates is open (the host finishes an abandoned long-poll on its own). */
  async drained(): Promise<void> {
    while ([...this.inflight.values()].some((count) => count > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  callsOf(method: string, botKey?: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method && (!botKey || call.botKey === botKey));
  }

  /** Marks a point in the call log (e.g. when a handler ran). */
  mark(label: string): void {
    this.calls.push({ method: `#${label}`, botKey: "", params: {}, at: Date.now() });
  }

  indexOf(predicate: (call: FakeCall) => boolean): number {
    return this.calls.findIndex(predicate);
  }

  pushUpdate(botKey: string, update: Omit<TelegramUpdate, "update_id"> & { update_id?: number }): number {
    const updateId = update.update_id ?? this.nextUpdateId++;
    const queue = this.queues.get(botKey) ?? [];
    queue.push({ ...update, update_id: updateId } as TelegramUpdate);
    this.queues.set(botKey, queue);
    this.wake();
    return updateId;
  }

  /** Builds the callback_query a tap on a card button would produce. */
  callbackUpdate(input: { messageId: number; data: string; fromId: number; chatId?: number; queryId?: string }): Omit<TelegramUpdate, "update_id"> {
    const message = this.messages.get(input.messageId);
    if (!message) throw new Error(`fake: no message ${input.messageId}`);
    return {
      callback_query: {
        id: input.queryId ?? `cq-${Math.random().toString(36).slice(2)}`,
        from: { id: input.fromId, first_name: "Test" },
        message: { ...structuredClone(message), chat: { id: input.chatId ?? message.chat.id } },
        data: input.data,
      },
    };
  }

  tap(botKey: string, input: { messageId: number; data: string; fromId: number; chatId?: number }): number {
    return this.pushUpdate(botKey, this.callbackUpdate(input));
  }

  /** Adds a message as if the bot had sent it (for rows created outside createGateCard). */
  addMessage(message: Omit<TelegramMessage, "message_id">): TelegramMessage {
    const full = { ...message, message_id: this.nextMessageId++ } as TelegramMessage;
    this.messages.set(full.message_id, full);
    return full;
  }

  /** The inline keyboard callback_data of a message, row by row. */
  buttons(messageId: number): string[] {
    const markup = this.messages.get(messageId)?.reply_markup;
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? "");
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private pending(botKey: string, offset: number | undefined): TelegramUpdate[] {
    let queue = this.queues.get(botKey) ?? [];
    if (offset !== undefined) {
      queue = queue.filter((update) => update.update_id >= offset);
      this.queues.set(botKey, queue);
    }
    return queue.slice(0, 100).map((update) => structuredClone(update));
  }

  private async getUpdates(botKey: string, params: Record<string, any>): Promise<Response> {
    if (this.conflicts.has(botKey)) {
      return json(409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" });
    }
    if (this.webhooks.get(botKey)?.url) {
      return json(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
    }
    const count = (this.inflight.get(botKey) ?? 0) + 1;
    this.inflight.set(botKey, count);
    this.maxInflight.set(botKey, Math.max(this.maxInflight.get(botKey) ?? 0, count));
    try {
      const deadline = Date.now() + Math.min(this.maxWaitMs, Number(params.timeout ?? 0) * 1000);
      for (;;) {
        const updates = this.pending(botKey, params.offset);
        if (updates.length > 0 || Date.now() >= deadline) return json(200, { ok: true, result: updates });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          this.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } finally {
      this.inflight.set(botKey, (this.inflight.get(botKey) ?? 1) - 1);
    }
  }

  private async dispatch(botKey: string, method: string, params: Record<string, any>): Promise<Response> {
    switch (method) {
      case "getUpdates":
        return this.getUpdates(botKey, params);
      case "getWebhookInfo":
        return ok({ url: this.webhooks.get(botKey)?.url ?? "", pending_update_count: 0 });
      case "setWebhook":
        this.webhooks.set(botKey, { url: params.url, secret: params.secret_token ?? null });
        return ok(true);
      case "deleteWebhook":
        this.webhooks.delete(botKey);
        return ok(true);
      case "sendMessage":
      case "sendPhoto":
      case "sendVideo": {
        const message: TelegramMessage = {
          message_id: this.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(params.chat_id) },
          ...(method === "sendMessage" ? { text: params.text } : { caption: params.caption ?? "" }),
          ...(method === "sendPhoto" ? { photo: [{ file_id: "photo-1" }] } : {}),
          ...(method === "sendVideo" ? { video: { file_id: "video-1" } } : {}),
          ...(params.reply_markup ? { reply_markup: params.reply_markup as InlineKeyboardMarkup } : {}),
        };
        this.messages.set(message.message_id, message);
        return ok(structuredClone(message));
      }
      case "editMessageCaption":
      case "editMessageText": {
        const message = this.messages.get(Number(params.message_id));
        if (!message || String(message.chat.id) !== String(params.chat_id)) return badRequest("Bad Request: message to edit not found");
        const media = Boolean(message.photo || message.video);
        if (method === "editMessageCaption" && !media) return badRequest("Bad Request: there is no caption in the message to edit");
        if (method === "editMessageText" && media) return badRequest("Bad Request: there is no text in the message to edit");
        const field = method === "editMessageCaption" ? "caption" : "text";
        const nextValue = method === "editMessageCaption" ? params.caption : params.text;
        const nextMarkup = params.reply_markup ?? undefined;
        if (message[field] === nextValue && JSON.stringify(message.reply_markup ?? null) === JSON.stringify(nextMarkup ?? null)) {
          return badRequest("Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
        }
        message[field] = nextValue;
        message.reply_markup = nextMarkup;
        return ok(structuredClone(message));
      }
      case "editMessageReplyMarkup": {
        const message = this.messages.get(Number(params.message_id));
        if (!message) return badRequest("Bad Request: message to edit not found");
        message.reply_markup = params.reply_markup;
        return ok(true);
      }
      case "answerCallbackQuery":
        return ok(true);
      default:
        return json(404, { ok: false, error_code: 404, description: "Not Found: method not found" });
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ok(result: unknown): Response {
  return json(200, { ok: true, result });
}

function badRequest(description: string): Response {
  return json(400, { ok: false, error_code: 400, description });
}
