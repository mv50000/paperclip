import { describe, expect, it } from "vitest";
import type { PauseAllResult } from "../../src/features/spend-guard/killswitch.js";
import type { GateRequestRecord } from "../../src/kit/gate/state-machine.js";
import { brandConfig, COMPANY_A } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";
import { APPROVER, gateRegistry, META_TOKEN, rig, telegramBlock } from "./rig.js";

function accountMeta(): FakeMeta {
  const meta = new FakeMeta();
  meta.campaigns = [
    { id: "100", name: "OLL jatkuva", status: "ACTIVE" },
    { id: "101", name: "OLL vanha", status: "PAUSED" },
  ];
  meta.ads = [
    { id: "301", name: "Syksy 1", status: "ACTIVE", campaign_id: "100" },
    { id: "302", name: "Syksy 2", status: "ACTIVE", campaign_id: "100" },
    // ACTIVE under a paused ad set: still paused, so it cannot come back with the ad set.
    { id: "303", name: "Syksy 3", status: "ACTIVE", effective_status: "ADSET_PAUSED", campaign_id: "100" },
    { id: "304", name: "Kesä", status: "PAUSED", campaign_id: "101" },
  ];
  return meta;
}

const UI = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "user-1" } };

describe("kill switch pauseAll", () => {
  it("dry run lists every ACTIVE ad and campaign, writes nothing to Meta and sends no Telegram", async () => {
    const r = rig({ meta: accountMeta() });
    const result = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: true }, UI);
    expect(result).toMatchObject({ dryRun: true, scope: "account", count: 4, campaignPaused: true, telegram: "skipped" });
    expect(result.pausedAds.map((ad) => ad.id)).toEqual(["301", "302", "303"]);
    expect(result.pausedCampaigns.map((campaign) => campaign.id)).toEqual(["100"]);
    expect(result.list).toEqual(["mainos Syksy 1 (301)", "mainos Syksy 2 (302)", "mainos Syksy 3 (303)", "kampanja OLL jatkuva (100)"]);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.notifier.messages).toHaveLength(0);
    expect(r.ruleActions()).toEqual([
      expect.objectContaining({ rule_type: "kill_switch", action: "pause_all", source: "ui", dry_run: true, applied: false, mode: "shadow" }),
    ]);
  });

  it("defaults to a dry run and refuses a live run without confirm", async () => {
    const r = rig({ meta: accountMeta() });
    expect((await r.harness.performAction<PauseAllResult>("pause-all", {}, UI)).dryRun).toBe(true);
    await expect(r.harness.performAction("pause-all", { dryRun: false }, UI)).rejects.toThrow(/confirm/);
    await expect(r.harness.performAction("pause-all", { dryRun: true }, { actor: { type: "user", userId: "u" } })).rejects.toThrow(
      /company context/,
    );
    expect(r.meta.writes).toHaveLength(0);
  });

  it("pauses ads then the campaign, notifies once, and a second run is a no-op with count 0 and no Telegram", async () => {
    const r = rig({ meta: accountMeta() });
    const first = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: false, confirm: true, reason: "testi" }, UI);
    expect(first).toMatchObject({ dryRun: false, count: 4, telegram: "sent", errors: [] });
    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([
      ["301", "PAUSED"],
      ["302", "PAUSED"],
      ["303", "PAUSED"],
      ["100", "PAUSED"],
    ]);
    // The token travels only in the Authorization header.
    expect(JSON.stringify(r.meta.calls)).not.toContain(META_TOKEN);
    expect(r.notifier.messages).toHaveLength(1);
    expect(r.notifier.messages[0]!.text).toContain("1 kampanja(a) ja 3 mainos(ta)");

    const second = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: false, confirm: true }, UI);
    expect(second).toMatchObject({ count: 0, telegram: "skipped", pausedAds: [], pausedCampaigns: [] });
    expect(r.meta.writes).toHaveLength(4);
    expect(r.notifier.messages).toHaveLength(1);

    const rows = r.ruleActions();
    expect(rows[0]).toMatchObject({ applied: true, dry_run: false, mode: "live", reason: "testi" });
    expect(rows[0]!.metrics).toMatchObject({ count: 4, adIds: ["301", "302", "303"], campaignIds: ["100"], initiator: { source: "ui", userId: "user-1" } });
    expect(r.harness.activity.some((entry) => /kill_switch paused 4/.test(entry.message))).toBe(true);
  });

  it("pages through every ACTIVE ad of the ad account (no 50-item limit)", async () => {
    const meta = new FakeMeta();
    meta.pageSize = 25;
    meta.campaigns = [{ id: "120247250925830775", name: "Aurinkopulssi", status: "ACTIVE" }];
    meta.ads = Array.from({ length: 130 }, (_, index) => ({
      id: String(500_000 + index),
      name: `ad ${index}`,
      status: index % 10 === 0 ? "PAUSED" : "ACTIVE",
      campaign_id: "120247250925830775",
    }));
    const r = rig({ meta });
    const result = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: false, confirm: true }, UI);
    expect(result).toMatchObject({ scope: "account", count: 118, campaignPaused: true });
    expect(meta.calls.filter((call) => call.path === "act_29231592883113369/ads")).toHaveLength(6);
  });

  it("pauses every ACTIVE campaign of the ad account, also one outside meta.campaignId (RK9-523)", async () => {
    const meta = new FakeMeta();
    meta.campaigns = [
      { id: "120247250925830775", name: "Configissa", status: "ACTIVE" },
      { id: "777", name: "Käsin Metan UI:ssa", status: "ACTIVE" },
      { id: "778", name: "Vanha", status: "PAUSED" },
    ];
    meta.ads = [
      { id: "501", name: "configin mainos", status: "ACTIVE", campaign_id: "120247250925830775" },
      { id: "999", name: "toisen kampanjan", status: "ACTIVE", campaign_id: "777" },
    ];
    const config = brandConfig({ telegram: telegramBlock() });
    (config.meta as Record<string, unknown>).campaignId = "120247250925830775";
    const r = rig({ meta, config });
    const result = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: false, confirm: true, reason: "hätä" }, UI);

    expect(result).toMatchObject({ scope: "account", count: 4, errors: [], telegram: "sent" });
    expect(result.pausedCampaigns.map((campaign) => campaign.id)).toEqual(["120247250925830775", "777"]);
    expect(meta.campaigns.map((campaign) => [campaign.id, campaign.status])).toEqual([
      ["120247250925830775", "PAUSED"],
      ["777", "PAUSED"],
      ["778", "PAUSED"],
    ]);
    expect(meta.ads.every((ad) => ad.status === "PAUSED")).toBe(true);
    // spend_cap is never written (G2): only status writes.
    expect(meta.writes.every((call) => Object.keys(call.body).join() === "status" && call.body.status === "PAUSED")).toBe(true);
    expect(meta.writes.some((call) => call.path.startsWith("act_"))).toBe(false);

    // Every paused campaign is in the ledger and in the Telegram notice, for the restore.
    const row = r.ruleActions()[0]!;
    expect(row).toMatchObject({ object_type: "account", object_id: "29231592883113369", applied: true });
    expect(row.metrics).toMatchObject({
      scope: "account",
      campaignIds: ["120247250925830775", "777"],
      campaigns: [
        { id: "120247250925830775", name: "Configissa" },
        { id: "777", name: "Käsin Metan UI:ssa" },
      ],
    });
    const notice = r.notifier.messages[0]!.text;
    expect(notice).toContain("koko mainostili pysäytetty");
    expect(notice).toContain("• kampanja Configissa (120247250925830775)");
    expect(notice).toContain("• kampanja Käsin Metan UI:ssa (777)");
  });

  it("lists every paused campaign in the notice even when the ads overflow the list", async () => {
    const meta = new FakeMeta();
    meta.campaigns = Array.from({ length: 5 }, (_, index) => ({ id: String(700 + index), name: `k${index}`, status: "ACTIVE" }));
    meta.ads = Array.from({ length: 60 }, (_, index) => ({ id: String(800 + index), name: `a${index}`, status: "ACTIVE", campaign_id: "700" }));
    const r = rig({ meta });
    await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: false, confirm: true }, UI);
    const notice = r.notifier.messages[0]!.text;
    for (let index = 0; index < 5; index += 1) expect(notice).toContain(`• kampanja k${index} (${700 + index})`);
    expect(notice).toContain("… ja 20 muuta mainosta");
  });

  it("keeps pausing after a single failure and reports it", async () => {
    const meta = accountMeta();
    meta.fail = (call) =>
      call.method === "POST" && call.path === "302"
        ? new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 })
        : null;
    const r = rig({ meta });
    const result = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: false, confirm: true }, UI);
    expect(result.count).toBe(3);
    expect(result.errors.map((entry) => entry.id)).toEqual(["302"]);
    expect(meta.ads.find((ad) => ad.id === "303")?.status).toBe("PAUSED");
    expect(meta.campaigns.find((campaign) => campaign.id === "100")?.status).toBe("PAUSED");
    expect(r.ruleActions()[0]!.error).toMatch(/^302: /);
  });

  it("is an agent tool that needs a reason and returns the pause list", async () => {
    const r = rig({ meta: accountMeta() });
    expect(await r.harness.executeTool("rk9ads_pause_all", {}, { companyId: COMPANY_A })).toEqual({ error: "reason is required" });
    const result = await r.harness.executeTool<{ content: string; data: PauseAllResult }>(
      "rk9ads_pause_all",
      { reason: "CPC karkasi" },
      { companyId: COMPANY_A, agentId: "agent-9", runId: "run-9" },
    );
    expect(result.content).toMatch(/^Paused 3 ad\(s\) and 1 campaign\(s\)/);
    expect(result.data.count).toBe(4);
    expect(r.ruleActions()[0]!.metrics).toMatchObject({ initiator: { source: "agent", agentId: "agent-9", runId: "run-9" } });
  });

  it("is the pause_all gate kind: one tap pauses everything, the card shows the outcome", async () => {
    const r = rig({ meta: accountMeta() });
    const handler = gateRegistry().get("pause_all");
    expect(handler).toBeDefined();
    const request = { id: "g1", companyId: COMPANY_A, brandCode: "OLL", kind: "pause_all", status: "approved" } as GateRequestRecord;
    const outcome = await handler!({ request, tgUserId: APPROVER });
    expect(outcome).toMatchObject({ statusText: "⏸ Pysäytetty: 3 mainosta, 1 kampanjaa", outcome: { count: 4 } });
    // The card is the notice: no second Telegram message.
    expect(r.notifier.messages).toHaveLength(0);
    expect(r.ruleActions()[0]!.metrics).toMatchObject({ initiator: { source: "telegram", tgUserId: APPROVER } });
    expect(await handler!({ request, tgUserId: APPROVER })).toMatchObject({ statusText: "⏸ Ei aktiivisia mainoksia" });
  });
});
