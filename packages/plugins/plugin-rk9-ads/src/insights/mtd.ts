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
  /** The account-local month from kit/local-time localMonthBounds. */
  month: Pick<LocalMonthBounds, "until" | "dayOfMonth" | "daysInMonth">;
  mtdCents: number;
  completeDaysCents: number;
  monthlyCapEur: number;
}): Pacing {
  const completeDays = input.month.dayOfMonth - 1;
  const daysInMonth = input.month.daysInMonth;
  const monthlyCapCents = Math.round(input.monthlyCapEur * 100);
  const projectedCents = completeDays > 0 ? Math.round((input.completeDaysCents / completeDays) * daysInMonth) : null;
  return {
    today: input.month.until,
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
  const month = localMonthBounds(input.now, input.accountTimeZone);
  const mtdCents = await store.spendCents(companyId, month.since, month.until);
  const yesterday = addDays(month.until, -1);
  const completeDaysCents = yesterday >= month.since ? await store.spendCents(companyId, month.since, yesterday) : 0;
  return computePacing({ month, mtdCents, completeDaysCents, monthlyCapEur: input.monthlyCapEur });
}
