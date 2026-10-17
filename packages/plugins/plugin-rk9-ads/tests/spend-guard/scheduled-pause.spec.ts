import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "../../src/config.js";
import { alertKey, riskKey } from "../../src/features/spend-guard/alerts.js";
import { evaluateDataGate, resolveJsonPointer } from "../../src/features/spend-guard/data-gate.js";
import { ALERT_CHECK_INTERVAL_MS, scheduledPauseKey } from "../../src/features/spend-guard/scheduled-pause.js";
import { brandConfig, COMPANY_A } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";
import { rig, telegramBlock } from "./rig.js";

const FEED = "https://feed.example/api/feed";

function activeMeta(): FakeMeta {
  const meta = new FakeMeta();
  meta.spend = () => "10.00";
  meta.account = { ...meta.account, amount_spent: "1000" };
  meta.campaigns = [{ id: "100", name: "OLL", status: "ACTIVE" }];
  meta.adsets = [{ id: "200", name: "set", status: "ACTIVE", campaign_id: "100", daily_budget: "300" }];
  meta.ads = [{ id: "301", name: "ad", status: "ACTIVE", campaign_id: "100" }];
  return meta;
}

function reactivate(meta: FakeMeta): void {
  for (const object of [...meta.campaigns, ...meta.ads]) {
    object.status = "ACTIVE";
    object.effective_status = "ACTIVE";
  }
}

function scheduled(extra: Record<string, unknown> = {}) {
  return brandConfig({ telegram: telegramBlock(), schedule: { scheduledPause: { enabled: true, at: "21:30" }, ...extra } });
}

const pauses = (meta: FakeMeta) => meta.writes.filter((call) => call.body.status === "PAUSED").length;

