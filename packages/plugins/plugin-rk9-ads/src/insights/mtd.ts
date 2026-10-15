/**
 * Month-to-date spend and pacing (A10, RK9-512).
 *
 * Insights dates are calendar days of the ad account time zone
 * (`timezone_name`, read from the account, never hardcoded), so the month is
 * that zone's month too. Ads Manager uses the same days, which is why MTD here
 * matches its "this month" figure. Graph `amount_spent` is not a calendar
 * month figure and is used only for the spend_cap headroom (G2).
 *
 * Follow-up: the spend guard (A6, RK9-511) computes its own MTD; joining the
 * two computations is a separate issue.
 */

import { localDate } from "../kit/local-time.js";
import type { InsightsStore } from "./store.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function format(utc: Date): string {
  return utc.toISOString().slice(0, 10);
}

/** Calendar arithmetic on a YYYY-MM-DD date (no time zone involved). */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parse(date);
  return format(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Inclusive list of dates from `since` to `until`. */
export function dateRange(since: string, until: string): string[] {
  const out: string[] = [];
  for (let date = since; date <= until && out.length < 400; date = addDays(date, 1)) out.push(date);
  return out;
}

export function monthStartOf(date: string): string {
  const { y, m } = parse(date);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

export function daysInMonthOf(date: string): number {
  const { y, m } = parse(date);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
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
  /** Projected month-end spend from the complete days; null on the 1st. */
  projectedCents: number | null;
  /** True when MTD or the projection is above the monthly cap. */
  overCap: boolean;
}

/**
 * Pure pacing math. The projection uses complete days only, so a morning
 * digest does not divide a few hours of today's spend by a whole day.
 */
export function computePacing(input: {
  today: string;
  mtdCents: number;
  completeDaysCents: number;
  monthlyCapEur: number;
}): Pacing {
  const completeDays = parse(input.today).d - 1;
  const daysInMonth = daysInMonthOf(input.today);
  const monthlyCapCents = Math.round(input.monthlyCapEur * 100);
  const projectedCents = completeDays > 0 ? Math.round((input.completeDaysCents / completeDays) * daysInMonth) : null;
  return {
    today: input.today,
    mtdCents: input.mtdCents,
    completeDays,
    daysInMonth,
    monthlyCapCents,
    projectedCents,
    overCap: input.mtdCents > monthlyCapCents || (projectedCents !== null && projectedCents > monthlyCapCents),
  };
}

/** MTD and pacing for one company from insights_daily, in the account time zone. */
export async function monthToDate(
  store: InsightsStore,
  companyId: string,
  input: { now: Date; accountTimeZone: string; monthlyCapEur: number },
): Promise<Pacing> {
  const today = localDate(input.now, input.accountTimeZone);
  const start = monthStartOf(today);
  const mtdCents = await store.spendCents(companyId, start, today);
  const yesterday = addDays(today, -1);
  const completeDaysCents = yesterday >= start ? await store.spendCents(companyId, start, yesterday) : 0;
  return computePacing({ today, mtdCents, completeDaysCents, monthlyCapEur: input.monthlyCapEur });
}
