/**
 * Fatigue evaluation over stored insights, and the optional "new creative
 * needed" issue (A10, RK9-512).
 *
 * The issue is off by default (`fatigue.issuesEnabled=false`). When it is on,
 * a fatigued ad gets at most one Paperclip issue in its own company. The
 * dedupe marker `fatigue-issue:<adId>` in alert_dedupe is inserted first
 * (ON CONFLICT DO NOTHING), so two overlapping runs cannot both create one.
 * A create the host refused before it ran (capability or scope denial)
 * removes the marker so the next run retries; any other failure keeps it,
 * because the issue may exist
 * (RK9-526: a missed issue beats a duplicate, and the digest still lists the
 * ad). The plugin has
 * no issues.read capability, so the marker is kept after the issue closes: an
 * ad gets one issue in its lifetime. Fatigue never pauses or changes an ad.
 */

import { PLUGIN_RPC_ERROR_CODES, type PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import { computeFatigue, fatigueThresholdsFor, type FatigueResult } from "./fatigue.js";
import { addDays } from "./mtd.js";
import type { InsightsStore, StoredInsightDay } from "./store.js";

/** Ads with impressions in this many days (to asOf) are evaluated. */
export const FATIGUE_ACTIVE_DAYS = 3;
/** History read per ad. */
export const FATIGUE_HORIZON_DAYS = 90;
export const FATIGUE_ISSUE_KIND = "fatigue_issue";

export interface AdFatigue {
  adId: string;
  result: FatigueResult;
}

function groupByAd(rows: readonly StoredInsightDay[]): Map<string, StoredInsightDay[]> {
  const out = new Map<string, StoredInsightDay[]>();
  for (const row of rows) {
    const list = out.get(row.adId) ?? [];
    list.push(row);
    out.set(row.adId, list);
  }
  return out;
}

/** Fatigue of every recently delivering ad of one company, as of an account-local date. */
export async function evaluateFatigue(
  store: InsightsStore,
  companyId: string,
  config: BrandConfig,
  asOf: string,
): Promise<AdFatigue[]> {
  if (!config.fatigue.enabled) return [];
  const rows = await store.recentAdSeries(companyId, addDays(asOf, -FATIGUE_ACTIVE_DAYS + 1), addDays(asOf, -FATIGUE_HORIZON_DAYS));
  const thresholds = fatigueThresholdsFor(config.fatigue);
  const out: AdFatigue[] = [];
  for (const [adId, series] of groupByAd(rows)) {
    out.push({ adId, result: computeFatigue(series, thresholds, asOf) });
  }
  return out;
}

/**
 * The host refused the create before it ran, so no issue was made: only a
 * capability or invocation-scope denial says that. Any other error, also a
 * generic host error (-32603), can come after the insert (e.g. its activity
 * log write failed), and a timeout says nothing about the outcome.
 */
const REFUSED_BEFORE_RUN: ReadonlySet<number> = new Set([
  PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
  PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
]);

export function hostRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && REFUSED_BEFORE_RUN.has(code);
}

export function fatigueIssueKey(adId: string): string {
  return `fatigue-issue:${adId}`;
}

export function fatigueIssueBody(input: { brandCode: string; adId: string; adName?: string | null; result: FatigueResult }): {
  title: string;
  description: string;
} {
  const label = input.adName ? `${input.adName} (${input.adId})` : input.adId;
  return {
    title: `${input.brandCode}: mainos ${label} on väsynyt, tarvitaan uusi creative`,
    description: [
      `RK9 Ads tunnisti mainoksen **${label}** väsyneeksi. Mainosta ei pysäytetty eikä muutettu.`,
      "",
      "Syyt:",
      ...input.result.reasons.map((reason) => `- ${reason}`),
      "",
      "Tee mainokselle uusi creative ja julkaise se tavalliseen tapaan.",
    ].join("\n"),
  };
}

/**
 * Creates the issue for each fatigued ad that has none yet. Returns the ad ids
 * that got an issue in this run. Errors are per ad and do not stop the others.
 */
export async function createFatigueIssues(
  deps: { ctx: Pick<PluginContext, "issues" | "logger">; store: InsightsStore; pluginId: string },
  companyId: string,
  config: BrandConfig,
  fatigued: readonly AdFatigue[],
  names: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  if (!config.fatigue.issuesEnabled) return [];
  const created: string[] = [];
  for (const { adId, result } of fatigued) {
    if (result.status !== "fatigued") continue;
    const key = fatigueIssueKey(adId);
    if (!(await deps.store.markOnce(companyId, key, FATIGUE_ISSUE_KIND, { adId }))) continue;
    try {
      const body = fatigueIssueBody({ brandCode: config.brandCode, adId, adName: names.get(adId), result });
      await deps.ctx.issues.create({
        companyId,
        title: body.title,
        description: body.description,
        status: "todo",
        priority: "medium",
        originKind: `plugin:${deps.pluginId}`,
        originId: key,
      });
      created.push(adId);
    } catch (error) {
      const refused = hostRefused(error);
      deps.ctx.logger.warn(refused ? "rk9-ads fatigue: issue create failed; retried next run" : "rk9-ads fatigue: issue create outcome unknown; not retried", {
        companyId,
        adId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      if (refused) await deps.store.unmark(companyId, key);
    }
  }
  return created;
}
