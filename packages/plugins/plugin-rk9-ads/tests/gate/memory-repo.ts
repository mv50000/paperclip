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
    async openForCompany(companyId) {
      const ids = [...store.rows.values()]
        .filter((row) => row.companyId === companyId && row.kind === "activate_ad" && row.status === "pending")
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
    async newerActivation(companyId, input) {
      const original = store.rows.get(input.gateRequestId);
      const own = original && original.companyId === companyId ? activationOf(original) : null;
      const publicationId = own?.publicationId;
      const nowMs = now().getTime();
      const inFlightSince = nowMs - Math.max(1, Math.trunc(input.inFlightMinutes)) * 60_000;
      // Ad sets known to be under the object (RK9-567): from any card's binding or outcome.
      const adsetsOfObject = new Set(
        [...store.rows.values()]
          .filter((row) => row.companyId === companyId && row.kind === "activate_ad")
          .filter((row) => activationOf(row)?.campaignId === input.objectId || row.outcome?.campaignId === input.objectId)
          .map((row) => activationOf(row)?.adsetId)
          .filter((id): id is string => typeof id === "string"),
      );
      const hits = [...store.rows.values()]
        .filter((row) => {
          if (row.companyId !== companyId || row.kind !== "activate_ad" || row.id === input.gateRequestId || row.status !== "approved") return false;
          const decided = row.decidedAt?.getTime() ?? 0;
          if (decided <= input.since.getTime()) return false;
          const running = row.outcome === null || row.outcome.handler === "started";
          if (row.outcome?.result !== "activated" && !running) return false;
          const binding = activationOf(row);
          const outcome = row.outcome ?? {};
          const ids = [binding?.adId, binding?.adsetId, binding?.campaignId, outcome.adId, outcome.adsetId, outcome.campaignId];
          const byAdset = running && binding !== null && (binding.adsetId === own?.adsetId || adsetsOfObject.has(binding.adsetId));
          return ids.includes(input.objectId) || (publicationId !== undefined && binding?.publicationId === publicationId) || byAdset;
        })
        .map((row) => {
          const decided = row.decidedAt?.getTime() ?? 0;
          const state = row.outcome?.result === "activated" ? 1 : decided > inFlightSince ? 0 : 2;
          return { id: row.id, state, decided };
        })
        .sort((a, b) => a.state - b.state || b.decided - a.decided);
      const hit = hits[0];
      if (!hit) return null;
      return { id: hit.id, inFlight: hit.state === 0, ...(hit.state === 2 ? { unknown: true } : {}), ageMinutes: Math.floor((nowMs - hit.decided) / 60_000) };
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