describe("scheduled pause job", () => {
  it("is off by default and for the Ololla config", async () => {
    const parsed = parseBrandConfig(brandConfig());
    expect(parsed.state === "enabled" && parsed.config.schedule).toEqual({ scheduledPause: { enabled: false, at: "21:30" } });
    const r = rig({ meta: activeMeta() });
    r.clock.now = new Date("2026-10-21T19:00:00Z"); // 22:00 EEST
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(0);
  });

  it("fires at 21:30 Helsinki in EET and in EEST, once per local day", async () => {
    const r = rig({ meta: activeMeta(), config: scheduled() });
    const tick = async (iso: string) => {
      r.clock.now = new Date(iso);
      await r.harness.runJob("scheduled-pause");
    };

    await tick("2026-03-28T19:29:00Z"); // 21:29 EET
    expect(pauses(r.meta)).toBe(0);
    await tick("2026-03-28T19:30:00Z"); // 21:30 EET
    expect(pauses(r.meta)).toBe(2);
    expect(r.notifier.messages).toHaveLength(1);
    expect(r.store.keys()).toContain(`${COMPANY_A}|${scheduledPauseKey("OLL", "2026-03-28")}`);
    // The pause closes the open activation cards (RK9-557).
    expect(r.cardCloses).toEqual([{ companyId: COMPANY_A, rule: "scheduled_pause", reason: "scheduled pause at 21:30 Europe/Helsinki" }]);

    // Someone turns the ads back on: the same local day does not pause again.
    reactivate(r.meta);
    await tick("2026-03-28T21:55:00Z"); // 23:55 EET
    await tick("2026-03-28T22:05:00Z"); // 00:05 next day, before 21:30
    expect(pauses(r.meta)).toBe(2);

    // DST started at 01:00Z on 29.3.: 21:30 is now 18:30Z.
    await tick("2026-03-29T18:29:00Z"); // 21:29 EEST
    expect(pauses(r.meta)).toBe(2);
    await tick("2026-03-29T18:30:00Z"); // 21:30 EEST
    expect(pauses(r.meta)).toBe(4);
    expect(r.ruleActions().filter((row) => row.rule_type === "scheduled_pause")).toHaveLength(2);
  });

  it("keeps the meta.campaignId scope (pulse schedule, not the kill switch)", async () => {
    const meta = activeMeta();
    meta.campaigns.push({ id: "777", name: "Käsin", status: "ACTIVE" });
    meta.ads.push({ id: "999", name: "toinen", status: "ACTIVE", campaign_id: "777" });
    const config = scheduled();
    (config.meta as Record<string, unknown>).campaignId = "100";
    const r = rig({ meta, config });
    r.clock.now = new Date("2026-10-21T18:30:00Z"); // 21:30 EEST
    await r.harness.runJob("scheduled-pause");
    expect(meta.writes.map((call) => call.path).sort()).toEqual(["100", "301"]);
    expect(r.ruleActions().find((row) => row.rule_type === "scheduled_pause")).toMatchObject({ object_type: "campaign", object_id: "100" });
  });

  it("fires at 21:30 across the October change back to EET", async () => {
    const r = rig({ meta: activeMeta(), config: scheduled() });
    r.clock.now = new Date("2026-10-24T18:30:00Z"); // 21:30 EEST, Saturday
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(2);
    reactivate(r.meta);
    r.clock.now = new Date("2026-10-25T18:30:00Z"); // 20:30 EET on Sunday: too early
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(2);
    r.clock.now = new Date("2026-10-25T19:30:00Z"); // 21:30 EET
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(4);
  });

  it("marks the day once nothing is left to pause, without Telegram", async () => {
    const meta = activeMeta();
    meta.campaigns[0]!.status = "PAUSED";
    meta.ads[0]!.status = "PAUSED";
    const r = rig({ meta, config: scheduled() });
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(0);
    expect(r.notifier.messages).toHaveLength(0);
    expect(r.store.keys()).toContain(`${COMPANY_A}|${scheduledPauseKey("OLL", "2026-10-21")}`);
  });

  it("keeps the pauses, audits and fails the run when Telegram fails (pulse-off exit 3)", async () => {
    const r = rig({ meta: activeMeta(), config: scheduled() });
    r.notifier.fail = new Error("Telegram sendMessage failed (502)");
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/Telegram notice failed/);
    expect(pauses(r.meta)).toBe(2);
    const row = r.ruleActions().find((entry) => entry.rule_type === "scheduled_pause");
    expect(row).toMatchObject({ applied: true, source: "job" });
    expect(row!.metrics).toMatchObject({ telegram: "failed" });
    expect(r.harness.activity.some((entry) => /scheduled_pause paused 2/.test(entry.message))).toBe(true);
    // The pause is done for the day: a retry does not pause or message again.
    r.notifier.fail = null;
    r.clock.now = new Date("2026-10-21T18:36:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(2);
    expect(r.notifier.messages).toHaveLength(0);
  });

  it("retries on the next tick when a Meta pause failed", async () => {
    const meta = activeMeta();
    let failing = true;
    meta.fail = (call) =>
      failing && call.method === "POST" ? new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 }) : null;
    const r = rig({ meta, config: scheduled() });
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/pause\(s\) failed/);
    expect(r.store.keys().some((key) => key.includes("scheduled-pause"))).toBe(false);
    failing = false;
    r.clock.now = new Date("2026-10-21T18:36:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(meta.campaigns[0]!.status).toBe("PAUSED");
    expect(meta.ads[0]!.status).toBe("PAUSED");
  });
});

