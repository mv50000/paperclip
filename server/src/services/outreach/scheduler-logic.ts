// RK9-194: pure scheduler/sender logic (no DB, no network) — send-window and
// warm-up-ramp math, SMTP response classification, retry backoff, and jitter.
// Kept DB-free so it is unit-testable; `scheduler.ts` is the thin DB/IO glue.

export interface OutreachSendWindow {
  tz: string;
  /** ISO weekday numbers, 1 = Monday … 7 = Sunday. */
  days: number[];
  startHour: number;
  /** Exclusive. */
  endHour: number;
}

export interface OutreachRampStep {
  fromDay: number;
  dailyCap: number;
}

/** SMTP 4xx gets this many total send attempts before the message gives up. */
export const MAX_SEND_ATTEMPTS = 3;

/** Backoff between retries, indexed by `attempts` (1st failure → index 0). */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 120 * 60_000];

/**
 * Is `now` inside the sequence's configured send window, in its own tz?
 * `days` are ISO weekdays (1 = Monday … 7 = Sunday); `endHour` is exclusive.
 */
export function isWithinSendWindow(window: OutreachSendWindow, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.tz,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
  const isoWeekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayStr);
  // Intl gives 0=Sun..6=Sat; ISO weekday is 1=Mon..7=Sun.
  const iso = isoWeekday === 0 ? 7 : isoWeekday;
  if (!window.days.includes(iso)) return false;
  return hour >= window.startHour && hour < window.endHour;
}

/**
 * The cap in force right now, given the warm-up ramp and days elapsed since
 * `activatedAt`. Falls back to `dailyCap` when the sequence has never been
 * activated, has no ramp configured, or the ramp doesn't cover `now` yet
 * (all steps are still in the future — treated as "ramp not started").
 */
export function effectiveDailyCap(
  seq: { dailyCap: number; rampSchedule: OutreachRampStep[]; activatedAt: Date | null },
  now: Date,
): number {
  if (!seq.activatedAt || seq.rampSchedule.length === 0) return seq.dailyCap;
  const daysSinceActivation = Math.floor(
    (now.getTime() - seq.activatedAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  const applicable = seq.rampSchedule
    .filter((step) => step.fromDay <= daysSinceActivation)
    .sort((a, b) => b.fromDay - a.fromDay)[0];
  return applicable ? applicable.dailyCap : seq.dailyCap;
}

/** How many more messages this sender identity may send today, right now. */
export function remainingDailyCapacity(
  seq: { dailyCap: number; rampSchedule: OutreachRampStep[]; activatedAt: Date | null },
  now: Date,
  sentOrQueuedTodayForIdentity: number,
): number {
  return Math.max(0, effectiveDailyCap(seq, now) - sentOrQueuedTodayForIdentity);
}

export type SmtpOutcome = "ok" | "retry" | "bounce_hard";

/** 2xx → ok, 4xx → transient (retry), 5xx → hard failure (bounce + suppress). */
export function classifySmtpCode(code: number): SmtpOutcome {
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400 && code < 500) return "retry";
  return "bounce_hard";
}

/** Backoff delay before the next retry, given attempts-so-far (1-indexed). */
export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index];
}

/** Random jitter between messages so sends don't land in a burst. */
export function jitterMs(minMs = 30_000, maxMs = 180_000, rng: () => number = Math.random): number {
  return Math.floor(minMs + rng() * (maxMs - minMs));
}

/**
 * The [start, end) of "today" in `tz`, as actual UTC instants — used to scope
 * the daily-cap count to the sequence's own send-window day rather than the
 * server's local day. Accurate to the minute; a DST-transition day may be
 * 23 or 25 hours, which is fine for a send-cap window.
 */
export function zonedDayRange(tz: string, instant: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = wallClockAsUtc - instant.getTime();
  const dayStartWallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0);
  const start = new Date(dayStartWallClockAsUtc - offsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
