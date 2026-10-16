import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FATIGUE } from "../src/config.js";
import { computeFatigue, DEFAULT_FATIGUE_THRESHOLDS, fatigueThresholdsFor, type FatigueDay } from "../src/insights/fatigue.js";
import { addDays } from "../src/insights/mtd.js";

const START = "2026-10-01";

/** `n` days from START with the same daily figures. */
function days(n: number, figures: Omit<FatigueDay, "date">, from = START): FatigueDay[] {
  return Array.from({ length: n }, (_, index) => ({ date: addDays(from, index), ...figures }));
}

const STABLE = { impressions: 300, inlineLinkClicks: 6, spendCents: 300, frequency: 1.2 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeFatigue", () => {
  it("returns ok for a stable series", () => {
    const series = days(10, STABLE);
    const result = computeFatigue(series, {}, addDays(START, 9));
    expect(result.status).toBe("ok");
    expect(result.signals).toEqual([]);
    expect(result.metrics.baseline).toMatchObject({ from: "2026-10-01", to: "2026-10-03", impressions: 900 });
    expect(result.metrics.recent).toMatchObject({ from: "2026-10-08", to: "2026-10-10", impressions: 900 });
  });

  it("returns fatigued for a decaying series, with reasons", () => {
    const series = [
      ...days(3, { impressions: 400, inlineLinkClicks: 10, spendCents: 400, frequency: 1.1 }),
      ...days(4, { impressions: 400, inlineLinkClicks: 7, spendCents: 400, frequency: 2.5 }, addDays(START, 3)),
      ...days(3, { impressions: 400, inlineLinkClicks: 4, spendCents: 400, frequency: 3.8 }, addDays(START, 7)),
    ];
    const result = computeFatigue(series, {}, addDays(START, 9));
    expect(result.status).toBe("fatigued");
    expect(result.signals).toEqual(["frequency", "ctr_decay", "cpc_rise"]);
    expect(result.reasons).toEqual([
      "frequency: 3.8 > 2",
      "ctr_decay: CTR 1 % vs baseline 2.5 % (-60 %)",
      "cpc_rise: CPC 1 vs baseline 0.4 (+150 %)",
    ]);
  });

  it("returns watch for a single signal", () => {
    const series = days(10, { ...STABLE, frequency: 4 });
    const result = computeFatigue(series, {}, addDays(START, 9));
    expect(result.status).toBe("watch");
    expect(result.signals).toEqual(["frequency"]);
  });

  it("returns insufficient-data below minImpressions", () => {
    const series = days(5, { impressions: 100, inlineLinkClicks: 0, spendCents: 200, frequency: 5 });
    const result = computeFatigue(series, {}, addDays(START, 4));
    expect(result).toMatchObject({ status: "insufficient-data", signals: [], reasons: ["min_impressions: 500 < 1000"] });
  });

  it("returns insufficient-data for an empty series", () => {
    expect(computeFatigue([], {}, START).status).toBe("insufficient-data");
  });

  it("ignores days after asOf and is independent of the clock", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("computeFatigue must not read the clock");
    });
    const series = [...days(6, STABLE), ...days(3, { ...STABLE, inlineLinkClicks: 0, frequency: 9 }, addDays(START, 6))];
    const asOfDay6 = computeFatigue(series, {}, addDays(START, 5));
    expect(asOfDay6.status).toBe("ok");
    expect(computeFatigue(series, {}, addDays(START, 5))).toEqual(asOfDay6);
  });

  it("extends a thin baseline until it reaches baselineMinImpressions", () => {
    const series = [
      ...days(3, { impressions: 50, inlineLinkClicks: 2, spendCents: 50, frequency: 1 }),
      ...days(9, STABLE, addDays(START, 3)),
    ];
    const result = computeFatigue(series, {}, addDays(START, 11));
    expect(result.metrics.baseline).toMatchObject({ from: "2026-10-01", to: "2026-10-04", impressions: 450 });
  });

  it("flags age past maxAgeDays", () => {
    const series = days(30, STABLE);
    const result = computeFatigue(series, {}, addDays(START, 29));
    expect(result.status).toBe("watch");
    expect(result.signals).toEqual(["age"]);
  });

  it("uses the brand config values over the defaults", () => {
    const thresholds = fatigueThresholdsFor({ minImpressions: 50, maxFrequency: 2, ctrDropPct: 10 });
    expect(thresholds).toMatchObject({ minImpressions: 50, maxFrequency: 2, ctrDropPct: 10, recentDays: 3 });
  });

  it("keeps the exported defaults in line with the config defaults", () => {
    expect(DEFAULT_FATIGUE_THRESHOLDS).toMatchObject({
      minImpressions: DEFAULT_FATIGUE.minImpressions,
      maxFrequency: DEFAULT_FATIGUE.maxFrequency,
      ctrDropPct: DEFAULT_FATIGUE.ctrDropPct,
    });
    expect(Object.isFrozen(DEFAULT_FATIGUE_THRESHOLDS)).toBe(true);
  });
});
