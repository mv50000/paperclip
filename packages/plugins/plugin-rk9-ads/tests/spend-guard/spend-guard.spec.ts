import { describe, expect, it } from "vitest";
import { dailyBudgetCents } from "../../src/config.js";
import {
  capCents,
  checkSpend,
  classifySpendWrite,
  createSpendGuardHook,
  evaluateGuard,
  projectBudgets,
  type GuardNumbers,
  type GuardResult,
} from "../../src/features/spend-guard/guard.js";
import { localMonthBounds } from "../../src/kit/local-time.js";
import { WriteRefusedError } from "../../src/meta/errors.js";
import { createAd, getAccountSummary, parseDecimalMoney, setObjectStatus } from "../../src/meta/methods.js";
import { FakeMeta } from "./fake-meta.js";
import { at, config, metaClient } from "./helpers.js";

const ACT = "act_29231592883113369";
const OLLOLA = config();

function numbers(overrides: Partial<GuardNumbers> = {}): GuardNumbers {
  return {
    monthlyCapEur: 100,
    currency: "EUR",
    accountTimeZone: "Europe/Helsinki",
    spendCapCents: 10_000,
    amountSpentCents: 7_000,
    mtdCents: 7_000,
    dailySumCents: 0,
    lifetimeCommitCents: 0,
    month: "2026-10",
    remainingDays: 11,
    ...overrides,
  };
}

/** Ololla on 21.10.2026 (11 local days left, today included). */
function ollolaMeta(mtd: string, adsetBudget: string): FakeMeta {
  const meta = new FakeMeta();
  meta.account = { ...meta.account, spend_cap: "10000", amount_spent: String(Math.round(Number(mtd) * 100)) };
  meta.spend = () => mtd;
  meta.campaigns = [{ id: "100", name: "OLL kampanja", status: "ACTIVE" }];
  meta.adsets = [{ id: "200", name: "OLL adset", status: "ACTIVE", campaign_id: "100", daily_budget: adsetBudget }];
  meta.ads = [{ id: "300", name: "OLL ad", status: "PAUSED", campaign_id: "100", adset_id: "200" }];
  return meta;
}

const OCT_21 = at("2026-10-21T09:00:00Z");

describe("evaluateGuard: the decision on read numbers", () => {
  it("Ololla 100 EUR/month: MTD 70 + 3 EUR/day x 11 days = 103 denies, 2 EUR/day = 92 allows", () => {
    const deny = evaluateGuard(numbers({ dailySumCents: 300 }));
    expect(deny).toMatchObject({ allow: false, reason: "projection_exceeds_cap", projectedMonthEndEur: 103, mtdEur: 70 });
    const allow = evaluateGuard(numbers({ dailySumCents: 200 }));
    expect(allow).toMatchObject({ allow: true, reason: "ok", projectedMonthEndEur: 92, pctUsed: 70 });
  });

  it("denies without a spend_cap", () => {
    expect(evaluateGuard(numbers({ spendCapCents: null }))).toMatchObject({ allow: false, reason: "no_spend_cap" });
  });

  it("uses the headroom rule (G2): spend_cap above the monthly cap is fine while Meta's headroom fits the remaining budget", () => {
    // Lifetime cap far above 100 EUR, but only 25 EUR of it left: Meta stops earlier than we would.
    expect(evaluateGuard(numbers({ spendCapCents: 500_000, amountSpentCents: 497_500, mtdCents: 7_000 }))).toMatchObject({
      allow: true,
      headroomEur: 25,
    });
    // Meta would allow 200 EUR more while 30 EUR of the month is left: Meta is no backstop.
    expect(evaluateGuard(numbers({ spendCapCents: 20_000, amountSpentCents: 0, mtdCents: 7_000 }))).toMatchObject({
      allow: false,
      reason: "spend_cap_headroom_exceeds_remaining",
      headroomEur: 200,
    });
  });

  it("denies a non-EUR account", () => {
    expect(evaluateGuard(numbers({ currency: "USD" }))).toMatchObject({ allow: false, reason: "currency_not_eur" });
  });

  it.each([
    ["2026-02-01T00:00:00+02:00", 28],
    ["2026-04-01T00:00:00+03:00", 30],
    ["2026-01-01T00:00:00+02:00", 31],
  ])("G3: the provisioned daily budget passes its own guard on day 1 of a %s-start month (%i days), one cent more does not", (iso, days) => {
    const bounds = localMonthBounds(at(iso), "Europe/Helsinki");
    expect(bounds.daysInMonth).toBe(days);
    expect(bounds.remainingDays).toBe(days);
    const daily = dailyBudgetCents(100, days);
    const base = { mtdCents: 0, amountSpentCents: 0, month: bounds.month, remainingDays: bounds.remainingDays };
    expect(evaluateGuard(numbers({ ...base, dailySumCents: daily })).allow).toBe(true);
    expect(evaluateGuard(numbers({ ...base, dailySumCents: daily + 1 })).allow).toBe(false);
  });

  it("converts cents to EUR without float drift", () => {
    const result = evaluateGuard(numbers({ spendCapCents: 10_000, amountSpentCents: 12_345, mtdCents: 1_001, dailySumCents: 333, remainingDays: 3 }));
    expect(result.spendCapEur).toBe(100);
    expect(result.amountSpentEur).toBe(123.45);
    expect(result.mtdEur).toBe(10.01);
    expect(result.projectedMonthEndEur).toBe(20.0);
    expect(capCents(100)).toBe(10_000);
    expect(capCents(99.99)).toBe(9_999);
  });
});

