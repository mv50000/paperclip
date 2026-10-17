import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { STAGE_CREATIVE_ROUTE, STAGE_CREATIVE_TOOL } from "../src/features/creatives/register.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { brandConfig, PACKAGE_ROOT, SECRET_A_META, SECRET_B_META, secretRef } from "./fixtures.js";
import { FakeMediaAndGraph } from "./helpers/fake-media.js";
import {
  EMBEDDED_PG_TIMEOUT_MS,
  describeEmbeddedPostgres,
  startPluginTestDatabase,
  type PluginTestDatabase,
} from "./helpers/embedded-pg.js";

const VIDEO_URL = "https://media.ololla.fi/reels/kesa-1.mp4";
const POSTER_URL = "https://media.ololla.fi/reels/kesa-1.jpg";
const IMAGE_URL = "https://media.ololla.fi/images/mokki.png";
const SHA_VIDEO = "a".repeat(64);
const SHA_IMAGE = "b".repeat(64);

function videoManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    brand: "OLL",
    kind: "video",
    mediaUrl: VIDEO_URL,
    posterUrl: POSTER_URL,
    sha256: SHA_VIDEO,
    aspectRatio: "9:16",
    copy: { message: "Mökkiloma Forssassa", title: "Varaa nyt" },
    cta: "BOOK_TRAVEL",
    landingUrlKey: "home",
    utmCampaign: "oll-kesa-2027",
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    idempotencyKey: "oll-reel-kesa-1",
    ...overrides,
  };
}

function imageManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { posterUrl: _poster, ...base } = videoManifest();
  return { ...base, kind: "image", mediaUrl: IMAGE_URL, sha256: SHA_IMAGE, aspectRatio: "1:1", idempotencyKey: "oll-image-mokki", ...overrides };
}

const describeDb = await describeEmbeddedPostgres("creative ingress");

