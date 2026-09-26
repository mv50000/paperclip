import { createHash } from "node:crypto";

/**
 * Pure helpers for packages/db/scripts/migration-dry-run.ts (RK9-311).
 * Kept free of I/O so the guard and the statement scanners are unit-testable.
 */

export const FORK_MIGRATION_PREFIX = "9";
export const SCRATCH_DB_PATTERN = /^paperclip_migdryrun(_[a-z0-9]+)?$/;
const PROD_DB_NAMES = new Set(["paperclip", "postgres", "template0", "template1"]);

export function migrationSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isForkMigrationFile(fileName: string): boolean {
  return fileName.startsWith(FORK_MIGRATION_PREFIX) && /^\d{4}_.+\.sql$/.test(fileName);
}

export type ScratchTargetInput = {
  database: string;
  prodDatabase?: string;
  socketDir: string | undefined;
  envDatabaseUrl?: string | undefined;
  /** Other libpq variables that can redirect createdb/dropdb/pg_restore away from the socket (pass process.env). */
  env?: Record<string, string | undefined>;
};

const REDIRECTING_PG_ENV = ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGPORT"] as const;

/**
 * Fail closed: the dry run drops and recreates its target database, so the target must
 * be a scratch name that cannot be the prod database, reached over a unix socket only.
 * Returns the reasons the target is refused; an empty array means the target is allowed.
 */
export function scratchTargetViolations(input: ScratchTargetInput): string[] {
  const violations: string[] = [];
  const prod = input.prodDatabase ?? "paperclip";
  if (!SCRATCH_DB_PATTERN.test(input.database)) {
    violations.push(`database '${input.database}' does not match ${SCRATCH_DB_PATTERN}`);
  }
  if (PROD_DB_NAMES.has(input.database) || input.database === prod) {
    violations.push(`database '${input.database}' is a prod/system database`);
  }
  if (!input.socketDir || !input.socketDir.startsWith("/")) {
    violations.push("PGHOST must be an absolute unix socket directory (TCP targets are refused)");
  }
  if (input.socketDir?.includes(",")) violations.push("PGHOST must be a single socket directory (no comma list)");
  for (const name of REDIRECTING_PG_ENV) {
    if (input.env?.[name]) violations.push(`${name} is set; unset it (libpq tools and postgres.js would disagree on the target)`);
  }
  if (input.envDatabaseUrl) {
    const dbInUrl = databaseNameFromUrl(input.envDatabaseUrl);
    if (dbInUrl === input.database) {
      violations.push("DATABASE_URL points at the scratch database name; unset DATABASE_URL for dry runs");
    }
  }
  return violations;
}

export function databaseNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

export type PinnedHashCheck = {
  missingBaseline: string[];
  changed: Array<{ file: string; expected: string; actual: string }>;
  staleBaseline: string[];
};

/**
 * Compare the sha256 of every fork (9xxx) migration file against the pinned baseline.
 * client.ts identifies applied migrations by content hash, so a changed 9xxx file would
 * be treated as a new pending migration and replayed against prod.
 */
export function checkPinnedForkHashes(
  files: Array<{ file: string; content: string }>,
  baseline: Record<string, string>,
): PinnedHashCheck {
  // Fork files are the 9xxx files plus any file that was pinned by name (e.g. a fork migration in a free upstream slot).
  const forkFiles = files.filter((entry) => isForkMigrationFile(entry.file) || entry.file in baseline);
  const result: PinnedHashCheck = { missingBaseline: [], changed: [], staleBaseline: [] };
  for (const { file, content } of forkFiles) {
    const expected = baseline[file];
    if (!expected) {
      result.missingBaseline.push(file);
      continue;
    }
    const actual = migrationSha256(content);
    if (actual !== expected) result.changed.push({ file, expected, actual });
  }
  const present = new Set(forkFiles.map((entry) => entry.file));
  for (const file of Object.keys(baseline)) {
    if (!present.has(file)) result.staleBaseline.push(file);
  }
  return result;
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map(normalizeSql)
    .filter(Boolean);
}

export function tablesCreatedIn(content: string): string[] {
  const tables = new Set<string>();
  for (const statement of splitStatements(content)) {
    const match = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? (?:"public"\.)?"([^"]+)"/i);
    if (match) tables.add(match[1]);
  }
  return [...tables];
}

export type CreatedObjects = {
  tables: string[];
  indexes: string[];
  constraints: Array<{ table: string; name: string }>;
};

