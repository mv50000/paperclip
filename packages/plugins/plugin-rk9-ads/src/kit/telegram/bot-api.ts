/**
 * Thin Telegram Bot API client (A5, RK9-509). The digest and every gate card
 * reuse it, so no other file builds a Bot API URL.
 *
 * The bot token is part of every request URL. It must never reach a log, a
 * state key, an activity entry or an error message, so:
 * - every error is a `TelegramApiError` whose message is built here from the
 *   method name and a redacted description, never from the URL;
 * - a transport error is re-thrown without `cause` (the cause can hold the URL);
 * - `telegramBotKey()` gives a stable, non-reversible id for state keys and
 *   ledger rows.
 *
 * Requests go through the `fetch` the caller passes in. The plugin passes
 * `ctx.http.fetch`: host SSRF checks and a 30 s host timeout apply, and the
 * request cannot be aborted on the host side (the SDK drops `signal`). The
 * poll loop therefore keeps the long-poll timeout at most 25 s and abandons
 * an in-flight request locally on shutdown.
 */

import { createHash } from "node:crypto";

export type TelegramFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Telegram limits: callback_data 64 bytes, caption 1024 chars, text 4096 chars. */
export const CALLBACK_DATA_MAX_BYTES = 64;
export const CAPTION_MAX_CHARS = 1024;
export const TEXT_MAX_CHARS = 4096;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  video?: { file_id: string };
  reply_markup?: InlineKeyboardMarkup;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  /** Absent or "inaccessible" (date 0) for very old messages. */
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface WebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_message?: string;
}

export interface GetUpdatesParams {
  offset?: number;
  timeout?: number;
  limit?: number;
  allowed_updates?: string[];
}

interface SendCommon {
  chat_id: string | number;
  reply_markup?: InlineKeyboardMarkup;
  parse_mode?: "HTML" | "MarkdownV2";
  disable_notification?: boolean;
}

export interface CallOptions {
  /** Passed to `fetch`. `ctx.http.fetch` ignores it; native fetch honours it. */
  signal?: AbortSignal;
}

/** One Bot API failure. The message never contains the token or the URL. */
export class TelegramApiError extends Error {
  readonly method: string;
  /** HTTP status; 0 when the request did not complete. */
  readonly status: number;
  /** Telegram `error_code` (often equal to the HTTP status). */
  readonly errorCode: number | null;
  readonly description: string;
  readonly retryAfterSeconds: number | null;

