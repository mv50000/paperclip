/**
 * Rule evaluation (A11, RK9-515). Pure: no I/O and no clock (`now` is an
 * argument), so the same input always gives the same decisions.
 *
 * Days are calendar days of the brand's time zone (Europe/Helsinki by
 * default). Threshold rules read completed days only: the window of a rule
 * with `days: N` is the N local dates ending yesterday. Date arithmetic is on
 * YYYY-MM-DD strings, so a 23- or 25-hour DST day is still one day. The
 * runner reads the days only after insights-daily-close has finalised
 * yesterday.
 *
 * - `aggregate: "each_day"`: every day of the window must break the
 *   threshold. A missing day breaks the streak, and so does a day whose
 *   metric cannot be computed (CTR or CPM without impressions, CPC without
 *   spend or clicks).
 * - `aggregate: "window_total"`: the metric is computed once from the
 *   window's summed spend, impressions and link clicks (RK9-536). A missing
 *   day is a day without delivery and adds nothing.
 *
 * Spend without a link click is an infinite CPC: it breaks a CPC threshold
 * from above, never from below.
 *
 * Minimum-data gates: a threshold rule fires only when the window's total
 * impressions are at least `minImpressions`, its total link clicks at least
 * `minClicks` and its total spend at least `minSpendEur` (equal fires). This
 * keeps the learning phase safe. A spend gate instead of a click gate lets a
 * CPC ceiling catch the expensive ads too: an ad that spent `minSpendEur`
 * with fewer than spend / threshold link clicks is above the ceiling.
 *
 * Only objects whose configured status is ACTIVE get a decision: a paused ad
 * needs no pause. An ad that is not in the status listing is skipped too.
 *
 * Cooldown: a rule does not decide on the same object again while an earlier
 * decision of the same rule and object is younger than `cooldownHours`. Shadow
 * decisions count against shadow ones, so a shadow hit is recorded at most
 * once per window instead of every hour. Live decisions count only against
 * live pauses that were applied without an error: a failed pause, or a
 * pause_all that left some object unpaused (RK9-536), is retried on the next
 * run, and switching a rule to live is not delayed by its shadow history.
 *
 * Metrics follow G18 (../../metrics/cpc.ts): link CPC and link CTR.
 */

import { addDays } from "../../insights/mtd.js";
import type { FatigueStatus } from "../../insights/fatigue.js";
import { localDate } from "../../kit/local-time.js";
import { cpm as cpmOf, linkCpc, linkCtr } from "../../metrics/cpc.js";
import { BUILTIN_PAUSE_ALL_CAP_PCT, isLive, type RuleMetric, type RuleMode, type RuleOperator, type RuleSet, type RuleType, type ThresholdPauseRule } from "./schema.js";

/** One ad-day from insights_daily. Money in cents. */
export interface RuleAdDay {
  adId: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  spendCents: number;
  impressions: number;
  inlineLinkClicks: number;
  /** Meta's daily frequency; null when unknown. */
  frequency: number | null;
}

/** An earlier rule_actions row of a rule on an object. */
export interface PriorRuleAction {
  ruleId: string;
  objectId: string;
  mode: RuleMode;
  /** True for a live write that changed the object and recorded no error. */
  applied: boolean;
  /** ISO instant. */
  decidedAt: string;
}

export interface RuleSnapshots {
  /** The brand's time zone for local dates. */
  timeZone: string;
  days: readonly RuleAdDay[];
  /** validUntil (ISO instant) of each published ad's creative. */
  creatives: ReadonlyArray<{ adId: string; validUntil: string }>;
  /** A10's fatigue result per ad; empty when fatigue is off for the brand. */
  fatigue: ReadonlyArray<{ adId: string; status: FatigueStatus; signals: readonly string[] }>;
  /** Month-to-date position from the spend guard; null when it could not be read (no cap decision). */
  spend: { month: string; mtdEur: number; monthlyCapEur: number; pctUsed: number } | null;
  priorActions: readonly PriorRuleAction[];
}

/** Live status of the brand's objects (configured status). */
export interface RuleStatus {
  adAccountId: string;
  ads: ReadonlyArray<{ id: string; name?: string; status: string }>;
  campaigns: ReadonlyArray<{ id: string; name?: string; status: string }>;
}

export type RuleObjectType = "account" | "ad";
export type RuleAction = "pause" | "pause_all";

export interface RuleDecision {
  ruleId: string;
  ruleType: RuleType;
  objectType: RuleObjectType;
  objectId: string;
  action: RuleAction;
  /** "live" only when the rule and the brand are both live. */
  mode: RuleMode;
  metrics: Record<string, unknown>;
  reason: string;
}

const OPERATOR_TEXT: Record<RuleOperator, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