describe("Helsinki calendar month", () => {
  it.each([
    // Last day of the month, 23:59 vs 00:00 Helsinki: UTC 21:59/22:00 in winter (EET), 20:59/21:00 in summer (EEST).
    ["2026-01-31T21:59:00Z", "2026-01", "2026-01-01", "2026-01-31", 1],
    ["2026-01-31T22:00:00Z", "2026-02", "2026-02-01", "2026-02-01", 28],
    ["2026-07-31T20:59:00Z", "2026-07", "2026-07-01", "2026-07-31", 1],
    ["2026-07-31T21:00:00Z", "2026-08", "2026-08-01", "2026-08-01", 31],
    // DST starts on the last Sunday of March (29.3.2026 01:00Z: 03:00 EET -> 04:00 EEST).
    ["2026-03-29T00:59:00Z", "2026-03", "2026-03-01", "2026-03-29", 3],
    ["2026-03-29T01:00:00Z", "2026-03", "2026-03-01", "2026-03-29", 3],
    ["2026-03-31T20:59:00Z", "2026-03", "2026-03-01", "2026-03-31", 1],
    ["2026-03-31T21:00:00Z", "2026-04", "2026-04-01", "2026-04-01", 30],
    // DST ends on the last Sunday of October (25.10.2026 01:00Z: 04:00 EEST -> 03:00 EET).
    ["2026-10-25T00:59:00Z", "2026-10", "2026-10-01", "2026-10-25", 7],
    ["2026-10-25T01:00:00Z", "2026-10", "2026-10-01", "2026-10-25", 7],
    ["2026-10-31T21:59:00Z", "2026-10", "2026-10-01", "2026-10-31", 1],
    ["2026-10-31T22:00:00Z", "2026-11", "2026-11-01", "2026-11-01", 30],
  ])("%s -> month %s, since %s, until %s, %i day(s) left", (iso, month, since, until, remaining) => {
    expect(localMonthBounds(at(iso), "Europe/Helsinki")).toMatchObject({ month, since, until, remainingDays: remaining });
  });

  it("reads MTD insights with Helsinki dates on both sides of midnight", async () => {
    for (const [iso, since, until] of [
      ["2026-10-31T21:59:00Z", "2026-10-01", "2026-10-31"],
      ["2026-10-31T22:00:00Z", "2026-11-01", "2026-11-01"],
    ] as const) {
      const meta = ollolaMeta("10.00", "100");
      await checkSpend({ config: OLLOLA, client: metaClient(meta), now: at(iso) });
      expect(JSON.parse(meta.insightsCalls[0]!.params.time_range!)).toEqual({ since, until });
      expect(meta.insightsCalls[0]!.params.level).toBe("account");
    }
  });
});

