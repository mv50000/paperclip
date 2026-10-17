/**
 * The activation gate's view of `gate_requests` (A9, RK9-517).
 *
 * The kit's GateStore (src/kit/gate/state-machine.ts) owns the card life
 * cycle: insert, the pending -> decided compare-and-set, settle. This file
 * adds what only activate_ad cards need, over the same table:
 * - the ad columns (publication_id, ad_id, adset_id), written with the
 *   pending row, before the card is sent;
 * - open cards of one ad (a creative swap closes them);
 * - whether an approved activation of an ad may still be running;
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
  /** For a re-send. */
  media: "photo" | "video";
  mediaUrl: string;
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
  if (raw.media !== "photo" && raw.media !== "video") return null;
  if (!str(raw.mediaUrl)) return null;
  return {
    publicationId: raw.publicationId,
    adId: raw.adId,
    adsetId: raw.adsetId,
    campaignId: raw.campaignId ?? null,
    creativeId: raw.creativeId,
    contentHash: raw.contentHash,
    adName: raw.adName,
    media: raw.media,
    mediaUrl: raw.mediaUrl,
  };
}

/** A card past valid_until, with the token hash the kit's `expire` takes. */
export interface DueCard {
  companyId: string;
  id: string;
  tokenHash: string;
}

export interface ActivationGateRepo {
  /** Pending activate_ad cards of one ad, live or not. */
  openForAd(companyId: string, adId: string): Promise<GateRequestRecord[]>;
  /**
   * True while an activate_ad card of this ad is approved and its handler has
   * not recorded an end (between the tap and the handler's own outcome),
   * decided within the last `withinMinutes`: a worker that crashed mid-handler
   * leaves `started` behind, and that must not block the ad for good.
   */
  activationInFlight(companyId: string, adId: string, withinMinutes: number): Promise<boolean>;
  /** pending -> expired with an outcome (superseded, creative swapped). True when this call won. */
  close(companyId: string, id: string, outcome: Record<string, unknown>): Promise<boolean>;
  /** Pending cards of every company whose valid_until has passed, oldest first. */
  dueForExpiry(limit: number): Promise<DueCard[]>;
  /** The pending activate_ad card of a publication, newest first. */
  pendingForPublication(companyId: string, publicationId: string): Promise<GateRequestRecord | null>;
  setPausedAdIds(companyId: string, id: string, adIds: readonly string[]): Promise<void>;
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function gateTable(db: PluginDatabaseClient): string {
  if (!IDENT_RE.test(db.namespace)) throw new Error(`Invalid SQL identifier ${db.namespace}`);
  return `${db.namespace}.gate_requests`;
}

/**
 * Wraps the kit's SQL store so an activate_ad row gets its ad columns in the
 * same step as the insert, before the card goes out: a swap that closes the
 * ad's cards then always sees it.
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

export function sqlActivationGateRepo(db: PluginDatabaseClient): ActivationGateRepo {
  const gate = gateTable(db);
  return {
    async openForAd(companyId, adId) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${GATE_RECORD_COLUMNS} FROM ${gate}
          WHERE company_id = $1 AND kind = 'activate_ad' AND status = 'pending' AND ad_id = $2
          ORDER BY created_at`,
        [companyId, adId],
      );
      return rows.map(toGateRecord);
    },

    async activationInFlight(companyId, adId, withinMinutes) {
      const rows = await db.query<{ n: unknown }>(
        `SELECT count(*) AS n FROM ${gate}
          WHERE company_id = $1 AND kind = 'activate_ad' AND ad_id = $2 AND status = 'approved'
            AND (outcome IS NULL OR outcome->>'handler' = 'started')
            AND decided_at > now() - make_interval(mins => $3)`,
        [companyId, adId, Math.max(1, Math.trunc(withinMinutes))],
      );
      return Number(rows[0]?.n ?? 0) > 0;
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
