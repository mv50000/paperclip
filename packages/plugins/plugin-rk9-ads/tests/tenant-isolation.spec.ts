import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { createLedger, LEDGER_COLUMNS, LEDGER_TABLES, type Ledger } from "../src/db.js";
import manifest from "../src/manifest.js";
import {
  EMBEDDED_PG_TIMEOUT_MS,
  embeddedPostgresSupport,
  startPluginTestDatabase,
  type PluginTestDatabase,
} from "./helpers/embedded-pg.js";
import { COMPANY_A, COMPANY_B, MIGRATION_001_FILE, PACKAGE_ROOT } from "./fixtures.js";

describe("ledger helpers (captured SQL)", () => {
  function captureLedger() {
    const harness = createTestHarness({ manifest });
    return { harness, ledger: createLedger(harness.ctx.db) };
  }

  it("binds companyId as $1 in WHERE company_id = $1 for reads", async () => {
    const { harness, ledger } = captureLedger();
    await ledger.select(COMPANY_A, "gate_requests", { where: { status: "pending", ad_id: null }, orderBy: { column: "created_at", direction: "desc" }, limit: 5 });
    await ledger.count(COMPANY_B, "insights_daily", { ad_id: "1" });
    expect(harness.dbQueries).toEqual([
      {
        sql: `SELECT * FROM ${harness.ctx.db.namespace}.gate_requests WHERE company_id = $1 AND status = $2 AND ad_id IS NULL ORDER BY created_at DESC LIMIT 5`,
        params: [COMPANY_A, "pending"],
      },
      {
        sql: `SELECT count(*)::int AS n FROM ${harness.ctx.db.namespace}.insights_daily WHERE company_id = $1 AND ad_id = $2`,
        params: [COMPANY_B, "1"],
      },
    ]);
  });

  it("binds companyId as $1 for inserts and updates", async () => {
    const { harness, ledger } = captureLedger();
    await ledger.insert(COMPANY_A, "alert_dedupe", { dedupe_key: "cap:2026-10:80", kind: "cap_alert", metadata: { pct: 80 } });
    await ledger.update(COMPANY_A, "gate_requests", { token: "t", status: "pending" }, { status: "approved" });
    const [insert, update] = harness.dbExecutes;
    expect(insert?.sql).toMatch(/^INSERT INTO \S+\.alert_dedupe \(company_id, id, dedupe_key, kind, metadata\) VALUES \(\$1, \$2, \$3, \$4, \$5\)$/);
    expect(insert?.params?.[0]).toBe(COMPANY_A);
    expect(insert?.params?.[4]).toBe('{"pct":80}');
    expect(update?.sql).toBe(
      `UPDATE ${harness.ctx.db.namespace}.gate_requests SET status = $4, updated_at = now() WHERE company_id = $1 AND token = $2 AND status = $3`,
    );
    expect(update?.params).toEqual([COMPANY_A, "t", "pending", "approved"]);
  });

  it("refuses calls that could escape the company scope", async () => {
    const { ledger } = captureLedger();
    await expect(ledger.select("", "publications")).rejects.toThrow(/companyId/);
    await expect(ledger.select("not-a-uuid", "publications")).rejects.toThrow(/companyId/);
    await expect(
      ledger.select(COMPANY_A, "publications", { where: { company_id: COMPANY_B } as never }),
    ).rejects.toThrow(/company_id comes from the companyId argument/);
    await expect(ledger.insert(COMPANY_A, "publications", { company_id: COMPANY_B } as never)).rejects.toThrow(
      /company_id comes from the companyId argument/,
    );
    await expect(ledger.update(COMPANY_A, "publications", {}, { status: "failed" })).rejects.toThrow(/at least one where/);
    await expect(
      ledger.select(COMPANY_A, "publications", { where: { "status; DROP TABLE x": 1 } as never }),
    ).rejects.toThrow(/Unknown column/);
    await expect(ledger.select(COMPANY_A, "companies" as never)).rejects.toThrow(/Unknown ledger table/);
  });
});

