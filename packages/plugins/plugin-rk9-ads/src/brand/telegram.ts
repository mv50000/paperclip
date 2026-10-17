/**
 * The brand's own Telegram bot, outside the running controller (A4, RK9-510).
 *
 * The preflight must check a brand that is not enabled yet, and the token
 * alert must reach a brand whose bot loop is down, so neither can rely on
 * `getTelegramController().botFor()`. This resolves `telegram.botTokenRef`
 * per call; the token stays inside the Bot API client. sendMessage, getMe,
 * getChat and getChatMember do not compete with the controller's getUpdates
 * loop (G17 is about getUpdates only).
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfigDraft } from "../config.js";
import { createBotApi, type BotApi, type TelegramFetch } from "../kit/telegram/bot-api.js";

const BOT_TOKEN_RE = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;

export type BrandBot =
  | { ok: true; api: BotApi; chatId: string }
  | { ok: false; reason: "not_configured" | "token_unresolved" | "token_malformed"; detail: string };

export interface BrandBotDeps {
  ctx: Pick<PluginContext, "secrets" | "http">;
  /** Defaults to `ctx.http.fetch`. */
  fetch?: TelegramFetch;
  apiBase?: string;
}

export async function resolveBrandBot(deps: BrandBotDeps, companyId: string, config: BrandConfigDraft): Promise<BrandBot> {
  const telegram = config.telegram;
  if (!telegram) return { ok: false, reason: "not_configured", detail: "the brand config has no telegram block" };
  let token: string;
  try {
    token = await deps.ctx.secrets.resolve(telegram.botTokenRef, { companyId, configPath: "telegram.botTokenRef" });
  } catch (error) {
    // The error name only: a host message may echo the reference.
    return { ok: false, reason: "token_unresolved", detail: `telegram.botTokenRef did not resolve (${error instanceof Error ? error.name : "unknown"})` };
  }
  token = typeof token === "string" ? token.trim() : "";
  if (!BOT_TOKEN_RE.test(token)) {
    return { ok: false, reason: "token_malformed", detail: "telegram.botTokenRef is not shaped like a Telegram bot token" };
  }
  const fetchImpl = deps.fetch ?? ((url: string, init?: RequestInit) => deps.ctx.http.fetch(url, init));
  return { ok: true, api: createBotApi({ token, fetch: fetchImpl, apiBase: deps.apiBase }), chatId: telegram.chatId };
}
