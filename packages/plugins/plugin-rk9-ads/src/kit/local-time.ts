/**
 * Local-time helpers for jobs.
 *
 * The plugin job scheduler only understands UTC cron (server/src/services/cron.ts),
 * so every job runs on a UTC schedule and computes the operator's local time here.
 * Pure functions with an injectable `now`; no ads-specific imports (kit rule, G16).
 */

export const DEFAULT_TIME_ZONE = "Europe/Helsinki";

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  /** "+03:00" style offset of the zone at that instant. */
  offset: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "longOffset",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const rawOffset = pick("timeZoneName").replace("GMT", "");
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    offset: rawOffset === "" ? "+00:00" : rawOffset,
  };
}

/** Local calendar date, "YYYY-MM-DD". */
export function localDate(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Local calendar month, "YYYY-MM". */
export function localMonth(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad2(p.month)}`;
}

/** Local wall-clock time, "HH:MM". */
export function localTime(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Number of days in the local calendar month that contains `instant`. */
export function daysInLocalMonth(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const p = zonedParts(instant, timeZone);
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHhMm(value: string): boolean {
  return HH_MM.test(value);
}

/**
 * True when the local wall-clock time of `instant` is at or after `hhmm`.
 * Jobs that must fire "once per local day at HH:MM" run on a frequent UTC
 * cron, call this, and dedupe on `localDate()`.
 */
export function isLocalTimeAtOrAfter(instant: Date, hhmm: string, timeZone: string = DEFAULT_TIME_ZONE): boolean {
  const match = HH_MM.exec(hhmm);
  if (!match) throw new Error(`Invalid HH:MM time: ${hhmm}`);
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute >= Number(match[1]) * 60 + Number(match[2]);
}

export interface LocalMonthBounds {
  /** "YYYY-MM" */
  month: string;
  /** First local day of the month, "YYYY-MM-01". */
  since: string;
  /** The local date of `instant`, "YYYY-MM-DD". */
  until: string;
  daysInMonth: number;
  /** 1-31 */
  dayOfMonth: number;
  /** Local days left in the month, today included (1 on the last day). */
  remainingDays: number;
}

/**
 * The local calendar month that contains `instant`, for month-to-date reads
 * (an inclusive since/until range in local dates) and month-end projections.
 */
export function localMonthBounds(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): LocalMonthBounds {
  const p = zonedParts(instant, timeZone);
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  const month = `${p.year}-${pad2(p.month)}`;
  return {
    month,
    since: `${month}-01`,
    until: `${month}-${pad2(p.day)}`,
    daysInMonth,
    dayOfMonth: p.day,
    remainingDays: daysInMonth - p.day + 1,
  };
}
