/**
 * The `scheduled-pause` job (A6, RK9-511). The host cron is UTC only (G18),
 * so the job runs every 5 minutes and decides in the brand's local time:
 *
 * 1. Spend alerts (alerts.ts: 80 % / 100 % MTD and the standing risks), at
 *    most every ALERT_CHECK_INTERVAL_MS per company. A failed MTD read or a
 *    failed send fails the run and is retried on the next check.
 * 2. Scheduled pause: when `schedule.scheduledPause.enabled` and the local
 *    time is at or after `at` (21:30 is right in both EET and EEST), once per
 *    local day. It also leaves a halt until the next local morning and closes
 *    the open activation cards (RK9-557, RK9-561). The day's marker is
 *    written once the Meta pauses succeeded and the halt is stored, so a Meta
 *    or halt failure is retried on the next tick (pauses are idempotent). A
 *    retry tick keeps the halt the day's first tick stored, and closes no
 *    cards again, so a board user's clear stands (RK9-565). A run with only a
 *    halt or card failure to report writes its audit row once per local day.
 *    A card close that failed fails the run once but is not retried: the halt
 *    already refuses a tap on the card left open. Off by default.
 * 3. Re-checks and activation undos (RK9-565), on every tick: the second
 *    listing of a kill switch or scheduled pause about a minute after it
 *    (recheck.ts), and the PAUSED writes of an activation undo that Meta
 *    refused (pending-undo.ts), until Meta confirms, a newer activation
 *    supersedes it or a board user acknowledges it. The same retry pauses
 *    what a kill switch, scheduled pause, cap pause or re-check could not
 *    pause during its halt (RK9-568).
 * 4. Data gate: when `schedule.dataGate` is set, on every tick. It fails open
 *    (see data-gate.ts): a feed that cannot be read pauses nothing, but it
 *    fails the run so the broken feed is seen (RK9-523). When the predicate no
 *    longer holds it runs pauseAll, which is a no-op once everything is paused.
 *    It leaves no halt: an activation approved while the predicate does not
 *    hold is paused again on the next tick, at most 5 minutes later. A halt
 *    would refuse every card whenever the feed's value is low.
 *
 * An invalid or unavailable config fails the run; the pause side (2 to 4)
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
import { haltIdentity, readRuleHalt, storedRuleHalt } from "./halt.js";
import { haltUntil, pauseAll, PauseListError, retryFailures, stopFailures, type PauseAllDeps, type PauseAllResult, type StopActivations } from "./killswitch.js";
import { loadPauseConfig } from "./pause-config.js";
import { readPendingUndos, retryPendingUndos, type UndoRetryDeps } from "./pending-undo.js";
import { dropRecheck, noteRecheckFailure, readRecheck, RECHECK_RULES, RECHECK_WINDOW_MS, type Recheck, type RecheckRule } from "./recheck.js";
import { brandReadClient, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "./support.js";

export const SCHEDULED_PAUSE_JOB_KEY = "scheduled-pause";
export const SCHEDULED_PAUSE_KIND = "scheduled_pause";
export const ALERT_CHECK_INTERVAL_MS = 15 * 60_000;

export function scheduledPauseKey(brandCode: string, date: string): string {
  return `scheduled-pause:${brandCode}:${date}`;
}

/** The once-per-day marker of a scheduled pause's audit row that reports only a halt or card failure. */
export function scheduledStopAuditKey(brandCode: string, date: string): string {
  return `scheduled-pause-stop:${brandCode}:${date}`;
}

/**
 * A retry tick's halt: the one the day's first tick stored (same end), if
 * any. A cleared one stays cleared. Undefined when this tick must store one.
 */
