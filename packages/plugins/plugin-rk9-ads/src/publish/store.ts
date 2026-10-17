/**
 * Publication and creative rows for the publish service (A8, RK9-514).
 *
 * The SQL store goes through the company-scoped ledger (migration 001's
 * `publications` and `creatives`); no new table (G11). The memory store backs
 * harness tests, whose `ctx.db` is a stub.
 */

import { randomUUID } from "node:crypto";
import type { Ledger, LedgerRow } from "../db.js";
import type { AdCopy, PublicationMode, PublicationPayload, PublicationRecord, PublicationStatus } from "./types.js";

export interface NewPublication {
  brandCode: string;
  creativeId: string | null;
  idempotencyKey: string;
  contentHash: string;
  mode: PublicationMode;
  adName: string;
  campaignId: string | null;
  adsetId: string | null;
  metaVideoId: string | null;
  metaAdId: string | null;
  replacesPublicationId: string | null;
  payload: PublicationPayload;
}

export interface PublicationPatch {
  status?: PublicationStatus;
  error?: string | null;
  metaVideoId?: string | null;
  metaCreativeId?: string | null;
  metaAdId?: string | null;
  payload?: PublicationPayload;
  publishedAt?: Date | null;
}

export interface PublicationStore {
  get(companyId: string, id: string): Promise<PublicationRecord | null>;
  findByKey(companyId: string, idempotencyKey: string): Promise<PublicationRecord | null>;
  /** The latest published or swapped publication that owns `adId`. */
  findByAd(companyId: string, adId: string): Promise<PublicationRecord | null>;
  /** Inserts a pending row; on a key conflict returns the existing row with `inserted: false`. */
  insertPending(companyId: string, values: NewPublication): Promise<{ inserted: boolean; record: PublicationRecord }>;
  /** Compare-and-set on the status. True when this call changed the row. */
  update(companyId: string, id: string, expectedStatus: PublicationStatus, patch: PublicationPatch): Promise<boolean>;
}

/** The creative row fields the publish service reads. */
export interface CreativeRow {
  id: string;
  brand: string;
  kind: "image" | "video";
  status: string;
  sha256: string;
  mediaUrl: string;
  posterUrl: string | null;
  aspectRatio: string | null;
  copy: AdCopy | null;
  cta: string | null;
  landingUrlKey: string | null;
  utmCampaign: string | null;
  targetAdsetId: string | null;
  validUntil: string | null;
  metaVideoId: string | null;
}

export interface CreativeSource {
  get(companyId: string, id: string): Promise<CreativeRow | null>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toCopy(value: unknown): AdCopy | null {
  const parsed = json(value);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.message !== "string") return null;
  return {
    message: record.message,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  };
}

export function toPublicationRecord(row: LedgerRow): PublicationRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    brandCode: String(row.brand_code),
    creativeId: str(row.creative_id),
    idempotencyKey: String(row.idempotency_key),
    contentHash: String(row.content_hash),
    mode: row.mode === "swap" ? "swap" : "publish",
    status: String(row.status) as PublicationStatus,
    adName: str(row.ad_name),
    campaignId: str(row.campaign_id),
    adsetId: str(row.adset_id),
    metaVideoId: str(row.meta_video_id),
    metaImageHash: str(row.meta_image_hash),
    metaCreativeId: str(row.meta_creative_id),
    metaAdId: str(row.meta_ad_id),
    replacesPublicationId: str(row.replaces_publication_id),
    error: str(row.error),
    payload: json(row.payload) as PublicationPayload,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toCreativeRow(row: LedgerRow): CreativeRow {
  return {
    id: String(row.id),
    brand: String(row.brand_code),
    kind: row.kind === "video" ? "video" : "image",
    status: String(row.status),
    sha256: String(row.sha256),
    mediaUrl: String(row.media_url),
    posterUrl: str(row.thumbnail_url),
    aspectRatio: str(row.aspect_ratio),
    copy: toCopy(row.ad_copy),
    cta: str(row.cta),
    landingUrlKey: str(row.landing_url_key),
    utmCampaign: str(row.utm_campaign),
    targetAdsetId: str(row.target_adset_id),
    validUntil: iso(row.valid_until),
    metaVideoId: str(row.meta_video_id),
  };
}

