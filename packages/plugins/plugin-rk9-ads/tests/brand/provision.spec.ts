import { describe, expect, it } from "vitest";
import { runPreflight } from "../../src/brand/preflight.js";
import {
  adSetFields,
  campaignFields,
  maxDailyBudgetCents,
  memoryBindingStore,
  provision,
  ProvisionError,
  provisionNames,
  type BindingStore,
  type ProvisionDeps,
  type ProvisionInput,
} from "../../src/brand/provision.js";
import type { BrandConfig } from "../../src/config.js";
import { createSpendGuardHook, unmodelledBudgetKeys } from "../../src/features/spend-guard/guard.js";
import type { MetaClientMode } from "../../src/meta/graph.js";
import { COMPANY, enabledConfig, graphError, happyRoutes, loadFixtureConfig, metaClient, NOW, rig, type FakeRoutes } from "./fake-routes.js";

const ACT = "act_29231592883113369";
const CAMPAIGN = "120000000000000001";
const ADSET = "120000000000000002";

function ollola(overrides: Record<string, unknown> = {}): BrandConfig {
  return enabledConfig({ ...loadFixtureConfig("ololla"), ...overrides });
}

/** Graph routes for provisioning on top of the preflight's happy routes: an empty account that accepts creates. */
function provisionRoutes(config: BrandConfig, state: { campaigns: Array<Record<string, unknown>>; adsets: Array<Record<string, unknown>> }) {
  const routes = happyRoutes(config);
  let nextId = 1;
  routes
    .on(`GET ${ACT}/campaigns`, () => ({ body: { data: state.campaigns } }))
    .on(`GET ${ACT}/adsets`, () => ({ body: { data: state.adsets } }))
    .on(`POST ${ACT}/campaigns`, (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      const id = `1200000000000000${String(nextId++).padStart(2, "0")}`;
      state.campaigns.push({ id, name: body.get("name"), status: body.get("status"), effective_status: body.get("status") });
      return { body: { id } };
    })
    .on(`POST ${ACT}/adsets`, (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      const id = `1200000000000000${String(nextId++).padStart(2, "0")}`;
      state.adsets.push({
        id,
        name: body.get("name"),
        status: body.get("status"),
        effective_status: body.get("status"),
        campaign_id: body.get("campaign_id"),
        daily_budget: body.get("daily_budget"),
      });
      return { body: { id } };
    });
  // Single-object reads answer from the state.
  const node = (id: string) => {
    const campaign = state.campaigns.find((row) => row.id === id);
    if (campaign) return { body: { ...campaign, account_id: "29231592883113369", objective: "OUTCOME_TRAFFIC" } };
    const adset = state.adsets.find((row) => row.id === id);
    if (adset) return { body: { ...adset, account_id: "29231592883113369" } };
    return graphError(100, "Unsupported get request. Object does not exist");
  };
  for (let n = 1; n < 10; n += 1) {
    const id = `1200000000000000${String(n).padStart(2, "0")}`;
    routes.on(`GET ${id}`, () => node(id));
  }
  return routes;
}

function setup(config: BrandConfig, options: { bindings?: BindingStore; state?: { campaigns: Array<Record<string, unknown>>; adsets: Array<Record<string, unknown>> } } = {}) {
  const r = rig();
  const state = options.state ?? { campaigns: [], adsets: [] };
  const routes = provisionRoutes(config, state);
  const bindings = options.bindings ?? memoryBindingStore();
  const preflightDeps = { ctx: r.harness.ctx, store: r.store, pluginId: "rk9-ads", now: () => NOW, metaClient: () => metaClient(routes), telegram: { fetch: routes.fetch } };
  const readClient = metaClient(routes);
  let launchChecks = 0;
  const depsFor = (mode: MetaClientMode): ProvisionDeps => ({
    ctx: r.harness.ctx,
    bindings,
    now: () => NOW,
    readClient,
    // The real write path: the spend guard hook in front of the client, as brandClient wires it.
    writeClient: metaClient(routes, { mode, guardedWrite: createSpendGuardHook({ config, readClient }) }),
    assertLaunchReady: async () => {
      launchChecks += 1;
      const result = await runPreflight(preflightDeps, COMPANY, config);
      if (!result.launchReady) throw new Error("not launch-ready");
      return result;
    },
  });
  const run = (input: Partial<ProvisionInput> = {}) =>
    provision(depsFor(input.dryRun ? "dryRun" : "live"), COMPANY, config, { dryRun: false, initiator: { source: "ui", userId: "user-1" }, ...input });
  return { r, routes, state, bindings, run, launchChecks: () => launchChecks };
}

