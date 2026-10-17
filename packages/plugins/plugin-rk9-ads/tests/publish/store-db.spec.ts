/**
 * The publication store on real Postgres (A8, RK9-514): migration 001's
 * publications table through the host's runtime SQL validators, one company
 * at a time, with the unique key and the status compare-and-set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLedger } from "../../src/db.js";
import manifest from "../../src/manifest.js";
import { publicationKey } from "../../src/publish/ad-name.js";
import { sqlCreativeSource, sqlPublicationStore, type NewPublication } from "../../src/publish/store.js";
import type { PublicationPayload } from "../../src/publish/types.js";
import { PACKAGE_ROOT } from "../fixtures.js";
import { EMBEDDED_PG_TIMEOUT_MS, embeddedPostgresSupport, startPluginTestDatabase, type PluginTestDatabase } from "../helpers/embedded-pg.js";

const support = await embeddedPostgresSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres publication store tests: ${support.reason ?? "unsupported environment"}`);
}

const payload: PublicationPayload = {
  v: 1,
  kind: "image",
  mediaUrl: "https://media.ololla.fi/a.jpg",
  posterUrl: null,
  sha256: "a".repeat(64),
  aspectRatio: "1:1",
  placement: null,
  copy: { message: "Hei ☀️", title: "Otsikko" },
  cta: "LEARN_MORE",
  landingUrlKey: "home",
  utmCampaign: "syksy",
  finalUrl: "https://www.ololla.fi/?utm_source=meta&utm_medium=paid&utm_campaign=syksy",
  pageId: "1284777064729996",
  igUserId: null,
  thumbnailUrl: null,
  cleanup: null,
};

function values(companyId: string, key = "k1"): NewPublication {
  return {
    brandCode: "OLL",
    creativeId: null,
    idempotencyKey: publicationKey({ companyId, mode: "publish", key }),
    contentHash: "f".repeat(64),
    mode: "publish",
    adName: "OLL-syksy-image-20261017-ffffff",
    campaignId: "100",
    adsetId: "200",
    metaVideoId: null,
    metaAdId: null,
    replacesPublicationId: null,
    payload,
  };
}

describeDb("publication store on real Postgres", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-publish-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  }, EMBEDDED_PG_TIMEOUT_MS);

  it("inserts pending once per key, round-trips the payload and stays inside the company", async () => {
    const store = sqlPublicationStore(createLedger(testDb.client));
    const first = await store.insertPending(companyA, values(companyA));
    expect(first.inserted).toBe(true);
    expect(first.record).toMatchObject({ companyId: companyA, status: "pending", mode: "publish", adsetId: "200", payload });
    const again = await store.insertPending(companyA, values(companyA));
    expect(again).toMatchObject({ inserted: false, record: { id: first.record.id } });

    expect(await store.get(companyB, first.record.id)).toBeNull();
    expect(await store.findByKey(companyB, first.record.idempotencyKey)).toBeNull();
    expect(await store.get(companyA, "not-a-uuid")).toBeNull();
    // The same caller key in company B is another publication.
    expect((await store.insertPending(companyB, values(companyB))).inserted).toBe(true);
  });

  it("updates only from the expected status and records Meta ids and the publish time", async () => {
    const store = sqlPublicationStore(createLedger(testDb.client));
    const { record } = await store.insertPending(companyA, values(companyA, "k2"));
    expect(await store.update(companyA, record.id, "published", { status: "failed" })).toBe(false);
    expect(await store.update(companyB, record.id, "pending", { status: "failed" })).toBe(false);
    expect(await store.update(companyA, record.id, "pending", { metaCreativeId: "7001", metaAdId: "5001" })).toBe(true);
    expect(await store.update(companyA, record.id, "pending", { status: "published", publishedAt: new Date("2026-10-17T09:00:00Z") })).toBe(true);
    const stored = await store.get(companyA, record.id);
    expect(stored).toMatchObject({ status: "published", metaCreativeId: "7001", metaAdId: "5001", publishedAt: "2026-10-17T09:00:00.000Z" });
    expect(await store.findByAd(companyA, "5001")).toMatchObject({ id: record.id });
    expect(await store.findByAd(companyB, "5001")).toBeNull();
    await expect(testDb.adminQuery("UPDATE " + testDb.namespace + ".publications SET status = 'ACTIVE' WHERE id = $1", [record.id])).rejects.toThrow();
  });

  it("finds the owner of an ad behind any number of newer failed or pending rows (RK9-561)", async () => {
    const store = sqlPublicationStore(createLedger(testDb.client));
    const insert = (key: string, status: string, updatedAt: string) =>
      testDb.adminQuery<{ id: string }>(
        `INSERT INTO ${testDb.namespace}.publications (company_id, brand_code, idempotency_key, content_hash, status, meta_ad_id, updated_at)
         VALUES ($1, 'OLL', $2, $3, $4, '5900', $5) RETURNING id`,
        [companyA, key, "f".repeat(64), status, updatedAt],
      );
    const [owner] = await insert("owner-5900", "published", "2026-10-17T09:00:00Z");
    for (let index = 0; index < 25; index += 1) {
      await insert(`retry-5900-${index}`, index % 2 === 0 ? "failed" : "pending", `2026-10-17T10:${String(index).padStart(2, "0")}:00Z`);
    }
    expect(await store.findByAd(companyA, "5900")).toMatchObject({ id: owner!.id, status: "published" });
    expect(await store.findByAd(companyB, "5900")).toBeNull();
    // A later swap owns the ad.
    const [swap] = await insert("swap-5900", "swapped", "2026-10-17T11:00:00Z");
    expect(await store.findByAd(companyA, "5900")).toMatchObject({ id: swap!.id, status: "swapped" });
  });

  it("reads a staged creative row of the company only", async () => {
    const ledger = createLedger(testDb.client);
    const { id } = await ledger.insert(companyA, "creatives", {
      brand_code: "OLL",
      sha256: "b".repeat(64),
      idempotency_key: "oll-creative-0001",
      kind: "video",
      aspect_ratio: "9:16",
      media_url: "https://media.ololla.fi/a.mp4",
      thumbnail_url: "https://media.ololla.fi/a.jpg",
      ad_copy: { message: "Hei", description: "Kuvaus" },
      cta: "LEARN_MORE",
      landing_url_key: "home",
      utm_campaign: "syksy",
      valid_until: new Date("2026-12-01T00:00:00Z"),
      meta_video_id: "9001",
      status: "uploading",
    });
    const source = sqlCreativeSource(ledger);
    expect(await source.get(companyA, id)).toMatchObject({
      id,
      kind: "video",
      status: "uploading",
      posterUrl: "https://media.ololla.fi/a.jpg",
      copy: { message: "Hei", description: "Kuvaus" },
      metaVideoId: "9001",
      validUntil: "2026-12-01T00:00:00.000Z",
    });
    expect(await source.get(companyB, id)).toBeNull();
  });
});
