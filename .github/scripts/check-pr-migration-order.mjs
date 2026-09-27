#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRECTORY = 'packages/db/src/migrations/';
const MIGRATION_FILE_PATTERN = /^packages\/db\/src\/migrations\/(\d{4})_[^/]+\.sql$/;

function parseMigration(file) {
  const match = file.match(MIGRATION_FILE_PATTERN);
  return match ? { file, number: Number.parseInt(match[1], 10) } : null;
}

// --- RK9 Custom (RK9-316) --- fork migration series, see checkMigrationOrder.
const FORK_SERIES_START = 9000;
const UPSTREAM_SERIES = 'upstream';
const FORK_SERIES = 'fork';

function migrationSeries(number) {
  return number >= FORK_SERIES_START ? FORK_SERIES : UPSTREAM_SERIES;
}
// --- end RK9 Custom ---

function formatMigrationNumber(number) {
  return String(number).padStart(4, '0');
}

// --- RK9 Custom (RK9-317) --- pinnedForkFiles: basenames pinned in the head's
// packages/db/src/fork-migration-hashes.json. A pinned fork file may sit in a free number below
// the series maximum (0126 in the upstream gap, 9000 before 9001) when the target branch has no
// file with that number. The hash pin and check:migrations guard these files.
const FORK_MIGRATION_HASHES_PATH = 'packages/db/src/fork-migration-hashes.json';

function basename(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}
// --- end RK9 Custom ---

export function checkMigrationOrder(baseMigrationFiles, prMigrationFiles, pinnedForkFiles = new Set()) {
  const invalidFiles = [...baseMigrationFiles, ...prMigrationFiles]
    .filter((file) => !parseMigration(file));

  if (invalidFiles.length > 0) {
    return {
      passed: false,
      message: [
        'Migration SQL files must start with a 4-digit number:',
        ...invalidFiles.map((file) => `- ${file}`),
      ].join('\n'),
    };
  }

  if (prMigrationFiles.length === 0) {
    return { passed: true, message: 'No new migrations in this PR.' };
  }

  const baseMigrations = baseMigrationFiles.map(parseMigration);
  const prMigrations = prMigrationFiles.map(parseMigration);
  // --- RK9 Custom (RK9-316) --- the fork keeps its own migrations in the 9000 series
  // (doc/UPSTREAM-UPGRADE.md, "Migraatiokonventio"). Each series is append-only on its
  // own: an upstream-stage PR adds 0xxx files after the latest 0xxx on master even
  // though master already has 9001+. Without this, every upgrade/v* PR would fail.
  const latestInSeries = (series) => baseMigrations
    .filter((migration) => migrationSeries(migration.number) === series)
    .reduce(
      (latest, migration) => migration.number > latest.number ? migration : latest,
      { file: '(none)', number: series === FORK_SERIES ? FORK_SERIES_START - 1 : -1 },
    );
  const baseNumbers = new Set(baseMigrations.map((migration) => migration.number));
  const outOfOrder = prMigrations.filter(
    (migration) => migration.number <= latestInSeries(migrationSeries(migration.number)).number
      // RK9 Custom (RK9-317): a pinned fork file in a free slot is not out of order.
      && !(pinnedForkFiles.has(basename(migration.file)) && !baseNumbers.has(migration.number)),
  );
  const latestBaseMigration = latestInSeries(
    migrationSeries((outOfOrder[0] ?? prMigrations[0]).number),
  );
  // --- end RK9 Custom ---

  if (outOfOrder.length === 0) {
    return {
      passed: true,
      message: `All new migrations follow ${latestBaseMigration.file}.`,
    };
  }

  const nextNumber = formatMigrationNumber(latestBaseMigration.number + 1);
  return {
    passed: false,
    message: [
      `The target branch already contains migrations through ${latestBaseMigration.file}.`,
      'This PR adds migration numbers that would be inserted into or collide with that history:',
      ...outOfOrder.map((migration) => `- ${migration.file}`),
      '',
      `Update from the target branch, then renumber this PR's migrations starting at ${nextNumber}`,
      'in their intended order. Keep each SQL filename, matching meta snapshot, and',
      'packages/db/src/migrations/meta/_journal.json entry aligned, then push again.',
      'Migration numbers are append-only and cannot reuse a number already present on the target branch.',
    ].join('\n'),
  };
}

function gitPaths(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function escapeWorkflowCommand(message) {
  return message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (!shaPattern.test(baseSha ?? '') || !shaPattern.test(headSha ?? '')) {
    console.error('Usage: check-pr-migration-order.mjs <40-character base SHA> <40-character head SHA>');
    process.exit(2);
  }

  const baseMigrationFiles = gitPaths([
    'ls-tree', '-r', '--name-only', '-z', baseSha, '--', MIGRATIONS_DIRECTORY,
  ]).filter((file) => file.endsWith('.sql'));
  const prMigrationFiles = gitPaths([
    'diff', '--name-only', '--diff-filter=A', '-z', `${baseSha}...${headSha}`, '--',
    MIGRATIONS_DIRECTORY,
  ]).filter((file) => file.endsWith('.sql'));
  // --- RK9 Custom (RK9-317) ---
  let pinnedForkFiles = new Set();
  try {
    const pinned = execFileSync('git', ['show', `${headSha}:${FORK_MIGRATION_HASHES_PATH}`], { encoding: 'utf8' });
    pinnedForkFiles = new Set(Object.keys(JSON.parse(pinned)));
  } catch {
    pinnedForkFiles = new Set();
  }
  const result = checkMigrationOrder(baseMigrationFiles, prMigrationFiles, pinnedForkFiles);
  // --- end RK9 Custom ---

  if (result.passed) {
    console.log(result.message);
    return;
  }

  console.error(
    `::error title=Migration numbers must follow the target branch::${escapeWorkflowCommand(result.message)}`,
  );
  console.error(result.message);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
