import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkPinnedForkHashes } from "./migration-dry-run-lib.js";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const forkHashesPath = fileURLToPath(new URL("./fork-migration-hashes.json", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

type JournalFile = {
  entries?: Array<{
    idx?: number;
    tag?: string;
  }>;
};

function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

// client.ts identifies applied migrations by sha256 of the file content, so an edited 9xxx file
// would be replayed against prod as a new pending migration. Edit = new file, never a rewrite.
async function ensureForkMigrationHashesPinned(migrationFiles: string[]) {
  const baseline = JSON.parse(await readFile(forkHashesPath, "utf8")) as Record<string, string>;
  const files = await Promise.all(
    migrationFiles.map(async (file) => ({ file, content: await readFile(`${migrationsDir}/${file}`, "utf8") })),
  );
  const result = checkPinnedForkHashes(files, baseline);
  const problems = [
    ...result.changed.map((c) => `${c.file} changed (pinned ${c.expected.slice(0, 12)}, now ${c.actual.slice(0, 12)})`),
    ...result.missingBaseline.map((file) => `${file} has no pinned hash in src/fork-migration-hashes.json`),
    ...result.staleBaseline.map((file) => `${file} is pinned but the file is missing`),
  ];
  if (problems.length > 0) {
    throw new Error(
      `Fork migration hash baseline violated (already-applied 9xxx files must never change; add new files to src/fork-migration-hashes.json):\n- ${problems.join("\n- ")}`,
    );
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalTags = (journal.entries ?? [])
    .map((entry, index) => {
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`Migration journal entry ${index} is missing a tag`);
      }
      return entry.tag;
    });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
  await ensureForkMigrationHashesPinned(migrationFiles);
}

await main();
