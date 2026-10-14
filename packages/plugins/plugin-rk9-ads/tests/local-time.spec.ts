import { describe, expect, it } from "vitest";
import {
  daysInLocalMonth,
  isLocalTimeAtOrAfter,
  localDate,
  localMonth,
  localTime,
  zonedParts,
} from "../src/kit/local-time.js";

describe("local time (UTC host, Europe/Helsinki jobs)", () => {
  it("crosses the spring DST boundary (29.3.2026, 03:00 EET -> 04:00 EEST)", () => {
    expect(localTime(new Date("2026-03-29T00:59:00Z"))).toBe("02:59");
    expect(zonedParts(new Date("2026-03-29T00:59:00Z")).offset).toBe("+02:00");
    expect(localTime(new Date("2026-03-29T01:00:00Z"))).toBe("04:00");
    expect(zonedParts(new Date("2026-03-29T01:00:00Z")).offset).toBe("+03:00");
  });

  it("crosses the autumn DST boundary (25.10.2026, 04:00 EEST -> 03:00 EET)", () => {
    expect(localTime(new Date("2026-10-25T00:59:00Z"))).toBe("03:59");
    expect(localTime(new Date("2026-10-25T01:00:00Z"))).toBe("03:00");
    expect(zonedParts(new Date("2026-10-25T01:00:00Z")).offset).toBe("+02:00");
  });

  it("moves the local date with the offset, not with UTC", () => {
    expect(localDate(new Date("2026-07-14T21:30:00Z"))).toBe("2026-07-15");
    expect(localDate(new Date("2026-01-14T21:30:00Z"))).toBe("2026-01-14");
    expect(localDate(new Date("2026-01-14T22:00:00Z"))).toBe("2026-01-15");
    expect(localMonth(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11");
  });

  it("gates a local HH:MM the same way in summer and winter", () => {
    // 21:30 local = 18:30Z in summer, 19:30Z in winter.
    expect(isLocalTimeAtOrAfter(new Date("2026-07-01T18:29:00Z"), "21:30")).toBe(false);
    expect(isLocalTimeAtOrAfter(new Date("2026-07-01T18:30:00Z"), "21:30")).toBe(true);
    expect(isLocalTimeAtOrAfter(new Date("2026-12-01T19:29:00Z"), "21:30")).toBe(false);
    expect(isLocalTimeAtOrAfter(new Date("2026-12-01T19:30:00Z"), "21:30")).toBe(true);
    expect(() => isLocalTimeAtOrAfter(new Date(), "25:00")).toThrow(/Invalid HH:MM/);
  });

  it("counts days of the local month", () => {
    expect(daysInLocalMonth(new Date("2026-02-28T22:30:00Z"))).toBe(31); // already 1.3. in Helsinki
    expect(daysInLocalMonth(new Date("2026-02-10T12:00:00Z"))).toBe(28);
    expect(daysInLocalMonth(new Date("2028-02-10T12:00:00Z"))).toBe(29);
    expect(daysInLocalMonth(new Date("2026-04-10T12:00:00Z"))).toBe(30);
  });
});
