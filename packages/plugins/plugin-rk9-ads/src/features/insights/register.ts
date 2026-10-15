import { listCompanyConfigs, loadCompanyConfig } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import { buildDigest, digestTickBrand, type DigestDeps } from "../../digest/run.js";
import { createFatigueIssues, evaluateFatigue } from "../../insights/fatigue-issues.js";
import {
  closeMarkerKey,
  ingestBrand,
  INSIGHTS_CLOSE_KIND,
  insightsDeps,
  MAX_BACKFILL_DAYS,
  runBrand,
  runInsights,
} from "../../insights/ingest.js";
import { addDays } from "../../insights/mtd.js";
import { localDate } from "../../kit/local-time.js";
import { PLUGIN_ID } from "../../manifest.js";
import { graphHealth } from "../../meta/graph.js";
import { getTelegramController } from "../telegram/controller.js";
import type { FeatureRuntime } from "../types.js";

/**
 * Insights collection, daily digest and creative fatigue (A10, RK9-512).
 *
 * The host cron is UTC only, so every job runs on a UTC schedule and gates on
 * the brand's local time (kit/local-time) with a once-per-local-date marker:
 * - insights-hourly (5 * * * *): yesterday's and today's ad-days.
 * - insights-daily-close (20 * * * *): on the first run of a new local date
 *   (config.timeZone, Europe/Helsinki by default) it re-pulls the last 7 days
 *   up to yesterday (finalises yesterday, fills gaps, takes Meta's late
 *   attribution), then evaluates fatigue and, behind the flag, files issues.
 *   Marker: alert_dedupe `insights-close:<local date>`, set only on success.
 * - digest-tick (every 15 min): ../../digest/run.ts.
 * Actions (no manifest entry needed; the company comes from the host context):
 * - digest.dryRun: the digest text; writes nothing.
 * - insights.backfill { days }: re-pulls up to 31 days for the company.
 */
export function register(runtime: FeatureRuntime): void {
  const { ctx } = runtime;
  const base = insightsDeps(ctx);
  const deps: DigestDeps = {
    ...base,
    telegram: (companyId) => getTelegramController()?.botFor(companyId) ?? null,
    drift: () => graphHealth.snapshot().drift,
  };
  const listConfigs = () => listCompanyConfigs(ctx);

  ctx.jobs.register("insights-hourly", async (job) => {
    const results = await runInsights({ ...base, listConfigs }, "hourly");
    ctx.logger.info("rk9-ads insights-hourly done", {
      runId: job.runId,
      brands: results.length,
      failed: results.filter((result) => !result.ok).length,
    });
  });

  ctx.jobs.register("insights-daily-close", async (job) => {
    let closed = 0;
    for (const { companyId, result } of await listConfigs()) {
      if (result.state !== "enabled") continue;
      const config = result.config;
      try {
        const key = closeMarkerKey(localDate(base.now(), config.timeZone));
        if (await base.store.hasMark(companyId, key)) continue;
        const outcome = await runBrand(base, companyId, config, "close", async (ingested) => {
          await fileFatigueIssues(companyId, config, addDays(ingested.today, -1));
        });
        if (!outcome.ok) continue;
        await base.store.markOnce(companyId, key, INSIGHTS_CLOSE_KIND, { rows: outcome.rows, window: outcome.window });
        closed += 1;
      } catch (error) {
        ctx.logger.warn("rk9-ads insights-daily-close: brand failed", {
          companyId,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    }
    ctx.logger.info("rk9-ads insights-daily-close done", { runId: job.runId, closed });
  });

  async function fileFatigueIssues(companyId: string, config: BrandConfig, asOf: string): Promise<void> {
    if (!config.fatigue.enabled || !config.fatigue.issuesEnabled) return;
    try {
      const fatigue = await evaluateFatigue(base.store, companyId, config, asOf);
      await createFatigueIssues({ ctx, store: base.store, pluginId: PLUGIN_ID }, companyId, config, fatigue);
    } catch (error) {
      // Fatigue issues are advisory; the close itself succeeded.
      ctx.logger.warn("rk9-ads fatigue issues failed", {
        companyId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }

  ctx.jobs.register("digest-tick", async (job) => {
    const outcomes: Record<string, number> = {};
    for (const { companyId, result } of await listConfigs()) {
      if (result.state !== "enabled") continue;
      try {
        const outcome = await digestTickBrand(deps, companyId, result.config);
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      } catch (error) {
        ctx.logger.warn("rk9-ads digest-tick: brand failed", {
          companyId,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    }
    ctx.logger.debug("rk9-ads digest-tick done", { runId: job.runId, outcomes });
  });

  async function enabledConfig(companyId: string | null): Promise<{ companyId: string; config: BrandConfig } | { error: string }> {
    if (!companyId) return { error: "This action needs a company context" };
    const result = await loadCompanyConfig(ctx, companyId);
    if (result.state !== "enabled") return { error: `Brand config is ${result.state}` };
    return { companyId, config: result.config };
  }

  ctx.actions.register("digest.dryRun", async (_params, context) => {
    const target = await enabledConfig(context.companyId);
    if ("error" in target) return target;
    const built = await buildDigest(deps, target.companyId, target.config);
    return { text: built.text, length: built.text?.length ?? 0, summary: built.summary };
  });

  ctx.actions.register("insights.backfill", async (params, context) => {
    const target = await enabledConfig(context.companyId);
    if ("error" in target) return target;
    const requested = Number(params.days ?? 7);
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_BACKFILL_DAYS) {
      return { error: `days must be an integer 1-${MAX_BACKFILL_DAYS}` };
    }
    // `days` days ending today.
    const result = await ingestBrand(base, target.companyId, target.config, (_account, today) => ({
      since: addDays(today, -(requested - 1)),
      until: today,
    }));
    return { rows: result.rows, window: result.window, accountTimeZone: result.accountTimeZone, skippedFields: result.skippedFields };
  });
}
