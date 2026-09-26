/**
 * migration-dry-run.ts — run the merged tree's migrations against a prod pg_dump copy (RK9-311).
 *
 * Restores a prod dump into a scratch database, applies every pending migration with the
 * tree's own driver (packages/db/src/client.ts, so run it from the MERGED tree), and writes a
 * counts-only report: journal order, hash identity, data impact, lock/duration figures.
 * The report never contains row values (the dump holds prospect PII): only row counts and names.
 *
 * Usage (from the tree under test, as a user that may connect to the local Postgres socket):
 *   PGHOST=/var/run/postgresql PGUSER=paperclip \
 *     pnpm --filter @paperclipai/db db:migration-dry-run --dump /var/backups/paperclip/<x>.dump \
 *       [--database paperclip_migdryrun] [--report report.md] [--schema-diff] [--keep-db] \
 *       [--deploy-window-seconds 300]
 *
 * Fails closed: the target must match paperclip_migdryrun[_x], is never `paperclip`, and is
 * reached over a unix socket only. The scratch database is dropped at the end unless --keep-db.
 * Exit code: 0 = all assertions hold, 1 = an assertion failed or the run errored, 2 = bad usage.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "../src/client.js";
import {
  analyzeJournal,
  checkPinnedForkHashes,
  createdObjectsIn,
  destructiveStatementsIn,
  forkTableReferencesIn,
  isForkMigrationFile,
  migrationSha256,
  scratchTargetViolations,
  tablesCreatedIn,
  type JournalEntry,
} from "../src/migration-dry-run-lib.js";

const execFileAsync = promisify(execFile);
const migrationsDir = fileURLToPath(new URL("../src/migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("../src/migrations/meta/_journal.json", import.meta.url));
const baselinePath = fileURLToPath(new URL("../src/fork-migration-hashes.json", import.meta.url));

type Args = {
  dump: string | null;
  database: string;
  report: string | null;
  keepDb: boolean;
  schemaDiff: boolean;
  deployWindowSeconds: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dump: null,
    database: "paperclip_migdryrun",
    report: null,
    keepDb: false,
    schemaDiff: false,
    deployWindowSeconds: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[(i += 1)];
      if (next === undefined) usage(`${flag} needs a value`);
      return next;
    };
    if (flag === "--dump") args.dump = value();
    else if (flag === "--database") args.database = value();
    else if (flag === "--report") args.report = value();
    else if (flag === "--keep-db") args.keepDb = true;
    else if (flag === "--schema-diff") args.schemaDiff = true;
    else if (flag === "--deploy-window-seconds") args.deployWindowSeconds = Number(value());
    else usage(`unknown argument ${flag}`);
  }
  if (!Number.isFinite(args.deployWindowSeconds) || args.deployWindowSeconds <= 0) usage("bad --deploy-window-seconds");
  return args;
}

function usage(message: string): never {
  console.error(`migration-dry-run: ${message}`);
  console.error("usage: migration-dry-run --dump <file> [--database paperclip_migdryrun] [--report <file>] [--schema-diff] [--keep-db]");
  process.exit(2);
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
const urlFor = (database: string) => `postgres:///${database}`; // host and user come from PGHOST/PGUSER

function newSql(database: string) {
  return postgres(urlFor(database), { max: 1, onnotice: () => {}, idle_timeout: 5 });
}

async function pgTool(tool: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(tool, args, { env: process.env, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").split("\n").slice(0, 15).join("\n");
    throw new Error(`${tool} failed:\n${stderr}`);
  }
}

// No --force: it needs the right to terminate other roles' backends (autovacuum) and fails without it.
// DROP DATABASE cancels autovacuum on its own; retry covers short-lived sessions.
async function dropDatabase(name: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await pgTool("dropdb", ["--if-exists", name]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function recreateDatabase(name: string): Promise<void> {
  await dropDatabase(name);
  await pgTool("createdb", [name]);
}

async function tableCounts(sql: postgres.Sql): Promise<Map<string, number>> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
  const counts = new Map<string, number>();
  for (const { table_name } of tables) {
    const [row] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from public.${q(table_name)}`);
    counts.set(table_name, Number(row.n));
  }
  return counts;
}

async function columnExists(sql: postgres.Sql, table: string, column: string): Promise<boolean> {
  const rows = await sql`select 1 from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = ${column}`;
  return rows.length > 0;
}

async function tableExists(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = await sql`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${table}`;
  return rows.length > 0;
}

async function scalar(sql: postgres.Sql, query: string): Promise<number> {
  const [row] = await sql.unsafe<{ n: string }[]>(query);
  return Number(row.n);
}

type Impact = { migration: string; what: string; count: number | string };

async function namedImpacts(sql: postgres.Sql): Promise<Impact[]> {
  const out: Impact[] = [];
  const add = (migration: string, what: string, count: number | string) => out.push({ migration, what, count });
  const skip = (migration: string, what: string) => add(migration, what, "n/a (table/column absent before the run)");

  for (const table of ["cloud_upstream_runs", "cloud_upstream_connections"]) {
    if (await tableExists(sql, table)) add("0196", `rows in ${table} (table is dropped)`, await scalar(sql, `select count(*)::text n from ${q(table)}`));
    else skip("0196", `rows in ${table}`);
  }

  if (await columnExists(sql, "issue_thread_interactions", "requested_resolver_policy")) {
    add("0218", "issue_thread_interactions total (all rows get provenance backfill)", await scalar(sql, "select count(*)::text n from issue_thread_interactions"));
    for (const policy of ["board_or_agents", "board_only"]) {
      add("0218", `interactions with requested_resolver_policy='${policy}' (rewritten)`, await scalar(sql,
        `select count(*)::text n from issue_thread_interactions where requested_resolver_policy = '${policy}'`));
    }
  } else skip("0218", "issue_thread_interactions.requested_resolver_policy");

  if (await columnExists(sql, "companies", "brand_color")) {
    add("0229", "companies with non-null brand_color (column is dropped)", await scalar(sql, "select count(*)::text n from companies where brand_color is not null"));
  } else skip("0229", "companies.brand_color");
  if (await columnExists(sql, "companies", "attachment_max_bytes")) {
    add("0229", "companies with non-null attachment_max_bytes (column is dropped)", await scalar(sql, "select count(*)::text n from companies where attachment_max_bytes is not null"));
    const values = await sql<{ v: string }[]>`select distinct attachment_max_bytes::text as v from companies where attachment_max_bytes is not null order by 1 limit 5`;
    add("0229", "distinct non-null attachment_max_bytes values (up to 5)", values.map((r) => r.v).join(", ") || "none");
  } else skip("0229", "companies.attachment_max_bytes");

  if (await columnExists(sql, "account", "provider_id")) {
    add("0230", "account rows total (issuer backfilled)", await scalar(sql, 'select count(*)::text n from "account"'));
    const providers = await sql<{ provider_id: string; n: string }[]>`select provider_id, count(*)::text n from "account" group by 1 order by 1`;
    for (const { provider_id, n } of providers) {
      add("0230", `account.provider_id='${provider_id}' -> issuer '${provider_id === "credential" ? "local:credential" : `local:oauth:${provider_id}`}'`, Number(n));
    }
  } else skip("0230", "account");

  if (await columnExists(sql, "agents", "runtime_config")) {
    add("0236", "agents with runtime_config.modelProfiles (key removed)", await scalar(sql, "select count(*)::text n from agents where runtime_config ? 'modelProfiles'"));
    add("0236", "agents total", await scalar(sql, "select count(*)::text n from agents"));
  } else skip("0236", "agents.runtime_config");
  if (await columnExists(sql, "agent_config_revisions", "before_config") && await columnExists(sql, "agent_config_revisions", "after_config")) {
    add("0236", "agent_config_revisions with modelProfiles in before/after runtimeConfig (rewritten)", await scalar(sql,
      `select count(*)::text n from agent_config_revisions
       where (before_config #> '{runtimeConfig}') ? 'modelProfiles' or (after_config #> '{runtimeConfig}') ? 'modelProfiles'`));
  } else skip("0236", "agent_config_revisions.before_config/after_config");
  return out;
}

async function genericDestructiveImpacts(sql: postgres.Sql, pending: Array<{ file: string; content: string }>): Promise<Impact[]> {
  const out: Impact[] = [];
  const seen = new Set<string>();
  for (const { file, content } of pending) {
    for (const statement of destructiveStatementsIn(content)) {
      const key = statement.kind === "drop_table" ? `t:${statement.table}` : `c:${statement.table}.${statement.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const migration = file.slice(0, 4);
      if (statement.kind === "drop_table") {
        if (!(await tableExists(sql, statement.table))) continue;
        const n = await scalar(sql, `select count(*)::text n from ${q(statement.table)}`);
        if (n > 0) out.push({ migration, what: `DROP TABLE ${statement.table}: rows lost`, count: n });
      } else {
        if (!(await columnExists(sql, statement.table, statement.column))) continue;
        const n = await scalar(sql, `select count(*)::text n from ${q(statement.table)} where ${q(statement.column)} is not null`);
        if (n > 0) out.push({ migration, what: `DROP COLUMN ${statement.table}.${statement.column}: non-null values lost`, count: n });
      }
    }
  }
  return out;
}

type LockSample = { first: number; last: number };

function startSampler(database: string, migrationTable: string) {
  const sql = newSql(database);
  const holds = new Map<string, LockSample>();
  const completions: Array<{ count: number; at: number }> = [];
  let stopped = false;
  let lastCount = -1;
  const t0 = performance.now();
  const loop = (async () => {
    while (!stopped) {
      try {
        const now = performance.now() - t0;
        const [{ n }] = await sql.unsafe<{ n: string }[]>(`select count(*)::text n from ${migrationTable}`);
        if (Number(n) !== lastCount) {
          lastCount = Number(n);
          completions.push({ count: lastCount, at: now });
        }
        const locks = await sql<{ vt: string; rel: string; mode: string }[]>`
          select l.virtualtransaction as vt, l.relation::regclass::text as rel, l.mode
          from pg_locks l
          where l.locktype = 'relation' and l.relation >= 16384 and l.pid <> pg_backend_pid()
            and l.database = (select oid from pg_database where datname = current_database())
            and l.mode in ('AccessExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock')`;
        for (const lock of locks) {
          const key = `${lock.vt}|${lock.rel}|${lock.mode}`;
          const entry = holds.get(key);
          if (entry) entry.last = now;
          else holds.set(key, { first: now, last: now });
        }
      } catch {
        // The sampler must never break the run; a missed sample only lowers resolution.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  return {
    holds,
    completions,
    async stop() {
      stopped = true;
      await loop;
      await sql.end({ timeout: 2 });
    },
  };
}

type StructureSnapshot = { columns: string[]; indexes: string[]; constraints: string[] };

async function structureOf(database: string): Promise<StructureSnapshot> {
  const sql = newSql(database);
  try {
    const columns = await sql<{ s: string }[]>`
      select table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-') as s
      from information_schema.columns where table_schema = 'public' order by 1`;
    const indexes = await sql<{ s: string }[]>`select tablename || ' ' || indexdef as s from pg_indexes where schemaname = 'public' order by 1`;
    const constraints = await sql<{ s: string }[]>`
      select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) as s
      from pg_constraint where connamespace = 'public'::regnamespace order by 1`;
    return { columns: columns.map((r) => r.s), indexes: indexes.map((r) => r.s), constraints: constraints.map((r) => r.s) };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

function setDiff(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const socketDir = process.env.PGHOST ?? "/var/run/postgresql";
  process.env.PGHOST = socketDir;
  process.env.PGUSER ??= "paperclip";

  const violations = scratchTargetViolations({ database: args.database, socketDir, envDatabaseUrl: process.env.DATABASE_URL });
  if (violations.length > 0) {
    console.error(`REFUSED (fail closed):\n- ${violations.join("\n- ")}`);
    process.exit(2);
  }
  if (!args.dump) usage("--dump is required");

  const report: string[] = [];
  const failures: string[] = [];
  const out = (line = "") => report.push(line);
  const assertOk = (ok: boolean, message: string) => {
    out(`- ${ok ? "OK" : "FAIL"}: ${message}`);
    if (!ok) failures.push(message);
  };
  const runStarted = Date.now();
  let freshDb: string | null = null;
  let dropped = true;

  try {
    // 1. Restore
    console.log(`Restoring dump into ${args.database} ...`);
    await recreateDatabase(args.database);
    await pgTool("pg_restore", ["--no-owner", "--no-acl", "--dbname", args.database, args.dump]);
    const sql = newSql(args.database);
    const [{ db }] = await sql<{ db: string }[]>`select current_database() as db`;
    if (db !== args.database) throw new Error(`connected to '${db}', expected '${args.database}'`);

    // 2. Static inputs: files, journal, hashes
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const contents = await Promise.all(files.map(async (file) => ({ file, content: await readFile(`${migrationsDir}/${file}`, "utf8") })));
    const journal = (JSON.parse(await readFile(journalPath, "utf8")) as { entries: JournalEntry[] }).entries;
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Record<string, string>;
    const hashByFile = new Map(contents.map(({ file, content }) => [file, migrationSha256(content)]));
    const fileByHash = new Map([...hashByFile].map(([file, hash]) => [hash, file]));
    const analysis = analyzeJournal(journal);
    const forkTables = new Set(contents.filter((c) => isForkMigrationFile(c.file)).flatMap((c) => tablesCreatedIn(c.content)));

    out("# Migration dry-run report");
    out();
    out(`Date: ${new Date().toISOString()}  ·  scratch db: \`${args.database}\`  ·  counts only, no row values.`);
    out();
    out("## 1. Journal order and hash identity");
    out(`- Journal entries: ${journal.length}; migration files: ${files.length}; last tag: \`${journal[journal.length - 1]?.tag}\`.`);
    out(`- Largest journal \`when\`: ${analysis.maxWhen} (\`${analysis.maxWhenTag}\`). Upstream entries with \`when\` below the largest fork \`when\`: ${analysis.upstreamBelowForkMax}.`);
    out(`- Journal entries whose \`when\` does not increase over the previous entry: ${analysis.nonMonotonic.length}${analysis.nonMonotonic.length ? ` (first: \`${analysis.nonMonotonic[0].tag}\` after \`${analysis.nonMonotonic[0].previousTag}\`)` : ""}.`);
    const pinned = checkPinnedForkHashes(contents, baseline);
    assertOk(pinned.changed.length === 0 && pinned.missingBaseline.length === 0 && pinned.staleBaseline.length === 0,
      `fork 9xxx files match the pinned sha256 baseline (changed: ${pinned.changed.map((c) => c.file).join(", ") || "none"}; unpinned: ${pinned.missingBaseline.join(", ") || "none"}; stale: ${pinned.staleBaseline.join(", ") || "none"})`);

    const preInspect = await inspectMigrations(urlFor(args.database));
    const [{ schema: migSchema }] = await sql<{ schema: string }[]>`
      select table_schema as schema from information_schema.tables where table_name = '__drizzle_migrations' order by (table_schema = 'drizzle') desc limit 1`;
    const migrationTable = `${q(migSchema)}."__drizzle_migrations"`;
    const dbRows = await sql.unsafe<{ id: number; hash: string; created_at: string }[]>(`select id, hash, created_at::text from ${migrationTable} order by id`);
    const unresolved = dbRows.filter((row) => !fileByHash.has(row.hash));
    const dbHashes = new Set(dbRows.map((row) => row.hash));
    const pinnedMissingInDb = Object.entries(baseline).filter(([, hash]) => !dbHashes.has(hash)).map(([file]) => file);
    out(`- Prod copy history rows: ${dbRows.length}; last created_at: ${dbRows[dbRows.length - 1]?.created_at}; rows whose hash matches no file in this tree: ${unresolved.length}.`);
    assertOk(unresolved.length === 0, "every prod history hash resolves to a migration file (otherwise client.ts falls back to created_at / partial resolution)");
    const upstreamApplied = preInspect.appliedMigrations.filter((f) => !isForkMigrationFile(f));
    out(`- Upstream migrations already applied in the prod copy: ${upstreamApplied.length} (last: \`${upstreamApplied[upstreamApplied.length - 1] ?? "-"}\`; the fork tree itself ends at 0072).`);
    out(`- Pinned fork hashes absent from the prod history (would be replayed as pending): ${pinnedMissingInDb.join(", ") || "none"}.`);
    out(`- Driver view before the run: status \`${preInspect.status}\`, applied ${preInspect.appliedMigrations.length}, pending ${preInspect.status === "needsMigrations" ? preInspect.pendingMigrations.length : 0}.`);
    const pendingFiles = preInspect.status === "needsMigrations" ? preInspect.pendingMigrations : [];
    const pendingForkFiles = pendingFiles.filter(isForkMigrationFile);
    assertOk(pendingForkFiles.length === 0, `no fork 9xxx migration is pending before the run (pending fork: ${pendingForkFiles.join(", ") || "none"})`);
    const upstreamPending = pendingFiles.filter((f) => !isForkMigrationFile(f));
    out(`- Pending upstream migrations: ${upstreamPending.length} (${upstreamPending[0] ?? "-"} .. ${upstreamPending[upstreamPending.length - 1] ?? "-"}).`);
    const pendingContents = contents.filter((c) => pendingFiles.includes(c.file));

    // 3. Before snapshot and data impact
    const before = await tableCounts(sql);
    out();
    out("## 2. Data impact per migration (before the run)");
    for (const impact of [...(await namedImpacts(sql)), ...(await genericDestructiveImpacts(sql, pendingContents))]) {
      out(`- \`${impact.migration}\` ${impact.what}: **${impact.count}**`);
    }
    out();
    out("### Upstream DDL touching fork tables");
    const refs = pendingContents.filter((c) => !isForkMigrationFile(c.file)).flatMap((c) =>
      forkTableReferencesIn(c.content, forkTables).map((r) => ({ file: c.file, ...r })));
    if (refs.length === 0) out("- None: no pending upstream statement alters, drops or references a fork table.");
    for (const ref of refs) out(`- \`${ref.file}\` (${ref.via}) ${ref.table}: \`${ref.statement}\``);

    out();
    out("### Name collisions: objects a pending upstream migration creates that already exist in the prod copy");
    const collisions: string[] = [];
    for (const { file, content } of pendingContents.filter((c) => !isForkMigrationFile(c.file))) {
      const created = createdObjectsIn(content);
      for (const table of created.tables) {
        if (await tableExists(sql, table)) collisions.push(`\`${file}\` creates table \`${table}\`, which exists (${before.get(table) ?? 0} rows)${forkTables.has(table) ? " [FORK TABLE]" : ""}`);
      }
      // A drop followed by a re-add of the same name in one migration is a rebuild, not a collision.
      const dropped = (kind: string, name: string) =>
        new RegExp(`DROP ${kind}(?: IF EXISTS)? (?:"public"\\.)?"${name}"`, "i").test(content);
      for (const index of created.indexes) {
        if (dropped("INDEX", index)) continue;
        const rows = await sql`select tablename from pg_indexes where schemaname = 'public' and indexname = ${index}`;
        if (rows.length > 0) collisions.push(`\`${file}\` creates index \`${index}\`, which exists on \`${rows[0].tablename}\``);
      }
      for (const { table, name } of created.constraints) {
        if (new RegExp(`DROP CONSTRAINT(?: IF EXISTS)? "${name}"`, "i").test(content)) continue;
        const rows = await sql`select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
          where t.relname = ${table} and c.conname = ${name} and t.relnamespace = 'public'::regnamespace`;
        if (rows.length > 0) collisions.push(`\`${file}\` adds constraint \`${name}\` on \`${table}\`, which exists`);
      }
    }
    if (collisions.length === 0) out("- None.");
    for (const line of collisions) out(`- ${line}`);
    assertOk(collisions.filter((c) => c.includes("[FORK TABLE]")).length === 0, "no pending upstream migration creates a table that a fork migration already created");

    // 4. Run with sampler
    console.log("Applying migrations ...");
    await sql.end({ timeout: 2 });
    const sampler = startSampler(args.database, migrationTable);
    const startedAt = performance.now();
    let applyError: unknown = null;
    try {
      await applyPendingMigrations(urlFor(args.database));
    } catch (error) {
      applyError = error;
    }
    const totalMs = performance.now() - startedAt;
    await sampler.stop();

    out();
    out("## 3. Run result");
    assertOk(applyError === null, `applyPendingMigrations completed${applyError ? `: ${(applyError as Error).message.slice(0, 300)}` : ""}`);

    const after = newSql(args.database);
    const postInspect = await inspectMigrations(urlFor(args.database));
    assertOk(postInspect.status === "upToDate", `inspectMigrations reports upToDate after the run (pending: ${postInspect.status === "needsMigrations" ? postInspect.pendingMigrations.length : 0})`);
    const historyCount = await scalar(after, `select count(*)::text n from ${migrationTable}`);
    assertOk(historyCount === journal.length, `history rows (${historyCount}) equal _journal.json entries (${journal.length})`);
    const histRows = await after.unsafe<{ hash: string }[]>(`select hash from ${migrationTable}`);
    const missingHashes = [...hashByFile].filter(([, hash]) => !histRows.some((r) => r.hash === hash)).map(([file]) => file);
    assertOk(missingHashes.length === 0, `every migration file has a history row by hash (missing: ${missingHashes.slice(0, 5).join(", ") || "none"})`);

    // 5. Row counts
    const afterCounts = await tableCounts(after);
    out();
    out("## 4. Row counts");
    const forkDeltas = [...forkTables].map((t) => ({ table: t, before: before.get(t) ?? 0, after: afterCounts.get(t) ?? 0 }));
    assertOk(forkDeltas.every((d) => d.before === d.after) && forkDeltas.length > 0, `fork 9001-9010 tables: row counts identical before and after (${forkDeltas.length} tables, non-zero deltas: ${forkDeltas.filter((d) => d.before !== d.after).map((d) => `${d.table} ${d.before}->${d.after}`).join(", ") || "none"})`);
    out();
    out("| fork table | before | after |");
    out("|---|---:|---:|");
    for (const d of forkDeltas.sort((a, b) => a.table.localeCompare(b.table))) out(`| ${d.table} | ${d.before} | ${d.after} |`);
    out();
    const otherChanges = [...new Set([...before.keys(), ...afterCounts.keys()])]
      .filter((t) => !forkTables.has(t) && before.get(t) !== afterCounts.get(t))
      .sort();
    const newTables = otherChanges.filter((t) => !before.has(t));
    const goneTables = otherChanges.filter((t) => !afterCounts.has(t));
    const changed = otherChanges.filter((t) => before.has(t) && afterCounts.has(t));
    out(`Non-fork tables: ${newTables.length} new (all created empty except: ${newTables.filter((t) => (afterCounts.get(t) ?? 0) > 0).map((t) => `${t} ${afterCounts.get(t)}`).join(", ") || "none"}), ${goneTables.length} dropped (${goneTables.map((t) => `${t} ${before.get(t)} rows`).join(", ") || "none"}), ${changed.length} with changed row counts:`);
    for (const t of changed) out(`- ${t}: ${before.get(t)} -> ${afterCounts.get(t)}`);

    // 6. Duration and locks
    out();
    out("## 5. Duration and locks");
    out(`- Total apply duration (driver call, including inspect/reconcile): **${fmt(totalMs)}**; whole script incl. restore: ${fmt(Date.now() - runStarted)}.`);
    const startCount = dbRows.length;
    const perMigration: Array<{ file: string; ms: number }> = [];
    let previousAt = sampler.completions[0]?.at ?? 0;
    for (const completion of sampler.completions.slice(1)) {
      const ordered = pendingFiles; // driver applies pending files in journal order
      const idx = completion.count - startCount - 1;
      perMigration.push({ file: ordered[idx] ?? `#${completion.count}`, ms: completion.at - previousAt });
      previousAt = completion.at;
    }
    out(`- Sampler: 20 ms poll of \`pg_locks\`; migrations finishing between two samples are attributed together, so per-migration figures have that resolution.`);
    out("- Slowest migrations (time between successive history rows):");
    for (const m of [...perMigration].sort((a, b) => b.ms - a.ms).slice(0, 8)) out(`  - \`${m.file}\`: ${fmt(m.ms)}`);
    const holds = [...sampler.holds.entries()].map(([key, v]) => ({ key, ms: v.last - v.first }));
    const exclusive = holds.filter((h) => h.key.endsWith("|AccessExclusiveLock")).sort((a, b) => b.ms - a.ms);
    const longestLock = exclusive[0]?.ms ?? 0;
    out(`- Longest observed AccessExclusiveLock hold: **${fmt(longestLock)}**${exclusive[0] ? ` (relation ${exclusive[0].key.split("|")[1]})` : ""}. Each migration runs in its own transaction, so a lock is held until that migration commits.`);
    for (const h of exclusive.slice(1, 5)) out(`  - ${h.key.split("|")[1]}: ${fmt(h.ms)}`);
    const slowestMigration = Math.max(0, ...perMigration.map((m) => m.ms));
    out(`- Deploy window: ${args.deployWindowSeconds} s. Total apply = ${((totalMs / 1000 / args.deployWindowSeconds) * 100).toFixed(1)} % of the window; longest lock = ${((longestLock / 1000 / args.deployWindowSeconds) * 100).toFixed(1)} %; slowest single migration = ${fmt(slowestMigration)}.`);
    assertOk(totalMs / 1000 <= args.deployWindowSeconds, `total apply duration fits the ${args.deployWindowSeconds} s deploy window`);
    out("- Note: the copy runs on an idle scratch database; prod contention (running agents, heartbeat writes) would add lock waits that this figure does not include.");

    // 7. Optional structural comparison with a fresh database
    if (args.schemaDiff) {
      freshDb = `${args.database}_fresh`;
      out();
      out("## 6. Schema equivalence: migrated prod copy vs. fresh database built from the same tree");
      await recreateDatabase(freshDb);
      await applyPendingMigrations(urlFor(freshDb));
      const [copy, fresh] = await Promise.all([structureOf(args.database), structureOf(freshDb)]);
      for (const kind of ["columns", "indexes", "constraints"] as const) {
        const onlyCopy = setDiff(copy[kind], fresh[kind]);
        const onlyFresh = setDiff(fresh[kind], copy[kind]);
        assertOk(onlyCopy.length === 0 && onlyFresh.length === 0, `${kind}: prod copy has ${copy[kind].length}, fresh has ${fresh[kind].length}; only-in-copy ${onlyCopy.length}, only-in-fresh ${onlyFresh.length}`);
        for (const line of onlyCopy.slice(0, 25)) out(`  - only in prod copy: \`${line.slice(0, 200)}\``);
        for (const line of onlyFresh.slice(0, 25)) out(`  - only in fresh: \`${line.slice(0, 200)}\``);
      }
    }
    await after.end({ timeout: 2 });
  } catch (error) {
    failures.push(`script error: ${(error as Error).message.slice(0, 400)}`);
    out(`- FAIL: script error: ${(error as Error).message.slice(0, 400)}`);
  } finally {
    if (!args.keepDb) {
      for (const name of [args.database, freshDb].filter((n): n is string => Boolean(n))) {
        await dropDatabase(name).catch((e) => {
          dropped = false;
          console.error(`could not drop ${name}: ${(e as Error).message}`);
        });
      }
      out();
      out(dropped ? `Scratch database dropped: yes (${args.database}).` : `**Scratch database NOT dropped (${args.database}): contains prod data; run dropdb ${args.database}.**`);
    } else {
      out();
      out(`Scratch database kept: ${args.database} (contains prod data; drop it: dropdb ${args.database}).`);
    }
  }

  out();
  out(failures.length === 0 ? "**Result: all assertions hold.**" : `**Result: ${failures.length} assertion(s) failed.**`);
  const text = report.join("\n");
  console.log(text);
  if (args.report) await writeFile(args.report, `${text}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
