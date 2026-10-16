/**
 * Company-scoped access to the plugin ledger (migration 001).
 *
 * Every helper takes `companyId` first and binds it as `$1` in a
 * `WHERE company_id = $1` clause (or as the company_id value of an INSERT).
 * Table and column names come only from the allowlist below, never from
 * caller strings, so a helper cannot be steered into another table or tenant.
 * Features reach the ledger through these helpers, not through raw `ctx.db`.
 * The rule is enforced by review, not by the runtime: `ctx.db` stays reachable
 * through the plugin context. A new helper must keep `company_id = $1`.
 */

import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

/** Columns per ledger table, mirroring migrations/001_rk9_ads_ledger.sql. */
export const LEDGER_COLUMNS = {
  brand_bindings: [
    "id", "company_id", "brand_code", "ad_account_id", "page_id", "ig_user_id", "dataset_id",
    "campaign_id", "adset_id", "binding_source", "status", "metadata", "created_at", "updated_at",
  ],
  creatives: [
    "id", "company_id", "brand_code", "sha256", "idempotency_key", "kind", "aspect_ratio", "media_url",
    "thumbnail_url", "ad_copy", "cta", "landing_url_key", "utm_campaign", "target_adset_id", "valid_until",
    "meta_video_id", "meta_image_hash", "status", "error", "payload", "created_at", "updated_at",
  ],
  publications: [
    "id", "company_id", "brand_code", "creative_id", "idempotency_key", "content_hash", "mode", "status",
    "ad_name", "campaign_id", "adset_id", "meta_video_id", "meta_image_hash", "meta_creative_id", "meta_ad_id",
    "replaces_publication_id", "error", "payload", "published_at", "created_at", "updated_at",
  ],
  gate_requests: [
    "id", "company_id", "brand_code", "kind", "status", "token", "publication_id", "ad_id", "adset_id",
    "payload", "chat_id", "message_id", "valid_until", "decided_by_tg_user_id", "decided_at", "outcome",
    "paused_ad_ids", "error", "created_at", "updated_at",
  ],
  rule_actions: [
    "id", "company_id", "brand_code", "rule_id", "rule_type", "object_type", "object_id", "action", "mode",
    "source", "dry_run", "applied", "reason", "metrics", "gate_request_id", "error", "decided_at", "created_at",
  ],
  insights_daily: [
    "id", "company_id", "brand_code", "ad_id", "date", "campaign_id", "adset_id", "currency", "spend",
    "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "ctr", "cpc", "cpm", "actions",
    "is_final", "fetched_at", "created_at", "updated_at",
  ],
  digest_runs: [
    "id", "company_id", "brand_code", "digest_date", "status", "attempts", "chat_id", "message_id", "summary",
    "error", "sent_at", "created_at", "updated_at",
  ],
  alert_dedupe: ["id", "company_id", "dedupe_key", "kind", "metadata", "created_at"],
  processed_updates: ["id", "company_id", "bot_key", "update_id", "update_kind", "received_at"],
} as const satisfies Record<string, readonly string[]>;

export type LedgerTable = keyof typeof LEDGER_COLUMNS;
export type LedgerColumn<T extends LedgerTable> = (typeof LEDGER_COLUMNS)[T][number];
export type LedgerRow = Record<string, unknown>;
export type LedgerValues<T extends LedgerTable> = Partial<Record<Exclude<LedgerColumn<T>, "company_id">, unknown>>;
export type LedgerWhere<T extends LedgerTable> = Partial<Record<Exclude<LedgerColumn<T>, "company_id">, unknown>>;

export const LEDGER_TABLES = Object.keys(LEDGER_COLUMNS) as LedgerTable[];

/** Status sets, mirroring the CHECK constraints of migration 001. */
export const GATE_REQUEST_STATUSES = ["pending", "approved", "denied", "skipped", "expired", "failed"] as const;
export const GATE_REQUEST_KINDS = ["activate_ad", "pause_all"] as const;
export const PUBLICATION_STATUSES = ["pending", "published", "failed", "swapped"] as const;
export const CREATIVE_STATUSES = ["staged", "uploading", "ready", "published", "rejected", "expired", "failed"] as const;
export const DIGEST_RUN_STATUSES = ["pending", "sent", "failed", "skipped"] as const;

