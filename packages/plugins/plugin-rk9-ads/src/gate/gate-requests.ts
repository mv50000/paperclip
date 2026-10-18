/**
 * The activation gate's view of `gate_requests` (A9, RK9-517).
 *
 * The kit's GateStore (src/kit/gate/state-machine.ts) owns the card life
 * cycle: insert, the pending -> decided compare-and-set, settle. This file
 * adds what only activate_ad cards need, over the same table:
 * - the ad columns (publication_id, ad_id, adset_id), written right after
 *   the pending insert (a second statement) and before the card is sent. A
 *   swap that lists the ad's cards between the two misses that card; the
 *   creative check at tap time still refuses it;
 * - open cards of one ad (a creative swap and pause-ad close them; a row
 *   without the ad column is found by its binding) and of the whole
 *   company (the kill switch, the cap pause and the scheduled pause close
 *   them, RK9-557);
 * - whether an approved activation of an ad may still be running;
 * - a newer completed activation of an object or a publication, which ends
 *   the retry of a failed undo (RK9-565), and one still running or with an
 *   unknown result (RK9-567);
 * - cards past valid_until for the expiry job;
 * - paused_ad_ids of a decided card.
 *
 * Every write is one conditional UPDATE scoped by company_id.
 */

import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import {
  GATE_RECORD_COLUMNS,
  toGateRecord,
  type GateRequestRecord,
  type GateStore,
  type NewGateRequest,
} from "../kit/gate/state-machine.js";

export const ACTIVATE_AD_KIND = "activate_ad";

/** What an activate_ad card binds its approval to (payload.activation). */
export interface ActivationBinding {
  publicationId: string;
  adId: string;
  adsetId: string;
  campaignId: string | null;
  /** The Meta creative the operator saw on the card. Checked against the ad right before activation. */
  creativeId: string;
  contentHash: string;
  adName: string;
  /** What the card shows, for a re-send. */
  media: "photo" | "video" | "text";
  mediaUrl: string | null;
}

const ID_RE = /^\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The binding of a card, or null when the payload is not a complete activate_ad binding. */
export function activationOf(request: Pick<GateRequestRecord, "kind" | "payload">): ActivationBinding | null {
  if (request.kind !== ACTIVATE_AD_KIND) return null;
  const raw = request.payload?.activation as Partial<ActivationBinding> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (!str(raw.publicationId) || !UUID_RE.test(raw.publicationId)) return null;
  if (!str(raw.adId) || !ID_RE.test(raw.adId) || !str(raw.adsetId) || !ID_RE.test(raw.adsetId)) return null;
  if (!str(raw.creativeId) || !ID_RE.test(raw.creativeId) || !str(raw.contentHash) || !str(raw.adName)) return null;
  if (raw.campaignId !== null && raw.campaignId !== undefined && !(str(raw.campaignId) && ID_RE.test(raw.campaignId))) return null;
  if (raw.media !== "photo" && raw.media !== "video" && raw.media !== "text") return null;
  if (raw.media !== "text" && !str(raw.mediaUrl)) return null;
  return {
    publicationId: raw.publicationId,
    adId: raw.adId,
    adsetId: raw.adsetId,
    campaignId: raw.campaignId ?? null,
    creativeId: raw.creativeId,
    contentHash: raw.contentHash,
    adName: raw.adName,
    media: raw.media,
    mediaUrl: raw.media === "text" ? null : (raw.mediaUrl as string),
  };
}

/** A card past valid_until, with the token hash the kit's `expire` takes. */
export interface DueCard {
  companyId: string;
  id: string;
  tokenHash: string;
}

