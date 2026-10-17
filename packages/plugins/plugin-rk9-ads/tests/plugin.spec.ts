import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { SMOKE_ACTIVITY_MESSAGE } from "../src/features/smoke/register.js";
import { recordedOutput, useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import {
  brandConfig,
  COMPANY_A,
  COMPANY_B,
  COMPANY_UNCONFIGURED,
  SECRET_A_BOT,
  SECRET_A_META,
  SECRET_B_META,
  secretRef,
} from "./fixtures.js";

const META_TOKEN_A = "EAAG-company-a-meta-token-value";
const BOT_TOKEN_A = "123456:company-a-bot-token-value";
const META_TOKEN_B = "EAAG-company-b-meta-token-value";

function company(id: string, name: string): Company {
  return { id, name } as Company;
}

async function setupHarness(): Promise<TestHarness> {
  const harness = createTestHarness({ manifest });
  harness.seed({
    companies: [company(COMPANY_A, "Ololla"), company(COMPANY_B, "Sunspot"), company(COMPANY_UNCONFIGURED, "Other")],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("worker", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  it("is healthy with no config at all (empty config == off)", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(await plugin.definition.onValidateConfig!({})).toEqual({
      ok: true,
      warnings: ["Config is empty: the plugin stays off for this company."],
    });
  });

  it("reports config errors through onValidateConfig", async () => {
    const result = await plugin.definition.onValidateConfig!({ brandCode: "OLL" });
    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(await plugin.definition.onValidateConfig!(brandConfig())).toEqual({ ok: true });
  });

  it("registers a handler for every declared job, tool, route and webhook", async () => {
    for (const job of manifest.jobs ?? []) {
      if (job.jobKey === "smoke") continue;
      await expect(harness.runJob(job.jobKey)).resolves.toBeUndefined();
    }
    for (const tool of manifest.tools ?? []) {
      // A handler answers (a placeholder says "not implemented yet"); a missing one throws.
      const result = await harness.executeTool<{ error?: string; content?: string }>(tool.name, {});
      expect(result.error ?? result.content).toEqual(expect.any(String));
    }
    for (const route of manifest.apiRoutes ?? []) {
      const response = await plugin.definition.onApiRequest!({
        routeKey: route.routeKey,
        method: route.method,
        path: route.path,
        params: {},
        query: {},
        body: { companyId: COMPANY_A },
        actor: { actorType: "user", actorId: "user-1" },
        companyId: COMPANY_A,
        headers: {},
      });
      // 501 from a placeholder; an implemented route refuses a body without a manifest.
      expect([400, 501]).toContain(response.status);
    }
    // A webhook without verification fails the delivery instead of looking accepted.
    for (const webhook of manifest.webhooks ?? []) {
      await expect(
        plugin.definition.onWebhook!({ endpointKey: webhook.endpointKey, headers: {}, rawBody: "{}", requestId: "r1" }),
      ).rejects.toThrow(/not implemented yet|Telegram webhook rejected/);
    }
  });

  it("answers 404 for an unknown route", async () => {
    const response = await plugin.definition.onApiRequest!({
      routeKey: "nope",
      method: "GET",
      path: "/nope",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: "user-1" },
      companyId: COMPANY_A,
      headers: {},
    });
    expect(response.status).toBe(404);
  });
});

describe("smoke job", () => {
  it("reads two companies' configs, resolves each company's secrets and logs one activity per company", async () => {
    const harness = await setupHarness();
    useCompanyConfigs(harness, {
      [COMPANY_A]: brandConfig({
        telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-100123", allowedUserIds: ["42"] },
      }),
      [COMPANY_B]: brandConfig({
        brandCode: "AUR",
        meta: { adAccountId: "act_1336862981968191", pageId: "1216714361516949", accessTokenRef: secretRef(SECRET_B_META) },
        landing: { allowedDomains: ["sunspot.fi"], urls: { home: "https://sunspot.fi/" } },
      }),
    });
    const resolutions = useCompanySecrets(harness, {
      [COMPANY_A]: { [SECRET_A_META]: META_TOKEN_A, [SECRET_A_BOT]: BOT_TOKEN_A },
      [COMPANY_B]: { [SECRET_B_META]: META_TOKEN_B },
    });

    await harness.runJob("smoke", { trigger: "manual" });

    // Each company resolves only its own refs, always with its own companyId.
    expect(resolutions).toEqual([
      { companyId: COMPANY_A, secretId: SECRET_A_META, configPath: "meta.accessTokenRef", resolved: true },
      { companyId: COMPANY_A, secretId: SECRET_A_BOT, configPath: "telegram.botTokenRef", resolved: true },
      { companyId: COMPANY_B, secretId: SECRET_B_META, configPath: "meta.accessTokenRef", resolved: true },
    ]);

    const entries = harness.activity as Array<{ companyId?: string; message: string; metadata?: Record<string, unknown> }>;
    expect(entries.map((entry) => [entry.companyId, entry.message])).toEqual([
      [COMPANY_A, SMOKE_ACTIVITY_MESSAGE],
      [COMPANY_B, SMOKE_ACTIVITY_MESSAGE],
    ]);
    expect(entries[0]?.metadata).toMatchObject({
      configState: "enabled",
      brandCode: "OLL",
      timeZone: "Europe/Helsinki",
      refChecks: [
        { path: "meta.accessTokenRef", resolved: true },
        { path: "telegram.botTokenRef", resolved: true },
      ],
    });
    expect(entries[1]?.metadata).toMatchObject({ brandCode: "AUR", refChecks: [{ path: "meta.accessTokenRef", resolved: true }] });

    // The ledger read is scoped by each company's own id.
    expect(harness.dbQueries.map((query) => query.params?.[0])).toEqual([COMPANY_A, COMPANY_B]);
    for (const query of harness.dbQueries) expect(query.sql).toMatch(/WHERE company_id = \$1\b/);

    // The unconfigured company is "off", not a warning.
    expect(harness.logs.filter((log) => /unavailable/.test(log.message))).toEqual([]);

    // No secret value reaches logs, activity, metrics, telemetry or SQL.
    const output = recordedOutput(harness);
    for (const value of [META_TOKEN_A, BOT_TOKEN_A, META_TOKEN_B]) {
      expect(output).not.toContain(value);
    }
  });

  it("records an unresolved secret without failing the job or leaking anything", async () => {
    const harness = await setupHarness();
    useCompanyConfigs(harness, { [COMPANY_A]: brandConfig() });
    useCompanySecrets(harness, {});

    await harness.runJob("smoke", { trigger: "manual" });

    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]?.metadata).toMatchObject({
      refChecks: [{ path: "meta.accessTokenRef", resolved: false }],
    });
    expect(harness.logs.some((log) => log.level === "warn" && /did not resolve/.test(log.message))).toBe(true);
  });

  it("warns when a config read fails for another reason than a missing row", async () => {
    const harness = await setupHarness();
    harness.ctx.config.get = async () => {
      throw new Error("worker RPC timeout");
    };
    await harness.runJob("smoke", { trigger: "manual" });
    expect(harness.activity).toEqual([]);
    expect(harness.logs.filter((log) => log.level === "warn" && /config unavailable/.test(log.message))).toHaveLength(3);
  });

  it("warns for a configured company that the host refuses, and only for that one", async () => {
    // The host keeps its own list of configured companies; it can be stale after a failed refresh.
    const harness = await setupHarness();
    await plugin.definition.onConfigChanged?.(brandConfig(), { companyId: COMPANY_A });
    useCompanyConfigs(harness, {});

    await harness.runJob("smoke", { trigger: "manual" });

    const warnings = harness.logs.filter((log) => log.level === "warn" && /config unavailable/.test(log.message));
    expect(warnings.map((log) => log.meta?.companyId)).toEqual([COMPANY_A]);
    expect(harness.activity).toEqual([]);
  });

  it("remembers a company after a successful read", async () => {
    const harness = await setupHarness();
    useCompanyConfigs(harness, { [COMPANY_B]: brandConfig({ brandCode: "AUR" }) });
    useCompanySecrets(harness, {});
    await harness.runJob("smoke", { trigger: "manual" });

    useCompanyConfigs(harness, {});
    await harness.runJob("smoke", { trigger: "manual" });

    const warnings = harness.logs.filter((log) => log.level === "warn" && /config unavailable/.test(log.message));
    expect(warnings.map((log) => log.meta?.companyId)).toEqual([COMPANY_B]);
  });

  it("forgets a company whose config was saved empty", async () => {
    const harness = await setupHarness();
    await plugin.definition.onConfigChanged?.(brandConfig(), { companyId: COMPANY_A });
    await plugin.definition.onConfigChanged?.({}, { companyId: COMPANY_A });
    useCompanyConfigs(harness, {});

    await harness.runJob("smoke", { trigger: "manual" });

    expect(harness.logs.filter((log) => /unavailable/.test(log.message))).toEqual([]);
  });

  it("logs an invalid config without resolving its secrets", async () => {
    const harness = await setupHarness();
    useCompanyConfigs(harness, { [COMPANY_A]: { brandCode: "OLL" } });
    const resolutions = useCompanySecrets(harness, {});

    await harness.runJob("smoke", { trigger: "manual" });

    expect(resolutions).toEqual([]);
    expect(harness.activity[0]?.metadata).toMatchObject({ configState: "invalid" });
  });

  it("logs a disabled config (monthlyCapEur null) as disabled", async () => {
    const harness = await setupHarness();
    useCompanyConfigs(harness, { [COMPANY_A]: brandConfig({ monthlyCapEur: null }) });
    useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: META_TOKEN_A } });

    await harness.runJob("smoke", { trigger: "manual" });

    expect(harness.activity[0]?.metadata).toMatchObject({ configState: "disabled", brandCode: "OLL" });
  });
});