describeDb("creative ingress (tool + route, real Postgres)", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;
  let companyB: string;
  let companyOff: string;
  let harness: TestHarness;
  let fake: FakeMediaAndGraph;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-creatives-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
    companyOff = await testDb.createCompany("Other");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  beforeEach(async () => {
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.creatives`);
    harness = createTestHarness({ manifest });
    harness.seed({
      companies: [
        { id: companyA, name: "Ololla" } as Company,
        { id: companyB, name: "Sunspot" } as Company,
        { id: companyOff, name: "Other" } as Company,
      ],
    });
    useCompanyConfigs(harness, {
      [companyA]: brandConfig(),
      [companyB]: brandConfig({
        brandCode: "AUR",
        meta: { adAccountId: "act_1336862981968191", pageId: "1", accessTokenRef: secretRef(SECRET_B_META) },
        landing: { allowedDomains: ["sunspot.fi"], urls: { home: "https://sunspot.fi/" } },
      }),
    });
    useCompanySecrets(harness, {
      [companyA]: { [SECRET_A_META]: "EAAG-company-a-token" },
      [companyB]: { [SECRET_B_META]: "EAAG-company-b-token" },
    });
    (harness.ctx as { db: unknown }).db = testDb.client;
    fake = new FakeMediaAndGraph()
      .head(VIDEO_URL, { headers: { "content-type": "video/mp4", "content-length": String(20 * 1024 * 1024) } })
      .head(POSTER_URL, { headers: { "content-type": "image/jpeg", "content-length": "200000" } })
      .head(IMAGE_URL, { headers: { "content-type": "image/png; charset=binary", "content-length": "500000" } });
    harness.ctx.http.fetch = fake.fetch;
    await plugin.definition.setup(harness.ctx);
  });

  async function viaTool(companyId: string, input: unknown) {
    const result = await harness.executeTool<{ error?: string; data?: unknown }>(STAGE_CREATIVE_TOOL, { manifest: input }, { companyId });
    return result;
  }

  async function viaRoute(companyId: string, input: unknown, bodyCompanyId: string = companyId) {
    return plugin.definition.onApiRequest!({
      routeKey: STAGE_CREATIVE_ROUTE,
      method: "POST",
      path: "/creatives",
      params: {},
      query: {},
      body: { companyId: bodyCompanyId, manifest: input },
      actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1" },
      companyId,
      headers: {},
    });
  }

  async function rows(companyId: string) {
    return testDb.adminQuery<Record<string, unknown>>(
      `SELECT * FROM ${testDb.namespace}.creatives WHERE company_id = $1 ORDER BY created_at`,
      [companyId],
    );
  }

  it("stages a video: one HEAD per URL, one advideos upload by file_url, never a media body read", async () => {
    const response = await viaRoute(companyA, videoManifest());
    expect(response.status).toBe(201);
    const body = response.body as { created: boolean; creative: Record<string, unknown> };
    expect(body.created).toBe(true);
    expect(body.creative).toMatchObject({
      brand: "OLL",
      kind: "video",
      status: "uploading",
      sha256: SHA_VIDEO,
      mediaUrl: VIDEO_URL,
      posterUrl: POSTER_URL,
      metaVideoId: "900000000000001",
    });

    expect(fake.mediaCalls.map((call) => `${call.method} ${call.url}`)).toEqual([`HEAD ${VIDEO_URL}`, `HEAD ${POSTER_URL}`]);
    expect(fake.graphWrites).toHaveLength(1);
    expect(fake.graphWrites[0]!.url).toMatch(/\/act_29231592883113369\/advideos$/);
    expect(fake.graphWrites[0]!.fields.file_url).toBe(VIDEO_URL);
    // The plugin never reads media bytes (G4): every media response body stays unread.
    fake.responses.filter((_, index) => !fake.calls[index]!.url.includes("graph.facebook.com")).forEach((r) => {
      expect(r.bodyUsed).toBe(false);
    });

    const [row] = await rows(companyA);
    expect(row).toMatchObject({ brand_code: "OLL", meta_video_id: "900000000000001", status: "uploading", thumbnail_url: POSTER_URL });
    expect(harness.activity.some((entry) => entry.message === "rk9-ads creative staged")).toBe(true);
  });

  it("stages an image as ready with no Meta call (the image goes to Meta by URL later)", async () => {
    const result = await viaTool(companyA, imageManifest());
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ created: true, creative: { kind: "image", status: "ready", metaImageHash: null } });
    expect(fake.graphWrites).toHaveLength(0);
  });

  it("returns the existing record for the same (company, brand, sha256) or idempotencyKey, with no second HEAD or upload", async () => {
    const first = await viaRoute(companyA, videoManifest());
    const firstId = (first.body as { creative: { id: string } }).creative.id;
    const callsAfterFirst = fake.calls.length;

    const sameKey = await viaRoute(companyA, videoManifest());
    const sameSha = await viaTool(companyA, videoManifest({ idempotencyKey: "oll-reel-kesa-1-variant" }));

    expect(sameKey.status).toBe(200);
    expect(sameKey.body).toMatchObject({ created: false, creative: { id: firstId } });
    expect(sameSha.data).toMatchObject({ created: false, creative: { id: firstId } });
    expect(fake.calls.length).toBe(callsAfterFirst);
    expect(await rows(companyA)).toHaveLength(1);
  });

  it("refuses the same media with other text fields with 409 and names them, instead of dropping them", async () => {
    const first = await viaRoute(companyA, videoManifest());
    const firstId = (first.body as { creative: { id: string } }).creative.id;
    const callsAfterFirst = fake.calls.length;

    const otherCopy = await viaRoute(companyA, videoManifest({ idempotencyKey: "oll-reel-kesa-1-variant", copy: { message: "Toinen teksti" } }));
    expect(otherCopy.status).toBe(409);
    expect(otherCopy.body).toMatchObject({
      error: { code: "creative_text_conflict", path: "/copy", fields: ["copy"] },
      creative: { id: firstId },
    });

    // A dropped optional copy key counts as a difference too.
    const noTitle = await viaRoute(companyA, videoManifest({ idempotencyKey: "oll-reel-kesa-1-variant", copy: { message: "Mökkiloma Forssassa" } }));
    expect(noTitle.body).toMatchObject({ error: { code: "creative_text_conflict", fields: ["copy"] } });

    // The same key with other text is refused as well: a retry must carry the same manifest.
    const several = await viaTool(companyA, videoManifest({ cta: "LEARN_MORE", utmCampaign: "oll-syksy-2027" }));
    expect(several.error).toMatch(/^creative_text_conflict at \/cta/);
    expect(several.data).toMatchObject({ error: { fields: ["cta", "utmCampaign"] } });

    expect(fake.calls.length).toBe(callsAfterFirst);
    const [row] = await rows(companyA);
    expect(row).toMatchObject({ cta: "BOOK_TRAVEL", utm_campaign: "oll-kesa-2027", ad_copy: { message: "Mökkiloma Forssassa", title: "Varaa nyt" } });
  });

  it("stages an expired or rejected creative again with the new manifest, once, and re-uploads the video", async () => {
    const first = await viaRoute(companyA, videoManifest());
    const id = (first.body as { creative: { id: string } }).creative.id;
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET status = 'expired', error = 'old' WHERE id = $1`, [id]);

    const newUrl = "https://media.ololla.fi/reels/kesa-1-v2.mp4";
    fake.head(newUrl, { headers: { "content-type": "video/mp4", "content-length": "1000" } });
    const restage = () =>
      viaRoute(
        companyA,
        videoManifest({ idempotencyKey: "oll-reel-kesa-1-again", mediaUrl: newUrl, copy: { message: "Syysloma" }, utmCampaign: "oll-syksy-2027" }),
      );
    const results = await Promise.all([restage(), restage(), restage()]);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ created: false, creative: { id, mediaUrl: newUrl, utmCampaign: "oll-syksy-2027", error: null } });
    }
    expect(fake.graphWrites).toHaveLength(2);
    expect(fake.graphWrites[1]!.fields.file_url).toBe(newUrl);
    const [row] = await rows(companyA);
    expect(row).toMatchObject({ status: "uploading", meta_video_id: "900000000000002", ad_copy: { message: "Syysloma" }, idempotency_key: "oll-reel-kesa-1" });
    expect(harness.activity.filter((entry) => entry.message === "rk9-ads creative restaged")).toHaveLength(1);

    // An image rejected earlier comes back as ready.
    await viaRoute(companyA, imageManifest());
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET status = 'rejected' WHERE sha256 = $1`, [SHA_IMAGE]);
    const image = await viaTool(companyA, imageManifest({ cta: "LEARN_MORE" }));
    expect(image.data).toMatchObject({ created: false, creative: { status: "ready", cta: "LEARN_MORE" } });
  });

  it("does not restage a live creative and does not restage on a failed HEAD", async () => {
    const first = await viaRoute(companyA, videoManifest());
    const id = (first.body as { creative: { id: string } }).creative.id;
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET status = 'published' WHERE id = $1`, [id]);
    const live = await viaRoute(companyA, videoManifest({ copy: { message: "Toinen teksti" } }));
    expect(live.body).toMatchObject({ error: { code: "creative_text_conflict" }, creative: { status: "published" } });

    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET status = 'expired' WHERE id = $1`, [id]);
    const missing = await viaRoute(companyA, videoManifest({ mediaUrl: "https://media.ololla.fi/gone.mp4" }));
    expect(missing.body).toMatchObject({ error: { code: "media_unreachable", path: "/mediaUrl" } });
    const [row] = await rows(companyA);
    expect(row).toMatchObject({ status: "expired", media_url: VIDEO_URL });
  });

  it("caps new creative rows per company per 24 hours, but still answers dedupe hits", async () => {
    await viaRoute(companyA, imageManifest());
    await testDb.adminQuery(
      `INSERT INTO ${testDb.namespace}.creatives (company_id, brand_code, sha256, idempotency_key, kind, media_url)
       SELECT $1, 'OLL', lpad(to_hex(n), 64, '0'), 'bulk-' || n, 'image', 'https://media.ololla.fi/x.png'
       FROM generate_series(1, 199) AS n`,
      [companyA],
    );
    const capped = await viaRoute(companyA, videoManifest());
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ error: { code: "creative_limit_reached" } });
    expect(fake.calls.some((call) => call.url === VIDEO_URL)).toBe(false);

    const dedupe = await viaRoute(companyA, imageManifest());
    expect(dedupe.status).toBe(200);

    // Another company has its own budget.
    const other = await viaTool(companyB, videoManifest({ brand: "AUR" }));
    expect(other.data).toMatchObject({ created: true });
  });

  it("holds under concurrency: N parallel stages make one row and one upload", async () => {
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => viaRoute(companyA, videoManifest())),
      ...Array.from({ length: 4 }, (_, i) => viaTool(companyA, videoManifest({ idempotencyKey: `oll-reel-race-${i}` }))),
    ]);
    const routeBodies = results.slice(0, 4).map((r) => (r as { body: unknown }).body);
    const toolBodies = results.slice(4).map((r) => (r as { data: unknown }).data);
    const all = [...routeBodies, ...toolBodies] as Array<{ created: boolean; creative: { id: string } }>;
    expect(all.filter((body) => body.created)).toHaveLength(1);
    expect(new Set(all.map((body) => body.creative.id)).size).toBe(1);
    expect(fake.graphWrites).toHaveLength(1);
    expect(await rows(companyA)).toHaveLength(1);
  });

  it("refuses an idempotencyKey reused for other media", async () => {
    await viaRoute(companyA, videoManifest());
    const response = await viaRoute(companyA, videoManifest({ sha256: "c".repeat(64) }));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "idempotency_key_conflict", path: "/idempotencyKey" } });
  });

  it("tool and route return identical results for the same input", async () => {
    const inputs: unknown[] = [
      videoManifest({ mediaUrl: "http://media.ololla.fi/a.mp4" }),
      videoManifest({ copy: { message: "" } }),
      videoManifest({ brand: "AUR" }),
      imageManifest(),
      imageManifest(),
      videoManifest(),
      videoManifest(),
    ];
    for (const input of inputs) {
      // Same state for both: the route call runs first, then the tool call sees the same row.
      const route = await viaRoute(companyA, input);
      const tool = await viaTool(companyA, input);
      if ((route.body as { created?: boolean }).created) {
        // The first call created the row; the parity check is the next pair.
        const routeAgain = await viaRoute(companyA, input);
        expect(tool.data).toEqual(routeAgain.body);
      } else {
        expect(tool.data).toEqual(route.body);
      }
      if ("error" in (route.body as object)) {
        const { error } = route.body as { error: { code: string } };
        expect(tool.error).toContain(error.code);
      }
    }
  });

  it.each([
    ["non-https mediaUrl", videoManifest({ mediaUrl: "http://media.ololla.fi/a.mp4" }), 400, "url_not_https", "/mediaUrl"],
    ["non-https posterUrl", videoManifest({ posterUrl: "ftp://media.ololla.fi/a.jpg" }), 400, "url_not_https", "/posterUrl"],
    ["IP literal", videoManifest({ mediaUrl: "https://169.254.169.254/latest/meta-data" }), 400, "url_forbidden", "/mediaUrl"],
    ["decimal IP literal", videoManifest({ mediaUrl: "https://2130706433/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["IPv6 literal", videoManifest({ mediaUrl: "https://[::1]/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["localhost", videoManifest({ mediaUrl: "https://localhost/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["internal name", videoManifest({ mediaUrl: "https://minio.internal/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["tailnet name", videoManifest({ mediaUrl: "https://vault.tail1234.ts.net/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["tailnet IP literal", videoManifest({ mediaUrl: "https://100.103.149.19/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["credentials", videoManifest({ mediaUrl: "https://u:p@media.ololla.fi/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["custom port", videoManifest({ mediaUrl: "https://media.ololla.fi:8443/a.mp4" }), 400, "url_forbidden", "/mediaUrl"],
    ["poster on an image", imageManifest({ posterUrl: POSTER_URL }), 400, "invalid_manifest", "/posterUrl"],
    ["bad sha256", videoManifest({ sha256: "ABC" }), 400, "invalid_manifest", "/sha256"],
    ["empty copy message", videoManifest({ copy: { message: "" } }), 400, "invalid_manifest", "/copy/message"],
    ["unknown field", videoManifest({ landingUrl: "https://evil.example/" }), 400, "invalid_manifest", ""],
    ["unknown cta", videoManifest({ cta: "ACTIVATE" }), 400, "invalid_manifest", "/cta"],
    ["past validUntil", videoManifest({ validUntil: "2020-01-01T00:00:00Z" }), 400, "valid_until_past", "/validUntil"],
    ["another company's brand", videoManifest({ brand: "AUR" }), 422, "unknown_brand", "/brand"],
    ["unknown landing key", videoManifest({ landingUrlKey: "promo" }), 422, "unknown_landing_url_key", "/landingUrlKey"],
  ])("rejects %s", async (_name, input, status, code, path) => {
    const response = await viaRoute(companyA, input);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error: { code, path } });
    const tool = await viaTool(companyA, input);
    expect(tool.error).toMatch(new RegExp(`^${code}`));
    expect(fake.calls).toHaveLength(0);
    expect(await rows(companyA)).toHaveLength(0);
  });

  it("rejects media whose HEAD does not match the kind, is too large or is not a direct file", async () => {
    fake.head("https://media.ololla.fi/wrong.mp4", { headers: { "content-type": "text/html" } });
    fake.head("https://media.ololla.fi/huge.png", { headers: { "content-type": "image/png", "content-length": String(31 * 1024 * 1024) } });
    fake.head("https://media.ololla.fi/moved.mp4", { status: 302, headers: { location: "http://10.0.0.1/a.mp4" } });
    fake.head("https://media.ololla.fi/poster.html", { headers: { "content-type": "text/html" } });

    const cases: Array<[unknown, number, string, string]> = [
      [videoManifest({ mediaUrl: "https://media.ololla.fi/wrong.mp4" }), 422, "media_type_mismatch", "/mediaUrl"],
      [videoManifest({ mediaUrl: IMAGE_URL }), 422, "media_type_mismatch", "/mediaUrl"],
      [imageManifest({ mediaUrl: VIDEO_URL }), 422, "media_type_mismatch", "/mediaUrl"],
      [imageManifest({ mediaUrl: "https://media.ololla.fi/huge.png" }), 422, "media_too_large", "/mediaUrl"],
      [videoManifest({ mediaUrl: "https://media.ololla.fi/moved.mp4" }), 422, "media_unreachable", "/mediaUrl"],
      [videoManifest({ mediaUrl: "https://media.ololla.fi/missing.mp4" }), 422, "media_unreachable", "/mediaUrl"],
      [videoManifest({ posterUrl: "https://media.ololla.fi/poster.html" }), 422, "media_type_mismatch", "/posterUrl"],
    ];
    for (const [input, status, code, path] of cases) {
      const response = await viaRoute(companyA, input);
      expect(response.status, code).toBe(status);
      expect(response.body).toMatchObject({ error: { code, path } });
    }
    // Only HEADs went out; the redirect target was never contacted.
    expect(fake.calls.every((call) => call.method === "HEAD")).toBe(true);
    expect(fake.calls.some((call) => call.url.startsWith("http://10."))).toBe(false);
    expect(await rows(companyA)).toHaveLength(0);
  });

  it("keeps companies apart: the route needs body.companyId to name the resolved company, and an unconfigured company is off", async () => {
    const mismatch = await viaRoute(companyA, videoManifest(), companyB);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ error: { code: "invalid_request" } });

    const off = await viaRoute(companyOff, videoManifest());
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: { code: "plugin_not_enabled" } });

    // Sunspot's agent cannot stage into Ololla's brand, even with the same media.
    const crossBrand = await viaTool(companyB, videoManifest());
    expect(crossBrand.error).toMatch(/^unknown_brand/);

    // The same media under each company's own brand gives two rows in two accounts.
    await viaRoute(companyA, videoManifest());
    const own = await viaTool(companyB, videoManifest({ brand: "AUR" }));
    expect(own.data).toMatchObject({ created: true, creative: { brand: "AUR" } });
    expect(fake.graphWrites.map((call) => new URL(call.url).pathname.split("/")[2])).toEqual([
      "act_29231592883113369",
      "act_1336862981968191",
    ]);
    expect(await rows(companyA)).toHaveLength(1);
    expect(await rows(companyB)).toHaveLength(1);
  });

  it("records a failed upload, then retries it once on the next submit", async () => {
    fake.failUploads = 1;
    const failed = await viaRoute(companyA, videoManifest());
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ error: { code: "meta_upload_failed" }, creative: { status: "failed", metaVideoId: null } });

    const retried = await viaTool(companyA, videoManifest());
    expect(retried.data).toMatchObject({ created: false, creative: { status: "uploading", metaVideoId: "900000000000001" } });
    expect(fake.graphWrites).toHaveLength(2);

    const again = await viaRoute(companyA, videoManifest());
    expect(again.body).toMatchObject({ created: false });
    expect(fake.graphWrites).toHaveLength(2);
  });

  it("returns no connection detail when the HEAD fails (no port or certificate probing)", async () => {
    const probe = "https://probe.example.com/x.mp4";
    fake.head(probe, { throws: "connect ECONNREFUSED 100.64.1.2:443 (cert CN=vault.tailnet)" });
    const response = await viaRoute(companyA, videoManifest({ mediaUrl: probe }));
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: "media_unreachable", message: "HEAD request failed", path: "/mediaUrl" } });
    expect(JSON.stringify(response.body)).not.toContain("100.64");
  });

  it("re-uploads a video stuck in uploading without a video id once it is stale, and only once", async () => {
    const first = await viaRoute(companyA, videoManifest());
    const id = (first.body as { creative: { id: string } }).creative.id;
    // A worker died between the claim and the Meta answer.
    await testDb.adminQuery(
      `UPDATE ${testDb.namespace}.creatives SET status = 'uploading', meta_video_id = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    const fresh = await viaRoute(companyA, videoManifest());
    expect(fresh.body).toMatchObject({ created: false, creative: { status: "uploading", metaVideoId: null } });
    expect(fake.graphWrites).toHaveLength(1);

    await testDb.adminQuery(
      `UPDATE ${testDb.namespace}.creatives SET updated_at = now() - interval '11 minutes' WHERE id = $1`,
      [id],
    );
    const results = await Promise.all(Array.from({ length: 4 }, () => viaRoute(companyA, videoManifest())));
    expect(fake.graphWrites).toHaveLength(2);
    expect(results.map((r) => (r.body as { creative: { id: string } }).creative.id)).toEqual([id, id, id, id]);
    const [row] = await rows(companyA);
    expect(row).toMatchObject({ status: "uploading", meta_video_id: "900000000000002" });
  });

  it("never sends the token anywhere but Graph, and never as a query parameter", async () => {
    await viaRoute(companyA, videoManifest());
    for (const call of fake.calls) {
      expect(call.url).not.toContain("EAAG-company-a-token");
    }
    expect(JSON.stringify(harness.activity)).not.toContain("EAAG-company-a-token");
  });
});
