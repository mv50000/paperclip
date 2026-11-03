// RK9 Custom (RK9-653): migration 9016 adds the `recall` token scope and the
// operator opt-in `recall_all` flag to rk9_coord_tokens. Proven against real
// Postgres: one active token per principal and scope, the flag only on a
// recall token, an idempotent replay, and the startup behaviour when another
// transaction holds a lock on the table (fail after 5 s, roll back, retry).
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "9016_rk9_coord_recall_scope.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`[rk9-coord-recall-scope-migration] embedded Postgres unsupported, suite skipped: ${support.reason ?? "unknown"}`);
}

describePostgres("RK9 coord migration 9016 (recall scope)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: postgres.Sql;
  let companyId: string;
  let n = 0;

  const row = (overrides: Record<string, unknown> = {}) => ({
    company_id: companyId,
    principal_kind: "host",
    principal_name: "mv-laptop",
    token_hash: createHash("sha256").update(`recall-${++n}`).digest("hex"),
    token_prefix: "rk9_coord_abcd",
    ...overrides,
  });

  /** Put the table back in its 9015 shape, as on a database before 9016. */
  async function revertTo9015() {
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    await sql`DELETE FROM rk9_coord_tokens`;
    await sql.unsafe(`
      ALTER TABLE "rk9_coord_tokens" DROP CONSTRAINT IF EXISTS "rk9_coord_tokens_recall_all_check";
      ALTER TABLE "rk9_coord_tokens" DROP COLUMN IF EXISTS "recall_all";
      ALTER TABLE "rk9_coord_tokens" DROP CONSTRAINT IF EXISTS "rk9_coord_tokens_scope_check";
      ALTER TABLE "rk9_coord_tokens" ADD CONSTRAINT "rk9_coord_tokens_scope_check" CHECK ("scope" in ('coord'));
      DROP INDEX IF EXISTS "rk9_coord_tokens_active_principal_uq";
      CREATE UNIQUE INDEX "rk9_coord_tokens_active_principal_uq" ON "rk9_coord_tokens" ("company_id","principal_kind","principal_name") WHERE "revoked_at" is null;
    `);
  }

  async function hasRecallAllColumn() {
    const cols = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'rk9_coord_tokens' AND column_name = 'recall_all'`;
    return cols.length === 1;
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-recall-scope-");
    sql = postgres(database.connectionString, { max: 4, onnotice: () => {} });
    companyId = randomUUID();
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Recall scope', 'RCS')`;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  it("is applied, names only rk9_coord_tokens and sets a transaction-local lock timeout", async () => {
    expect(await sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`).toHaveLength(1);
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s';");
    for (const code of statements.slice(1)) expect(code, code.slice(0, 80)).toMatch(/"rk9_coord_tokens(_[a-z_]+)?"/);
    // SET LOCAL never leaks into the session that ran the migration.
    expect((await sql`SHOW lock_timeout`)[0]!.lock_timeout).toBe("0");
  });

  it("allows one active token per principal and scope, and recall_all only on a recall token", async () => {
    await sql`INSERT INTO rk9_coord_tokens ${sql(row())}`;
    await sql`INSERT INTO rk9_coord_tokens ${sql(row({ scope: "recall", recall_all: true }))}`;
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql(row())}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_tokens_active_principal_uq" });
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql(row({ scope: "recall" }))}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_tokens_active_principal_uq" });
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql(row({ principal_name: "htpc", recall_all: true }))}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_tokens_recall_all_check" });
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql(row({ principal_name: "htpc", scope: "admin" }))}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_tokens_scope_check" });
    const [defaults] = await sql<{ scope: string; recall_all: boolean }[]>`
      INSERT INTO rk9_coord_tokens ${sql(row({ principal_name: "skynet" }))} RETURNING scope, recall_all`;
    expect(defaults).toEqual({ scope: "coord", recall_all: false });
  });

  it("replays idempotently over an already-migrated database", async () => {
    await sql.begin(async (tx) => {
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    });
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    await applyPendingMigrations(database.connectionString);
    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
  }, 30_000);

  it("fails after the 5 s lock timeout while another transaction holds the table, rolls back, and applies on retry", async () => {
    await revertTo9015();
    expect(await hasRecallAllColumn()).toBe(false);
    const holder = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = holder.begin(async (tx) => {
      await tx`SELECT count(*) FROM rk9_coord_tokens`; // ACCESS SHARE until COMMIT
      locked();
      await released;
    });
    try {
      await lockTaken;
      const started = Date.now();
      await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({ code: "55P03" });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(20_000);
      // Nothing was applied or recorded.
      expect(await hasRecallAllColumn()).toBe(false);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [migrationFile],
      });
    } finally {
      release();
      await holding;
      await holder.end();
    }
    await applyPendingMigrations(database.connectionString);
    expect(await hasRecallAllColumn()).toBe(true);
    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
  }, 60_000);
});
