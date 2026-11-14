/**
 * Organic posting SQL (RK9-832) on real Postgres, through the host's runtime
 * SQL validators, on migrations 001 + 006: the organic_publish gate kind, the
 * post status compare-and-set, the open-content unique index, the card join,
 * the first reject reason, findByMessage and claimDenyReason, and two
 * companies that never see each other's rows.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import manifest from "../../src/manifest.js";
import { createLedger, type Ledger } from "../../src/db.js";
import { createSqlGateStore, gateTokenHash, newGateToken, type GateStore } from "../../src/kit/gate/state-machine.js";
import { effectiveStatus, sqlOrganicPostStore, type OrganicPostStore } from "../../src/organic/store.js";
import { EMBEDDED_PG_TIMEOUT_MS, describeEmbeddedPostgres, startPluginTestDatabase, type PluginTestDatabase } from "../helpers/embedded-pg.js";
import { PACKAGE_ROOT } from "../fixtures.js";

const describeDb = await describeEmbeddedPostgres("organic posts");

describeDb("organic posts SQL on real Postgres", () => {
  let testDb: PluginTestDatabase;
  let ledger: Ledger;
  let posts: OrganicPostStore;
  let gates: GateStore;
  let companyA: string;
  let companyB: string;
  const creatives: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-organic-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
    ledger = createLedger(testDb.client);
    posts = sqlOrganicPostStore(testDb.client, ledger);
    gates = createSqlGateStore(testDb.client);
    for (const [company, brand] of [[companyA, "OLL"], [companyB, "AUR"]] as const) {
      const { id } = await ledger.insert(company, "creatives", {
        brand_code: brand,
        sha256: "a".repeat(64),
        idempotency_key: `${brand}-organic-0001`,
        kind: "video",
        aspect_ratio: "9:16",
        media_url: "https://media.example.fi/a.mp4",
        status: "ready",
      });
      creatives[company] = id;
    }
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  }, EMBEDDED_PG_TIMEOUT_MS);

  async function card(companyId: string, messageId: number, validForMs = 3_600_000) {
    const token = newGateToken();
    const id = randomUUID();
    await gates.insertPending({
      id,
      companyId,
      brandCode: companyId === companyA ? "OLL" : "AUR",
      kind: "organic_publish",
      tokenHash: gateTokenHash(token),
      chatId: "-100777",
      validUntil: new Date(Date.now() + validForMs),
      payload: { card: { media: "video", text: "x" } },
    });
    await gates.setMessageId(companyId, id, messageId);
    return { id, tokenHash: gateTokenHash(token) };
  }

  function newPost(companyId: string, contentHash: string) {
    return posts.insertPending(companyId, {
      brandCode: companyId === companyA ? "OLL" : "AUR",
      creativeId: creatives[companyId]!,
      channel: "ig_reel",
      caption: "Valo palaa.",
      contentHash,
      mode: "dry_run",
      lint: null,
      payload: { mediaUrl: "https://media.example.fi/a.mp4" },
    });
  }

  it("accepts the organic_publish gate kind and still refuses an unknown one", async () => {
    await card(companyA, 1);
    const error = await testDb
      .adminQuery(
        `INSERT INTO ${testDb.namespace}.gate_requests (company_id, brand_code, kind, status, token, chat_id, valid_until)
         VALUES ($1, 'OLL', 'publish_anything', 'pending', $2, '-100777', now() + interval '1 hour')`,
        [companyA, "t".repeat(64)],
      )
      .then(() => null, (caught: unknown) => caught as { message?: string; cause?: { message?: string; constraint_name?: string } });
    expect(error).not.toBeNull();
    expect(`${error?.message} ${error?.cause?.message} ${error?.cause?.constraint_name}`).toMatch(/gate_requests_kind_check/);
  });

  it("keeps one open post per content and company, moves status by compare-and-set and stays company-scoped", async () => {
    const hash = "1".repeat(64);
    const post = await newPost(companyA, hash);
    expect(post).toMatchObject({ status: "pending", mode: "dry_run", channel: "ig_reel", payload: { mediaUrl: "https://media.example.fi/a.mp4" } });
    expect(await newPost(companyA, hash)).toBeNull();
    // The same hash in another company is another post.
    const other = await newPost(companyB, hash);
    expect(other).not.toBeNull();

    expect(await posts.get(companyB, post!.id)).toBeNull();
    expect(await posts.update(companyB, post!.id, "pending", { status: "publishing" })).toBe(false);
    expect(await posts.update(companyA, post!.id, "pending", { status: "publishing", decidedByTgUserId: 4242, decidedAt: new Date() })).toBe(true);
    expect(await posts.update(companyA, post!.id, "pending", { status: "failed" })).toBe(false);
    expect(await posts.update(companyA, post!.id, "publishing", { status: "published", metaMediaId: "17900000000000002", publishedAt: new Date() })).toBe(true);
    expect(await posts.get(companyA, post!.id)).toMatchObject({ status: "published", metaMediaId: "17900000000000002", decidedByTgUserId: 4242 });
    expect((await posts.findOpen(companyA, hash))?.id).toBe(post!.id);
    expect((await posts.findOpen(companyB, hash))?.id).toBe(other!.id);

    // A closed post frees the content for a new card.
    expect(await posts.update(companyA, post!.id, "published", { status: "deleted", deletedAt: new Date(), deletedBy: "board-user-1" })).toBe(true);
    expect(await posts.findOpen(companyA, hash)).toBeNull();
    expect(await newPost(companyA, hash)).not.toBeNull();

    expect((await posts.list(companyB, 50)).every((row) => row.companyId === companyB)).toBe(true);
    expect((await posts.recent(companyA, 24, 50)).every((row) => row.companyId === companyA)).toBe(true);
  });

  it("joins the card state: a pending post of an expired card reads as expired", async () => {
    const post = await newPost(companyA, "2".repeat(64));
    const live = await card(companyA, 2);
    await posts.update(companyA, post!.id, "pending", { gateRequestId: live.id });
    const view = await posts.findOpen(companyA, "2".repeat(64));
    expect(view).toMatchObject({ gateStatus: "pending", gateLive: true });
    expect(effectiveStatus(view!)).toBe("pending");

    const post2 = await newPost(companyA, "3".repeat(64));
    const stale = await card(companyA, 3, -60_000);
    await posts.update(companyA, post2!.id, "pending", { gateRequestId: stale.id });
    const view2 = await posts.findOpen(companyA, "3".repeat(64));
    expect(view2).toMatchObject({ gateStatus: "pending", gateLive: false });
    expect(effectiveStatus(view2!)).toBe("expired");
  });

  it("stores only the first reject reason of a rejected post of the company", async () => {
    const post = await newPost(companyA, "4".repeat(64));
    expect(await posts.setRejectReason(companyA, post!.id, "claim", null)).toBe(false);
    await posts.update(companyA, post!.id, "pending", { status: "rejected" });
    expect(await posts.setRejectReason(companyB, post!.id, "visual", null)).toBe(false);
    expect(await posts.setRejectReason(companyA, post!.id, "other", "Aurinko näyttää kuulta")).toBe(true);
    expect(await posts.setRejectReason(companyA, post!.id, "visual", null)).toBe(false);
    expect(await posts.get(companyA, post!.id)).toMatchObject({ rejectReasonCode: "other", rejectReasonText: "Aurinko näyttää kuulta" });
  });

  it("finds a card by chat and message id, and claims a deny reason once, only on a denied card of the company", async () => {
    const a = await card(companyA, 501);
    const found = await gates.findByMessage!("-100777", 501);
    expect(found).toMatchObject({ id: a.id, companyId: companyA, kind: "organic_publish", status: "pending" });
    expect(await gates.findByMessage!("-100777", 999_999)).toBeNull();
    expect(await gates.findByMessage!("-100888", 501)).toBeNull();

    expect(await gates.claimDenyReason!(companyA, a.id, { reason: { code: "claim" } })).toBe(false);
    expect(await gates.decide(companyA, a.tokenHash, "denied", 4242)).toBe(true);
    expect(await gates.claimDenyReason!(companyB, a.id, { reason: { code: "claim" } })).toBe(false);
    expect(await gates.claimDenyReason!(companyA, a.id, { reason: { code: "claim" } })).toBe(true);
    expect(await gates.claimDenyReason!(companyA, a.id, { reason: { code: "visual" } })).toBe(false);
    const [row] = await testDb.adminQuery<{ outcome: unknown }>(`SELECT outcome FROM ${testDb.namespace}.gate_requests WHERE id = $1`, [a.id]);
    expect(row!.outcome).toEqual({ reason: { code: "claim" } });

    // Company B's card on the same chat and message id is the newest; the router then checks the company's chat.
    const b = await card(companyB, 501);
    expect((await gates.findByMessage!("-100777", 501))?.id).toBe(b.id);
  });
});
