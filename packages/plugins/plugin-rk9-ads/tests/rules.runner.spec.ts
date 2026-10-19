import type { Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createLedger } from "../src/db.js";
import type { RuleAdDay } from "../src/features/rules/evaluate.js";
import { registerRules, RULES_DATA_KEY, RULES_DRY_RUN_ACTION_KEY } from "../src/features/rules/register.js";
import { CAP_HALT_RELEASED_ACTIVITY, RULES_JOB_KEY } from "../src/features/rules/runner.js";
import { clearHalt, readHalt, setHalt, type HaltState } from "../src/features/spend-guard/halt.js";
import { memoryRulesStore } from "../src/features/rules/store.js";
import type { FeatureRuntime } from "../src/features/types.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import manifest from "../src/manifest.js";
import { brandConfig, COMPANY_A, COMPANY_B, SECRET_A_META, SECRET_B_META, secretRef } from "./fixtures.js";
import { FakeMeta } from "./spend-guard/fake-meta.js";
import { FakeNotifier, META_TOKEN, telegramBlock } from "./spend-guard/rig.js";

const NOW = new Date("2026-10-21T09:00:00Z"); // yesterday = 2026-10-20 in Helsinki
const CPC_LIVE = { ruleId: "cpc-ceiling", type: "threshold_pause", mode: "live", metric: "cpc", operator: "gt", threshold: 0.5, days: 2, minImpressions: 500, minClicks: 10 };

/** Two days at 0.60 and 0.70 EUR per link click, 300 impressions and 5 clicks each. */
function badDays(adId: string): RuleAdDay[] {
  return [
    { adId, date: "2026-10-19", spendCents: 300, impressions: 300, inlineLinkClicks: 5, frequency: 1.1 },
    { adId, date: "2026-10-20", spendCents: 350, impressions: 300, inlineLinkClicks: 5, frequency: 1.1 },
  ];
}

function accountMeta(): FakeMeta {
  const meta = new FakeMeta();
  meta.campaigns = [{ id: "100", name: "OLL jatkuva", status: "ACTIVE" }];
  meta.ads = [
    { id: "301", name: "Syksy 1", status: "ACTIVE", campaign_id: "100" },
    { id: "302", name: "Syksy 2", status: "PAUSED", campaign_id: "100" },
    { id: "303", name: "Syksy 3", status: "ACTIVE", campaign_id: "100" },
  ];
  // 40 EUR month-to-date of a 100 EUR cap.
  meta.spend = () => "40.00";
  return meta;
}

function setup(
  input: { rules?: Record<string, unknown>; meta?: FakeMeta; companies?: Record<string, Record<string, unknown>>; days?: RuleAdDay[]; closed?: boolean; closeCardsError?: Error } = {},
) {
  const harness = createTestHarness({ manifest });
  const configs = input.companies ?? { [COMPANY_A]: brandConfig({ telegram: telegramBlock(), ...(input.rules ? { rules: input.rules } : {}) }) };
  harness.seed({ companies: Object.keys(configs).map((id, index) => ({ id, name: `Brand ${index}` }) as Company) });
  useCompanyConfigs(harness, configs);
  useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: META_TOKEN }, [COMPANY_B]: { [SECRET_B_META]: META_TOKEN } });
  const meta = input.meta ?? accountMeta();
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    throw new Error(`no route for ${url}`);
  };
  const notifier = new FakeNotifier();
  const store = memoryRulesStore({ days: input.days ?? [...badDays("301"), ...badDays("302")], closed: input.closed ?? true });
  const clock = { now: NOW };
  const runtime: FeatureRuntime = {
    ctx: harness.ctx,
    ledger: createLedger(harness.ctx.db),
    handleWebhook() {},
    handleApiRoute() {},
    onConfigChanged() {},
    onShutdown() {},
  };
  const cardCloses: Array<{ companyId: string; rule: string }> = [];
  // The gate is not registered here: a stub stands in for its card closer.
  const closeCards = async (companyId: string, close: { rule: string }) => {
    if (input.closeCardsError) throw input.closeCardsError;
    cardCloses.push({ companyId, rule: close.rule });
    return { ids: [], announce: async () => undefined };
  };
  registerRules(runtime, { store, notifier, now: () => clock.now, fatigue: async () => [], closeCards });
  return {
    cardCloses,
    harness,
    /** Mutable: a test changes a company's saved config between runs. */
    configs,
    meta,
    notifier,
    store,
    clock,
    /** rule_actions rows pauseAll wrote through the ledger (the SDK db stub records them). */
    ledgerRuleActions: () =>
      harness.dbExecutes
        .filter((entry) => /INSERT INTO \S+\.rule_actions/.test(entry.sql))
        .map((entry) => {
          const columns = /\(([^)]*)\) VALUES/.exec(entry.sql)![1]!.split(",").map((column) => column.trim());
          const row = Object.fromEntries(columns.map((column, index) => [column, entry.params?.[index]]));
          if (typeof row.metrics === "string") row.metrics = JSON.parse(row.metrics);
          return row;
        }),
  };
}

