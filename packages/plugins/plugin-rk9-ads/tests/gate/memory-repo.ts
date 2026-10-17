/**
 * In-memory ActivationGateRepo over the kit's memory gate store, with the
 * semantics of the SQL repo (tests/gate/gate-requests-db.spec.ts runs the SQL
 * one on real Postgres).
 */

import { activationOf, type ActivationGateRepo } from "../../src/gate/gate-requests.js";
import type { MemoryGateStore } from "../../src/kit/testing/memory-gate-store.js";

export function memoryActivationRepo(store: MemoryGateStore, now: () => Date): ActivationGateRepo & { pausedAdIds: Map<string, string[]> } {
  const pausedAdIds = new Map<string, string[]>();
  const adOf = (row: { kind: string; payload: Record<string, unknown> }) => activationOf(row)?.adId ?? null;
  const records = async (companyId: string, ids: string[]) =>
    (await Promise.all(ids.map((id) => store.findById(companyId, id)))).filter((row) => row !== null);
  return {
    pausedAdIds,
    async openForAd(companyId, adId) {
      const ids = [...store.rows.values()]
        .filter((row) => row.companyId === companyId && row.kind === "activate_ad" && row.status === "pending" && adOf(row) === adId)
        .map((row) => row.id);
      return records(companyId, ids);
    },
    async activationInFlight(companyId, adId, withinMinutes) {
      const since = now().getTime() - withinMinutes * 60_000;
      return [...store.rows.values()].some(
        (row) =>
          row.companyId === companyId &&
          row.kind === "activate_ad" &&
          adOf(row) === adId &&
          row.status === "approved" &&
          (row.outcome === null || row.outcome.handler === "started") &&
          (row.decidedAt?.getTime() ?? 0) > since,
      );
    },
    async close(companyId, id, outcome) {
      const row = store.rows.get(id);
      if (!row || row.companyId !== companyId || row.status !== "pending") return false;
      row.status = "expired";
      row.outcome = outcome;
      return true;
    },
    async dueForExpiry(limit) {
      return [...store.rows.values()]
        .filter((row) => row.status === "pending" && row.validUntil.getTime() <= now().getTime())
        .sort((a, b) => a.validUntil.getTime() - b.validUntil.getTime())
        .slice(0, limit)
        .map((row) => ({ companyId: row.companyId, id: row.id, tokenHash: row.tokenHash }));
    },
    async pendingForPublication(companyId, publicationId) {
      const rows = [...store.rows.values()].filter(
        (row) =>
          row.companyId === companyId && row.kind === "activate_ad" && row.status === "pending" && activationOf(row)?.publicationId === publicationId,
      );
      const last = rows.at(-1);
      return last ? store.findById(companyId, last.id) : null;
    },
    async setPausedAdIds(_companyId, id, adIds) {
      pausedAdIds.set(id, [...adIds]);
    },
  };
}
