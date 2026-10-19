/**
 * The `rules-evaluate` job body (A11, RK9-515). Hourly, per company with a
 * brand config:
 *
 * 1. Read the live status of the brand's ads and campaigns (read-only client).
 *    A failed read fails the run and switches off every rule but the built-in
 *    cap rule, which decides on the month position alone: pauseAll lists its
 *    own targets and pauses only what is ACTIVE (RK9-541).
 * 2. Read the month position from the spend guard (checkSpend, the same MTD
 *    as the digest, RK9-526). Unreadable: the cap rule makes no decision.
 * 3. Read completed ad-days from insights_daily, creative validUntil, A10's
 *    fatigue (only when a pause_fatigued rule is on) and the earlier
 *    rule_actions the cooldowns need. Each read is isolated (RK9-536): a
 *    failed one fails the run and switches off only the rules that need it,
 *    never the built-in cap rule. Without the earlier rule_actions only the
 *    cap rule runs, and the marker of its latest settled pause stands in
 *    for its cooldown while that pause's halt is in force (RK9-541), so an
 *    object the operator restarted is not paused again every hour.
 *    Without the status the cap rule still runs, unless a board user
 *    cleared this month's cap halt and the cap is still the one it paused
 *    at: an unread status must not override that. After the headroom
 *    release, or under a cap changed since the clear, it runs, so spend at
 *    90 % of the cap still pauses (RK9-579, RK9-582).
 *    Threshold rules wait for insights-daily-close; still waiting at 06:00
 *    local time fails the run, so a broken close is seen. When the ad account
 *    reports in another time zone than the brand's, the insights dates and
 *    the close marker are not the brand's days, so threshold rules do not run
 *    (the spend guard refuses that state too).
 * 4. evaluateRules() decides.
 * 5. Every decision goes to rule_actions and the activity log:
 *    - shadow: dry_run=true, no Meta write. The morning digest lists the
 *      shadow hits of the last 24 h, so shadow sends no Telegram of its own.
 *    - live ad pause: setObjectStatus(PAUSED) on the brand client, so the
 *      write passes the spend guard hook (guardedWrite). One Telegram message
 *      per run lists the ads that changed state; none when nothing changed.
 *    - pause_all (the built-in cap rule): A6's pauseAll, dry run in shadow.
 *      It pauses only ACTIVE objects, audits itself and notifies only when
 *      it paused something.
 *
 * The cap pause's halt (spend-guard/halt.ts) is lifted when two consecutive
 * runs, at least CAP_HEADROOM_MIN_GAP_MS apart, read the month under the 90 %
 * cap, e.g. after monthlyCapEur was raised (RK9-565). Spend only grows within
 * a month, so a reading below the MTD the halt stored is a bad reading (an
 * empty or partial insights answer reads as 0) and counts as none, also a
 * downward correction by Meta; a halt without those figures waits for the
 * board. A first reading more than CAP_HEADROOM_MAX_GAP_MS old counts as none. A run that reads the month at
 * or over the cap, or cannot read it or the status, starts the count again.
 * The release is audited like a board user's clear and announced in Telegram.
 *
 * A brand whose config is invalid, unavailable or disabled (monthlyCapEur
 * cleared) runs only the built-in cap rule, on the last valid config (A6's
 * loadPauseConfig, README ADR 3), with that config's liveMode and ad
 * account: a broken edit is not read. An invalid or unavailable config fails
 * every run so it is seen; a disabled one is an operator's choice and fails
 * only the first run of each local day (RK9-541). Deleting the brand config
 * stops the fallback. A brand saved disabled and never enabled is skipped
 * quietly.
 *
 * One brand's failure does not stop the others. The run throws at the end
 * when anything failed, so the host shows it.
 */

