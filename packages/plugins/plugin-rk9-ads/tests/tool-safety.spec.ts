/**
 * No agent tool can spend money (RK9-513). Every tool in the manifest is
 * driven against a fake Graph with valid and hostile parameters, and no write
 * may activate anything, touch a budget or cap, or create a campaign, ad set
 * or ad. The test enumerates manifest.tools, so a new tool is covered without
 * editing it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { creativesDeclarations } from "../src/features/creatives/declarations.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { brandConfig, PACKAGE_ROOT, SECRET_A_META } from "./fixtures.js";
import { FakeMediaAndGraph, type RecordedRequest } from "./helpers/fake-media.js";
import {
  EMBEDDED_PG_TIMEOUT_MS,
  describeEmbeddedPostgres,
  startPluginTestDatabase,
  type PluginTestDatabase,
} from "./helpers/embedded-pg.js";

const BUDGET_FIELDS = [
  "daily_budget",
  "lifetime_budget",
  "spend_cap",
  "spend_cap_action",
  "lifetime_spend_cap",
  "daily_spend_cap",
  "bid_amount",
  "bid_strategy",
  "budget_remaining",
  "daily_min_spend_target",
  "lifetime_min_spend_target",
];
const SPENDING_EDGE_RE = /\/act_\d+\/(campaigns|adsets|ads|copies|async_batch_requests)$|\/copies$/;

function forbiddenWrite(call: RecordedRequest): string | null {
  const path = new URL(call.url).pathname;
  if (SPENDING_EDGE_RE.test(path)) return `creates a spending object: ${path}`;
  for (const [key, value] of Object.entries(call.fields)) {
    if (/status/i.test(key) && /ACTIVE/i.test(value)) return `sets ${key}=${value} on ${path}`;
    if (BUDGET_FIELDS.includes(key)) return `changes ${key} on ${path}`;
  }
  if (/^\/v[\d.]+\/act_\d+$/.test(path)) return `writes the ad account itself: ${path}`;
  return null;
}

const MEDIA = "https://media.ololla.fi/safety.mp4";

/** Valid input, empty input and hostile input for every tool. */
const PARAM_SETS: Array<Record<string, unknown>> = [
  {},
  { status: "ACTIVE" },
  { since: "2026-10-01", until: "2026-10-07", adId: "120200000000001" },
  {
    manifest: {
      schemaVersion: "1",
      brand: "OLL",
      kind: "video",
      mediaUrl: MEDIA,
      sha256: "d".repeat(64),
      aspectRatio: "9:16",
      copy: { message: "Testi" },
      cta: "LEARN_MORE",
      landingUrlKey: "home",
      utmCampaign: "safety",
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      targetAdsetId: "120200000000002",
      idempotencyKey: "safety-video-1",
    },
  },
  { status: "ACTIVE", daily_budget: 100000, spend_cap: 0, adsetId: "120200000000002", adId: "120200000000001" },
  { manifest: { status: "ACTIVE", daily_budget: 100000 } },
];

const describeDb = await describeEmbeddedPostgres("tool safety");

describe("agent tool surface", () => {
  it("declares the four creative and read-only tools of the spec, and no tool that sounds like spending", () => {
    // rk9ads_get_pacing may move to the spend-guard feature (RK9-511); the surface stays these four plus other features' tools.
    const all = (manifest.tools ?? []).map((tool) => tool.name);
    for (const name of ["rk9ads_stage_creative", "rk9ads_list_ads", "rk9ads_get_insights", "rk9ads_get_pacing"]) {
      expect(all).toContain(name);
    }
    expect(creativesDeclarations.tools!.map((tool) => tool.name).every((name) => all.includes(name))).toBe(true);
    expect(all.filter((name) => /activ|resume|unpause|scale|budget|cap/i.test(name))).toEqual([]);
  });
});

describeDb("no agent tool writes anything that can spend (real Postgres, fake Graph)", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-tool-safety-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  it("drives every manifest tool and finds only safe writes", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ companies: [{ id: companyA, name: "Ololla" } as Company] });
    useCompanyConfigs(harness, { [companyA]: brandConfig() });
    useCompanySecrets(harness, { [companyA]: { [SECRET_A_META]: "EAAG-company-a-token" } });
    (harness.ctx as { db: unknown }).db = testDb.client;
    const fake = new FakeMediaAndGraph().head(MEDIA, { headers: { "content-type": "video/mp4", "content-length": "1000" } });
    harness.ctx.http.fetch = fake.fetch;
    await plugin.definition.setup(harness.ctx);

    const tools = manifest.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      for (const params of PARAM_SETS) {
        // Throws "No tool handler registered" if a declared tool has no handler.
        await harness.executeTool(tool.name, params, { companyId: companyA });
      }
    }

    const problems = fake.graphWrites.map(forbiddenWrite).filter((problem): problem is string => problem !== null);
    expect(problems).toEqual([]);
    // The stage tool did reach Graph, so the check above looked at real traffic.
    expect(fake.graphWrites.some((call) => call.url.endsWith("/advideos"))).toBe(true);
  });

  it("flags the writes it must catch (self-check of the detector)", () => {
    const write = (path: string, fields: Record<string, string>): RecordedRequest => ({
      url: `https://graph.facebook.com/v23.0/${path}`,
      method: "POST",
      fields,
    });
    expect(forbiddenWrite(write("120200000000001", { status: "ACTIVE" }))).not.toBeNull();
    expect(forbiddenWrite(write("120200000000002", { daily_budget: "500" }))).not.toBeNull();
    expect(forbiddenWrite(write("act_1", { spend_cap: "0" }))).not.toBeNull();
    expect(forbiddenWrite(write("act_1/campaigns", { status: "PAUSED" }))).not.toBeNull();
    expect(forbiddenWrite(write("act_1/adsets", { status: "PAUSED" }))).not.toBeNull();
    expect(forbiddenWrite(write("act_1/ads", { status: "PAUSED" }))).not.toBeNull();
    expect(forbiddenWrite(write("act_1/advideos", { file_url: MEDIA }))).toBeNull();
    expect(forbiddenWrite(write("120200000000001", { status: "PAUSED" }))).toBeNull();
  });
});
