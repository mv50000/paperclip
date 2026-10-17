/**
 * Gate state machine (A5, RK9-509): a plugin-owned approval card, decided by
 * one Telegram tap. Not a core approval: nothing here calls `ctx.approvals`.
 *
 *   pending -> approved | denied | skipped   (tap, while valid_until > now())
 *   pending -> expired             (tap or job, once valid_until <= now())
 *   pending -> failed              (the card could not be sent)
 *   approved -> failed | denied    (the kind handler threw or refused)
 *
 * Every transition is one conditional UPDATE (compare-and-set). Only the
 * caller whose UPDATE changed exactly one row goes on, so a double tap or a
 * redelivered update runs the handler once.
 *
 * The card token is random (144 bit) and single-use. The callback_data
 * carries it, and the table stores only its sha256 (`token` column), so a
 * database reader cannot forge a tap.
 *
 * The table contract (migration 001 of the ads plugin): `gate_requests` with
 * id, company_id, brand_code, kind, status, token, payload, chat_id,
 * message_id, valid_until, decided_by_tg_user_id, decided_at, outcome, error,
 * updated_at; `processed_updates` with company_id, bot_key, update_id,
 * update_kind and UNIQUE (company_id, bot_key, update_id).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { CALLBACK_DATA_MAX_BYTES, redactSecrets, sendCard, type BotApi, type CardMedia, type InlineKeyboardMarkup } from "../telegram/bot-api.js";
import type { GateRegistry } from "./registry.js";

export const GATE_STATUSES = ["pending", "approved", "denied", "skipped", "expired", "failed"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];
/** "skipped" is a deny button that means "not now" rather than "no" (e.g. 🗑 Ohita). */
export type GateDecision = "approved" | "denied" | "skipped";
/** What a card's second button records. */
export type GateDenyDecision = Exclude<GateDecision, "approved">;

export interface GateCard {
  media: CardMedia;
  /** Original caption or text; status lines are appended to it on edits. */
  text: string;
}

export interface GateRequestRecord {
  id: string;
  companyId: string;
  brandCode: string;
  kind: string;
  status: GateStatus;
  chatId: string | null;
  messageId: number | null;
  validUntil: Date;
  /** valid_until > now() by the database clock at read time. */
  live: boolean;
  payload: Record<string, unknown>;
  decidedByTgUserId: number | null;
  decidedAt: Date | null;
  /** The status line a closer stored in `outcome.statusText` (e.g. a pause that closed the card). */
  closedStatus?: string | null;
}

export interface NewGateRequest {
  id: string;
  companyId: string;
  brandCode: string;
  kind: string;
  tokenHash: string;
  chatId: string;
  validUntil: Date;
  payload: Record<string, unknown>;
}

export interface GateStore {
  insertPending(request: NewGateRequest): Promise<void>;
  setMessageId(companyId: string, id: string, messageId: number): Promise<boolean>;
  findByTokenHash(tokenHash: string): Promise<GateRequestRecord | null>;
  /** pending -> approved|denied|skipped while valid_until > now(). True when this call won. */
  decide(companyId: string, tokenHash: string, decision: GateDecision, tgUserId: number): Promise<boolean>;
  /** pending -> expired once valid_until <= now(). True when this call won. */
  expire(companyId: string, tokenHash: string): Promise<boolean>;
  /** Records the handler outcome; `to` differs from `from` only for approved -> failed. */
  settle(
    companyId: string,
    id: string,
    input: { from: GateStatus; to: GateStatus; outcome?: Record<string, unknown> | null; error?: string | null },
  ): Promise<boolean>;
  /** Records a Telegram update id. False when it was already recorded. */
  markUpdateProcessed(companyId: string, botKey: string, updateId: number, updateKind: string): Promise<boolean>;
  findById(companyId: string, id: string): Promise<GateRequestRecord | null>;
  /**
   * Gives a pending, live card a new token and chat and clears its message id
   * (re-send). The old token stops matching any row. True when this call won.
   */
  rotateToken(companyId: string, id: string, tokenHash: string, chatId: string): Promise<boolean>;
}

/** 18 random bytes = 144 bit, 24 base64url chars. */
export function newGateToken(): string {
  return randomBytes(18).toString("base64url");
}

export function gateTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** callback_data layout: "g:a:<token>" approves, "g:d:<token>" denies, "g:s:<token>" skips. */
const CALLBACK_RE = /^g:([ads]):([A-Za-z0-9_-]{16,48})$/;
const DECISION_CODE: Record<GateDecision, string> = { approved: "a", denied: "d", skipped: "s" };
const CODE_DECISION: Record<string, GateDecision> = { a: "approved", d: "denied", s: "skipped" };

export function gateCallbackData(decision: GateDecision, token: string): string {
  const code = DECISION_CODE[decision];
  if (!code) throw new Error("Invalid gate decision");
  const data = `g:${code}:${token}`;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error("callback_data exceeds 64 bytes");
  return data;
}