import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { listCompanyConfigs } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { evaluateFatigue, type AdFatigue } from "../../insights/fatigue-issues.js";
import { addDays } from "../../insights/mtd.js";
import { createInsightsStore } from "../../insights/store.js";
import { isLocalTimeAtOrAfter, localDate, nextLocalMonthStart } from "../../kit/local-time.js";
import type { MetaClientMode, MetaGraphClient } from "../../meta/graph.js";
import { listAds, listCampaigns, setObjectStatus } from "../../meta/methods.js";
import { checkSpend } from "../spend-guard/guard.js";
import { clearRuleHalt, HALT_NAMESPACE, haltIdentity, readRuleHalt, storedRuleHalt, type HaltState } from "../spend-guard/halt.js";
import { pauseAll, PauseListError, stopFailures, type PauseAllDeps } from "../spend-guard/killswitch.js";
import { loadPauseConfig, pauseReason, type PauseConfig } from "../spend-guard/pause-config.js";
import { brandClient, brandReadClient, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "../spend-guard/support.js";
import { evaluateRules, type RuleAdDay, type RuleDecision, type RuleSnapshots, type RuleStatus } from "./evaluate.js";
import { BUILTIN_PAUSE_ALL_CAP_PCT, BUILTIN_PAUSE_ALL_CAP_RULE_ID, builtinPauseAllCap, type RuleSet, type ThresholdPauseRule } from "./schema.js";
import type { RulesStore } from "./store.js";

export const RULES_JOB_KEY = "rules-evaluate";
export const RULES_ACTIVITY_PREFIX = "rk9-ads rules";
const LIST_MAX_PAGES = 100;
/** Telegram allows 4096 characters; the notice stays below this. */
const NOTICE_MAX = 3900;
/** Local time by which insights-daily-close must have finalised yesterday. */
const CLOSE_DEADLINE = "06:00";
/** The second run that sees headroom must come at least this long after the first (the job is hourly). */
export const CAP_HEADROOM_MIN_GAP_MS = 30 * 60_000;
/** A first reading older than this (runs skipped, e.g. an unreadable config) counts as none. Two credible readings at most this far apart are needed. */
export const CAP_HEADROOM_MAX_GAP_MS = 2 * 60 * 60_000;
export const CAP_HALT_RELEASED_ACTIVITY = "rk9-ads spend guard: cap halt released";

export interface RulesDeps {
  ctx: PluginContext;
  ledger: Ledger;
  store: RulesStore;
  notifier: SpendGuardNotifier;
  now: () => Date;
  /** A10 fatigue of the brand's ads as of a local date. */
  fatigue?: (companyId: string, config: BrandConfig, asOf: string) => Promise<AdFatigue[]>;
  /** Tests: replaces the brand's Meta client (readOnly for reads). */
  clientFor?: (companyId: string, config: BrandConfig, mode: MetaClientMode, initiator: Initiator) => MetaGraphClient;
  /** Tests: replaces the running gate's card closer of the cap pause. */
  closeCards?: PauseAllDeps["closeCards"];
  /** The alert markers of the pause retry of objects the cap pause could not pause (RK9-568). */
  onceStore?: OnceStore;
}

export interface AppliedDecision extends RuleDecision {
  /** True when a live write changed the object (or pauseAll paused something). */
  applied: boolean;
  error: string | null;
}

export interface BrandRulesOutcome {
  brandCode: string;
  decisions: AppliedDecision[];
  /** Ads a live rule paused in this run. */
  changed: number;
  telegram: "sent" | "not_configured" | "failed" | "skipped";
  failures: string[];
}

function clientFor(deps: RulesDeps, companyId: string, config: BrandConfig, mode: MetaClientMode, initiator: Initiator): MetaGraphClient {
  if (deps.clientFor) return deps.clientFor(companyId, config, mode, initiator);
  if (mode === "readOnly") return brandReadClient(deps.ctx, companyId, config);
  return brandClient(deps, companyId, config, mode, { initiator });
}

async function logActivity(deps: RulesDeps, companyId: string, config: BrandConfig, message: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await deps.ctx.activity.log({
      companyId,
      message: `${RULES_ACTIVITY_PREFIX}: ${message}`,
      entityType: "rk9_ads_brand",
      entityId: config.brandCode,
      metadata,
    });
  } catch (error) {
    deps.ctx.logger.error("rk9-ads rules: activity log failed", { companyId, error: safeError(error) });
  }
}

/**
 * rule_actions row + activity entry of one ad decision. An audit failure is
 * never thrown (it must not undo a pause); it returns the error text so the
 * run fails, because a missing row also lifts the decision's cooldown.
 */