async function dayHalt(ctx: PluginContext, companyId: string, config: BrandConfig, now: Date): Promise<StopActivations | undefined> {
  let stored: Awaited<ReturnType<typeof storedRuleHalt>>;
  try {
    stored = await storedRuleHalt(ctx, companyId, "scheduled_pause");
  } catch {
    return undefined;
  }
  // The same night's halt from the same local day: an `at` moved past midnight starts a new one.
  if (
    !stored ||
    stored.halt.until !== haltUntil("scheduled_pause", config.timeZone, now) ||
    !Number.isFinite(Date.parse(stored.halt.since)) ||
    localDate(new Date(stored.halt.since), config.timeZone) !== localDate(now, config.timeZone)
  ) {
    return undefined;
  }
  return { stopped: { closedCardIds: [], ...(stored.cleared ? {} : { halt: stored.halt }) }, announce: async () => undefined };
}

export interface ScheduledPauseDeps extends PauseAllDeps {
  /** Ends a failed undo's retry (pending-undo.ts). */
  newerActivation?: UndoRetryDeps["newerActivation"];
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
        const day = localDate(now, config.timeZone);
        const reused = await dayHalt(ctx, companyId, config, now);
        const result = await pauseAll(deps, companyId, config, {
          dryRun: false,
          rule: "scheduled_pause",
          reason: `scheduled pause at ${pause.at} ${config.timeZone}${fallbackMark}`,
          initiator,
          notify: true,
          ...(reused ? { stopped: reused } : {}),
          recordStopOnly: () => deps.store.claim(companyId, scheduledStopAuditKey(brand, day), SCHEDULED_PAUSE_KIND),
        });
        failures.push(...stopFailures(`${brand} scheduled pause`, result));
        if (result.recheckError) failures.push(`${brand} scheduled pause: the re-check was not stored (${result.recheckError})`);
        if (result.errors.length > 0) {
          failures.push(...retryFailures(`${brand} scheduled pause`, result));
          failures.push(`${brand} scheduled pause: retrying the listing next tick`);
        } else if (result.haltError) {
          // Without the halt an open card could undo the pause: the next tick stores it and closes the cards again.
          failures.push(`${brand} scheduled pause: retrying the halt next tick`);
        } else {
          // A failed card close is reported, not retried (RK9-561): the halt refuses a tap on a card left open.
          await deps.store.claim(companyId, key, SCHEDULED_PAUSE_KIND, {
            count: result.count,
            jobRunId: job.runId,
            ...(result.cardsError ? { cardsError: result.cardsError } : {}),
          });
          const tg = telegramFailure(`${brand} scheduled pause`, result);
          if (tg) failures.push(tg);
        }
      }
    } catch (error) {
      failures.push(`${brand} scheduled pause: ${safeError(error)}`);
      if (error instanceof PauseListError) failures.push(...stopFailures(`${brand} scheduled pause`, error.stopped));
    }
  }

  // 3. Re-checks and activation undos
  failures.push(...(await runDueRechecks(deps, companyId, config, initiator, now)));
  try {
    failures.push(...(await retryPendingUndos(deps, companyId, config, initiator, now)));
  } catch (error) {
    failures.push(`${brand} activation undo: ${safeError(error)}`);
  }

  // 4. Data gate
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

const RECHECK_RULE_TEXT: Record<RecheckRule, string> = { kill_switch: "hätäkatkaisimen", scheduled_pause: "ajastetun pysäytyksen" };

/** The marker of a dropped re-check's alert: one per re-check (RK9-570). */
export function recheckDroppedKey(brandCode: string, rule: RecheckRule, dueAt: string): string {
  return `recheck-dropped:${brandCode}:${rule}:${dueAt}`;
}

/**
 * The alert of a re-check whose every run failed within its window (RK9-570):
 * its listing, its halt read or its PAUSED writes, with no pause retry
 * stored. Claimed before the send and given back when it fails. Returns the
 * failure that keeps the re-check for the next tick, or null.
 */
