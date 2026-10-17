/**
 * In-memory GateStore with the same compare-and-set semantics as the SQL
 * store: each method checks and writes in one synchronous step, so parallel
 * callers race exactly like conditional UPDATEs (one winner). Test-only; the
 * concurrency AC also runs against real Postgres.
 */

import type { GateRequestRecord, GateStatus, GateStore, NewGateRequest } from "../gate/state-machine.js";

export interface MemoryGateRow extends NewGateRequest {
  status: GateStatus;
  messageId: number | null;
  decidedByTgUserId: number | null;
  decidedAt: Date | null;
  outcome: Record<string, unknown> | null;
  error: string | null;
}

export interface MemoryGateStore extends GateStore {
  rows: Map<string, MemoryGateRow>;
  processed: Set<string>;
  /** Number of calls that changed a row, per method. */
  writes: { decide: number; expire: number; settle: number };
}

export function createMemoryGateStore(now: () => Date = () => new Date()): MemoryGateStore {
  const rows = new Map<string, MemoryGateRow>();
  const byToken = new Map<string, string>();
  const processed = new Set<string>();
  const writes = { decide: 0, expire: 0, settle: 0 };

  function record(row: MemoryGateRow): GateRequestRecord {
    return {
      id: row.id,
      companyId: row.companyId,
      brandCode: row.brandCode,
      kind: row.kind,
      status: row.status,
      chatId: row.chatId,
      messageId: row.messageId,
      validUntil: row.validUntil,
      live: row.validUntil.getTime() > now().getTime(),
      payload: structuredClone(row.payload),
      decidedByTgUserId: row.decidedByTgUserId,
      decidedAt: row.decidedAt,
      closedStatus: typeof row.outcome?.statusText === "string" ? row.outcome.statusText : null,
    };
  }

  function byTokenHash(companyId: string, tokenHash: string): MemoryGateRow | undefined {
    const id = byToken.get(tokenHash);
    const row = id ? rows.get(id) : undefined;
    return row && row.companyId === companyId ? row : undefined;
  }

  return {
    rows,
    processed,
    writes,
    async insertPending(request) {
      if (byToken.has(request.tokenHash)) throw new Error("duplicate key value violates gate_requests_token_key");
      rows.set(request.id, {
        ...request,
        payload: structuredClone(request.payload),
        status: "pending",
        messageId: null,
        decidedByTgUserId: null,
        decidedAt: null,
        outcome: null,
        error: null,
      });
      byToken.set(request.tokenHash, request.id);
    },
    async setMessageId(companyId, id, messageId) {
      const row = rows.get(id);
      if (!row || row.companyId !== companyId) return false;
      row.messageId = messageId;
      return true;
    },
    async findByTokenHash(tokenHash) {
      const id = byToken.get(tokenHash);
      const row = id ? rows.get(id) : undefined;
      return row ? record(row) : null;
    },
    async decide(companyId, tokenHash, decision, tgUserId) {
      const row = byTokenHash(companyId, tokenHash);
      if (!row || row.status !== "pending" || row.validUntil.getTime() <= now().getTime()) return false;
      row.status = decision;
      row.decidedByTgUserId = tgUserId;
      row.decidedAt = now();
      writes.decide += 1;
      return true;
    },
    async expire(companyId, tokenHash) {
      const row = byTokenHash(companyId, tokenHash);
      if (!row || row.status !== "pending" || row.validUntil.getTime() > now().getTime()) return false;
      row.status = "expired";
      writes.expire += 1;
      return true;
    },
    async settle(companyId, id, input) {
      const row = rows.get(id);
      if (!row || row.companyId !== companyId || row.status !== input.from) return false;
      row.status = input.to;
      row.outcome = input.outcome ?? null;
      row.error = input.error ?? null;
      writes.settle += 1;
      return true;
    },
    async findById(companyId, id) {
      const row = rows.get(id);
      return row && row.companyId === companyId ? record(row) : null;
    },
    async rotateToken(companyId, id, tokenHash, chatId) {
      const row = rows.get(id);
      if (!row || row.companyId !== companyId || row.status !== "pending" || row.validUntil.getTime() <= now().getTime()) return false;
      if (byToken.has(tokenHash)) throw new Error("duplicate key value violates gate_requests_token_key");
      byToken.delete(row.tokenHash);
      row.tokenHash = tokenHash;
      row.chatId = chatId;
      row.messageId = null;
      byToken.set(tokenHash, id);
      return true;
    },
    async markUpdateProcessed(companyId, botKey, updateId) {
      const key = `${companyId}:${botKey}:${updateId}`;
      if (processed.has(key)) return false;
      processed.add(key);
      return true;
    },
  };
}
