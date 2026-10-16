/**
 * RK9-526: the morning digest and the spend guard show the same MTD, headroom,
 * remaining cap and projection for the same day, because the digest takes them
 * from a guard snapshot through the shared monthPosition. insights_daily only
 * cross-checks MTD. No database: the store is a stub.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { buildDigest, MTD_SOURCE_GAP_MIN_CENTS, sendRefused, type DigestDeps } from "../src/digest/run.js";
import { TelegramApiError } from "../src/kit/telegram/bot-api.js";
import { checkSpend, evaluateGuard } from "../src/features/spend-guard/guard.js";
import { monthPosition } from "../src/features/spend-guard/position.js";
import type { InsightsStore } from "../src/insights/store.js";
import { useCompanySecrets } from "../src/kit/testing/harness.js";
import manifest from "../src/manifest.js";
import { GraphHealth } from "../src/meta/graph.js";
import { COMPANY_A, SECRET_A_META } from "./fixtures.js";
import { FakeMeta } from "./spend-guard/fake-meta.js";
import { at, config, metaClient } from "./spend-guard/helpers.js";

const OLLOLA = config();
/** 08:00 in Helsinki on 21.10.2026: 20 complete days, 11 local days left. */
const MORNING = at("2026-10-21T05:00:00Z");
const cents = (eur: number | null) => (eur === null ? null : Math.round(eur * 100));

function stubStore(insightsMtdCents: number): InsightsStore {
  const store = {
    dayTotals: async () => ({ spendCents: 300, impressions: 900, clicks: 20, inlineLinkClicks: 10, ads: 1 }),
    spendCents: async () => insightsMtdCents,
    recentRuleActions: async () => [],
    pendingGates: async () => [],
    recentMarks: async () => [],
    hasMark: async () => true,
    recentAdSeries: async () => [],
  };
  return store as unknown as InsightsStore;
}

function ollolaMeta(mtd: string, amountSpentCents: number): FakeMeta {
  const meta = new FakeMeta();
  meta.account = { ...meta.account, spend_cap: "10000", amount_spent: String(amountSpentCents) };
  meta.spend = () => mtd;
  meta.campaigns = [{ id: "100", name: "OLL kampanja", status: "ACTIVE" }];
  meta.adsets = [{ id: "200", name: "OLL adset", status: "ACTIVE", campaign_id: "100", daily_budget: "200" }];
  meta.ads = [{ id: "300", name: "OLL ad", status: "ACTIVE", campaign_id: "100", adset_id: "200" }];
  meta.adsetSpend = [{ adset_id: "200", campaign_id: "100", spend: "0.80" }];
  return meta;
}