async function alertDroppedRecheck(deps: RecheckDeps, companyId: string, config: BrandConfig, recheck: Recheck): Promise<string | null> {
  if (!config.telegram) return null;
  const key = recheckDroppedKey(config.brandCode, recheck.rule, recheck.dueAt);
  try {
    if (!(await deps.store.claim(companyId, key, "recheck_dropped", { rule: recheck.rule, dueAt: recheck.dueAt }))) return null;
  } catch (error) {
    return `alert marker not claimed (${safeError(error)})`;
  }
  const name = config.displayName || config.brandCode;
  const text = [
    `⚠️ ${name}: ${RECHECK_RULE_TEXT[recheck.rule]} uudelleentarkistus epäonnistui ${recheck.attempts} kertaa ${RECHECK_WINDOW_MS / 60_000} minuutin aikana ja lopetettiin`,
    `Viimeisin virhe: ${(recheck.lastError ?? "tuntematon").slice(0, 300)}`,
    "Metan listaus on voinut näyttää viiveellä ACTIVE-kohteita, joita ei pysäytetty. Tarkista Metassa ja pysäytä käsin kohteet, jotka ovat yhä ACTIVE.",
  ].join("\n");
  try {
    await deps.notifier.sendMessage(companyId, config, text);
    return null;
  } catch (error) {
    await deps.store.release(companyId, key).catch(() => undefined);
    return safeError(error);
  }
}

type RecheckDeps = PauseAllDeps & { store: OnceStore };

/** The tick: runs each due re-check of the company. Returns the run's failure lines. */
export async function runDueRechecks(
  deps: RecheckDeps,
  companyId: string,
  config: BrandConfig,
  initiator: Initiator,
  now: Date,
): Promise<string[]> {
  const failures: string[] = [];
  for (const rule of RECHECK_RULES) {
    const prefix = `${config.brandCode} ${rule} re-check`;
    try {
      const recheck = await readRecheck(deps.ctx, companyId, rule);
      if (!recheck) continue;
      const due = Date.parse(recheck.dueAt);
      if (Number.isFinite(due) && due > now.getTime()) continue;
      const drop = () => dropRecheck(deps.ctx, companyId, rule);
      /** One more failed run, so the drop at the window's end can say the ticks ran (RK9-568, RK9-570). */
      const noteFailure = async (error: string) => {
        try {
          await noteRecheckFailure(deps.ctx, companyId, recheck, error);
        } catch (noteError) {
          // The drop at the window's end cannot tell that this run ran: this line does.
          failures.push(`${prefix}: this failed run was not counted (${safeError(noteError)})`);
        }
      };
      if (!Number.isFinite(due) || now.getTime() - due > RECHECK_WINDOW_MS) {
        if (recheck.attempts) {
          // The ticks ran and failed: the objects the late listing would show may still spend (RK9-570).
          const alertError = await alertDroppedRecheck(deps, companyId, config, recheck);
          if (alertError) {
            // With Telegram down the run's failure is the only signal: it carries what the drop line would.
            failures.push(
              `${prefix}: ran ${recheck.attempts} time(s) within ${RECHECK_WINDOW_MS / 60_000} min of ${recheck.dueAt} and failed each time (last error: ${recheck.lastError ?? "unknown"}); check Meta and pause by hand what is still ACTIVE. The alert failed (${alertError}): kept to send it next tick`,
            );
            continue;
          }
        }
        deps.ctx.logger.warn("rk9-ads pause: re-check past its window, dropped", { companyId, rule, dueAt: recheck.dueAt, attempts: recheck.attempts ?? 0 });
        await drop();
        // The run fails once so it is seen, and says whether the ticks ran (RK9-568).
        failures.push(
          recheck.attempts
            ? `${prefix}: ran ${recheck.attempts} time(s) within ${RECHECK_WINDOW_MS / 60_000} min of ${recheck.dueAt} and failed each time (last error: ${recheck.lastError ?? "unknown"}), dropped; check Meta and pause by hand what is still ACTIVE`
            : `${prefix}: no tick ran within ${RECHECK_WINDOW_MS / 60_000} min of ${recheck.dueAt}, dropped unrun`,
        );
        continue;
      }
      if (recheck.haltId !== null) {
        let halt: Awaited<ReturnType<typeof readRuleHalt>>;
        try {
          halt = await readRuleHalt(deps.ctx, companyId, rule, now);
        } catch (error) {
          failures.push(`${prefix}: halt not read (${safeError(error)}), retrying next tick`);
          await noteFailure(`halt not read: ${safeError(error)}`);
          continue;
        }
        if (!halt || haltIdentity(halt) !== recheck.haltId) {
          deps.ctx.logger.info("rk9-ads pause: halt no longer in force, re-check dropped", { companyId, rule });
          await drop();
          continue;
        }
      }
      let result: PauseAllResult;
      try {
        result = await pauseAll(deps, companyId, config, {
          dryRun: false,
          rule,
          reason: `${recheck.reason} (re-check)`.slice(0, 300),
          initiator,
          notify: true,
          note: "Uudelleentarkistus: Metan listaus näytti nämä ACTIVE-tilassa vasta viiveellä.",
          // The halt and the card close stand from the pause itself.
          stopped: { stopped: { closedCardIds: [] }, announce: async () => undefined },
          recheck: true,
          haltId: recheck.haltId,
        });
      } catch (error) {
        failures.push(`${prefix}: ${safeError(error)}, retrying next tick`);
        if (error instanceof PauseListError) failures.push(...stopFailures(prefix, error.stopped));
        await noteFailure(`${error instanceof PauseListError ? "listing failed" : "pause failed"}: ${safeError(error)}`);
        continue;
      }
      failures.push(...retryFailures(prefix, result));
      if (result.errors.length > 0 && !result.retry?.stored) {
        // The objects are not in the retry: the re-check stays and counts the failure.
        failures.push(`${prefix}: retrying next tick`);
        await noteFailure(`PAUSED failed and the pause retry could not be stored: ${result.errors.at(-1)!.error}`);
        continue;
      }
      // The listing ran; what it could not pause is in the pause retry. A failed drop is no failed run: the outer catch reports it.
      await drop();
      if (result.telegram === "failed") failures.push(`${prefix}: paused ${result.count} but the Telegram notice failed (${result.telegramError})`);
    } catch (error) {
      failures.push(`${prefix}: ${safeError(error)}`);
    }
  }
  return failures;
}