describe("checkSpend: fresh Meta reads, fail-closed", () => {
  it("allows and denies the Ololla example from real reads", async () => {
    expect(await checkSpend({ config: OLLOLA, client: metaClient(ollolaMeta("70.00", "300")), now: OCT_21 })).toMatchObject({
      allow: false,
      reason: "projection_exceeds_cap",
      monthlyCapEur: 100,
      spendCapEur: 100,
      amountSpentEur: 70,
      mtdEur: 70,
      projectedMonthEndEur: 103,
    });
    expect(await checkSpend({ config: OLLOLA, client: metaClient(ollolaMeta("70.00", "200")), now: OCT_21 })).toMatchObject({
      allow: true,
      projectedMonthEndEur: 92,
      remainingDays: 11,
    });
  });

  it("re-reads Meta on every call (no cache)", async () => {
    const meta = ollolaMeta("70.00", "200");
    const client = metaClient(meta);
    await checkSpend({ config: OLLOLA, client, now: OCT_21 });
    meta.spend = () => "95.00";
    meta.account = { ...meta.account, amount_spent: "9500" };
    const second = await checkSpend({ config: OLLOLA, client, now: OCT_21 });
    expect(second).toMatchObject({ allow: false, mtdEur: 95 });
    expect(meta.calls.filter((call) => call.path === ACT)).toHaveLength(2);
    expect(meta.insightsCalls).toHaveLength(2);
  });

  it("denies a missing or zero spend_cap", async () => {
    for (const spendCap of ["0", undefined]) {
      const meta = ollolaMeta("10.00", "100");
      meta.account = { ...meta.account, spend_cap: spendCap };
      expect(await checkSpend({ config: OLLOLA, client: metaClient(meta), now: OCT_21 })).toMatchObject({ allow: false, reason: "no_spend_cap" });
    }
  });

  it("denies a non-EUR account", async () => {
    const meta = ollolaMeta("10.00", "100");
    meta.account = { ...meta.account, currency: "SEK" };
    expect(await checkSpend({ config: OLLOLA, client: metaClient(meta), now: OCT_21 })).toMatchObject({ allow: false, reason: "currency_not_eur" });
  });

  it.each(["account", "insights", "adsets"])("denies when the %s read fails", async (which) => {
    const meta = ollolaMeta("10.00", "100");
    meta.fail = (call) =>
      (which === "account" && call.path === ACT) || (which === "insights" && call.path.endsWith("/insights")) || (which === "adsets" && call.path.endsWith("/adsets"))
        ? new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 })
        : null;
    const result = await checkSpend({ config: OLLOLA, client: metaClient(meta), now: OCT_21 });
    expect(result).toMatchObject({ allow: false, reason: "meta_read_failed", mtdEur: null, projectedMonthEndEur: null });
  });

  it("denies when the ad account's time zone is not the brand's (MTD would be off)", async () => {
    const meta = ollolaMeta("10.00", "100");
    meta.account = { ...meta.account, timezone_name: "Asia/Tokyo" };
    expect(await checkSpend({ config: OLLOLA, client: metaClient(meta), now: OCT_21 })).toMatchObject({
      allow: false,
      reason: "account_timezone_mismatch",
      mtdEur: null,
    });
  });

  it("denies when an insights row has no spend (missing spend never reads as zero)", async () => {
    const meta = ollolaMeta("10.00", "100");
    meta.spend = () => "";
    expect(await checkSpend({ config: OLLOLA, client: metaClient(meta), now: OCT_21 })).toMatchObject({ allow: false, reason: "meta_read_failed" });
  });

  it("denies when the reads time out", async () => {
    const client = metaClient(new FakeMeta(), "readOnly", { http: { fetch: () => new Promise<Response>(() => {}) } });
    expect(await checkSpend({ config: OLLOLA, client, now: OCT_21, timeoutMs: 30 })).toMatchObject({ allow: false, reason: "meta_read_timeout" });
  });

  it("parses money exactly", async () => {
    expect(parseDecimalMoney("70.5", "spend")).toBe(7_050);
    expect(parseDecimalMoney("0.01", "spend")).toBe(1);
    expect(parseDecimalMoney("1234", "spend")).toBe(123_400);
    expect(() => parseDecimalMoney("1.234", "spend")).toThrow();
    expect(() => parseDecimalMoney("-1", "spend")).toThrow();
    const meta = new FakeMeta(undefined, { spend_cap: "10000", amount_spent: "12345" });
    expect(await getAccountSummary(metaClient(meta), ACT)).toMatchObject({ spendCapCents: 10_000, amountSpentCents: 12_345 });
  });
});

