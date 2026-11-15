/**
 * Dry-run creative staging (RK9-849). With `meta.stagingMode: "dry_run"` the
 * ingress runs every check (manifest, brand config, media HEAD, sha dedupe)
 * but sends no Meta call: no upload, no read, no token resolution. The row is
 * marked as a dry run, and the SQL creative source reports the marker to the
 * publish, activation and organic paths. Staging the same media in live mode
 * stages it anew and clears the marker. The default stays live.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { createLedger } from "../src/db.js";
import { STAGE_CREATIVE_ROUTE, STAGE_CREATIVE_TOOL } from "../src/features/creatives/register.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { sqlCreativeSource } from "../src/publish/store.js";
import { brandConfig, PACKAGE_ROOT, SECRET_A_META, secretRef } from "./fixtures.js";
import { FakeMediaAndGraph } from "./helpers/fake-media.js";
import { EMBEDDED_PG_TIMEOUT_MS, describeEmbeddedPostgres, startPluginTestDatabase, type PluginTestDatabase } from "./helpers/embedded-pg.js";

const VIDEO_URL = "https://media.sunspot.fi/reels/valo-1.mp4";
const POSTER_URL = "https://media.sunspot.fi/reels/valo-1.jpg";
const IMAGE_URL = "https://media.sunspot.fi/images/terassi.png";
const SHA_VIDEO = "c".repeat(64);
const SHA_IMAGE = "d".repeat(64);
const AD_ACCOUNT = "act_1336862981968191";

function videoManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    brand: "AUR",
    kind: "video",
    mediaUrl: VIDEO_URL,
    posterUrl: POSTER_URL,
    sha256: SHA_VIDEO,
    aspectRatio: "9:16",
    copy: { message: "Aurinko palaa terassille", title: "Katso" },
    cta: "LEARN_MORE",
    landingUrlKey: "home",
    utmCampaign: "aur-valo-2026",
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    idempotencyKey: "aur-reel-valo-1",
    ...overrides,
  };
}

function imageManifest(): Record<string, unknown> {
  const { posterUrl: _poster, ...base } = videoManifest();
  return { ...base, kind: "image", mediaUrl: IMAGE_URL, sha256: SHA_IMAGE, aspectRatio: "1:1", idempotencyKey: "aur-image-terassi" };
}

function sunspotConfig(stagingMode?: string, extraMeta: Record<string, unknown> = {}): Record<string, unknown> {
  return brandConfig({
    brandCode: "AUR",
    meta: { adAccountId: AD_ACCOUNT, pageId: "1", accessTokenRef: secretRef(SECRET_A_META), ...(stagingMode ? { stagingMode } : {}), ...extraMeta },
    landing: { allowedDomains: ["sunspot.fi"], urls: { home: "https://sunspot.fi/" } },
  });
}

const describeDb = await describeEmbeddedPostgres("dry-run staging");

describeDb("dry-run creative staging (real Postgres)", () => {
  let testDb: PluginTestDatabase;
  let company: string;
  let harness: TestHarness;
  let fake: FakeMediaAndGraph;
  let secretResolves: number;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-dryrun-" });
    await testDb.applyMigrations();
    company = await testDb.createCompany("Sunspot (dev)");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  type DbClient = PluginTestDatabase["client"];

  async function setup(stagingMode?: string, withSecret = true, options: { extraMeta?: Record<string, unknown>; db?: (client: DbClient) => DbClient } = {}) {
    harness = createTestHarness({ manifest });
    harness.seed({ companies: [{ id: company, name: "Sunspot (dev)" } as Company] });
    useCompanyConfigs(harness, { [company]: sunspotConfig(stagingMode, options.extraMeta) });
    useCompanySecrets(harness, withSecret ? { [company]: { [SECRET_A_META]: "EAAG-sunspot-dev-token" } } : { [company]: {} });
    const resolve = harness.ctx.secrets.resolve.bind(harness.ctx.secrets);
    secretResolves = 0;
    harness.ctx.secrets.resolve = async (...args: Parameters<typeof resolve>) => {
      secretResolves += 1;
      return resolve(...args);
    };
    (harness.ctx as { db: unknown }).db = options.db ? options.db(testDb.client) : testDb.client;
    fake = new FakeMediaAndGraph()
      .head(VIDEO_URL, { headers: { "content-type": "video/mp4", "content-length": String(20 * 1024 * 1024) } })
      .head(POSTER_URL, { headers: { "content-type": "image/jpeg", "content-length": "200000" } })
      .head(IMAGE_URL, { headers: { "content-type": "image/png", "content-length": "500000" } });
    harness.ctx.http.fetch = fake.fetch;
    await plugin.definition.setup(harness.ctx);
  }

  beforeEach(async () => {
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.creatives`);
  });

  const graphCalls = () => fake.calls.filter((call) => new URL(call.url).hostname.endsWith("facebook.com"));

  async function viaRoute(input: unknown) {
    return plugin.definition.onApiRequest!({
      routeKey: STAGE_CREATIVE_ROUTE,
      method: "POST",
      path: "/creatives",
      params: {},
      query: {},
      body: { companyId: company, manifest: input },
      actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1" },
      companyId: company,
      headers: {},
    });
  }

  async function row() {
    const [first] = await testDb.adminQuery<Record<string, unknown>>(`SELECT * FROM ${testDb.namespace}.creatives WHERE company_id = $1`, [company]);
    return first!;
  }

  it("dry_run stages a video as staged with the planned upload, and sends no Meta call and resolves no token", async () => {
    await setup("dry_run", false);
    const response = await viaRoute(videoManifest());
    expect(response.status).toBe(201);
    const { creative } = response.body as { creative: Record<string, unknown> };
    expect(creative).toMatchObject({ status: "staged", stagingMode: "dry_run", metaVideoId: null, error: null });
    expect(creative.plannedCalls).toEqual([
      { method: "POST", path: `${AD_ACCOUNT}/advideos`, fields: expect.objectContaining({ file_url: VIDEO_URL }) },
    ]);
    // Every check still ran: one HEAD per URL.
    expect(fake.mediaCalls.map((call) => `${call.method} ${call.url}`)).toEqual([`HEAD ${VIDEO_URL}`, `HEAD ${POSTER_URL}`]);
    expect(graphCalls()).toEqual([]);
    expect(secretResolves).toBe(0);

    const stored = await row();
    expect(stored).toMatchObject({ status: "staged", meta_video_id: null });
    expect(stored.payload).toMatchObject({ schemaVersion: "1", stagingMode: "dry_run" });
    expect(harness.activity.some((entry) => entry.message === "rk9-ads creative dry-run upload")).toBe(true);

    const source = await sqlCreativeSource(createLedger(testDb.client)).get(company, String(stored.id));
    expect(source?.stagingDryRun).toBe(true);
  });

  it("dry_run still refuses what live refuses: a bad media type, an unknown landing key", async () => {
    await setup("dry_run");
    fake.head(VIDEO_URL, { headers: { "content-type": "text/html" } });
    expect((await viaRoute(videoManifest())).status).toBe(422);
    expect((await viaRoute(videoManifest({ landingUrlKey: "nope" }))).status).toBe(422);
    expect(graphCalls()).toEqual([]);
    expect(await testDb.adminQuery(`SELECT 1 FROM ${testDb.namespace}.creatives`)).toEqual([]);
  });

  it("dry_run marks an image too, with no Meta call", async () => {
    await setup("dry_run");
    const result = await harness.executeTool<{ data?: { creative: Record<string, unknown> } }>(STAGE_CREATIVE_TOOL, { manifest: imageManifest() }, { companyId: company });
    expect(result.data?.creative).toMatchObject({ kind: "image", status: "ready", stagingMode: "dry_run" });
    expect(graphCalls()).toEqual([]);
    const source = await sqlCreativeSource(createLedger(testDb.client)).get(company, String((await row()).id));
    expect(source?.stagingDryRun).toBe(true);
  });

  it("a repeated dry-run stage stays a dry run and still makes no Meta call", async () => {
    await setup("dry_run");
    await viaRoute(videoManifest());
    const again = await viaRoute(videoManifest());
    expect(again.status).toBe(200);
    expect((again.body as { creative: Record<string, unknown> }).creative).toMatchObject({ status: "staged", stagingMode: "dry_run" });
    expect(graphCalls()).toEqual([]);
  });

  it("the default (no stagingMode) is live: one advideos upload and no marker", async () => {
    await setup();
    const response = await viaRoute(videoManifest());
    expect(response.status).toBe(201);
    expect((response.body as { creative: Record<string, unknown> }).creative).toMatchObject({ status: "uploading", stagingMode: "live" });
    expect(graphCalls().map((call) => `${call.method} ${new URL(call.url).pathname.split("/").slice(2).join("/")}`)).toEqual([`POST ${AD_ACCOUNT}/advideos`]);
    expect((await row()).payload).toEqual({ schemaVersion: "1" });
  });

  it("staging a dry-run creative again in live mode stages it anew: the video uploads and the marker is gone", async () => {
    await setup("dry_run");
    const first = await viaRoute(videoManifest());
    const id = (first.body as { creative: { id: string } }).creative.id;

    await setup("live");
    const live = await viaRoute(videoManifest());
    expect(live.status).toBe(200);
    expect((live.body as { creative: Record<string, unknown> }).creative).toMatchObject({ id, status: "uploading", stagingMode: "live" });
    expect(graphCalls().filter((call) => call.method === "POST")).toHaveLength(1);
    const stored = await row();
    expect(stored.payload).toEqual({ schemaVersion: "1" });
    expect(stored.meta_video_id).toBeTruthy();
    expect((await sqlCreativeSource(createLedger(testDb.client)).get(company, id))?.stagingDryRun).toBe(false);
    expect(harness.activity.some((entry) => entry.message === "rk9-ads creative restaged")).toBe(true);
  });
  // RK9-853: the rows a dry-run stage meets after a live one.
  async function liveRowAs(status: string, extraSql = "") {
    await setup("live");
    const first = await viaRoute(videoManifest());
    const id = (first.body as { creative: { id: string } }).creative.id;
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET status = $2, meta_video_id = NULL${extraSql} WHERE id = $1`, [id, status]);
    return id;
  }

  for (const status of ["expired", "rejected"]) {
    it(`a dry-run stage of an ${status} live row restages it as a dry run, with no Meta call`, async () => {
      const id = await liveRowAs(status);
      await setup("dry_run", false);
      const response = await viaRoute(videoManifest());
      expect(response.status).toBe(200);
      expect((response.body as { creative: Record<string, unknown> }).creative).toMatchObject({ id, status: "staged", stagingMode: "dry_run", metaVideoId: null });
      expect(graphCalls()).toEqual([]);
      expect(secretResolves).toBe(0);
      expect((await sqlCreativeSource(createLedger(testDb.client)).get(company, id))?.stagingDryRun).toBe(true);
    });
  }

  it("a dry-run stage of a live failed row without a video id marks it and sends no Meta call", async () => {
    const id = await liveRowAs("failed");
    await setup("dry_run", false);
    const response = await viaRoute(videoManifest());
    expect(response.status).toBe(200);
    expect((response.body as { creative: Record<string, unknown> }).creative).toMatchObject({ id, status: "staged", stagingMode: "dry_run" });
    expect(graphCalls()).toEqual([]);
    expect((await row()).payload).toMatchObject({ stagingMode: "dry_run", plannedCalls: [expect.objectContaining({ path: `${AD_ACCOUNT}/advideos` })] });
  });

  it("a dry-run stage claims a stale live upload, marks it and sends no Meta call", async () => {
    const id = await liveRowAs("uploading", ", updated_at = now() - interval '30 minutes'");
    await setup("dry_run", false);
    const response = await viaRoute(videoManifest());
    expect(response.status).toBe(200);
    expect((response.body as { creative: Record<string, unknown> }).creative).toMatchObject({ id, status: "staged", stagingMode: "dry_run" });
    expect(graphCalls()).toEqual([]);
    expect((await sqlCreativeSource(createLedger(testDb.client)).get(company, id))?.stagingDryRun).toBe(true);
  });

  it("a dry run that dies after the claim leaves the row marked: the marker is in the claim write", async () => {
    const id = await liveRowAs("failed");
    // The worker dies at the write after the dry-run client answered (status back to
    // staged with the planned calls): that write and every later one never happen.
    let dead = false;
    await setup("dry_run", false, {
      db: (client) => ({
        ...client,
        execute: async (statement: string, params?: unknown[]) => {
          if (/UPDATE/.test(statement) && (params ?? []).some((param) => typeof param === "string" && param.includes("plannedCalls"))) dead = true;
          if (dead) throw new Error("worker died");
          return client.execute(statement, params);
        },
      }),
    });
    await viaRoute(videoManifest()).catch(() => undefined);
    const stored = await row();
    expect(stored.status).toBe("uploading");
    expect(stored.payload).toMatchObject({ stagingMode: "dry_run" });
    expect((await sqlCreativeSource(createLedger(testDb.client)).get(company, id))?.stagingDryRun).toBe(true);
    expect(graphCalls()).toEqual([]);
  });

  it("dryRunMediaCheck skip stages a dry run with no HEAD and says so on the creative", async () => {
    await setup("dry_run", false, { extraMeta: { dryRunMediaCheck: "skip" } });
    const response = await viaRoute(videoManifest({ mediaUrl: "https://media.unreachable.example/a.mp4", posterUrl: undefined }));
    expect(response.status).toBe(201);
    expect((response.body as { creative: Record<string, unknown> }).creative).toMatchObject({ status: "staged", stagingMode: "dry_run", mediaCheck: "skipped" });
    expect(fake.mediaCalls).toEqual([]);
    expect(graphCalls()).toEqual([]);
    expect((await row()).payload).toMatchObject({ stagingMode: "dry_run", mediaCheck: "skipped" });
  });

  it("dryRunMediaCheck head keeps both HEADs in a dry run", async () => {
    await setup("dry_run", false, { extraMeta: { dryRunMediaCheck: "head" } });
    const response = await viaRoute(videoManifest());
    expect(response.status).toBe(201);
    expect((response.body as { creative: Record<string, unknown> }).creative).not.toHaveProperty("mediaCheck");
    expect(fake.mediaCalls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
  });

  it("legacy payloads: a JSON null is live, a JSON string is parsed (the marker inside counts)", async () => {
    const id = await liveRowAs("staged");
    const source = sqlCreativeSource(createLedger(testDb.client));
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET payload = 'null'::jsonb WHERE id = $1`, [id]);
    expect((await source.get(company, id))?.stagingDryRun).toBe(false);
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET payload = to_jsonb($2::text) WHERE id = $1`, [id, JSON.stringify({ stagingMode: "dry_run" })]);
    expect((await source.get(company, id))?.stagingDryRun).toBe(true);
    await testDb.adminQuery(`UPDATE ${testDb.namespace}.creatives SET payload = to_jsonb('not json'::text) WHERE id = $1`, [id]);
    expect((await source.get(company, id))?.stagingDryRun).toBe(false);
  });
});