/** Names a migration creates (tables, indexes, named constraints), for collision checks against an existing schema. */
export function createdObjectsIn(content: string): CreatedObjects {
  const created: CreatedObjects = { tables: [], indexes: [], constraints: [] };
  for (const statement of splitStatements(content)) {
    const table = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? (?:"public"\.)?"([^"]+)"/i);
    if (table) created.tables.push(table[1]);
    const index = statement.match(/^CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)?(?: IF NOT EXISTS)? "([^"]+)"/i);
    if (index) created.indexes.push(index[1]);
    const constraint = statement.match(/^ALTER TABLE(?: IF EXISTS)?(?: ONLY)? (?:"public"\.)?"([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
    if (constraint) created.constraints.push({ table: constraint[1], name: constraint[2] });
  }
  return created;
}

export type DestructiveStatement =
  | { kind: "drop_table"; table: string }
  | { kind: "drop_column"; table: string; column: string };

/** DROP TABLE / DROP COLUMN statements: the places where an upgrade can lose prod data. */
export function destructiveStatementsIn(content: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];
  for (const statement of splitStatements(content)) {
    const dropTable = statement.match(/^DROP TABLE(?: IF EXISTS)? (?:"public"\.)?"([^"]+)"/i);
    if (dropTable) {
      found.push({ kind: "drop_table", table: dropTable[1] });
      continue;
    }
    const dropColumn = statement.match(
      /^ALTER TABLE(?: IF EXISTS)?(?: ONLY)? (?:"public"\.)?"([^"]+)" DROP COLUMN(?: IF EXISTS)? "([^"]+)"/i,
    );
    if (dropColumn) found.push({ kind: "drop_column", table: dropColumn[1], column: dropColumn[2] });
  }
  return found;
}

export type ForkTableReference = { statement: string; table: string; via: "target" | "foreign_key" };

/** Statements that alter, drop or reference (FK) one of the given fork tables. */
export function forkTableReferencesIn(content: string, forkTables: ReadonlySet<string>): ForkTableReference[] {
  const found: ForkTableReference[] = [];
  for (const statement of splitStatements(content)) {
    const target = statement.match(
      /^(?:ALTER TABLE(?: IF EXISTS)?(?: ONLY)?|DROP TABLE(?: IF EXISTS)?|CREATE TABLE(?: IF NOT EXISTS)?|CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "[^"]+" ON) (?:"public"\.)?"([^"]+)"/i,
    );
    if (target && forkTables.has(target[1])) {
      found.push({ statement: statement.slice(0, 140), table: target[1], via: "target" });
    }
    for (const fk of statement.matchAll(/REFERENCES (?:"public"\.)?"([^"]+)"/gi)) {
      if (forkTables.has(fk[1])) {
        found.push({ statement: statement.slice(0, 140), table: fk[1], via: "foreign_key" });
      }
    }
  }
  return found;
}

export type JournalEntry = { idx: number; tag: string; when: number };

export type JournalAnalysis = {
  entries: number;
  maxWhen: number;
  maxWhenTag: string;
  /** Entries whose `when` is not greater than the previous entry's (journal order != created_at order). */
  nonMonotonic: Array<{ tag: string; when: number; previousTag: string; previousWhen: number }>;
  /** Upstream (non-9xxx) entries whose `when` is below the largest fork `when` (created_at fallback hazard). */
  upstreamBelowForkMax: number;
};

export function analyzeJournal(entries: JournalEntry[]): JournalAnalysis {
  let maxWhen = -1;
  let maxWhenTag = "";
  const nonMonotonic: JournalAnalysis["nonMonotonic"] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.when > maxWhen) {
      maxWhen = entry.when;
      maxWhenTag = entry.tag;
    }
    if (i > 0 && entry.when <= entries[i - 1].when) {
      nonMonotonic.push({
        tag: entry.tag,
        when: entry.when,
        previousTag: entries[i - 1].tag,
        previousWhen: entries[i - 1].when,
      });
    }
  }
  const forkMax = Math.max(
    -1,
    ...entries.filter((entry) => entry.tag.startsWith(FORK_MIGRATION_PREFIX)).map((entry) => entry.when),
  );
  const upstreamBelowForkMax = entries.filter(
    (entry) => !entry.tag.startsWith(FORK_MIGRATION_PREFIX) && entry.when < forkMax,
  ).length;
  return { entries: entries.length, maxWhen, maxWhenTag, nonMonotonic, upstreamBelowForkMax };
}

/**
 * Scrub a database error message before it goes into the report: Postgres embeds offending row
 * values in quotes (`invalid input syntax for type uuid: "…"`). Quoted text survives only after
 * an identifier keyword (relation, column, table, ...). Only the first line is kept.
 */
export function redactDbError(message: string, maxLength = 200): string {
  const firstLine = message.split("\n")[0] ?? "";
  return firstLine
    .replace(/(?<!\b(?:relation|column|table|constraint|index|function|type|schema|database|role|sequence)\s)"[^"]*"/gi, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, maxLength);
}
