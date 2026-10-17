import { describe, expect, it } from "vitest";
import {
  assertLaunchReady,
  LaunchNotReadyError,
  PREFLIGHT_CHECKS,
  PREFLIGHT_TTL_MS,
  readCachedPreflight,
  runPreflight,
  type PreflightDeps,
  type PreflightResult,
} from "../../src/brand/preflight.js";
import { tokenAlertKey, tokenIncidentKey } from "../../src/brand/token-alert.js";
import type { BrandConfigDraft } from "../../src/config.js";
import {
  BOT_TOKEN,
  COMPANY,
  draftConfig,
  enabledConfig,
  graphError,
  happyRoutes,
  loadFixtureConfig,
  META_TOKEN,
  metaClient,
  NOW,
  rig,
  tgError,
  type FakeRoutes,
  type Rig,
} from "./fake-routes.js";

function deps(r: Rig, routes: FakeRoutes, now = () => NOW): PreflightDeps & { ctx: Rig["harness"]["ctx"] } {
  return {
    ctx: r.harness.ctx,
    store: r.store,
    pluginId: "rk9-ads",
    now,
    metaClient: () => metaClient(routes),
    telegram: { fetch: routes.fetch },
  };
}

function byCheck(result: PreflightResult) {
  return Object.fromEntries(result.checks.map((entry) => [entry.check, entry]));
}

function reasons(result: PreflightResult) {
  return Object.fromEntries(result.checks.map((entry) => [entry.check, `${entry.status}:${entry.reason}`]));
}

const ollola = () => draftConfig(loadFixtureConfig("ololla"));

