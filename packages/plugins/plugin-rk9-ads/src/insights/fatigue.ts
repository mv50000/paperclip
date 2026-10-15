/**
 * Creative fatigue (A10, RK9-512). Pure: no I/O and no clock; `asOf` is
 * injected. Fatigue never pauses or changes an ad. It feeds the digest
 * ("🔁 väsynyt") and, behind a flag, one Paperclip issue per ad.
 *
 * Signals:
 * - frequency: impressions-weighted daily frequency over the recent window
 *   above `maxFrequency`. Daily reach is not additive, so a lifetime
 *   frequency cannot be derived from daily rows.
 * - ctr_decay: recent link CTR at least `ctrDropPct` % below the ad's own
 *   baseline. The baseline is the first `baselineDays` days of delivery,
 *   extended day by day (up to `baselineMaxDays`) until it reaches
 *   `baselineMinImpressions`. It is derived from insights_daily every run,
 *   so it stays the same while those rows exist.
 * - cpc_rise / cpm_rise: recent link CPC or CPM at least the given % above
 *   the baseline.
 * - age: days since the first delivery day at least `maxAgeDays`.
 *
 * Status: below `minImpressions` in total → insufficient-data. Two or more
 * signals → fatigued. One signal → watch. None → ok. At 100 EUR/month the
 * samples are small, so one noisy signal alone never says "fatigued".
 */

import { cpm as cpmOf, linkCpc, linkCtr } from "../metrics/cpc.js";

export type FatigueStatus = "ok" | "watch" | "fatigued" | "insufficient-data";

export interface FatigueDay {
  /** YYYY-MM-DD */
  date: string;
  impressions: number;
  inlineLinkClicks: number;
  spendCents: number;
  /** Meta's daily frequency (impressions / reach); null when unknown. */
  frequency: number | null;
}

export interface FatigueThresholds {
  /** Total impressions below which the result is insufficient-data. */
  minImpressions: number;
  maxFrequency: number;
  /** Relative CTR drop against the baseline, percent. */
  ctrDropPct: number;
  cpcRisePct: number;
  cpmRisePct: number;
  maxAgeDays: number;
  baselineDays: number;
  baselineMaxDays: number;
  baselineMinImpressions: number;
  /** Days that form the recent window, ending at asOf. */
  recentDays: number;
  recentMinImpressions: number;
}

/** Defaults; documented in the README. minImpressions, maxFrequency and ctrDropPct come from brand config `fatigue`. */
export const DEFAULT_FATIGUE_THRESHOLDS: Readonly<FatigueThresholds> = Object.freeze({
  minImpressions: 1000,
  maxFrequency: 3.5,
  ctrDropPct: 30,
  cpcRisePct: 40,
  cpmRisePct: 40,
  maxAgeDays: 28,
  baselineDays: 3,
  baselineMaxDays: 7,
  baselineMinImpressions: 300,
  recentDays: 3,
  recentMinImpressions: 300,
});

export type FatigueSignal = "frequency" | "ctr_decay" | "cpc_rise" | "cpm_rise" | "age";

