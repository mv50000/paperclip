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
 *   the plugin never takes a bot from another consumer. A loop that stops on
 *   repeated 409s stays off until the config is saved again or the worker
 *   restarts.
 * - Webhook mode is implemented but OFF in the worker (`webhookMode`
 *   "disabled"): the host stores every webhook delivery's headers (the secret
 *   token) and body (the card tokens in reply_markup) in
 *   plugin_webhook_deliveries, so a database reader could forge an approval.
 *   See the ADR.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { listCompanyConfigs, loadCompanyConfig } from "../../company-configs.js";
import type { TelegramMode } from "../../config.js";
import { createCallbackRouter, type CallbackRouter, type GateAuditEvent, type GateBrand } from "../../kit/gate/callback-router.js";
import type { GateRegistry } from "../../kit/gate/registry.js";
import { createGateCard, type GateCard, type GateStore } from "../../kit/gate/state-machine.js";
import { createBotApi, redactSecrets, telegramBotKey, type BotApi, type TelegramFetch } from "../../kit/telegram/bot-api.js";
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
/** Kinds a brand can still decide while its config is unreadable: stopping, never spending. */
const HELD_BRAND_KINDS: readonly GateKind[] = ["pause_all"];
const RETRY_PLAN_MS = 60_000;
/**
 * First retry after a setup or config-change plan. Seen on a dev instance:
 * the host sends onConfigChanged before it refreshes the worker's list of
 * configured companies, so the first config read can be refused; and the host
 * refuses a proactive companies.list while any other invocation is in flight.
 */
const FIRST_RETRY_PLAN_MS = 5_000;
const PLAN_WAIT_ON_STOP_MS = 2_000;
const SHUTDOWN_HANDLER_WAIT_MS = 5_000;
const MIN_WEBHOOK_SECRET_CHARS = 32;
const BOT_TOKEN_RE = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;

export type PlanReason = "setup" | "config" | "retry";

/**
 * Runs a function in the async context of module load, outside any host
 * invocation. The SDK tags each worker->host call with the invocation it runs
 * in (AsyncLocalStorage), and the host refuses a call whose invocation has
 * ended ("missing, expired, or unknown invocation scope"). Planning, poll
 * loops and gate handlers outlive the onConfigChanged or webhook call that
 * started them, so they run detached. Seen on a dev instance.
 */
const detached: <R>(fn: () => R) => R = AsyncLocalStorage.snapshot();

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
  webhook: { digest: Buffer; url: string } | null;
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
  /** "disabled" (default): webhook-mode bots are not started and every delivery is refused. */
  webhookMode?: "disabled" | "enabled";
  pollTimeoutSeconds?: number;
  errorBackoffMs?: number;
  conflictBackoffMs?: number;
  retryPlanMs?: number;
}

function ownerKey(botKey: string) {
  return { scopeKind: "instance" as const, namespace: TELEGRAM_STATE_NAMESPACE, stateKey: `webhook-owner:${botKey}` };
}

function safe(error: unknown, token?: string): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), token).slice(0, 300);
}