async function audit(deps: RulesDeps, companyId: string, config: BrandConfig, decision: AppliedDecision, initiator: Initiator, now: Date): Promise<string | null> {
  let failure: string | null = null;
  const shadow = decision.mode === "shadow";
  try {
    await deps.store.insertAction(companyId, {
      brandCode: config.brandCode,
      ruleId: decision.ruleId,
      ruleType: decision.ruleType,
      objectType: decision.objectType,
      objectId: decision.objectId,
      action: decision.action,
      mode: decision.mode,
      dryRun: shadow,
      applied: decision.applied,
      reason: decision.reason,
      metrics: { ...decision.metrics, initiator },
      error: decision.error,
      decidedAt: now,
    });
  } catch (error) {
    failure = safeError(error);
    deps.ctx.logger.error("rk9-ads rules: rule_actions insert failed", { companyId, error: failure });
  }
  const verb = shadow ? "would pause" : decision.applied ? "paused" : "failed to pause";
  await logActivity(deps, companyId, config, `${decision.ruleId} ${verb} ${decision.objectType} ${decision.objectId}${shadow ? " (shadow)" : ""}`, {
    rule: decision.ruleType,
    ruleId: decision.ruleId,
    action: decision.action,
    mode: decision.mode,
    dryRun: shadow,
    applied: decision.applied,
    reason: decision.reason,
    objectType: decision.objectType,
    objectId: decision.objectId,
    initiator,
    ...decision.metrics,
    ...(decision.error ? { error: decision.error } : {}),
  });
  return failure;
}