describe("runPreflight", () => {
  it("passes every check for the Ololla fixture and is launch-ready", async () => {
    const r = rig();
    const config = ollola();
    const routes = happyRoutes(config);
    const result = await runPreflight(deps(r, routes), COMPANY, config);
    expect(result.checks.map((entry) => entry.check)).toEqual([...PREFLIGHT_CHECKS]);
    expect(reasons(result)).toEqual({
      token_scopes: "pass:ok",
      ad_account: "pass:ok",
      spend_cap: "pass:ok",
      page: "pass:ok",
      ig_actor: "pass:ok",
      dataset: "pass:ok",
      telegram: "pass:ok",
    });
    expect(result.launchReady).toBe(true);
    expect(result.igUserId).toBe("17841400000000001");
    expect(byCheck(result).ig_actor!.required).toBe(false);
    expect(byCheck(result).spend_cap!.data).toMatchObject({ spendCapEur: 100, amountSpentEur: 12.34, mtdEur: 12.34, headroomEur: 87.66, remainingEur: 87.66 });
    // Read-only: the preflight never writes to Meta and never sends a Telegram message.
    expect(routes.writes()).toEqual([]);
    expect(routes.calls.filter((call) => call.key === "tg:sendMessage")).toEqual([]);
  });

  it("passes the Sunspot fixture (adopted Aurinkopulssi ids) against mocked Graph responses", async () => {
    const r = rig();
    const config = draftConfig(loadFixtureConfig("sunspot"));
    expect(config.meta).toMatchObject({ adAccountId: "1336862981968191", pageId: "1216714361516949", campaignId: "120247250925830775", adSetId: "120247250925850775" });
    const result = await runPreflight(deps(r, happyRoutes(config, { "tg:getChat": { body: { ok: true, result: { id: -1001234567890, type: "supergroup" } } } })), COMPANY, config);
    expect(result.launchReady).toBe(true);
    expect(byCheck(result).dataset).toMatchObject({ status: "skipped", reason: "dataset_not_configured", required: false });
  });

  it("caches the result with checkedAt and the config fingerprint", async () => {
    const r = rig();
    const config = ollola();
    const result = await runPreflight(deps(r, happyRoutes(config)), COMPANY, config);
    const cached = await readCachedPreflight(r.harness.ctx, COMPANY);
    expect(cached).toEqual(result);
    expect(cached?.checkedAt).toBe(NOW.toISOString());
    expect(await readCachedPreflight(r.harness.ctx, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ["missing scopes", { "GET me/permissions": { body: { data: [{ permission: "ads_read", status: "granted" }, { permission: "ads_management", status: "declined" }] } } }, "token_scopes", "fail:missing_scopes"],
    ["currency", { "GET act_29231592883113369": { body: { currency: "USD", timezone_name: "Europe/Helsinki", spend_cap: "10000", amount_spent: "0", account_status: 1 } } }, "ad_account", "fail:currency_not_eur"],
    ["time zone", { "GET act_29231592883113369": { body: { currency: "EUR", timezone_name: "America/Los_Angeles", spend_cap: "10000", amount_spent: "1234", account_status: 1 } } }, "ad_account", "fail:timezone_mismatch"],
    ["account status", { "GET act_29231592883113369": { body: { currency: "EUR", timezone_name: "Europe/Helsinki", spend_cap: "10000", amount_spent: "1234", account_status: 2 } } }, "ad_account", "fail:account_not_active"],
    ["account unreadable", { "GET act_29231592883113369": graphError(100, "Unsupported get request") }, "ad_account", "fail:account_unreachable"],
    ["no spend cap", { "GET act_29231592883113369": { body: { currency: "EUR", timezone_name: "Europe/Helsinki", spend_cap: "0", amount_spent: "1234", account_status: 1 } } }, "spend_cap", "fail:no_spend_cap"],
    ["spend cap used up", { "GET act_29231592883113369": { body: { currency: "EUR", timezone_name: "Europe/Helsinki", spend_cap: "10000", amount_spent: "10000", account_status: 1 } } }, "spend_cap", "fail:spend_cap_reached"],
    // spend_cap 200 EUR with 12.34 spent: headroom 187.66 > the 87.66 EUR left of the 100 EUR cap (G2).
    ["headroom above the rest of the cap", { "GET act_29231592883113369": { body: { currency: "EUR", timezone_name: "Europe/Helsinki", spend_cap: "20000", amount_spent: "1234", account_status: 1 } } }, "spend_cap", "fail:spend_cap_headroom_exceeds_remaining"],
    ["page", { "GET 1284777064729996": graphError(100, "Object does not exist") }, "page", "fail:page_unreachable"],
    ["dataset", { "GET act_29231592883113369/adspixels": { body: { data: [{ id: "999" }] } } }, "dataset", "fail:dataset_not_attached"],
    ["chat", { "tg:getChat": tgError(400, "Bad Request: chat not found") }, "telegram", "fail:telegram_chat_unreachable"],
    ["left the chat", { "tg:getChatMember": { body: { ok: true, result: { status: "left" } } } }, "telegram", "fail:telegram_cannot_post"],
    ["muted", { "tg:getChatMember": { body: { ok: true, result: { status: "restricted", can_send_messages: false } } } }, "telegram", "fail:telegram_cannot_post"],
    ["bot token refused", { "tg:getMe": tgError(401, "Unauthorized") }, "telegram", "fail:telegram_token_invalid"],
  ])("fails %s with a typed reason and is not launch-ready", async (_label, overrides, key, expected) => {
    const r = rig();
    const config = ollola();
    const result = await runPreflight(deps(r, happyRoutes(config, overrides as never)), COMPANY, config);
    expect(reasons(result)[key]).toBe(expected);
    expect(result.launchReady).toBe(false);
  });

  it("checks a configured igUserId instead of resolving it from the page", async () => {
    const r = rig();
    const config = draftConfig({ ...loadFixtureConfig("ololla"), meta: { ...(loadFixtureConfig("ololla").meta as object), igUserId: "17841499999999999" } });
    const routes = happyRoutes(config, { "GET 17841499999999999": graphError(100, "Object does not exist") });
    const result = await runPreflight(deps(r, routes), COMPANY, config);
    expect(byCheck(result).ig_actor).toMatchObject({ status: "fail", reason: "ig_unreachable", required: true });
    expect(result.launchReady).toBe(false);
  });

  it("skips ig_actor (not required) when the page has no Instagram account", async () => {
    const r = rig();
    const config = ollola();
    const result = await runPreflight(deps(r, happyRoutes(config, { "GET 1284777064729996": { body: { id: "1284777064729996", name: "Ololla" } } })), COMPANY, config);
    expect(byCheck(result).ig_actor).toMatchObject({ status: "skipped", reason: "ig_not_linked", required: false });
    expect(result.launchReady).toBe(true);
  });

  it("checks a channel by can_post_messages", async () => {
    const r = rig();
    const config = ollola();
    const channel = { "tg:getChat": { body: { ok: true, result: { id: -1, type: "channel" } } } };
    const member = await runPreflight(deps(r, happyRoutes(config, { ...channel, "tg:getChatMember": { body: { ok: true, result: { status: "member" } } } })), COMPANY, config);
    expect(byCheck(member).telegram!.reason).toBe("telegram_cannot_post");
    const admin = await runPreflight(deps(r, happyRoutes(config, { ...channel, "tg:getChatMember": { body: { ok: true, result: { status: "administrator", can_post_messages: true } } } })), COMPANY, config);
    expect(byCheck(admin).telegram!.status).toBe("pass");
  });

  it("is not launch-ready while monthlyCapEur is null, even when Meta passes", async () => {
    const r = rig();
    const config = draftConfig({ ...loadFixtureConfig("ololla"), monthlyCapEur: null });
    expect(config.monthlyCapEur).toBeNull();
    const result = await runPreflight(deps(r, happyRoutes(config)), COMPANY, config);
    expect(byCheck(result).spend_cap).toMatchObject({ status: "fail", reason: "monthly_cap_unset" });
    expect(result.launchReady).toBe(false);
  });

  it("fails telegram when the brand has no telegram block", async () => {
    const r = rig();
    const raw = loadFixtureConfig("ololla");
    delete raw.telegram;
    const config = draftConfig(raw);
    const result = await runPreflight(deps(r, happyRoutes(config)), COMPANY, config);
    expect(byCheck(result).telegram).toMatchObject({ status: "fail", reason: "telegram_not_configured", required: true });
    expect(result.launchReady).toBe(false);
  });

  it("reports an unresolvable token ref without calling Meta", async () => {
    const r = rig();
    const config = ollola();
    const routes = happyRoutes(config);
    const d = deps(r, routes);
    d.metaClient = () => metaClient(routes, { token: async () => { throw new Error("binding_missing for secret f9567c7b"); } });
    const result = await runPreflight(d, COMPANY, config);
    expect(byCheck(result).token_scopes!.reason).toBe("token_unresolved");
    expect(byCheck(result).ad_account!.reason).toBe("token_unresolved");
    expect(routes.calls.filter((call) => !call.key.startsWith("tg:"))).toEqual([]);
  });
});

describe("Graph error 190", () => {
  const expired = graphError(190, "Error validating access token: Session has expired", 463);

  it("fails without a retry, skips later Meta checks, sends one alert and creates one issue", async () => {
    const r = rig();
    const config = ollola();
    const routes = happyRoutes(config, { "GET me/permissions": expired });
    const first = await runPreflight(deps(r, routes), COMPANY, config);
    expect(reasons(first)).toMatchObject({ token_scopes: "fail:token_invalid", ad_account: "fail:token_invalid", spend_cap: "fail:token_invalid", page: "fail:token_invalid" });
    // One Graph request in total: no retry, no further Meta reads.
    expect(routes.calls.filter((call) => !call.key.startsWith("tg:")).map((call) => call.key)).toEqual(["GET me/permissions"]);
    expect(first.tokenIncident).toEqual({ errorClass: "token_invalid", telegram: "sent", issue: "created" });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ companyId: COMPANY, originKind: "plugin:rk9-ads", originId: "rk9-ads:OLL:token_invalid", priority: "high" });

    const second = await runPreflight(deps(r, routes), COMPANY, config);
    expect(second.tokenIncident).toEqual({ errorClass: "token_invalid", telegram: "already_sent", issue: "exists" });
    expect(routes.calls.filter((call) => call.key === "tg:sendMessage")).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
  });

  it("clears the Telegram marker after a successful token check, so the next 190 is messaged again", async () => {
    const r = rig();
    const config = ollola();
    const first = happyRoutes(config, { "GET me/permissions": expired });
    await runPreflight(deps(r, first), COMPANY, config);
    expect(r.store.keys()).toEqual([`${COMPANY}|${tokenAlertKey("OLL")}`, `${COMPANY}|${tokenIncidentKey("OLL")}`]);
    await runPreflight(deps(r, happyRoutes(config)), COMPANY, config);
    // RK9-538: the issue marker stays. The plugin cannot see whether the issue is still open.
    expect(r.store.keys()).toEqual([`${COMPANY}|${tokenIncidentKey("OLL")}`]);
    const again = happyRoutes(config, { "GET me/permissions": expired });
    const second = await runPreflight(deps(r, again), COMPANY, config);
    expect(second.tokenIncident).toEqual({ errorClass: "token_invalid", telegram: "sent", issue: "exists" });
    expect(again.calls.filter((call) => call.key === "tg:sendMessage")).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
  });

  it("gives the alert marker back when Telegram fails, but keeps the issue", async () => {
    const r = rig();
    const config = ollola();
    const routes = happyRoutes(config, { "GET me/permissions": expired, "tg:sendMessage": tgError(500, "Internal") });
    const result = await runPreflight(deps(r, routes), COMPANY, config);
    expect(result.tokenIncident).toMatchObject({ telegram: "failed", issue: "created" });
    expect(r.store.keys()).toEqual([`${COMPANY}|${tokenIncidentKey("OLL")}`]);
  });

  it("never puts a resolved secret into the result, the cache, logs, activity or the issue", async () => {
    const r = rig();
    const config = ollola();
    const leaky = graphError(190, `Invalid OAuth access token - Cannot parse access token ${META_TOKEN}`);
    const result = await runPreflight(deps(r, happyRoutes(config, { "GET me/permissions": leaky, "tg:getChat": tgError(400, `chat not found for bot${BOT_TOKEN}`) })), COMPANY, config);
    const everything = JSON.stringify({ result, cached: await readCachedPreflight(r.harness.ctx, COMPANY), logs: r.harness.logs, activity: r.harness.activity, issues: r.issues });
    expect(everything).not.toContain(META_TOKEN);
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toContain("sentinel");
  });
});

