/**
 * Ad-level insights collection (A10, RK9-512).
 *
 * One account-level call per brand and window (`level=ad`,
 * `time_increment=1`), never one call per ad. Rows are upserted into
 * insights_daily by (company_id, ad_id, date), so a re-run of the same window
 * gives the same rows and values.
 *
 * Fault isolation follows Sunspot's gen-insights-digest.mjs:
 * - every brand runs in its own try/catch. A Graph error, an invalid token
 *   (190) or a rate limit for one brand is logged, stored as a warning
 *   (alert_dedupe kind `insights_warning`, shown in the digest) and the next
 *   brand still runs;
 * - when Meta rejects the field list (code 100), the core fields are fetched
 *   alone and every optional field is tried on its own; a rejected field is
 *   skipped with a warning instead of failing the brand.
 *
 * The token check itself belongs to A4 (RK9-510); a 190 here is only a warning.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listCompanyConfigs } from "../company-configs.js";
import type { BrandConfig } from "../config.js";
import { localDate } from "../kit/local-time.js";
import { InvalidParamError, MetaGraphError, RateLimitError, TokenInvalidError } from "../meta/errors.js";
import { createMetaClient, type MetaClientOptions, type MetaGraphClient } from "../meta/graph.js";
import { adAccountPath, getAccountSummary, getInsights, parseDecimalMoney } from "../meta/methods.js";
import type { AccountSummary, InsightsRow } from "../meta/types.js";
import { cpm, linkCpc, linkCtr, parseCount } from "../metrics/cpc.js";
import { addDays } from "./mtd.js";
import { createInsightsStore, type InsightDayRow, type InsightsStore } from "./store.js";

/** Always requested: ids, date and the counts every figure is built from. */
export const CORE_INSIGHT_FIELDS = ["ad_id", "adset_id", "campaign_id", "spend", "impressions", "clicks", "inline_link_clicks"] as const;
/** Requested together with the core; each one is dropped alone when Meta rejects it. */
export const OPTIONAL_INSIGHT_FIELDS = ["reach", "frequency"] as const;
/** Only when the brand config has a dataset (pixel). */
export const ACTION_FIELDS = ["actions"] as const;

/** Bounded backfill window of the daily close, days before today. */
export const CLOSE_WINDOW_DAYS = 7;
/** A day older than this many days is marked final (Meta revises ~72 h). */
export const FINAL_AFTER_DAYS = 3;
export const MAX_BACKFILL_DAYS = 31;

export const INSIGHTS_WARNING_KIND = "insights_warning";
export const INSIGHTS_CLOSE_KIND = "insights_close";

/** Marker of a finished daily close, per ad-account-local date (the date whose yesterday it closed). */
export function closeMarkerKey(localDay: string): string {
  return `insights-close:${localDay}`;
}

export type WarningCode = "token" | "rate_limit" | "graph" | "field" | "config";

export interface InsightsDeps {
  ctx: Pick<PluginContext, "http" | "secrets" | "logger" | "activity">;
  store: InsightsStore;
  now: () => Date;
  /** Test hook: client options such as retry and sleep. */
  clientOptions?: Partial<Pick<MetaClientOptions, "retry" | "sleep" | "now" | "health">>;
}

export interface BrandIngestResult {
  companyId: string;
  brandCode: string;
  ok: boolean;
  rows: number;
  window: { since: string; until: string } | null;
  accountTimeZone: string | null;
  skippedFields: string[];
  error?: string;
  warning?: WarningCode;
}

export function insightsDeps(ctx: PluginContext): InsightsDeps {
  return { ctx, store: createInsightsStore(ctx.db), now: () => new Date() };
}