function bodyOf(routes: FakeRoutes, key: string) {
  const call = routes.calls.find((entry) => entry.key === key);
  return call ? Object.fromEntries(new URLSearchParams(call.body)) : null;
}

describe("provision", () => {
  it("first run creates one PAUSED OUTCOME_TRAFFIC campaign and one PAUSED ad set at the G3 budget", async () => {
    const config = ollola();
    const { routes, run, r, bindings, launchChecks } = setup(config);
    const result = await run();
    expect(result.creates).toBe(2);
    expect(result.campaign).toMatchObject({ name: "OLL-traffic", action: "created", status: "PAUSED" });
    expect(result.adSet).toMatchObject({ name: "OLL-traffic", action: "created", dailyBudgetCents: 322 });
    expect(launchChecks()).toBe(1);

    const writes = routes.writes().map((call) => call.key);
    expect(writes).toEqual([`POST ${ACT}/campaigns`, `POST ${ACT}/adsets`]);
    const campaign = bodyOf(routes, `POST ${ACT}/campaigns`)!;
    expect(campaign).toMatchObject({
      name: "OLL-traffic",
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
      special_ad_categories: '["NONE"]',
      is_adset_budget_sharing_enabled: "false",
    });
    const adset = bodyOf(routes, `POST ${ACT}/adsets`)!;
    expect(adset).toMatchObject({
      name: "OLL-traffic",
      status: "PAUSED",
      campaign_id: result.campaign.id,
      daily_budget: "322",
      billing_event: "IMPRESSIONS",
      optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    expect(JSON.parse(adset.targeting!)).toEqual({ geo_locations: { countries: ["FI"] }, age_min: 18, targeting_automation: { advantage_audience: 0 } });

    expect(r.harness.activity.map((entry) => entry.message).filter((message) => message.startsWith("rk9-ads provision"))).toEqual([
      `rk9-ads provision: created campaign ${result.campaign.id} (PAUSED)`,
      `rk9-ads provision: created adset ${result.adSet.id} (PAUSED)`,
    ]);
    expect(await bindings.get(COMPANY, "OLL")).toEqual({ campaignId: result.campaign.id, adSetId: result.adSet.id, adAccountId: "29231592883113369" });
  });

  it("second run reuses both by stored id (0 creates)", async () => {
    const config = ollola();
    const { routes, run } = setup(config);
    const first = await run();
    const second = await run();
    expect(second.creates).toBe(0);
    expect(second.campaign).toMatchObject({ id: first.campaign.id, action: "reused", source: "binding" });
    expect(second.adSet).toMatchObject({ id: first.adSet.id, action: "reused", source: "binding" });
    expect(routes.writes()).toHaveLength(2);
  });

  it("reuses by exact name when no id is stored (0 creates)", async () => {
    const config = ollola();
    const state = {
      campaigns: [{ id: CAMPAIGN, name: "OLL-traffic", status: "PAUSED", effective_status: "PAUSED" }, { id: "120000000000000009", name: "OLL-traffic-old", status: "PAUSED", effective_status: "PAUSED" }],
      adsets: [{ id: ADSET, name: "OLL-traffic", status: "PAUSED", effective_status: "PAUSED", campaign_id: CAMPAIGN, daily_budget: "300" }],
    };
    const { routes, run } = setup(config, { state });
    const result = await run();
    expect(result.creates).toBe(0);
    expect(result.campaign).toMatchObject({ id: CAMPAIGN, action: "reused", source: "name" });
    expect(result.adSet).toMatchObject({ id: ADSET, action: "reused", source: "name", dailyBudgetCents: 300 });
    expect(routes.writes()).toEqual([]);
  });

  it("refuses two campaigns with the brand name instead of guessing", async () => {
    const config = ollola();
    const state = {
      campaigns: [CAMPAIGN, "120000000000000009"].map((id) => ({ id, name: "OLL-traffic", status: "PAUSED", effective_status: "PAUSED" })),
      adsets: [],
    };
    const { routes, run } = setup(config, { state });
    await expect(run()).rejects.toMatchObject({ code: "ambiguous_name" });
    expect(routes.writes()).toEqual([]);
  });

  it("adopts hand-entered campaignId/adSetId (the Sunspot migration) without creating anything", async () => {
    const config = ollola({ meta: { ...(loadFixtureConfig("ololla").meta as object), campaignId: CAMPAIGN, adSetId: ADSET } });
    const state = {
      campaigns: [{ id: CAMPAIGN, name: "Aurinkopulssi", status: "PAUSED", effective_status: "PAUSED" }],
      adsets: [{ id: ADSET, name: "Aurinkopulssi", status: "PAUSED", effective_status: "PAUSED", campaign_id: CAMPAIGN, daily_budget: "500" }],
    };
    const { routes, run, bindings } = setup(config, { state });
    const result = await run();
    expect(result.creates).toBe(0);
    expect(result.campaign).toMatchObject({ id: CAMPAIGN, name: "Aurinkopulssi", action: "adopted", source: "config" });
    expect(result.adSet).toMatchObject({ id: ADSET, action: "adopted", source: "config" });
    // Its own budget is above the G3 cap: reported, not changed.
    expect(result.adSetBudgetAboveCap).toBe(true);
    expect(routes.writes()).toEqual([]);
    expect(await bindings.get(COMPANY, "OLL")).toMatchObject({ campaignId: CAMPAIGN, adSetId: ADSET });
  });

  it("refuses an adopted ad set of another campaign, and an id of another ad account", async () => {
    const config = ollola();
    const state = {
      campaigns: [{ id: CAMPAIGN, name: "A", status: "PAUSED", effective_status: "PAUSED" }],
      adsets: [{ id: ADSET, name: "B", status: "PAUSED", effective_status: "PAUSED", campaign_id: "120000000000000009", daily_budget: "300" }],
    };
    const { run } = setup(config, { state });
    await expect(run({ campaignId: CAMPAIGN, adSetId: ADSET })).rejects.toMatchObject({ code: "adset_not_in_campaign" });

    const foreign = setup(config, { state: { campaigns: [], adsets: [] } });
    foreign.routes.on(`GET ${CAMPAIGN}`, { body: { id: CAMPAIGN, name: "X", status: "PAUSED", effective_status: "PAUSED", account_id: "1336862981968191" } });
    await expect(foreign.run({ campaignId: CAMPAIGN })).rejects.toMatchObject({ code: "object_not_in_account" });
    expect(foreign.routes.writes()).toEqual([]);
  });

  it("rejects a budget above floor(cap*100/days) before any API call", async () => {
    const config = ollola();
    const { routes, run } = setup(config);
    const error = await run({ dailyBudgetCents: 323 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProvisionError);
    expect((error as ProvisionError).code).toBe("budget_above_cap");
    await expect(run({ dailyBudgetCents: 0 })).rejects.toMatchObject({ code: "budget_invalid" });
    await expect(run({ dailyBudgetCents: 3.5 })).rejects.toMatchObject({ code: "budget_invalid" });
    expect(routes.calls).toEqual([]);
  });

  it("rejects a budget below Meta's min_daily_budget before any write", async () => {
    const config = ollola();
    const { routes, run } = setup(config);
    await expect(run({ dailyBudgetCents: 50 })).rejects.toMatchObject({ code: "budget_below_minimum" });
    expect(routes.writes()).toEqual([]);
  });

  it("accepts a lower requested budget", async () => {
    const { routes, run } = setup(ollola());
    const result = await run({ dailyBudgetCents: 250 });
    expect(result.adSet.dailyBudgetCents).toBe(250);
    expect(bodyOf(routes, `POST ${ACT}/adsets`)!.daily_budget).toBe("250");
  });

  it("dryRun returns the planned Graph calls and mutates nothing", async () => {
    const config = ollola();
    const { routes, run, bindings, r, launchChecks } = setup(config);
    const result = await run({ dryRun: true });
    expect(routes.writes()).toEqual([]);
    expect(result.creates).toBe(0);
    expect(result.campaign).toMatchObject({ id: null, action: "planned_create" });
    expect(result.adSet).toMatchObject({ id: null, action: "planned_create", dailyBudgetCents: 322 });
    expect(result.plannedCalls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${ACT}/campaigns`, `POST ${ACT}/adsets`]);
    expect(result.plannedCalls[0]!.fields).toMatchObject({ name: "OLL-traffic", status: "PAUSED", objective: "OUTCOME_TRAFFIC" });
    expect(result.plannedCalls[1]!.fields).toMatchObject({ status: "PAUSED", daily_budget: "322", campaign_id: "<new campaign>" });
    expect(await bindings.get(COMPANY, "OLL")).toBeNull();
    expect(r.harness.activity.filter((entry) => entry.message.startsWith("rk9-ads provision"))).toEqual([]);
    expect(launchChecks()).toBe(0);
  });

  it("refuses a real run that is not launch-ready, before any write", async () => {
    const config = ollola();
    const { routes, run } = setup(config);
    routes.on("tg:getChatMember", { body: { ok: true, result: { status: "left" } } });
    await expect(run()).rejects.toThrow("not launch-ready");
    expect(routes.writes()).toEqual([]);
  });

  it("refuses a second run while one is in progress", async () => {
    const config = ollola();
    const { run } = setup(config);
    const [first, second] = await Promise.allSettled([run(), run()]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "in_progress" } });
  });

  it("propagates a 190 from a write (the action reports it) and creates nothing more", async () => {
    const config = ollola();
    const { routes, run } = setup(config);
    routes.on(`POST ${ACT}/campaigns`, graphError(190, "Error validating access token", 463));
    await expect(run()).rejects.toMatchObject({ name: "TokenInvalidError" });
    expect(routes.writes()).toHaveLength(1);
  });
});

describe("provision helpers", () => {
  it("names the permanent objects without a month (G8)", () => {
    expect(provisionNames({ namingPrefix: "OLL" })).toEqual({ campaign: "OLL-traffic", adSet: "OLL-traffic" });
  });

  it.each([
    ["2026-02-15T10:00:00Z", 357],
    ["2026-04-15T10:00:00Z", 333],
    ["2026-10-17T09:00:00Z", 322],
  ])("caps the daily budget with the Helsinki month length (G3) at %s", (iso, expected) => {
    expect(maxDailyBudgetCents({ monthlyCapEur: 100, timeZone: "Europe/Helsinki" }, new Date(iso))).toBe(expected);
  });

  it("uses the Helsinki month, not the UTC one, at a month boundary", () => {
    // 2026-04-30 22:30 UTC is already 1 May in Helsinki (31 days).
    expect(maxDailyBudgetCents({ monthlyCapEur: 100, timeZone: "Europe/Helsinki" }, new Date("2026-04-30T22:30:00Z"))).toBe(322);
  });

  it("adds special_ad_category_country only with a real special category (G6)", () => {
    expect(campaignFields(ollola())).not.toHaveProperty("special_ad_category_country");
    const housing = ollola({ meta: { ...(loadFixtureConfig("ololla").meta as object), specialAdCategories: ["HOUSING"] } });
    expect(campaignFields(housing)).toMatchObject({ special_ad_categories: ["HOUSING"], special_ad_category_country: ["FI"] });
    expect(adSetFields()).not.toHaveProperty("status");
  });

  it("lets the spend guard pass is_adset_budget_sharing_enabled only as false", () => {
    expect(unmodelledBudgetKeys({ is_adset_budget_sharing_enabled: false })).toEqual([]);
    expect(unmodelledBudgetKeys({ is_adset_budget_sharing_enabled: "false" })).toEqual([]);
    expect(unmodelledBudgetKeys({ is_adset_budget_sharing_enabled: true })).toEqual(["is_adset_budget_sharing_enabled"]);
    expect(unmodelledBudgetKeys({ budget_schedule_specs: "[]" })).toEqual(["budget_schedule_specs"]);
  });
});
