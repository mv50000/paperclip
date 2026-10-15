import { describe, expect, it } from "vitest";
import {
  formatDecimal,
  formatDigest,
  formatInt,
  formatMoney,
  TELEGRAM_TEXT_UTF16_LIMIT,
  TRUNCATION_MARK,
  truncateForTelegram,
  type DigestInput,
} from "../src/digest/format.js";
import { computePacing } from "../src/insights/mtd.js";
import { localMonthBounds } from "../src/kit/local-time.js";

/** Month bounds of a Helsinki date, at local noon. */
const month = (date: string) => localMonthBounds(new Date(`${date}T09:00:00Z`));

function normalDay(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    brandName: "Ololla",
    reportDate: "2026-10-14",
    currency: "EUR",
    yesterday: { spendCents: 321, impressions: 1812, clicks: 19, inlineLinkClicks: 11 },
    cpcWarnEur: 0.5,
    zeroSpendMode: "message",
    pacing: computePacing({ month: month("2026-10-15"), mtdCents: 4510, completeDaysCents: 4300, monthlyCapEur: 100 }),
    spendCap: { capCents: 10000, headroomCents: 5490 },
    activeAds: 2,
    fatigued: [],
    ruleActions: [],
    pendingGates: [],
    warnings: [],
    ...overrides,
  };
}

describe("number formatting", () => {
  it("uses the Finnish decimal comma and space thousands", () => {
    expect(formatDecimal(0.291)).toBe("0,29");
    expect(formatDecimal(1234.5)).toBe("1 234,50");
    expect(formatInt(1234567)).toBe("1 234 567");
    expect(formatMoney(10000, "EUR")).toBe("100,00 €");
    expect(formatMoney(5, "USD")).toBe("0,05 USD");
  });
});