function ready(entry: BotEntry): boolean {
  return entry.mode === "poll" ? entry.loop?.running === true : entry.webhook !== null;
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
  replan(reason: PlanReason = "config"): Promise<void> {
    this.chain = this.chain
      .then(() => detached(() => this.plan(reason)))
      .catch((error) => {
        this.ctx.logger.error("rk9-ads telegram: planning failed, retrying", { detail: safe(error) });
        this.holdAll("plan_failed");
        this.scheduleRetry(reason !== "retry");
      });
    return this.chain;
  }

  /**
   * Lets every brand decide stopping cards only, until a plan succeeds. Called
   * when a config change arrives and when a plan fails: the allowlists in
   * memory may be stale, so they must not approve spend.
   */
  holdAll(reason: "config_changed" | "plan_failed"): void {
    if (this.bots.size === 0) return;
    for (const entry of this.bots.values()) {
      entry.brands = new Map(
        [...entry.brands].map(([companyId, brand]): [string, BrandEntry] => [
          companyId,
          brand.allowedKinds ? brand : { ...brand, allowedKinds: HELD_BRAND_KINDS },
        ]),
      );
    }
    this.ctx.logger.warn("rk9-ads telegram: brands held for pause cards only until the next plan", { reason });
  }

  /** Resolves when the queued planning runs have finished. */
  whenPlanned(): Promise<void> {
    return this.chain;
  }

  async stop(): Promise<void> {
    // From here on, no planning run starts a loop or sets a webhook.
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await Promise.race([this.chain, new Promise((resolve) => setTimeout(resolve, PLAN_WAIT_ON_STOP_MS).unref?.())]);
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
  summary(): Array<{ botKey: string; mode: TelegramMode; companies: string[]; ready: boolean; loop: string | null }> {
    return [...this.bots.values()].map((entry) => ({
      botKey: entry.botKey,
      mode: entry.mode,
      companies: [...entry.brands.keys()],
      ready: ready(entry),
      loop: entry.loop?.status ?? null,
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
      if (brand && !brand.allowedKinds && ready(entry)) return { api: entry.api, chatId: brand.chatId, brandCode: brand.brandCode };
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
    if (this.options.webhookMode !== "enabled") {
      this.ctx.logger.warn("rk9-ads telegram: webhook delivery rejected", { reason: "webhook_mode_disabled", requestId: input.requestId });
      throw new Error("Telegram webhook rejected (webhook mode is disabled)");
    }
    const candidates = [...this.bots.values()]
      .filter((entry) => entry.mode === "webhook" && entry.webhook)
      .map((entry) => ({ digest: entry.webhook!.digest, value: entry }));
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
    const { router } = verified.value;
    await detached(() => router.handleUpdate(update));
  }

  /**
   * The brand as saved now, for a tap that would spend. The list in memory can
   * be stale: a plan may still run on an older read, and the host does not
   * retry a configChanged call that failed. Null unless the saved config still
   * binds this bot.
   */
  private async freshBrand(botKey: string, companyId: string): Promise<GateBrand | null> {
    const result = await loadCompanyConfig(this.ctx, companyId);
    if (result.state !== "enabled" || !result.config.telegram) return null;
    const telegram = result.config.telegram;
    const token = await this.ctx.secrets.resolve(telegram.botTokenRef, { companyId, configPath: "telegram.botTokenRef" });
    if (typeof token !== "string" || telegramBotKey(token.trim()) !== botKey) return null;
    return { companyId, chatId: telegram.chatId, allowedUserIds: [...telegram.allowedUserIds] };
  }

  private scheduleRetry(first = false): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = this.options.retryPlanMs ?? (first ? FIRST_RETRY_PLAN_MS : RETRY_PLAN_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.replan("retry");
    }, delay);
    this.retryTimer.unref?.();
  }

  private async plan(reason: PlanReason): Promise<void> {
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
        ctx.logger.warn("rk9-ads telegram: bot token did not resolve", { companyId, detail: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      token = typeof token === "string" ? token.trim() : "";
      if (!BOT_TOKEN_RE.test(token)) {
        ctx.logger.warn("rk9-ads telegram: bot token is empty or not shaped like a Telegram bot token", { companyId });
        continue;
      }
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
          ctx.logger.warn("rk9-ads telegram: webhook secret did not resolve", { companyId, detail: error instanceof Error ? error.name : "unknown" });
        }
      }
      desired.set(botKey, bot);
    }
    if (this.stopped) return;

    // A company whose config the host refused stays on its current bot, but
    // only for stopping kinds: its allowlist may be stale, so it cannot approve spend.
    const keep = new Set<string>();
    for (const [botKey, entry] of this.bots) {
      const held = [...entry.brands.values()]
        .filter((brand) => unavailable.has(brand.companyId))
        .map((brand): BrandEntry => ({ ...brand, allowedKinds: HELD_BRAND_KINDS }));
      if (held.length === 0) continue;
      ctx.logger.warn("rk9-ads telegram: config unavailable, keeping the current bot for pause cards only", {
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

    // Webhook secrets tell bots apart on the one endpoint: a shared secret is refused.
    const digestOwners = new Map<string, string[]>();
    for (const [botKey, bot] of desired) {
      for (const hook of bot.webhooks) {
        const hex = webhookSecretDigest(hook.secret).toString("hex");
        const owners = digestOwners.get(hex) ?? [];
        if (!owners.includes(botKey)) owners.push(botKey);
        digestOwners.set(hex, owners);
      }
    }
    const sharedSecretBots = new Set([...digestOwners.values()].filter((owners) => owners.length > 1).flat());

    // Stop bots that are gone, changed mode, or whose loop is no longer running.
    for (const [botKey, entry] of [...this.bots]) {
      if (keep.has(botKey)) continue;
      const bot = desired.get(botKey);
      const sameMode = bot !== undefined && bot.modes.size === 1 && bot.modes.has(entry.mode);
      let keepEntry = sameMode;
      if (keepEntry && entry.mode === "poll") {
        // A loop that stopped on repeated 409s waits for a config save, not for the retry timer.
        keepEntry = entry.loop?.running === true || (reason === "retry" && entry.loop?.status === "conflict");
      }
      if (keepEntry && entry.mode === "webhook") {
        const first = bot!.webhooks[0];
        keepEntry =
          entry.webhook !== null &&
          first !== undefined &&
          first.url === entry.webhook.url &&
          webhookSecretDigest(first.secret).equals(entry.webhook.digest) &&
          !sharedSecretBots.has(botKey);
      }
      if (keepEntry) {
        entry.brands = bot!.brands;
        continue;
      }
      await entry.loop?.stop();
      this.bots.delete(botKey);
      if (!bot) ctx.logger.info("rk9-ads telegram: bot stopped", { botKey });
    }

    for (const [botKey, bot] of desired) {
      if (this.stopped) return;
      if (this.bots.has(botKey)) continue;
      if (bot.modes.size !== 1) {
        ctx.logger.error("rk9-ads telegram: poll and webhook mode on one bot token; the bot is not started", {
          botKey,
          companies: [...bot.brands.keys()],
        });
        continue;
      }
      const mode = [...bot.modes][0]!;
      if (mode === "webhook" && this.options.webhookMode !== "enabled") {
        ctx.logger.error(
          "rk9-ads telegram: webhook mode is disabled (the host stores webhook headers and bodies in plain text); use poll mode",
          { botKey, companies: [...bot.brands.keys()] },
        );
        continue;
      }
      if (mode === "webhook" && sharedSecretBots.has(botKey)) {
        ctx.logger.error("rk9-ads telegram: two bots use the same webhook secret; the bot is not started", { botKey });
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
        webhook: null,
        router: null as unknown as CallbackRouter,
      };
      entry.router = createCallbackRouter({
        api,
        store: this.options.store,
        registry: this.options.registry,
        brandFor: (companyId) => entry.brands.get(companyId) ?? null,
        freshBrandFor: (companyId) => this.freshBrand(botKey, companyId),
        cachedKinds: HELD_BRAND_KINDS,
        logger: ctx.logger,
        audit: (event) => this.audit(event),
      });
      this.bots.set(botKey, entry);
      const started = mode === "poll" ? await this.startPolling(entry) : await this.startWebhook(entry, bot);
      if (!started) retry = true;
    }

    if (retry) this.scheduleRetry(reason !== "retry");
    ctx.logger.info("rk9-ads telegram: plan done", {
      reason,
      bots: [...this.bots.values()].map((entry) => ({ botKey: entry.botKey, mode: entry.mode, ready: ready(entry), companies: entry.brands.size })),
      retryScheduled: retry,
    });
  }

  private async startPolling(entry: BotEntry): Promise<boolean> {
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
          return false;
        }
        if (this.stopped) return true;
        await entry.api.deleteWebhook({ drop_pending_updates: false });
        await ctx.state.delete(ownerKey(entry.botKey));
        ctx.logger.info("rk9-ads telegram: removed this plugin's own webhook for poll mode", { botKey: entry.botKey });
      }
    } catch (error) {
      // getUpdates reports a webhook conflict (409) on its own.
      ctx.logger.warn("rk9-ads telegram: webhook check failed, polling anyway", { botKey: entry.botKey, detail: safe(error) });
    }
    if (this.stopped) return true;
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
    return true;
  }

  private async startWebhook(entry: BotEntry, bot: DesiredBot): Promise<boolean> {
    const { ctx } = this;
    const first = bot.webhooks[0];
    if (!first) {
      ctx.logger.error("rk9-ads telegram: webhook mode needs a resolved secret and URL", { botKey: entry.botKey });
      return false;
    }
    const digest = webhookSecretDigest(first.secret);
    if (bot.webhooks.some((hook) => hook.url !== first.url || !webhookSecretDigest(hook.secret).equals(digest))) {
      ctx.logger.error("rk9-ads telegram: brands on one bot token disagree on the webhook URL or secret", { botKey: entry.botKey });
      return true;
    }
    if (!isValidWebhookSecret(first.secret) || first.secret.length < MIN_WEBHOOK_SECRET_CHARS) {
      ctx.logger.error(
        `rk9-ads telegram: webhook secret must be ${MIN_WEBHOOK_SECRET_CHARS}-256 chars of A-Z, a-z, 0-9, _ or -`,
        { botKey: entry.botKey },
      );
      return true;
    }
    try {
      const info = await entry.api.getWebhookInfo();
      const owned = await ctx.state.get(ownerKey(entry.botKey));
      // Our own URL, or a fresh bot (no webhook, no owner marker): webhook mode is the operator's explicit choice.
      if (info.url !== first.url && info.url !== owned && !(info.url === "" && owned === null)) {
        ctx.logger.error("rk9-ads telegram: the bot has a webhook set by another consumer; webhook mode refused", {
          botKey: entry.botKey,
        });
        return false;
      }
      if (this.stopped) return true;
      await entry.api.setWebhook({
        url: first.url,
        secret_token: first.secret,
        allowed_updates: [...POLL_ALLOWED_UPDATES],
        drop_pending_updates: false,
      });
      await ctx.state.set(ownerKey(entry.botKey), first.url);
    } catch (error) {
      ctx.logger.error("rk9-ads telegram: setWebhook failed", { botKey: entry.botKey, detail: safe(error, bot.token) });
      return false;
    }
    entry.webhook = { digest, url: first.url };
    ctx.logger.info("rk9-ads telegram: webhook mode ready", { botKey: entry.botKey });
    return true;
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
