import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "../src/config.js";
import { evaluateRules, type PriorRuleAction, type RuleAdDay, type RuleSnapshots, type RuleStatus } from "../src/features/rules/evaluate.js";
import { parseRules, type RuleSet } from "../src/features/rules/schema.js";
import { evaluateDataGate } from "../src/features/spend-guard/data-gate.js";
import { isLocalTimeAtOrAfter } from "../src/kit/local-time.js";
import plugin from "../src/worker.js";

const NOW = new Date("2026-10-21T09:00:00Z"); // 12:00 in Helsinki; yesterday = 2026-10-20
const CPC = { ruleId: "cpc", type: "threshold_pause", metric: "cpc", operator: "gt", threshold: 0.5, days: 2, minImpressions: 500, minClicks: 10 };

function ruleSet(list: unknown[], liveMode = false): RuleSet {
  const { rules, errors } = parseRules({ liveMode, list });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return rules;
}

function day(adId: string, date: string, spendEur: number, impressions: number, clicks: number, frequency: number | null = null): RuleAdDay {
  return { adId, date, spendCents: Math.round(spendEur * 100), impressions, inlineLinkClicks: clicks, frequency };
}

function snapshots(partial: Partial<RuleSnapshots> = {}): RuleSnapshots {
  return { timeZone: "Europe/Helsinki", days: [], creatives: [], fatigue: [], spend: null, priorActions: [], ...partial };
}

function status(ads: Array<[string, string]> = [["1", "ACTIVE"]], campaigns: Array<[string, string]> = [["100", "ACTIVE"]]): RuleStatus {
  return {
    adAccountId: "29231592883113369",
    ads: ads.map(([id, value]) => ({ id, name: `ad ${id}`, status: value })),
    campaigns: campaigns.map(([id, value]) => ({ id, status: value })),
  };
}

/** Two bad CPC days (0.60 and 0.70) with 300 impressions and 5 clicks each. */
function badCpcDays(adId = "1", dates = ["2026-10-19", "2026-10-20"]): RuleAdDay[] {
  return dates.map((date, index) => day(adId, date, (0.6 + index * 0.1) * 5, 300, 5));
}