export function liveNoticeText(config: BrandConfig, paused: readonly AppliedDecision[], names: ReadonlyMap<string, string>, at: Date): string {
  const head = `⏸ ${config.displayName || config.brandCode}`.slice(0, 120) + `: säännöt pysäyttivät ${paused.length} mainos(ta) (${localDate(at, config.timeZone)})`;
  const lines = [head];
  let length = head.length;
  for (const [index, decision] of paused.entries()) {
    const name = names.get(decision.objectId);
    const line = `• ${decision.ruleId}: mainos ${name ? `${name} (${decision.objectId})` : decision.objectId} – ${decision.reason}`.slice(0, 400);
    if (length + line.length + 1 > NOTICE_MAX - 120) {
      lines.push(`… ja ${paused.length - index} muuta (lista aktiviteettilokissa)`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * The snapshots evaluateRules needs, and the rules that can run on them. A
 * read failure is a failure line, and its rules get no input, so they decide
 * nothing; a status read failure leaves only the cap rule.
 */
async function readInputs(
  deps: RulesDeps,
  companyId: string,
  config: BrandConfig,
  rules: RuleSet,
  now: Date,
  initiator: Initiator,
  failures: string[],
): Promise<{ snapshots: RuleSnapshots; status: RuleStatus; rules: RuleSet }> {
  const brand = config.brandCode;
  const readClient = clientFor(deps, companyId, config, "readOnly", initiator);
  const capOnly = (set: RuleSet): RuleSet => ({ ...set, list: set.list.filter((rule) => rule.type === "pause_all_cap") });
  let runnable = rules;

  let status: RuleStatus;
  try {
    const [ads, campaigns] = await Promise.all([
      listAds(readClient, config.meta.adAccountId, { maxPages: LIST_MAX_PAGES }),
      listCampaigns(readClient, config.meta.adAccountId, { maxPages: LIST_MAX_PAGES }),
    ]);
    status = { adAccountId: config.meta.adAccountId, ads, campaigns };
  } catch (error) {
    // The other rules need the ad status (fail-open). The cap rule does not:
    // pauseAll lists its own targets (RK9-541).
    status = { adAccountId: config.meta.adAccountId, ads: [], campaigns: [], unread: true };
    runnable = capOnly(runnable);
    const cleared = await capHaltCleared(deps, companyId, config, now);
    if (cleared) runnable = { ...runnable, list: [] };
    failures.push(
      `${brand}: Meta status read failed (${safeError(error)}), ${cleared ? `no rule evaluated (${cleared})` : "only pause_all_cap evaluated"} (fail-open)`,
    );
  }
  const enabled = runnable.list.filter((rule) => rule.enabled);

  let spend: RuleSnapshots["spend"] = null;
  let zoneMismatch = false;
  if (enabled.some((rule) => rule.type === "pause_all_cap")) {
    try {
      const figures = await checkSpend({ config, client: readClient, now });
      zoneMismatch = figures.reason === "account_timezone_mismatch";
      // The cap is in EUR: a figure in another currency is no basis for a pause.
      if (figures.pctUsed === null || figures.mtdEur === null || figures.currency !== "EUR") {
        failures.push(`${brand}: month-to-date not read (${figures.reason}: ${figures.detail}), pause_all_cap skipped (fail-open)`);
      } else {
        spend = { month: figures.month, mtdEur: figures.mtdEur, monthlyCapEur: figures.monthlyCapEur, pctUsed: figures.pctUsed };
      }
    } catch (error) {
      failures.push(`${brand}: month-to-date not read (${safeError(error)}), pause_all_cap skipped (fail-open)`);
    }
  }

  const today = localDate(now, config.timeZone);
  const yesterday = addDays(today, -1);
  const thresholdRules = enabled.filter((rule): rule is ThresholdPauseRule => rule.type === "threshold_pause");
  const maxDays = Math.max(0, ...thresholdRules.map((rule) => rule.days));
  // Yesterday's rows are partial until insights-daily-close finalised them
  // (shortly after local midnight); until then threshold rules wait.
  let days: RuleAdDay[] = [];
  if (maxDays > 0 && zoneMismatch) {
    // Insights dates and the close marker are ad-account-local days.
    failures.push(`${brand}: the ad account reports in another time zone than ${config.timeZone}, threshold rules skipped`);
  } else if (maxDays > 0) {
    try {
      if (await deps.store.dayClosed(companyId, today)) {
        days = await deps.store.adDays(companyId, addDays(yesterday, -(maxDays - 1)), yesterday);
      } else if (isLocalTimeAtOrAfter(now, CLOSE_DEADLINE, config.timeZone)) {
        failures.push(`${brand}: insights-daily-close has not finalised ${yesterday} by ${CLOSE_DEADLINE}, threshold rules wait`);
      } else {
        deps.ctx.logger.info("rk9-ads rules: yesterday's insights are not closed yet, threshold rules wait", { companyId, yesterday });
      }
    } catch (error) {
      failures.push(`${brand}: insights not read (${safeError(error)}), threshold rules skipped (fail-open)`);
    }
  }

  let creatives: RuleSnapshots["creatives"] = [];
  if (enabled.some((rule) => rule.type === "pause_valid_until")) {
    try {
      creatives = await deps.store.creativeValidity(companyId);
    } catch (error) {
      failures.push(`${brand}: creative validity not read (${safeError(error)}), pause_valid_until skipped (fail-open)`);
    }
  }

  let fatigue: RuleSnapshots["fatigue"] = [];
  if (enabled.some((rule) => rule.type === "pause_fatigued") && config.fatigue.enabled) {
    try {
      const evaluate = deps.fatigue ?? ((id, brandConfig, asOf) => evaluateFatigue(createInsightsStore(deps.ctx.db), id, brandConfig, asOf));
      fatigue = (await evaluate(companyId, config, yesterday)).map((entry) => ({ adId: entry.adId, status: entry.result.status, signals: entry.result.signals }));
    } catch (error) {
      failures.push(`${brand}: fatigue not read (${safeError(error)}), pause_fatigued skipped (fail-open)`);
    }
  }

  const maxCooldownHours = Math.max(0, ...enabled.map((rule) => rule.cooldownHours));
  let priorActions: RuleSnapshots["priorActions"] = [];
  if (maxCooldownHours > 0) {
    try {
      priorActions = await deps.store.priorActions(companyId, enabled.map((rule) => rule.ruleId), new Date(now.getTime() - maxCooldownHours * 3_600_000));
    } catch (error) {
      // Without their cooldowns the other rules would decide again every
      // hour. The cap rule still runs: pauseAll pauses only what is ACTIVE.
      runnable = capOnly(runnable);
      const cooldown = await capHaltCooldown(deps, companyId, config, runnable, now);
      priorActions = cooldown.prior;
      failures.push(`${brand}: earlier rule actions not read (${safeError(error)}), only pause_all_cap evaluated, ${cooldown.note}`);
    }
  }

  return { snapshots: { timeZone: config.timeZone, days, creatives, fatigue, spend, priorActions }, status, rules: runnable };
}

function capSettledKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `cap-settled:${companyId}` };
}

/**
 * Remembers a settled live cap pause (RK9-541): the halt it left, the ad
 * account and the time. The halt alone is no proof, because pauseAll stores
 * it before it lists or pauses anything. Never throws; without the marker
 * the cap rule has no cooldown on the fallback path, which only pauses more.
 */
async function rememberSettledCap(deps: RulesDeps, companyId: string, config: BrandConfig, halt: HaltState, now: Date): Promise<void> {
  try {
    await deps.ctx.state.set(capSettledKey(companyId), { haltId: haltIdentity(halt), adAccountId: config.meta.adAccountId, at: now.toISOString() });
  } catch (error) {
    deps.ctx.logger.warn("rk9-ads rules: settled cap pause not remembered", { companyId, error: safeError(error) });
  }
}

/**
 * The cap rule's cooldown when rule_actions cannot be read: the latest
 * settled cap pause, while the halt it left is still in force (not cleared,
 * not ended, not replaced by a later attempt) and on the same ad account
 * (RK9-541). Otherwise the rule has no cooldown, as before; its pause is
 * idempotent.
 */
async function capHaltCooldown(
  deps: RulesDeps,
  companyId: string,
  config: BrandConfig,
  rules: RuleSet,
  now: Date,
): Promise<{ prior: RuleSnapshots["priorActions"]; note: string }> {
  const cap = rules.list.find((rule) => rule.type === "pause_all_cap");
  if (!cap) return { prior: [], note: "no cooldown" };
  try {
    const halt = await readRuleHalt(deps.ctx, companyId, "pause_all_cap", now);
    if (!halt) return { prior: [], note: "no cap halt in force, no cooldown" };
    const settled = (await deps.ctx.state.get(capSettledKey(companyId))) as { haltId?: unknown; adAccountId?: unknown; at?: unknown } | null;
    const at = typeof settled?.at === "string" ? Date.parse(settled.at) : Number.NaN;
    if (!settled || settled.haltId !== haltIdentity(halt) || settled.adAccountId !== config.meta.adAccountId || !Number.isFinite(at)) {
      return { prior: [], note: "the cap halt in force is not from a settled cap pause, no cooldown" };
    }
    const decidedAt = new Date(at).toISOString();
    return {
      prior: [{ ruleId: cap.ruleId, objectId: config.meta.adAccountId, mode: "live", applied: true, decidedAt }],
      note: `cooldown from the settled cap pause of ${decidedAt}`,
    };
  } catch (error) {
    return { prior: [], note: `no cooldown (cap halt not read: ${safeError(error)})` };
  }
}

/**
 * Why the cap rule waits when the status could not be read: a board user
 * cleared this month's cap halt, and `monthlyCapEur` is the cap it paused at.
 * Without the status that clear must not be overridden every hour (a new
 * halt each run). Null when the rule may run, also when the halt cannot be
 * read (the cap rule then runs, as a pause is the safe side).
 *
 * The headroom release's clear never makes the rule wait (RK9-582): it says
 * only that the month was under the cap of that time, so spend at 90 % of
 * the cap now pauses as it would with a status read, also after the cap was
 * lowered again. A board clear makes it wait only at the cap it paused at:
 * the clear said nothing about a cap raised or lowered since (RK9-579). A
 * clear marker from before RK9-582 names no clearer; it waits at the same
 * cap, as before. A halt without the cap figure (stored before RK9-565)
 * waits, as only a board user can clear it. A halt without `until` (a hand
 * edit or a legacy record) ends with the local month of its `since`, like
 * every cap halt; one without a readable `since` does not make the rule wait.
 */
async function capHaltCleared(deps: RulesDeps, companyId: string, config: BrandConfig, now: Date): Promise<string | null> {
  try {
    const stored = await storedRuleHalt(deps.ctx, companyId, "pause_all_cap");
    if (!stored?.cleared || stored.clearedBy === "rules_job") return null;
    const { halt } = stored;
    const until = halt.until === undefined ? Number.NaN : Date.parse(halt.until);
    const since = Date.parse(halt.since);
    const end = Number.isFinite(until) ? until : Number.isFinite(since) ? nextLocalMonthStart(new Date(since), config.timeZone).getTime() : Number.NaN;
    if (!(end > now.getTime())) return null;
    const pausedAt = halt.cap?.monthlyCapEur;
    if (typeof pausedAt === "number" && Number.isFinite(pausedAt) && config.monthlyCapEur !== pausedAt) return null;
    return "this month's cap halt was cleared; the cap rule waits for a status read";
  } catch {
    return null;
  }
}

/**
 * The rules of a brand whose config is invalid, unavailable or disabled: only
 * the built-in cap rule, with the mode and cooldown of the last valid config.
 */
export function capOnlyRules(lastValid: BrandConfig): RuleSet {
  // A config stored before the rule engine has no rules block.
  const stored = (lastValid as Partial<BrandConfig>).rules;
  const cap = (Array.isArray(stored?.list) ? stored.list : []).find((rule) => rule.type === "pause_all_cap" && rule.ruleId === BUILTIN_PAUSE_ALL_CAP_RULE_ID);
  return { liveMode: stored?.liveMode === true, list: [cap ?? builtinPauseAllCap()] };
}

function capHeadroomKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `cap-headroom:${companyId}` };
}

