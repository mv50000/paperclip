/**
 * The action `stage-creative` (RK9-910). A host-side run (rk9-motion host-run)
 * holds the company's agent key but no heartbeat run, so it cannot call the
 * tool `rk9ads_stage_creative`. The action runs the same `stageCreative()`:
 * the same checks, the same dry-run marker, the same idempotency. The company
 * and the initiator come from the host context, never from params.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { STAGE_CREATIVE_ACTION_KEY, STAGE_CREATIVE_TOOL } from "../src/features/creatives/register.js";
import type { StageResponseBody } from "../src/creative-manifest/ingress.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { brandConfig, PACKAGE_ROOT, SECRET_A_META, secretRef } from "./fixtures.js";
import { FakeMediaAndGraph } from "./helpers/fake-media.js";
import { EMBEDDED_PG_TIMEOUT_MS, describeEmbeddedPostgres, startPluginTestDatabase, type PluginTestDatabase } from "./helpers/embedded-pg.js";

const VIDEO_URL = "https://media.sunspot.fi/reels/valo-2.mp4";
const POSTER_URL = "https://media.sunspot.fi/reels/valo-2.jpg";
const AD_ACCOUNT = "act_1336862981968191";
const AGENT_ID = "agent-host-run";
const BOARD_USER = "board-user-1";

function videoManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    brand: "AUR",
    kind: "video",
    mediaUrl: VIDEO_URL,
    posterUrl: POSTER_URL,
    sha256: "e".repeat(64),
    aspectRatio: "9:16",
    copy: { message: "Aurinko palaa terassille", title: "Katso" },
    cta: "LEARN_MORE",
    landingUrlKey: "home",
    utmCampaign: "aur-valo-2026",
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    idempotencyKey: "aur-reel-valo-2",
    ...overrides,
  };
}

function sunspotConfig(stagingMode?: string): Record<string, unknown> {
  return brandConfig({
    brandCode: "AUR",
    meta: { adAccountId: AD_ACCOUNT, pageId: "1", accessTokenRef: secretRef(SECRET_A_META), ...(stagingMode ? { stagingMode } : {}) },
    landing: { allowedDomains: ["sunspot.fi"], urls: { home: "https://sunspot.fi/" } },
  });
}

interface ActionResult {
  status: number;
  body: StageResponseBody;
}

const describeDb = await describeEmbeddedPostgres("stage-creative action");

describeDb("action stage-creative (real Postgres)", () => {
  let testDb: PluginTestDatabase;
  let company: string;
  let otherCompany: string;
  let harness: TestHarness;
  let fake: FakeMediaAndGraph;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-stage-action-" });
    await testDb.applyMigrations();
    company = await testDb.createCompany("Sunspot (dev)");
    otherCompany = await testDb.createCompany("Ololla (dev)");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  async function setup(stagingMode = "dry_run") {
    harness = createTestHarness({ manifest });
    harness.seed({ companies: [{ id: company, name: "Sunspot (dev)" } as Company, { id: otherCompany, name: "Ololla (dev)" } as Company] });
    useCompanyConfigs(harness, { [company]: sunspotConfig(stagingMode) });
    useCompanySecrets(harness, { [company]: { [SECRET_A_META]: "EAAG-sunspot-dev-token" } });
    (harness.ctx as { db: unknown }).db = testDb.client;
    fake = new FakeMediaAndGraph()
      .head(VIDEO_URL, { headers: { "content-type": "video/mp4", "content-length": String(20 * 1024 * 1024) } })
      .head(POSTER_URL, { headers: { "content-type": "image/jpeg", "content-length": "200000" } });
    harness.ctx.http.fetch = fake.fetch;
    await plugin.definition.setup(harness.ctx);
  }

  beforeEach(async () => {
    await testDb.adminQuery(`DELETE FROM ${testDb.namespace}.creatives`);
  });

  const asAgent = (companyId: string) => ({ companyId, actor: { type: "agent" as const, agentId: AGENT_ID, companyId } });
  const asBoard = (companyId: string) => ({ companyId, actor: { type: "user" as const, userId: BOARD_USER, companyId } });

  const rows = (companyId?: string) =>
    companyId
      ? testDb.adminQuery<Record<string, unknown>>(`SELECT * FROM ${testDb.namespace}.creatives WHERE company_id = $1`, [companyId])
      : testDb.adminQuery<Record<string, unknown>>(`SELECT * FROM ${testDb.namespace}.creatives`);

  const stagedActivity = () => harness.activity.filter((entry) => entry.message === "rk9-ads creative staged");

  it("an agent key stages in its own company: the same body as the tool, the dry-run marker kept, the agent recorded", async () => {
    await setup("dry_run");
    const result = await harness.performAction<ActionResult>(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asAgent(company));
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ created: true, creative: { status: "staged", stagingMode: "dry_run", metaVideoId: null } });
    const stored = await rows(company);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.payload).toMatchObject({ stagingMode: "dry_run" });
    expect(fake.calls.filter((call) => new URL(call.url).hostname.endsWith("facebook.com"))).toEqual([]);
    expect(stagedActivity().map((entry) => entry.metadata?.initiator)).toEqual([
      { source: "agent", agentId: AGENT_ID, userId: null, runId: null },
    ]);

    // The tool answers the same creative for the same manifest.
    const tool = await harness.executeTool<{ data?: StageResponseBody }>(STAGE_CREATIVE_TOOL, { manifest: videoManifest() }, { companyId: company });
    expect(tool.data).toEqual({ created: false, creative: (result.body as { creative: unknown }).creative });
  });

  it("the same idempotency key does not make a second row", async () => {
    await setup("dry_run");
    const first = await harness.performAction<ActionResult>(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asAgent(company));
    const again = await harness.performAction<ActionResult>(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asAgent(company));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, creative: { id: (first.body as { creative: { id: string } }).creative.id } });
    expect(await rows()).toHaveLength(1);
    expect(stagedActivity()).toHaveLength(1);
  });

  it("a key reused for other media keeps the stage error code, path and creative", async () => {
    await setup("dry_run");
    await harness.performAction(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asAgent(company));
    const conflict = await harness.performAction<ActionResult>(
      STAGE_CREATIVE_ACTION_KEY,
      { manifest: videoManifest({ sha256: "f".repeat(64) }) },
      asAgent(company),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "idempotency_key_conflict", path: "/idempotencyKey" }, creative: { idempotencyKey: "aur-reel-valo-2" } });
    expect(await rows()).toHaveLength(1);
  });

  it("a board user stages too, and the board user is recorded", async () => {
    await setup("dry_run");
    const result = await harness.performAction<ActionResult>(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asBoard(company));
    expect(result.status).toBe(201);
    expect(await rows(company)).toHaveLength(1);
    expect(stagedActivity().map((entry) => entry.metadata?.initiator)).toEqual([
      { source: "board", agentId: null, userId: BOARD_USER, runId: null },
    ]);
  });

  it("a foreign params.companyId is refused and writes nothing", async () => {
    await setup("dry_run");
    // No host scope injection here: the context names one company, params another.
    await expect(
      harness.performAction(
        STAGE_CREATIVE_ACTION_KEY,
        { companyId: otherCompany, manifest: videoManifest() },
        { actor: { type: "agent", agentId: AGENT_ID, companyId: company } },
      ),
    ).rejects.toThrow(/invalid_request/);
    expect(await rows()).toEqual([]);
  });

  it("the host scope wins over a spoofed params.companyId: the row lands in the caller's company", async () => {
    await setup("dry_run");
    // The bridge writes the authorized company over params.companyId, as the host does.
    const result = await harness.performAction<ActionResult>(
      STAGE_CREATIVE_ACTION_KEY,
      { companyId: otherCompany, manifest: videoManifest() },
      asAgent(company),
    );
    expect(result.status).toBe(201);
    expect(await rows(company)).toHaveLength(1);
    expect(await rows(otherCompany)).toEqual([]);
  });

  it("another company's agent cannot reach this company's creative: its company has no brand config", async () => {
    await setup("dry_run");
    await harness.performAction(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asAgent(company));
    const foreign = await harness.performAction<ActionResult>(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, asAgent(otherCompany));
    expect(foreign.status).toBe(409);
    expect(foreign.body).toMatchObject({ error: { code: "plugin_not_enabled" } });
    expect(foreign.body).not.toHaveProperty("creative");
    expect(await rows(otherCompany)).toEqual([]);
  });

  it("refuses a call without company context", async () => {
    await setup("dry_run");
    await expect(
      harness.performAction(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, { actor: { type: "agent", agentId: AGENT_ID } }),
    ).rejects.toThrow(/company context is required/);
    expect(await rows()).toEqual([]);
  });

  it("refuses a system actor and an agent actor without an agent id", async () => {
    await setup("dry_run");
    await expect(
      harness.performAction(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, { companyId: company }),
    ).rejects.toThrow(/forbidden/);
    await expect(
      harness.performAction(STAGE_CREATIVE_ACTION_KEY, { manifest: videoManifest() }, { companyId: company, actor: { type: "agent", companyId: company } }),
    ).rejects.toThrow(/forbidden/);
    expect(await rows()).toEqual([]);
  });
});

describe("action stage-creative is registered", () => {
  it("next to the tool, under its own key", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.performAction(STAGE_CREATIVE_ACTION_KEY, {}, { companyId: "c-1" })).rejects.toThrow(/forbidden/);
  });
});
