/**
 * organic_posts (migration 006, RK9-832). Every call is company-scoped; status
 * changes are compare-and-set on the expected status.
 */

import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { Ledger } from "../db.js";
import {
  OPEN_ORGANIC_STATUSES,
  ORGANIC_CHANNELS,
  ORGANIC_POST_STATUSES,
  type OrganicChannel,
  type OrganicLint,
  type OrganicMode,
  type OrganicPost,
  type OrganicPostStatus,
} from "./types.js";

export interface NewOrganicPost {
  brandCode: string;
  creativeId: string;
  channel: OrganicChannel;
  caption: string;
  contentHash: string;
  mode: OrganicMode;
  lint: OrganicLint | null;
  payload?: Record<string, unknown>;
}

export interface OrganicPostPatch {
  status?: OrganicPostStatus;
  gateRequestId?: string;
  metaContainerId?: string | null;
  metaMediaId?: string | null;
  metaPostId?: string | null;
  permalink?: string | null;
  rejectReasonCode?: string;
  rejectReasonText?: string | null;
  decidedByTgUserId?: number;
  decidedAt?: Date;
  publishedAt?: Date;
  deletedAt?: Date;
  deletedBy?: string;
  error?: string | null;
  payload?: Record<string, unknown>;
}

/** A post with the state of its card (null when it has none yet). */
export interface OrganicPostView extends OrganicPost {
  gateStatus: string | null;
  gateLive: boolean | null;
}

