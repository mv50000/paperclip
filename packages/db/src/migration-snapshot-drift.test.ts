import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

// The newest snapshot in `src/migrations/meta` is the state `drizzle-kit
// generate` diffs the schema against. When it drifts from the schema, the next
// generated migration silently carries the drift: it re-adds a column an
// earlier migration already created (which fails on a fresh database) and drops
// a column the schema never had. This test reproduces the diff `generate`
// performs — schema modules versus newest snapshot — and fails when it is not
// empty, so drift is caught in CI instead of inside someone else's migration.

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("./schema", import.meta.url));

type JournalEntry = { idx: number; tag: string };

async function readNewestSnapshot(): Promise<{ file: string; snapshot: Record<string, unknown> }> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  // --- RK9 Custom (RK9-316): fork 9xxx migrations are hand-written. Only
  // 9001-9003 have (stale, pre-upgrade) snapshots and 9004-9010 have none, so
  // the newest snapshot is the newest upstream (< 9000) entry.
  const newest = journal.entries.filter((entry) => !isForkMigrationTag(entry.tag)).at(-1);
  // --- /RK9 Custom ---
  if (!newest) throw new Error("migration journal has no entries");
  const file = `${String(newest.idx).padStart(4, "0")}_snapshot.json`;
  const snapshot = JSON.parse(await readFile(path.join(migrationsDir, "meta", file), "utf8")) as Record<
    string,
    unknown
  >;
  return { file, snapshot };
}

// --- RK9 Custom (RK9-316) ---
// Tables created by the fork's hand-written 9xxx migrations are not in any
// upstream snapshot. Drift on them is expected here and is covered by the fork
// migration hash pins and the upgrade dry-run; drift on every other table
// still fails this test.
function isForkMigrationTag(tag: string): boolean {
  return Number.parseInt(tag.slice(0, 4), 10) >= 9000;
}

async function readForkTables(): Promise<Set<string>> {
  // RK9-317: pinned fork files also include the slot migration 0126, which renames the fork
  // Resend table to rk9_email_messages. Its rename target is a fork table too.
  const pinned = JSON.parse(
    await readFile(path.join(migrationsDir, "..", "fork-migration-hashes.json"), "utf8"),
  ) as Record<string, string>;
  const files = (await readdir(migrationsDir)).filter(
    (file) => file.endsWith(".sql") && (isForkMigrationTag(file) || file in pinned),
  );
  const tables = new Set<string>();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([a-z0-9_]+)"?/gi)) {
      tables.add(match[1]!);
    }
    for (const match of sql.matchAll(/ALTER TABLE\s+(?:"public"\.)?"?[a-z0-9_]+"?\s+RENAME TO\s+"?(rk9_[a-z0-9_]+)"?/gi)) {
      tables.add(match[1]!);
    }
  }
  // 9002 created the fork table as "email_messages"; after the 9011 split that name is
  // upstream's AgentMail table again, so its drift must still fail this test.
  tables.delete("email_messages");
  return tables;
}

function statementTable(statement: string): string | null {
  const match =
    /^\s*(?:CREATE TABLE|ALTER TABLE)\s+(?:"public"\.)?"([^"]+)"/i.exec(statement) ??
    /^\s*CREATE (?:UNIQUE )?INDEX\b[^;]*?\bON\s+(?:"public"\.)?"([^"]+)"/i.exec(statement);
  return match?.[1] ?? null;
}
// --- /RK9 Custom ---

// drizzle.config.ts points drizzle-kit at every module in the schema directory,
// so the test imports the same set rather than the hand-maintained barrel — a
// table missing from the barrel must not hide from this check.
async function importSchemaModules(): Promise<Record<string, unknown>> {
  const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".ts")).sort();
  const exports: Record<string, unknown> = {};
  // The barrel re-exports the same table objects the per-table modules export,
  // so dedupe by identity: serializing one table twice trips drizzle-kit's
  // duplicate-index guard.
  const seen = new Set<unknown>();
  for (const file of files) {
    const module = (await import(pathToFileURL(path.join(schemaDir, file)).href)) as Record<
      string,
      unknown
    >;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) continue;
        seen.add(value);
      }
      exports[`${file}#${name}`] = value;
    }
  }
  return exports;
}

describe("migration snapshot drift", () => {
  it("keeps the newest snapshot in sync with the drizzle schema", async () => {
    const { file, snapshot } = await readNewestSnapshot();
    const current = generateDrizzleJson(await importSchemaModules(), snapshot.id as string);
    const statements = await generateMigration(
      snapshot as Parameters<typeof generateMigration>[0],
      current as Parameters<typeof generateMigration>[1],
    );

    // --- RK9 Custom (RK9-316): ignore statements that only touch fork tables ---
    const forkTables = await readForkTables();
    expect(forkTables.size).toBeGreaterThan(0);
    const upstreamStatements = statements.filter((statement) => {
      const table = statementTable(statement);
      return table === null || !forkTables.has(table);
    });
    // --- /RK9 Custom ---

    expect(
      upstreamStatements,
      `${file} no longer matches src/schema. Run \`pnpm --filter @paperclipai/db generate\` and commit the migration it emits; do not hand-edit the snapshot.`,
    ).toEqual([]);
  });
});
