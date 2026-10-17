/**
 * The `scheduled-pause` job (A6, RK9-511). The host cron is UTC only (G18),
 * so the job runs every 5 minutes and decides in the brand's local time:
 *
 * 1. Spend alerts (alerts.ts: 80 % / 100 % MTD and the standing risks), at
 *    most every ALERT_CHECK_INTERVAL_MS per company. A failed MTD read or a
 *    failed send fails the run and is retried on the next check.
 * 2. Scheduled pause: when `schedule.scheduledPause.enabled` and the local
 *    time is at or after `at` (21:30 is right in both EET and EEST), once per
 *    local day. It also closes the open activation cards (RK9-557). The day's marker is written only after the Meta part
 *    succeeded, so a Meta failure is retried on the next tick (pauses are
 *    idempotent). Off by default.
 * 3. Data gate: when `schedule.dataGate` is set, on every tick. It fails open
 *    (see data-gate.ts): a feed that cannot be read pauses nothing, but it
 *    fails the run so the broken feed is seen (RK9-523). When the predicate no
 *    longer holds it runs pauseAll, which is a no-op once everything is paused.
 *
 * An invalid or unavailable config fails the run; the pause side (2 and 3)
 * still runs on the brand's last valid config (pause-config.ts).
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
import { loadPauseConfig } from "./pause-config.js";
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

async function runForCompany(
  deps: ScheduledPauseDeps,
  job: PluginJobContext,
  companyId: string,
  config: BrandConfig,
  now: Date,
  pauseOnly: boolean,
): Promise<string[]> {
  const { ctx } = deps;
  const failures: string[] = [];
  const initiator: Initiator = { source: "job", jobRunId: job.runId };
  const brand = config.brandCode;
  const fallbackMark = pauseOnly ? " [last valid config, whole ad account]" : "";

  // 1. Alerts (not on a fallback config: the pause side only)
  try {
    if (!pauseOnly && (await alertsDue(ctx, companyId, now))) {
      const figures = await checkSpend({ config, client: brandReadClient(ctx, companyId, config), now });
      if (figures.pctUsed === null) {
        // Not marked as checked, so the next tick retries. The run fails, so an
        // expired token does not silence the alerts unnoticed.
        failures.push(`${brand} alerts: MTD not read (${figures.reason}: ${figures.detail})`);
      } else {
        await ctx.state.set(alertCheckKey(companyId), now.toISOString());
        const outcome = await evaluateSpendAlerts(deps, companyId, config, figures, initiator);
        if (outcome.telegram === "failed") {
          const what = [...outcome.claimed.map((threshold) => `${threshold} %`), ...outcome.risks].join("/");
          failures.push(`${brand} alert ${what}: Telegram failed (${outcome.error}), retrying next check`);
        }
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
      // A marker read failure must not skip the pause; pausing is idempotent.
      let done = false;
      try {
        done = (await deps.store.claimed(companyId, [key])).length > 0;
      } catch (error) {
        failures.push(`${brand} scheduled pause: marker read failed (${safeError(error)}), paused anyway`);
      }
      if (!done) {
        const result = await pauseAll(deps, companyId, config, {
          dryRun: false,
          rule: "scheduled_pause",
          reason: `scheduled pause at ${pause.at} ${config.timeZone}${fallbackMark}`,
          initiator,
          notify: true,
        });
        if (result.errors.length > 0) {
          failures.push(`${brand} scheduled pause: ${result.errors.length} pause(s) failed, retrying next tick`);
        } else if (result.cardsError) {
          // The day is not marked: the next tick closes the cards again (the pauses are idempotent).
          failures.push(`${brand} scheduled pause: open activation cards not closed (${result.cardsError}), retrying next tick`);
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
          failures.push(`${brand} data gate: feed check failed (${outcome.reason}: ${outcome.detail}), nothing paused (fail-open)`);
        }
      } else {
        const note = `data-gate: arvo ${outcome.value} (ehto ${gate.operator} ${gate.threshold} ei enää täyty)`;
        const result = await pauseAll(deps, companyId, config, {
          dryRun: false,
          rule: "data_gate",
          reason: `data gate ${gate.jsonPointer} = ${outcome.value}, needs ${gate.operator} ${gate.threshold}${fallbackMark}`,
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
      // README ADR 3: a pause is never skipped silently. An invalid or
      // unavailable config runs the pause side on the last valid config, and
      // the run fails either way so the broken config is seen.
      const loaded = await loadPauseConfig(ctx, companyId, result);
      if (!loaded.ok && loaded.neverEnabled) {
        // A disabled brand (monthlyCapEur unset, e.g. the AUR read-only
        // config) that was never enabled is a normal state, not a failure.
        ctx.logger.info("rk9-ads scheduled-pause: brand disabled and never enabled; skipped", { companyId });
        continue;
      }
      if (!loaded.ok) {
        failures.push(`company ${companyId}: ${loaded.error}; nothing paused`);
        continue;
      }
      if (loaded.fallback) {
        failures.push(`${loaded.config.brandCode}: the brand config is ${loaded.fallback.state}; pause side ran on the last valid config`);
      }
      failures.push(...(await runForCompany(deps, job, companyId, loaded.config, now, loaded.fallback !== null)));
    }
    if (failures.length > 0) {
      throw new Error(`scheduled-pause: ${failures.join("; ")}`.slice(0, 2000));
    }
  };
}