describe("evaluateRules (A11)", () => {
  it("is pure: the same input gives the same decisions and the input is not changed", () => {
    const snap = snapshots({ days: badCpcDays() });
    const frozen = JSON.parse(JSON.stringify(snap)) as RuleSnapshots;
    const rules = ruleSet([CPC]);
    const first = evaluateRules(snap, status(), rules, NOW);
    const second = evaluateRules(snap, status(), rules, NOW);
    expect(first).toEqual(second);
    expect(snap).toEqual(frozen);
    expect(first).toEqual([
      {
        ruleId: "cpc",
        ruleType: "threshold_pause",
        objectType: "ad",
        objectId: "1",
        action: "pause",
        mode: "shadow",
        metrics: {
          spendEur: 6.5,
          clicks: 10,
          impressions: 600,
          cpc: 0.65,
          ctr: 1.6667,
          days: 2,
          from: "2026-10-19",
          to: "2026-10-20",
          metric: "cpc",
          operator: "gt",
          threshold: 0.5,
          dailyValues: [0.6, 0.7],
        },
        reason: expect.stringMatching(/^cpc > 0.5 on 2 consecutive day\(s\) 2026-10-19\.\.2026-10-20 \(0\.6, 0\.7\); 600 impressions, 10 link clicks$/),
      },
    ]);
  });

  describe("minimum-data gates (the window holds 600 impressions and 10 link clicks)", () => {
    it.each([
      ["impressions == minImpressions fires", { minImpressions: 600, minClicks: 0 }, 1],
      ["impressions == minImpressions - 1 does not", { minImpressions: 601, minClicks: 0 }, 0],
      ["clicks == minClicks fires", { minImpressions: 0, minClicks: 10 }, 1],
      ["clicks == minClicks - 1 does not", { minImpressions: 0, minClicks: 11 }, 0],
    ])("%s", (_label, gates, expected) => {
      expect(evaluateRules(snapshots({ days: badCpcDays() }), status(), ruleSet([{ ...CPC, ...gates }]), NOW)).toHaveLength(expected);
    });
  });

  describe("the default CPC ceiling gates on spend over a 7-day window total (RK9-536)", () => {
    const WEEK = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"];
    // Ololla: 100 EUR cap, G3 daily budget floor(100 * 100 / 31) = 322 cents.
    const DAILY_CENTS = 322;

    it("pauses an ad at 0.90 EUR per link click on Ololla's budget, which the old click gate never could", () => {
      // 3 or 4 link clicks a day: 25 clicks for 22.54 EUR, 0.90 EUR per click.
      const clicks = [4, 3, 4, 3, 4, 3, 4];
      const days = WEEK.map((date, index) => ({ adId: "1", date, spendCents: DAILY_CENTS, impressions: 400, inlineLinkClicks: clicks[index]!, frequency: 1.2 }));
      const decisions = evaluateRules(snapshots({ days }), status(), parseRules({}).rules, NOW);
      expect(decisions).toEqual([
        expect.objectContaining({
          ruleId: "cpc-ceiling",
          objectId: "1",
          mode: "shadow",
          metrics: expect.objectContaining({ spendEur: 22.54, clicks: 25, cpc: 0.9016, windowValue: 0.9016, aggregate: "window_total", days: 7, daysWithData: 7, from: "2026-10-14", to: "2026-10-20" }),
          reason: "cpc > 0.5 over the 7-day window 2026-10-14..2026-10-20 (total 0.9); 22.54 EUR spend, 2800 impressions, 25 link clicks",
        }),
      ]);
      // The old default (2 days, >= 10 link clicks): 2 days hold 6.44 EUR and 7 clicks, so it never fired.
      const old = { ruleId: "old", type: "threshold_pause", metric: "cpc", operator: "gt", threshold: 0.5, days: 2, minImpressions: 500, minClicks: 10 };
      expect(evaluateRules(snapshots({ days }), status(), ruleSet([old]), NOW)).toEqual([]);
    });

    it("pauses an ad with no link click once it has spent 3 EUR, and not before", () => {
      const spent = (cents: number) => [{ adId: "1", date: "2026-10-18", spendCents: cents, impressions: 900, inlineLinkClicks: 0, frequency: 1.1 }];
      const hit = evaluateRules(snapshots({ days: spent(300) }), status(), parseRules({}).rules, NOW);
      expect(hit).toEqual([
        expect.objectContaining({
          objectId: "1",
          metrics: expect.objectContaining({ spendEur: 3, clicks: 0, cpc: null, windowValue: null, daysWithData: 1 }),
          reason: expect.stringMatching(/\(total no link clicks\); 3\.00 EUR spend/),
        }),
      ]);
      expect(evaluateRules(snapshots({ days: spent(299) }), status(), parseRules({}).rules, NOW)).toEqual([]);
    });

    it("judges the window total, not each day: one cheap day does not save an expensive week", () => {
      const rule = { ...CPC, days: 3, aggregate: "window_total", minImpressions: 0, minClicks: 0, minSpendEur: 3 };
      const days = [day("1", "2026-10-18", 2, 300, 1), day("1", "2026-10-19", 1, 300, 5), day("1", "2026-10-20", 2, 300, 2)];
      // Day 2 is 0.20 per click, the window is 5 EUR / 8 clicks = 0.625.
      expect(evaluateRules(snapshots({ days }), status(), ruleSet([rule]), NOW)).toEqual([expect.objectContaining({ objectId: "1", metrics: expect.objectContaining({ windowValue: 0.625 }) })]);
      // A cheap window total does not fire, whatever a single day did.
      const cheap = [day("1", "2026-10-18", 2, 300, 1), day("1", "2026-10-19", 2, 300, 10)];
      expect(evaluateRules(snapshots({ days: cheap }), status(), ruleSet([rule]), NOW)).toEqual([]);
      // Days outside the window (today, or before it) do not count.
      const outside = [day("1", "2026-10-17", 10, 300, 0), day("1", "2026-10-21", 10, 300, 0)];
      expect(evaluateRules(snapshots({ days: outside }), status(), ruleSet([rule]), NOW)).toEqual([]);
    });

    it.each([
      ["spend == minSpendEur fires", 6.5, 1],
      ["spend below minSpendEur does not", 6.51, 0],
    ])("each_day honours minSpendEur too: %s", (_label, minSpendEur, expected) => {
      expect(evaluateRules(snapshots({ days: badCpcDays() }), status(), ruleSet([{ ...CPC, minSpendEur }]), NOW)).toHaveLength(expected);
    });
  });

  describe("N consecutive Helsinki calendar days", () => {
    it("ignores today's partial day and needs every day of the window", () => {
      const rules = ruleSet([CPC]);
      // Bad today only: not a completed day.
      const todayOnly = [day("1", "2026-10-21", 50, 5000, 50)];
      expect(evaluateRules(snapshots({ days: todayOnly }), status(), rules, NOW)).toEqual([]);
      // A missing day breaks the streak.
      const gap = [day("1", "2026-10-18", 3, 300, 5), day("1", "2026-10-20", 3.5, 300, 5)];
      expect(evaluateRules(snapshots({ days: gap }), status(), rules, NOW)).toEqual([]);
      // A good day breaks it too.
      const good = [day("1", "2026-10-19", 1, 300, 5), day("1", "2026-10-20", 3.5, 300, 5)];
      expect(evaluateRules(snapshots({ days: good }), status(), rules, NOW)).toEqual([]);
      // Spend without a link click is an infinite CPC: over a ceiling, never under a floor.
      const noClicks = [day("1", "2026-10-19", 3, 300, 0), day("1", "2026-10-20", 3.5, 300, 10)];
      expect(evaluateRules(snapshots({ days: noClicks }), status(), ruleSet([{ ...CPC, minClicks: 0 }]), NOW)).toEqual([]);
      expect(evaluateRules(snapshots({ days: noClicks }), status(), ruleSet([{ ...CPC, minClicks: 0, threshold: 0.3 }]), NOW)).toMatchObject([
        { metrics: { dailyValues: [null, 0.35] }, reason: expect.stringMatching(/\(no link clicks, 0\.35\)/) },
      ]);
      expect(evaluateRules(snapshots({ days: noClicks }), status(), ruleSet([{ ...CPC, operator: "lt", minClicks: 0 }]), NOW)).toEqual([]);
      // No spend and no clicks: no CPC at all, the streak breaks.
      const idle = [day("1", "2026-10-19", 0, 300, 0), day("1", "2026-10-20", 3.5, 300, 5)];
      expect(evaluateRules(snapshots({ days: idle }), status(), ruleSet([{ ...CPC, minClicks: 0 }]), NOW)).toEqual([]);
    });

    it("never fires a cpc floor on an ad that spent nothing, also with clicks (RK9-541)", () => {
      const floor = { ...CPC, operator: "lt", threshold: 0.2, minImpressions: 0, minClicks: 0 };
      const free = [day("1", "2026-10-19", 0, 300, 5), day("1", "2026-10-20", 0, 300, 5)];
      expect(evaluateRules(snapshots({ days: free }), status(), ruleSet([floor]), NOW)).toEqual([]);
      expect(evaluateRules(snapshots({ days: free }), status(), ruleSet([{ ...floor, aggregate: "window_total" }]), NOW)).toEqual([]);
      // With spend the floor still works.
      const cheap = [day("1", "2026-10-19", 0.5, 300, 5), day("1", "2026-10-20", 0.5, 300, 5)];
      expect(evaluateRules(snapshots({ days: cheap }), status(), ruleSet([floor]), NOW)).toHaveLength(1);
    });

    it("counts the 25-hour day of 2026-10-25 (EEST -> EET) as one day", () => {
      const rules = ruleSet([{ ...CPC, days: 3 }]);
      const days = badCpcDays("1", ["2026-10-23", "2026-10-24", "2026-10-25"]);
      // 2026-10-26 00:30 EET: yesterday is the 25th, the window is 23..25.
      expect(evaluateRules(snapshots({ days }), status(), rules, new Date("2026-10-25T22:30:00Z"))).toMatchObject([
        { metrics: { from: "2026-10-23", to: "2026-10-25", days: 3 } },
      ]);
      // 2026-10-25 23:30 EET: still the 25th, so the window is 22..24 and the 22nd is missing.
      expect(evaluateRules(snapshots({ days }), status(), rules, new Date("2026-10-25T21:30:00Z"))).toEqual([]);
      // 72 hours before 2026-10-26 00:30 EET is 2026-10-22 23:30 local (one hour of DST): a
      // clock-based window would start a day early. The calendar window does not.
      const withExtraDay = [...days, day("1", "2026-10-22", 0.1, 300, 5)];
      expect(evaluateRules(snapshots({ days: withExtraDay }), status(), rules, new Date("2026-10-25T22:30:00Z"))).toHaveLength(1);
    });

    it("counts the 23-hour day of 2027-03-28 (EET -> EEST) as one day", () => {
      const rules = ruleSet([{ ...CPC, days: 3 }]);
      const days = badCpcDays("1", ["2027-03-26", "2027-03-27", "2027-03-28"]);
      // 2027-03-29 00:30 EEST.
      expect(evaluateRules(snapshots({ days }), status(), rules, new Date("2027-03-28T21:30:00Z"))).toMatchObject([
        { metrics: { from: "2027-03-26", to: "2027-03-28" } },
      ]);
      // 2027-03-28 23:59 EEST: the 28th is still today.
      expect(evaluateRules(snapshots({ days }), status(), rules, new Date("2027-03-28T20:59:00Z"))).toEqual([]);
      // A missing day in the middle breaks the streak across the change.
      const gap = days.filter((entry) => entry.date !== "2027-03-27");
      expect(evaluateRules(snapshots({ days: gap }), status(), rules, new Date("2027-03-28T21:30:00Z"))).toEqual([]);
    });
  });

  it("supports a low-CTR rule with minClicks 0 and the other metrics", () => {
    const ctr = ruleSet([{ ruleId: "ctr", type: "threshold_pause", metric: "ctr", operator: "lt", threshold: 0.8, days: 1, minImpressions: 1000, minClicks: 0 }]);
    expect(evaluateRules(snapshots({ days: [day("1", "2026-10-20", 5, 1000, 7)] }), status(), ctr, NOW)).toHaveLength(1);
    expect(evaluateRules(snapshots({ days: [day("1", "2026-10-20", 5, 1000, 8)] }), status(), ctr, NOW)).toHaveLength(0);
    const freq = ruleSet([{ ruleId: "freq", type: "threshold_pause", metric: "frequency", operator: "gte", threshold: 2, days: 1, minImpressions: 0, minClicks: 0 }]);
    expect(evaluateRules(snapshots({ days: [day("1", "2026-10-20", 5, 1000, 8, 2)] }), status(), freq, NOW)).toHaveLength(1);
    expect(evaluateRules(snapshots({ days: [day("1", "2026-10-20", 5, 1000, 8, null)] }), status(), freq, NOW)).toHaveLength(0);
  });

  it("decides only on ACTIVE ads that are in the status listing", () => {
    const days = [...badCpcDays("1"), ...badCpcDays("2"), ...badCpcDays("3")];
    const decisions = evaluateRules(snapshots({ days }), status([["1", "PAUSED"], ["2", "ACTIVE"]]), ruleSet([CPC]), NOW);
    expect(decisions.map((decision) => decision.objectId)).toEqual(["2"]);
  });

  describe("cooldown", () => {
    const prior = (hoursAgo: number, mode: "shadow" | "live" = "shadow", applied = false): PriorRuleAction => ({
      ruleId: "cpc",
      objectId: "1",
      mode,
      applied,
      decidedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    });

    it("blocks the same rule on the same object inside the window and allows it at the boundary", () => {
      const rules = ruleSet([{ ...CPC, cooldownHours: 24 }]);
      const days = badCpcDays();
      expect(evaluateRules(snapshots({ days, priorActions: [prior(24 - 1 / 3600)] }), status(), rules, NOW)).toEqual([]);
      expect(evaluateRules(snapshots({ days, priorActions: [prior(24)] }), status(), rules, NOW)).toHaveLength(1);
      // Another object or another rule does not block.
      expect(evaluateRules(snapshots({ days, priorActions: [{ ...prior(1), objectId: "2" }, { ...prior(1), ruleId: "other" }] }), status(), rules, NOW)).toHaveLength(1);
    });

    it("counts only applied live pauses against a live rule", () => {
      const rules = ruleSet([{ ...CPC, mode: "live" }], true);
      const days = badCpcDays();
      expect(evaluateRules(snapshots({ days, priorActions: [prior(1, "live", true)] }), status(), rules, NOW)).toEqual([]);
      // A failed live pause is retried; a shadow history does not delay going live.
      expect(evaluateRules(snapshots({ days, priorActions: [prior(1, "live", false), prior(1, "shadow")] }), status(), rules, NOW)).toMatchObject([
        { mode: "live" },
      ]);
    });
  });

  it("is live only when both the rule and the brand are live", () => {
    const days = badCpcDays();
    expect(evaluateRules(snapshots({ days }), status(), ruleSet([{ ...CPC, mode: "live" }], false), NOW)[0]?.mode).toBe("shadow");
    expect(evaluateRules(snapshots({ days }), status(), ruleSet([CPC], true), NOW)[0]?.mode).toBe("shadow");
    expect(evaluateRules(snapshots({ days }), status(), ruleSet([{ ...CPC, mode: "live" }], true), NOW)[0]?.mode).toBe("live");
  });

  describe("pause_all_cap (built in)", () => {
    const spend = (pctUsed: number) => ({ month: "2026-10", mtdEur: pctUsed, monthlyCapEur: 100, pctUsed });

    it("fires at 90 % of the cap with no other rule defined", () => {
      const rules = ruleSet([]);
      expect(evaluateRules(snapshots({ spend: spend(89.9) }), status(), rules, NOW)).toEqual([]);
      expect(evaluateRules(snapshots({ spend: spend(90) }), status(), rules, NOW)).toEqual([
        {
          ruleId: "pause_all_cap",
          ruleType: "pause_all_cap",
          objectType: "account",
          objectId: "29231592883113369",
          action: "pause_all",
          mode: "shadow",
          metrics: { month: "2026-10", mtdEur: 90, monthlyCapEur: 100, pctUsed: 90, capPct: 90 },
          reason: "month-to-date spend 90 EUR is 90 % of the 100 EUR cap (>= 90 %)",
        },
      ]);
    });

    it("decides nothing when MTD was not read or nothing is active", () => {
      const rules = ruleSet([]);
      expect(evaluateRules(snapshots({ spend: null }), status(), rules, NOW)).toEqual([]);
      expect(evaluateRules(snapshots({ spend: spend(95) }), status([["1", "PAUSED"]], [["100", "PAUSED"]]), rules, NOW)).toEqual([]);
      // An ACTIVE campaign alone is enough.
      expect(evaluateRules(snapshots({ spend: spend(95) }), status([], [["100", "ACTIVE"]]), rules, NOW)).toHaveLength(1);
    });

    it("decides on the month position alone when the status listing failed (RK9-541)", () => {
      const unread = { ...status([], []), unread: true };
      expect(evaluateRules(snapshots({ spend: spend(95) }), unread, ruleSet([]), NOW)).toEqual([expect.objectContaining({ ruleId: "pause_all_cap", action: "pause_all" })]);
      expect(evaluateRules(snapshots({ spend: spend(89) }), unread, ruleSet([]), NOW)).toEqual([]);
    });
  });

  it("pause_valid_until pauses an ACTIVE ad whose creative validUntil is before now", () => {
    const rules = ruleSet([{ ruleId: "expired", type: "pause_valid_until" }]);
    const creatives = [
      { adId: "1", validUntil: "2026-10-21T08:59:59Z" },
      { adId: "2", validUntil: NOW.toISOString() },
      { adId: "3", validUntil: "2026-10-22T00:00:00Z" },
    ];
    const decisions = evaluateRules(snapshots({ creatives }), status([["1", "ACTIVE"], ["2", "ACTIVE"], ["3", "ACTIVE"], ["4", "ACTIVE"]]), rules, NOW);
    expect(decisions).toEqual([
      expect.objectContaining({ ruleId: "expired", objectId: "1", action: "pause", metrics: { validUntil: "2026-10-21T08:59:59.000Z" } }),
    ]);
  });

  it("pause_fatigued fires only for an opted-in brand with a fatigued signal", () => {
    const fatigue = [
      { adId: "1", status: "fatigued" as const, signals: ["frequency", "ctr_decay"] },
      { adId: "2", status: "watch" as const, signals: ["age"] },
    ];
    const ads = status([["1", "ACTIVE"], ["2", "ACTIVE"]]);
    expect(evaluateRules(snapshots({ fatigue }), ads, ruleSet([{ ruleId: "tired", type: "pause_fatigued" }]), NOW)).toEqual([
      expect.objectContaining({ ruleId: "tired", objectId: "1", reason: "creative fatigued (frequency, ctr_decay)" }),
    ]);
    // Not opted in: no pause_fatigued rule, no decision.
    expect(evaluateRules(snapshots({ fatigue }), ads, ruleSet([]), NOW)).toEqual([]);
    // Opted in but no signal: no-op.
    expect(evaluateRules(snapshots({ fatigue: [] }), ads, ruleSet([{ ruleId: "tired", type: "pause_fatigued" }]), NOW)).toEqual([]);
  });

  it("propose_scale never decides (G9)", () => {
    const rules = ruleSet([{ ruleId: "scale", type: "propose_scale", enabled: false, threshold: 5, days: 1, minImpressions: 0, minClicks: 0 }]);
    expect(evaluateRules(snapshots({ days: [day("1", "2026-10-20", 1, 1000, 100)] }), status(), rules, NOW)).toEqual([]);
  });
});

