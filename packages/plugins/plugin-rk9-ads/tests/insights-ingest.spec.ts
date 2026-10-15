import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { parseBrandConfig, type BrandConfig } from "../src/config.js";
import { buildDigest, digestTickBrand, type DigestDeps } from "../src/digest/run.js";
import {
  closeMarkerKey,
  fetchAdDays,
  INSIGHTS_WARNING_KIND,
  runInsights,
  toDayRow,
  type InsightsDeps,
} from "../src/insights/ingest.js";
import { createFatigueIssues, fatigueIssueKey } from "../src/insights/fatigue-issues.js";
import { monthToDate } from "../src/insights/mtd.js";
import { createInsightsStore, type InsightDayRow, type InsightsStore } from "../src/insights/store.js";
import { useCompanySecrets } from "../src/kit/testing/harness.js";
import manifest from "../src/manifest.js";
import { GraphHealth, MetaGraphClient } from "../src/meta/graph.js";
import { linkCpc } from "../src/metrics/cpc.js";
import plugin from "../src/worker.js";
import { EMBEDDED_PG_TIMEOUT_MS, embeddedPostgresSupport, startPluginTestDatabase, type PluginTestDatabase } from "./helpers/embedded-pg.js";
import { brandConfig, PACKAGE_ROOT, SECRET_A_BOT, SECRET_A_META, SECRET_B_META, secretRef } from "./fixtures.js";
import { FakeGraph, fixture, type FixtureResponse } from "./meta/fake-graph.js";

const SUNSPOT_ACT = "act_1336862981968191";
const OLL_ACT = "act_29231592883113369";
const AD_1 = "120248676310950775";
const AD_2 = "120248676310950776";
const AD_B = "120248676310950900";
const TOKEN_A = "tok-a-fake-meta-token-for-tests";
const TOKEN_B = "tok-b-fake-meta-token-for-tests";

interface SunspotFixture {
  date: string;
  accountLevel: { data: Array<Record<string, unknown>> };
  adLevel: { data: Array<Record<string, unknown>> };
}

function loadSunspot(date: string): SunspotFixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/insights/sunspot-${date}.json`, import.meta.url), "utf8")) as SunspotFixture;
}

function ok(body: unknown): FixtureResponse {
  return { status: 200, headers: { "facebook-api-version": "v23.0" }, body };
}

function graphError(status: number, code: number, message: string): FixtureResponse {
  return { status, headers: { "facebook-api-version": "v23.0" }, body: { error: { message, type: "OAuthException", code } } };
}

function account(timezone = "Europe/Helsinki", amountSpent = "4510"): FixtureResponse {
  return ok({ currency: "EUR", timezone_name: timezone, spend_cap: "10000", amount_spent: amountSpent, account_status: 1 });
}

function adDay(adId: string, date: string, spend: string, impressions: number, linkClicks: number, extra: Record<string, unknown> = {}) {
  return {
    ad_id: adId,
    adset_id: "120247250925850775",
    campaign_id: "120247250925830775",
    date_start: date,
    date_stop: date,
    spend,
    impressions: String(impressions),
    clicks: String(linkClicks * 2),
    inline_link_clicks: String(linkClicks),
    reach: String(Math.round(impressions / 1.2)),
    frequency: "1.2",
    ...extra,
  };
}

function enabled(raw: Record<string, unknown>): BrandConfig {
  const parsed = parseBrandConfig(raw);
  if (parsed.state !== "enabled") throw new Error(`fixture config is ${parsed.state}: ${JSON.stringify(parsed)}`);
  return parsed.config;
}

const TELEGRAM = { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-100111", allowedUserIds: ["42"] };

describe("toDayRow and the Sunspot SOP parity (recorded, read-only)", () => {
  for (const date of ["2026-08-21", "2026-09-15"]) {
    it(`matches the SOP's spend, impressions, link clicks and CPC for ${date}`, () => {
      const recorded = loadSunspot(date);
      const sop = recorded.accountLevel.data[0]!;
      const rows = recorded.adLevel.data
        .map((raw) => toDayRow(raw, { brandCode: "AUR", currency: "EUR", withActions: false, finalBefore: date }))
        .filter((row): row is InsightDayRow => row !== null);
      const spend = rows.reduce((total, row) => total + row.spendCents, 0);
      const clicks = rows.reduce((total, row) => total + row.inlineLinkClicks, 0);
      expect(spend).toBe(Math.round(Number(sop.spend) * 100));
      expect(rows.reduce((total, row) => total + row.impressions, 0)).toBe(Number(sop.impressions));
      expect(clicks).toBe(Number(sop.inline_link_clicks));
      // The SOP prints spend / inline_link_clicks with two decimals.
      expect(linkCpc(spend, clicks)!.toFixed(2)).toBe((Number(sop.spend) / Number(sop.inline_link_clicks)).toFixed(2));
      // Meta's own cpc (all clicks) differs, which is why it is not used.
      expect(rows[0]!.cpc).not.toBeCloseTo(Number(sop.spend) / rows[0]!.clicks, 3);
    });
  }

  it("skips rows without an ad id or date and keeps actions only with a dataset", () => {
    const raw = adDay(AD_1, "2026-10-14", "1.00", 100, 2, { actions: [{ action_type: "link_click", value: "2" }] });
    expect(toDayRow({ ...raw, ad_id: undefined }, { brandCode: "OLL", currency: "EUR", withActions: true, finalBefore: "2026-10-01" })).toBeNull();
    expect(toDayRow(raw, { brandCode: "OLL", currency: "EUR", withActions: false, finalBefore: "2026-10-01" })!.actions).toEqual([]);
    expect(toDayRow(raw, { brandCode: "OLL", currency: "EUR", withActions: true, finalBefore: "2026-10-01" })!.actions).toHaveLength(1);
  });
});