/**
 * Open undos and pause retries of a company the job skips: without a brand
 * config, a valid one or a last valid one, there is no Meta client to retry
 * them with.
 */
async function orphanedUndos(ctx: ScheduledPauseDeps["ctx"], companyId: string): Promise<string[]> {
  try {
    const open = await readPendingUndos(ctx, companyId);
    if (open.length === 0) return [];
    return [`company ${companyId}: ${open.length} activation undo(s) or pause retry(ies) open (${open.map((entry) => `${entry.kind} ${entry.objectId}`).join(", ")}) but no brand config to retry them; pause them by hand in Meta`];
  } catch (error) {
    return [`company ${companyId}: open activation undos not read (${safeError(error)})`];
  }
}

export function createScheduledPauseJob(deps: ScheduledPauseDeps) {
  return async (job: PluginJobContext): Promise<void> => {
    const { ctx } = deps;
    const now = deps.now?.() ?? new Date();
    const failures: string[] = [];
    for (const { companyId, result } of await listCompanyConfigs(ctx)) {
      if (result.state === "absent") {
        failures.push(...(await orphanedUndos(ctx, companyId)));
        continue;
      }
      // README ADR 3: a pause is never skipped silently. An invalid or
      // unavailable config runs the pause side on the last valid config, and
      // the run fails either way so the broken config is seen.
      const loaded = await loadPauseConfig(ctx, companyId, result);
      if (!loaded.ok && loaded.neverEnabled) {
        // A disabled brand (monthlyCapEur unset, e.g. the AUR read-only
        // config) that was never enabled is a normal state, not a failure.
        ctx.logger.info("rk9-ads scheduled-pause: brand disabled and never enabled; skipped", { companyId });
        failures.push(...(await orphanedUndos(ctx, companyId)));
        continue;
      }
      if (!loaded.ok) {
        // No config to pause with: the retry does not run either, so its open objects are named (RK9-567).
        failures.push(`company ${companyId}: ${loaded.error}; nothing paused`, ...(await orphanedUndos(ctx, companyId)));
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