export function metaClientFor(deps: InsightsDeps, companyId: string, config: BrandConfig): MetaGraphClient {
  return createMetaClient(deps.ctx, {
    companyId,
    tokenRef: config.meta.accessTokenRef,
    tokenConfigPath: "meta.accessTokenRef",
    // Insights never write; readOnly makes the client refuse any POST/DELETE.
    mode: "readOnly",
    ...deps.clientOptions,
  });
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Graph insights row -> insights_daily row. Rates come from ../metrics/cpc.ts. */
export function toDayRow(
  raw: InsightsRow,
  input: { brandCode: string; currency: string | null; withActions: boolean; finalBefore: string },
): InsightDayRow | null {
  const adId = optionalId(raw.ad_id);
  const date = typeof raw.date_start === "string" ? raw.date_start : null;
  if (!adId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Missing spend must not read as zero: parseDecimalMoney throws and the brand fails loudly.
  const spendCents = parseDecimalMoney(raw.spend, "spend");
  const impressions = parseCount(raw.impressions);
  const inlineLinkClicks = parseCount(raw.inline_link_clicks);
  return {
    brandCode: input.brandCode,
    adId,
    date,
    campaignId: optionalId(raw.campaign_id),
    adsetId: optionalId(raw.adset_id),
    currency: input.currency,
    spendCents,
    impressions,
    reach: parseCount(raw.reach),
    frequency: optionalNumber(raw.frequency),
    clicks: parseCount(raw.clicks),
    inlineLinkClicks,
    ctr: linkCtr(inlineLinkClicks, impressions),
    cpc: linkCpc(spendCents, inlineLinkClicks),
    cpm: cpm(spendCents, impressions),
    actions: input.withActions && Array.isArray(raw.actions) ? raw.actions : [],
    isFinal: date < input.finalBefore,
  };
}

function rowKey(row: InsightsRow): string {
  return `${String(row.ad_id)}|${String(row.date_start)}`;
}

/**
 * Fetches ad-day rows for a window. On a code-100 rejection of the full field
 * list it fetches the core alone and merges each optional field fetched on its
 * own; a field Meta still rejects is reported in `skipped`.
 */
export async function fetchAdDays(
  client: MetaGraphClient,
  actId: string,
  window: { since: string; until: string },
  optional: readonly string[],
): Promise<{ rows: InsightsRow[]; skipped: string[] }> {
  const read = (fields: readonly string[]) =>
    getInsights(client, adAccountPath(actId), { level: "ad", fields: [...fields], timeRange: window, timeIncrement: 1, maxPages: 50 });
  try {
    return { rows: await read([...CORE_INSIGHT_FIELDS, ...optional]), skipped: [] };
  } catch (error) {
    if (!(error instanceof InvalidParamError) || optional.length === 0) throw error;
  }
  const rows = await read(CORE_INSIGHT_FIELDS);
  const byKey = new Map(rows.map((row) => [rowKey(row), row]));
  const skipped: string[] = [];
  for (const field of optional) {
    try {
      for (const extra of await read(["ad_id", field])) {
        const target = byKey.get(rowKey(extra));
        if (target) target[field] = extra[field];
      }
    } catch (error) {
      if (!(error instanceof InvalidParamError)) throw error;
      skipped.push(field);
    }
  }
  return { rows, skipped };
}

function classify(error: unknown): WarningCode {
  if (error instanceof TokenInvalidError) return "token";
  if (error instanceof RateLimitError) return "rate_limit";
  return "graph";
}

function safeMessage(error: unknown): string {
  // MetaGraphError messages are redacted by the client; anything else is cut short.
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

/** Stores a warning once per account-local day and code, for the digest. */
export async function recordWarning(
  deps: InsightsDeps,
  companyId: string,
  code: WarningCode,
  message: string,
  day: string,
  detail?: string,
): Promise<void> {
  const key = `insights-warning:${day}:${code}${detail ? `:${detail}` : ""}`;
  try {
    await deps.store.markOnce(companyId, key, INSIGHTS_WARNING_KIND, { code, message: message.slice(0, 300) });
  } catch (error) {
    deps.ctx.logger.warn("rk9-ads insights: could not store warning", { companyId, code, error: safeMessage(error) });
  }
}

/** Ingests one brand for a window given in account-local dates. Throws on a brand-level failure. */
export async function ingestBrand(
  deps: InsightsDeps,
  companyId: string,
  config: BrandConfig,
  window: (account: AccountSummary, today: string) => { since: string; until: string },
): Promise<BrandIngestResult & { account: AccountSummary; today: string }> {
  const client = metaClientFor(deps, companyId, config);
  const account = await getAccountSummary(client, config.meta.adAccountId);
  const today = localDate(deps.now(), account.timezone);
  const range = window(account, today);
  const withActions = Boolean(config.meta.datasetId);
  const optional = [...OPTIONAL_INSIGHT_FIELDS, ...(withActions ? ACTION_FIELDS : [])];
  const { rows: raw, skipped } = await fetchAdDays(client, config.meta.adAccountId, range, optional);
  const finalBefore = addDays(today, -FINAL_AFTER_DAYS + 1);
  const rows: InsightDayRow[] = [];
  for (const item of raw) {
    const row = toDayRow(item, { brandCode: config.brandCode, currency: account.currency, withActions, finalBefore });
    if (row) rows.push(row);
  }
  await deps.store.upsertDays(companyId, rows);
  for (const field of skipped) {
    await recordWarning(deps, companyId, "field", `Meta hylkäsi kentän ${field}; se ohitettiin`, today, field);
  }
  return {
    companyId,
    brandCode: config.brandCode,
    ok: true,
    rows: rows.length,
    window: range,
    accountTimeZone: account.timezone,
    skippedFields: skipped,
    account,
    today,
  };
}

export type InsightsRunMode = "hourly" | "close";

/**
 * Window per mode. Hourly reads yesterday and today, so late reporting for
 * yesterday is in before the morning digest. Close reads the bounded backfill
 * window up to yesterday.
 */
export function windowFor(mode: InsightsRunMode, today: string): { since: string; until: string } {
  return mode === "hourly" ? { since: addDays(today, -1), until: today } : { since: addDays(today, -CLOSE_WINDOW_DAYS), until: addDays(today, -1) };
}

/**
 * Runs one brand with full fault isolation: never throws. A failure becomes a
 * warning for the digest, a log line and an activity entry.
 */
export async function runBrand(
  deps: InsightsDeps,
  companyId: string,
  config: BrandConfig,
  mode: InsightsRunMode,
  onIngested?: (result: BrandIngestResult & { account: AccountSummary; today: string }) => Promise<void>,
): Promise<BrandIngestResult> {
  try {
    const result = await ingestBrand(deps, companyId, config, (_account, today) => windowFor(mode, today));
    if (onIngested) await onIngested(result);
    const { account: _account, today: _today, ...summary } = result;
    return summary;
  } catch (error) {
    const code = classify(error);
    const message = safeMessage(error);
    const day = localDate(deps.now(), config.timeZone);
    deps.ctx.logger.warn("rk9-ads insights: brand failed", {
      companyId,
      brandCode: config.brandCode,
      mode,
      code,
      error: error instanceof MetaGraphError ? error.toJSON() : message,
    });
    await recordWarning(deps, companyId, code, message, day);
    try {
      await deps.ctx.activity.log({
        companyId,
        message: "rk9-ads insights failed",
        metadata: { brandCode: config.brandCode, mode, code },
      });
    } catch {
      // The warning row and the log line already carry it.
    }
    return {
      companyId,
      brandCode: config.brandCode,
      ok: false,
      rows: 0,
      window: null,
      accountTimeZone: null,
      skippedFields: [],
      error: message,
      warning: code,
    };
  }
}

/** Every enabled brand, each isolated. */
export async function runInsights(
  deps: InsightsDeps & { listConfigs: () => ReturnType<typeof listCompanyConfigs> },
  mode: InsightsRunMode,
  onIngested?: Parameters<typeof runBrand>[4],
): Promise<BrandIngestResult[]> {
  const results: BrandIngestResult[] = [];
  for (const { companyId, result } of await deps.listConfigs()) {
    if (result.state !== "enabled") {
      if (result.state === "unavailable") {
        deps.ctx.logger.warn("rk9-ads insights: config unavailable", { companyId, error: result.error });
      }
      continue;
    }
    results.push(await runBrand(deps, companyId, result.config, mode, onIngested));
  }
  return results;
}
