/**
 * Company-scoped SQL for insights, digest and fatigue (A10, RK9-512).
 *
 * Plain inserts and lookups go through the generic ledger helpers (../db.ts).
 * They cannot express upserts, sums or time windows, so this module writes
 * those statements itself under the same
 * rules: `companyId` is always `$1` and every statement filters or inserts
 * `company_id = $1`; table and column names are literals of this file, never
 * caller strings. Only tables of migration 001 are used (no migration 003):
 * insights_daily, digest_runs, alert_dedupe, rule_actions and gate_requests.
 */

import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { createLedger } from "../db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAMESPACE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const UPSERT_BATCH = 50;
/** recentAdSeries page size and page bound (RK9-526: 5000 rows was about 55 ads x 90 days). */
const SERIES_PAGE_ROWS = 5000;
const SERIES_MAX_PAGES = 40;

/** One ad-day as stored in insights_daily. Money in cents, rates computed by ../metrics/cpc.ts. */
export interface InsightDayRow {
  brandCode: string;
  adId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  currency: string | null;
  spendCents: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  clicks: number;
  inlineLinkClicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  actions: unknown[];
  isFinal: boolean;
}

/** A stored ad-day as read back (numbers parsed). */
export interface StoredInsightDay {
  adId: string;
  date: string;
  spendCents: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  clicks: number;
  inlineLinkClicks: number;
}

export interface DayTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  inlineLinkClicks: number;
  ads: number;
}

export interface RuleActionSummary {
  ruleId: string;
  ruleType: string;
  action: string;
  objectType: string;
  objectId: string;
  mode: string;
  applied: boolean;
  decidedAt: string;
}

export interface PendingGateSummary {
  kind: string;
  adId: string | null;
  validUntil: string;
}

export interface DigestRunRow {
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
}

function assertCompanyId(companyId: string): void {
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) throw new Error("An insights store call needs a companyId (uuid)");
}