describe("pause side on an invalid or unavailable config (README ADR 3)", () => {
  const UI = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "u" } };

  it("pauses on the last valid config when the config turns invalid, and fails the run", async () => {
    const r = rig({ meta: activeMeta(), config: scheduled() });
    await r.harness.runJob("scheduled-pause"); // 12:00 local: remembers the valid config
    r.harness.ctx.config.get = async () => ({ ...scheduled(), timeZone: "Europe/Helsinkii" });
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/OLL: the brand config is invalid; pause side ran on the last valid config/);
    expect(pauses(r.meta)).toBe(2);
    expect(r.ruleActions().find((row) => row.rule_type === "scheduled_pause")).toMatchObject({ applied: true });
  });

  it("pauses on the last valid config when the host refuses the config, also from the kill switch", async () => {
    const r = rig({ meta: activeMeta(), config: scheduled() });
    await r.harness.runJob("scheduled-pause");
    r.harness.ctx.config.get = async () => {
      throw new Error("company context is required");
    };
    const result = await r.harness.performAction<{ count: number; fallbackConfig: string; scope: string }>("pause-all", { dryRun: false, confirm: true }, UI);
    expect(result).toMatchObject({ count: 2, fallbackConfig: "unavailable", scope: "account" });
    expect(r.ruleActions().at(-1)!.reason).toMatch(/konfiguraatio unavailable: viimeisin kelvollinen, koko mainostili/);
    reactivate(r.meta);
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/the brand config is unavailable; pause side ran/);
    expect(pauses(r.meta)).toBe(4);
  });

  it("pauses the whole ad account on a fallback, even when the stored config was scoped to a campaign", async () => {
    const meta = activeMeta();
    meta.campaigns.push({ id: "900", name: "uusi", status: "ACTIVE" });
    meta.ads.push({ id: "902", name: "uusi ad", status: "ACTIVE", campaign_id: "900" });
    const valid = { ...scheduled(), meta: { ...(scheduled().meta as Record<string, unknown>), campaignId: "100" } };
    const r = rig({ meta, config: valid });
    await r.harness.runJob("scheduled-pause");
    // One broken save moves the campaign and breaks the time zone.
    r.harness.ctx.config.get = async () => ({ ...valid, timeZone: "Europe/Helsinkii", meta: { ...valid.meta, campaignId: "900" } });
    const tool = await r.harness.executeTool<{ content: string }>("rk9ads_pause_all", { reason: "hätä" }, { companyId: COMPANY_A });
    expect(tool.content).toMatch(/The brand config is invalid: paused the whole ad account on the last valid config/);
    expect(meta.ads.every((ad) => ad.status === "PAUSED")).toBe(true);
    expect(meta.campaigns.every((campaign) => campaign.status === "PAUSED")).toBe(true);
  });

  it("fails the run loudly when there is no last valid config, and pauses nothing", async () => {
    const r = rig({ meta: activeMeta(), config: { ...scheduled(), timeZone: "Europe/Helsinkii" } });
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/invalid and there is no last valid config to pause with; nothing paused/);
    await expect(r.harness.performAction("pause-all", { dryRun: false, confirm: true }, UI)).rejects.toThrow(/no last valid config/);
    expect(r.meta.writes).toHaveLength(0);
  });

  it("skips a disabled brand that was never enabled, but pauses one that was (RK9-510)", async () => {
    const r = rig({ meta: activeMeta(), config: { ...scheduled(), monthlyCapEur: null } });
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).resolves.toBeUndefined();
    expect(r.meta.writes).toHaveLength(0);

    const later = rig({ meta: activeMeta(), config: scheduled() });
    await later.harness.runJob("scheduled-pause");
    later.harness.ctx.config.get = async () => ({ ...scheduled(), monthlyCapEur: null });
    later.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(later.harness.runJob("scheduled-pause")).rejects.toThrow(/OLL: the brand config is disabled; pause side ran on the last valid config/);
    expect(pauses(later.meta)).toBe(2);
  });

  it("still pauses when the day marker cannot be read", async () => {
    const r = rig({ meta: activeMeta(), config: scheduled() });
    r.store.claimed = async () => {
      throw new Error("db down");
    };
    r.clock.now = new Date("2026-10-21T18:31:00Z");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/marker read failed \(Error: db down\), paused anyway/);
    expect(pauses(r.meta)).toBe(2);
  });
});