const NAMESPACE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelectOptions<T extends LedgerTable> {
  where?: LedgerWhere<T>;
  orderBy?: { column: LedgerColumn<T>; direction?: "asc" | "desc" };
  limit?: number;
}

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) {
    throw new Error("A ledger call needs a companyId (uuid)");
  }
}

function assertColumn<T extends LedgerTable>(table: T, column: string): asserts column is LedgerColumn<T> {
  if (!Object.hasOwn(LEDGER_COLUMNS, table) || !(LEDGER_COLUMNS[table] as readonly string[]).includes(column)) {
    throw new Error(`Unknown column ${String(table)}.${column}`);
  }
}

/** Calendar-date columns. They take a local "YYYY-MM-DD" string, never a Date. */
const DATE_COLUMNS = new Set(["date", "digest_date"]);

/** Objects and arrays go to jsonb columns as JSON text. */
function toParam(column: string, value: unknown): unknown {
  if (value instanceof Date) {
    // A Date is a UTC instant; its UTC day differs from the Helsinki day late in the evening.
    if (DATE_COLUMNS.has(column)) throw new Error(`${column} takes a local YYYY-MM-DD string (see kit/local-time localDate)`);
    return value.toISOString();
  }
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

export function createLedger(db: PluginDatabaseClient) {
  const namespace = db.namespace;
  if (!NAMESPACE_RE.test(namespace)) throw new Error(`Invalid plugin namespace ${namespace}`);

  function qualified(table: LedgerTable): string {
    if (!Object.hasOwn(LEDGER_COLUMNS, table)) throw new Error(`Unknown ledger table ${String(table)}`);
    return `${namespace}.${table}`;
  }

  /** Builds `company_id = $1 AND col = $n ...`; params[0] is always companyId. */
  function whereClause<T extends LedgerTable>(table: T, companyId: string, where: LedgerWhere<T> = {}, params: unknown[]) {
    params.push(companyId);
    const parts = ["company_id = $1"];
    for (const [column, value] of Object.entries(where)) {
      if (value === undefined) continue;
      assertColumn(table, column);
      if (column === "company_id") throw new Error("company_id comes from the companyId argument only");
      if (value === null) {
        parts.push(`${column} IS NULL`);
      } else {
        params.push(toParam(column, value));
        parts.push(`${column} = $${params.length}`);
      }
    }
    return parts.join(" AND ");
  }

  return {
    namespace,
    qualified,

    async select<T extends LedgerTable, R = LedgerRow>(companyId: string, table: T, options: SelectOptions<T> = {}): Promise<R[]> {
      assertCompanyId(companyId);
      const params: unknown[] = [];
      let statement = `SELECT * FROM ${qualified(table)} WHERE ${whereClause(table, companyId, options.where, params)}`;
      if (options.orderBy) {
        assertColumn(table, options.orderBy.column);
        statement += ` ORDER BY ${options.orderBy.column} ${options.orderBy.direction === "desc" ? "DESC" : "ASC"}`;
      }
      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
          throw new Error("limit must be an integer 1-1000");
        }
        statement += ` LIMIT ${options.limit}`;
      }
      return db.query<R>(statement, params);
    },

    async count<T extends LedgerTable>(companyId: string, table: T, where?: LedgerWhere<T>): Promise<number> {
      assertCompanyId(companyId);
      const params: unknown[] = [];
      const rows = await db.query<{ n: number | string }>(
        `SELECT count(*)::int AS n FROM ${qualified(table)} WHERE ${whereClause(table, companyId, where, params)}`,
        params,
      );
      return Number(rows[0]?.n ?? 0);
    },

    /** Inserts one row for `companyId`. Returns the row id (generated when absent). */
    async insert<T extends LedgerTable>(companyId: string, table: T, values: LedgerValues<T>): Promise<{ id: string; rowCount: number }> {
      assertCompanyId(companyId);
      if ("company_id" in values) throw new Error("company_id comes from the companyId argument only");
      const id = typeof (values as Record<string, unknown>).id === "string" ? String((values as Record<string, unknown>).id) : randomUUID();
      const columns = ["company_id", "id"];
      const params: unknown[] = [companyId, id];
      for (const [column, value] of Object.entries(values)) {
        if (column === "id" || value === undefined) continue;
        assertColumn(table, column);
        columns.push(column);
        params.push(toParam(column, value));
      }
      const placeholders = params.map((_, index) => `$${index + 1}`).join(", ");
      const result = await db.execute(
        `INSERT INTO ${qualified(table)} (${columns.join(", ")}) VALUES (${placeholders})`,
        params,
      );
      return { id, rowCount: result.rowCount };
    },

    /**
     * Inserts one row unless it would break a unique constraint
     * (`ON CONFLICT DO NOTHING`). `inserted` is false when the row already
     * existed: a once-only claim, e.g. an alert_dedupe key.
     */
    async insertIfAbsent<T extends LedgerTable>(companyId: string, table: T, values: LedgerValues<T>): Promise<{ inserted: boolean }> {
      assertCompanyId(companyId);
      if ("company_id" in values) throw new Error("company_id comes from the companyId argument only");
      const columns = ["company_id", "id"];
      const params: unknown[] = [companyId, typeof (values as Record<string, unknown>).id === "string" ? String((values as Record<string, unknown>).id) : randomUUID()];
      for (const [column, value] of Object.entries(values)) {
        if (column === "id" || value === undefined) continue;
        assertColumn(table, column);
        columns.push(column);
        params.push(toParam(column, value));
      }
      const placeholders = params.map((_, index) => `$${index + 1}`).join(", ");
      const result = await db.execute(
        `INSERT INTO ${qualified(table)} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        params,
      );
      return { inserted: result.rowCount === 1 };
    },

    /**
     * Updates rows of `companyId` that match every `where` column. Use it as a
     * compare-and-set: put the expected current status in `where` and check
     * `rowCount === 1`.
     */
    async update<T extends LedgerTable>(companyId: string, table: T, where: LedgerWhere<T>, values: LedgerValues<T>): Promise<number> {
      assertCompanyId(companyId);
      if (Object.values(where).every((value) => value === undefined)) {
        throw new Error("update needs at least one where column besides company_id");
      }
      if ("company_id" in values || "id" in values) throw new Error("company_id and id cannot be updated");
      const params: unknown[] = [];
      const condition = whereClause(table, companyId, where, params);
      const assignments: string[] = [];
      for (const [column, value] of Object.entries(values)) {
        if (value === undefined) continue;
        assertColumn(table, column);
        params.push(toParam(column, value));
        assignments.push(`${column} = $${params.length}`);
      }
      if ((LEDGER_COLUMNS[table] as readonly string[]).includes("updated_at") && !("updated_at" in values)) {
        assignments.push("updated_at = now()");
      }
      if (assignments.length === 0) throw new Error("update needs at least one value");
      const result = await db.execute(`UPDATE ${qualified(table)} SET ${assignments.join(", ")} WHERE ${condition}`, params);
      return result.rowCount;
    },

    /** Deletes rows of `companyId` that match every `where` column, e.g. a once-only claim to give back. */
    async remove<T extends LedgerTable>(companyId: string, table: T, where: LedgerWhere<T>): Promise<number> {
      assertCompanyId(companyId);
      if (Object.values(where).every((value) => value === undefined)) {
        throw new Error("remove needs at least one where column besides company_id");
      }
      const params: unknown[] = [];
      const condition = whereClause(table, companyId, where, params);
      const result = await db.execute(`DELETE FROM ${qualified(table)} WHERE ${condition}`, params);
      return result.rowCount;
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;