describe("rules-evaluate job (A11)", () => {
  it("is declared hourly in the manifest", () => {
    expect(manifest.jobs).toContainEqual(expect.objectContaining({ jobKey: RULES_JOB_KEY, schedule: "0 * * * *" }));
  });

  it("shadow (the default config): records the CPC hit and the 90 % cap hit, makes zero Meta writes and sends no Telegram", async () => {
    const meta = accountMeta();
    meta.spend = () => "95.00";
    const r = setup({ meta });
    await r.harness.runJob(RULES_JOB_KEY);

    expect(r.meta.writes).toHaveLength(0);
    expect(r.notifier.messages).toHaveLength(0);
    expect(r.notifier.cards).toHaveLength(0);
    expect(r.store.actions).toEqual([
      expect.objectContaining({
        companyId: COMPANY_A,
        ruleId: "cpc-ceiling",
        ruleType: "threshold_pause",
        objectType: "ad",
        objectId: "301",
        action: "pause",
        mode: "shadow",
        dryRun: true,
        applied: false,
        metrics: expect.objectContaining({ spendEur: 6.5, clicks: 10, impressions: 600, cpc: 0.65, days: 7, aggregate: "window_total" }),
      }),
    ]);
    // The cap rule runs A6's pauseAll as a dry run: it lists, writes nothing, audits.
    expect(r.ledgerRuleActions()).toEqual([
      expect.objectContaining({
        rule_id: "pause_all_cap",
        rule_type: "pause_all_cap",
        action: "pause_all",
        mode: "shadow",
        dry_run: true,
        applied: false,
        metrics: expect.objectContaining({ ruleId: "pause_all_cap", pctUsed: 95, count: 3 }),
      }),
    ]);
    expect(r.harness.activity.map((entry) => entry.message)).toEqual(
      expect.arrayContaining(["rk9-ads rules: cpc-ceiling would pause ad 301 (shadow)", expect.stringMatching(/pause_all_cap dry-run would pause 3/)]),
    );
  });

  it("shadow hits respect the cooldown: a second run within 24 h records nothing new", async () => {
    const r = setup();
    await r.harness.runJob(RULES_JOB_KEY);
    r.clock.now = new Date(NOW.getTime() + 3_600_000);
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.store.actions).toHaveLength(1);
    r.clock.now = new Date(NOW.getTime() + 23 * 3_600_000);
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.store.actions).toHaveLength(1);
    // 24 h later the cooldown is over, and the 7-day window still holds the bad days.
    r.clock.now = new Date(NOW.getTime() + 24 * 3_600_000);
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.store.actions).toHaveLength(2);
  });

  it("a live rule stays shadow while the brand's liveMode is off", async () => {
    const r = setup({ rules: { liveMode: false, list: [CPC_LIVE] } });
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toEqual([expect.objectContaining({ objectId: "301", mode: "shadow", dryRun: true })]);
  });

  it("live: pauses only the ACTIVE ad through the guarded client, notifies once, and a second run changes nothing and stays silent", async () => {
    const r = setup({ rules: { liveMode: true, list: [CPC_LIVE] } });
    await r.harness.runJob(RULES_JOB_KEY);

    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([["301", "PAUSED"]]);
    expect(r.store.actions).toEqual([expect.objectContaining({ objectId: "301", mode: "live", dryRun: false, applied: true, error: null })]);
    expect(r.notifier.messages).toHaveLength(1);
    expect(r.notifier.messages[0]!.text).toMatch(/säännöt pysäyttivät 1 mainos/);
    expect(r.notifier.messages[0]!.text).toMatch(/cpc-ceiling: mainos Syksy 1 \(301\) – cpc > 0.5 on 2 consecutive day/);
    expect(r.harness.activity.map((entry) => entry.message)).toContain("rk9-ads rules: cpc-ceiling paused ad 301");

    // Next hour: 301 is PAUSED now (and in cooldown); nothing changes, no Telegram.
    r.clock.now = new Date(NOW.getTime() + 3_600_000);
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.meta.writes).toHaveLength(1);
    expect(r.notifier.messages).toHaveLength(1);
  });

  it("live: no Telegram when every matching ad is already PAUSED", async () => {
    const r = setup({ rules: { liveMode: true, list: [CPC_LIVE] }, days: badDays("302") });
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.notifier.messages).toHaveLength(0);
    expect(r.store.actions).toHaveLength(0);
  });

  it("live pause_all_cap: pauses the whole account through pauseAll at 90 % and audits the MTD figures", async () => {
    const meta = accountMeta();
    meta.spend = () => "90.00";
    const r = setup({ meta, rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
    await r.harness.runJob(RULES_JOB_KEY);

    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([
      ["100", "PAUSED"],
      ["301", "PAUSED"],
      ["303", "PAUSED"],
    ]);
    expect(r.notifier.messages).toHaveLength(1);
    expect(r.notifier.messages[0]!.text).toMatch(/koko mainostili pysäytetty .*kulutuskatto 90 %/);
    expect(r.notifier.messages[0]!.text).toMatch(/Kulutus 90 % kuukauden katosta/);
    expect(r.ledgerRuleActions()).toEqual([
      expect.objectContaining({ rule_id: "pause_all_cap", mode: "live", dry_run: false, applied: true, metrics: expect.objectContaining({ pctUsed: 90, mtdEur: 90 }) }),
    ]);
    expect(r.cardCloses).toEqual([{ companyId: COMPANY_A, rule: "pause_all_cap" }]);
    // Below 90 % nothing happens.
    const quiet = setup({ rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
    await quiet.harness.runJob(RULES_JOB_KEY);
    expect(quiet.meta.writes).toHaveLength(0);
  });

  it("fails the run when the cap pause could not close the open activation cards (RK9-561)", async () => {
    const meta = accountMeta();
    meta.spend = () => "90.00";
    const r = setup({ meta, rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] }, closeCardsError: new Error("gate store down") });
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/pause_all_cap: open activation cards were not closed \(Error: gate store down\)/);
    // The pause itself stands.
    expect(r.meta.writes.map((call) => call.body.status)).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  });

  it("keeps the card-close failure when the cap pause's own listing fails (RK9-561)", async () => {
    const meta = accountMeta();
    meta.spend = () => "90.00";
    // The month-to-date read and the status read list the campaigns first; the pause's listing is the third.
    let campaignLists = 0;
    meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") && ++campaignLists > 2 ? new Error("graph down") : null);
    const r = setup({ meta, rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] }, closeCardsError: new Error("gate store down") });
    const run = r.harness.runJob(RULES_JOB_KEY);
    await expect(run).rejects.toThrow(/graph down/);
    await expect(run).rejects.toThrow(/pause_all_cap: open activation cards were not closed \(Error: gate store down\)/);
    expect(campaignLists).toBe(3);
    expect(r.meta.writes).toHaveLength(0);
  });

  it("propose_scale never calls Meta (G9)", async () => {
    const r = setup({
      rules: { liveMode: true, list: [{ ruleId: "scale", type: "propose_scale", enabled: false, mode: "live", threshold: 5, days: 1, minImpressions: 0, minClicks: 0 }] },
    });
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toHaveLength(0);
  });

  it("fails open on a Meta read failure (no pause, run failed) and still evaluates the other brands", async () => {
    const companies = {
      // Another ad account: the fake answers every read of it with an error.
      [COMPANY_A]: brandConfig({ meta: { adAccountId: "act_111", pageId: "1", accessTokenRef: secretRef(SECRET_A_META) }, rules: { liveMode: true, list: [CPC_LIVE] } }),
      [COMPANY_B]: brandConfig({ brandCode: "AUR", meta: { adAccountId: "act_29231592883113369", pageId: "2", accessTokenRef: secretRef(SECRET_B_META) } }),
    };
    const r = setup({ companies });
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: Meta status read failed \(.*\), only pause_all_cap evaluated \(fail-open\)/);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toEqual([expect.objectContaining({ companyId: COMPANY_B, brandCode: "AUR", objectId: "301", mode: "shadow" })]);
  });

  it("skips the cap rule when month-to-date cannot be read, and still runs the other rules", async () => {
    const meta = accountMeta();
    meta.fail = (call) => (call.path.endsWith("/insights") ? new Response(JSON.stringify({ error: { message: "x", code: 1 } }), { status: 500 }) : null);
    const r = setup({ meta });
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/month-to-date not read .*pause_all_cap skipped \(fail-open\)/);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toEqual([expect.objectContaining({ ruleId: "cpc-ceiling", objectId: "301" })]);
  });

  it("threshold rules wait until insights-daily-close has finalised yesterday, and a close still missing at 06:00 fails the run", async () => {
    const r = setup({ rules: { liveMode: true, list: [CPC_LIVE] }, closed: false });
    r.clock.now = new Date("2026-10-21T02:59:00Z"); // 05:59 in Helsinki
    await expect(r.harness.runJob(RULES_JOB_KEY)).resolves.toBeUndefined();
    expect(r.meta.writes).toHaveLength(0);
    r.clock.now = new Date("2026-10-21T03:00:00Z"); // 06:00 in Helsinki
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: insights-daily-close has not finalised 2026-10-20 by 06:00, threshold rules wait/);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toHaveLength(0);
    r.store.closed = true;
    await r.harness.runJob(RULES_JOB_KEY);
    expect(r.meta.writes.map((call) => call.path)).toEqual(["301"]);
  });

  it("the cap rule makes no decision on a non-EUR account", async () => {
    const meta = new FakeMeta(undefined, { currency: "SEK" });
    meta.campaigns = accountMeta().campaigns;
    meta.ads = accountMeta().ads;
    meta.spend = () => "99.00";
    const r = setup({ meta, rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/month-to-date not read .*pause_all_cap skipped/);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.ledgerRuleActions()).toHaveLength(0);
  });

  it("skips threshold rules when the ad account reports in another time zone than the brand's (RK9-541)", async () => {
    const meta = new FakeMeta(undefined, { timezone_name: "UTC" });
    meta.campaigns = accountMeta().campaigns;
    meta.ads = accountMeta().ads;
    meta.spend = () => "40.00";
    const r = setup({ meta, rules: { liveMode: true, list: [CPC_LIVE] } });
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: the ad account reports in another time zone than Europe\/Helsinki, threshold rules skipped/);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toHaveLength(0);
  });

  it("fails the run when a decision's rule_actions row cannot be written (its cooldown would be lost)", async () => {
    const r = setup();
    r.store.failInsert = true;
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/cpc-ceiling: rule_actions insert failed for ad 301/);
    expect(r.meta.writes).toHaveLength(0);
  });

  it("does not evaluate an invalid config that was never valid", async () => {
    const r = setup({ companies: { [COMPANY_A]: brandConfig({ rules: { list: [{ ruleId: "x", type: "nope" }] } }) } });
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/the brand config is invalid and there is no last valid config to pause with; rules not evaluated/);
    expect(r.meta.calls).toHaveLength(0);
  });

  describe("the built-in cap rule is isolated from the rest (RK9-536)", () => {
    const LIVE_RULES = { liveMode: true, list: [CPC_LIVE, { type: "pause_all_cap", mode: "live" }] };
    const capPauses = [
      ["100", "PAUSED"],
      ["301", "PAUSED"],
      ["303", "PAUSED"],
    ];
    function overCap(): FakeMeta {
      const meta = accountMeta();
      meta.spend = () => "95.00";
      return meta;
    }

    it.each([
      ["invalid", (config: Record<string, unknown>) => ({ ...config, rules: { list: [{ ruleId: "x", type: "nope" }] } })],
      // RK9-538 item 2: clearing the cap must not silence the pause side.
      ["disabled", (config: Record<string, unknown>) => ({ ...config, monthlyCapEur: null })],
    ])("a config turned %s runs only the cap rule, on the last valid config, and fails the run", async (state, breakIt) => {
      const r = setup({ rules: LIVE_RULES, days: [] });
      // Enabled and below the cap: nothing to do, but the valid config is stored.
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes).toHaveLength(0);

      r.configs[COMPANY_A] = breakIt(r.configs[COMPANY_A]!);
      r.meta.spend = () => "95.00";
      r.store.days.push(...badDays("301"));
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(new RegExp(`OLL: the brand config is ${state}; only pause_all_cap ran, on the last valid config`));
      // The account is paused; the CPC rule did not run (no ad decision of its own).
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      expect(r.store.actions).toHaveLength(0);
      expect(r.ledgerRuleActions()).toEqual([
        expect.objectContaining({ rule_id: "pause_all_cap", mode: "live", applied: true, reason: expect.stringContaining(`[konfiguraatio ${state}: viimeisin kelvollinen, koko mainostili]`) }),
      ]);
    });

    it("skips a disabled config that was never enabled without failing the run", async () => {
      const r = setup({ companies: { [COMPANY_A]: brandConfig({ monthlyCapEur: null }) }, meta: overCap() });
      await expect(r.harness.runJob(RULES_JOB_KEY)).resolves.toBeUndefined();
      expect(r.meta.calls).toHaveLength(0);
    });

    it("runs the cap rule when the insights read throws, and fails the run", async () => {
      const r = setup({ meta: overCap(), rules: LIVE_RULES });
      r.store.adDays = async () => {
        throw new Error("recentAdSeries: more than 200000 rows");
      };
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: insights not read \(Error: recentAdSeries: more than 200000 rows\), threshold rules skipped/);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      expect(r.store.actions).toHaveLength(0);
    });

    it("runs the cap rule when the creative read throws, and fails the run", async () => {
      const r = setup({ meta: overCap(), rules: { liveMode: true, list: [{ ruleId: "expired", type: "pause_valid_until", mode: "live" }, { type: "pause_all_cap", mode: "live" }] } });
      r.store.creativeValidity = async () => {
        throw new Error("db down");
      };
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: creative validity not read \(Error: db down\), pause_valid_until skipped/);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
    });

    it("runs only the cap rule when the earlier rule actions cannot be read", async () => {
      const r = setup({ meta: overCap(), rules: LIVE_RULES });
      r.store.priorActions = async () => {
        throw new Error("priorActions: more than 5000 rows");
      };
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: earlier rule actions not read \(Error: priorActions: more than 5000 rows\), only pause_all_cap evaluated, no cap halt in force, no cooldown/);
      // The CPC rule made no decision without its cooldown; the cap rule paused the account.
      expect(r.store.actions).toHaveLength(0);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
    });

    it("a pause_all that hands a failed object to the pause retry is settled; one left ACTIVE without the retry is retried (RK9-541)", async () => {
      const meta = overCap();
      meta.fail = (call) => (call.method !== "GET" && call.path === "303" ? new Response(JSON.stringify({ error: { message: "x", code: 2 } }), { status: 500 }) : null);
      const r = setup({ meta, rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL pause_all_cap: 1 pause\(s\) failed/);
      expect(r.ledgerRuleActions()).toEqual([
        expect.objectContaining({
          rule_id: "pause_all_cap",
          applied: true,
          error: expect.stringContaining("303"),
          metrics: expect.objectContaining({ settled: true, retry: expect.objectContaining({ stored: true }) }),
        }),
      ]);
      // pauseAll writes through the ledger; the memory store gets the same row by hand.
      const row = (settled: boolean, decidedAt: Date) => ({
        brandCode: "OLL",
        ruleId: "pause_all_cap",
        ruleType: "pause_all_cap",
        objectType: "account" as const,
        objectId: "29231592883113369",
        action: "pause_all" as const,
        mode: "live" as const,
        dryRun: false,
        applied: true,
        reason: "cap",
        metrics: { settled },
        error: "303: x",
        decidedAt,
      });
      await r.store.insertAction(COMPANY_A, row(true, NOW));
      expect(await r.store.priorActions(COMPANY_A, ["pause_all_cap"], new Date(0))).toEqual([expect.objectContaining({ ruleId: "pause_all_cap", applied: true })]);
      // The pause retry owns 303 now: the cap rule does not try it every hour.
      meta.fail = () => null;
      r.clock.now = new Date(NOW.getTime() + 3_600_000);
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes.filter((call) => call.path === "303")).toHaveLength(1);
      // Without the pause retry (not settled) the row does not start the cooldown.
      r.store.actions.length = 0;
      await r.store.insertAction(COMPANY_A, row(false, r.clock.now));
      expect(await r.store.priorActions(COMPANY_A, ["pause_all_cap"], new Date(0))).toEqual([expect.objectContaining({ ruleId: "pause_all_cap", applied: false })]);
      r.clock.now = new Date(NOW.getTime() + 2 * 3_600_000);
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes.filter((call) => call.path === "303")).toHaveLength(2);
    });

    it("a cap pause whose Telegram notice failed is settled, so its cooldown holds (RK9-541)", async () => {
      const r = setup({ meta: overCap(), rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
      r.notifier.fail = new Error("telegram down");
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL pause_all_cap: paused 3 but the Telegram notice failed/);
      expect(r.ledgerRuleActions()).toEqual([
        expect.objectContaining({ rule_id: "pause_all_cap", applied: true, error: expect.stringContaining("telegram: "), metrics: expect.objectContaining({ settled: true }) }),
      ]);
    });

    it("runs the cap rule when the status read fails: pauseAll lists its own targets (RK9-541)", async () => {
      const meta = overCap();
      // The status read's ad listing fails; the pause's own listing works.
      let adLists = 0;
      meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/ads") && ++adLists === 1 ? new Error("graph down") : null);
      const r = setup({ meta, rules: LIVE_RULES });
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      // The CPC rule made no decision without the ad status.
      expect(r.store.actions).toHaveLength(0);
    });

    it("takes the cap rule's cooldown from its settled pause when the earlier rule actions cannot be read (RK9-541)", async () => {
      const r = setup({ meta: overCap(), rules: LIVE_RULES, days: [] });
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      // The operator restarts the ads; rule_actions cannot be read from now on.
      for (const object of [...r.meta.campaigns, ...r.meta.ads]) if (object.id !== "302") object.status = "ACTIVE";
      r.store.priorActions = async () => {
        throw new Error("db down");
      };
      r.clock.now = new Date(NOW.getTime() + 2 * 3_600_000);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/only pause_all_cap evaluated, cooldown from the settled cap pause of 2026-10-21T09:00:00.000Z/);
      expect(r.meta.writes).toHaveLength(3);
      expect(r.notifier.messages).toHaveLength(1);
      // After the 24 h cooldown the cap rule pauses again.
      r.clock.now = new Date(NOW.getTime() + 24 * 3_600_000);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/earlier rule actions not read/);
      expect(r.meta.writes).toHaveLength(6);
    });

    it("a cap halt from a pause attempt that paused nothing gives no cooldown (RK9-541)", async () => {
      const meta = overCap();
      // The status read and the month read work; the pause's own listing fails.
      let campaignLists = 0;
      meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") && ++campaignLists === 3 ? new Error("graph down") : null);
      const r = setup({ meta, rules: LIVE_RULES, days: [] });
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/graph down/);
      expect(r.meta.writes).toHaveLength(0);
      expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toMatchObject({ rule: "pause_all_cap" });
      r.store.priorActions = async () => {
        throw new Error("db down");
      };
      r.clock.now = new Date(NOW.getTime() + 3_600_000);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/the cap halt in force is not from a settled cap pause, no cooldown/);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
    });

    it("with an unread status the cap rule does not override a cleared cap halt (RK9-541)", async () => {
      const meta = overCap();
      meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/ads") ? new Error("graph down") : null);
      const r = setup({ meta, rules: LIVE_RULES });
      const halt: HaltState = {
        brandCode: "OLL",
        rule: "pause_all_cap",
        id: "cap-1",
        since: "2026-10-21T07:00:00.000Z",
        until: "2026-10-31T22:00:00.000Z",
        reason: "pause_all_cap test",
        initiator: { source: "job" },
        cap: { mtdEur: 92, monthlyCapEur: 100 },
      };
      await setHalt(r.harness.ctx, COMPANY_A, halt);
      const preview = await readHalt(r.harness.ctx, COMPANY_A, r.clock.now);
      await clearHalt(r.harness.ctx, COMPANY_A, preview!.since, r.clock.now);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/no rule evaluated \(this month's cap halt was cleared; the cap rule waits for a status read\)/);
      expect(r.meta.writes).toHaveLength(0);
      expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toBeNull();
      expect(r.cardCloses).toHaveLength(0);
    });

    describe("a cleared cap halt and an unread status (RK9-579)", () => {
      const clearedHalt: HaltState = {
        brandCode: "OLL",
        rule: "pause_all_cap",
        id: "cap-1",
        since: "2026-10-21T07:00:00.000Z",
        until: "2026-10-31T22:00:00.000Z",
        reason: "pause_all_cap test",
        initiator: { source: "job" },
        cap: { mtdEur: 92, monthlyCapEur: 100 },
      };
      const clearedKey = { scopeKind: "instance" as const, namespace: "spend-guard", stateKey: `halt-cleared:${COMPANY_A}:pause_all_cap` };
      /** The status read's first ad listing fails; the pause's own listing works. */
      function unreadStatus(): FakeMeta {
        const meta = overCap();
        let adLists = 0;
        meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/ads") && ++adLists === 1 ? new Error("graph down") : null);
        return meta;
      }
      async function clearedRig(halt: HaltState) {
        const r = setup({ meta: unreadStatus(), rules: LIVE_RULES });
        await setHalt(r.harness.ctx, COMPANY_A, halt);
        await clearHalt(r.harness.ctx, COMPANY_A, halt.since, r.clock.now);
        expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toBeNull();
        return r;
      }

      it("a board clear after monthlyCapEur was raised above the halt's cap does not make the cap rule wait", async () => {
        // Paused at 92 of a 90 EUR cap; the cap is now 100 EUR and the month at 95.
        const r = await clearedRig({ ...clearedHalt, cap: { mtdEur: 92, monthlyCapEur: 90 } });
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
        expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
        expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toMatchObject({ rule: "pause_all_cap", cap: { mtdEur: 95, monthlyCapEur: 100 } });
      });

      it("a board clear at a cap that was lowered since does not make the cap rule wait (RK9-582)", async () => {
        // Cleared at a 120 EUR cap; the cap is now 100 EUR and the month at 95.
        const r = await clearedRig({ ...clearedHalt, cap: { mtdEur: 92, monthlyCapEur: 120 } });
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
        expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      });

      it("a board clear at the cap it paused at makes the cap rule wait, and the marker names the board (RK9-582)", async () => {
        const r = await clearedRig(clearedHalt);
        expect(await r.harness.ctx.state.get(clearedKey)).toEqual({ id: "cap-1", by: "board" });
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/no rule evaluated \(this month's cap halt was cleared; the cap rule waits for a status read\)/);
        expect(r.meta.writes).toHaveLength(0);
      });

      it("a clear marker from before RK9-582 (no clearer) waits at the cap it paused at", async () => {
        const r = setup({ meta: unreadStatus(), rules: LIVE_RULES });
        await setHalt(r.harness.ctx, COMPANY_A, clearedHalt);
        await r.harness.ctx.state.set(clearedKey, "cap-1");
        expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toBeNull();
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/no rule evaluated \(this month's cap halt was cleared/);
        expect(r.meta.writes).toHaveLength(0);
      });

      it("a clear by the rules job does not make the cap rule wait, also at the cap it paused at (RK9-582)", async () => {
        const r = setup({ meta: unreadStatus(), rules: LIVE_RULES });
        await setHalt(r.harness.ctx, COMPANY_A, clearedHalt);
        await r.harness.ctx.state.set(clearedKey, { id: "cap-1", by: "rules_job" });
        expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toBeNull();
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
        expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      });

      it("a damaged clear marker clears nothing", async () => {
        const r = setup({ meta: unreadStatus(), rules: LIVE_RULES });
        await setHalt(r.harness.ctx, COMPANY_A, clearedHalt);
        await r.harness.ctx.state.set(clearedKey, { by: "board" });
        expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toMatchObject({ id: "cap-1" });
        // The halt is in force, so the cap rule runs and pauses.
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated/);
        expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      });

      it("a cleared halt without the cap figure waits, as only a board user clears one", async () => {
        const r = await clearedRig({ ...clearedHalt, cap: undefined });
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/no rule evaluated \(this month's cap halt was cleared/);
        expect(r.meta.writes).toHaveLength(0);
      });

      it("a cleared halt without until ends with the local month of its since", async () => {
        // Set in September (Helsinki): it ended at the start of October.
        const r = await clearedRig({ ...clearedHalt, since: "2026-09-29T07:00:00.000Z", until: undefined });
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
        expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      });

      it("a cleared halt without until set this month still makes the cap rule wait", async () => {
        const r = await clearedRig({ ...clearedHalt, until: undefined });
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/no rule evaluated \(this month's cap halt was cleared/);
        expect(r.meta.writes).toHaveLength(0);
      });

      it("a cleared halt without until or a readable since does not make the cap rule wait", async () => {
        const r = setup({ meta: unreadStatus(), rules: LIVE_RULES });
        const halt = { ...clearedHalt, since: "not a time", until: undefined };
        await setHalt(r.harness.ctx, COMPANY_A, halt);
        // clearHalt looks a halt up by since; the marker is what it would store.
        await r.harness.ctx.state.set(clearedKey, "cap-1");
        await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/only pause_all_cap evaluated \(fail-open\)/);
        expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      });
    });

    it("a failed attempt after a settled cap pause (retry not stored) gives no fallback cooldown (RK9-579)", async () => {
      const r = setup({ meta: overCap(), rules: LIVE_RULES, days: [] });
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
      const settledHalt = await readHalt(r.harness.ctx, COMPANY_A, r.clock.now);
      // The operator restarts the ads. Past the cooldown the next attempt's
      // PAUSED writes fail and the pause retry cannot be stored.
      for (const object of [...r.meta.campaigns, ...r.meta.ads]) if (object.id !== "302") object.status = "ACTIVE";
      r.meta.fail = (call) => (call.method !== "GET" ? new Response(JSON.stringify({ error: { message: "x", code: 2 } }), { status: 500 }) : null);
      const state = r.harness.ctx.state;
      const set = state.set.bind(state);
      state.set = async (input, value) => {
        if (input.stateKey.startsWith("pending-undo:")) throw new Error("state down");
        return set(input, value);
      };
      r.clock.now = new Date(NOW.getTime() + 25 * 3_600_000);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL pause_all_cap: 3 pause\(s\) failed/);
      expect(r.ledgerRuleActions().at(-1)).toMatchObject({
        rule_id: "pause_all_cap",
        metrics: expect.objectContaining({ settled: false, retry: expect.objectContaining({ stored: false }) }),
      });
      // That attempt left a new halt, which the settled marker does not name.
      expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).not.toMatchObject({ id: settledHalt!.id });
      r.meta.fail = () => null;
      state.set = set;
      r.store.priorActions = async () => {
        throw new Error("db down");
      };
      r.clock.now = new Date(NOW.getTime() + 26 * 3_600_000);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/only pause_all_cap evaluated, the cap halt in force is not from a settled cap pause, no cooldown/);
      expect(r.meta.writes.filter((call) => call.body.status === "PAUSED").slice(-3).map((call) => call.path)).toEqual(["100", "301", "303"]);
    });

    it("a settled-cap marker of another ad account gives no fallback cooldown (RK9-579)", async () => {
      const r = setup({ meta: overCap(), rules: LIVE_RULES, days: [] });
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes).toHaveLength(3);
      const key = { scopeKind: "instance" as const, namespace: "spend-guard", stateKey: `cap-settled:${COMPANY_A}` };
      const marker = (await r.harness.ctx.state.get(key)) as Record<string, unknown>;
      expect(marker).toMatchObject({ adAccountId: "29231592883113369" });
      await r.harness.ctx.state.set(key, { ...marker, adAccountId: "1336862981968191" });
      for (const object of [...r.meta.campaigns, ...r.meta.ads]) if (object.id !== "302") object.status = "ACTIVE";
      r.store.priorActions = async () => {
        throw new Error("db down");
      };
      r.clock.now = new Date(NOW.getTime() + 2 * 3_600_000);
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/the cap halt in force is not from a settled cap pause, no cooldown/);
      expect(r.meta.writes).toHaveLength(6);
    });

    it("a disabled config fails only the first run of each local day; an invalid one fails every run (RK9-541)", async () => {
      const r = setup({ rules: LIVE_RULES, days: [] });
      await r.harness.runJob(RULES_JOB_KEY);
      const valid = r.configs[COMPANY_A]!;
      const run = (hours: number) => {
        r.clock.now = new Date(NOW.getTime() + hours * 3_600_000);
        return r.harness.runJob(RULES_JOB_KEY);
      };
      r.configs[COMPANY_A] = { ...valid, monthlyCapEur: null };
      await expect(run(1)).rejects.toThrow(/OLL: the brand config is disabled; only pause_all_cap ran, on the last valid config/);
      await expect(run(2)).resolves.toBeUndefined();
      // The next local day reports it again.
      await expect(run(24)).rejects.toThrow(/the brand config is disabled/);
      r.configs[COMPANY_A] = { ...valid, rules: { list: [{ ruleId: "x", type: "nope" }] } };
      await expect(run(25)).rejects.toThrow(/the brand config is invalid/);
      await expect(run(26)).rejects.toThrow(/the brand config is invalid/);
    });

    it("fails the run when the cap pause's rule_actions row cannot be written", async () => {
      const r = setup({ meta: overCap(), rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
      const db = r.harness.ctx.db;
      const execute = db.execute.bind(db);
      db.execute = async (sql, params) => {
        if (/INSERT INTO \S+\.rule_actions/.test(sql)) throw new Error("ledger down");
        return execute(sql, params);
      };
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL pause_all_cap: rule_actions insert failed \(Error: ledger down\)/);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
    });
  });

});

