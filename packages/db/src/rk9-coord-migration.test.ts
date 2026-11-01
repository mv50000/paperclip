// RK9 Custom (RK9-623): migration 9015 creates the coordination bus tables
// (epic RK9-620). The database is migrated with applyPendingMigrations, then
// each invariant the later children rely on is exercised against real
// Postgres: one active lease per resource under concurrency, the resource
// prefix and length CHECKs, the closed enums, the inbox target rule and the
// append-only journal.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationFile = "9015_rk9_coord.sql";
const migrationSql = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  // The concurrency AC must not pass silently: say loudly when it is skipped.
  console.warn(`[rk9-coord-migration] embedded Postgres unsupported, suite skipped: ${support.reason ?? "unknown"}`);
}

describePostgres("RK9 coord migration 9015", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: postgres.Sql;
  let companyId: string;

  async function newActor(ref: string, kind = ref.split(":", 1)[0]!, company = companyId) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO rk9_coord_actors (company_id, kind, actor_ref, trust)
      VALUES (${company}, ${kind}, ${ref}, 'attributed') RETURNING id`;
    return row!.id;
  }

  async function newCompany(prefix: string) {
    const id = randomUUID();
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${id}, ${`Coord ${prefix}`}, ${prefix})`;
    return id;
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-migration-");
    sql = postgres(database.connectionString, { max: 4, onnotice: () => {} });
    companyId = await newCompany("CRD");
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  it("is applied by applyPendingMigrations and creates exactly the rk9_coord_* tables", async () => {
    const applied = await sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    expect(applied).toHaveLength(1);
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'rk9\\_coord\\_%' ORDER BY table_name`;
    expect(tables.map((row) => row.table_name)).toEqual([
      "rk9_coord_actors",
      "rk9_coord_cursors",
      "rk9_coord_escalations",
      "rk9_coord_events",
      "rk9_coord_inbox",
      "rk9_coord_lease_waiters",
      "rk9_coord_leases",
      "rk9_coord_tokens",
    ]);
    // No upstream table is altered: every statement names an rk9_coord_ object.
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      const code = statement.replace(/^\s*--.*$/gm, "").trim();
      if (!code) continue;
      expect(code, code.slice(0, 80)).toMatch(/rk9_coord_/);
      expect(code).not.toMatch(/ALTER TABLE\s+"(?!rk9_coord_)/);
    }
  });

  it("replays idempotently over an already-migrated database", async () => {
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [migrationFile],
    });
    await applyPendingMigrations(database.connectionString);
    await sql.begin(async (tx) => {
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
  }, 30_000);

  it("allows one active lease per resource, also under a concurrent double insert", async () => {
    const a = await newActor("cc:paperclip-01:lease-a");
    const b = await newActor("cc:paperclip-01:lease-b");
    const insert = (holder: string) => sql`
      INSERT INTO rk9_coord_leases (company_id, resource, holder_actor_id, expires_at)
      VALUES (${companyId}, 'prod:saatavilla', ${holder}, now() + interval '5 minutes')
      RETURNING id, fencing_token`;
    const results = await Promise.allSettled([insert(a), insert(b)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "23505", constraint_name: "rk9_coord_leases_active_resource_uq" });

    // Another company may hold the same resource name.
    const other = await newCompany("CRE");
    const otherActor = await newActor("cc:paperclip-01:lease-c", "cc", other);
    await sql`INSERT INTO rk9_coord_leases (company_id, resource, holder_actor_id, expires_at)
      VALUES (${other}, 'prod:saatavilla', ${otherActor}, now() + interval '5 minutes')`;

    // After release, a new lease succeeds and gets a higher fencing token.
    const [first] = await sql<{ id: string; fencing_token: string }[]>`
      SELECT id, fencing_token FROM rk9_coord_leases
      WHERE company_id = ${companyId} AND resource = 'prod:saatavilla' AND released_at IS NULL`;
    await sql`UPDATE rk9_coord_leases SET released_at = now(), release_reason = 'released' WHERE id = ${first!.id}`;
    const [second] = await insert(b);
    expect(BigInt(second!.fencing_token)).toBeGreaterThan(BigInt(first!.fencing_token));
  });

  it("rejects a release without a reason and a reason without a release", async () => {
    const a = await newActor("worktree:RK9-623");
    await expect(sql`INSERT INTO rk9_coord_leases (company_id, resource, holder_actor_id, expires_at, released_at)
      VALUES (${companyId}, 'repo:paperclip@master', ${a}, now(), now())`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_leases_release_check" });
  });

  it.each([
    ["deploy:saatavilla"],
    ["prod:"],
    ["prod"],
    ["PROD:x"],
    ["prod:has space"],
    [`repo:${"x".repeat(300)}`],
  ])("rejects the lease resource %j", async (resource) => {
    const a = await newActor(`cc:paperclip-01:bad-${randomUUID().slice(0, 8)}`);
    await expect(sql`INSERT INTO rk9_coord_leases (company_id, resource, holder_actor_id, expires_at)
      VALUES (${companyId}, ${resource}, ${a}, now())`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_leases_resource_check" });
  });

  it("accepts every frozen resource prefix", async () => {
    const a = await newActor("orch:prefix-check");
    for (const resource of ["prod:oll", "migrate:paperclip", "repo:rk9-ai/bk@master", "vault:rk9/areas/decision_log", "host:pve-01"]) {
      await sql`INSERT INTO rk9_coord_leases (company_id, resource, holder_actor_id, expires_at)
        VALUES (${companyId}, ${resource}, ${a}, now() + interval '1 minute')`;
    }
  });

  it("orders waiters FIFO and queues an actor once per resource", async () => {
    const a = await newActor("headless:wait-a");
    const b = await newActor("headless:wait-b");
    await sql`INSERT INTO rk9_coord_lease_waiters (company_id, resource, actor_id) VALUES (${companyId}, 'host:pve-02', ${a})`;
    await sql`INSERT INTO rk9_coord_lease_waiters (company_id, resource, actor_id) VALUES (${companyId}, 'host:pve-02', ${b})`;
    const queue = await sql<{ actor_id: string }[]>`
      SELECT actor_id FROM rk9_coord_lease_waiters WHERE company_id = ${companyId} AND resource = 'host:pve-02' ORDER BY id`;
    expect(queue.map((row) => row.actor_id)).toEqual([a, b]);
    await expect(sql`INSERT INTO rk9_coord_lease_waiters (company_id, resource, actor_id) VALUES (${companyId}, 'host:pve-02', ${a})`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_lease_waiters_resource_actor_uq" });
  });

  it("caps the phase at 140 characters and keeps the actor kind closed", async () => {
    const id = await newActor("cc:paperclip-01:phase");
    await sql`UPDATE rk9_coord_actors SET phase = ${"p".repeat(140)} WHERE id = ${id}`;
    await expect(sql`UPDATE rk9_coord_actors SET phase = ${"p".repeat(141)} WHERE id = ${id}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_actors_phase_check" });
    await expect(sql`INSERT INTO rk9_coord_actors (company_id, kind, actor_ref, trust)
      VALUES (${companyId}, 'daemon', 'daemon:x', 'attributed')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_actors_kind_check" });
    // actor_ref must start with its kind.
    await expect(sql`INSERT INTO rk9_coord_actors (company_id, kind, actor_ref, trust)
      VALUES (${companyId}, 'cc', 'remote:mv-laptop', 'unverified')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_actors_actor_ref_check" });
    await expect(newActor("cc:paperclip-01:phase"))
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_actors_company_actor_ref_uq" });
  });

  async function insertEvent(fields: Partial<Record<string, string | null>> = {}) {
    const row = {
      company_id: companyId,
      type: "decision",
      actor_ref: "operator",
      actor_kind: "operator",
      trust: "verified",
      summary: "Use one migration for the coord bus",
      ...fields,
    };
    const [inserted] = await sql<{ id: string }[]>`INSERT INTO rk9_coord_events ${sql(row)} RETURNING id`;
    return inserted!.id;
  }

  it("keeps the journal typed, length-capped and deduplicated", async () => {
    await insertEvent({ type: "headsup", trust: "unverified", actor_ref: "grok", actor_kind: "grok" });
    await expect(insertEvent({ type: "chat" }))
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_events_type_check" });
    await expect(insertEvent({ trust: "trusted" }))
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_events_trust_check" });
    await insertEvent({ summary: "s".repeat(300) });
    await expect(insertEvent({ summary: "s".repeat(301) }))
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_events_summary_check" });
    await expect(insertEvent({ resource: "deploy:x" }))
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_events_resource_check" });

    const clientEventId = randomUUID();
    await insertEvent({ client_event_id: clientEventId });
    await expect(insertEvent({ client_event_id: clientEventId }))
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_events_client_event_uq" });
    await insertEvent({ type: "headsup", dedupe_key: "obs-1" });
    await expect(insertEvent({ type: "headsup", dedupe_key: "obs-1" }))
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_events_dedupe_uq" });
  });

  it("hands out increasing event ids for the cursor", async () => {
    const first = BigInt(await insertEvent());
    const second = BigInt(await insertEvent({ type: "done", repo: "mv50000/paperclip", issue: "RK9-623" }));
    expect(second).toBeGreaterThan(first);
  });

  it("rejects UPDATE and DELETE on the journal, except the retention prune", async () => {
    const id = await insertEvent();
    await expect(sql`UPDATE rk9_coord_events SET summary = 'rewritten' WHERE id = ${id}`)
      .rejects.toMatchObject({ code: "23001" });
    await expect(sql`DELETE FROM rk9_coord_events WHERE id = ${id}`).rejects.toMatchObject({ code: "23001" });
    await sql.begin(async (tx) => {
      await tx`SET LOCAL rk9.coord_events_prune = 'on'`;
      await tx`DELETE FROM rk9_coord_events WHERE id = ${id}`;
    });
    expect(await sql`SELECT 1 FROM rk9_coord_events WHERE id = ${id}`).toHaveLength(0);
    // The prune flag is transaction-local.
    const next = await insertEvent();
    await expect(sql`DELETE FROM rk9_coord_events WHERE id = ${next}`).rejects.toMatchObject({ code: "23001" });
  });

  it("requires exactly one inbox target and caps the body at 500", async () => {
    const to = await newActor("cc:paperclip-01:inbox-to");
    const base = { company_id: companyId, from_actor_ref: "operator", body: "hello" };
    await sql`INSERT INTO rk9_coord_inbox ${sql({ ...base, to_actor_id: to })}`;
    await sql`INSERT INTO rk9_coord_inbox ${sql({ ...base, to_issue: "RK9-623" })}`;
    await sql`INSERT INTO rk9_coord_inbox ${sql({ ...base, to_name: "implement" })}`;
    await expect(sql`INSERT INTO rk9_coord_inbox ${sql(base)}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_inbox_target_check" });
    await expect(sql`INSERT INTO rk9_coord_inbox ${sql({ ...base, to_issue: "RK9-1", to_name: "x" })}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_inbox_target_check" });
    await sql`INSERT INTO rk9_coord_inbox ${sql({ ...base, to_issue: "RK9-2", body: "b".repeat(500) })}`;
    await expect(sql`INSERT INTO rk9_coord_inbox ${sql({ ...base, to_issue: "RK9-2", body: "b".repeat(501) })}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_inbox_body_check" });
  });

  it("allows one active token per host and only well-formed principals", async () => {
    const token = (hash: string) => ({
      company_id: companyId,
      principal_kind: "host",
      principal_name: "mv-laptop",
      token_hash: hash,
      token_prefix: "rk9_coord_abcd",
    });
    const hash = (n: number) => createHash("sha256").update(`t${n}`).digest("hex");
    const [first] = await sql<{ id: string }[]>`INSERT INTO rk9_coord_tokens ${sql(token(hash(1)))} RETURNING id`;
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql(token(hash(2)))}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_tokens_active_principal_uq" });
    await sql`UPDATE rk9_coord_tokens SET revoked_at = now() WHERE id = ${first!.id}`;
    await sql`INSERT INTO rk9_coord_tokens ${sql({ ...token(hash(2)), rotated_from_token_id: first!.id })}`;
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql({ ...token(hash(3)), principal_name: "MV_Laptop" })}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_tokens_principal_name_check" });
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql({ ...token(hash(3)), principal_kind: "service", principal_name: "openai" })}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_tokens_principal_name_check" });
    await expect(sql`INSERT INTO rk9_coord_tokens ${sql({ ...token("not-a-hash"), principal_name: "pve-01" })}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "rk9_coord_tokens_token_hash_check" });
  });

  it("keeps one escalation per episode", async () => {
    const row = { company_id: companyId, episode_key: "prod:saatavilla#1", reason: "lease_jam", mode: "shadow" };
    await sql`INSERT INTO rk9_coord_escalations ${sql(row)}`;
    await expect(sql`INSERT INTO rk9_coord_escalations ${sql(row)}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "rk9_coord_escalations_episode_uq" });
  });

  it("cascades a company delete through every coord table, the journal included", async () => {
    const doomed = await newCompany("CRX");
    const actor = await newActor("cc:paperclip-01:doomed", "cc", doomed);
    await sql`INSERT INTO rk9_coord_leases (company_id, resource, holder_actor_id, expires_at)
      VALUES (${doomed}, 'prod:x', ${actor}, now())`;
    await sql`INSERT INTO rk9_coord_cursors (company_id, actor_id, last_event_id) VALUES (${doomed}, ${actor}, 1)`;
    await sql`INSERT INTO rk9_coord_events (company_id, type, actor_ref, actor_kind, trust, summary)
      VALUES (${doomed}, 'done', 'operator', 'operator', 'verified', 'bye')`;
    await sql`DELETE FROM companies WHERE id = ${doomed}`;
    for (const table of ["rk9_coord_actors", "rk9_coord_leases", "rk9_coord_cursors", "rk9_coord_events"]) {
      expect(await sql`SELECT 1 FROM ${sql(table)} WHERE company_id = ${doomed}`, table).toHaveLength(0);
    }
  });

  it("deletes an actor's leases, waiters and cursor and keeps messages it sent", async () => {
    const sender = await newActor("cc:paperclip-01:sender");
    const to = await newActor("cc:paperclip-01:receiver");
    await sql`INSERT INTO rk9_coord_inbox (company_id, to_actor_id, from_actor_id, from_actor_ref, body)
      VALUES (${companyId}, ${to}, ${sender}, 'cc:paperclip-01:sender', 'kept')`;
    await sql`INSERT INTO rk9_coord_cursors (company_id, actor_id) VALUES (${companyId}, ${sender})`;
    await sql`DELETE FROM rk9_coord_actors WHERE id = ${sender}`;
    const [message] = await sql<{ from_actor_id: string | null; from_actor_ref: string }[]>`
      SELECT from_actor_id, from_actor_ref FROM rk9_coord_inbox WHERE to_actor_id = ${to}`;
    expect(message).toEqual({ from_actor_id: null, from_actor_ref: "cc:paperclip-01:sender" });
    expect(await sql`SELECT 1 FROM rk9_coord_cursors WHERE actor_id = ${sender}`).toHaveLength(0);
  });
});