describe("formatDigest", () => {
  it("formats a normal day", () => {
    expect(formatDigest(normalDay())).toMatchSnapshot();
  });

  it("warns when CPC is above cpcWarnEur", () => {
    const text = formatDigest(normalDay({ yesterday: { spendCents: 600, impressions: 900, clicks: 12, inlineLinkClicks: 10 } }))!;
    expect(text).toContain("CPC 0,60 € ⚠️ yli 0,50 €");
  });

  it("does not warn at or below cpcWarnEur", () => {
    const text = formatDigest(normalDay({ yesterday: { spendCents: 500, impressions: 900, clicks: 12, inlineLinkClicks: 10 } }))!;
    expect(text).toContain("CPC 0,50 €");
    expect(text).not.toContain("⚠️ yli");
  });

  it("formats a zero-spend day in message mode", () => {
    const input = normalDay({ yesterday: { spendCents: 0, impressions: 0, clicks: 0, inlineLinkClicks: 0 }, activeAds: 0 });
    const text = formatDigest(input);
    expect(text).toContain("0 € kulutus, ei aktiivisia mainoksia");
    expect(text).toMatchSnapshot();
  });

  it("does not claim 'no active ads' when the ad count is unknown", () => {
    const text = formatDigest(normalDay({ yesterday: { spendCents: 0, impressions: 0, clicks: 0, inlineLinkClicks: 0 }, activeAds: null }))!;
    expect(text).toContain("Eilen: 0,00 € · 0 näyttöä");
    expect(text).not.toContain("ei aktiivisia mainoksia");
  });

  it("returns null for a quiet zero-spend day in silent mode", () => {
    const input = normalDay({
      yesterday: { spendCents: 0, impressions: 0, clicks: 0, inlineLinkClicks: 0 },
      activeAds: 0,
      zeroSpendMode: "silent",
    });
    expect(formatDigest(input)).toBeNull();
  });

  it("still sends a zero-spend day in silent mode when there is a warning", () => {
    const input = normalDay({
      yesterday: { spendCents: 0, impressions: 0, clicks: 0, inlineLinkClicks: 0 },
      activeAds: 0,
      zeroSpendMode: "silent",
      warnings: ["Meta-token ei kelpaa (190): tilin tietoja ei saatu"],
    });
    expect(formatDigest(input)).toContain("Meta-token ei kelpaa");
  });

  it("warns when the pacing goes over the monthly cap", () => {
    const input = normalDay({
      pacing: computePacing({ month: month("2026-10-20"), mtdCents: 8200, completeDaysCents: 7800, monthlyCapEur: 100 }),
      spendCap: { capCents: 10000, headroomCents: 1800 },
    });
    const text = formatDigest(input)!;
    expect(text).toContain("Ennuste kuun loppuun: 127,26 € ⚠️ ylittää katon 100,00 €");
    expect(text).toMatchSnapshot();
  });

  it("flags a fatigued ad and lists rule actions, gates and warnings", () => {
    const input = normalDay({
      fatigued: [{ adId: "120248676310950775", adName: "Syysreel 1", signals: ["ctr_decay", "cpc_rise"] }],
      ruleActions: [
        {
          ruleId: "cpc-high",
          ruleType: "threshold_pause",
          action: "pause",
          objectType: "ad",
          objectId: "120248676310950775",
          mode: "shadow",
          applied: false,
          decidedAt: "2026-10-14T18:00:00.000Z",
        },
      ],
      pendingGates: [{ kind: "activate_ad", adId: "120248676310950999", validUntil: "2026-10-16T00:00:00.000Z" }],
      warnings: ["Metan tilillä ei ole kulutusrajaa (spend_cap)"],
    });
    const text = formatDigest(input)!;
    expect(text).toContain("🔁 väsynyt: Syysreel 1 (120248676310950775) – CTR laskenut, CPC noussut");
    expect(text).toMatchSnapshot();
  });

  it("caps long lists and stays within 4096 UTF-16 units", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      adId: String(120248676310950000 + index),
      adName: `🔥 Hyvin pitkä mainoksen nimi numero ${index} ${"x".repeat(60)}`,
      signals: ["frequency", "ctr_decay", "cpc_rise", "cpm_rise", "age"] as DigestInput["fatigued"][number]["signals"],
    }));
    const text = formatDigest(normalDay({ fatigued: many, warnings: Array.from({ length: 50 }, (_, i) => `varoitus ${i} ${"y".repeat(300)}`) }))!;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_UTF16_LIMIT);
    expect(text).toContain("… ja 390 muuta");
    expect(formatDigest(normalDay({ fatigued: many }))).toBe(formatDigest(normalDay({ fatigued: many })));
  });

  it("truncates deterministically at a line break without splitting an emoji", () => {
    const text = Array.from({ length: 600 }, (_, i) => `🔁 rivi ${i} ${"z".repeat(10)}`).join("\n");
    const cut = truncateForTelegram(text);
    expect(cut.length).toBeLessThanOrEqual(TELEGRAM_TEXT_UTF16_LIMIT);
    expect(cut.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(cut.slice(0, -TRUNCATION_MARK.length).endsWith("z")).toBe(true);
    expect(truncateForTelegram(text)).toBe(cut);
    // No lone surrogate anywhere.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
  });
});

describe("computePacing", () => {
  it("projects from complete days only", () => {
    expect(computePacing({ month: month("2026-10-11"), mtdCents: 3500, completeDaysCents: 3000, monthlyCapEur: 100 })).toEqual({
      today: "2026-10-11",
      mtdCents: 3500,
      completeDays: 10,
      daysInMonth: 31,
      monthlyCapCents: 10000,
      projectedCents: 9300,
      overCap: false,
    });
  });

  it("has no projection on the 1st", () => {
    expect(computePacing({ month: month("2026-11-01"), mtdCents: 120, completeDaysCents: 0, monthlyCapEur: 100 }).projectedCents).toBeNull();
  });

  it("uses the month length of the account-local date", () => {
    expect(computePacing({ month: month("2026-02-15"), mtdCents: 0, completeDaysCents: 0, monthlyCapEur: 100 }).daysInMonth).toBe(28);
    expect(computePacing({ month: month("2026-09-15"), mtdCents: 0, completeDaysCents: 0, monthlyCapEur: 100 }).daysInMonth).toBe(30);
  });
});
