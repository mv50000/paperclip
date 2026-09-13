import { describe, expect, it } from "vitest";
import {
  MAX_SEND_ATTEMPTS,
  classifySmtpCode,
  effectiveDailyCap,
  isWithinSendWindow,
  jitterMs,
  remainingDailyCapacity,
  retryDelayMs,
  zonedDayRange,
  type OutreachSendWindow,
} from "../services/outreach/scheduler-logic.js";

const HELSINKI_WINDOW: OutreachSendWindow = {
  tz: "Europe/Helsinki",
  days: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 16,
};

// 2026-01-13 is a Tuesday; Helsinki is UTC+2 (EET) in January, no DST.
const TUE_10_00_HELSINKI = new Date(Date.UTC(2026, 0, 13, 8, 0, 0));

describe("isWithinSendWindow", () => {
  it("is open on a weekday inside the hour range", () => {
    expect(isWithinSendWindow(HELSINKI_WINDOW, TUE_10_00_HELSINKI)).toBe(true);
  });

  it("is closed on a Saturday even at the same local hour", () => {
    const saturday = new Date(Date.UTC(2026, 0, 17, 8, 0, 0)); // 10:00 Helsinki, Saturday
    expect(isWithinSendWindow(HELSINKI_WINDOW, saturday)).toBe(false);
  });

  it("is closed before startHour", () => {
    const before = new Date(Date.UTC(2026, 0, 13, 4, 0, 0)); // 06:00 Helsinki
    expect(isWithinSendWindow(HELSINKI_WINDOW, before)).toBe(false);
  });

  it("endHour is exclusive", () => {
    const atEnd = new Date(Date.UTC(2026, 0, 13, 14, 0, 0)); // 16:00 Helsinki exactly
    const justBefore = new Date(Date.UTC(2026, 0, 13, 13, 59, 0)); // 15:59 Helsinki
    expect(isWithinSendWindow(HELSINKI_WINDOW, atEnd)).toBe(false);
    expect(isWithinSendWindow(HELSINKI_WINDOW, justBefore)).toBe(true);
  });
});

describe("effectiveDailyCap (warm-up ramp)", () => {
  const rampSchedule = [
    { fromDay: 0, dailyCap: 5 },
    { fromDay: 7, dailyCap: 10 },
    { fromDay: 14, dailyCap: 15 },
    { fromDay: 21, dailyCap: 20 },
  ];
  const activatedAt = new Date("2026-01-01T00:00:00Z");

  it("uses the week-1 cap right after activation", () => {
    const now = new Date("2026-01-04T00:00:00Z"); // day 3
    expect(effectiveDailyCap({ dailyCap: 20, rampSchedule, activatedAt }, now)).toBe(5);
  });

  it("steps up to week 2 and week 3 caps", () => {
    expect(
      effectiveDailyCap({ dailyCap: 20, rampSchedule, activatedAt }, new Date("2026-01-10T00:00:00Z")),
    ).toBe(10); // day 9
    expect(
      effectiveDailyCap({ dailyCap: 20, rampSchedule, activatedAt }, new Date("2026-01-20T00:00:00Z")),
    ).toBe(15); // day 19
  });

  it("reaches the steady-state cap once the ramp is past its last step", () => {
    const now = new Date("2026-03-01T00:00:00Z"); // well past day 21
    expect(effectiveDailyCap({ dailyCap: 20, rampSchedule, activatedAt }, now)).toBe(20);
  });

  it("falls back to dailyCap when there is no ramp configured", () => {
    const now = new Date("2026-01-04T00:00:00Z");
    expect(effectiveDailyCap({ dailyCap: 20, rampSchedule: [], activatedAt }, now)).toBe(20);
  });

  it("falls back to dailyCap when the sequence has never been activated", () => {
    const now = new Date("2026-01-04T00:00:00Z");
    expect(effectiveDailyCap({ dailyCap: 20, rampSchedule, activatedAt: null }, now)).toBe(20);
  });
});

describe("remainingDailyCapacity", () => {
  it("subtracts what's already gone out today, floored at zero", () => {
    const seq = { dailyCap: 5, rampSchedule: [], activatedAt: null };
    const now = new Date();
    expect(remainingDailyCapacity(seq, now, 2)).toBe(3);
    expect(remainingDailyCapacity(seq, now, 5)).toBe(0);
    expect(remainingDailyCapacity(seq, now, 9)).toBe(0);
  });
});

describe("classifySmtpCode", () => {
  it("classifies 2xx/4xx/5xx", () => {
    expect(classifySmtpCode(250)).toBe("ok");
    expect(classifySmtpCode(299)).toBe("ok");
    expect(classifySmtpCode(450)).toBe("retry");
    expect(classifySmtpCode(499)).toBe("retry");
    expect(classifySmtpCode(550)).toBe("bounce_hard");
    expect(classifySmtpCode(599)).toBe("bounce_hard");
  });
});

describe("retryDelayMs / MAX_SEND_ATTEMPTS", () => {
  it("backs off further with each attempt, capped at the last configured delay", () => {
    const d1 = retryDelayMs(1);
    const d2 = retryDelayMs(2);
    const d3 = retryDelayMs(3);
    expect(d1).toBeLessThan(d2);
    expect(d2).toBeLessThan(d3);
    expect(retryDelayMs(MAX_SEND_ATTEMPTS + 5)).toBe(d3); // clamps, doesn't grow forever
  });
});

describe("jitterMs", () => {
  it("stays within [min, max)", () => {
    expect(jitterMs(30_000, 180_000, () => 0)).toBe(30_000);
    expect(jitterMs(30_000, 180_000, () => 0.999999)).toBeLessThan(180_000);
    expect(jitterMs(30_000, 180_000, () => 0.5)).toBe(30_000 + 0.5 * 150_000);
  });
});

describe("zonedDayRange", () => {
  it("returns the [local midnight, +24h) instant range for the given tz", () => {
    const { start, end } = zonedDayRange("Europe/Helsinki", TUE_10_00_HELSINKI);
    expect(start.toISOString()).toBe(new Date(Date.UTC(2026, 0, 12, 22, 0, 0)).toISOString());
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    // The instant itself must fall inside the returned range.
    expect(TUE_10_00_HELSINKI.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(TUE_10_00_HELSINKI.getTime()).toBeLessThan(end.getTime());
  });
});
