/**
 * The dry-run marker of a staged creative (RK9-849). A creative staged with
 * `meta.stagingMode: "dry_run"` carries `payload.stagingMode = "dry_run"`.
 * Publication, activation and live organic posts read the marker through
 * `isDryRunCreativeRow` and refuse the row.
 */

import type { LedgerRow } from "../db.js";

export const DRY_RUN_STAGING = "dry_run";

/** The row's jsonb payload as an object; anything else is an empty object. */
export function creativePayloadOf(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** True when the ledger row was staged in dry-run mode and not staged live since. */
export function isDryRunCreativeRow(row: LedgerRow): boolean {
  return creativePayloadOf(row.payload).stagingMode === DRY_RUN_STAGING;
}
