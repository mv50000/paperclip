import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

// --- RK9 Custom (RK9-316) --- fork 9000 series (doc/UPSTREAM-UPGRADE.md, "Migraatiokonventio").
test('passes an upstream stage whose 0xxx migrations follow the latest 0xxx even when master has 9xxx', () => {
  const result = checkMigrationOrder(
    [migration('0211_on_master'), migration('9010_rk9_on_master')],
    [migration('0212_from_upstream'), migration('0230_from_upstream')],
  );

  assert.equal(result.passed, true);
});

test('fails an upstream migration inserted before the latest 0xxx even when master has 9xxx', () => {
  const result = checkMigrationOrder(
    [migration('0211_on_master'), migration('9010_rk9_on_master')],
    [migration('0211_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0211_on_master\.sql/);
  assert.match(result.message, /starting at 0212/);
});

test('passes a new fork migration after the latest 9xxx', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master'), migration('9010_rk9_on_master')],
    [migration('9011_rk9_new')],
  );

  assert.equal(result.passed, true);
});

test('fails a fork migration that reuses a 9xxx number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master'), migration('9010_rk9_on_master')],
    [migration('9010_rk9_duplicate')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*9010_rk9_on_master\.sql/);
  assert.match(result.message, /starting at 9011/);
});

// --- RK9 Custom (RK9-317) --- pinned fork files in free slots (0126 in the upstream gap, 9000).
test('passes pinned fork files in free slots below the series maximum', () => {
  const result = checkMigrationOrder(
    [migration('0125_on_master'), migration('0230_on_master'), migration('9001_rk9_on_master'), migration('9010_rk9_on_master')],
    [migration('0126_rk9_slot'), migration('9000_rk9_slot'), migration('0231_upstream_new')],
    new Set(['0126_rk9_slot.sql', '9000_rk9_slot.sql']),
  );

  assert.equal(result.passed, true);
});

test('fails an unpinned file in a free slot below the series maximum', () => {
  const result = checkMigrationOrder(
    [migration('0125_on_master'), migration('0230_on_master')],
    [migration('0126_not_pinned')],
    new Set(['0126_rk9_slot.sql']),
  );

  assert.equal(result.passed, false);
});

test('fails a pinned fork file whose number the target branch already has', () => {
  const result = checkMigrationOrder(
    [migration('0126_on_master'), migration('0230_on_master')],
    [migration('0126_rk9_slot')],
    new Set(['0126_rk9_slot.sql']),
  );

  assert.equal(result.passed, false);
});