function patchColumns(patch: PublicationPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.error !== undefined) out.error = patch.error;
  if (patch.metaVideoId !== undefined) out.meta_video_id = patch.metaVideoId;
  if (patch.metaCreativeId !== undefined) out.meta_creative_id = patch.metaCreativeId;
  if (patch.metaAdId !== undefined) out.meta_ad_id = patch.metaAdId;
  if (patch.payload !== undefined) out.payload = patch.payload;
  if (patch.publishedAt !== undefined) out.published_at = patch.publishedAt;
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sqlPublicationStore(ledger: Ledger): PublicationStore {
  const one = async (companyId: string, where: Record<string, unknown>) => {
    const [row] = await ledger.select(companyId, "publications", { where, limit: 1 });
    return row ? toPublicationRecord(row) : null;
  };
  return {
    // A malformed id would make Postgres throw on the uuid cast; it is simply not found.
    get: async (companyId, id) => (UUID_RE.test(id) ? one(companyId, { id }) : null),
    findByKey: (companyId, idempotencyKey) => one(companyId, { idempotency_key: idempotencyKey }),
    async findByAd(companyId, adId) {
      // The status filter is in SQL: any number of newer failed or pending rows of the ad cannot hide the owner (RK9-561).
      const latest = async (status: "published" | "swapped") =>
        (
          await ledger.select(companyId, "publications", {
            where: { meta_ad_id: adId, status },
            orderBy: { column: "updated_at", direction: "desc" },
            limit: 1,
          })
        )[0];
      const [published, swapped] = [await latest("published"), await latest("swapped")];
      const time = (row: Record<string, unknown> | undefined) => (row ? Date.parse(iso(row.updated_at) ?? "") || 0 : -1);
      // A tie goes to the swap: it is the later owner of the same ad.
      const owner = time(swapped) >= time(published) ? swapped : published;
      return owner ? toPublicationRecord(owner) : null;
    },
    async insertPending(companyId, values) {
      const { inserted } = await ledger.insertIfAbsent(companyId, "publications", {
        id: randomUUID(),
        brand_code: values.brandCode,
        creative_id: values.creativeId,
        idempotency_key: values.idempotencyKey,
        content_hash: values.contentHash,
        mode: values.mode,
        status: "pending",
        ad_name: values.adName,
        campaign_id: values.campaignId,
        adset_id: values.adsetId,
        meta_video_id: values.metaVideoId,
        meta_ad_id: values.metaAdId,
        replaces_publication_id: values.replacesPublicationId,
        payload: values.payload,
      });
      const record = await one(companyId, { idempotency_key: values.idempotencyKey });
      if (!record) throw new Error("publication insert conflicted but no row with that key exists for this company");
      return { inserted, record };
    },
    async update(companyId, id, expectedStatus, patch) {
      return (await ledger.update(companyId, "publications", { id, status: expectedStatus }, patchColumns(patch))) === 1;
    },
  };
}

export function sqlCreativeSource(ledger: Ledger): CreativeSource {
  return {
    async get(companyId, id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await ledger.select(companyId, "creatives", { where: { id }, limit: 1 });
      return row ? toCreativeRow(row) : null;
    },
  };
}

/** In-memory store with the SQL store's semantics (tests). */
export function memoryPublicationStore(): PublicationStore & { rows: PublicationRecord[] } {
  const rows: PublicationRecord[] = [];
  const clone = (record: PublicationRecord): PublicationRecord => structuredClone(record);
  return {
    rows,
    async get(companyId, id) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.id === id);
      return row ? clone(row) : null;
    },
    async findByKey(companyId, key) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.idempotencyKey === key);
      return row ? clone(row) : null;
    },
    async findByAd(companyId, adId) {
      const row = [...rows]
        .reverse()
        .find((entry) => entry.companyId === companyId && entry.metaAdId === adId && (entry.status === "published" || entry.status === "swapped"));
      return row ? clone(row) : null;
    },
    async insertPending(companyId, values) {
      const existing = rows.find((entry) => entry.idempotencyKey === values.idempotencyKey);
      if (existing) {
        if (existing.companyId !== companyId) throw new Error("publication insert conflicted but no row with that key exists for this company");
        return { inserted: false, record: clone(existing) };
      }
      const now = new Date().toISOString();
      const record: PublicationRecord = {
        id: randomUUID(),
        companyId,
        brandCode: values.brandCode,
        creativeId: values.creativeId,
        idempotencyKey: values.idempotencyKey,
        contentHash: values.contentHash,
        mode: values.mode,
        status: "pending",
        adName: values.adName,
        campaignId: values.campaignId,
        adsetId: values.adsetId,
        metaVideoId: values.metaVideoId,
        metaImageHash: null,
        metaCreativeId: null,
        metaAdId: values.metaAdId,
        replacesPublicationId: values.replacesPublicationId,
        error: null,
        payload: structuredClone(values.payload),
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(record);
      return { inserted: true, record: clone(record) };
    },
    async update(companyId, id, expectedStatus, patch) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.id === id && entry.status === expectedStatus);
      if (!row) return false;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.error !== undefined) row.error = patch.error;
      if (patch.metaVideoId !== undefined) row.metaVideoId = patch.metaVideoId;
      if (patch.metaCreativeId !== undefined) row.metaCreativeId = patch.metaCreativeId;
      if (patch.metaAdId !== undefined) row.metaAdId = patch.metaAdId;
      if (patch.payload !== undefined) row.payload = structuredClone(patch.payload);
      if (patch.publishedAt !== undefined) row.publishedAt = patch.publishedAt ? patch.publishedAt.toISOString() : null;
      row.updatedAt = new Date().toISOString();
      return true;
    },
  };
}

export function memoryCreativeSource(rows: Array<CreativeRow & { companyId: string }> = []): CreativeSource & { rows: typeof rows } {
  return {
    rows,
    async get(companyId, id) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.id === id);
      if (!row) return null;
      const { companyId: _companyId, ...rest } = row;
      return structuredClone(rest);
    },
  };
}
