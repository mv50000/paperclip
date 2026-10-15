/**
 * The once-only markers on real Postgres (A6, RK9-511): alert and
 * scheduled-pause dedupe survives a worker restart (a new ledger on the same
 * database), resets with the month key, and stays per company.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLedger } from "../../src/db.js";
import { alertedThresholds, alertKey, SPEND_ALERT_KIND } from "../../src/features/spend-guard/alerts.js";
import { sqlOnceStore } from "../../src/features/spend-guard/support.js";
import manifest from "../../src/manifest.js";
import { PACKAGE_ROOT } from "../fixtures.js";
import {
  EMBEDDED_PG_TIMEOUT_MS,
  embeddedPostgresSupport,
  startPluginTestDatabase,
  type PluginTestDatabase,
} from "../helpers/embedded-pg.js";

const support = await embeddedPostgresSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres once-store tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("alert dedupe on real Postgres", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-once-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  }, EMBEDDED_PG_TIMEOUT_MS);

  it("claims a threshold once per month, across a worker restart, per company", async () => {
    const october80 = alertKey("OLL", "2026-10", 80);
    const first = sqlOnceStore(createLedger(testDb.client));
    expect(await first.claim(companyA, october80, SPEND_ALERT_KIND, { pct: 81 })).toBe(true);
    expect(await first.claim(companyA, october80, SPEND_ALERT_KIND)).toBe(false);

    // Worker restart: a fresh ledger and store on the same database.
    const restarted = sqlOnceStore(createLedger(testDb.client));
    expect(await restarted.claim(companyA, october80, SPEND_ALERT_KIND)).toBe(false);
    expect(await alertedThresholds(restarted, companyA, "OLL", "2026-10")).toEqual([80]);

    // The next month starts clean; another company has its own markers.
    expect(await restarted.claim(companyA, alertKey("OLL", "2026-11", 80), SPEND_ALERT_KIND)).toBe(true);
    expect(await restarted.claim(companyB, october80, SPEND_ALERT_KIND)).toBe(true);
    expect(await alertedThresholds(restarted, companyA, "OLL", "2026-11")).toEqual([80]);

    const rows = await testDb.adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${testDb.namespace}.alert_dedupe WHERE kind = $1`,
      [SPEND_ALERT_KIND],
    );
    expect(rows[0]?.n).toBe(3);
  });

  it("writes a rule_actions row with the guard's columns", async () => {
    const ledger = createLedger(testDb.client);
    await ledger.insert(companyA, "rule_actions", {
      brand_code: "OLL",
      rule_id: "spend-guard",
      rule_type: "pause_all_cap",
      object_type: "account",
      object_id: "29231592883113369",
      action: "none",
      mode: "live",
      source: "agent",
      dry_run: false,
      applied: false,
      reason: "projection_exceeds_cap",
      metrics: { mtdEur: 70 },
    });
    for (const [ruleType, action] of [["kill_switch", "pause_all"], ["scheduled_pause", "pause_all"], ["data_gate", "pause_all"]] as const) {
      await ledger.insert(companyA, "rule_actions", {
        brand_code: "OLL",
        rule_id: ruleType,
        rule_type: ruleType,
        object_type: "campaign",
        object_id: "100",
        action,
        mode: "live",
        source: "job",
        dry_run: false,
        applied: true,
        reason: "test",
        metrics: {},
      });
    }
    expect(await ledger.count(companyA, "rule_actions")).toBe(4);
  });
});