export interface OrganicPostStore {
  /** Inserts a pending post. Null when an open post of the same content exists (unique index). */
  insertPending(companyId: string, post: NewOrganicPost): Promise<OrganicPost | null>;
  get(companyId: string, id: string): Promise<OrganicPost | null>;
  /** The open (pending, publishing, published) post of this content. */
  findOpen(companyId: string, contentHash: string): Promise<OrganicPostView | null>;
  /** Compare-and-set on the status. True when this call changed the row. */
  update(companyId: string, id: string, expected: OrganicPostStatus, patch: OrganicPostPatch): Promise<boolean>;
  /** Stores the first reject reason of a rejected post. True when this call stored it. */
  setRejectReason(companyId: string, id: string, code: string, text: string | null): Promise<boolean>;
  /** Newest first, with the card state. */
  list(companyId: string, limit: number): Promise<OrganicPostView[]>;
  /** Posts that changed in the last `hours` hours (digest). */
  recent(companyId: string, hours: number, limit: number): Promise<OrganicPostView[]>;
  /** Meta object ids the company's other posts hold: a caption match never takes one. */
  otherMediaIds(companyId: string, postId: string): Promise<Set<string>>;
  /** Publishing posts of every company not updated for `minutes` minutes, oldest first (the reconcile job). */
  stalePublishing(minutes: number, limit: number): Promise<Array<{ companyId: string; id: string }>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function json(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return json(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function toOrganicPost(row: Record<string, unknown>): OrganicPost {
  const channel = String(row.channel);
  const status = String(row.status);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    brandCode: String(row.brand_code),
    creativeId: String(row.creative_id),
    channel: ((ORGANIC_CHANNELS as readonly string[]).includes(channel) ? channel : "ig_reel") as OrganicChannel,
    caption: String(row.caption ?? ""),
    contentHash: String(row.content_hash),
    status: ((ORGANIC_POST_STATUSES as readonly string[]).includes(status) ? status : "failed") as OrganicPostStatus,
    mode: row.mode === "live" ? "live" : "dry_run",
    gateRequestId: str(row.gate_request_id),
    lint: json(row.lint) as OrganicLint | null,
    metaContainerId: str(row.meta_container_id),
    metaMediaId: str(row.meta_media_id),
    metaPostId: str(row.meta_post_id),
    permalink: str(row.permalink),
    rejectReasonCode: str(row.reject_reason_code),
    rejectReasonText: str(row.reject_reason_text),
    decidedByTgUserId: num(row.decided_by_tg_user_id),
    decidedAt: iso(row.decided_at),
    publishedAt: iso(row.published_at),
    deletedAt: iso(row.deleted_at),
    deletedBy: str(row.deleted_by),
    error: str(row.error),
    payload: json(row.payload) ?? {},
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function toView(row: Record<string, unknown>): OrganicPostView {
  return {
    ...toOrganicPost(row),
    gateStatus: str(row.gate_status),
    gateLive: row.gate_live === null || row.gate_live === undefined ? null : row.gate_live === true,
  };
}

/**
 * A pending post that never got a card id this long after it was created lost
 * its worker between the insert and the card (RK9-852). A card send takes
 * seconds; without this the row would block the same content for good.
 */
export const STALE_PENDING_MINUTES = 10;

/** A pending post whose card can no longer be approved reads as expired. */
export function effectiveStatus(
  post: Pick<OrganicPostView, "status" | "gateStatus" | "gateLive"> & Partial<Pick<OrganicPostView, "gateRequestId" | "createdAt">>,
  now: Date = new Date(),
): OrganicPostStatus {
  if (post.status !== "pending") return post.status;
  if (!post.gateRequestId && post.gateStatus === null && post.createdAt && Date.parse(post.createdAt) <= now.getTime() - STALE_PENDING_MINUTES * 60_000) {
    return "expired";
  }
  if (post.gateStatus === "pending" && post.gateLive === false) return "expired";
  // A card that is decided or closed (expired, denied, skipped, failed) can no longer publish this post.
  if (post.gateStatus !== null && post.gateStatus !== "pending" && post.gateStatus !== "approved") return "expired";
  return "pending";
}

function patchColumns(patch: OrganicPostPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Array<[keyof OrganicPostPatch, string]> = [
    ["status", "status"],
    ["gateRequestId", "gate_request_id"],
    ["metaContainerId", "meta_container_id"],
    ["metaMediaId", "meta_media_id"],
    ["metaPostId", "meta_post_id"],
    ["permalink", "permalink"],
    ["rejectReasonCode", "reject_reason_code"],
    ["rejectReasonText", "reject_reason_text"],
    ["decidedByTgUserId", "decided_by_tg_user_id"],
    ["decidedAt", "decided_at"],
    ["publishedAt", "published_at"],
    ["deletedAt", "deleted_at"],
    ["deletedBy", "deleted_by"],
    ["error", "error"],
    ["payload", "payload"],
  ];
  for (const [key, column] of map) if (patch[key] !== undefined) out[column] = patch[key];
  return out;
}

const VIEW_COLUMNS = `p.*, g.status AS gate_status, (g.valid_until > now()) AS gate_live`;

export function sqlOrganicPostStore(db: PluginDatabaseClient, ledger: Ledger): OrganicPostStore {
  const posts = ledger.qualified("organic_posts");
  const gates = ledger.qualified("gate_requests");
  const open = OPEN_ORGANIC_STATUSES.map((status) => `'${status}'`).join(", ");
  const from = `${posts} p LEFT JOIN ${gates} g ON g.company_id = p.company_id AND g.id = p.gate_request_id`;

  function assertCompany(companyId: string): void {
    if (!UUID_RE.test(companyId)) throw new Error("A ledger call needs a companyId (uuid)");
  }

  return {
    async insertPending(companyId, post) {
      const id = randomUUID();
      const { inserted } = await ledger.insertIfAbsent(companyId, "organic_posts", {
        id,
        brand_code: post.brandCode,
        creative_id: post.creativeId,
        channel: post.channel,
        caption: post.caption,
        content_hash: post.contentHash,
        status: "pending",
        mode: post.mode,
        lint: post.lint,
        payload: post.payload ?? {},
      });
      return inserted ? this.get(companyId, id) : null;
    },
    async get(companyId, id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await ledger.select(companyId, "organic_posts", { where: { id }, limit: 1 });
      return row ? toOrganicPost(row) : null;
    },
    async findOpen(companyId, contentHash) {
      assertCompany(companyId);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${VIEW_COLUMNS} FROM ${from} WHERE p.company_id = $1 AND p.content_hash = $2 AND p.status IN (${open}) LIMIT 1`,
        [companyId, contentHash],
      );
      return rows[0] ? toView(rows[0]) : null;
    },
    async update(companyId, id, expected, patch) {
      return (await ledger.update(companyId, "organic_posts", { id, status: expected }, patchColumns(patch))) === 1;
    },
    async setRejectReason(companyId, id, code, text) {
      return (
        (await ledger.update(
          companyId,
          "organic_posts",
          { id, status: "rejected", reject_reason_code: null },
          { reject_reason_code: code, reject_reason_text: text },
        )) === 1
      );
    },
    async list(companyId, limit) {
      assertCompany(companyId);
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${VIEW_COLUMNS} FROM ${from} WHERE p.company_id = $1 ORDER BY p.created_at DESC LIMIT ${bounded}`,
        [companyId],
      );
      return rows.map(toView);
    },
    async recent(companyId, hours, limit) {
      assertCompany(companyId);
      const boundedHours = Math.min(Math.max(Math.floor(hours), 1), 24 * 31);
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT ${VIEW_COLUMNS} FROM ${from} WHERE p.company_id = $1 AND p.updated_at > now() - interval '${boundedHours} hours' ` +
          `ORDER BY p.updated_at ASC LIMIT ${bounded}`,
        [companyId],
      );
      return rows.map(toView);
    },
    async otherMediaIds(companyId, postId) {
      assertCompany(companyId);
      const rows = await db.query<{ meta_media_id: unknown }>(
        `SELECT meta_media_id FROM ${posts} WHERE company_id = $1 AND id <> $2 AND meta_media_id IS NOT NULL`,
        [companyId, UUID_RE.test(postId) ? postId : "00000000-0000-0000-0000-000000000000"],
      );
      return new Set(rows.map((row) => String(row.meta_media_id)));
    },
    async stalePublishing(minutes, limit) {
      const boundedMinutes = Math.min(Math.max(Math.floor(minutes), 1), 24 * 60);
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 100);
      const rows = await db.query<{ company_id: unknown; id: unknown }>(
        `SELECT company_id, id FROM ${posts} WHERE status = 'publishing' AND updated_at < now() - interval '${boundedMinutes} minutes' ` +
          `ORDER BY updated_at ASC LIMIT ${bounded}`,
        [],
      );
      return rows.map((row) => ({ companyId: String(row.company_id), id: String(row.id) }));
    },
  };
}

/** In-memory store with the SQL store's semantics (tests). */
export function memoryOrganicPostStore(
  now: () => Date = () => new Date(),
  gateOf: (companyId: string, gateRequestId: string) => { status: string; live: boolean } | null = () => null,
): OrganicPostStore & { rows: OrganicPost[] } {
  const rows: OrganicPost[] = [];
  const view = (post: OrganicPost): OrganicPostView => {
    const gate = post.gateRequestId ? gateOf(post.companyId, post.gateRequestId) : null;
    return { ...structuredClone(post), gateStatus: gate?.status ?? null, gateLive: gate ? gate.live : null };
  };
  const apply = (post: OrganicPost, patch: OrganicPostPatch): void => {
    const date = (value: Date | undefined) => (value ? value.toISOString() : undefined);
    if (patch.status !== undefined) post.status = patch.status;
    if (patch.gateRequestId !== undefined) post.gateRequestId = patch.gateRequestId;
    if (patch.metaContainerId !== undefined) post.metaContainerId = patch.metaContainerId;
    if (patch.metaMediaId !== undefined) post.metaMediaId = patch.metaMediaId;
    if (patch.metaPostId !== undefined) post.metaPostId = patch.metaPostId;
    if (patch.permalink !== undefined) post.permalink = patch.permalink;
    if (patch.rejectReasonCode !== undefined) post.rejectReasonCode = patch.rejectReasonCode;
    if (patch.rejectReasonText !== undefined) post.rejectReasonText = patch.rejectReasonText;
    if (patch.decidedByTgUserId !== undefined) post.decidedByTgUserId = patch.decidedByTgUserId;
    if (patch.decidedAt !== undefined) post.decidedAt = date(patch.decidedAt)!;
    if (patch.publishedAt !== undefined) post.publishedAt = date(patch.publishedAt)!;
    if (patch.deletedAt !== undefined) post.deletedAt = date(patch.deletedAt)!;
    if (patch.deletedBy !== undefined) post.deletedBy = patch.deletedBy;
    if (patch.error !== undefined) post.error = patch.error;
    if (patch.payload !== undefined) post.payload = structuredClone(patch.payload);
    post.updatedAt = now().toISOString();
  };
  return {
    rows,
    async insertPending(companyId, post) {
      if (rows.some((row) => row.companyId === companyId && row.contentHash === post.contentHash && OPEN_ORGANIC_STATUSES.includes(row.status))) {
        return null;
      }
      const at = now().toISOString();
      const row: OrganicPost = {
        id: randomUUID(),
        companyId,
        brandCode: post.brandCode,
        creativeId: post.creativeId,
        channel: post.channel,
        caption: post.caption,
        contentHash: post.contentHash,
        status: "pending",
        mode: post.mode,
        gateRequestId: null,
        lint: post.lint ? structuredClone(post.lint) : null,
        metaContainerId: null,
        metaMediaId: null,
        metaPostId: null,
        permalink: null,
        rejectReasonCode: null,
        rejectReasonText: null,
        decidedByTgUserId: null,
        decidedAt: null,
        publishedAt: null,
        deletedAt: null,
        deletedBy: null,
        error: null,
        payload: structuredClone(post.payload ?? {}),
        createdAt: at,
        updatedAt: at,
      };
      rows.push(row);
      return structuredClone(row);
    },
    async get(companyId, id) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.id === id);
      return row ? structuredClone(row) : null;
    },
    async findOpen(companyId, contentHash) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.contentHash === contentHash && OPEN_ORGANIC_STATUSES.includes(entry.status));
      return row ? view(row) : null;
    },
    async update(companyId, id, expected, patch) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.id === id);
      if (!row || row.status !== expected) return false;
      apply(row, patch);
      return true;
    },
    async setRejectReason(companyId, id, code, text) {
      const row = rows.find((entry) => entry.companyId === companyId && entry.id === id);
      if (!row || row.status !== "rejected" || row.rejectReasonCode !== null) return false;
      apply(row, { rejectReasonCode: code, rejectReasonText: text });
      return true;
    },
    async list(companyId, limit) {
      return rows
        .filter((row) => row.companyId === companyId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(view);
    },
    async recent(companyId, hours, limit) {
      const since = now().getTime() - hours * 3_600_000;
      return rows
        .filter((row) => row.companyId === companyId && Date.parse(row.updatedAt) > since)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, limit)
        .map(view);
    },
    async otherMediaIds(companyId, postId) {
      return new Set(rows.filter((row) => row.companyId === companyId && row.id !== postId && row.metaMediaId).map((row) => row.metaMediaId!));
    },
    async stalePublishing(minutes, limit) {
      const before = now().getTime() - minutes * 60_000;
      return rows
        .filter((row) => row.status === "publishing" && Date.parse(row.updatedAt) < before)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, limit)
        .map((row) => ({ companyId: row.companyId, id: row.id }));
    },
  };
}