describe("fetchAdDays field fallback (no DB)", () => {
  it("skips a field Meta rejects and keeps the others", async () => {
    const fake = new FakeGraph(
      graphError(400, 100, "(#100) frequency is not valid"),
      ok({ data: [adDay(AD_1, "2026-10-14", "2.00", 400, 8, { reach: undefined, frequency: undefined })] }),
      ok({ data: [{ ad_id: AD_1, date_start: "2026-10-14", date_stop: "2026-10-14", reach: "333" }] }),
      graphError(400, 100, "(#100) frequency is not valid"),
    );
    const client = new MetaGraphClient({
      companyId: "11111111-1111-4111-8111-111111111111",
      tokenRef: secretRef(SECRET_A_META) as never,
      http: { fetch: fake.fetch },
      secrets: { resolve: async () => "tok" },
      mode: "readOnly",
      retry: { maxAttempts: 1 },
      sleep: async () => {},
      health: new GraphHealth(),
    });
    const result = await fetchAdDays(client, OLL_ACT, { since: "2026-10-14", until: "2026-10-14" }, ["reach", "frequency"]);
    expect(result.skipped).toEqual(["frequency"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.reach).toBe("333");
    expect(fake.calls.map((call) => new URL(call.url).searchParams.get("fields"))).toEqual([
      "ad_id,adset_id,campaign_id,spend,impressions,clicks,inline_link_clicks,reach,frequency",
      "ad_id,adset_id,campaign_id,spend,impressions,clicks,inline_link_clicks",
      "ad_id,reach",
      "ad_id,frequency",
    ]);
    expect(fake.nonGetCalls).toEqual([]);
    const first = new URL(fake.calls[0]!.url).searchParams;
    expect(first.get("level")).toBe("ad");
    expect(first.get("time_increment")).toBe("1");
    expect(JSON.parse(first.get("time_range")!)).toEqual({ since: "2026-10-14", until: "2026-10-14" });
  });
});

const support = await embeddedPostgresSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres insights tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("insights ingest and digest on real Postgres", () => {
  let testDb: PluginTestDatabase;
  let store: InsightsStore;
  let companyA: string;
  let companyB: string;
  let configA: BrandConfig;
  let configB: BrandConfig;
  let harness: TestHarness;
  let fake: FakeGraph;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-insights-" });
    await testDb.applyMigrations();
    store = createInsightsStore(testDb.client);
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
    configA = enabled(
      brandConfig({ displayName: "Ololla", telegram: TELEGRAM, meta: { adAccountId: OLL_ACT, pageId: "1284777064729996", accessTokenRef: secretRef(SECRET_A_META) } }),
    );
    configB = enabled(
      brandConfig({ brandCode: "AUR", displayName: "Sunspot", meta: { adAccountId: SUNSPOT_ACT, pageId: "1", accessTokenRef: secretRef(SECRET_B_META) } }),
    );
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  beforeEach(async () => {
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.insights_daily`);
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.digest_runs`);
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.alert_dedupe`);
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.rule_actions`);
    // issues.read only so the test can list what was created; the plugin itself has no such capability.
    harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issues.read"] });
    fake = new FakeGraph();
    harness.ctx.http.fetch = fake.fetch as typeof harness.ctx.http.fetch;
    useCompanySecrets(harness, { [companyA]: { [SECRET_A_META]: TOKEN_A }, [companyB]: { [SECRET_B_META]: TOKEN_B } });
  });

  function deps(now: string, telegram: DigestDeps["telegram"] = () => null): DigestDeps & { listConfigs: () => Promise<never> } {
    const base: InsightsDeps = {
      ctx: harness.ctx,
      store,
      now: () => new Date(now),
      clientOptions: { retry: { maxAttempts: 1 }, sleep: async () => {}, health: new GraphHealth() },
    };
    return {
      ...base,
      telegram,
      drift: () => null,
      listConfigs: (async () => [
        { companyId: companyA, companyName: "Ololla", result: { state: "enabled", config: configA } },
        { companyId: companyB, companyName: "Sunspot", result: { state: "enabled", config: configB } },
      ]) as never,
    };
  }

  async function storedRows(companyId: string) {
    return testDb.adminQuery<Record<string, unknown>>(
      `SELECT ad_id, to_char(date, 'YYYY-MM-DD') AS date, spend::text, impressions::text, reach::text, frequency::text, clicks::text,
              inline_link_clicks::text, ctr::text, cpc::text, cpm::text, actions::text, is_final
         FROM ${testDb.namespace}.insights_daily WHERE company_id = $1 ORDER BY ad_id, date`,
      [companyId],
    );
  }

  it("upserts by (company, ad, date) and gives identical rows on a re-run", async () => {
    const window = [adDay(AD_1, "2026-10-14", "3.21", 812, 11), adDay(AD_2, "2026-10-14", "0.70", 150, 1), adDay(AD_1, "2026-10-15", "1.05", 200, 3)];
    const run = async () => {
      fake.push(account(), ok({ data: window }), account(), ok({ data: [] }));
      return runInsights(deps("2026-10-15T09:00:00Z"), "hourly");
    };
    const first = await run();
    const before = await storedRows(companyA);
    const second = await run();
    const after = await storedRows(companyA);
    expect(first.map((r) => [r.brandCode, r.ok, r.rows])).toEqual([["OLL", true, 3], ["AUR", true, 0]]);
    expect(second.map((r) => r.rows)).toEqual([3, 0]);
    expect(after).toEqual(before);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatchObject({ ad_id: AD_1, date: "2026-10-14", spend: "3.21", impressions: "812", inline_link_clicks: "11", cpc: "0.2918" });
    expect(await store.countDays(companyB, "2026-10-01", "2026-10-31")).toBe(0);
    // Hourly reads yesterday and today in the account zone.
    const range = JSON.parse(new URL(fake.calls[1]!.url).searchParams.get("time_range")!);
    expect(range).toEqual({ since: "2026-10-14", until: "2026-10-15" });
  });

  it("keeps one row when Meta repeats an (ad, date) in one window", async () => {
    fake.push(account(), ok({ data: [adDay(AD_1, "2026-10-15", "1.00", 100, 1), adDay(AD_1, "2026-10-15", "2.00", 200, 2)] }), account(), ok({ data: [] }));
    const results = await runInsights(deps("2026-10-15T09:00:00Z"), "hourly");
    expect(results[0]!.ok).toBe(true);
    expect((await storedRows(companyA)).map((row) => row.spend)).toEqual(["2.00"]);
  });

  it("isolates brands: a Graph 500 for A is a warning and B still ingests", async () => {
    fake.push(account(), graphError(500, 2, "An unexpected error has occurred"), account(), ok({ data: [adDay(AD_B, "2026-10-15", "2.00", 300, 4)] }));
    const results = await runInsights(deps("2026-10-15T09:00:00Z"), "hourly");
    expect(results.map((r) => [r.brandCode, r.ok, r.warning ?? null])).toEqual([["OLL", false, "graph"], ["AUR", true, null]]);
    expect(await storedRows(companyB)).toHaveLength(1);
    expect(await storedRows(companyA)).toHaveLength(0);
    const warnings = await store.recentMarks(companyA, INSIGHTS_WARNING_KIND, 24);
    expect(warnings.map((w) => w.metadata.code)).toEqual(["graph"]);
    expect(await store.recentMarks(companyB, INSIGHTS_WARNING_KIND, 24)).toEqual([]);
  });

  it("records an invalid token (190) as a token warning only", async () => {
    fake.push(fixture("error-190", TOKEN_A), account(), ok({ data: [] }));
    const results = await runInsights(deps("2026-10-15T09:00:00Z"), "hourly");
    expect(results.map((r) => [r.ok, r.warning ?? null])).toEqual([[false, "token"], [true, null]]);
    expect(JSON.stringify(await store.recentMarks(companyA, INSIGHTS_WARNING_KIND, 24))).not.toContain(TOKEN_A);
  });

  it("close re-pulls a bounded 7-day window up to yesterday and marks old days final", async () => {
    fake.push(account(), ok({ data: [adDay(AD_1, "2026-10-08", "1.00", 100, 1), adDay(AD_1, "2026-10-14", "1.00", 100, 1)] }), account(), ok({ data: [] }));
    await runInsights(deps("2026-10-15T09:00:00Z"), "close");
    expect(JSON.parse(new URL(fake.calls[1]!.url).searchParams.get("time_range")!)).toEqual({ since: "2026-10-08", until: "2026-10-14" });
    const rows = await storedRows(companyA);
    expect(rows.map((row) => [row.date, row.is_final])).toEqual([["2026-10-08", true], ["2026-10-14", false]]);
  });

  it("computes MTD in the ad account time zone", async () => {
    const rows = (date: string, spend: string) => toDayRow(adDay(AD_1, date, spend, 100, 1), { brandCode: "OLL", currency: "EUR", withActions: false, finalBefore: "2026-01-01" })!;
    await store.upsertDays(companyA, [rows("2026-09-29", "3.21"), rows("2026-09-30", "0.70"), rows("2026-10-01", "8.24")]);
    // 2026-10-01 05:00Z is Oct 1 in Helsinki but still Sep 30 in Los Angeles.
    const now = new Date("2026-10-01T05:00:00Z");
    const helsinki = await monthToDate(store, companyA, { now, accountTimeZone: "Europe/Helsinki", monthlyCapEur: 100 });
    const losAngeles = await monthToDate(store, companyA, { now, accountTimeZone: "America/Los_Angeles", monthlyCapEur: 100 });
    expect(helsinki).toMatchObject({ today: "2026-10-01", mtdCents: 824, projectedCents: null });
    expect(losAngeles).toMatchObject({ today: "2026-09-30", mtdCents: 391, completeDays: 29 });
    // Same company, other tenant untouched.
    expect(await store.spendCents(companyB, "2026-09-01", "2026-10-31")).toBe(0);
  });

  describe("digest", () => {
    const due = "2026-10-15T05:00:00Z"; // 08:00 Helsinki
    const sent: Array<{ chat_id: string | number; text: string }> = [];
    let failSends = 0;
    const telegram: DigestDeps["telegram"] = () => ({
      chatId: "-100111",
      api: {
        sendMessage: async (params) => {
          if (failSends > 0) {
            failSends -= 1;
            throw new Error("Telegram 502");
          }
          sent.push({ chat_id: params.chat_id, text: params.text });
          return { message_id: 900 + sent.length, chat: { id: -100111, type: "group" }, date: 0 } as never;
        },
      },
    });

    beforeEach(async () => {
      sent.length = 0;
      failSends = 0;
      const day = (company: string, adId: string, spend: string, impressions: number, clicks: number, brand: string) =>
        store.upsertDays(company, [
          toDayRow(adDay(adId, "2026-10-14", spend, impressions, clicks), { brandCode: brand, currency: "EUR", withActions: false, finalBefore: "2026-10-01" })!,
        ]);
      await day(companyA, AD_1, "3.21", 812, 11, "OLL");
      await day(companyB, AD_B, "50.00", 9999, 77, "AUR");
    });

    function queueDigestGraph(names: Array<{ id: string; name: string }> = [{ id: AD_1, name: "Syysreel 1" }], amountSpent = "321") {
      fake.push(
        account("Europe/Helsinki", amountSpent),
        ok({ data: names.map((ad) => ({ id: ad.id, name: ad.name, status: "ACTIVE", effective_status: "ACTIVE", adset_id: "1", campaign_id: "2", creative: { id: "3" } })) }),
      );
    }

    it("is not sent before digest.time in Helsinki", async () => {
      expect(await digestTickBrand(deps("2026-10-15T04:00:00Z", telegram), companyA, configA)).toBe("not_due");
      expect(await testDb.adminQuery(`SELECT 1 FROM ${testDb.namespace}.digest_runs`)).toHaveLength(0);
    });

    it("sends once per brand per Helsinki date and shows only that brand's figures", async () => {
      queueDigestGraph();
      expect(await digestTickBrand(deps(due, telegram), companyA, configA)).toBe("sent");
      expect(await digestTickBrand(deps("2026-10-15T05:15:00Z", telegram), companyA, configA)).toBe("done");
      expect(sent).toHaveLength(1);
      const text = sent[0]!.text;
      expect(text).toContain("📊 Ololla · mainosraportti 14.10.2026");
      expect(text).toContain("Eilen: 3,21 € · 812 näyttöä · 22 klikkiä · 11 linkkiklikkiä");
      expect(text).toContain("Aktiivisia mainoksia: 1");
      expect(text).not.toContain("50,00");
      expect(text).not.toContain(AD_B);
      const runs = await testDb.adminQuery<Record<string, unknown>>(
        `SELECT company_id, to_char(digest_date, 'YYYY-MM-DD') AS d, status, attempts, message_id::text FROM ${testDb.namespace}.digest_runs`,
      );
      expect(runs).toEqual([{ company_id: companyA, d: "2026-10-15", status: "sent", attempts: 1, message_id: "901" }]);
      // Graph reads for A only, with A's account.
      expect(fake.calls.every((call) => call.url.includes("29231592883113369"))).toBe(true);
      expect(fake.nonGetCalls).toEqual([]);
    });

    it("records a failed send and retries it later without a double send", async () => {
      failSends = 1;
      queueDigestGraph();
      expect(await digestTickBrand(deps(due, telegram), companyA, configA)).toBe("failed");
      // The next tick is too soon for a retry.
      expect(await digestTickBrand(deps("2026-10-15T05:01:00Z", telegram), companyA, configA)).toBe("busy");
      await testDb.adminQuery(
        `UPDATE ${testDb.namespace}.digest_runs SET updated_at = now() - interval '11 minutes' WHERE company_id = $1`,
        [companyA],
      );
      queueDigestGraph();
      expect(await digestTickBrand(deps("2026-10-15T05:15:00Z", telegram), companyA, configA)).toBe("sent");
      expect(await digestTickBrand(deps("2026-10-15T05:30:00Z", telegram), companyA, configA)).toBe("done");
      expect(sent).toHaveLength(1);
      const [run] = await testDb.adminQuery<Record<string, unknown>>(`SELECT status, attempts, error FROM ${testDb.namespace}.digest_runs`);
      expect(run).toMatchObject({ status: "sent", attempts: 2, error: null });
    });

    it("does not claim an attempt while the bot is not ready", async () => {
      expect(await digestTickBrand(deps(due, () => null), companyA, configA)).toBe("telegram_not_ready");
      expect(await testDb.adminQuery(`SELECT 1 FROM ${testDb.namespace}.digest_runs`)).toHaveLength(0);
    });

    it("re-claims a row left pending by a worker restart after the retry delay", async () => {
      await store.ensureDigestRun(companyA, "OLL", "2026-10-15");
      expect(await store.claimDigestRun(companyA, "2026-10-15", 5, 10)).toBe(true);
      // The worker died here: the row stays pending with attempts = 1.
      expect(await digestTickBrand(deps("2026-10-15T05:05:00Z", telegram), companyA, configA)).toBe("busy");
      await testDb.adminQuery(
        `UPDATE ${testDb.namespace}.digest_runs SET updated_at = now() - interval '11 minutes' WHERE company_id = $1`,
        [companyA],
      );
      queueDigestGraph();
      expect(await digestTickBrand(deps("2026-10-15T05:20:00Z", telegram), companyA, configA)).toBe("sent");
      expect(sent).toHaveLength(1);
    });

    it("keeps a delivered digest out of the retry path when the sent write fails", async () => {
      queueDigestGraph();
      const flaky = { ...store, finishDigestRun: async () => { throw new Error("db down"); } };
      const result = await digestTickBrand({ ...deps(due, telegram), store: flaky }, companyA, configA);
      expect(result).toBe("sent");
      expect(sent).toHaveLength(1);
      const [run] = await testDb.adminQuery<Record<string, unknown>>(`SELECT status FROM ${testDb.namespace}.digest_runs`);
      expect(run).toMatchObject({ status: "pending" });
    });

    it("skips a quiet zero-spend day in silent mode and does not send", async () => {
      const silent = { ...configA, digest: { ...configA.digest, zeroSpendMode: "silent" as const } };
      await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.insights_daily WHERE company_id = $1`, [companyA]);
      await store.markOnce(companyA, closeMarkerKey("2026-10-15"), "insights_close");
      queueDigestGraph([], "0");
      expect(await digestTickBrand(deps(due, telegram), companyA, silent)).toBe("skipped");
      expect(sent).toHaveLength(0);
      expect(await digestTickBrand(deps("2026-10-15T06:00:00Z", telegram), companyA, silent)).toBe("done");
    });

    it("digest.dryRun returns the text and writes nothing", async () => {
      const dry = createTestHarness({ manifest });
      Object.assign(dry.ctx, { db: testDb.client });
      dry.ctx.http.fetch = fake.fetch as typeof dry.ctx.http.fetch;
      useCompanySecrets(dry, { [companyA]: { [SECRET_A_META]: TOKEN_A } });
      dry.ctx.config.get = async (companyId?: string) => (companyId === companyA ? (brandConfig({ displayName: "Ololla" }) as never) : ({} as never));
      await plugin.definition.setup(dry.ctx);
      queueDigestGraph();
      const result = await dry.performAction<{ text: string; summary: Record<string, unknown> }>("digest.dryRun", {}, { companyId: companyA });
      expect(result.text).toContain("Eilen:");
      expect(await testDb.adminQuery(`SELECT 1 FROM ${testDb.namespace}.digest_runs`)).toHaveLength(0);
      expect(await testDb.adminQuery(`SELECT 1 FROM ${testDb.namespace}.alert_dedupe`)).toHaveLength(0);
      expect(await dry.performAction("digest.dryRun", {}, { companyId: null })).toEqual({ error: "This action needs a company context" });
      await plugin.definition.onShutdown?.();
    });

    it("buildDigest lists warnings: token, missing close and spend_cap reset", async () => {
      await store.markOnce(companyA, "insights-warning:2026-10-15:token", INSIGHTS_WARNING_KIND, { code: "token", message: "x" });
      // amount_spent 60 EUR vs MTD 3.21 EUR: the 1st-of-month reset looks missing.
      fake.push(account("Europe/Helsinki", "6000"), ok({ data: [] }));
      const built = await buildDigest(deps(due, telegram), companyA, configA);
      expect(built.input.warnings).toEqual([
        expect.stringContaining("nollaus näyttää puuttuvan"),
        "Meta-token ei kelpaa (190), insights-haku epäonnistui",
        "Eilisen luvut voivat olla vajaat: päivän sulkuajo ei ole vielä onnistunut",
      ]);
    });
  });

  describe("fatigue issues", () => {
    const fatiguedAd = { adId: AD_1, result: { status: "fatigued" as const, signals: ["ctr_decay", "cpc_rise"] as never, reasons: ["ctr_decay: x"], metrics: {} as never } };

    it("creates nothing while the flag is off (default)", async () => {
      const created = await createFatigueIssues({ ctx: harness.ctx, store, pluginId: "rk9-ads" }, companyA, configA, [fatiguedAd]);
      expect(created).toEqual([]);
      expect(await harness.ctx.issues.list({ companyId: companyA })).toEqual([]);
    });

    it("creates at most one issue per (company, ad) in the brand's company", async () => {
      const on = { ...configA, fatigue: { ...configA.fatigue, issuesEnabled: true } };
      const ctx = harness.ctx;
      expect(await createFatigueIssues({ ctx, store, pluginId: "rk9-ads" }, companyA, on, [fatiguedAd])).toEqual([AD_1]);
      expect(await createFatigueIssues({ ctx, store, pluginId: "rk9-ads" }, companyA, on, [fatiguedAd])).toEqual([]);
      const issues = await ctx.issues.list({ companyId: companyA });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ companyId: companyA, originKind: "plugin:rk9-ads", originId: fatigueIssueKey(AD_1) });
      expect(await store.hasMark(companyB, fatigueIssueKey(AD_1))).toBe(false);
    });

    it("removes the marker when the create fails, so the next run retries", async () => {
      const on = { ...configA, fatigue: { ...configA.fatigue, issuesEnabled: true } };
      const failing = { ...harness.ctx, issues: { ...harness.ctx.issues, create: async () => { throw new Error("boom"); } } };
      expect(await createFatigueIssues({ ctx: failing as never, store, pluginId: "rk9-ads" }, companyA, on, [fatiguedAd])).toEqual([]);
      expect(await store.hasMark(companyA, fatigueIssueKey(AD_1))).toBe(false);
    });
  });
});
