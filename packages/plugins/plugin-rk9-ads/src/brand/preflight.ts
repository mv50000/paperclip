/**
 * Live preflight of one brand ("Tarkista yhteys", A4 RK9-510).
 *
 * `onValidateConfig` is offline (the host gives it no companyId), so the live
 * check is the `verify-connection` action. It returns one result per check,
 * each with a typed reason:
 * - token_scopes: the Meta token has ads_management and ads_read
 *   (`me/permissions`; `debug_token` would put the token in a query string);
 * - ad_account: reachable, EUR, time zone = config.timeZone (Europe/Helsinki
 *   by default), account_status 1;
 * - spend_cap: a spend_cap is set, its headroom (spend_cap - amount_spent) is
 *   above 0 and at most what is left of the monthly cap (G2; the same month
 *   position and reason codes as the spend guard, RK9-526);
 * - page: reachable;
 * - ig_actor: the configured igUserId, or the page's instagram_business_account;
 * - dataset: attached to the ad account (only when datasetId is set);
 * - telegram: the bot can post to telegram.chatId (getChat + getChatMember,
 *   no test message).
 *
 * launchReady = every required check passed AND monthlyCapEur is set. The
 * result is cached in plugin state with checkedAt and a fingerprint of the
 * config. `assertLaunchReady` is the gate of every mutating path (provision
 * here, activation in A9): it re-runs the preflight when the cache is stale,
 * belongs to another config or is not launch-ready, and refuses when the
 * fresh result is not launch-ready.
 *
 * No result, log line or activity entry carries a resolved secret: the Meta
 * token stays inside the Meta client, the bot token inside the Bot API client,
 * and every detail text is redacted.
 */

import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { loadCompanyConfig } from "../company-configs.js";
import type { BrandConfig, BrandConfigDraft } from "../config.js";
import type { OnceStore } from "../features/spend-guard/support.js";
import { monthPosition } from "../features/spend-guard/position.js";
import { localMonthBounds } from "../kit/local-time.js";
import { TelegramApiError, redactSecrets } from "../kit/telegram/bot-api.js";
import { MetaGraphError, TokenInvalidError, TokenResolveError } from "../meta/errors.js";
import { createMetaClient, type MetaGraphClient } from "../meta/graph.js";
import {
  getAccountSpendCents,
  getAccountSummary,
  getInstagramUser,
  getPage,
  getTokenPermissions,
  listAdAccountDatasets,
  type PageSummary,
} from "../meta/methods.js";
import { redactText } from "../meta/redact.js";
import type { AccountSummary } from "../meta/types.js";
import { resolveBrandBot, type BrandBotDeps } from "./telegram.js";
import { clearTokenIncident, reportTokenInvalid, type TokenIncidentReport } from "./token-alert.js";

export const PREFLIGHT_CHECKS = ["token_scopes", "ad_account", "spend_cap", "page", "ig_actor", "dataset", "telegram"] as const;
export type PreflightCheckKey = (typeof PREFLIGHT_CHECKS)[number];

export const REQUIRED_SCOPES = ["ads_management", "ads_read"] as const;
export const REQUIRED_CURRENCY = "EUR";
export const ACTIVE_ACCOUNT_STATUS = 1;
/** A cached result older than this is re-run before any mutating action. */
export const PREFLIGHT_TTL_MS = 15 * 60_000;

export const PREFLIGHT_REASONS = [
  "ok",
  // any Meta check
  "token_unresolved",
  "token_invalid",
  "meta_error",
  // token_scopes
  "missing_scopes",
  // ad_account
  "account_unreachable",
  "currency_not_eur",
  "timezone_mismatch",
  "account_not_active",
  // spend_cap (same codes as the spend guard)
  "monthly_cap_unset",
  "no_spend_cap",
  "spend_cap_reached",
  "spend_cap_headroom_exceeds_remaining",
  // page / ig_actor / dataset
  "page_unreachable",
  "ig_not_linked",
  "ig_unreachable",
  "dataset_not_configured",
  "dataset_not_attached",
  // telegram
  "telegram_not_configured",
  "telegram_token_unresolved",
  "telegram_token_invalid",
  "telegram_chat_unreachable",
  "telegram_cannot_post",
  "telegram_error",
] as const;
export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];