/**
 * Lifts the cap pause's halt on the second consecutive run that reads the
 * month under the cap. Never throws; a failure is a failure line.
 */
async function releaseCapHalt(
  deps: RulesDeps,
  companyId: string,
  config: BrandConfig,
  spend: RuleSnapshots["spend"],
  initiator: Initiator,
  now: Date,
  failures: string[],
): Promise<void> {
  const { ctx } = deps;
  const key = capHeadroomKey(companyId);
  try {
    const halt = await readRuleHalt(ctx, companyId, "pause_all_cap", now);
    const stored = halt?.cap;
    // A damaged or missing figure waits for the board, also a damaged cap (RK9-582).
    const credible =
      spend !== null &&
      typeof stored?.mtdEur === "number" &&
      Number.isFinite(stored.mtdEur) &&
      typeof stored.monthlyCapEur === "number" &&
      Number.isFinite(stored.monthlyCapEur) &&
      spend.mtdEur >= stored.mtdEur;
    if (!halt || !spend || !credible || spend.pctUsed >= BUILTIN_PAUSE_ALL_CAP_PCT) {
      // No halt to lift, or no headroom seen: the count starts again.
      await ctx.state.delete(key);
      return;
    }
    const id = haltIdentity(halt);
    const seen = (await ctx.state.get(key)) as { haltId?: unknown; at?: unknown } | null;
    const gap = typeof seen?.at === "string" ? now.getTime() - Date.parse(seen.at) : Number.NaN;
    if (!seen || seen.haltId !== id || !(gap <= CAP_HEADROOM_MAX_GAP_MS)) {
      await ctx.state.set(key, { haltId: id, at: now.toISOString(), pctUsed: spend.pctUsed });
      return;
    }
    if (!(gap >= CAP_HEADROOM_MIN_GAP_MS)) return;
    const released = await clearRuleHalt(ctx, companyId, "pause_all_cap", id, "rules_job", now);
    await ctx.state.delete(key);
    if (!released) return;
    const metadata = {
      halt,
      clearedBy: { rulesJob: initiator.jobRunId ?? null },
      reason: `month-to-date ${spend.mtdEur} EUR is ${spend.pctUsed} % of the ${spend.monthlyCapEur} EUR cap (< ${BUILTIN_PAUSE_ALL_CAP_PCT} %) on two consecutive runs`,
      firstSeenAt: seen.at,
    };
    try {
      await ctx.activity.log({ companyId, message: CAP_HALT_RELEASED_ACTIVITY, entityType: "rk9_ads_brand", entityId: config.brandCode, metadata });
    } catch (error) {
      ctx.logger.warn("rk9-ads rules: cap halt release not logged", { companyId, detail: safeError(error) });
    }
    ctx.logger.info("rk9-ads rules: cap halt released", { companyId, since: halt.since, pctUsed: spend.pctUsed });
    try {
      await deps.notifier.sendMessage(
        companyId,
        config,
        `▶️ ${config.displayName || config.brandCode}`.slice(0, 120) +
          `: kulutuskaton pysäytystila poistettu, koska kulutus on ${spend.pctUsed} % katosta (${spend.mtdEur} / ${spend.monthlyCapEur} €). Aktivointikortit toimivat taas; pysäytettyjä mainoksia ei käynnistetä automaattisesti.`,
      );
    } catch (error) {
      failures.push(`${config.brandCode}: cap halt released but the Telegram notice failed (${safeError(error)})`);
    }
  } catch (error) {
    failures.push(`${config.brandCode}: cap halt release check failed (${safeError(error)})`);
  }
}