describe("digest and spend guard: one month position (RK9-526)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness({ manifest });
    useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: "EAAtest-meta-token-parity-000000000000" } });
  });

  function deps(meta: FakeMeta, insightsMtdCents: number): DigestDeps {
    harness.ctx.http.fetch = meta.fetch as typeof harness.ctx.http.fetch;
    return {
      ctx: harness.ctx,
      store: stubStore(insightsMtdCents),
      now: () => MORNING,
      clientOptions: { retry: { maxAttempts: 1 }, sleep: async () => {}, health: new GraphHealth() },
      telegram: () => null,
      drift: () => null,
    };
  }

  it("shows the guard's MTD, headroom, remaining cap and projection for the same day", async () => {
    const meta = ollolaMeta("42.17", 4217);
    const built = await buildDigest(deps(meta, 4217), COMPANY_A, OLLOLA);
    const guard = await checkSpend({ config: OLLOLA, client: metaClient(meta), now: MORNING });

    expect(guard.mtdEur).toBe(42.17);
    const pacing = built.input.pacing!;
    expect(pacing.source).toBe("spend_guard");
    expect(pacing.mtdCents).toBe(cents(guard.mtdEur));
    expect(pacing.remainingCents).toBe(cents(guard.remainingEur));
    expect(pacing.pctUsed).toBe(guard.pctUsed);
    expect(pacing.projectedCents).toBe(cents(guard.projectedMonthEndEur));
    expect(built.input.spendCap).toEqual({ capCents: cents(guard.spendCapEur), headroomCents: cents(guard.headroomEur) });
    // 100 - 42.17; 42.17 + (2.00 - 0.80) + 2.00 x 10.
    expect(pacing).toMatchObject({ remainingCents: 5783, projectedCents: 6337, pctUsed: 42.1 });
    expect(built.input.warnings).toEqual([]);
    expect(built.text).toContain("Kuukausi: 42,17 € / 100,00 € (42,1 %), jäljellä 57,83 €");
    expect(built.text).toContain("Ennuste kuun loppuun (nykyisillä budjeteilla): 63,37 €");
    expect(built.text).toContain("Metan kulutusraja: 100,00 €, jäljellä 57,83 €");
  });

  it("warns on the guard's rule 4 when Meta's headroom is above the remaining cap", async () => {
    // amount_spent was not reset on the 1st: Meta allows 80 EUR more, the month only 57.83 EUR.
    const meta = ollolaMeta("42.17", 2000);
    const built = await buildDigest(deps(meta, 4217), COMPANY_A, OLLOLA);
    const guard = await checkSpend({ config: OLLOLA, client: metaClient(meta), now: MORNING });

    expect(guard.risks).toContain("spend_cap_headroom_exceeds_remaining");
    expect(built.input.spendCap?.headroomCents).toBe(cents(guard.headroomEur));
    expect(built.input.warnings).toContain(
      "Metan kulutusrajaa on jäljellä 80,00 €, mutta kuukausikattoa vain 57,83 €: Meta ei pysäytä kulutusta ajoissa",
    );
  });

  it("logs and shows a gap between Graph MTD and insights_daily above the tolerance", async () => {
    const meta = ollolaMeta("42.17", 4217);
    // Within the tolerance: no warning.
    const close = await buildDigest(deps(meta, 4217 - MTD_SOURCE_GAP_MIN_CENTS), COMPANY_A, OLLOLA);
    expect(close.input.warnings).toEqual([]);
    expect(close.summary).toMatchObject({ mtdSource: "spend_guard", insightsMtdCents: 4017, mtdGapCents: -200 });

    const far = await buildDigest(deps(meta, 3000), COMPANY_A, OLLOLA);
    expect(far.input.pacing?.mtdCents).toBe(4217);
    expect(far.input.warnings).toEqual(["Kuukauden kulutus poikkeaa lähteiden välillä: Meta 42,17 €, tallennetut insightsit 30,00 €"]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ level: "warn", message: "rk9-ads digest: MTD sources differ", meta: expect.objectContaining({ gapCents: -1217 }) }),
    );
  });

  it("falls back to insights_daily, labelled, when the guard cannot read Meta", async () => {
    const meta = ollolaMeta("42.17", 4217);
    meta.fail = (call) => (call.path.endsWith("/insights") && call.params.level === "account" ? new Error("socket hang up") : null);
    const built = await buildDigest(deps(meta, 4000), COMPANY_A, OLLOLA);

    const pacing = built.input.pacing!;
    expect(pacing.source).toBe("insights");
    expect(pacing.mtdCents).toBe(4000);
    // The same monthPosition on the digest's own account read.
    const position = monthPosition({ monthlyCapEur: 100, mtdCents: 4000, spendCapCents: 10_000, amountSpentCents: 4217 });
    expect(built.input.spendCap).toEqual({ capCents: 10_000, headroomCents: position.headroomCents });
    expect(built.input.warnings[0]).toBe("Spend guardin Meta-lukua ei saatu (meta_read_failed): kuukauden luvut on laskettu tallennetuista insighteista");
    expect(built.text).toContain("(toteutuneella tahdilla)");
  });

  it("keeps the digest when the fatigue read fails, with a warning", async () => {
    const meta = ollolaMeta("42.17", 4217);
    const d = deps(meta, 4217);
    d.store = { ...d.store, recentAdSeries: async () => { throw new Error("recentAdSeries: more than 200000 rows"); } } as InsightsStore;
    const built = await buildDigest(d, COMPANY_A, OLLOLA);
    expect(built.text).not.toBeNull();
    expect(built.input.warnings).toEqual(["Mainosten väsymistä ei saatu arvioitua: recentAdSeries: more than 200000 rows"]);
  });

  it("does not compare a non-EUR account's spend_cap with the EUR cap", async () => {
    const meta = ollolaMeta("42.17", 2000);
    meta.account = { ...meta.account, currency: "SEK" };
    const built = await buildDigest(deps(meta, 4217), COMPANY_A, OLLOLA);
    expect(built.input.warnings).toEqual(["Mainostilin valuutta on SEK: spend guard estää kaikki kulutusta nostavat muutokset"]);
    expect(built.input.spendCap).toEqual({ capCents: 10_000, headroomCents: 8_000 });
  });

  it("evaluateGuard and monthPosition agree on the figures", () => {
    const input = { monthlyCapEur: 100, mtdCents: 7_001, spendCapCents: 10_000, amountSpentCents: 6_500 };
    const position = monthPosition(input);
    const guard = evaluateGuard({
      ...input,
      currency: "EUR",
      accountTimeZone: "Europe/Helsinki",
      todayCoveredCents: 0,
      dailySumCents: 0,
      lifetimeCommitCents: 0,
      month: "2026-10",
      remainingDays: 11,
    });
    expect(position).toMatchObject({ headroomCents: 3_500, remainingCents: 2_999, pctUsed: 70, headroomExceedsRemaining: true });
    expect(cents(guard.headroomEur)).toBe(position.headroomCents);
    expect(cents(guard.remainingEur)).toBe(position.remainingCents);
    expect(guard.pctUsed).toBe(position.pctUsed);
    expect(guard.reason).toBe("spend_cap_headroom_exceeds_remaining");
  });
});

describe("digest send outcome (RK9-526)", () => {
  const error = (status: number, description: string) => new TelegramApiError("sendMessage", { status, description });

  it("retries only when the message certainly did not reach Telegram", () => {
    expect(sendRefused(error(400, "Bad Request: chat not found"))).toBe(true);
    expect(sendRefused(error(429, "Too Many Requests"))).toBe(true);
    expect(sendRefused(error(0, "getaddrinfo ENOTFOUND api.telegram.org"))).toBe(true);
    expect(sendRefused(error(0, "connect ECONNREFUSED 149.154.167.220:443"))).toBe(true);
    expect(sendRefused(error(0, "socket hang up"))).toBe(false);
    expect(sendRefused(error(0, "The operation was aborted due to timeout"))).toBe(false);
    expect(sendRefused(error(502, "Bad Gateway"))).toBe(false);
    expect(sendRefused(new Error("ENOTFOUND"))).toBe(false);
  });
});