describe("rules data and dry-run action (for the A12 UI)", () => {
  const UI = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "user-1" } };

  it("the dry run returns live decisions without writing anything", async () => {
    const r = setup({ rules: { liveMode: true, list: [CPC_LIVE] } });
    const result = await r.harness.performAction<{ liveMode: boolean; decisions: Array<Record<string, unknown>> }>(RULES_DRY_RUN_ACTION_KEY, {}, UI);
    expect(result.liveMode).toBe(true);
    expect(result.decisions).toEqual([expect.objectContaining({ ruleId: "cpc-ceiling", objectId: "301", mode: "live", applied: false })]);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.store.actions).toHaveLength(0);
    expect(r.ledgerRuleActions()).toHaveLength(0);
    expect(r.harness.activity).toHaveLength(0);
    expect(r.notifier.messages).toHaveLength(0);
  });

  it("serves the effective rules", async () => {
    const r = setup();
    const data = await r.harness.getData<{ state: string; liveMode: boolean; rules: Array<{ ruleId: string; mode: string }> }>(RULES_DATA_KEY, { companyId: COMPANY_A });
    expect(data.state).toBe("enabled");
    expect(data.liveMode).toBe(false);
    expect(data.rules.map((rule) => [rule.ruleId, rule.mode])).toEqual([
      ["cpc-ceiling", "shadow"],
      ["pause_all_cap", "shadow"],
    ]);
    expect(await r.harness.getData(RULES_DATA_KEY, {})).toEqual({ state: "error", error: "company context is required" });
  });
});


