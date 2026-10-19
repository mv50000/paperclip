/**
 * The publish feature through the SDK harness (A8, RK9-514): action and data
 * wiring, the company from the host context, and a slow upload that does not
 * block other calls.
 */

import { describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { memoryBindingStore } from "../../src/brand/provision.js";
import { createLedger } from "../../src/db.js";
import { PUBLICATION_DATA_KEY, PUBLISH_ACTION_KEY, registerPublish, SWAP_CREATIVE_ACTION_KEY } from "../../src/features/publish/register.js";
import { memoryOnceStore } from "../../src/features/spend-guard/support.js";
import type { FeatureRuntime } from "../../src/features/types.js";
import { useCompanyConfigs, useCompanySecrets } from "../../src/kit/testing/harness.js";
import manifest from "../../src/manifest.js";
import type { PublishOutcome, PublishPlan } from "../../src/publish/publish-service.js";
import { memoryCreativeSource, memoryPublicationStore } from "../../src/publish/store.js";
import { SECRET_A_META } from "../fixtures.js";
import { graphError, loadFixtureConfig } from "../brand/fake-routes.js";
import { ADSET, CAMPAIGN, COMPANY, CREATIVE_IMAGE, CREATIVE_VIDEO, imageCreative, META_TOKEN, NOW, publishRoutes, olollaConfig, videoCreative } from "./rig.js";

const OTHER = "22222222-2222-4222-8222-222222222222";
const UI = { companyId: COMPANY, actor: { type: "user" as const, userId: "user-1" } };
const AGENT = { companyId: COMPANY, actor: { type: "agent" as const, agentId: "agent-1", runId: "run-1" } };
const ACT = "act_29231592883113369";

function setup() {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY, name: "Ololla" } as Company, { id: OTHER, name: "Other" } as Company] });
  useCompanyConfigs(harness, { [COMPANY]: loadFixtureConfig("ololla") });
  useCompanySecrets(harness, { [COMPANY]: { [SECRET_A_META]: META_TOKEN } });
  const routes = publishRoutes(olollaConfig());
  harness.ctx.http.fetch = routes.fetch;
  const runtime: FeatureRuntime = {
    ctx: harness.ctx,
    ledger: createLedger(harness.ctx.db),
    handleWebhook() {},
    handleApiRoute() {},
    onConfigChanged() {},
    onShutdown() {},
  };
  const bindings = memoryBindingStore();
  bindings.rows.set(`${COMPANY}|OLL`, { campaignId: CAMPAIGN, adSetId: ADSET, adAccountId: "29231592883113369", source: "provisioned" });
  const store = memoryPublicationStore();
  const service = registerPublish(runtime, {
    store,
    creatives: memoryCreativeSource([imageCreative(), videoCreative()]),
    bindings,
    once: memoryOnceStore(),
    now: () => NOW,
    assertLaunchReady: null,
    video: { pollIntervalMs: 500, timeoutMs: 5_000 },
  });
  return { harness, routes, store, service };
}

describe("publish actions", () => {
  it("is a dry run by default and needs confirm: true for a real run", async () => {
    const { harness, routes } = setup();
    const plan = await harness.performAction<PublishPlan>(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE }, UI);
    expect(plan.dryRun).toBe(true);
    expect(plan.ad.body).toMatchObject({ status: "PAUSED" });
    expect(routes.calls).toEqual([]);
    // The real host adds renderEnvironment (null outside a launcher) to the params.
    const hosted = await harness.performAction<PublishPlan>(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE, renderEnvironment: null }, UI);
    expect(hosted.dryRun).toBe(true);
    await expect(harness.performAction(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE, dryRun: false }, UI)).rejects.toThrow(/confirm: true/);
    await expect(harness.performAction(PUBLISH_ACTION_KEY, { creativeId: "nope" }, UI)).rejects.toThrow(/invalid_request: creativeId/);
    await expect(harness.performAction(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE, status: "ACTIVE" }, UI)).rejects.toThrow(/invalid_request/);
  });

  it("an agent may publish a new PAUSED ad, but a real creative swap is board-only (RK9-540)", async () => {
    const { harness, routes, service } = setup();
    const outcome = await harness.performAction<PublishOutcome>(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE, dryRun: false, confirm: true }, AGENT);
    await service.settled();
    expect(outcome.started).toBe(true);
    const calls = routes.calls.length;
    await expect(
      harness.performAction(SWAP_CREATIVE_ACTION_KEY, { creativeId: CREATIVE_IMAGE, adId: "5001", dryRun: false, confirm: true }, AGENT),
    ).rejects.toThrow(/board_only: a real creative swap is board-only/);
    expect(routes.calls.length).toBe(calls);
  });

  it("takes the company from the host context: another company sees neither the config nor the creative", async () => {
    const { harness } = setup();
    await expect(harness.performAction(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE }, { ...UI, companyId: OTHER })).rejects.toThrow(/plugin_not_enabled/);
  });

  it("a real publish shows Meta's 2859024 as one line in the action result and in the publication", async () => {
    const { harness, routes, service } = setup();
    routes.on(`POST ${ACT}/ads`, graphError(100, "Invalid parameter", 2859024));
    const outcome = await harness.performAction<PublishOutcome>(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE, dryRun: false, confirm: true }, UI);
    expect(outcome.publication.status).toBe("failed");
    expect(outcome.publication.error).toMatch(/^Meta refused the request: the ad account has not accepted Meta's policy terms \(code 100, subcode 2859024\)\. Fix: /);
    expect(outcome.publication.error).not.toContain("\n");
    expect(JSON.stringify(outcome)).not.toContain(META_TOKEN);
    const data = await harness.getData<{ state: string; publication: { error: string } }>(PUBLICATION_DATA_KEY, { companyId: COMPANY, publicationId: outcome.publication.id });
    expect(data).toMatchObject({ state: "ok", publication: { error: outcome.publication.error } });
    expect(await harness.getData(PUBLICATION_DATA_KEY, { companyId: OTHER, publicationId: outcome.publication.id })).toEqual({ state: "not_found" });
    await service.settled();
  });

  it("a slow upload does not block other calls: the action returns pending and data and a dry run answer at once", async () => {
    const { harness, routes, service } = setup();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const fetch = routes.fetch;
    harness.ctx.http.fetch = async (url, init) => {
      if (String(url).includes("/advideos")) await slow;
      return fetch(url, init);
    };
    const started = Date.now();
    const outcome = await harness.performAction<PublishOutcome>(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_VIDEO, dryRun: false, confirm: true, waitMs: 0 }, UI);
    expect(outcome).toMatchObject({ started: true, publication: { status: "pending" } });
    const [data, plan] = await Promise.all([
      harness.getData<{ publication: { status: string } }>(PUBLICATION_DATA_KEY, { companyId: COMPANY, publicationId: outcome.publication.id }),
      harness.performAction<PublishPlan>(PUBLISH_ACTION_KEY, { creativeId: CREATIVE_IMAGE }, UI),
    ]);
    expect(data.publication.status).toBe("pending");
    expect(plan.dryRun).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(service.isRunning(outcome.publication.id)).toBe(true);

    release();
    await service.settled();
    const done = await harness.getData<{ publication: { status: string; metaAdId: string } }>(PUBLICATION_DATA_KEY, { companyId: COMPANY, publicationId: outcome.publication.id });
    expect(done.publication).toMatchObject({ status: "published", metaAdId: "5001" });
  });
});