export type CheckStatus = "pass" | "fail" | "skipped";
export type CheckData = Record<string, string | number | boolean | null | string[]>;

export interface PreflightCheck {
  check: PreflightCheckKey;
  status: CheckStatus;
  /** A failed required check blocks launch. A skipped check is never required. */
  required: boolean;
  reason: PreflightReason;
  /** Short, redacted text for the operator. */
  detail: string;
  data?: CheckData;
}

export interface PreflightResult {
  companyId: string;
  brandCode: string;
  checkedAt: string;
  /** sha256 of the parsed config (secret refs, never secret values). */
  configFingerprint: string;
  monthlyCapEur: number | null;
  launchReady: boolean;
  checks: PreflightCheck[];
  /** The IG user the ads use: configured, or resolved from the page. */
  igUserId: string | null;
  tokenIncident?: TokenIncidentReport;
}

export interface PreflightDeps {
  ctx: Pick<PluginContext, "secrets" | "http" | "logger" | "activity" | "state" | "issues">;
  store: OnceStore;
  pluginId: string;
  now: () => Date;
  /** Read-only Meta client of the brand. Defaults to createMetaClient in readOnly mode. */
  metaClient?: (companyId: string, config: BrandConfigDraft) => MetaGraphClient;
  telegram?: Omit<BrandBotDeps, "ctx">;
}

/** Thrown by assertLaunchReady. `result` is the fresh preflight that refused. */
export class LaunchNotReadyError extends Error {
  readonly result: PreflightResult | null;
  readonly failed: Array<{ check: PreflightCheckKey | "config"; reason: string }>;