/**
 * Evaluates one brand. `persist: false` is the dry run: the same reads and
 * decisions, but no rule_actions row, no activity entry, no Meta write and
 * no Telegram.
 */
export async function runRulesForBrand(
  deps: RulesDeps,
  companyId: string,
  config: BrandConfig,
  options: { initiator: Initiator; persist: boolean; fallback?: Extract<PauseConfig, { ok: true }>["fallback"] },
): Promise<BrandRulesOutcome> {
  const now = deps.now();
  const failures: string[] = [];
  const outcome: BrandRulesOutcome = { brandCode: config.brandCode, decisions: [], changed: 0, telegram: "skipped", failures };
  let inputs: Awaited<ReturnType<typeof readInputs>>;
  try {
    inputs = await readInputs(deps, companyId, config, config.rules, now, options.initiator, failures);
  } catch (error) {
    // No reading (an unexpected throw): the cap halt's headroom count starts again.
    if (options.persist) await deps.ctx.state.delete(capHeadroomKey(companyId)).catch(() => undefined);
    throw error;
  }
  const { snapshots, status, rules } = inputs;
  const decisions = evaluateRules(snapshots, status, rules, now);
  if (!options.persist) {
    outcome.decisions = decisions.map((decision) => ({ ...decision, applied: false, error: null }));
    return outcome;
  }

  if (status.unread) {
    // No status reading: the cap halt's headroom count starts again.
    await deps.ctx.state.delete(capHeadroomKey(companyId)).catch(() => undefined);
  } else {
    await releaseCapHalt(deps, companyId, config, snapshots.spend, options.initiator, now, failures);
  }

  const names = new Map(status.ads.map((ad) => [ad.id, ad.name ?? ""]));
  const paused: AppliedDecision[] = [];
  let liveClient: MetaGraphClient | null = null;

  for (const decision of decisions) {
    if (decision.action === "pause_all") {
      const shadow = decision.mode === "shadow";
      try {
        const result = await pauseAll(
          {
            ctx: deps.ctx,
            ledger: deps.ledger,
            notifier: deps.notifier,
            now: deps.now,
            ...(deps.clientFor ? { clientFor: (id, brandConfig, mode, initiator) => deps.clientFor!(id, brandConfig, mode, initiator) } : {}),
            ...(deps.closeCards ? { closeCards: deps.closeCards } : {}),
            ...(deps.onceStore ? { store: deps.onceStore } : {}),
          },
          companyId,
          config,
          {
            dryRun: shadow,
            rule: "pause_all_cap",
            // A fallback run is marked in the audit row and the notice.
            reason: pauseReason({ ok: true, config, fallback: options.fallback ?? null }, `${decision.ruleId}: ${decision.reason}`),
            initiator: options.initiator,
            notify: true,
            note: `Kulutus ${decision.metrics.pctUsed} % kuukauden katosta (${decision.metrics.mtdEur} / ${decision.metrics.monthlyCapEur} €)`,
            metrics: { ruleId: decision.ruleId, mode: decision.mode, ...decision.metrics },
          },
        );
        if (!shadow && result.settled && result.halt) await rememberSettledCap(deps, companyId, config, result.halt, now);
        const error = result.errors.length > 0 ? `${result.errors.length} pause(s) failed (last error: ${result.errors.at(-1)!.error})` : null;
        outcome.decisions.push({ ...decision, applied: !shadow && result.count > 0, error });
        if (error) failures.push(`${config.brandCode} ${decision.ruleId}: ${error}`);
        if (result.retry?.error) failures.push(`${config.brandCode} ${decision.ruleId}: pause retry: ${result.retry.error}`);
        if (result.auditError) failures.push(`${config.brandCode} ${decision.ruleId}: rule_actions insert failed (${result.auditError})`);
        // The pause stands either way, but open activation cards or a missing halt must not go unnoticed (RK9-561).
        failures.push(...stopFailures(`${config.brandCode} ${decision.ruleId}`, result));
        if (result.telegram === "failed") failures.push(`${config.brandCode} ${decision.ruleId}: paused ${result.count} but the Telegram notice failed (${result.telegramError})`);
      } catch (error) {
        // pauseAll audited the failed listing itself; the halt and card close ran before it (RK9-561).
        outcome.decisions.push({ ...decision, applied: false, error: safeError(error) });
        failures.push(`${config.brandCode} ${decision.ruleId}: ${safeError(error)}`);
        if (error instanceof PauseListError) failures.push(...stopFailures(`${config.brandCode} ${decision.ruleId}`, error.stopped));
      }
      continue;
    }

    const applied: AppliedDecision = { ...decision, applied: false, error: null };
    if (decision.mode === "live") {
      try {
        liveClient ??= clientFor(deps, companyId, config, "live", options.initiator);
        const result = await setObjectStatus(liveClient, decision.objectId, "PAUSED");
        applied.applied = "success" in result && result.success === true;
        if (!applied.applied) applied.error = "Meta did not confirm the pause";
      } catch (error) {
        applied.error = safeError(error);
      }
      if (applied.applied) paused.push(applied);
      else failures.push(`${config.brandCode} ${decision.ruleId}: pause of ad ${decision.objectId} failed (${applied.error})`);
    }
    const auditFailure = await audit(deps, companyId, config, applied, options.initiator, now);
    if (auditFailure) failures.push(`${config.brandCode} ${decision.ruleId}: rule_actions insert failed for ${decision.objectType} ${decision.objectId} (${auditFailure})`);
    outcome.decisions.push(applied);
  }

  outcome.changed = paused.length;
  if (paused.length > 0) {
    try {
      outcome.telegram = await deps.notifier.sendMessage(companyId, config, liveNoticeText(config, paused, names, now));
    } catch (error) {
      outcome.telegram = "failed";
      failures.push(`${config.brandCode}: paused ${paused.length} ad(s) but the Telegram notice failed (${safeError(error)})`);
    }
  }
  return outcome;
}

function fallbackReportKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `rules-fallback-reported:${companyId}` };
}

/**
 * True when the run reports the brand's fallback as a failure. A disabled
 * config (monthlyCapEur cleared) is the operator's choice: it fails only the
 * first run of each local day, so it does not hide the other brands' real
 * failures every hour (RK9-541). An invalid or unavailable config is always
 * reported, and so is anything when the marker cannot be read or written.
 */
async function reportFallback(deps: RulesDeps, companyId: string, config: BrandConfig, state: "invalid" | "disabled" | "unavailable"): Promise<boolean> {
  if (state !== "disabled") return true;
  const key = fallbackReportKey(companyId);
  const mark = `${state}:${localDate(deps.now(), config.timeZone)}`;
  try {
    if ((await deps.ctx.state.get(key)) === mark) return false;
    await deps.ctx.state.set(key, mark);
  } catch (error) {
    deps.ctx.logger.warn("rk9-ads rules: fallback report marker failed", { companyId, error: safeError(error) });
  }
  return true;
}

export function createRulesJob(deps: RulesDeps) {
  return async (job: PluginJobContext): Promise<void> => {
    const { ctx } = deps;
    const failures: string[] = [];
    let brands = 0;
    for (const { companyId, result } of await listCompanyConfigs(ctx)) {
      if (result.state === "absent") continue;
      // README ADR 3, RK9-536: the cap rule is a pause, so a config that
      // cannot be read (invalid, unavailable) or was disabled by clearing
      // monthlyCapEur still runs it, on the last valid config.
      const loaded = await loadPauseConfig(ctx, companyId, result);
      if (!loaded.ok && loaded.neverEnabled) {
        // Saved disabled and never enabled (e.g. the AUR read-only config): nothing has spent.
        ctx.logger.info("rk9-ads rules: brand disabled and never enabled; skipped", { companyId });
        continue;
      }
      if (!loaded.ok) {
        failures.push(`company ${companyId}: ${loaded.error}; rules not evaluated`);
        continue;
      }
      let config = loaded.config;
      if (loaded.fallback) config = { ...config, rules: capOnlyRules(config) };
      brands += 1;
      let ran = false;
      try {
        const outcome = await runRulesForBrand(deps, companyId, config, { initiator: { source: "job", jobRunId: job.runId }, persist: true, fallback: loaded.fallback });
        failures.push(...outcome.failures);
        ran = true;
      } catch (error) {
        ctx.logger.warn("rk9-ads rules: brand failed", { companyId, error: safeError(error) });
        failures.push(`${config.brandCode}: ${safeError(error)}`);
      }
      // After the run, so the line says what happened (RK9-541).
      if (loaded.fallback) {
        const line = `${config.brandCode}: the brand config is ${loaded.fallback.state}; only pause_all_cap ${ran ? "ran" : "was to run"}, on the last valid config`;
        if (await reportFallback(deps, companyId, config, loaded.fallback.state)) failures.push(line);
        else ctx.logger.info(`rk9-ads rules: ${line} (reported today already)`, { companyId });
      }
    }
    ctx.logger.info("rk9-ads rules-evaluate done", { runId: job.runId, brands, failures: failures.length });
    if (failures.length > 0) throw new Error(`rules-evaluate: ${failures.join("; ")}`.slice(0, 2000));
  };
}