export interface FatigueResult {
  status: FatigueStatus;
  /** "<code>: <detail>" per finding, signals first. */
  reasons: string[];
  signals: FatigueSignal[];
  metrics: {
    totalImpressions: number;
    ageDays: number | null;
    baseline: { from: string; to: string; impressions: number; ctr: number | null; cpc: number | null; cpm: number | null } | null;
    recent: { from: string; to: string; impressions: number; ctr: number | null; cpc: number | null; cpm: number | null; frequency: number | null } | null;
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(date: string): number {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sum(days: readonly FatigueDay[], pick: (day: FatigueDay) => number): number {
  return days.reduce((total, day) => total + pick(day), 0);
}

function rates(days: readonly FatigueDay[]) {
  const impressions = sum(days, (d) => d.impressions);
  const clicks = sum(days, (d) => d.inlineLinkClicks);
  const spend = sum(days, (d) => d.spendCents);
  return { impressions, ctr: linkCtr(clicks, impressions), cpc: linkCpc(spend, clicks), cpm: cpmOf(spend, impressions) };
}

function pctChange(recent: number, baseline: number): number {
  return ((recent - baseline) / baseline) * 100;
}

export function computeFatigue(
  series: readonly FatigueDay[],
  thresholds: Partial<FatigueThresholds> = {},
  asOf: string,
): FatigueResult {
  const t: FatigueThresholds = { ...DEFAULT_FATIGUE_THRESHOLDS, ...thresholds };
  const asOfDay = dayNumber(asOf);
  const days = series
    .filter((day) => dayNumber(day.date) <= asOfDay)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const delivering = days.filter((day) => day.impressions > 0);
  const totalImpressions = sum(delivering, (d) => d.impressions);

  const empty: FatigueResult["metrics"] = { totalImpressions, ageDays: null, baseline: null, recent: null };
  if (delivering.length === 0 || totalImpressions < t.minImpressions) {
    return {
      status: "insufficient-data",
      reasons: [`min_impressions: ${totalImpressions} < ${t.minImpressions}`],
      signals: [],
      metrics: empty,
    };
  }

  const firstDay = dayNumber(delivering[0]!.date);
  const ageDays = asOfDay - firstDay + 1;
  const recentFrom = asOfDay - t.recentDays + 1;

  // Baseline: the first baselineDays of delivery, extended until it has enough impressions.
  let baselineEnd = firstDay + t.baselineDays - 1;
  const inWindow = (end: number) => delivering.filter((d) => dayNumber(d.date) <= end);
  while (sum(inWindow(baselineEnd), (d) => d.impressions) < t.baselineMinImpressions && baselineEnd < firstDay + t.baselineMaxDays - 1) {
    baselineEnd += 1;
  }
  const baselineDays = inWindow(baselineEnd);
  const baselineRates = rates(baselineDays);
  const baselineUsable = baselineRates.impressions >= t.baselineMinImpressions && baselineEnd < recentFrom;

  const recentDays = delivering.filter((d) => dayNumber(d.date) >= recentFrom);
  const recentRates = rates(recentDays);
  const freqWeight = sum(recentDays.filter((d) => d.frequency !== null), (d) => d.impressions);
  const recentFrequency =
    freqWeight > 0 ? sum(recentDays, (d) => (d.frequency !== null ? d.frequency * d.impressions : 0)) / freqWeight : null;
  const recentUsable = recentRates.impressions >= t.recentMinImpressions;

  const signals: FatigueSignal[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];

  if (recentFrequency !== null && recentUsable && recentFrequency > t.maxFrequency) {
    signals.push("frequency");
    reasons.push(`frequency: ${round(recentFrequency)} > ${t.maxFrequency}`);
  }
  if (baselineUsable && recentUsable) {
    if (baselineRates.ctr !== null && baselineRates.ctr > 0 && recentRates.ctr !== null) {
      const drop = -pctChange(recentRates.ctr, baselineRates.ctr);
      if (drop >= t.ctrDropPct) {
        signals.push("ctr_decay");
        reasons.push(`ctr_decay: CTR ${round(recentRates.ctr)} % vs baseline ${round(baselineRates.ctr)} % (-${round(drop, 0)} %)`);
      }
    }
    if (baselineRates.cpc !== null && recentRates.cpc !== null) {
      const rise = pctChange(recentRates.cpc, baselineRates.cpc);
      if (rise >= t.cpcRisePct) {
        signals.push("cpc_rise");
        reasons.push(`cpc_rise: CPC ${round(recentRates.cpc)} vs baseline ${round(baselineRates.cpc)} (+${round(rise, 0)} %)`);
      }
    }
    if (baselineRates.cpm !== null && baselineRates.cpm > 0 && recentRates.cpm !== null) {
      const rise = pctChange(recentRates.cpm, baselineRates.cpm);
      if (rise >= t.cpmRisePct) {
        signals.push("cpm_rise");
        reasons.push(`cpm_rise: CPM ${round(recentRates.cpm)} vs baseline ${round(baselineRates.cpm)} (+${round(rise, 0)} %)`);
      }
    }
  } else if (!baselineUsable) {
    notes.push("no_baseline: baseline not yet available or overlaps the recent window");
  } else {
    notes.push(`low_recent_impressions: ${recentRates.impressions} < ${t.recentMinImpressions}`);
  }
  if (ageDays >= t.maxAgeDays) {
    signals.push("age");
    reasons.push(`age: ${ageDays} d >= ${t.maxAgeDays} d`);
  }

  const status: FatigueStatus = signals.length >= 2 ? "fatigued" : signals.length === 1 ? "watch" : "ok";
  const dateOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
  return {
    status,
    reasons: [...reasons, ...notes],
    signals,
    metrics: {
      totalImpressions,
      ageDays,
      baseline: baselineUsable
        ? {
            from: dateOf(firstDay),
            to: dateOf(baselineEnd),
            impressions: baselineRates.impressions,
            ctr: baselineRates.ctr,
            cpc: baselineRates.cpc,
            cpm: baselineRates.cpm,
          }
        : null,
      recent: {
        from: dateOf(recentFrom),
        to: asOf,
        impressions: recentRates.impressions,
        ctr: recentRates.ctr,
        cpc: recentRates.cpc,
        cpm: recentRates.cpm,
        frequency: recentFrequency,
      },
    },
  };
}

/** Thresholds for a brand: config `fatigue` values over the defaults. */
export function fatigueThresholdsFor(config: { minImpressions: number; maxFrequency: number; ctrDropPct: number }): FatigueThresholds {
  return {
    ...DEFAULT_FATIGUE_THRESHOLDS,
    minImpressions: config.minImpressions,
    maxFrequency: config.maxFrequency,
    ctrDropPct: config.ctrDropPct,
  };
}
