/**
 * The rule engine's SQL on real Postgres (A11, RK9-515): every statement runs
 * through the host's runtime SQL validators, stays inside one company and
 * reads only migration 001 tables.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLedger } from "../src/db.js";
import { createRulesStore, type RuleActionRow } from "../src/features/rules/store.js";
import { createInsightsStore, type InsightDayRow } from "../src/insights/store.js";
import manifest from "../src/manifest.js";
import { PACKAGE_ROOT } from "./fixtures.js";
import { EMBEDDED_PG_TIMEOUT_MS, embeddedPostgresSupport, startPluginTestDatabase, type PluginTestDatabase } from "./helpers/embedded-pg.js";

const support = await embeddedPostgresSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres rules store tests: ${support.reason ?? "unsupported environment"}`);
}

function action(overrides: Partial<RuleActionRow>): RuleActionRow {
  return {
    brandCode: "OLL",
    ruleId: "cpc-ceiling",
    ruleType: "threshold_pause",
    objectType: "ad",
    objectId: "301",
    action: "pause",
    mode: "shadow",
    dryRun: true,
    applied: false,
    reason: "test",
    metrics: { cpc: 0.65 },
    error: null,
    decidedAt: new Date("2026-10-21T08:00:00Z"),
    ...overrides,
  };
}

function insightDay(adId: string, date: string, impressions: number): InsightDayRow {
  return {
    brandCode: "OLL",
    adId,
    date,
    campaignId: "100",
    adsetId: "200",
    currency: "EUR",
    spendCents: 325,
    impressions,
    reach: impressions,
    frequency: 1.1,
    clicks: 7,
    inlineLinkClicks: 5,
    ctr: null,
    cpc: null,
    cpm: null,
    actions: [],
    isFinal: true,
  };
}

describeDb("rules store on real Postgres", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-rules-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  }, EMBEDDED_PG_TIMEOUT_MS);

  it("writes rule_actions and reads the latest decision per rule, object and mode inside the window, per company", async () => {
    const store = createRulesStore(testDb.client);
    await store.insertAction(companyA, action({ decidedAt: new Date("2026-10-20T08:00:00Z") }));
    await store.insertAction(companyA, action({}));
    await store.insertAction(companyA, action({ mode: "live", dryRun: false, applied: true, decidedAt: new Date("2026-10-21T07:00:00Z") }));
    await store.insertAction(companyA, action({ ruleId: "old", decidedAt: new Date("2026-10-01T00:00:00Z") }));
    await store.insertAction(companyA, action({ ruleId: "pause_all_cap", ruleType: "pause_all_cap", objectType: "account", objectId: "1", action: "pause_all" }));
    // Not a pause: a spend alert row never counts for a cooldown.
    await store.insertAction(companyA, action({ ruleId: "pause_all_cap", ruleType: "pause_all_cap", objectType: "account", objectId: "1", action: "none", decidedAt: new Date("2026-10-21T08:30:00Z") }));
    await store.insertAction(companyB, action({ decidedAt: new Date("2026-10-21T08:45:00Z") }));

    const prior = await store.priorActions(companyA, ["cpc-ceiling", "old", "pause_all_cap"], new Date("2026-10-20T09:00:00Z"));
    expect(prior.sort((a, b) => `${a.ruleId}${a.mode}`.localeCompare(`${b.ruleId}${b.mode}`))).toEqual([
      { ruleId: "cpc-ceiling", objectId: "301", mode: "live", applied: true, decidedAt: "2026-10-21T07:00:00.000Z" },
      { ruleId: "cpc-ceiling", objectId: "301", mode: "shadow", applied: false, decidedAt: "2026-10-21T08:00:00.000Z" },
      { ruleId: "pause_all_cap", objectId: "1", mode: "shadow", applied: false, decidedAt: "2026-10-21T08:00:00.000Z" },
    ]);
    expect(await store.priorActions(companyA, [], new Date(0))).toEqual([]);
    expect(await store.priorActions(companyB, ["cpc-ceiling"], new Date(0))).toEqual([
      { ruleId: "cpc-ceiling", objectId: "301", mode: "shadow", applied: false, decidedAt: "2026-10-21T08:45:00.000Z" },
    ]);
    const rows = await testDb.adminQuery<{ source: string; dry_run: boolean; metrics: unknown }>(
      `SELECT source, dry_run, metrics FROM ${testDb.namespace}.rule_actions WHERE company_id = $1 AND rule_id = 'cpc-ceiling' AND mode = 'shadow' ORDER BY decided_at DESC LIMIT 1`,
      [companyA],
    );
    expect(rows[0]).toMatchObject({ source: "job", dry_run: true, metrics: { cpc: 0.65 } });
  });

  it("reads the creative validUntil of each ad's latest published publication, per company", async () => {
    const ledger = createLedger(testDb.client);
    async function creative(companyId: string, key: string, validUntil: string | null) {
      const { id } = await ledger.insert(companyId, "creatives", {
        brand_code: "OLL",
        sha256: key.padEnd(64, "0"),
        idempotency_key: `${companyId}-${key}`,
        kind: "image",
        media_url: `https://cdn.example/${key}.jpg`,
        valid_until: validUntil,
        status: "published",
      });
      return id;
    }
    async function publication(companyId: string, key: string, creativeId: string, adId: string, status: string, publishedAt: string) {
      await ledger.insert(companyId, "publications", {
        brand_code: "OLL",
        creative_id: creativeId,
        idempotency_key: `${companyId}-pub-${key}`,
        content_hash: key,
        status,
        meta_ad_id: adId,
        published_at: publishedAt,
      });
    }
    const old = await creative(companyA, "a1", "2026-10-01T00:00:00Z");
    const swapped = await creative(companyA, "a2", "2026-12-01T00:00:00Z");
    const noExpiry = await creative(companyA, "a3", null);
    const failed = await creative(companyA, "a4", "2026-09-01T00:00:00Z");
    await publication(companyA, "p1", old, "301", "published", "2026-10-01T00:00:00Z");
    await publication(companyA, "p2", swapped, "301", "published", "2026-10-10T00:00:00Z");
    await publication(companyA, "p3", noExpiry, "302", "published", "2026-10-10T00:00:00Z");
    await publication(companyA, "p4", failed, "303", "failed", "2026-10-10T00:00:00Z");
    const other = await creative(companyB, "b1", "2026-09-01T00:00:00Z");
    await publication(companyB, "p5", other, "901", "published", "2026-09-01T00:00:00Z");

    const store = createRulesStore(testDb.client);
    expect(await store.creativeValidity(companyA)).toEqual([{ adId: "301", validUntil: "2026-12-01T00:00:00.000Z" }]);
    expect(await store.creativeValidity(companyB)).toEqual([{ adId: "901", validUntil: "2026-09-01T00:00:00.000Z" }]);
  });

  it("reads ad-days of a date range for ads that delivered in it", async () => {
    const insights = createInsightsStore(testDb.client);
    await insights.upsertDays(companyA, [insightDay("301", "2026-10-18", 300), insightDay("301", "2026-10-19", 300), insightDay("301", "2026-10-20", 300), insightDay("302", "2026-10-20", 0)]);
    await insights.upsertDays(companyB, [insightDay("901", "2026-10-20", 300)]);
    const store = createRulesStore(testDb.client);
    expect(await store.adDays(companyA, "2026-10-19", "2026-10-20")).toEqual([
      { adId: "301", date: "2026-10-19", spendCents: 325, impressions: 300, inlineLinkClicks: 5, frequency: 1.1 },
      { adId: "301", date: "2026-10-20", spendCents: 325, impressions: 300, inlineLinkClicks: 5, frequency: 1.1 },
    ]);
  });
});