describe("Sunspot ops scripts as config (fixtures/sunspot-rules.json)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/sunspot-rules.json", import.meta.url), "utf8")) as { config: Record<string, unknown> };
  const parsed = parseBrandConfig(fixture.config);
  if (parsed.state !== "enabled") throw new Error(`fixture invalid: ${JSON.stringify(parsed)}`);
  const config = parsed.config;

  function recorded(date: string): RuleAdDay[] {
    const file = JSON.parse(readFileSync(new URL(`./fixtures/insights/sunspot-${date}.json`, import.meta.url), "utf8")) as {
      adLevel: { data: Array<Record<string, string>> };
    };
    return file.adLevel.data.map((row) => day(row.ad_id!, row.date_start!, Number(row.spend), Number(row.impressions), Number(row.inline_link_clicks)));
  }

  /** sunspot-aamu-sop.sh: `warn if clicks and spend / clicks > 0.5` on yesterday's account totals. */
  function scriptWarns(rows: readonly RuleAdDay[]): boolean {
    const spend = rows.reduce((sum, row) => sum + row.spendCents / 100, 0);
    const clicks = rows.reduce((sum, row) => sum + row.inlineLinkClicks, 0);
    return clicks > 0 && spend / clicks > 0.5;
  }

  it("loads through onValidateConfig", async () => {
    expect(await plugin.definition.onValidateConfig!(fixture.config)).toEqual({ ok: true });
    expect(config.rules.liveMode).toBe(false);
    expect(config.rules.list.map((rule) => [rule.ruleId, rule.mode])).toEqual([
      ["aamu-sop-cpc", "shadow"],
      ["pause_all_cap", "shadow"],
    ]);
  });

  it.each([
    ["2026-08-21 as recorded", "2026-08-21", (rows: RuleAdDay[]) => rows],
    ["2026-09-15 as recorded", "2026-09-15", (rows: RuleAdDay[]) => rows],
    ["2026-09-15 with 16 link clicks (0.515 €/click)", "2026-09-15", (rows: RuleAdDay[]) => rows.map((row) => ({ ...row, inlineLinkClicks: 16 }))],
    ["2026-08-21 with 23 link clicks (0.511 €/click)", "2026-08-21", (rows: RuleAdDay[]) => rows.map((row) => ({ ...row, inlineLinkClicks: 23 }))],
    ["2026-08-21 without link clicks", "2026-08-21", (rows: RuleAdDay[]) => rows.map((row) => ({ ...row, inlineLinkClicks: 0 }))],
  ])("the aamu-SOP CPC warning matches the script on %s, warn only (shadow)", (_label, date, variant) => {
    const rows = variant(recorded(date));
    const now = new Date(`${date}T05:00:00Z`);
    now.setUTCDate(now.getUTCDate() + 1); // the morning after: `date` is yesterday
    const ads: RuleStatus = { adAccountId: config.meta.adAccountId, ads: rows.map((row) => ({ id: row.adId, status: "ACTIVE" })), campaigns: [] };
    const decisions = evaluateRules(snapshots({ days: rows }), ads, config.rules, now);
    expect(decisions.length > 0).toBe(scriptWarns(rows));
    for (const decision of decisions) expect(decision).toMatchObject({ ruleId: "aamu-sop-cpc", mode: "shadow", action: "pause" });
  });

  it("pulse-off: the scheduled pause fires from 21:30 Helsinki time, as the script's 18:30 UTC cron in summer", () => {
    const pause = config.schedule.scheduledPause;
    expect(pause).toEqual({ enabled: true, at: "21:30" });
    expect(isLocalTimeAtOrAfter(new Date("2026-08-21T18:29:00Z"), pause.at, config.timeZone)).toBe(false);
    expect(isLocalTimeAtOrAfter(new Date("2026-08-21T18:30:00Z"), pause.at, config.timeZone)).toBe(true);
  });

  it("data-gate: pauses below 8 terraces in sun as the script does, and fails open when the feed is down", async () => {
    const gate = config.schedule.dataGate!;
    const feed = JSON.parse(readFileSync(new URL("./fixtures/sunspot-pulse-off/feed.json", import.meta.url), "utf8")) as {
      body: { terraces: Array<{ status: string }> };
    };
    const inSun = feed.body.terraces.filter((terrace) => terrace.status === "clear" || terrace.status === "partly-clear").length;
    for (const count of [inSun, 7, 8, 12]) {
      const outcome = await evaluateDataGate(async () => new Response(JSON.stringify({ inSunNow: count })), gate);
      expect(outcome.action === "pause").toBe(count < 8);
    }
    const down = await evaluateDataGate(async () => new Response("bad gateway", { status: 502 }), gate);
    expect(down).toMatchObject({ action: "skip", reason: "feed_unavailable" });
  });
});