function assertDate(value: string, field: string): void {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Decimal string with fixed places for a numeric column; null stays null. */
function fixed(value: number | null, places: number): string | null {
  return value === null || !Number.isFinite(value) ? null : value.toFixed(places);
}

function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function createInsightsStore(db: PluginDatabaseClient) {
  const ns = db.namespace;
  if (!NAMESPACE_RE.test(ns)) throw new Error(`Invalid plugin namespace ${ns}`);
  const ledger = createLedger(db);

  return {
    /**
     * Upserts ad-days keyed by (company_id, ad_id, date). A re-run overwrites
     * the metrics with Meta's latest numbers (attribution moves for ~72 h), so
     * the same window twice gives the same rows and values.
     */
    async upsertDays(companyId: string, rows: readonly InsightDayRow[]): Promise<number> {
      assertCompanyId(companyId);
      // One row per (ad, date): Postgres refuses an upsert batch that hits the same key twice. The last row wins.
      const unique = [...new Map(rows.map((row) => [`${row.adId}|${row.date}`, row])).values()];
      let written = 0;
      for (let start = 0; start < unique.length; start += UPSERT_BATCH) {
        const batch = unique.slice(start, start + UPSERT_BATCH);
        const params: unknown[] = [companyId];
        const tuples: string[] = [];
        for (const row of batch) {
          assertDate(row.date, "date");
          const values = [
            row.brandCode,
            row.adId,
            row.date,
            row.campaignId,
            row.adsetId,
            row.currency,
            centsToDecimal(row.spendCents),
            row.impressions,
            row.reach,
            fixed(row.frequency, 4),
            row.clicks,
            row.inlineLinkClicks,
            fixed(row.ctr, 4),
            fixed(row.cpc, 4),
            fixed(row.cpm, 4),
            JSON.stringify(row.actions ?? []),
            row.isFinal,
          ];
          const placeholders = values.map((value) => {
            params.push(value);
            return `$${params.length}`;
          });
          // $1 is company_id for every tuple.
          tuples.push(
            `($1, ${placeholders[0]}, ${placeholders[1]}, ${placeholders[2]}::date, ${placeholders[3]}, ${placeholders[4]}, ${placeholders[5]}, ` +
              `${placeholders[6]}::numeric, ${placeholders[7]}, ${placeholders[8]}, ${placeholders[9]}::numeric, ${placeholders[10]}, ${placeholders[11]}, ` +
              `${placeholders[12]}::numeric, ${placeholders[13]}::numeric, ${placeholders[14]}::numeric, ${placeholders[15]}::jsonb, ${placeholders[16]})`,
          );
        }
        const result = await db.execute(
          `INSERT INTO ${ns}.insights_daily (company_id, brand_code, ad_id, date, campaign_id, adset_id, currency, spend, impressions, reach, ` +
            `frequency, clicks, inline_link_clicks, ctr, cpc, cpm, actions, is_final) VALUES ${tuples.join(", ")} ` +
            `ON CONFLICT (company_id, ad_id, date) DO UPDATE SET brand_code = EXCLUDED.brand_code, campaign_id = EXCLUDED.campaign_id, ` +
            `adset_id = EXCLUDED.adset_id, currency = EXCLUDED.currency, spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, ` +
            `reach = EXCLUDED.reach, frequency = EXCLUDED.frequency, clicks = EXCLUDED.clicks, inline_link_clicks = EXCLUDED.inline_link_clicks, ` +
            `ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, cpm = EXCLUDED.cpm, actions = EXCLUDED.actions, is_final = EXCLUDED.is_final, ` +
            `fetched_at = now(), updated_at = now()`,
          params,
        );
        written += result.rowCount;
      }
      return written;
    },

    /** Sum of spend in cents over an inclusive date range. */
    async spendCents(companyId: string, since: string, until: string): Promise<number> {
      assertCompanyId(companyId);
      assertDate(since, "since");
      assertDate(until, "until");
      const rows = await db.query<{ cents: unknown }>(
        `SELECT COALESCE(round(sum(spend) * 100), 0)::bigint AS cents FROM ${ns}.insights_daily ` +
          `WHERE company_id = $1 AND date >= $2::date AND date <= $3::date`,
        [companyId, since, until],
      );
      return num(rows[0]?.cents);
    },

    async dayTotals(companyId: string, date: string): Promise<DayTotals> {
      assertCompanyId(companyId);
      assertDate(date, "date");
      const rows = await db.query<Record<string, unknown>>(
        `SELECT COALESCE(round(sum(spend) * 100), 0)::bigint AS cents, COALESCE(sum(impressions), 0)::bigint AS impressions, ` +
          `COALESCE(sum(clicks), 0)::bigint AS clicks, COALESCE(sum(inline_link_clicks), 0)::bigint AS link_clicks, ` +
          `count(*) FILTER (WHERE impressions > 0)::int AS ads ` +
          `FROM ${ns}.insights_daily WHERE company_id = $1 AND date = $2::date`,
        [companyId, date],
      );
      const row = rows[0] ?? {};
      return {
        spendCents: num(row.cents),
        impressions: num(row.impressions),
        clicks: num(row.clicks),
        inlineLinkClicks: num(row.link_clicks),
        ads: num(row.ads),
      };
    },

    /** Number of stored ad-days in a range (backfill gap check). */
    async countDays(companyId: string, since: string, until: string): Promise<number> {
      assertCompanyId(companyId);
      assertDate(since, "since");
      assertDate(until, "until");
      const rows = await db.query<{ n: unknown }>(
        `SELECT count(*)::int AS n FROM ${ns}.insights_daily WHERE company_id = $1 AND date >= $2::date AND date <= $3::date`,
        [companyId, since, until],
      );
      return num(rows[0]?.n);
    },

    /**
     * Daily series of every ad that had impressions on or after `activeSince`,
     * from `horizonSince` on, ordered by ad and date. Feeds computeFatigue.
     * Read in keyset pages of SERIES_PAGE_ROWS (RK9-526), so a large account
     * gets every row; past SERIES_MAX_PAGES it throws rather than cut rows.
     */
    async recentAdSeries(companyId: string, activeSince: string, horizonSince: string): Promise<StoredInsightDay[]> {
      assertCompanyId(companyId);
      assertDate(activeSince, "activeSince");
      assertDate(horizonSince, "horizonSince");
      const rows: Record<string, unknown>[] = [];
      let after: { adId: string; day: string } | null = null;
      for (let page = 0; ; page += 1) {
        if (page >= SERIES_MAX_PAGES) throw new Error(`recentAdSeries: more than ${SERIES_MAX_PAGES * SERIES_PAGE_ROWS} rows`);
        const cursor = after ? `AND (ad_id, date) > ($4, $5::date) ` : "";
        const batch: Record<string, unknown>[] = await db.query<Record<string, unknown>>(
          `SELECT ad_id, to_char(date, 'YYYY-MM-DD') AS day, round(spend * 100)::bigint AS cents, impressions, reach, frequency, clicks, inline_link_clicks ` +
            `FROM ${ns}.insights_daily WHERE company_id = $1 AND date >= $3::date AND ad_id IN ` +
            `(SELECT ad_id FROM ${ns}.insights_daily WHERE company_id = $1 AND date >= $2::date AND impressions > 0) ` +
            cursor +
            `ORDER BY ad_id, date LIMIT ${SERIES_PAGE_ROWS}`,
          after ? [companyId, activeSince, horizonSince, after.adId, after.day] : [companyId, activeSince, horizonSince],
        );
        rows.push(...batch);
        if (batch.length < SERIES_PAGE_ROWS) break;
        const last = batch[batch.length - 1]!;
        after = { adId: String(last.ad_id), day: String(last.day) };
      }
      return rows.map((row) => ({
        adId: String(row.ad_id),
        date: String(row.day),
        spendCents: num(row.cents),
        impressions: num(row.impressions),
        reach: num(row.reach),
        frequency: numOrNull(row.frequency),
        clicks: num(row.clicks),
        inlineLinkClicks: num(row.inline_link_clicks),
      }));
    },

    /** Rule actions decided in the last `hours` hours, newest first. */
    async recentRuleActions(companyId: string, hours = 24, limit = 50): Promise<RuleActionSummary[]> {
      assertCompanyId(companyId);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT rule_id, rule_type, action, object_type, object_id, mode, applied, decided_at FROM ${ns}.rule_actions ` +
          `WHERE company_id = $1 AND decided_at > now() - make_interval(hours => $2::int) ORDER BY decided_at DESC LIMIT ${Math.min(Math.max(1, Math.trunc(limit)), 200)}`,
        [companyId, Math.trunc(hours)],
      );
      return rows.map((row) => ({
        ruleId: String(row.rule_id),
        ruleType: String(row.rule_type),
        action: String(row.action),
        objectType: String(row.object_type),
        objectId: String(row.object_id),
        mode: String(row.mode),
        applied: row.applied === true,
        decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
      }));
    },

    /** Gate cards still waiting for a tap. */
    async pendingGates(companyId: string): Promise<PendingGateSummary[]> {
      assertCompanyId(companyId);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT kind, ad_id, valid_until FROM ${ns}.gate_requests WHERE company_id = $1 AND status = 'pending' AND valid_until > now() ` +
          `ORDER BY valid_until LIMIT 50`,
        [companyId],
      );
      return rows.map((row) => ({
        kind: String(row.kind),
        adId: row.ad_id === null || row.ad_id === undefined ? null : String(row.ad_id),
        validUntil: row.valid_until instanceof Date ? row.valid_until.toISOString() : String(row.valid_until),
      }));
    },

    /** Inserts a once-only marker. True when this call created it. */
    async markOnce(companyId: string, dedupeKey: string, kind: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
      const { inserted } = await ledger.insertIfAbsent(companyId, "alert_dedupe", { dedupe_key: dedupeKey, kind, metadata });
      return inserted;
    },

    async hasMark(companyId: string, dedupeKey: string): Promise<boolean> {
      return (await ledger.count(companyId, "alert_dedupe", { dedupe_key: dedupeKey })) > 0;
    },

    /** Removes a marker this run created and could not follow through on. */
    async unmark(companyId: string, dedupeKey: string): Promise<void> {
      assertCompanyId(companyId);
      await db.execute(`DELETE FROM ${ns}.alert_dedupe WHERE company_id = $1 AND dedupe_key = $2`, [companyId, dedupeKey]);
    },

    /**
     * Markers of `kind` created in the last `hours` hours, oldest first: the
     * newest `limit` of them. `fresh` = created in the last 24 hours.
     */
    async recentMarks(
      companyId: string,
      kind: string,
      hours = 24,
      limit = 50,
    ): Promise<Array<{ dedupeKey: string; metadata: Record<string, unknown>; fresh: boolean }>> {
      assertCompanyId(companyId);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT dedupe_key, metadata, created_at > now() - interval '24 hours' AS fresh FROM ${ns}.alert_dedupe WHERE company_id = $1 AND kind = $2 ` +
          `AND created_at > now() - make_interval(hours => $3::int) ORDER BY created_at DESC LIMIT ${Math.min(Math.max(1, Math.trunc(limit)), 500)}`,
        [companyId, kind, Math.trunc(hours)],
      );
      return rows.reverse().map((row) => ({
        dedupeKey: String(row.dedupe_key),
        metadata: (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {}) as Record<string, unknown>,
        fresh: row.fresh === true,
      }));
    },

    async digestRun(companyId: string, digestDate: string): Promise<DigestRunRow | null> {
      assertDate(digestDate, "digestDate");
      const [row] = await ledger.select(companyId, "digest_runs", { where: { digest_date: digestDate }, limit: 1 });
      return row ? { status: row.status as DigestRunRow["status"], attempts: num(row.attempts) } : null;
    },

    /** Creates the day's digest row if missing. Runs before any send. */
    async ensureDigestRun(companyId: string, brandCode: string, digestDate: string): Promise<void> {
      assertDate(digestDate, "digestDate");
      await ledger.insertIfAbsent(companyId, "digest_runs", { brand_code: brandCode, digest_date: digestDate, status: "pending" });
    },

    /**
     * Claims one send attempt (compare-and-set). Succeeds for a fresh row, or
     * for a failed row whose last attempt is older than `retryAfterMinutes`,
     * while attempts < maxAttempts. A sent or skipped row is never claimed,
     * and neither is a pending row with attempts > 0: its send may already
     * have reached Telegram (see abandonStaleDigestRun).
     */
    async claimDigestRun(companyId: string, digestDate: string, maxAttempts: number, retryAfterMinutes: number): Promise<boolean> {
      assertCompanyId(companyId);
      assertDate(digestDate, "digestDate");
      const result = await db.execute(
        `UPDATE ${ns}.digest_runs SET attempts = attempts + 1, status = 'pending', updated_at = now() ` +
          `WHERE company_id = $1 AND digest_date = $2::date AND attempts < $3::int AND ` +
          `((status = 'pending' AND attempts = 0) OR (status = 'failed' AND updated_at < now() - make_interval(mins => $4::int)))`,
        [companyId, digestDate, Math.trunc(maxAttempts), Math.trunc(retryAfterMinutes)],
      );
      return result.rowCount === 1;
    },

    /**
     * Closes a claimed row that never finished (worker restart, or a sent
     * write that failed) once it is older than `staleMinutes`. The send state
     * is unknown, so the row becomes failed with attempts at the cap and is
     * never sent again: a missed digest is better than a duplicate.
     */
    async abandonStaleDigestRun(companyId: string, digestDate: string, maxAttempts: number, staleMinutes: number): Promise<boolean> {
      assertCompanyId(companyId);
      assertDate(digestDate, "digestDate");
      const result = await db.execute(
        `UPDATE ${ns}.digest_runs SET status = 'failed', attempts = GREATEST(attempts, $3::int), ` +
          `error = 'Abandoned mid-send (worker restart or unrecorded send); not resent to avoid a duplicate', updated_at = now() ` +
          `WHERE company_id = $1 AND digest_date = $2::date AND status = 'pending' AND attempts > 0 ` +
          `AND updated_at < now() - make_interval(mins => $4::int)`,
        [companyId, digestDate, Math.trunc(maxAttempts), Math.trunc(staleMinutes)],
      );
      return result.rowCount === 1;
    },

    async finishDigestRun(
      companyId: string,
      digestDate: string,
      outcome:
        | { status: "sent"; chatId: string; messageId: number | null; summary: Record<string, unknown> }
        | { status: "skipped"; summary: Record<string, unknown> }
        | { status: "failed"; error: string },
    ): Promise<number> {
      assertCompanyId(companyId);
      assertDate(digestDate, "digestDate");
      if (outcome.status === "sent") {
        const result = await db.execute(
          `UPDATE ${ns}.digest_runs SET status = 'sent', chat_id = $3, message_id = $4, summary = $5::jsonb, error = NULL, sent_at = now(), updated_at = now() ` +
            `WHERE company_id = $1 AND digest_date = $2::date AND status = 'pending'`,
          [companyId, digestDate, outcome.chatId, outcome.messageId, JSON.stringify(outcome.summary)],
        );
        return result.rowCount;
      }
      if (outcome.status === "skipped") {
        const result = await db.execute(
          `UPDATE ${ns}.digest_runs SET status = 'skipped', summary = $3::jsonb, updated_at = now() ` +
            `WHERE company_id = $1 AND digest_date = $2::date AND status = 'pending'`,
          [companyId, digestDate, JSON.stringify(outcome.summary)],
        );
        return result.rowCount;
      }
      const result = await db.execute(
        `UPDATE ${ns}.digest_runs SET status = 'failed', error = $3, updated_at = now() ` +
          `WHERE company_id = $1 AND digest_date = $2::date AND status = 'pending'`,
        [companyId, digestDate, outcome.error.slice(0, 500)],
      );
      return result.rowCount;
    },
  };
}

export type InsightsStore = ReturnType<typeof createInsightsStore>;
