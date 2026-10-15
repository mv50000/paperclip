/**
 * The `scheduled-pause` job (A6, RK9-511). The host cron is UTC only (G18),
 * so the job runs every 5 minutes and decides in the brand's local time:
 *
 * 1. MTD alerts, at most every ALERT_CHECK_INTERVAL_MS per company.
 * 2. Scheduled pause: when `schedule.scheduledPause.enabled` and the local
 *    time is at or after `at` (21:30 is right in both EET and EEST), once per
 *    local day. The day's marker is written only after the Meta part
 *    succeeded, so a Meta failure is retried on the next tick (pauses are
 *    idempotent). Off by default.
 * 3. Data gate: when `schedule.dataGate` is set, on every tick. It fails open
 *    (see data-gate.ts); when the predicate no longer holds it runs pauseAll,
 *    which is a no-op once everything is paused.
 *
 * If a pause succeeded but its Telegram notice failed, the pauses stay, the
 * audit entry is written and the job throws at the end, so the host marks the
 * run failed (sunspot-pulse-off.sh exit 3). Other companies still run first.
 */

import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { listCompanyConfigs } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { isLocalTimeAtOrAfter, localDate } from "../../kit/local-time.js";
import { evaluateSpendAlerts } from "./alerts.js";
import { evaluateDataGate, type FeedFetch } from "./data-gate.js";
import { checkSpend } from "./guard.js";
import { pauseAll, type PauseAllDeps, type PauseAllResult } from "./killswitch.js";
import { brandReadClient, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "./support.js";

export const SCHEDULED_PAUSE_JOB_KEY = "scheduled-pause";
export const SCHEDULED_PAUSE_KIND = "scheduled_pause";
export const ALERT_CHECK_INTERVAL_MS = 15 * 60_000;

export function scheduledPauseKey(brandCode: string, date: string): string {
  return `scheduled-pause:${brandCode}:${date}`;
}

export interface ScheduledPauseDeps extends PauseAllDeps {
  ctx: PluginContext;
  ledger: Ledger;
  store: OnceStore;
  notifier: SpendGuardNotifier;
  /** Feed fetch for the data gate; defaults to ctx.http.fetch. */
  feedFetch?: FeedFetch;
  now?: () => Date;
}

function alertCheckKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: "spend-guard", stateKey: `alert-check:${companyId}` };
}

async function alertsDue(ctx: PluginContext, companyId: string, now: Date): Promise<boolean> {
  const last = await ctx.state.get(alertCheckKey(companyId));
  return typeof last !== "string" || !(now.getTime() - Date.parse(last) < ALERT_CHECK_INTERVAL_MS);
}

function telegramFailure(label: string, result: PauseAllResult): string | null {
  return result.telegram === "failed" ? `${label}: paused ${result.count} but the Telegram notice failed (${result.telegramError})` : null;
}

async function runForCompany(deps: ScheduledPauseDeps, job: PluginJobContext, companyId: string, config: BrandConfig, now: Date): Promise<string[]> {
  const { ctx } = deps;
  const failures: string[] = [];
  const initiator: Initiator = { source: "job", jobRunId: job.runId };
  const brand = config.brandCode;

  // 1. Alerts
  try {
    if (await alertsDue(ctx, companyId, now)) {
      const figures = await checkSpend({ config, client: brandReadClient(ctx, companyId, config), now });
      if (figures.pctUsed === null) {
        ctx.logger.warn("rk9-ads spend guard: MTD read failed, alerts not evaluated", { companyId, reason: figures.reason, detail: figures.detail });
      } else {
        await ctx.state.set(alertCheckKey(companyId), now.toISOString());
        const outcome = await evaluateSpendAlerts(deps, companyId, config, figures, initiator);
        if (outcome.telegram === "failed") failures.push(`${brand} alert ${outcome.claimed.join("/")} %: Telegram failed (${outcome.error})`);
      }
    }
  } catch (error) {
    failures.push(`${brand} alerts: ${safeError(error)}`);
  }

  // 2. Scheduled pause
  const pause = config.schedule.scheduledPause;
  if (pause.enabled && isLocalTimeAtOrAfter(now, pause.at, config.timeZone)) {
    const key = scheduledPauseKey(brand, localDate(now, config.timeZone));
    try {
      if ((await deps.store.claimed(companyId, [key])).length === 0) {
        const result = await pauseAll(deps, companyId, config, {
          dryRun: false,
          rule: "scheduled_pause",
          reason: `scheduled pause at ${pause.at} ${config.timeZone}`,
          initiator,
          notify: true,
        });
        if (result.errors.length > 0) {
          failures.push(`${brand} scheduled pause: ${result.errors.length} pause(s) failed, retrying next tick`);
        } else {
          await deps.store.claim(companyId, key, SCHEDULED_PAUSE_KIND, { count: result.count, jobRunId: job.runId });
          const tg = telegramFailure(`${brand} scheduled pause`, result);
          if (tg) failures.push(tg);
        }
      }
    } catch (error) {
      failures.push(`${brand} scheduled pause: ${safeError(error)}`);
    }
  }

  // 3. Data gate
  const gate = config.schedule.dataGate;
  if (gate) {
    try {
      const outcome = await evaluateDataGate(deps.feedFetch ?? ((url, init) => ctx.http.fetch(url, init)), gate);
      if (outcome.action === "skip") {
        if (outcome.reason !== "predicate_holds") {
          ctx.logger.warn("rk9-ads data gate: feed check failed, nothing paused (fail-open)", { companyId, reason: outcome.reason, detail: outcome.detail });
        }
      } else {
        const note = `data-gate: arvo ${outcome.value} (ehto ${gate.operator} ${gate.threshold} ei enää täyty)`;
        const result = await pauseAll(deps, companyId, config, {
          dryRun: false,
          rule: "data_gate",
          reason: `data gate ${gate.jsonPointer} = ${outcome.value}, needs ${gate.operator} ${gate.threshold}`,
          initiator,
          notify: true,
          note,
        });
        if (result.errors.length > 0) failures.push(`${brand} data gate: ${result.errors.length} pause(s) failed`);
        const tg = telegramFailure(`${brand} data gate`, result);
        if (tg) failures.push(tg);
      }
    } catch (error) {
      failures.push(`${brand} data gate: ${safeError(error)}`);
    }
  }
  return failures;
}

export function createScheduledPauseJob(deps: ScheduledPauseDeps) {
  return async (job: PluginJobContext): Promise<void> => {
    const { ctx } = deps;
    const now = deps.now?.() ?? new Date();
    const failures: string[] = [];
    for (const { companyId, result } of await listCompanyConfigs(ctx)) {
      if (result.state === "absent") continue;
      if (result.state !== "enabled") {
        // README ADR 3: a pause must not be skipped silently. Without a readable
        // config there is no token to pause with, so the job warns.
        ctx.logger.warn("rk9-ads scheduled-pause: config not readable, company skipped this tick", {
          companyId,
          state: result.state,
          ...(result.state === "unavailable" ? { error: result.error } : { errorCount: result.errors.length }),
        });
        continue;
      }
      failures.push(...(await runForCompany(deps, job, companyId, result.config, now)));
    }
    if (failures.length > 0) {
      throw new Error(`scheduled-pause: ${failures.join("; ")}`.slice(0, 2000));
    }
  };
}
