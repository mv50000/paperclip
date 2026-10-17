/**
 * The activation gate's SQL (A9, RK9-517) on real Postgres, through the
 * host's runtime SQL validators: the ad columns written with the pending row,
 * the swap close, the in-flight check, the expiry sweep, token rotation and
 * the atomic pending -> decided transition under parallel taps.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../../src/manifest.js";
import { sqlActivationGateRepo, withActivationColumns } from "../../src/gate/gate-requests.js";
import { createSqlGateStore, gateTokenHash, newGateToken, type GateStore } from "../../src/kit/gate/state-machine.js";
import { EMBEDDED_PG_TIMEOUT_MS, describeEmbeddedPostgres, startPluginTestDatabase, type PluginTestDatabase } from "../helpers/embedded-pg.js";
import { PACKAGE_ROOT } from "../fixtures.js";

const describeDb = await describeEmbeddedPostgres("activation gate");

const AD = "120200000000000301";
const ADSET = "120200000000000201";

describeDb("activation gate SQL on real Postgres", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;
  let companyB: string;
  let publicationId: string;
  let store: GateStore;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-a9-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
    const [row] = await testDb.adminQuery<{ id: string }>(
      `INSERT INTO ${testDb.namespace}.publications (company_id, brand_code, idempotency_key, content_hash, status)
       VALUES ($1, 'OLL', 'a9-key', $2, 'published') RETURNING id`,
      [companyA, "c".repeat(64)],
    );
    publicationId = row!.id;
    store = withActivationColumns(createSqlGateStore(testDb.client), testDb.client);
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  async function card(input: { companyId?: string; validForMs?: number; adId?: string } = {}) {
    const token = newGateToken();
    const id = crypto.randomUUID();
    await store.insertPending({
      id,
      companyId: input.companyId ?? companyA,
      brandCode: "OLL",
      kind: "activate_ad",
      tokenHash: gateTokenHash(token),
      chatId: "-100777",
      validUntil: new Date(Date.now() + (input.validForMs ?? 3_600_000)),
      payload: {
        card: { media: "photo", text: "x" },
        activation: {
          publicationId,
          adId: input.adId ?? AD,
          adsetId: ADSET,
          campaignId: null,
          creativeId: "120200000000000401",
          contentHash: "c".repeat(64),
          adName: "OLL syksy 1",
          media: "photo",
          mediaUrl: "https://media.ololla.fi/a.jpg",
        },
      },
    });
    await store.setMessageId(input.companyId ?? companyA, id, 10);
    return { id, token, tokenHash: gateTokenHash(token) };
  }

  it("writes the ad columns with the pending row and finds the ad's open cards, per company", async () => {
    const repo = sqlActivationGateRepo(testDb.client);
    const { id } = await card({ adId: "120200000000000311" });
    const [row] = await testDb.adminQuery<{ publication_id: string; ad_id: string; adset_id: string }>(
      `SELECT publication_id, ad_id, adset_id FROM ${testDb.namespace}.gate_requests WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ publication_id: publicationId, ad_id: "120200000000000311", adset_id: ADSET });
    expect((await repo.openForAd(companyA, "120200000000000311")).map((entry) => entry.id)).toEqual([id]);
    expect(await repo.openForAd(companyB, "120200000000000311")).toEqual([]);
    expect((await repo.pendingForPublication(companyA, publicationId))?.id).toBe(id);

    expect(await repo.close(companyB, id, { reason: "creative_swapped" })).toBe(false);
    expect(await repo.close(companyA, id, { handler: "not_run", reason: "creative_swapped" })).toBe(true);
    expect(await repo.close(companyA, id, { reason: "creative_swapped" })).toBe(false);
    expect(await repo.openForAd(companyA, "120200000000000311")).toEqual([]);
    expect(await store.findById(companyA, id)).toMatchObject({ status: "expired" });
  });

  it("lists the company's open activation cards for a pause, and reads a closer's status line back (RK9-557)", async () => {
    const repo = sqlActivationGateRepo(testDb.client);
    const first = await card({ adId: "120200000000000321" });
    const second = await card({ adId: "120200000000000322", validForMs: 1 });
    const open = (await repo.openForCompany(companyA)).map((entry) => entry.id);
    // Live or not: a pending card past valid_until is closed too.
    expect(open).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await repo.openForCompany(companyB)).toEqual([]);

    expect(await store.findById(companyA, first.id)).toMatchObject({ closedStatus: null });
    expect(await repo.close(companyA, first.id, { handler: "not_run", reason: "kill_switch", statusText: "⛔ Hätäkatkaisin" })).toBe(true);
    expect(await store.findByTokenHash(first.tokenHash)).toMatchObject({ status: "expired", closedStatus: "⛔ Hätäkatkaisin" });
    expect((await repo.openForCompany(companyA)).map((entry) => entry.id)).not.toContain(first.id);
  });

  it("reports an approved activation in flight until the handler records its end, and only within the window", async () => {
    const repo = sqlActivationGateRepo(testDb.client);
    const { id, tokenHash } = await card({ adId: "120200000000000312" });
    expect(await repo.activationInFlight(companyA, "120200000000000312", 30)).toBe(false);
    expect(await store.decide(companyA, tokenHash, "approved", 4242)).toBe(true);
    expect(await repo.activationInFlight(companyA, "120200000000000312", 30)).toBe(true);
    expect(await store.settle(companyA, id, { from: "approved", to: "approved", outcome: { handler: "started" } })).toBe(true);
    expect(await repo.activationInFlight(companyA, "120200000000000312", 30)).toBe(true);
    expect(await repo.activationInFlight(companyB, "120200000000000312", 30)).toBe(false);
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET decided_at = now() - interval '31 minutes' WHERE id = $1`, [id]);
    expect(await repo.activationInFlight(companyA, "120200000000000312", 30)).toBe(false);
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET decided_at = now() WHERE id = $1`, [id]);
    expect(await store.settle(companyA, id, { from: "approved", to: "denied", outcome: { handler: "done" }, error: "spend_guard" })).toBe(true);
    expect(await repo.activationInFlight(companyA, "120200000000000312", 30)).toBe(false);

    await repo.setPausedAdIds(companyA, id, ["1", "2"]);
    const [row] = await testDb.adminQuery<{ paused_ad_ids: string[]; status: string }>(
      `SELECT paused_ad_ids, status FROM ${testDb.namespace}.gate_requests WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ paused_ad_ids: ["1", "2"], status: "denied" });
  });

  it("finds a newer activation of the object or the card's publication, a running one first, per company (RK9-565)", async () => {
    const repo = sqlActivationGateRepo(testDb.client);
    const ad = "120200000000000313";
    const failed = await card({ adId: ad });
    const since = new Date(Date.now() - 60_000);
    const query = { objectId: ad, gateRequestId: failed.id, since, inFlightMinutes: 30 };
    expect(await repo.newerActivation(companyA, query)).toBeNull();

    // Approved, the handler not finished: still activating.
    const newer = await card({ adId: ad });
    expect(await store.decide(companyA, newer.tokenHash, "approved", 4242)).toBe(true);
    expect(await repo.newerActivation(companyA, query)).toEqual({ id: newer.id, inFlight: true });
    // Ended without activating: the retry goes on.
    expect(await store.settle(companyA, newer.id, { from: "approved", to: "approved", outcome: { handler: "done", result: "failed" } })).toBe(true);
    expect(await repo.newerActivation(companyA, query)).toBeNull();
    expect(await store.settle(companyA, newer.id, { from: "approved", to: "approved", outcome: { handler: "done", result: "activated", campaignId: "120200000000000777" } })).toBe(true);
    expect(await repo.newerActivation(companyA, query)).toEqual({ id: newer.id, inFlight: false });
    // Any object of the failed card's publication matches; without the publication, the outcome's campaign (the binding has none) does.
    expect(await repo.newerActivation(companyA, { ...query, objectId: "120200000000000999" })).toEqual({ id: newer.id, inFlight: false });
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET publication_id = NULL WHERE id = $1`, [newer.id]);
    expect(await repo.newerActivation(companyA, { ...query, objectId: "120200000000000777" })).toEqual({ id: newer.id, inFlight: false });
    expect(await repo.newerActivation(companyA, { ...query, objectId: "120200000000000999" })).toBeNull();
    // Decided before the failure: not newer.
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET decided_at = $2 WHERE id = $1`, [newer.id, new Date(since.getTime() - 1_000).toISOString()]);
    expect(await repo.newerActivation(companyA, query)).toBeNull();
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET decided_at = now() WHERE id = $1`, [newer.id]);
    // The failed card itself never counts, and another company sees nothing.
    expect(await repo.newerActivation(companyA, { ...query, gateRequestId: newer.id })).toBeNull();
    expect(await repo.newerActivation(companyB, query)).toBeNull();

    // A handler that never finished stops counting as running after the window.
    const stuck = await card({ adId: ad });
    expect(await store.decide(companyA, stuck.tokenHash, "approved", 4242)).toBe(true);
    expect(await repo.newerActivation(companyA, query)).toEqual({ id: stuck.id, inFlight: true });
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET decided_at = now() - interval '31 minutes' WHERE id = $1`, [stuck.id]);
    expect(await repo.newerActivation(companyA, { ...query, since: new Date(Date.now() - 3_600_000) })).toEqual({ id: newer.id, inFlight: false });
  });

  it("sweeps only cards past valid_until, and the kit's expire moves each one once", async () => {
    const repo = sqlActivationGateRepo(testDb.client);
    const live = await card({ adId: "120200000000000313" });
    const due = await card({ adId: "120200000000000314", validForMs: 60_000 });
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.gate_requests SET valid_until = now() - interval '1 second' WHERE id = $1`, [due.id]);
    const swept = await repo.dueForExpiry(100);
    expect(swept.map((entry) => entry.id)).toContain(due.id);
    expect(swept.map((entry) => entry.id)).not.toContain(live.id);
    const entry = swept.find((item) => item.id === due.id)!;
    expect(entry.tokenHash).toBe(due.tokenHash);
    expect(await store.expire(entry.companyId, entry.tokenHash)).toBe(true);
    expect(await store.expire(entry.companyId, entry.tokenHash)).toBe(false);
    expect((await repo.dueForExpiry(100)).map((item) => item.id)).not.toContain(due.id);
  });

  it("rotates the token of a pending card only; the old token stops matching", async () => {
    const { id, tokenHash } = await card({ adId: "120200000000000315" });
    const next = gateTokenHash(newGateToken());
    expect(await store.rotateToken(companyB, id, next, "-100888")).toBe(false);
    expect(await store.rotateToken(companyA, id, next, "-100888")).toBe(true);
    expect(await store.findByTokenHash(tokenHash)).toBeNull();
    expect(await store.findByTokenHash(next)).toMatchObject({ id, chatId: "-100888", messageId: null });
    expect(await store.decide(companyA, next, "skipped", 4242)).toBe(true);
    expect(await store.rotateToken(companyA, id, gateTokenHash(newGateToken()), "-100888")).toBe(false);
  });

  it("lets exactly one of many parallel taps decide a card", async () => {
    const { tokenHash } = await card({ adId: "120200000000000316" });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.decide(companyA, tokenHash, "approved", 4242)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