  constructor(method: string, input: { status: number; errorCode?: number | null; description: string; retryAfterSeconds?: number | null }) {
    super(`Telegram ${method} failed (${input.errorCode ?? input.status}): ${input.description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = input.status;
    this.errorCode = input.errorCode ?? null;
    this.description = input.description;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }

  /** 409: another getUpdates consumer, or a webhook is set on this bot. */
  get isConflict(): boolean {
    return this.errorCode === 409 || this.status === 409;
  }

  /** An edit that would not change the message. Safe to ignore. */
  get isNotModified(): boolean {
    return /message is not modified/i.test(this.description);
  }
}

const GENERIC_TOKEN_RE = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

const CREDENTIAL_PARAM_RE = /\b(access_token|token|secret|password|key|signature|appsecret_proof)=[^&\s"']+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Removes the token (and anything shaped like a bot token) from a string. */
export function redactToken(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join("<redacted>");
  return out.replace(GENERIC_TOKEN_RE, "<redacted>");
}

/**
 * `redactToken` plus credential-shaped query parameters (`access_token=...`)
 * and bearer headers. For error text from other APIs (for example Meta) that
 * reaches a log or a database column.
 */
export function redactSecrets(text: string, token?: string): string {
  return redactToken(text, token).replace(CREDENTIAL_PARAM_RE, "$1=<redacted>").replace(BEARER_RE, "Bearer <redacted>");
}

/**
 * Stable id for a bot token: sha256 over a fixed prefix and the token, first
 * 32 hex chars. Used in state keys and `processed_updates.bot_key`.
 */
export function telegramBotKey(token: string): string {
  return createHash("sha256").update(`telegram-bot-token:${token}`).digest("hex").slice(0, 32);
}

export interface BotApi {
  /** `telegramBotKey(token)`; safe to log. */
  readonly botKey: string;
  call<T>(method: string, params?: object, options?: CallOptions): Promise<T>;
  getUpdates(params: GetUpdatesParams, options?: CallOptions): Promise<TelegramUpdate[]>;
  getWebhookInfo(): Promise<WebhookInfo>;
  setWebhook(params: { url: string; secret_token: string; allowed_updates?: string[]; drop_pending_updates?: boolean }): Promise<boolean>;
  deleteWebhook(params?: { drop_pending_updates?: boolean }): Promise<boolean>;
  sendMessage(params: SendCommon & { text: string }): Promise<TelegramMessage>;
  sendPhoto(params: SendCommon & { photo: string; caption?: string }): Promise<TelegramMessage>;
  sendVideo(params: SendCommon & { video: string; caption?: string }): Promise<TelegramMessage>;
  editMessageCaption(params: { chat_id: string | number; message_id: number; caption: string; reply_markup?: InlineKeyboardMarkup }): Promise<unknown>;
  editMessageText(params: { chat_id: string | number; message_id: number; text: string; reply_markup?: InlineKeyboardMarkup }): Promise<unknown>;
  editMessageReplyMarkup(params: { chat_id: string | number; message_id: number; reply_markup?: InlineKeyboardMarkup }): Promise<unknown>;
  answerCallbackQuery(params: { callback_query_id: string; text?: string; show_alert?: boolean }): Promise<boolean>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createBotApi(input: { token: string; fetch: TelegramFetch; apiBase?: string }): BotApi {
  const { token } = input;
  if (typeof token !== "string" || token.length === 0) throw new Error("Telegram bot token is empty");
  const base = (input.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
  const fetchImpl = input.fetch;
  const botKey = telegramBotKey(token);

  async function call<T>(method: string, params: object = {}, options: CallOptions = {}): Promise<T> {
    if (!/^[A-Za-z]+$/.test(method)) throw new Error(`Invalid Telegram method name`);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // No `cause`: a transport error message or cause can carry the URL.
      throw new TelegramApiError(method, { status: 0, description: redactToken(errorText(error), token).slice(0, 300) });
    }
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      throw new TelegramApiError(method, { status: response.status, description: redactToken(errorText(error), token).slice(0, 300) });
    }
    let body: { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok || !body || body.ok !== true) {
      const description = redactToken(
        typeof body?.description === "string" ? body.description : `HTTP ${response.status}`,
        token,
      ).slice(0, 300);
      const retryAfter = body?.parameters?.retry_after;
      throw new TelegramApiError(method, {
        status: response.status,
        errorCode: typeof body?.error_code === "number" ? body.error_code : null,
        description,
        retryAfterSeconds: typeof retryAfter === "number" ? retryAfter : null,
      });
    }
    return body.result as T;
  }

  return {
    botKey,
    call,
    getUpdates: (params, options) => call<TelegramUpdate[]>("getUpdates", { ...params }, options),
    getWebhookInfo: () => call<WebhookInfo>("getWebhookInfo"),
    setWebhook: (params) => call<boolean>("setWebhook", params),
    deleteWebhook: (params = {}) => call<boolean>("deleteWebhook", params),
    sendMessage: (params) => call<TelegramMessage>("sendMessage", params),
    sendPhoto: (params) => call<TelegramMessage>("sendPhoto", params),
    sendVideo: (params) => call<TelegramMessage>("sendVideo", params),
    editMessageCaption: (params) => call("editMessageCaption", params),
    editMessageText: (params) => call("editMessageText", params),
    editMessageReplyMarkup: (params) => call("editMessageReplyMarkup", params),
    answerCallbackQuery: (params) => call<boolean>("answerCallbackQuery", params),
  };
}

/** Cards carry media (photo/video: caption edits) or only text (text edits). */
export type CardMedia = "photo" | "video" | "text";

export function messageMedia(message: TelegramMessage | undefined): CardMedia {
  if (message?.photo && message.photo.length > 0) return "photo";
  if (message?.video) return "video";
  return "text";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Edits a card's caption (photo/video) or text, with the status line appended
 * to the original text. `buttons: null` removes the inline keyboard.
 * "message is not modified" is not an error.
 */
export async function editCard(
  api: BotApi,
  input: {
    chatId: string | number;
    messageId: number;
    media: CardMedia;
    original: string;
    status: string;
    buttons?: InlineKeyboardMarkup | null;
  },
): Promise<void> {
  const replyMarkup = input.buttons === undefined || input.buttons === null ? { inline_keyboard: [] } : input.buttons;
  const suffix = `\n\n${input.status}`;
  try {
    if (input.media === "text") {
      await api.editMessageText({
        chat_id: input.chatId,
        message_id: input.messageId,
        text: clip(input.original, TEXT_MAX_CHARS - suffix.length) + suffix,
        reply_markup: replyMarkup,
      });
    } else {
      await api.editMessageCaption({
        chat_id: input.chatId,
        message_id: input.messageId,
        caption: clip(input.original, CAPTION_MAX_CHARS - suffix.length) + suffix,
        reply_markup: replyMarkup,
      });
    }
  } catch (error) {
    if (error instanceof TelegramApiError && error.isNotModified) return;
    throw error;
  }
}

/** Sends a card: photo or video with a caption, or a text message. */
export async function sendCard(
  api: BotApi,
  input: { chatId: string | number; media: CardMedia; mediaUrl?: string; text: string; buttons?: InlineKeyboardMarkup },
): Promise<TelegramMessage> {
  const common = { chat_id: input.chatId, ...(input.buttons ? { reply_markup: input.buttons } : {}) };
  if (input.media === "photo") {
    if (!input.mediaUrl) throw new Error("A photo card needs mediaUrl");
    return api.sendPhoto({ ...common, photo: input.mediaUrl, caption: clip(input.text, CAPTION_MAX_CHARS) });
  }
  if (input.media === "video") {
    if (!input.mediaUrl) throw new Error("A video card needs mediaUrl");
    return api.sendVideo({ ...common, video: input.mediaUrl, caption: clip(input.text, CAPTION_MAX_CHARS) });
  }
  return api.sendMessage({ ...common, text: clip(input.text, TEXT_MAX_CHARS) });
}