describe("data gate", () => {
  const gate = { url: FEED, jsonPointer: "/stats/inSun", operator: "gte" as const, threshold: 8 };

  function gateRig(feed: () => Response | Promise<Response>) {
    const r = rig({ meta: activeMeta(), config: brandConfig({ telegram: telegramBlock(), schedule: { dataGate: gate } }) });
    r.feeds.set(FEED, feed);
    r.clock.now = new Date("2026-07-15T10:00:00Z");
    return r;
  }

  it("does nothing while the predicate holds", async () => {
    const r = gateRig(() => new Response(JSON.stringify({ stats: { inSun: 8 } })));
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(0);
  });

  it("pauses everything once the predicate fails, then stays quiet", async () => {
    const r = gateRig(() => new Response(JSON.stringify({ stats: { inSun: 3 } })));
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(2);
    expect(r.notifier.messages[0]!.text).toContain("data-gate: arvo 3");
    r.clock.now = new Date("2026-07-15T10:05:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(pauses(r.meta)).toBe(2);
    expect(r.notifier.messages).toHaveLength(1);
    expect(r.ruleActions().filter((row) => row.rule_type === "data_gate")).toHaveLength(1);
  });

  it.each([
    ["unreachable", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["HTTP 503", () => new Response("down", { status: 503 })],
    ["not JSON", () => new Response("<html>")],
    ["no number at the pointer", () => new Response(JSON.stringify({ stats: {} }))],
  ])("fails open when the feed is %s: pauses nothing, warns and fails the run so it is seen", async (_label, feed) => {
    const r = gateRig(feed as () => Response);
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/OLL data gate: feed check failed \(feed_\w+|value_missing/);
    expect(pauses(r.meta)).toBe(0);
    expect(r.harness.logs.some((entry) => entry.level === "warn" && /fail-open/.test(entry.message))).toBe(true);
  });

  it("reads numbers, numeric strings and array lengths through RFC 6901 pointers", async () => {
    expect(resolveJsonPointer({ "a/b": { "c~d": [1, 2] } }, "/a~1b/c~0d/1")).toBe(2);
    const fetchJson = (body: unknown) => async () => new Response(JSON.stringify(body));
    expect(await evaluateDataGate(fetchJson({ x: ["a", "b"] }), { ...gate, jsonPointer: "/x", threshold: 2 })).toEqual({
      action: "skip",
      reason: "predicate_holds",
      value: 2,
    });
    expect(await evaluateDataGate(fetchJson({ x: "7" }), { ...gate, jsonPointer: "/x" })).toEqual({ action: "pause", value: 7 });
  });
});

describe("MTD alerts", () => {
  /** MTD and Meta's amount_spent move together; spend_cap 100 EUR, so Meta stays the backstop. */
  function setMtd(meta: FakeMeta, mtd: string): void {
    meta.spend = () => mtd;
    meta.account = { ...meta.account, amount_spent: String(Math.round(Number(mtd) * 100)) };
  }

  function alertRig(mtd: string, config = brandConfig({ telegram: telegramBlock() })) {
    const meta = new FakeMeta();
    setMtd(meta, mtd);
    return rig({ meta, config });
  }

  it("sends 80 % and 100 % once per month each, as a pause card", async () => {
    const r = alertRig("81.00");
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
    expect(r.notifier.cards[0]!.text).toMatch(/kulutus 81 % katosta/);

    // Within the check interval nothing is read again.
    const reads = r.meta.calls.length;
    r.clock.now = new Date(r.clock.now.getTime() + 60_000);
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.calls.length).toBe(reads);

    // Later the same month at 85 %: no repeat.
    setMtd(r.meta, "85.00");
    r.clock.now = new Date(r.clock.now.getTime() + ALERT_CHECK_INTERVAL_MS);
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);

    // 100 %: the second threshold.
    setMtd(r.meta, "100.00");
    r.clock.now = new Date(r.clock.now.getTime() + ALERT_CHECK_INTERVAL_MS);
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(2);
    expect(r.notifier.cards[1]!.text).toMatch(/katto täynnä/);

    // A new Helsinki month resets the thresholds (Meta's cap reset too, G2).
    setMtd(r.meta, "80.00");
    r.clock.now = new Date("2026-10-31T22:30:00Z"); // 00:30 on 1.11. in Helsinki
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(3);
    expect(r.store.keys()).toEqual([
      `${COMPANY_A}|${alertKey("OLL", "2026-10", 80)}`,
      `${COMPANY_A}|${alertKey("OLL", "2026-10", 100)}`,
      `${COMPANY_A}|${alertKey("OLL", "2026-11", 80)}`,
    ]);
    expect(r.ruleActions().map((row) => row.rule_id)).toEqual(["spend-alert-80", "spend-alert-100", "spend-alert-80"]);
  });

  it("sends one card for a jump straight past 100 % and claims both thresholds", async () => {
    const r = alertRig("120.00");
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
    expect(r.notifier.cards[0]!.text).toMatch(/katto täynnä/);
    // Meta's spend_cap is used up (headroom -20 EUR), so Meta delivers nothing more: no overrun risk.
    expect(r.notifier.cards[0]!.text).not.toMatch(/ylittää katon/);
    expect(r.store.keys()).toEqual([`${COMPANY_A}|${alertKey("OLL", "2026-10", 80)}`, `${COMPANY_A}|${alertKey("OLL", "2026-10", 100)}`]);
  });

  it("does not claim a threshold for a brand without Telegram", async () => {
    const r = alertRig("90.00", brandConfig());
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(0);
    expect(r.store.keys()).toHaveLength(0);
  });

  it("fails the run when the alert cannot be sent, gives the marker back and sends on the next check", async () => {
    const r = alertRig("81.00");
    r.notifier.fail = new Error("Telegram 502");
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/alert 80 %: Telegram failed .*retrying next check/);
    expect(r.store.keys()).toEqual([]);
    expect(r.ruleActions()[0]).toMatchObject({ rule_id: "spend-alert-80", applied: false });
    r.notifier.fail = null;
    r.clock.now = new Date(r.clock.now.getTime() + ALERT_CHECK_INTERVAL_MS);
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
    expect(r.store.keys()).toEqual([`${COMPANY_A}|${alertKey("OLL", "2026-10", 80)}`]);
    // Sent once: the next check does not repeat it.
    r.clock.now = new Date(r.clock.now.getTime() + ALERT_CHECK_INTERVAL_MS);
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
  });

  it("alerts once per local day when Meta's spend_cap is no backstop (headroom above the rest of the cap)", async () => {
    const r = alertRig("10.00");
    // Meta would allow 200 - 10 = 190 EUR more, 90 EUR of the month is left.
    r.meta.account = { ...r.meta.account, spend_cap: "20000" };
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
    expect(r.notifier.cards[0]!.text).toMatch(/kulutusvahdin varoitus/);
    expect(r.notifier.cards[0]!.text).toMatch(/spend_cap sallii vielä 190,00 €, mutta katosta on jäljellä 90,00 €/);
    expect(r.ruleActions().map((row) => [row.rule_id, row.reason, row.applied])).toEqual([
      ["spend-risk-spend_cap_headroom_exceeds_remaining", "spend_cap_headroom_exceeds_remaining", true],
    ]);

    // The same local day: no repeat.
    r.clock.now = new Date(r.clock.now.getTime() + ALERT_CHECK_INTERVAL_MS);
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);

    // The next local day, still unresolved: alerted again.
    r.clock.now = new Date("2026-10-22T05:00:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(2);
  });

  it("alerts when the account has no spend_cap", async () => {
    const r = alertRig("10.00");
    r.meta.account = { ...r.meta.account, spend_cap: "0" };
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
    expect(r.notifier.cards[0]!.text).toMatch(/spend_cap puuttuu/);
  });

  it("alerts when the current budgets project above the cap, below 80 %", async () => {
    const r = alertRig("50.00");
    // 50 + 5 EUR/day x 11 days = 105 EUR on 21.10.
    r.meta.adsets = [{ id: "200", name: "set", status: "ACTIVE", daily_budget: "500" }];
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
    expect(r.notifier.cards[0]!.text).toMatch(/arvio 105,00 € ylittää katon 100,00 €/);
    expect(r.store.keys()).toEqual([`${COMPANY_A}|${riskKey("OLL", "2026-10-21", "projection_exceeds_cap")}`]);
  });

  it("sends nothing while Meta is the backstop and the budgets fit the cap", async () => {
    const r = alertRig("50.00");
    r.meta.adsets = [{ id: "200", name: "set", status: "ACTIVE", daily_budget: "300" }];
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(0);
    expect(r.store.keys()).toEqual([]);
  });

  it("fails the run, skips alerts and retries next tick when the MTD read fails", async () => {
    const r = alertRig("81.00");
    r.meta.fail = (call) => (call.path.endsWith("/insights") ? new Error("timeout") : null);
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/OLL alerts: MTD not read \(meta_read_failed/);
    expect(r.notifier.cards).toHaveLength(0);
    r.meta.fail = () => null;
    r.clock.now = new Date(r.clock.now.getTime() + 5 * 60_000);
    await r.harness.runJob("scheduled-pause");
    expect(r.notifier.cards).toHaveLength(1);
  });
});