export function compare(value: number, operator: RuleOperator, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

interface Totals {
  spendCents: number;
  impressions: number;
  inlineLinkClicks: number;
}

/** The metric of a set of days; null when it cannot be computed. */
export function metricValue(metric: RuleMetric, totals: Totals, frequency: number | null = null): number | null {
  switch (metric) {
    case "cpc":
      // Spend without a single link click is the worst CPC there is.
      if (totals.inlineLinkClicks === 0 && totals.spendCents > 0) return Number.POSITIVE_INFINITY;
      return linkCpc(totals.spendCents, totals.inlineLinkClicks);
    case "ctr":
      return linkCtr(totals.inlineLinkClicks, totals.impressions);
    case "cpm":
      return cpmOf(totals.spendCents, totals.impressions);
    case "frequency":
      return frequency;
    case "spend":
      return totals.spendCents / 100;
  }
}

function round(value: number | null, places: number): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sumTotals(days: readonly RuleAdDay[]): Totals {
  return days.reduce(
    (total, day) => ({
      spendCents: total.spendCents + day.spendCents,
      impressions: total.impressions + day.impressions,
      inlineLinkClicks: total.inlineLinkClicks + day.inlineLinkClicks,
    }),
    { spendCents: 0, impressions: 0, inlineLinkClicks: 0 },
  );
}

/** The figures every decision reports: spend, clicks, impressions, CPC, CTR, days. */
function windowMetrics(totals: Totals, window: { from: string; to: string; days: number }): Record<string, unknown> {
  return {
    spendEur: totals.spendCents / 100,
    clicks: totals.inlineLinkClicks,
    impressions: totals.impressions,
    cpc: round(linkCpc(totals.spendCents, totals.inlineLinkClicks), 4),
    ctr: round(linkCtr(totals.inlineLinkClicks, totals.impressions), 4),
    days: window.days,
    from: window.from,
    to: window.to,
  };
}

/** True while an earlier decision of this rule on this object blocks a new one. */
export function inCooldown(
  prior: readonly PriorRuleAction[],
  rule: { ruleId: string; cooldownHours: number },
  objectId: string,
  mode: RuleMode,
  now: Date,
): boolean {
  const windowMs = rule.cooldownHours * 3_600_000;
  return prior.some((action) => {
    if (action.ruleId !== rule.ruleId || action.objectId !== objectId || action.mode !== mode) return false;
    if (mode === "live" && !action.applied) return false;
    const age = now.getTime() - Date.parse(action.decidedAt);
    return Number.isFinite(age) && age < windowMs;
  });
}

function groupDays(days: readonly RuleAdDay[]): Map<string, Map<string, RuleAdDay>> {
  const out = new Map<string, Map<string, RuleAdDay>>();
  for (const day of days) {
    const byDate = out.get(day.adId) ?? new Map<string, RuleAdDay>();
    byDate.set(day.date, day);
    out.set(day.adId, byDate);
  }
  return out;
}

function passesGates(rule: ThresholdPauseRule, totals: Totals): boolean {
  return (
    totals.impressions >= rule.minImpressions &&
    totals.inlineLinkClicks >= rule.minClicks &&
    totals.spendCents >= Math.round(rule.minSpendEur * 100)
  );
}

function shownValue(value: number): number | string {
  return Number.isFinite(value) ? (round(value, 2) as number) : "no link clicks";
}

function thresholdDecision(
  rule: ThresholdPauseRule,
  adId: string,
  byDate: Map<string, RuleAdDay> | undefined,
  yesterday: string,
): { metrics: Record<string, unknown>; reason: string } | null {
  if (!byDate) return null;
  const from = addDays(yesterday, -(rule.days - 1));
  if (rule.aggregate === "window_total") {
    const window: RuleAdDay[] = [];
    for (let offset = rule.days - 1; offset >= 0; offset -= 1) {
      const day = byDate.get(addDays(yesterday, -offset));
      if (day) window.push(day); // a missing day had no delivery
    }
    if (window.length === 0) return null;
    const totals = sumTotals(window);
    const value = metricValue(rule.metric, totals);
    if (value === null || !compare(value, rule.operator, rule.threshold) || !passesGates(rule, totals)) return null;
    return {
      metrics: {
        ...windowMetrics(totals, { from, to: yesterday, days: rule.days }),
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        aggregate: rule.aggregate,
        windowValue: Number.isFinite(value) ? round(value, 4) : null,
        daysWithData: window.length,
      },
      reason: `${rule.metric} ${OPERATOR_TEXT[rule.operator]} ${rule.threshold} over the ${rule.days}-day window ${from}..${yesterday} (total ${shownValue(value)}); ${(totals.spendCents / 100).toFixed(2)} EUR spend, ${totals.impressions} impressions, ${totals.inlineLinkClicks} link clicks`,
    };
  }

  const window: RuleAdDay[] = [];
  const values: number[] = [];
  for (let offset = rule.days - 1; offset >= 0; offset -= 1) {
    const day = byDate.get(addDays(yesterday, -offset));
    if (!day) return null; // a missing day breaks the streak
    const value = metricValue(rule.metric, day, day.frequency);
    if (value === null || !compare(value, rule.operator, rule.threshold)) return null;
    window.push(day);
    values.push(value);
  }
  const totals = sumTotals(window);
  if (!passesGates(rule, totals)) return null;
  const metrics = {
    ...windowMetrics(totals, { from, to: yesterday, days: rule.days }),
    metric: rule.metric,
    operator: rule.operator,
    threshold: rule.threshold,
    dailyValues: values.map((value) => (Number.isFinite(value) ? round(value, 4) : null)),
  };
  return {
    metrics,
    reason: `${rule.metric} ${OPERATOR_TEXT[rule.operator]} ${rule.threshold} on ${rule.days} consecutive day(s) ${from}..${yesterday} (${values.map(shownValue).join(", ")}); ${totals.impressions} impressions, ${totals.inlineLinkClicks} link clicks`,
  };
}

/**
 * Decides which rules act on which objects. Each rule gives at most one
 * decision per object. The order is the rule list order, then the status
 * listing order.
 */
export function evaluateRules(snapshots: RuleSnapshots, status: RuleStatus, rules: RuleSet, now: Date): RuleDecision[] {
  const decisions: RuleDecision[] = [];
  const today = localDate(now, snapshots.timeZone);
  const yesterday = addDays(today, -1);
  const activeAds = status.ads.filter((ad) => ad.status === "ACTIVE");
  const daysByAd = groupDays(snapshots.days);

  for (const rule of rules.list) {
    // propose_scale is always disabled (G9), so it never gets past this line.
    if (!rule.enabled) continue;
    const mode: RuleMode = isLive(rule, rules.liveMode) ? "live" : "shadow";
    const push = (objectType: RuleObjectType, objectId: string, action: RuleAction, metrics: Record<string, unknown>, reason: string) => {
      if (inCooldown(snapshots.priorActions, rule, objectId, mode, now)) return;
      decisions.push({ ruleId: rule.ruleId, ruleType: rule.type, objectType, objectId, action, mode, metrics, reason });
    };

    switch (rule.type) {
      case "threshold_pause":
        for (const ad of activeAds) {
          const hit = thresholdDecision(rule, ad.id, daysByAd.get(ad.id), yesterday);
          if (hit) push("ad", ad.id, "pause", hit.metrics, hit.reason);
        }
        break;

      case "pause_all_cap": {
        const spend = snapshots.spend;
        if (!spend || spend.pctUsed < BUILTIN_PAUSE_ALL_CAP_PCT) break;
        const anythingActive = activeAds.length > 0 || status.campaigns.some((campaign) => campaign.status === "ACTIVE");
        if (!anythingActive) break;
        push(
          "account",
          status.adAccountId,
          "pause_all",
          { month: spend.month, mtdEur: spend.mtdEur, monthlyCapEur: spend.monthlyCapEur, pctUsed: spend.pctUsed, capPct: BUILTIN_PAUSE_ALL_CAP_PCT },
          `month-to-date spend ${spend.mtdEur} EUR is ${spend.pctUsed} % of the ${spend.monthlyCapEur} EUR cap (>= ${BUILTIN_PAUSE_ALL_CAP_PCT} %)`,
        );
        break;
      }

      case "pause_valid_until": {
        const validUntil = new Map(snapshots.creatives.map((creative) => [creative.adId, creative.validUntil]));
        for (const ad of activeAds) {
          const until = validUntil.get(ad.id);
          if (until === undefined) continue;
          const untilMs = Date.parse(until);
          if (!Number.isFinite(untilMs) || untilMs >= now.getTime()) continue;
          push("ad", ad.id, "pause", { validUntil: new Date(untilMs).toISOString() }, `creative validUntil ${new Date(untilMs).toISOString()} has passed`);
        }
        break;
      }

      case "pause_fatigued": {
        const fatigue = new Map(snapshots.fatigue.map((entry) => [entry.adId, entry]));
        for (const ad of activeAds) {
          const entry = fatigue.get(ad.id);
          if (!entry || entry.status !== "fatigued") continue;
          push("ad", ad.id, "pause", { fatigue: entry.status, signals: [...entry.signals] }, `creative fatigued (${entry.signals.join(", ")})`);
        }
        break;
      }
    }
  }
  return decisions;
}