export interface ActivationGateRepo {
  /**
   * Pending activate_ad cards of one ad, live or not: by the ad column, or by
   * the card's binding when the column is empty (a row from before the
   * column, or one between the insert and the column write; RK9-566).
   */
  openForAd(companyId: string, adId: string): Promise<GateRequestRecord[]>;
  /** Pending activate_ad cards of the company, live or not, oldest first. */
  openForCompany(companyId: string): Promise<GateRequestRecord[]>;
  /**
   * True while an activate_ad card of this ad is approved and its handler has
   * not recorded an end (between the tap and the handler's own outcome),
   * decided within the last `withinMinutes`: a worker that crashed mid-handler
   * leaves `started` behind, and that must not block the ad for good.
   */
  activationInFlight(companyId: string, adId: string, withinMinutes: number): Promise<boolean>;
  /** pending -> expired with an outcome (superseded, creative swapped, paused). True when this call won. */
  close(companyId: string, id: string, outcome: Record<string, unknown>): Promise<boolean>;
  /**
   * An activate_ad card other than `gateRequestId`, approved after `since`,
   * that names the object (as its ad, ad set or campaign, in the binding or
   * in the handler's outcome) or the publication of `gateRequestId`'s card:
   * one that activated (outcome.result activated), or one with no recorded
   * end. Of those, one approved within `inFlightMinutes` is still running
   * (`inFlight: true`); an older one has an unknown result (`unknown: true`):
   * its worker died, or its outcome was not stored (RK9-567). Running first,
   * then activated, then unknown. For a campaign (`objectKind`), a card with
   * no recorded end also matches by its ad set when that ad set is
   * `gateRequestId`'s or is known (from any card) to be under the campaign:
   * a swap card's binding names no campaign (RK9-567). An ad or ad set
   * never matches a sibling's running card, which cannot end its retry. `since` is on the worker's clock; the query moves it
   * to the database's clock, which `decided_at` uses (RK9-567).
   */
  newerActivation(companyId: string, input: NewerActivationQuery): Promise<NewerActivation | null>;
  /** Pending cards of every company whose valid_until has passed, oldest first. */
  dueForExpiry(limit: number): Promise<DueCard[]>;
  /** The pending activate_ad card of a publication, newest first. */
  pendingForPublication(companyId: string, publicationId: string): Promise<GateRequestRecord | null>;
  setPausedAdIds(companyId: string, id: string, adIds: readonly string[]): Promise<void>;
}

export interface NewerActivationQuery {
  objectId: string;
  /** The object's level. Only a campaign matches a running card by its ad set (RK9-567). */
  objectKind?: "campaign" | "adset" | "ad";
  gateRequestId: string;
  since: Date;
  inFlightMinutes: number;
}

