/**
 * Telegram transport of the ads plugin (A5, RK9-509): maps brand configs to
 * bots and runs one consumer per distinct bot token.
 *
 * - The token comes only from `ctx.secrets.resolve(telegram.botTokenRef)`. It
 *   stays inside the Bot API client; logs, state keys and activity entries
 *   use the bot key (a token hash).
 * - Brands that share a token share one bot entry (one getUpdates loop). The
 *   router checks each tap against the brand of the card's company.
 * - Poll mode (default): one long-poll loop. A webhook on the bot is deleted
 *   only when this plugin set it (owner marker in state); a webhook set by
 *   anyone else (core chat-channels, another instance) refuses poll mode, so
 *   the plugin never takes a bot from another consumer.
 * - Webhook mode: setWebhook with secret_token, and deliveries are verified
 *   against the secret digest. Poll and webhook on one token conflict, and
 *   that bot is not started.
 */

import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { listCompanyConfigs } from "../../company-configs.js";
import type { TelegramMode } from "../../config.js";
import { createCallbackRouter, type CallbackRouter, type GateAuditEvent, type GateBrand } from "../../kit/gate/callback-router.js";
import type { GateRegistry } from "../../kit/gate/registry.js";
import { createGateCard, type GateCard, type GateStore } from "../../kit/gate/state-machine.js";
import { createBotApi, redactToken, telegramBotKey, type BotApi, type TelegramFetch } from "../../kit/telegram/bot-api.js";
import {
  createPollLoop,
  POLL_ALLOWED_UPDATES,
  stateOffsetStore,
  TELEGRAM_STATE_NAMESPACE,
  type PollLoop,
} from "../../kit/telegram/poll-loop.js";
import {
  isValidWebhookSecret,
  parseWebhookUpdate,
  verifyWebhookSecret,
  webhookSecretDigest,
} from "../../kit/telegram/webhook.js";
import type { GateKind } from "./gates.js";

export const GATE_ACTIVITY_PREFIX = "rk9-ads gate";
const RETRY_PLAN_MS = 60_000;
const SHUTDOWN_HANDLER_WAIT_MS = 5_000;

interface BrandEntry extends GateBrand {
  brandCode: string;
}

interface BotEntry {
  botKey: string;
  mode: TelegramMode;
  api: BotApi;
  brands: Map<string, BrandEntry>;
  router: CallbackRouter;
  loop: PollLoop | null;
  webhookDigest: Buffer | null;
  ready: boolean;
}

interface DesiredBot {
  token: string;
  modes: Set<TelegramMode>;
  brands: Map<string, BrandEntry>;
  webhooks: Array<{ companyId: string; secret: string; url: string }>;
}

export interface TelegramControllerOptions {
  store: GateStore;
  registry: GateRegistry;
  /** Defaults to `ctx.http.fetch`. */
  fetch?: TelegramFetch;
  apiBase?: string;
  pollTimeoutSeconds?: number;
  errorBackoffMs?: number;
  conflictBackoffMs?: number;
  retryPlanMs?: number;
}

function ownerKey(botKey: string) {
  return { scopeKind: "instance" as const, namespace: TELEGRAM_STATE_NAMESPACE, stateKey: `webhook-owner:${botKey}` };
}

function safe(error: unknown, token?: string): string {
  return redactToken(error instanceof Error ? error.message : String(error), token).slice(0, 300);
}

export class TelegramController {
  private readonly ctx: PluginContext;
  private readonly options: TelegramControllerOptions;
  private readonly bots = new Map<string, BotEntry>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: PluginContext, options: TelegramControllerOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  /** Re-reads every brand config and starts, keeps or stops bots. Serialized. */
  replan(): Promise<void> {
    this.chain = this.chain
      .then(() => this.plan())
      .catch((error) => {
        this.ctx.logger.error("rk9-ads telegram: planning failed", { error: safe(error) });
      });
    return this.chain;
  }