export function parseGateCallbackData(data: string | undefined): { decision: GateDecision; token: string } | null {
  if (typeof data !== "string") return null;
  const match = CALLBACK_RE.exec(data);
  if (!match) return null;
  return { decision: CODE_DECISION[match[1]!]!, token: match[2]! };
}

export function gateButtons(
  token: string,
  labels: { approve?: string; deny?: string } = {},
  denyDecision: GateDenyDecision = "denied",
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: labels.approve ?? "✅ Hyväksy", callback_data: gateCallbackData("approved", token) },
        { text: labels.deny ?? "❌ Hylkää", callback_data: gateCallbackData(denyDecision, token) },
      ],
    ],
  };
}

/** The card as stored in `payload.card`. */
export function storedCard(request: GateRequestRecord): GateCard | null {
  const card = request.payload?.card as Partial<GateCard> | undefined;
  if (!card || typeof card.text !== "string") return null;
  if (card.media !== "photo" && card.media !== "video" && card.media !== "text") return null;
  return { media: card.media, text: card.text };
}

/**
 * Creates a pending gate request and posts its card. The row exists before
 * the card is sent, so a tap never points at a missing row. A card that
 * cannot be sent moves to `failed`, and the error is re-thrown.
 */
export async function createGateCard(input: {
  store: GateStore;
  api: BotApi;
  registry: GateRegistry;
  companyId: string;
  brandCode: string;
  kind: string;
  chatId: string;
  validUntil: Date;
  card: GateCard & { mediaUrl?: string };
  payload?: Record<string, unknown>;
  labels?: { approve?: string; deny?: string };
  /** What the second button records; default "denied". */
  denyDecision?: GateDenyDecision;
}): Promise<{ id: string; messageId: number }> {
  if (!input.registry.has(input.kind)) throw new Error(`Gate kind ${input.kind} has no handler`);
  if (!(input.validUntil instanceof Date) || Number.isNaN(input.validUntil.getTime())) {
    throw new Error("validUntil must be a valid Date");
  }
  const token = newGateToken();
  const id = randomUUID();
  await input.store.insertPending({
    id,
    companyId: input.companyId,
    brandCode: input.brandCode,
    kind: input.kind,
    tokenHash: gateTokenHash(token),
    chatId: input.chatId,
    validUntil: input.validUntil,
    payload: { ...(input.payload ?? {}), card: { media: input.card.media, text: input.card.text } },
  });
  let messageId: number;
  try {
    const message = await sendCard(input.api, {
      chatId: input.chatId,
      media: input.card.media,
      mediaUrl: input.card.mediaUrl,
      text: input.card.text,
      buttons: gateButtons(token, input.labels, input.denyDecision),
    });
    messageId = message.message_id;
  } catch (error) {
    try {
      await input.store.settle(input.companyId, id, {
        from: "pending",
        to: "failed",
        error: redactSecrets(error instanceof Error ? error.message : "card send failed").slice(0, 300),
      });
    } catch {
      // The send error is the one the caller needs.
    }
    throw error;
  }
  await input.store.setMessageId(input.companyId, id, messageId);
  return { id, messageId };
}

/**
 * Posts a pending, live card again (a lost or buried card). The card gets a
 * new token first, so the old card's buttons find no row; the router also
 * refuses a tap on any message id other than the stored one. A send that
 * fails leaves the card pending without a message: re-send it again.
 */
export async function resendGateCard(input: {
  store: GateStore;
  api: BotApi;
  request: GateRequestRecord;
  chatId: string;
  mediaUrl?: string;
  labels?: { approve?: string; deny?: string };
  denyDecision?: GateDenyDecision;
}): Promise<{ messageId: number }> {
  const { request } = input;
  const card = storedCard(request);
  if (!card) throw new Error("The gate request has no stored card");
  const token = newGateToken();
  if (!(await input.store.rotateToken(request.companyId, request.id, gateTokenHash(token), input.chatId))) {
    throw new Error("The gate request is no longer pending");
  }
  const message = await sendCard(input.api, {
    chatId: input.chatId,
    media: card.media,
    mediaUrl: input.mediaUrl,
    text: card.text,
    buttons: gateButtons(token, input.labels, input.denyDecision),
  });
  await input.store.setMessageId(request.companyId, request.id, message.message_id);
  return { messageId: message.message_id };
}

// ---------------------------------------------------------------------------
// SQL store on the plugin namespace (runs through the host's runtime validators)
// ---------------------------------------------------------------------------

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return toRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export const GATE_RECORD_COLUMNS = `id, company_id, brand_code, kind, status, chat_id, message_id, valid_until, payload,
  decided_by_tg_user_id, decided_at, (valid_until > now()) AS live, outcome->>'statusText' AS closed_status`;