describe("assertLaunchReady", () => {
  function counting(routes: FakeRoutes) {
    return () => routes.calls.filter((call) => call.key === "GET me/permissions").length;
  }

  it("uses a fresh launch-ready cache entry and re-runs a stale one", async () => {
    const r = rig();
    const raw = loadFixtureConfig("ololla");
    const config = enabledConfig(raw);
    const routes = happyRoutes(config);
    let now = NOW;
    const d = deps(r, routes, () => now);
    const runs = counting(routes);

    await assertLaunchReady(d, COMPANY, { config });
    expect(runs()).toBe(1);
    now = new Date(NOW.getTime() + PREFLIGHT_TTL_MS - 1);
    await assertLaunchReady(d, COMPANY, { config });
    expect(runs()).toBe(1);
    now = new Date(NOW.getTime() + PREFLIGHT_TTL_MS + 1);
    await assertLaunchReady(d, COMPANY, { config });
    expect(runs()).toBe(2);
  });

  it("re-runs when the config changed since the cached check", async () => {
    const r = rig();
    const config = enabledConfig(loadFixtureConfig("ololla"));
    const routes = happyRoutes(config);
    const d = deps(r, routes);
    await assertLaunchReady(d, COMPANY, { config });
    const changed: BrandConfigDraft = { ...config, namingPrefix: "OLL2" };
    await assertLaunchReady(d, COMPANY, { config: changed as typeof config });
    expect(counting(routes)()).toBe(2);
  });

  it("refuses with the failing checks when the fresh preflight is not launch-ready", async () => {
    const r = rig();
    const config = enabledConfig(loadFixtureConfig("ololla"));
    const d = deps(r, happyRoutes(config, { "tg:getChatMember": { body: { ok: true, result: { status: "kicked" } } } }));
    const error = await assertLaunchReady(d, COMPANY, { config }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchNotReadyError);
    expect((error as LaunchNotReadyError).failed).toEqual([{ check: "telegram", reason: "telegram_cannot_post" }]);
  });

  it("refuses a disabled brand (monthlyCapEur null) before any Meta call", async () => {
    const r = rig();
    const routes = happyRoutes(ollola());
    r.harness.ctx.config.get = async () => ({ ...loadFixtureConfig("ololla"), monthlyCapEur: null });
    const error = await assertLaunchReady(deps(r, routes), COMPANY).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchNotReadyError);
    expect((error as LaunchNotReadyError).failed).toEqual([{ check: "config", reason: "monthly_cap_unset" }]);
    expect(routes.calls).toEqual([]);
  });
});
