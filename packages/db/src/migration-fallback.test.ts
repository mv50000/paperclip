import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// RK9-311: client.ts identifies applied migrations by sha256 hash and falls back to created_at
// only when NO hash resolves. These tests build a prod-like history (fork 9xxx applied, the two
// newest upstream migrations 0071/0072 still pending), then damage the recorded hashes the way a
// reformatted checkout or an edited 9xxx file would, and pin what the driver does.

const cleanups: Array<() => Promise<void>> = [];
// Runs on embedded Postgres, or on a host Postgres unix socket when PAPERCLIP_TEST_PGHOST is set
// (hosts without the embedded runtime's ICU libraries). The host database is a throwaway
// paperclip_migdryrun_t* scratch database and is dropped afterwards.
const hostSocket = process.env.PAPERCLIP_TEST_PGHOST;
const support = hostSocket ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

async function createDatabase(): Promise<string> {
  if (!hostSocket) {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-migration-fallback-");
    cleanups.push(db.cleanup);
    return db.connectionString;
  }
  const name = `paperclip_migdryrun_t${process.pid}${Date.now() % 100000}`;
  const admin = postgres("postgres:///postgres", { max: 1, host: hostSocket, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  cleanups.push(async () => {
    const dropper = postgres("postgres:///postgres", { max: 1, host: hostSocket, onnotice: () => {} });
    await dropper.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await dropper.end();
  });
  return `postgres:///${name}`; // host from PGHOST
}

const STRANDED_INDEX = "issues_active_stranded_issue_recovery_uq"; // created by 0072
const MIGRATIONS = "drizzle.__drizzle_migrations";

function hashOf(file: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8"))
    .digest("hex");
}

async function prodLikeDatabase(): Promise<{ url: string; sql: postgres.Sql }> {
  const url = await createDatabase();
  await applyPendingMigrations(url);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  // Rewind 0071 and 0072: history rows out, effects undone, so both are genuinely pending.
  await sql.unsafe(`DELETE FROM ${MIGRATIONS} WHERE hash IN ('${hashOf("0071_default_hire_approval_off.sql")}', '${hashOf("0072_large_sandman.sql")}')`);
  await sql.unsafe(`DROP INDEX IF EXISTS "${STRANDED_INDEX}"`);
  await sql.unsafe(`ALTER TABLE "companies" ALTER COLUMN "require_board_approval_for_new_agents" SET DEFAULT true`);
  return { url, sql };
}

async function indexPresent(sql: postgres.Sql): Promise<boolean> {
  const rows = await sql`select 1 from pg_indexes where schemaname = 'public' and indexname = ${STRANDED_INDEX}`;
  return rows.length > 0;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("migration history identity (RK9-311)", () => {
  it("runs pending upstream migrations when every recorded hash resolves", async () => {
    const { url, sql } = await prodLikeDatabase();
    try {
      const state = await inspectMigrations(url);
      expect(state).toMatchObject({ status: "needsMigrations", reason: "pending-migrations" });
      if (state.status === "needsMigrations") {
        expect(state.pendingMigrations).toEqual(["0071_default_hire_approval_off.sql", "0072_large_sandman.sql"]);
      }
      await applyPendingMigrations(url);
      expect(await indexPresent(sql)).toBe(true);
      expect((await inspectMigrations(url)).status).toBe("upToDate");
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("executes upstream migrations and fails loudly when one edited fork file is replayed", async () => {
    const { url, sql } = await prodLikeDatabase();
    try {
      const forkTable = await sql`select count(*)::int as n from risk_categories`;
      // An edited 9001 file hashes differently from what prod recorded: it looks pending again.
      await sql.unsafe(`UPDATE ${MIGRATIONS} SET hash = 'edited-file-hash' WHERE hash = '${hashOf("9001_rk9_risk_management.sql")}'`);
      const state = await inspectMigrations(url);
      expect(state.status === "needsMigrations" && state.pendingMigrations).toContain("9001_rk9_risk_management.sql");

      // 9001 is plain CREATE TABLE, so the replay throws (loud) instead of silently re-running.
      await expect(applyPendingMigrations(url)).rejects.toThrow();
      // The upstream migrations before it did run: nothing was skipped.
      expect(await indexPresent(sql)).toBe(true);
      const after = await sql`select count(*)::int as n from risk_categories`;
      expect(after[0].n).toBe(forkTable[0].n);
    } finally {
      await sql.end();
    }
  }, 60_000);

  // KNOWN DEFECT (client.ts loadAppliedMigrations, created_at fallback): when no recorded hash
  // resolves (e.g. every file re-hashes differently after a line-ending rewrite), the driver takes
  // the first `rows.length` journal entries as applied. Those are upstream entries that never ran,
  // and it then treats the tail of the fork's 9xxx entries as pending. This test states the SAFE
  // behavior and is expected to fail until the driver is fixed; then remove `.fails`.
  it.fails("does not mark unexecuted upstream migrations as applied when no hash resolves", async () => {
    const { url, sql } = await prodLikeDatabase();
    try {
      await sql.unsafe(`UPDATE ${MIGRATIONS} SET hash = 'unresolved-' || id`);
      try {
        await applyPendingMigrations(url);
      } catch {
        // A loud failure is acceptable; a silent skip is not.
      }
      expect(await indexPresent(sql)).toBe(true);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
