/**
 * Gate state machine (A5, RK9-509): a plugin-owned approval card, decided by
 * one Telegram tap. Not a core approval: nothing here calls `ctx.approvals`.
 *
 *   pending -> approved | denied   (tap, while valid_until > now())
 *   pending -> expired             (tap or job, once valid_until <= now())
 *   pending -> failed              (the card could not be sent)
 *   approved -> failed             (the kind handler threw)
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
import { CALLBACK_DATA_MAX_BYTES, sendCard, type BotApi, type CardMedia, type InlineKeyboardMarkup } from "../telegram/bot-api.js";
import type { GateRegistry } from "./registry.js";

export const GATE_STATUSES = ["pending", "approved", "denied", "skipped", "expired", "failed"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];
export type GateDecision = "approved" | "denied";

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
  /** pending -> approved|denied while valid_until > now(). True when this call won. */
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
}

/** 18 random bytes = 144 bit, 24 base64url chars. */
export function newGateToken(): string {
  return randomBytes(18).toString("base64url");
}

export function gateTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** callback_data layout: "g:a:<token>" approves, "g:d:<token>" denies. */
const CALLBACK_RE = /^g:([ad]):([A-Za-z0-9_-]{16,48})$/;

export function gateCallbackData(decision: GateDecision, token: string): string {
  const data = `g:${decision === "approved" ? "a" : "d"}:${token}`;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error("callback_data exceeds 64 bytes");
  return data;
}

export function parseGateCallbackData(data: string | undefined): { decision: GateDecision; token: string } | null {
  if (typeof data !== "string") return null;
  const match = CALLBACK_RE.exec(data);
  if (!match) return null;
  return { decision: match[1] === "a" ? "approved" : "denied", token: match[2]! };
}

export function gateButtons(token: string, labels: { approve?: string; deny?: string } = {}): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: labels.approve ?? "✅ Hyväksy", callback_data: gateCallbackData("approved", token) },
        { text: labels.deny ?? "❌ Hylkää", callback_data: gateCallbackData("denied", token) },
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
      buttons: gateButtons(token, input.labels),
    });
    messageId = message.message_id;
  } catch (error) {
    await input.store.settle(input.companyId, id, {
      from: "pending",
      to: "failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "card send failed",
    });
    throw error;
  }
  await input.store.setMessageId(input.companyId, id, messageId);
  return { id, messageId };
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
      const rows = await db.query<Record<string, unknown>>(
        `SELECT id, company_id, brand_code, kind, status, chat_id, message_id, valid_until, payload,
                decided_by_tg_user_id, decided_at, (valid_until > now()) AS live
           FROM ${gate} WHERE token = $1 LIMIT 1`,
        [tokenHash],
      );
      const row = rows[0];
      if (!row) return null;
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
      };
    },

    async decide(companyId, tokenHash, decision, tgUserId) {
      if (decision !== "approved" && decision !== "denied") throw new Error("Invalid gate decision");
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
