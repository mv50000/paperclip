/**
 * Read-only agent tools (RK9-513): `rk9ads_list_ads` and `rk9ads_get_insights`.
 *
 * Each call builds a Meta client in `readOnly` mode for the calling agent's
 * own company, so a write throws before any request leaves the worker.
 */

import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import { loadCompanyConfig } from "../../company-configs.js";
import { localDate } from "../../kit/local-time.js";
import { createMetaClient, type MetaGraphClient } from "../../meta/graph.js";
import { getInsights, listAds } from "../../meta/methods.js";
import { redactText } from "../../meta/redact.js";

/** Graph `effective_status` values an agent may filter on. */
export const AD_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
] as const;

export const INSIGHTS_FIELDS = [
  "ad_id",
  "ad_name",
  "adset_id",
  "campaign_id",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "ctr",
  "cpm",
] as const;
export const DEFAULT_INSIGHTS_DAYS = 7;
export const MAX_INSIGHTS_DAYS = 90;
export const INSIGHTS_MAX_PAGES = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d{1,32}$/;
const DAY_MS = 86_400_000;

export interface ReadToolDeps {
  ctx: PluginContext;
  now?: () => Date;
  /** Test seam; the worker uses `createMetaClient` in readOnly mode. */
  metaClient?: (companyId: string, config: BrandConfig) => MetaGraphClient;
}

function toolError(message: string): ToolResult {
  return { error: message };
}

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data), data };
}

async function companyClient(deps: ReadToolDeps, companyId: string): Promise<{ config: BrandConfig; client: MetaGraphClient } | ToolResult> {
  const result = await loadCompanyConfig(deps.ctx, companyId);
  if (result.state === "unavailable") return toolError("config_unavailable: the brand config could not be read; retry later");
  if (result.state !== "enabled") return toolError("plugin_not_enabled: RK9 Ads has no valid brand config for this company");
  const config = result.config;
  const client = deps.metaClient
    ? deps.metaClient(companyId, config)
    : createMetaClient(deps.ctx, {
        companyId,
        tokenRef: config.meta.accessTokenRef,
        tokenConfigPath: "meta.accessTokenRef",
        mode: "readOnly",
      });
  return { config, client };
}

function failure(error: unknown): ToolResult {
  return toolError(`meta_read_failed: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isRealDate(value: string): boolean {
  return DATE_RE.test(value) && addDays(value, 0) === value;
}

function record(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
}

export async function listAdsTool(deps: ReadToolDeps, companyId: string, rawParams: unknown): Promise<ToolResult> {
  const params = record(rawParams);
  const status = params.status;
  if (status !== undefined && !(AD_EFFECTIVE_STATUSES as readonly unknown[]).includes(status)) {
    return toolError(`invalid_params: status must be one of ${AD_EFFECTIVE_STATUSES.join(", ")}`);
  }
  const resolved = await companyClient(deps, companyId);
  if (!("client" in resolved)) return resolved;
  try {
    const ads = await listAds(resolved.client, resolved.config.meta.adAccountId, {
      ...(typeof status === "string" ? { effectiveStatus: [status] } : {}),
    });
    return ok({ brand: resolved.config.brandCode, count: ads.length, ads });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Daily ad-level insights of the company's own ad account. Dates are local
 * dates in the brand time zone; the default is the last seven full days.
 * `adId` filters the account's rows, so another account's ad cannot be read.
 */
export async function getInsightsTool(deps: ReadToolDeps, companyId: string, rawParams: unknown): Promise<ToolResult> {
  const params = record(rawParams);
  for (const key of ["since", "until"] as const) {
    const value = params[key];
    if (value !== undefined && (typeof value !== "string" || !isRealDate(value))) {
      return toolError(`invalid_params: ${key} must be a YYYY-MM-DD date`);
    }
  }
  const adId = params.adId;
  if (adId !== undefined && (typeof adId !== "string" || !ID_RE.test(adId))) {
    return toolError("invalid_params: adId must be a numeric Meta ad id");
  }
  const resolved = await companyClient(deps, companyId);
  if (!("client" in resolved)) return resolved;
  const { config, client } = resolved;

  const today = localDate(deps.now?.() ?? new Date(), config.timeZone);
  const until = (params.until as string | undefined) ?? addDays(today, -1);
  const since = (params.since as string | undefined) ?? addDays(until, -(DEFAULT_INSIGHTS_DAYS - 1));
  if (since > until) return toolError("invalid_params: since must not be after until");
  if (addDays(since, MAX_INSIGHTS_DAYS - 1) < until) {
    return toolError(`invalid_params: the range may span at most ${MAX_INSIGHTS_DAYS} days`);
  }

  try {
    const rows = await getInsights(client, `act_${config.meta.adAccountId}`, {
      level: "ad",
      fields: [...INSIGHTS_FIELDS],
      timeRange: { since, until },
      timeIncrement: 1,
      // 90 days of daily rows for dozens of ads; a truncated walk throws rather than under-reports.
      maxPages: INSIGHTS_MAX_PAGES,
    });
    const filtered = typeof adId === "string" ? rows.filter((row) => row.ad_id === adId) : rows;
    return ok({ brand: config.brandCode, since, until, count: filtered.length, rows: filtered });
  } catch (error) {
    return failure(error);
  }
}