describe("projection", () => {
  const budgets = {
    campaigns: [
      { id: "1", name: "", status: "PAUSED", effectiveStatus: "PAUSED", level: "campaign" as const, campaignId: null, dailyBudgetCents: 1_000, lifetimeBudgetCents: null },
      { id: "2", name: "", status: "ACTIVE", effectiveStatus: "ACTIVE", level: "campaign" as const, campaignId: null, dailyBudgetCents: null, lifetimeBudgetCents: 5_000 },
    ],
    adsets: [
      // ACTIVE under a PAUSED campaign: counted (it runs as soon as the campaign does).
      { id: "11", name: "", status: "ACTIVE", effectiveStatus: "CAMPAIGN_PAUSED", level: "adset" as const, campaignId: "1", dailyBudgetCents: 200, lifetimeBudgetCents: null },
      { id: "12", name: "", status: "PAUSED", effectiveStatus: "PAUSED", level: "adset" as const, campaignId: "2", dailyBudgetCents: 900, lifetimeBudgetCents: null },
    ],
  };

  it("counts ACTIVE objects conservatively and lifetime budgets in full", () => {
    expect(projectBudgets(budgets, null)).toEqual({ dailySumCents: 200, lifetimeCommitCents: 5_000 });
  });

  it("applies an activation, a budget change and a create", () => {
    expect(projectBudgets(budgets, { objectId: "1", level: null, activate: true })).toEqual({ dailySumCents: 1_200, lifetimeCommitCents: 5_000 });
    expect(projectBudgets(budgets, { objectId: "11", level: null, activate: false, dailyBudgetCents: 500 })).toEqual({ dailySumCents: 500, lifetimeCommitCents: 5_000 });
    expect(projectBudgets(budgets, { objectId: null, level: "adset", activate: true, dailyBudgetCents: 300 })).toEqual({ dailySumCents: 500, lifetimeCommitCents: 5_000 });
    expect(projectBudgets(budgets, { objectId: null, level: "ad", activate: true })).toEqual({ dailySumCents: 200, lifetimeCommitCents: 5_000 });
  });
});