  /** Resolves when the queued planning runs have finished. */
  whenPlanned(): Promise<void> {
    return this.chain;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.chain;
    const entries = [...this.bots.values()];
    this.bots.clear();
    await Promise.all(entries.map((entry) => entry.loop?.stop()));
    // Give running handlers a moment to edit their final outcome.
    await Promise.race([
      Promise.all(entries.map((entry) => entry.router.idle())),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_HANDLER_WAIT_MS).unref?.()),
    ]);
  }

  /** Bot summary for health and tests. No token, no secret. */
  summary(): Array<{ botKey: string; mode: TelegramMode; companies: string[]; polling: boolean; ready: boolean }> {
    return [...this.bots.values()].map((entry) => ({
      botKey: entry.botKey,
      mode: entry.mode,
      companies: [...entry.brands.keys()],
      polling: entry.loop?.running ?? false,
      ready: entry.ready,
    }));
  }

  /** Waits for handler runs of every bot (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.bots.values()].map((entry) => entry.router.idle()));
  }

  /** The bot and chat of a company, for the digest and gate cards. */
  botFor(companyId: string): { api: BotApi; chatId: string; brandCode: string } | null {
    for (const entry of this.bots.values()) {
      const brand = entry.brands.get(companyId);
      if (brand && entry.ready) return { api: entry.api, chatId: brand.chatId, brandCode: brand.brandCode };
    }
    return null;
  }

  /** Posts a gate card to the company's chat. See kit/gate/state-machine createGateCard. */
  async sendGateCard(input: {
    companyId: string;
    kind: GateKind;
    validUntil: Date;
    card: GateCard & { mediaUrl?: string };
    payload?: Record<string, unknown>;
  }): Promise<{ id: string; messageId: number }> {
    const bot = this.botFor(input.companyId);
    if (!bot) throw new Error("Telegram is not configured or not ready for this company");
    return createGateCard({
      store: this.options.store,
      api: bot.api,
      registry: this.options.registry,
      companyId: input.companyId,
      brandCode: bot.brandCode,
      kind: input.kind,
      chatId: bot.chatId,
      validUntil: input.validUntil,
      card: input.card,
      payload: input.payload,
    });
  }

  async handleWebhook(input: PluginWebhookInput): Promise<void> {
    const candidates = [...this.bots.values()]
      .filter((entry) => entry.mode === "webhook" && entry.ready && entry.webhookDigest)
      .map((entry) => ({ digest: entry.webhookDigest!, value: entry }));
    const verified = verifyWebhookSecret(input.headers, candidates);
    if (!verified.ok) {
      this.ctx.logger.warn("rk9-ads telegram: webhook delivery rejected", { reason: verified.reason, requestId: input.requestId });
      throw new Error(`Telegram webhook rejected (${verified.reason})`);
    }
    const update = parseWebhookUpdate(input.parsedBody, input.rawBody);
    if (!update) {
      // Accept it: a retry would not make it valid.
      this.ctx.logger.warn("rk9-ads telegram: webhook body is not an update", { requestId: input.requestId });
      return;
    }
    await verified.value.router.handleUpdate(update);
  }

  private async plan(): Promise<void> {
    if (this.stopped) return;
    const { ctx } = this;
    let retry = false;
    const desired = new Map<string, DesiredBot>();
    const unavailable = new Set<string>();

    for (const { companyId, result } of await listCompanyConfigs(ctx)) {
      if (result.state === "unavailable") {
        retry = true;
        unavailable.add(companyId);
        continue;
      }
      if (result.state !== "enabled" || !result.config.telegram) continue;
      const telegram = result.config.telegram;
      let token: string;
      try {
        token = await ctx.secrets.resolve(telegram.botTokenRef, { companyId, configPath: "telegram.botTokenRef" });
      } catch (error) {
        retry = true;
        ctx.logger.warn("rk9-ads telegram: bot token did not resolve", { companyId, error: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      if (typeof token !== "string" || token.trim() === "") {
        ctx.logger.warn("rk9-ads telegram: bot token is empty", { companyId });
        continue;
      }
      token = token.trim();
      const botKey = telegramBotKey(token);
      const bot: DesiredBot = desired.get(botKey) ?? { token, modes: new Set(), brands: new Map(), webhooks: [] };
      bot.modes.add(telegram.mode);
      bot.brands.set(companyId, {
        companyId,
        chatId: telegram.chatId,
        allowedUserIds: [...telegram.allowedUserIds],
        brandCode: result.config.brandCode,
      });
      if (telegram.mode === "webhook" && telegram.webhookSecretRef && telegram.webhookUrl) {
        try {
          const secret = await ctx.secrets.resolve(telegram.webhookSecretRef, { companyId, configPath: "telegram.webhookSecretRef" });
          bot.webhooks.push({ companyId, secret, url: telegram.webhookUrl });
        } catch (error) {
          retry = true;
          ctx.logger.warn("rk9-ads telegram: webhook secret did not resolve", { companyId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      desired.set(botKey, bot);
    }

    // A company whose config the host refused stays on its current bot,
    // instead of losing its gate on a host hiccup.
    const keep = new Set<string>();
    for (const [botKey, entry] of this.bots) {
      const held = [...entry.brands.values()].filter((brand) => unavailable.has(brand.companyId));
      if (held.length === 0) continue;
      ctx.logger.warn("rk9-ads telegram: config unavailable, keeping the current bot", {
        botKey,
        companies: held.map((brand) => brand.companyId),
      });
      const bot = desired.get(botKey);
      if (bot) {
        for (const brand of held) if (!bot.brands.has(brand.companyId)) bot.brands.set(brand.companyId, brand);
      } else {
        keep.add(botKey);
        entry.brands = new Map(held.map((brand) => [brand.companyId, brand]));
      }
    }

    // Stop bots that are gone or changed mode. Webhook bots are set up again,
    // so a rotated secret or URL takes effect.
    for (const [botKey, entry] of [...this.bots]) {
      if (keep.has(botKey)) continue;
      const bot = desired.get(botKey);
      if (!bot || bot.modes.size !== 1 || !bot.modes.has(entry.mode) || entry.mode === "webhook") {
        await entry.loop?.stop();
        entry.ready = false;
        this.bots.delete(botKey);
        if (!bot) ctx.logger.info("rk9-ads telegram: bot stopped", { botKey });
      }
    }

    for (const [botKey, bot] of desired) {
      if (this.stopped) return;
      if (bot.modes.size !== 1) {
        ctx.logger.error("rk9-ads telegram: poll and webhook mode on one bot token; the bot is not started", {
          botKey,
          companies: [...bot.brands.keys()],
        });
        continue;
      }
      const mode = [...bot.modes][0]!;
      const existing = this.bots.get(botKey);
      if (existing) {
        // Same token, same poll mode: keep the loop, take the new brand list.
        existing.brands = bot.brands;
        continue;
      }
      const api = createBotApi({
        token: bot.token,
        fetch: this.options.fetch ?? ((url, init) => ctx.http.fetch(url, init)),
        ...(this.options.apiBase ? { apiBase: this.options.apiBase } : {}),
      });
      const entry: BotEntry = {
        botKey,
        mode,
        api,
        brands: bot.brands,
        loop: null,
        webhookDigest: null,
        ready: false,
        router: null as unknown as CallbackRouter,
      };
      entry.router = createCallbackRouter({
        api,
        store: this.options.store,
        registry: this.options.registry,
        brandFor: (companyId) => entry.brands.get(companyId) ?? null,
        logger: ctx.logger,
        audit: (event) => this.audit(event),
      });
      this.bots.set(botKey, entry);
      if (mode === "poll") await this.startPolling(entry);
      else await this.startWebhook(entry, bot);
    }

    if (retry && !this.stopped) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.replan();
      }, this.options.retryPlanMs ?? RETRY_PLAN_MS);
      this.retryTimer.unref?.();
    }
  }

  private async startPolling(entry: BotEntry): Promise<void> {
    const { ctx } = this;
    try {
      const info = await entry.api.getWebhookInfo();
      if (info.url) {
        const owned = await ctx.state.get(ownerKey(entry.botKey));
        if (owned !== info.url) {
          ctx.logger.error(
            "rk9-ads telegram: the bot has a webhook set by another consumer; poll mode refused. The plugin needs its own bot, separate from dev, core chat-channels and other listeners.",
            { botKey: entry.botKey },
          );
          return;
        }
        await entry.api.deleteWebhook({ drop_pending_updates: false });
        await ctx.state.delete(ownerKey(entry.botKey));
        ctx.logger.info("rk9-ads telegram: removed this plugin's own webhook for poll mode", { botKey: entry.botKey });
      }
    } catch (error) {
      // getUpdates reports a webhook conflict (409) on its own.
      ctx.logger.warn("rk9-ads telegram: webhook check failed, polling anyway", { botKey: entry.botKey, error: safe(error) });
    }
    if (this.stopped) return;
    entry.loop = createPollLoop({
      api: entry.api,
      offsets: stateOffsetStore(ctx.state, entry.botKey),
      onUpdate: (update) => entry.router.handleUpdate(update),
      logger: ctx.logger,
      ...(this.options.pollTimeoutSeconds !== undefined ? { timeoutSeconds: this.options.pollTimeoutSeconds } : {}),
      ...(this.options.errorBackoffMs !== undefined ? { errorBackoffMs: this.options.errorBackoffMs } : {}),
      ...(this.options.conflictBackoffMs !== undefined ? { conflictBackoffMs: this.options.conflictBackoffMs } : {}),
    });
    entry.loop.start();
    entry.ready = true;
  }

  private async startWebhook(entry: BotEntry, bot: DesiredBot): Promise<void> {
    const { ctx } = this;
    const first = bot.webhooks[0];
    if (!first || bot.webhooks.length !== bot.brands.size) {
      ctx.logger.error("rk9-ads telegram: webhook mode needs a resolved secret and URL for every brand", { botKey: entry.botKey });
      return;
    }
    const digest = webhookSecretDigest(first.secret);
    if (bot.webhooks.some((hook) => hook.url !== first.url || !webhookSecretDigest(hook.secret).equals(digest))) {
      ctx.logger.error("rk9-ads telegram: brands on one bot token disagree on the webhook URL or secret", { botKey: entry.botKey });
      return;
    }
    if (!isValidWebhookSecret(first.secret)) {
      ctx.logger.error("rk9-ads telegram: webhook secret must be 1-256 chars of A-Z, a-z, 0-9, _ or -", { botKey: entry.botKey });
      return;
    }
    try {
      const info = await entry.api.getWebhookInfo();
      const owned = await ctx.state.get(ownerKey(entry.botKey));
      if (info.url && info.url !== first.url && info.url !== owned) {
        ctx.logger.error("rk9-ads telegram: the bot has a webhook set by another consumer; webhook mode refused", {
          botKey: entry.botKey,
        });
        return;
      }
      await entry.api.setWebhook({
        url: first.url,
        secret_token: first.secret,
        allowed_updates: [...POLL_ALLOWED_UPDATES],
        drop_pending_updates: false,
      });
      await ctx.state.set(ownerKey(entry.botKey), first.url);
    } catch (error) {
      ctx.logger.error("rk9-ads telegram: setWebhook failed", { botKey: entry.botKey, error: safe(error, bot.token) });
      return;
    }
    entry.webhookDigest = digest;
    entry.ready = true;
    ctx.logger.info("rk9-ads telegram: webhook mode ready", { botKey: entry.botKey });
  }

  private async audit(event: GateAuditEvent): Promise<void> {
    const { companyId, gateRequestId, type, ...rest } = event;
    await this.ctx.activity.log({
      companyId,
      message: `${GATE_ACTIVITY_PREFIX}: ${type}`,
      entityType: "gate_request",
      entityId: gateRequestId,
      metadata: rest,
    });
  }
}

let current: TelegramController | null = null;

export function setTelegramController(controller: TelegramController | null): void {
  current = controller;
}

/** The running worker's controller (digest and gate features). */
export function getTelegramController(): TelegramController | null {
  return current;
}