const support = await embeddedPostgresSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres ledger tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("ledger on real Postgres (migration 001)", () => {
  let testDb: PluginTestDatabase;
  let ledger: Ledger;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-ledger-" });
    await testDb.applyMigrations();
    ledger = createLedger(testDb.client);
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  }, EMBEDDED_PG_TIMEOUT_MS);

  it("applies 001 once, records its checksum and skips it on the next activation", async () => {
    const first = await testDb.appliedMigrations();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ migration_key: MIGRATION_001_FILE, status: "applied" });
    expect(first[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

    // A worker restart re-runs applyMigrations: it must neither fail nor re-apply.
    await testDb.applyMigrations();
    expect(await testDb.appliedMigrations()).toEqual(first);
  });

  it("creates exactly the ledger tables and columns the helpers allow", async () => {
    const rows = await testDb.adminQuery<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position",
      [testDb.namespace],
    );
    const actual: Record<string, string[]> = {};
    for (const row of rows) (actual[row.table_name] ??= []).push(row.column_name);
    const expected = Object.fromEntries(LEDGER_TABLES.map((table) => [table, [...LEDGER_COLUMNS[table]]]));
    expect(Object.keys(actual).sort()).toEqual([...LEDGER_TABLES].sort());
    for (const table of LEDGER_TABLES) expect(actual[table], table).toEqual(expected[table]);
  });

  it("gives every table a NOT NULL company_id referencing public.companies", async () => {
    const rows = await testDb.adminQuery<{ table_name: string; is_nullable: string; references_companies: boolean }>(
      `SELECT c.table_name, c.is_nullable,
              EXISTS (
                SELECT 1 FROM pg_constraint k
                JOIN pg_class t ON t.oid = k.conrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE k.contype = 'f' AND n.nspname = c.table_schema AND t.relname = c.table_name
                  AND k.confrelid = 'public.companies'::regclass
              ) AS references_companies
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.column_name = 'company_id'
       ORDER BY c.table_name`,
      [testDb.namespace],
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([...LEDGER_TABLES].sort());
    for (const row of rows) {
      expect(row.is_nullable, row.table_name).toBe("NO");
      expect(row.references_companies, row.table_name).toBe(true);
    }
  });

  it("has the unique constraints the idempotency and gate logic rely on", async () => {
    const rows = await testDb.adminQuery<{ table_name: string; columns: string }>(
      `SELECT t.relname AS table_name,
              string_agg(a.attname, ',' ORDER BY k.ordinality) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.connamespace = $1::regnamespace AND c.contype = 'u'
       GROUP BY t.relname, c.conname`,
      [testDb.namespace],
    );
    const uniques = new Set(rows.map((row) => `${row.table_name}:${row.columns}`));
    expect(uniques).toContain("publications:idempotency_key");
    expect(uniques).toContain("gate_requests:token");
    expect(uniques).toContain("insights_daily:company_id,ad_id,date");
    expect(uniques).toContain("creatives:company_id,brand_code,sha256");
    expect(uniques).toContain("digest_runs:company_id,digest_date");
    expect(uniques).toContain("processed_updates:company_id,bot_key,update_id");
  });

  it("never returns or changes company B rows through a company A call", async () => {
    const validUntil = new Date(Date.now() + 3_600_000);
    await ledger.insert(companyA, "gate_requests", { brand_code: "OLL", kind: "activate_ad", token: "token-a", valid_until: validUntil, payload: { adId: "1" } });
    const gateB = await ledger.insert(companyB, "gate_requests", { brand_code: "AUR", kind: "activate_ad", token: "token-b", valid_until: validUntil });
    await ledger.insert(companyA, "insights_daily", { brand_code: "OLL", ad_id: "ad-1", date: "2026-10-14", spend: "1.50" });
    await ledger.insert(companyB, "insights_daily", { brand_code: "AUR", ad_id: "ad-1", date: "2026-10-14", spend: "9.99" });

    const gatesA = await ledger.select<"gate_requests", { company_id: string; token: string; payload: unknown }>(companyA, "gate_requests");
    expect(gatesA.map((row) => [row.company_id, row.token])).toEqual([[companyA, "token-a"]]);
    expect(gatesA[0]?.payload).toEqual({ adId: "1" });

    // Even with B's token or row id, a company A call sees nothing.
    expect(await ledger.select(companyA, "gate_requests", { where: { token: "token-b" } })).toEqual([]);
    expect(await ledger.select(companyA, "gate_requests", { where: { id: gateB.id } })).toEqual([]);
    expect(await ledger.update(companyA, "gate_requests", { id: gateB.id, status: "pending" }, { status: "approved" })).toBe(0);
    const [stillPending] = await ledger.select<"gate_requests", { status: string }>(companyB, "gate_requests", { where: { id: gateB.id } });
    expect(stillPending?.status).toBe("pending");

    const insightsA = await ledger.select<"insights_daily", { company_id: string; spend: string }>(companyA, "insights_daily", { where: { ad_id: "ad-1" } });
    expect(insightsA.map((row) => [row.company_id, row.spend])).toEqual([[companyA, "1.50"]]);
    expect(await ledger.count(companyA, "insights_daily")).toBe(1);
    expect(await ledger.count(companyB, "insights_daily")).toBe(1);
  });

  it("refuses a link from a company A row to a company B row", async () => {
    const creativeB = await ledger.insert(companyB, "creatives", {
      brand_code: "AUR", sha256: "b".repeat(64), idempotency_key: "creative-b", kind: "image", media_url: "https://sunspot.fi/a.jpg",
    });
    await expect(
      ledger.insert(companyA, "publications", {
        brand_code: "OLL", creative_id: creativeB.id, idempotency_key: "pub-a-cross", content_hash: "h",
      }),
    ).rejects.toThrow();
    const creativeA = await ledger.insert(companyA, "creatives", {
      brand_code: "OLL", sha256: "a".repeat(64), idempotency_key: "creative-a", kind: "image", media_url: "https://ololla.fi/a.jpg",
    });
    const publication = await ledger.insert(companyA, "publications", {
      brand_code: "OLL", creative_id: creativeA.id, idempotency_key: "pub-a", content_hash: "h",
    });
    await expect(
      ledger.insert(companyB, "gate_requests", {
        brand_code: "AUR", kind: "activate_ad", token: "token-cross", publication_id: publication.id, valid_until: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  it("takes calendar dates as local strings, never as a Date", async () => {
    await expect(
      ledger.insert(companyA, "insights_daily", { brand_code: "OLL", ad_id: "ad-2", date: new Date() }),
    ).rejects.toThrow(/local YYYY-MM-DD/);
  });

  it("works as a compare-and-set and enforces the final status sets", async () => {
    const validUntil = new Date(Date.now() + 3_600_000);
    const gate = await ledger.insert(companyA, "gate_requests", { brand_code: "OLL", kind: "pause_all", token: "token-cas", valid_until: validUntil });
    expect(await ledger.update(companyA, "gate_requests", { id: gate.id, status: "pending" }, { status: "approved", decided_at: new Date() })).toBe(1);
    expect(await ledger.update(companyA, "gate_requests", { id: gate.id, status: "pending" }, { status: "denied" })).toBe(0);

    await expect(
      ledger.update(companyA, "gate_requests", { id: gate.id }, { status: "rejected" }),
    ).rejects.toThrow();
    await expect(
      ledger.insert(companyB, "gate_requests", { brand_code: "AUR", kind: "activate_ad", token: "token-cas", valid_until: validUntil }),
    ).rejects.toThrow();
  });
});