describe("guardedWrite hook: every spend-raising write passes the guard", () => {
  function rig(meta: FakeMeta, authorize: boolean | undefined) {
    const decisions: GuardResult[] = [];
    const hook = createSpendGuardHook({
      config: OLLOLA,
      readClient: metaClient(meta),
      now: () => OCT_21,
      ...(authorize === undefined ? {} : { authorizeSpend: () => (authorize ? { allow: true } : { allow: false, reason: "no tap" }) }),
      onDecision: async (result) => void decisions.push(result),
    });
    const client = metaClient(meta, "live", { guardedWrite: hook });
    return { client, decisions };
  }

  it("refuses activation without the gate's authorization (G1), before any Meta read", async () => {
    const meta = ollolaMeta("10.00", "100");
    const { client, decisions } = rig(meta, undefined);
    await expect(setObjectStatus(client, "300", "ACTIVE")).rejects.toThrow(WriteRefusedError);
    expect(meta.calls).toHaveLength(0);
    expect(decisions[0]).toMatchObject({ allow: false, reason: "gate_required" });
  });

  it("lets pauses through without a guard read", async () => {
    const meta = ollolaMeta("99.00", "300");
    const { client } = rig(meta, undefined);
    await setObjectStatus(client, "200", "PAUSED");
    expect(meta.writes).toHaveLength(1);
    expect(meta.insightsCalls).toHaveLength(0);
  });

  it("activates within the cap and refuses over it, sending nothing", async () => {
    const ok = ollolaMeta("70.00", "200");
    await setObjectStatus(rig(ok, true).client, "300", "ACTIVE");
    expect(ok.writes.map((call) => call.body.status)).toEqual(["ACTIVE"]);

    const over = ollolaMeta("70.00", "300");
    const { client, decisions } = rig(over, true);
    await expect(setObjectStatus(client, "300", "ACTIVE")).rejects.toThrow(/spend_guard:projection_exceeds_cap/);
    expect(over.writes).toHaveLength(0);
    expect(decisions[0]).toMatchObject({ allow: false, reason: "projection_exceeds_cap", projectedMonthEndEur: 103 });
  });

  it("guards an ad created ACTIVE (and one created without a status, which Meta makes ACTIVE)", async () => {
    const over = ollolaMeta("70.00", "300");
    const { client } = rig(over, true);
    await expect(
      client.post(`${ACT}/ads`, { name: "x", adset_id: "200", creative: { creative_id: "1" }, status: "ACTIVE" }),
    ).rejects.toThrow(/projection_exceeds_cap/);
    await expect(client.post(`${ACT}/ads`, { name: "x", adset_id: "200", creative: { creative_id: "1" } })).rejects.toThrow(
      /projection_exceeds_cap/,
    );
    // createAd always sends PAUSED: allowed with no guard read at all.
    await createAd(client, ACT, { name: "x", adsetId: "200", creativeId: "1" });
    expect(over.writes).toHaveLength(1);
    expect(over.writes[0]!.body.status).toBe("PAUSED");
  });

  it("guards a budget raise, and never blocks a budget cut", async () => {
    const meta = ollolaMeta("70.00", "200");
    const { client, decisions } = rig(meta, true);
    await expect(client.post("200", { daily_budget: "300" })).rejects.toThrow(/projection_exceeds_cap/);
    await expect(client.post("200", { lifetime_budget: "5000" })).rejects.toThrow(/projection_exceeds_cap/);
    meta.spend = () => "99.00";
    await client.post("200", { daily_budget: "100" });
    expect(decisions.at(-1)).toMatchObject({ allow: true, reason: "not_spend_raising" });
    expect(meta.writes.map((call) => call.body.daily_budget)).toEqual(["100"]);
  });

  it("refuses writes it cannot classify, another account and objects outside the account", async () => {
    const meta = ollolaMeta("10.00", "100");
    meta.foreign.add("300");
    const { client, decisions } = rig(meta, true);
    await expect(client.post("200", { bid_amount: "500" })).rejects.toThrow(/unsupported_write/);
    await expect(client.post("act_123/adsets", { name: "x", status: "ACTIVE" })).rejects.toThrow(/another ad account/);
    await expect(client.post(`${ACT}/ads`, { name: "x", status: "ACTIVE", adset_spec: { daily_budget: 1 } })).rejects.toThrow(
      /unsupported_write/,
    );
    await expect(setObjectStatus(client, "300", "ACTIVE")).rejects.toThrow(/object_not_in_account/);
    expect(meta.writes).toHaveLength(0);
    expect(decisions.map((decision) => decision.reason)).toEqual([
      "unsupported_write",
      "unsupported_write",
      "unsupported_write",
      "object_not_in_account",
    ]);
  });

  it("refuses to activate a campaign or ad set the account listing leaves out (e.g. archived)", async () => {
    const meta = ollolaMeta("10.00", "100");
    meta.campaigns.push({ id: "500", name: "archived", status: "PAUSED", daily_budget: "50000" });
    meta.adsets.push({ id: "510", name: "archived set", status: "PAUSED", campaign_id: "100", daily_budget: "50000" });
    meta.unlisted.add("500");
    meta.unlisted.add("510");
    const { client, decisions } = rig(meta, true);
    await expect(setObjectStatus(client, "500", "ACTIVE")).rejects.toThrow(/meta_read_failed/);
    await expect(setObjectStatus(client, "510", "ACTIVE")).rejects.toThrow(/meta_read_failed/);
    await expect(client.post("500", { daily_budget: "100" })).rejects.toThrow(/unsupported_write/);
    expect(meta.writes).toHaveLength(0);
    expect(decisions.map((decision) => decision.reason)).toEqual(["meta_read_failed", "meta_read_failed", "unsupported_write"]);
    // A listed ad still activates through the ad lookup.
    await setObjectStatus(client, "300", "ACTIVE");
    expect(meta.writes.map((call) => [call.path, call.body.status])).toEqual([["300", "ACTIVE"]]);
  });

  it("refuses budget fields the projection does not model, also on a PAUSED create", async () => {
    const meta = ollolaMeta("10.00", "100");
    const { client, decisions } = rig(meta, true);
    const specs = JSON.stringify([{ budget_value: 100000, time_start: 1, time_end: 2 }]);
    await expect(client.post(`${ACT}/adsets`, { name: "x", status: "PAUSED", daily_budget: "100", budget_schedule_specs: specs })).rejects.toThrow(
      /unsupported_write: .*budget_schedule_specs/,
    );
    await expect(client.post(`${ACT}/campaigns`, { name: "x", status: "ACTIVE", adset_budgets: "[]" })).rejects.toThrow(/unsupported_write/);
    await expect(client.post("200", { budget_schedule_specs: specs })).rejects.toThrow(/unsupported_write/);
    expect(meta.writes).toHaveLength(0);
    expect(decisions.every((decision) => decision.reason === "unsupported_write")).toBe(true);
  });

  it("refuses when a Meta read fails during the check", async () => {
    const meta = ollolaMeta("10.00", "100");
    meta.fail = (call) => (call.path.endsWith("/insights") ? new Error("socket hang up") : null);
    const { client } = rig(meta, true);
    await expect(setObjectStatus(client, "300", "ACTIVE")).rejects.toThrow(/meta_read_failed/);
    expect(meta.writes).toHaveLength(0);
  });

  it("classifies creates and node writes", () => {
    const plan = (path: string, fields: Record<string, unknown>) => ({ companyId: "c", mode: "live" as const, method: "POST" as const, path, fields });
    expect(classifySpendWrite(plan(`${ACT}/adsets`, { name: "a", status: "ACTIVE", daily_budget: "322" }), ACT)).toEqual({
      ok: true,
      change: { objectId: null, level: "adset", activate: true, dailyBudgetCents: 322 },
    });
    expect(classifySpendWrite(plan("200", { status: "ACTIVE" }), ACT)).toEqual({
      ok: true,
      change: { objectId: "200", level: null, activate: true },
    });
    expect(classifySpendWrite(plan("200", { daily_budget: "12.5" }), ACT)).toMatchObject({ ok: false });
    expect(classifySpendWrite(plan("200", { status: "ARCHIVED" }), ACT)).toMatchObject({ ok: false });
    expect(classifySpendWrite(plan(`${ACT}/ads`, { name: "a", status: "ACTIVE", daily_budget: "1" }), ACT)).toMatchObject({ ok: false });
  });
});