  constructor(message: string, result: PreflightResult | null, failed: LaunchNotReadyError["failed"]) {
    super(message);
    this.name = "LaunchNotReadyError";
    this.result = result;
    this.failed = failed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function configFingerprint(config: BrandConfigDraft): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function safeDetail(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(redactText(text)).slice(0, 300);
}

function cents(value: number | null): number | null {
  return value === null ? null : Math.round(value) / 100;
}

function check(
  key: PreflightCheckKey,
  status: CheckStatus,
  reason: PreflightReason,
  detail: string,
  options: { required?: boolean; data?: CheckData } = {},
): PreflightCheck {
  return {
    check: key,
    status,
    required: status === "skipped" ? false : options.required ?? true,
    reason,
    detail: redactText(detail).slice(0, 300),
    ...(options.data ? { data: options.data } : {}),
  };
}

/** True when the error means the token itself does not work; every later Meta check is then skipped. */
function tokenFailure(error: unknown): "token_unresolved" | "token_invalid" | null {
  if (error instanceof TokenResolveError) return "token_unresolved";
  if (error instanceof TokenInvalidError) return "token_invalid";
  return null;
}

export function isLaunchReady(monthlyCapEur: number | null, checks: readonly PreflightCheck[]): boolean {
  return monthlyCapEur !== null && checks.every((entry) => !entry.required || entry.status === "pass");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function accountCheck(config: BrandConfigDraft, summary: AccountSummary): PreflightCheck {
  const data: CheckData = {
    accountId: summary.accountId,
    currency: summary.currency,
    timezone: summary.timezone,
    expectedTimezone: config.timeZone,
    accountStatus: summary.statusCode,
  };
  const problems: Array<[PreflightReason, string]> = [];
  if (summary.currency !== REQUIRED_CURRENCY) problems.push(["currency_not_eur", `currency is ${summary.currency}, not ${REQUIRED_CURRENCY}`]);
  if (summary.timezone !== config.timeZone) problems.push(["timezone_mismatch", `time zone is ${summary.timezone}, the brand uses ${config.timeZone}`]);
  if (summary.statusCode !== ACTIVE_ACCOUNT_STATUS) problems.push(["account_not_active", `account_status is ${summary.statusCode ?? "unknown"} (${summary.status}), not 1 (ACTIVE)`]);
  if (problems.length === 0) return check("ad_account", "pass", "ok", `act_${summary.accountId}: EUR, ${summary.timezone}, active`, { data });
  return check("ad_account", "fail", problems[0]![0], problems.map(([, text]) => text).join("; "), { data });
}

async function spendCapCheck(
  client: MetaGraphClient,
  config: BrandConfigDraft,
  summary: AccountSummary,
  now: Date,
): Promise<PreflightCheck> {
  const base: CheckData = {
    spendCapEur: cents(summary.spendCapCents),
    amountSpentEur: cents(summary.amountSpentCents),
    monthlyCapEur: config.monthlyCapEur,
  };
  if (summary.currency !== REQUIRED_CURRENCY) {
    return check("spend_cap", "fail", "currency_not_eur", `spend_cap cannot be compared: the account currency is ${summary.currency}`, { data: base });
  }
  if (config.monthlyCapEur === null) {
    return check("spend_cap", "fail", "monthly_cap_unset", "monthlyCapEur is not set, so the headroom cannot be checked", { data: base });
  }
  if (summary.spendCapCents === null) {
    return check("spend_cap", "fail", "no_spend_cap", "the ad account has no spend_cap (set it in Billing Hub to at most the monthly cap)", { data: base });
  }
  const bounds = localMonthBounds(now, config.timeZone);
  const mtdCents = await getAccountSpendCents(client, `act_${config.meta.adAccountId}`, { since: bounds.since, until: bounds.until });
  const position = monthPosition({
    monthlyCapEur: config.monthlyCapEur,
    mtdCents,
    spendCapCents: summary.spendCapCents,
    amountSpentCents: summary.amountSpentCents,
  });
  const data: CheckData = {
    ...base,
    month: bounds.month,
    mtdEur: cents(position.mtdCents),
    headroomEur: cents(position.headroomCents),
    remainingEur: cents(position.remainingCents),
  };
  const headroom = position.headroomCents ?? 0;
  if (headroom <= 0) {
    return check("spend_cap", "fail", "spend_cap_reached", `spend_cap is used up (headroom ${cents(headroom)} EUR): Meta delivers nothing more`, { data });
  }
  if (position.headroomExceedsRemaining) {
    return check(
      "spend_cap",
      "fail",
      "spend_cap_headroom_exceeds_remaining",
      `spend_cap headroom ${cents(headroom)} EUR is above what is left of the monthly cap (${cents(position.remainingCents)} EUR): Meta would not stop spend in time`,
      { data },
    );
  }
  return check("spend_cap", "pass", "ok", `headroom ${cents(headroom)} EUR, at most the ${cents(position.remainingCents)} EUR left of the monthly cap`, { data });
}

interface ChatMember {
  status?: unknown;
  can_send_messages?: unknown;
  can_post_messages?: unknown;
}

async function telegramCheck(deps: PreflightDeps, companyId: string, config: BrandConfigDraft): Promise<PreflightCheck> {
  const bot = await resolveBrandBot({ ctx: deps.ctx, ...deps.telegram }, companyId, config);
  if (!bot.ok) {
    const reason: PreflightReason =
      bot.reason === "not_configured" ? "telegram_not_configured" : bot.reason === "token_unresolved" ? "telegram_token_unresolved" : "telegram_token_invalid";
    return check("telegram", "fail", reason, bot.detail);
  }
  try {
    const me = await bot.api.call<{ id?: unknown }>("getMe");
    if (typeof me?.id !== "number") return check("telegram", "fail", "telegram_error", "getMe returned no bot id");
    let chat: { type?: unknown };
    try {
      chat = await bot.api.call<{ type?: unknown }>("getChat", { chat_id: bot.chatId });
    } catch (error) {
      if (error instanceof TelegramApiError && (error.status === 400 || error.status === 403)) {
        return check("telegram", "fail", "telegram_chat_unreachable", `the bot cannot see chat ${bot.chatId}: ${safeDetail(error)}`);
      }
      throw error;
    }
    const chatType = typeof chat?.type === "string" ? chat.type : "unknown";
    const data: CheckData = { chatId: bot.chatId, chatType };
    if (chatType === "private") return check("telegram", "pass", "ok", "private chat: the bot can message it", { data });
    const member = await bot.api.call<ChatMember>("getChatMember", { chat_id: bot.chatId, user_id: me.id });
    const status = typeof member?.status === "string" ? member.status : "unknown";
    data.memberStatus = status;
    const canPost =
      chatType === "channel"
        ? status === "creator" || (status === "administrator" && member.can_post_messages !== false)
        : status === "creator" ||
          status === "administrator" ||
          status === "member" ||
          (status === "restricted" && member.can_send_messages === true);
    return canPost
      ? check("telegram", "pass", "ok", `the bot is ${status} in the ${chatType} and can post`, { data })
      : check("telegram", "fail", "telegram_cannot_post", `the bot is ${status} in the ${chatType} and cannot post`, { data });
  } catch (error) {
    if (error instanceof TelegramApiError && error.status === 401) {
      return check("telegram", "fail", "telegram_token_invalid", "Telegram refused the bot token (401)");
    }
    return check("telegram", "fail", "telegram_error", safeDetail(error));
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function defaultMetaClient(deps: PreflightDeps) {
  return (companyId: string, config: BrandConfigDraft) =>
    createMetaClient(deps.ctx, { companyId, tokenRef: config.meta.accessTokenRef, mode: "readOnly" });
}

/** Runs every check, caches the result and handles a 190 (alert + issue, no retry). */
export async function runPreflight(deps: PreflightDeps, companyId: string, config: BrandConfigDraft): Promise<PreflightResult> {
  const now = deps.now();
  const client = (deps.metaClient ?? defaultMetaClient(deps))(companyId, config);
  const act = `act_${config.meta.adAccountId}`;
  const checks: PreflightCheck[] = [];
  let tokenError: MetaGraphError | null = null;
  let tokenOk = false;

  /** Runs one Meta step; a token failure stops every later Meta step. */
  async function meta<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: PreflightReason; detail: string }> {
    if (tokenError) return { ok: false, reason: tokenFailure(tokenError) ?? "token_invalid", detail: "not checked: the Meta token does not work" };
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const failure = tokenFailure(error);
      if (failure) tokenError = error as MetaGraphError;
      return { ok: false, reason: failure ?? "meta_error", detail: safeDetail(error) };
    }
  }

  // token_scopes
  const permissions = await meta(() => getTokenPermissions(client));
  if (permissions.ok) {
    tokenOk = true;
    const missing = REQUIRED_SCOPES.filter((scope) => !permissions.value.granted.includes(scope));
    checks.push(
      missing.length === 0
        ? check("token_scopes", "pass", "ok", `granted: ${REQUIRED_SCOPES.join(", ")}`, { data: { granted: permissions.value.granted } })
        : check("token_scopes", "fail", "missing_scopes", `missing: ${missing.join(", ")}`, { data: { granted: permissions.value.granted, missing } }),
    );
  } else {
    checks.push(check("token_scopes", "fail", permissions.reason, permissions.detail));
  }

  // ad_account + spend_cap
  const summary = await meta(() => getAccountSummary(client, act));
  if (summary.ok) {
    checks.push(accountCheck(config, summary.value));
    const spend = await meta(() => spendCapCheck(client, config, summary.value, now));
    checks.push(spend.ok ? spend.value : check("spend_cap", "fail", spend.reason, spend.detail));
  } else {
    const reason = summary.reason === "meta_error" ? "account_unreachable" : summary.reason;
    checks.push(check("ad_account", "fail", reason, summary.detail));
    checks.push(check("spend_cap", "fail", reason, "not checked: the ad account could not be read"));
  }

  // page + ig_actor
  const page = await meta(() => getPage(client, config.meta.pageId));
  let pageSummary: PageSummary | null = null;
  if (page.ok) {
    pageSummary = page.value;
    checks.push(check("page", "pass", "ok", `page ${page.value.id} ${page.value.name}`.trim(), { data: { pageId: page.value.id, name: page.value.name } }));
  } else {
    checks.push(check("page", "fail", page.reason === "meta_error" ? "page_unreachable" : page.reason, page.detail));
  }

  let igUserId: string | null = null;
  if (config.meta.igUserId) {
    const ig = await meta(() => getInstagramUser(client, config.meta.igUserId!));
    if (ig.ok) {
      igUserId = ig.value.id;
      checks.push(check("ig_actor", "pass", "ok", `configured IG user ${ig.value.id}${ig.value.username ? ` (@${ig.value.username})` : ""}`, { data: { igUserId: ig.value.id, source: "config" } }));
    } else {
      checks.push(check("ig_actor", "fail", ig.reason === "meta_error" ? "ig_unreachable" : ig.reason, ig.detail));
    }
  } else if (pageSummary?.instagramBusinessAccountId) {
    igUserId = pageSummary.instagramBusinessAccountId;
    checks.push(check("ig_actor", "pass", "ok", `resolved from the page: IG user ${igUserId}`, { required: false, data: { igUserId, source: "page" } }));
  } else {
    checks.push(
      check(
        "ig_actor",
        "skipped",
        page.ok ? "ig_not_linked" : page.reason === "meta_error" ? "page_unreachable" : page.reason,
        page.ok ? "the page has no Instagram account the token can see; ads run on Facebook placements only" : "not checked: the page could not be read",
      ),
    );
  }

  // dataset
  if (config.meta.datasetId) {
    const datasets = await meta(() => listAdAccountDatasets(client, act));
    if (datasets.ok) {
      const attached = datasets.value.some((entry) => entry.id === config.meta.datasetId);
      checks.push(
        attached
          ? check("dataset", "pass", "ok", `dataset ${config.meta.datasetId} is attached to ${act}`)
          : check("dataset", "fail", "dataset_not_attached", `dataset ${config.meta.datasetId} is not among the ad account's datasets`, {
              data: { attached: datasets.value.map((entry) => entry.id) },
            }),
      );
    } else {
      checks.push(check("dataset", "fail", datasets.reason, datasets.detail));
    }
  } else {
    checks.push(check("dataset", "skipped", "dataset_not_configured", "no datasetId in the config"));
  }

  // telegram (no Meta call)
  checks.push(await telegramCheck(deps, companyId, config));

  const result: PreflightResult = {
    companyId,
    brandCode: config.brandCode,
    checkedAt: now.toISOString(),
    configFingerprint: configFingerprint(config),
    monthlyCapEur: config.monthlyCapEur,
    launchReady: isLaunchReady(config.monthlyCapEur, checks),
    checks,
    igUserId,
  };

  const alertDeps = {
    ctx: deps.ctx,
    store: deps.store,
    pluginId: deps.pluginId,
    sendTelegram: async (id: string, brand: BrandConfigDraft, text: string) => {
      const bot = await resolveBrandBot({ ctx: deps.ctx, ...deps.telegram }, id, brand);
      if (!bot.ok) {
        if (bot.reason === "not_configured") return "not_configured" as const;
        throw new Error(bot.detail);
      }
      await bot.api.sendMessage({ chat_id: bot.chatId, text });
      return "sent" as const;
    },
  };
  const failedToken = tokenError as MetaGraphError | null;
  if (failedToken instanceof TokenInvalidError) {
    result.tokenIncident = await reportTokenInvalid(alertDeps, companyId, config, failedToken, "Tarkista yhteys");
  } else if (tokenOk) {
    await clearTokenIncident(alertDeps, companyId, config.brandCode);
  }

  await writeCachedPreflight(deps.ctx, result);
  try {
    await deps.ctx.activity.log({
      companyId,
      message: `rk9-ads preflight: ${result.launchReady ? "launch-ready" : "not launch-ready"}`,
      entityType: "rk9_ads_brand",
      entityId: config.brandCode,
      metadata: {
        launchReady: result.launchReady,
        checks: Object.fromEntries(result.checks.map((entry) => [entry.check, `${entry.status}:${entry.reason}`])),
      },
    });
  } catch (error) {
    deps.ctx.logger.warn("rk9-ads preflight: activity log failed", { companyId, error: safeDetail(error) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cache and launch gate
// ---------------------------------------------------------------------------

/**
 * Instance scope keyed by company, as the config markers: in a job (A9's
 * activation runs from a Telegram tap) the host can refuse company-scoped
 * state. Only the company's own handlers read the entry.
 */
function preflightStateKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: "preflight", stateKey: companyId };
}

function isPreflightResult(value: unknown, companyId: string): value is PreflightResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<PreflightResult>;
  return (
    result.companyId === companyId &&
    typeof result.checkedAt === "string" &&
    typeof result.configFingerprint === "string" &&
    typeof result.launchReady === "boolean" &&
    Array.isArray(result.checks)
  );
}

export async function readCachedPreflight(ctx: Pick<PluginContext, "state" | "logger">, companyId: string): Promise<PreflightResult | null> {
  try {
    const raw = await ctx.state.get(preflightStateKey(companyId));
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return isPreflightResult(parsed, companyId) ? parsed : null;
  } catch (error) {
    ctx.logger.warn("rk9-ads preflight: could not read the cached result", { companyId, error: safeDetail(error) });
    return null;
  }
}

async function writeCachedPreflight(ctx: Pick<PluginContext, "state" | "logger">, result: PreflightResult): Promise<void> {
  try {
    await ctx.state.set(preflightStateKey(result.companyId), JSON.stringify(result));
  } catch (error) {
    ctx.logger.warn("rk9-ads preflight: could not cache the result", { companyId: result.companyId, error: safeDetail(error) });
  }
}

/** Fresh = same config, checked within `maxAgeMs`, not in the future. */
export function isFreshPreflight(result: PreflightResult, config: BrandConfigDraft, now: Date, maxAgeMs = PREFLIGHT_TTL_MS): boolean {
  const age = now.getTime() - Date.parse(result.checkedAt);
  return result.configFingerprint === configFingerprint(config) && Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

function failedChecks(result: PreflightResult): LaunchNotReadyError["failed"] {
  const failed: LaunchNotReadyError["failed"] = result.checks
    .filter((entry) => entry.required && entry.status !== "pass")
    .map((entry) => ({ check: entry.check, reason: entry.reason }));
  if (result.monthlyCapEur === null) failed.push({ check: "config", reason: "monthly_cap_unset" });
  return failed;
}

/**
 * The launch gate of every mutating path. Uses a fresh launch-ready cache
 * entry, or re-runs the preflight; throws LaunchNotReadyError otherwise.
 * Pass `config` when the caller already loaded it.
 */
export async function assertLaunchReady(
  deps: PreflightDeps & { ctx: Pick<PluginContext, "config"> },
  companyId: string,
  options: { config?: BrandConfig; maxAgeMs?: number } = {},
): Promise<PreflightResult> {
  let config = options.config;
  if (!config) {
    const loaded = await loadCompanyConfig(deps.ctx as PluginContext, companyId);
    if (loaded.state !== "enabled") {
      const reason = loaded.state === "disabled" ? "monthly_cap_unset" : `config_${loaded.state}`;
      throw new LaunchNotReadyError(`RK9 Ads is not launch-ready: the brand config is ${loaded.state}`, null, [{ check: "config", reason }]);
    }
    config = loaded.config;
  }
  const cached = await readCachedPreflight(deps.ctx, companyId);
  if (cached && cached.launchReady && isFreshPreflight(cached, config, deps.now(), options.maxAgeMs)) return cached;
  const result = await runPreflight(deps, companyId, config);
  if (!result.launchReady) {
    const failed = failedChecks(result);
    throw new LaunchNotReadyError(
      `RK9 Ads is not launch-ready: ${failed.map((entry) => `${entry.check} ${entry.reason}`).join(", ")}`,
      result,
      failed,
    );
  }
  return result;
}