export interface NewerActivation {
  id: string;
  inFlight: boolean;
  /** No end recorded and approved longer ago than `inFlightMinutes`: it may or may not have activated. */
  unknown?: boolean;
  /** Whole minutes since the card was approved, on the database's clock. */
  ageMinutes: number;
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function gateTable(db: PluginDatabaseClient): string {
  if (!IDENT_RE.test(db.namespace)) throw new Error(`Invalid SQL identifier ${db.namespace}`);
  return `${db.namespace}.gate_requests`;
}

/**
 * Wraps the kit's SQL store so an activate_ad row gets its ad columns right
 * after the insert, before the card goes out, so a swap that closes the ad's
 * cards sees it.
 */
export function withActivationColumns(store: GateStore, db: PluginDatabaseClient): GateStore {
  const gate = gateTable(db);
  return {
    ...store,
    async insertPending(request: NewGateRequest) {
      await store.insertPending(request);
      const binding = activationOf({ kind: request.kind, payload: request.payload });
      if (!binding) return;
      await db.execute(
        `UPDATE ${gate} SET publication_id = $3, ad_id = $4, adset_id = $5, updated_at = now()
          WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
        [request.companyId, request.id, binding.publicationId, binding.adId, binding.adsetId],
      );
    },
  };
}

export function sqlActivationGateRepo(db: PluginDatabaseClient, options: { now?: () => Date } = {}): ActivationGateRepo {
  const gate = gateTable(db);
  /** The worker's clock; tests move it to stand in for a skewed one. */
  const workerNow = options.now ?? (() => new Date());
  return {
    async openForAd(companyId, adId) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${GATE_RECORD_COLUMNS} FROM ${gate}
          WHERE company_id = $1 AND kind = 'activate_ad' AND status = 'pending'
            AND (ad_id = $2 OR (ad_id IS NULL AND payload->'activation'->>'adId' = $2))
          ORDER BY created_at`,
        [companyId, adId],
      );
      return rows.map(toGateRecord);
    },

    async openForCompany(companyId) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${GATE_RECORD_COLUMNS} FROM ${gate}
          WHERE company_id = $1 AND kind = 'activate_ad' AND status = 'pending'
          ORDER BY created_at`,
        [companyId],
      );
      return rows.map(toGateRecord);
    },

    async activationInFlight(companyId, adId, withinMinutes) {
      const rows = await db.query<{ n: unknown }>(
        `SELECT count(*) AS n FROM ${gate}
          WHERE company_id = $1 AND kind = 'activate_ad' AND status = 'approved'
            AND (ad_id = $2 OR (ad_id IS NULL AND payload->'activation'->>'adId' = $2))
            AND (outcome IS NULL OR outcome->>'handler' = 'started')
            AND decided_at > now() - make_interval(mins => $3)`,
        [companyId, adId, Math.max(1, Math.trunc(withinMinutes))],
      );
      return Number(rows[0]?.n ?? 0) > 0;
    },

    async newerActivation(companyId, input) {
      // $6 is the worker's time now: `since` + (database now - worker now) is the failure on the database's clock.
      const rows = await db.query<{ id: unknown; state: unknown; age_minutes: unknown }>(
        `SELECT id, state, age_minutes FROM (
           SELECT g.id, g.decided_at,
             CASE WHEN g.outcome->>'result' = 'activated' THEN 'activated'
                  WHEN g.decided_at > now() - make_interval(mins => $5) THEN 'in_flight'
                  ELSE 'unknown' END AS state,
             floor(extract(epoch FROM (now() - g.decided_at)) / 60) AS age_minutes
           FROM ${gate} g
           WHERE g.company_id = $1 AND g.kind = 'activate_ad' AND g.status = 'approved'
             AND g.decided_at > $3::timestamptz + (now() - $6::timestamptz) AND g.id::text <> $2
             AND (g.outcome->>'result' = 'activated' OR g.outcome IS NULL OR g.outcome->>'handler' = 'started')
             AND (g.ad_id = $4 OR g.adset_id = $4 OR g.payload->'activation'->>'campaignId' = $4
               OR g.outcome->>'adId' = $4 OR g.outcome->>'adsetId' = $4 OR g.outcome->>'campaignId' = $4
               OR g.publication_id = (SELECT o.publication_id FROM ${gate} o WHERE o.company_id = $1 AND o.id::text = $2)
               OR ($7 = 'campaign' AND (g.outcome IS NULL OR g.outcome->>'handler' = 'started') AND g.adset_id IS NOT NULL
                 AND (g.adset_id = (SELECT o.adset_id FROM ${gate} o WHERE o.company_id = $1 AND o.id::text = $2)
                   OR g.adset_id IN (SELECT o.adset_id FROM ${gate} o
                     WHERE o.company_id = $1 AND o.kind = 'activate_ad' AND o.adset_id IS NOT NULL
                       AND (o.payload->'activation'->>'campaignId' = $4 OR o.outcome->>'campaignId' = $4)))))
         ) hits
         ORDER BY CASE state WHEN 'in_flight' THEN 0 WHEN 'activated' THEN 1 ELSE 2 END, decided_at DESC LIMIT 1`,
        [companyId, input.gateRequestId, input.since.toISOString(), input.objectId, Math.max(1, Math.trunc(input.inFlightMinutes)), workerNow().toISOString(), input.objectKind ?? null],
      );
      const row = rows[0];
      if (!row) return null;
      const state = String(row.state);
      return { id: String(row.id), inFlight: state === "in_flight", ...(state === "unknown" ? { unknown: true } : {}), ageMinutes: Number(row.age_minutes) };
    },

    async close(companyId, id, outcome) {
      const result = await db.execute(
        `UPDATE ${gate} SET status = 'expired', outcome = $3::jsonb, updated_at = now()
          WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
        [companyId, id, JSON.stringify(outcome)],
      );
      return result.rowCount === 1;
    },

    async dueForExpiry(limit) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT company_id, id, token FROM ${gate}
          WHERE status = 'pending' AND valid_until <= now()
          ORDER BY valid_until LIMIT $1`,
        [Math.max(1, Math.min(Math.trunc(limit), 500))],
      );
      return rows.map((row) => ({ companyId: String(row.company_id), id: String(row.id), tokenHash: String(row.token) }));
    },

    async pendingForPublication(companyId, publicationId) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${GATE_RECORD_COLUMNS} FROM ${gate}
          WHERE company_id = $1 AND kind = 'activate_ad' AND status = 'pending' AND publication_id = $2
          ORDER BY created_at DESC LIMIT 1`,
        [companyId, publicationId],
      );
      return rows[0] ? toGateRecord(rows[0]) : null;
    },

    async setPausedAdIds(companyId, id, adIds) {
      await db.execute(`UPDATE ${gate} SET paused_ad_ids = $3::jsonb, updated_at = now() WHERE company_id = $1 AND id = $2`, [
        companyId,
        id,
        JSON.stringify([...adIds]),
      ]);
    },
  };
}
