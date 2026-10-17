import type { Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createLedger } from "../src/db.js";
import type { RuleAdDay } from "../src/features/rules/evaluate.js";
import { registerRules, RULES_DATA_KEY, RULES_DRY_RUN_ACTION_KEY } from "../src/features/rules/register.js";
import { RULES_JOB_KEY } from "../src/features/rules/runner.js";
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
    await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: Meta status read failed, nothing paused \(fail-open\)/);
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
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL: earlier rule actions not read \(Error: priorActions: more than 5000 rows\), only pause_all_cap ran/);
      // The CPC rule made no decision without its cooldown; the cap rule paused the account.
      expect(r.store.actions).toHaveLength(0);
      expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual(capPauses);
    });

    it("a pause_all that leaves an object ACTIVE fails the run and is not counted against the cooldown", async () => {
      const meta = overCap();
      meta.fail = (call) => (call.method !== "GET" && call.path === "303" ? new Response(JSON.stringify({ error: { message: "x", code: 2 } }), { status: 500 }) : null);
      const r = setup({ meta, rules: { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] } });
      await expect(r.harness.runJob(RULES_JOB_KEY)).rejects.toThrow(/OLL pause_all_cap: 1 pause\(s\) failed/);
      expect(r.ledgerRuleActions()).toEqual([expect.objectContaining({ rule_id: "pause_all_cap", applied: true, error: expect.stringContaining("303") })]);
      // Such a row (applied, with an error) does not start the cooldown: the store
      // reads it as not applied (SQL: rules.store-db.spec.ts), so the next run retries.
      await r.store.insertAction(COMPANY_A, {
        brandCode: "OLL",
        ruleId: "pause_all_cap",
        ruleType: "pause_all_cap",
        objectType: "account",
        objectId: "29231592883113369",
        action: "pause_all",
        mode: "live",
        dryRun: false,
        applied: true,
        reason: "cap",
        metrics: {},
        error: "303: x",
        decidedAt: NOW,
      });
      expect(await r.store.priorActions(COMPANY_A, ["pause_all_cap"], new Date(0))).toEqual([expect.objectContaining({ ruleId: "pause_all_cap", applied: false })]);
      r.clock.now = new Date(NOW.getTime() + 3_600_000);
      meta.fail = () => null;
      await r.harness.runJob(RULES_JOB_KEY);
      expect(r.meta.writes.filter((call) => call.path === "303")).toHaveLength(2);
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