describe("getData spend-guard and the pacing tool", () => {
  it("returns the figures and alerted thresholds, never a token", async () => {
    const meta = new FakeMeta();
    meta.spend = () => "81.00";
    meta.account = { ...meta.account, amount_spent: "8100" };
    meta.adsets = [{ id: "200", status: "ACTIVE", daily_budget: "100" }];
    const r = rig({ meta });
    await r.harness.runJob("scheduled-pause");
    const data = await r.harness.getData<Record<string, unknown>>("spend-guard", { companyId: COMPANY_A });
    expect(data).toMatchObject({
      state: "enabled",
      brandCode: "OLL",
      month: "2026-10",
      monthlyCapEur: 100,
      spendCapEur: 100,
      amountSpentEur: 81,
      mtdEur: 81,
      projectedMonthEndEur: 92,
      pctUsed: 81,
      alertedThresholds: [80],
      allow: true,
    });
    expect(JSON.stringify(data)).not.toMatch(/EAA|token|secret/i);
    expect(await r.harness.getData("spend-guard", {})).toMatchObject({ state: "error" });

    const pacing = await r.harness.executeTool<{ content: string }>("rk9ads_get_pacing", {}, { companyId: COMPANY_A });
    expect(pacing.content).toMatch(/spent 81 EUR of 100 EUR \(81 %\)/);
  });
});
