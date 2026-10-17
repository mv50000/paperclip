import { describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PreflightResult } from "../../src/brand/preflight.js";
import { memoryBindingStore, type ProvisionResult } from "../../src/brand/provision.js";
import { createLedger } from "../../src/db.js";
import { PREFLIGHT_STATUS_DATA_KEY, PROVISION_ACTION_KEY, registerBrand, VERIFY_CONNECTION_ACTION_KEY } from "../../src/features/brand/register.js";
import { memoryOnceStore } from "../../src/features/spend-guard/support.js";
import type { FeatureRuntime } from "../../src/features/types.js";
import { recordedOutput, useCompanyConfigs, useCompanySecrets } from "../../src/kit/testing/harness.js";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";
import { SECRET_A_BOT, SECRET_A_META } from "../fixtures.js";
import { BOT_TOKEN, COMPANY, draftConfig, happyRoutes, loadFixtureConfig, META_TOKEN, NOW, type FakeRoutes } from "./fake-routes.js";

const OTHER = "22222222-2222-4222-8222-222222222222";
const UI = { companyId: COMPANY, actor: { type: "user" as const, userId: "user-1" } };

function setup(raw: Record<string, unknown> = loadFixtureConfig("ololla"), routes?: FakeRoutes) {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY, name: "Ololla" } as Company, { id: OTHER, name: "Other" } as Company] });
  useCompanyConfigs(harness, { [COMPANY]: raw });
  const secrets = useCompanySecrets(harness, {
    [COMPANY]: { [SECRET_A_META]: META_TOKEN, [SECRET_A_BOT]: BOT_TOKEN },
  });
  const fake = routes ?? happyRoutes(draftConfig(raw));
  harness.ctx.http.fetch = fake.fetch;
  const runtime: FeatureRuntime = {
    ctx: harness.ctx,
    ledger: createLedger(harness.ctx.db),
    handleWebhook() {},
    handleApiRoute() {},
    onConfigChanged() {},
    onShutdown() {},
  };
  registerBrand(runtime, { store: memoryOnceStore(), bindings: memoryBindingStore(), now: () => NOW });
  return { harness, routes: fake, secrets };
}

describe("brand actions", () => {
  it("verify-connection resolves the company's secrets and returns one result per check", async () => {
    const { harness, routes, secrets } = setup();
    const result = await harness.performAction<PreflightResult>(VERIFY_CONNECTION_ACTION_KEY, {}, UI);
    expect(result.launchReady).toBe(true);
    expect(result.checks).toHaveLength(7);
    // Meta token as a Bearer header only, never in a URL.
    const graphCalls = routes.calls.filter((call) => !call.key.startsWith("tg:"));
    expect(graphCalls.every((call) => call.headers.Authorization === `Bearer ${META_TOKEN}` && !call.url.includes(META_TOKEN))).toBe(true);
    expect(secrets.every((entry) => entry.companyId === COMPANY)).toBe(true);
    expect(new Set(secrets.map((entry) => entry.configPath))).toEqual(new Set(["meta.accessTokenRef", "telegram.botTokenRef"]));
    const output = JSON.stringify({ result, recorded: recordedOutput(harness) });
    expect(output).not.toContain(META_TOKEN);
    expect(output).not.toContain(BOT_TOKEN);
  });

  it("verify-connection refuses a company without a config", async () => {
    const { harness } = setup();
    await expect(harness.performAction(VERIFY_CONNECTION_ACTION_KEY, {}, { ...UI, companyId: OTHER })).rejects.toThrow(/not configured/);
  });

  it("preflight-status serves the cached result and freshness without calling Meta", async () => {
    const { harness, routes } = setup();
    expect(await harness.getData(PREFLIGHT_STATUS_DATA_KEY, { companyId: COMPANY })).toMatchObject({ state: "enabled", fresh: false, result: null });
    await harness.performAction(VERIFY_CONNECTION_ACTION_KEY, {}, UI);
    const calls = routes.calls.length;
    const status = await harness.getData<{ fresh: boolean; result: PreflightResult }>(PREFLIGHT_STATUS_DATA_KEY, { companyId: COMPANY });
    expect(status.fresh).toBe(true);
    expect(status.result.launchReady).toBe(true);
    expect(routes.calls.length).toBe(calls);
  });

  it("provision is a dry run unless confirm: true is given", async () => {
    const { harness, routes } = setup();
    routes.on("GET act_29231592883113369/campaigns", { body: { data: [] } });
    const preview = await harness.performAction<ProvisionResult>(PROVISION_ACTION_KEY, {}, UI);
    expect(preview.dryRun).toBe(true);
    expect(preview.plannedCalls).toHaveLength(2);
    expect(routes.writes()).toEqual([]);
    await expect(harness.performAction(PROVISION_ACTION_KEY, { dryRun: false }, UI)).rejects.toThrow(/confirm: true/);
    await expect(harness.performAction(PROVISION_ACTION_KEY, { dailyBudgetCents: 1000 }, UI)).rejects.toThrow(/budget_above_cap/);
  });

  it("a real provision is board-only: an agent may only preview it (RK9-538)", async () => {
    const { harness, routes } = setup();
    routes.on("GET act_29231592883113369/campaigns", { body: { data: [] } });
    const agent = { companyId: COMPANY, actor: { type: "agent" as const, agentId: "agent-1" } };
    const preview = await harness.performAction<ProvisionResult>(PROVISION_ACTION_KEY, {}, agent);
    expect(preview.dryRun).toBe(true);
    await expect(harness.performAction(PROVISION_ACTION_KEY, { dryRun: false, confirm: true }, agent)).rejects.toThrow(/board-only/);
    expect(routes.writes()).toEqual([]);
  });

  it("provision refuses a disabled brand", async () => {
    const raw = { ...loadFixtureConfig("ololla"), monthlyCapEur: null };
    const { harness, routes } = setup(raw);
    await expect(harness.performAction(PROVISION_ACTION_KEY, {}, UI)).rejects.toThrow(/disabled: set monthlyCapEur/);
    expect(routes.calls).toEqual([]);
    // The preflight still runs for a disabled brand, and says why it is not launch-ready.
    const result = await harness.performAction<PreflightResult>(VERIFY_CONNECTION_ACTION_KEY, {}, UI);
    expect(result.launchReady).toBe(false);
  });
});

describe("worker config validation", () => {
  it("accepts monthlyCapEur null with a disabled warning", async () => {
    expect(await plugin.definition.onValidateConfig!({ ...loadFixtureConfig("ololla"), monthlyCapEur: null })).toEqual({
      ok: true,
      warnings: ["monthlyCapEur is not set: the brand stays disabled until it is"],
    });
  });

  it("passes the host's save-time schema check with monthlyCapEur null or absent", async () => {
    const validator = (await import(/* @vite-ignore */ new URL("../../../../../server/src/services/plugin-config-validator.ts", import.meta.url).href)) as {
      validateInstanceConfig(config: Record<string, unknown>, schema: unknown): { valid: boolean };
    };
    const raw = loadFixtureConfig("ololla");
    expect(validator.validateInstanceConfig(raw, manifest.instanceConfigSchema).valid).toBe(true);
    expect(validator.validateInstanceConfig({ ...raw, monthlyCapEur: null }, manifest.instanceConfigSchema).valid).toBe(true);
    expect(validator.validateInstanceConfig({ ...raw, monthlyCapEur: 0 }, manifest.instanceConfigSchema).valid).toBe(false);
  });
});