export function toGateRecord(row: Record<string, unknown>): GateRequestRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    brandCode: String(row.brand_code),
    kind: String(row.kind),
    status: String(row.status) as GateStatus,
    chatId: row.chat_id === null || row.chat_id === undefined ? null : String(row.chat_id),
    messageId: toNumberOrNull(row.message_id),
    validUntil: toDate(row.valid_until),
    live: row.live === true,
    payload: toRecord(row.payload),
    decidedByTgUserId: toNumberOrNull(row.decided_by_tg_user_id),
    decidedAt: row.decided_at ? toDate(row.decided_at) : null,
    closedStatus: typeof row.closed_status === "string" ? row.closed_status : null,
  };
}

export function createSqlGateStore(
  db: PluginDatabaseClient,
  tables: { gateRequests?: string; processedUpdates?: string } = {},
): GateStore {
  const namespace = db.namespace;
  const gateTable = tables.gateRequests ?? "gate_requests";
  const updatesTable = tables.processedUpdates ?? "processed_updates";
  for (const name of [namespace, gateTable, updatesTable]) {
    if (!IDENT_RE.test(name)) throw new Error(`Invalid SQL identifier ${name}`);
  }
  const gate = `${namespace}.${gateTable}`;
  const updates = `${namespace}.${updatesTable}`;

  return {
    async insertPending(request) {
      await db.execute(
        `INSERT INTO ${gate} (id, company_id, brand_code, kind, status, token, chat_id, valid_until, payload)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8::jsonb)`,
        [
          request.id,
          request.companyId,
          request.brandCode,
          request.kind,
          request.tokenHash,
          request.chatId,
          request.validUntil.toISOString(),
          JSON.stringify(request.payload),
        ],
      );
    },

    async setMessageId(companyId, id, messageId) {
      const result = await db.execute(
        `UPDATE ${gate} SET message_id = $3, updated_at = now() WHERE company_id = $1 AND id = $2`,
        [companyId, id, messageId],
      );
      return result.rowCount === 1;
    },

    // The only lookup without company_id: a callback carries just the token,
    // which is unique across the table. The row's company_id then scopes every
    // later statement.
    async findByTokenHash(tokenHash) {
      const rows = await db.query<Record<string, unknown>>(`SELECT ${GATE_RECORD_COLUMNS} FROM ${gate} WHERE token = $1 LIMIT 1`, [tokenHash]);
      return rows[0] ? toGateRecord(rows[0]) : null;
    },

    async findById(companyId, id) {
      const rows = await db.query<Record<string, unknown>>(`SELECT ${GATE_RECORD_COLUMNS} FROM ${gate} WHERE company_id = $1 AND id = $2 LIMIT 1`, [
        companyId,
        id,
      ]);
      return rows[0] ? toGateRecord(rows[0]) : null;
    },

    async rotateToken(companyId, id, tokenHash, chatId) {
      const result = await db.execute(
        `UPDATE ${gate} SET token = $3, chat_id = $4, message_id = NULL, updated_at = now()
          WHERE company_id = $1 AND id = $2 AND status = 'pending' AND valid_until > now()`,
        [companyId, id, tokenHash, chatId],
      );
      return result.rowCount === 1;
    },

    async decide(companyId, tokenHash, decision, tgUserId) {
      if (decision !== "approved" && decision !== "denied" && decision !== "skipped") throw new Error("Invalid gate decision");
      const result = await db.execute(
        `UPDATE ${gate}
            SET status = $3, decided_by_tg_user_id = $4, decided_at = now(), updated_at = now()
          WHERE company_id = $1 AND token = $2 AND status = 'pending' AND valid_until > now()`,
        [companyId, tokenHash, decision, tgUserId],
      );
      return result.rowCount === 1;
    },

    async expire(companyId, tokenHash) {
      const result = await db.execute(
        `UPDATE ${gate} SET status = 'expired', updated_at = now()
          WHERE company_id = $1 AND token = $2 AND status = 'pending' AND valid_until <= now()`,
        [companyId, tokenHash],
      );
      return result.rowCount === 1;
    },

    async settle(companyId, id, input) {
      const result = await db.execute(
        `UPDATE ${gate} SET status = $4, outcome = $5::jsonb, error = $6, updated_at = now()
          WHERE company_id = $1 AND id = $2 AND status = $3`,
        [companyId, id, input.from, input.to, input.outcome ? JSON.stringify(input.outcome) : null, input.error ?? null],
      );
      return result.rowCount === 1;
    },

    async markUpdateProcessed(companyId, botKey, updateId, updateKind) {
      const result = await db.execute(
        `INSERT INTO ${updates} (company_id, bot_key, update_id, update_kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, bot_key, update_id) DO NOTHING`,
        [companyId, botKey, updateId, updateKind],
      );
      return result.rowCount === 1;
    },
  };
}