describe("the cap pause's halt ends when the month is back under the cap (RK9-565)", () => {
  const CAP_LIVE = { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] };
  const capHalt: HaltState = {
    brandCode: "OLL",
    rule: "pause_all_cap",
    id: "cap-halt-1",
    since: "2026-10-21T07:00:00.000Z",
    until: "2026-10-31T22:00:00.000Z",
    reason: "pause_all_cap test",
    initiator: { source: "job" },
    // Paused at 33 of a 36 EUR cap; the cap is now 100 EUR.
    cap: { mtdEur: 33, monthlyCapEur: 36 },
  };
  const at = async (r: ReturnType<typeof setup>, minutes: number) => {
    r.clock.now = new Date(NOW.getTime() + minutes * 60_000);
    await r.harness.runJob(RULES_JOB_KEY);
  };
  const halt = (r: ReturnType<typeof setup>) => readHalt(r.harness.ctx, COMPANY_A, r.clock.now);

  it("on the second consecutive run that reads headroom, at least 30 min after the first", async () => {
    const r = setup({ rules: CAP_LIVE }); // 40 % of the cap
    await setHalt(r.harness.ctx, COMPANY_A, capHalt);
    await at(r, 0);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
    await at(r, 10); // a manual re-run right after is not a second tick
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
    await at(r, 60);
    expect(await halt(r)).toBeNull();
    expect(r.harness.activity.find((entry) => entry.message === CAP_HALT_RELEASED_ACTIVITY)).toMatchObject({
      metadata: { halt: { id: "cap-halt-1" }, clearedBy: { rulesJob: expect.any(String) } },
    });
    expect(r.notifier.messages.at(-1)!.text).toContain("kulutuskaton pysäytystila poistettu");
    // Nothing paused, nothing activated.
    expect(r.meta.writes).toEqual([]);
  });

  it("after the release, the cap rule still pauses at 90 % of the new cap when the status is unread (RK9-579)", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, capHalt);
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toBeNull();
    // The month passes 90 % of the raised cap; the status read fails.
    r.meta.spend = () => "95.00";
    let adLists = 0;
    r.meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/ads") && ++adLists === 1 ? new Error("graph down") : null);
    r.clock.now = new Date(NOW.getTime() + 120 * 60_000);
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([
      ["100", "PAUSED"],
      ["301", "PAUSED"],
      ["303", "PAUSED"],
    ]);
    expect(await halt(r)).toMatchObject({ rule: "pause_all_cap", cap: { mtdEur: 95, monthlyCapEur: 100 } });
  });

  it("after the release and a cap lowered back to the one it paused at, the cap rule pauses when the status is unread (RK9-582)", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, capHalt);
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toBeNull();
    expect(await r.harness.ctx.state.get({ scopeKind: "instance", namespace: "spend-guard", stateKey: `halt-cleared:${COMPANY_A}:pause_all_cap` })).toEqual({
      id: "cap-halt-1",
      by: "rules_job",
    });
    // The operator lowers the cap back to 36 EUR; the month is at 40 and the status read fails.
    r.configs[COMPANY_A] = { ...r.configs[COMPANY_A]!, monthlyCapEur: 36 };
    let adLists = 0;
    r.meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/ads") && ++adLists === 1 ? new Error("graph down") : null);
    r.clock.now = new Date(NOW.getTime() + 120 * 60_000);
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed \(.*graph down\)+, only pause_all_cap evaluated \(fail-open\)/);
    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([
      ["100", "PAUSED"],
      ["301", "PAUSED"],
      ["303", "PAUSED"],
    ]);
  });

  it("a run that cannot read the month starts the count again", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, capHalt);
    await at(r, 0);
    r.meta.fail = (call) => (call.path.endsWith("/insights") ? new Response(JSON.stringify({ error: { message: "x", code: 1 } }), { status: 500 }) : null);
    r.clock.now = new Date(NOW.getTime() + 60 * 60_000);
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/month-to-date not read/);
    r.meta.fail = () => null;
    await at(r, 120);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
    await at(r, 180);
    expect(await halt(r)).toBeNull();
  });

  it("a reading below the MTD the halt stored is no headroom (an empty insights answer reads as 0)", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, { ...capHalt, cap: { mtdEur: 95, monthlyCapEur: 100 } });
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
  });

  it("a first reading from before skipped runs counts as none", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, capHalt);
    await at(r, 0);
    await at(r, 180); // runs at +60 and +120 did not see the company
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
    await at(r, 240);
    expect(await halt(r)).toBeNull();
  });

  it("a damaged cap figure waits for the board and does not fail the run", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, { ...capHalt, cap: null } as unknown as HaltState);
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
  });

  it("a damaged cap with a valid MTD waits for the board (RK9-582)", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, { ...capHalt, cap: { mtdEur: 33, monthlyCapEur: "36" } } as unknown as HaltState);
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
    expect(r.harness.activity.find((entry) => entry.message === CAP_HALT_RELEASED_ACTIVITY)).toBeUndefined();
  });

  it("a cap halt without the figures waits for the board", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, { ...capHalt, cap: undefined });
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
  });

  it("a run whose status read fails starts the count again", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, capHalt);
    await at(r, 0);
    r.meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") ? new Error("graph down") : null);
    r.clock.now = new Date(NOW.getTime() + 60 * 60_000);
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/Meta status read failed/);
    r.meta.fail = () => null;
    await at(r, 120);
    expect(await halt(r)).toMatchObject({ id: "cap-halt-1" });
    await at(r, 180);
    expect(await halt(r)).toBeNull();
  });

  it("the live cap pause stores its MTD and cap on the halt", async () => {
    const meta = accountMeta();
    meta.spend = () => "95.00";
    const r = setup({ meta, rules: CAP_LIVE });
    await at(r, 0);
    expect(await halt(r)).toMatchObject({ rule: "pause_all_cap", cap: { mtdEur: 95, monthlyCapEur: 100 } });
  });

  it("leaves the kill switch's halt alone", async () => {
    const r = setup({ rules: CAP_LIVE });
    await setHalt(r.harness.ctx, COMPANY_A, { ...capHalt, rule: "kill_switch", id: "ks-1", until: undefined });
    await at(r, 0);
    await at(r, 60);
    expect(await halt(r)).toMatchObject({ rule: "kill_switch" });
  });
});
