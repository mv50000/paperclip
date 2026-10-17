/**
 * Ledger access of the rule engine (A11, RK9-515), behind an interface so the
 * runner tests can inject an in-memory store.
 *
 * Inserts go through the generic ledger helpers (../../db.ts). The two reads
 * that need a join or a time window are written here under the same rules as
 * insights/store.ts: `companyId` is always `$1`, every table is filtered by
 * `company_id = $1`, and table and column names are literals of this file.
 * Only tables of migration 001 are used.
 */

import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { createLedger } from "../../db.js";
import { closeMarkerKey } from "../../insights/ingest.js";
import { createInsightsStore } from "../../insights/store.js";
import type { PriorRuleAction, RuleAdDay } from "./evaluate.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
/** Bounds the prior-action read; the cooldown lookback is at most 720 h. */
const PRIOR_ACTIONS_MAX_ROWS = 5000;

export interface RuleActionRow {
  brandCode: string;
  ruleId: string;
  ruleType: string;
  objectType: "account" | "campaign" | "adset" | "ad";
  objectId: string;
  action: "pause" | "pause_all" | "propose_scale" | "none";
  mode: "shadow" | "live";
  dryRun: boolean;
  applied: boolean;
  reason: string;
  metrics: Record<string, unknown>;
  error: string | null;
  decidedAt: Date;
}

export interface RulesStore {
  /**
   * True when insights-daily-close has finalised the day before `localToday`
   * (its marker is keyed by the local date whose yesterday it closed).
   */
  dayClosed(companyId: string, localToday: string): Promise<boolean>;
  /** Ad-days in an inclusive local-date range, for ads with impressions in it. */
  adDays(companyId: string, since: string, until: string): Promise<RuleAdDay[]>;
  /** validUntil of the creative of each published ad (its latest publication). */
  creativeValidity(companyId: string): Promise<Array<{ adId: string; validUntil: string }>>;
  /** The latest decision per (rule, object, mode, applied) since `since`. */
  priorActions(companyId: string, ruleIds: readonly string[], since: Date): Promise<PriorRuleAction[]>;
  insertAction(companyId: string, row: RuleActionRow): Promise<void>;
}

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) throw new Error("A rules store call needs a companyId (uuid)");
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function createRulesStore(db: PluginDatabaseClient): RulesStore {
  const ns = db.namespace;
  if (!NAMESPACE_RE.test(ns)) throw new Error(`Invalid plugin namespace ${ns}`);
  const ledger = createLedger(db);
  const insights = createInsightsStore(db);

  return {
    async dayClosed(companyId, localToday) {
      return insights.hasMark(companyId, closeMarkerKey(localToday));
    },

    async adDays(companyId, since, until) {
      const rows = await insights.recentAdSeries(companyId, since, since);
      return rows
        .filter((row) => row.date <= until)
        .map((row) => ({
          adId: row.adId,
          date: row.date,
          spendCents: row.spendCents,
          impressions: row.impressions,
          inlineLinkClicks: row.inlineLinkClicks,
          frequency: row.frequency,
        }));
    },

    async creativeValidity(companyId) {
      assertCompanyId(companyId);
      const rows = await db.query<{ ad_id: unknown; valid_until: unknown }>(
        `SELECT DISTINCT ON (p.meta_ad_id) p.meta_ad_id AS ad_id, c.valid_until FROM ${ns}.publications p ` +
          `JOIN ${ns}.creatives c ON c.company_id = $1 AND c.id = p.creative_id ` +
          `WHERE p.company_id = $1 AND p.status = 'published' AND p.meta_ad_id IS NOT NULL ` +
          `ORDER BY p.meta_ad_id, p.published_at DESC NULLS LAST, p.created_at DESC`,
        [companyId],
      );
      const out: Array<{ adId: string; validUntil: string }> = [];
      for (const row of rows) {
        const validUntil = iso(row.valid_until);
        if (validUntil && row.ad_id !== null && row.ad_id !== undefined) out.push({ adId: String(row.ad_id), validUntil });
      }
      return out;
    },

    async priorActions(companyId, ruleIds, since) {
      assertCompanyId(companyId);
      if (ruleIds.length === 0) return [];
      const rows = await db.query<Record<string, unknown>>(
        `SELECT rule_id, object_id, mode, applied, max(decided_at) AS decided_at FROM ${ns}.rule_actions ` +
          `WHERE company_id = $1 AND decided_at >= $2::timestamptz AND action IN ('pause', 'pause_all') ` +
          `GROUP BY rule_id, object_id, mode, applied LIMIT ${PRIOR_ACTIONS_MAX_ROWS}`,
        [companyId, since.toISOString()],
      );
      // A cut list could hide a decision and break a cooldown: refuse instead.
      if (rows.length >= PRIOR_ACTIONS_MAX_ROWS) throw new Error(`priorActions: more than ${PRIOR_ACTIONS_MAX_ROWS} rows`);
      const wanted = new Set(ruleIds);
      return rows
        .filter((row) => wanted.has(String(row.rule_id)))
        .map((row) => ({
          ruleId: String(row.rule_id),
          objectId: String(row.object_id),
          mode: row.mode === "live" ? "live" : "shadow",
          applied: row.applied === true,
          decidedAt: iso(row.decided_at) ?? new Date(0).toISOString(),
        }));
    },

    async insertAction(companyId, row) {
      await ledger.insert(companyId, "rule_actions", {
        brand_code: row.brandCode,
        rule_id: row.ruleId,
        rule_type: row.ruleType,
        object_type: row.objectType,
        object_id: row.objectId,
        action: row.action,
        mode: row.mode,
        source: "job",
        dry_run: row.dryRun,
        applied: row.applied,
        reason: row.reason.slice(0, 500),
        metrics: row.metrics,
        error: row.error,
        decided_at: row.decidedAt,
      });
    },
  };
}

/** In-memory store for tests: rows in, rows out, no SQL. */
export function memoryRulesStore(seed: { days?: RuleAdDay[]; creatives?: Array<{ adId: string; validUntil: string }>; closed?: boolean } = {}) {
  const days = [...(seed.days ?? [])];
  const creatives = [...(seed.creatives ?? [])];
  const actions: Array<RuleActionRow & { companyId: string }> = [];
  const store: RulesStore & { actions: typeof actions; days: RuleAdDay[]; creatives: typeof creatives; closed: boolean; failInsert: boolean } = {
    actions,
    days,
    creatives,
    closed: seed.closed ?? true,
    failInsert: false,
    async dayClosed() {
      return store.closed;
    },
    async adDays(_companyId, since, until) {
      const active = new Set(days.filter((day) => day.date >= since && day.date <= until && day.impressions > 0).map((day) => day.adId));
      return days.filter((day) => active.has(day.adId) && day.date >= since && day.date <= until);
    },
    async creativeValidity() {
      return [...creatives];
    },
    async priorActions(companyId, ruleIds, since) {
      return actions
        .filter((row) => row.companyId === companyId && ruleIds.includes(row.ruleId) && row.decidedAt >= since && (row.action === "pause" || row.action === "pause_all"))
        .map((row) => ({ ruleId: row.ruleId, objectId: row.objectId, mode: row.mode, applied: row.applied, decidedAt: row.decidedAt.toISOString() }));
    },
    async insertAction(companyId, row) {
      if (store.failInsert) throw new Error("insert failed");
      actions.push({ ...row, companyId });
    },
  };
  return store;
}
