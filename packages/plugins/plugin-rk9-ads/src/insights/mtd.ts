/**
 * Month-to-date spend and pacing (A10, RK9-512; RK9-526).
 *
 * The digest's canonical MTD is the spend guard's Graph read: the digest
 * takes it from a guard snapshot (features/spend-guard/position.ts), so the
 * digest and the guard show the same MTD, headroom and remaining cap.
 * insights_daily MTD (this module) cross-checks it and is the labelled
 * fallback when the guard cannot read Meta.
 *
 * Insights dates are calendar days of the ad account time zone
 * (`timezone_name`, read from the account, never hardcoded), so the month is
 * that zone's month too. Ads Manager uses the same days, which is why MTD here
 * matches its "this month" figure. Graph `amount_spent` is not a calendar
 * month figure and is used only for the spend_cap headroom (G2).
 */

import { monthPosition } from "../features/spend-guard/position.js";
import { localMonthBounds, type LocalMonthBounds } from "../kit/local-time.js";
import type { InsightsStore } from "./store.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar arithmetic on a YYYY-MM-DD date (no time zone involved). */
export function addDays(date: string, days: number): string {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)).toISOString().slice(0, 10);
}

export interface Pacing {
  /** Account-zone date the figures run to (today). */
  today: string;
  /** Spend from the 1st through today, cents. */
  mtdCents: number;
  /** Complete days of the month so far (yesterday is the last one). */
  completeDays: number;
  daysInMonth: number;
  monthlyCapCents: number;
  /** Monthly cap - MTD, cents (negative when MTD is over the cap). */
  remainingCents: number;
  /** MTD as a share of the cap, one decimal, floored (as the guard's pctUsed). */
  pctUsed: number | null;
  /** Projected month-end spend, cents; null when there is none (run rate on the 1st). */
  projectedCents: number | null;
  /**
   * Where MTD and the projection come from: "spend_guard" = the guard's Graph
   * read and its budget projection (canonical); "insights" = insights_daily
   * and the run rate of the complete days (fallback).
   */
  source: "spend_guard" | "insights";
  /** True when MTD or the projection is above the monthly cap. */
  overCap: boolean;
}

/**
 * Pure pacing math. The projection uses complete days only, so a morning
 * digest does not divide a few hours of today's spend by a whole day.
 */
export function computePacing(input: {
  /** The account-local month from kit/local-time localMonthBounds. */
  month: Pick<LocalMonthBounds, "until" | "dayOfMonth" | "daysInMonth">;
  mtdCents: number;
  completeDaysCents: number;
  monthlyCapEur: number;
}): Pacing {
  const completeDays = input.month.dayOfMonth - 1;
  const projectedCents = completeDays > 0 ? Math.round((input.completeDaysCents / completeDays) * input.month.daysInMonth) : null;
  return pacingOf({ month: input.month, mtdCents: input.mtdCents, monthlyCapEur: input.monthlyCapEur, projectedCents, source: "insights" });
}

/** Pacing from an MTD and a projection already decided (the guard's, or the run rate). */
export function pacingOf(input: {
  month: Pick<LocalMonthBounds, "until" | "dayOfMonth" | "daysInMonth">;
  mtdCents: number;
  monthlyCapEur: number;
  projectedCents: number | null;
  source: Pacing["source"];
}): Pacing {
  // The position math is the guard's (RK9-526); spend_cap does not matter here.
  const position = monthPosition({ monthlyCapEur: input.monthlyCapEur, mtdCents: input.mtdCents, spendCapCents: null, amountSpentCents: 0 });
  const projectedCents = input.projectedCents;
  return {
    today: input.month.until,
    mtdCents: input.mtdCents,
    completeDays: input.month.dayOfMonth - 1,
    daysInMonth: input.month.daysInMonth,
    monthlyCapCents: position.capCents,
    remainingCents: position.remainingCents,
    pctUsed: position.pctUsed,
    projectedCents,
    source: input.source,
    overCap: input.mtdCents > position.capCents || (projectedCents !== null && projectedCents > position.capCents),
  };
}

/** MTD and pacing for one company from insights_daily, in the account time zone. */
export async function monthToDate(
  store: InsightsStore,
  companyId: string,
  input: { now: Date; accountTimeZone: string; monthlyCapEur: number },
): Promise<Pacing> {
  const month = localMonthBounds(input.now, input.accountTimeZone);
  const mtdCents = await store.spendCents(companyId, month.since, month.until);
  const yesterday = addDays(month.until, -1);
  const completeDaysCents = yesterday >= month.since ? await store.spendCents(companyId, month.since, yesterday) : 0;
  return computePacing({ month, mtdCents, completeDaysCents, monthlyCapEur: input.monthlyCapEur });
}
