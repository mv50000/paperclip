/**
 * A pause's own PAUSED write that Meta refuses during a halt (RK9-568): the
 * kill switch, the scheduled pause, the cap pause and their re-check put the
 * object in the pause retry (pending-undo.ts), alert once per object, and
 * the scheduled-pause job pauses it again on every tick until Meta confirms,
 * a board user acknowledges it, or a newer activation is approved after the
 * halt ended. Meta is a routing fake and Telegram a recording notifier: no
 * real Meta or Telegram call is made.
 */

import { describe, expect, it } from "vitest";
import { createLedger } from "../../src/db.js";
import { readHalt, type HaltState } from "../../src/features/spend-guard/halt.js";
import { pauseAll, type PauseAllResult } from "../../src/features/spend-guard/killswitch.js";
import { readPendingUndos, reportPauseFailure } from "../../src/features/spend-guard/pending-undo.js";
import { readRecheck } from "../../src/features/spend-guard/recheck.js";
import { CLEAR_HALT_ACTION_KEY, PAUSE_ALL_ACTION_KEY } from "../../src/features/spend-guard/register.js";
import type { NewerActivationQuery } from "../../src/gate/gate-requests.js";
import { parseBrandConfig } from "../../src/config.js";
import { brandConfig, COMPANY_A } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";
import { META_TOKEN, rig, telegramBlock, type Rig } from "./rig.js";

const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-1" } };
const AD = "301";
const CAMPAIGN = "100";

function activeMeta(): FakeMeta {
  const meta = new FakeMeta();
  meta.spend = () => "10.00";
  meta.account = { ...meta.account, amount_spent: "1000" };
  meta.campaigns = [{ id: CAMPAIGN, name: "OLL", status: "ACTIVE" }];
  meta.adsets = [{ id: "200", name: "set", status: "ACTIVE", campaign_id: CAMPAIGN, daily_budget: "300" }];
  meta.ads = [{ id: AD, name: "ad", status: "ACTIVE", campaign_id: CAMPAIGN }];
  return meta;
}

function reactivate(meta: FakeMeta): void {
  for (const object of [...meta.campaigns, ...meta.ads]) {
    object.status = "ACTIVE";
    object.effective_status = "ACTIVE";
  }
}

/** Meta refuses the ad's PAUSED write while `refusing()`; the error carries the token, which must not leak. */
function refuseAdPause(meta: FakeMeta, refusing: () => boolean = () => true): void {
  meta.fail = (call) =>
    refusing() && call.method === "POST" && call.path === AD && call.body.status === "PAUSED"
      ? new Response(JSON.stringify({ error: { message: `rate limited access_token=${META_TOKEN}`, code: 17 } }), { status: 400 })
      : null;
}

const pauseAlerts = (r: Rig) => r.notifier.messages.filter((message) => message.text.includes("pysäytys epäonnistui pysäytystilan aikana"));
const adPauses = (meta: FakeMeta) => meta.writes.filter((call) => call.path === AD && call.body.status === "PAUSED").length;

async function tick(r: Rig, iso: string): Promise<void> {
  r.clock.now = new Date(iso);
  await r.harness.runJob("scheduled-pause");
}

async function failingTick(r: Rig, iso: string): Promise<string> {
  r.clock.now = new Date(iso);
  try {
    await r.harness.runJob("scheduled-pause");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`the tick at ${iso} did not fail`);
}

async function killSwitch(r: Rig): Promise<PauseAllResult> {
  r.clock.now = new Date("2026-10-21T10:00:00Z");
  return r.harness.performAction<PauseAllResult>(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
}

describe("a re-check whose PAUSED write Meta keeps refusing (RK9-568, AC 5a)", () => {
  it("alerts once, moves the ad to the pause retry and retries it on every tick while the halt stands", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    const halt = (await readHalt(r.harness.ctx, COMPANY_A, r.clock.now))!;
    reactivate(r.meta);
    refuseAdPause(r.meta);

    const first = await failingTick(r, "2026-10-21T10:05:00Z");
    expect(first).toMatch(/OLL kill_switch re-check: 1 pause\(s\) failed \(last error: .*rate limited.*\), moved to the pause retry/);
    expect(first).not.toContain(META_TOKEN);
    // The listing ran: the re-check is done, the ad is in the retry.
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([
      { objectId: AD, kind: "ad", origin: "pause", haltRule: "kill_switch", gateRequestId: `kill_switch:${halt.id}` },
    ]);
    expect(pauseAlerts(r)).toHaveLength(1);
    const alert = pauseAlerts(r)[0]!.text;
    expect(alert).toContain("(hätäkatkaisin)");
    expect(alert).toContain(`mainos ${AD}: PAUSED epäonnistui 1 kertaa, viimeisin virhe:`);
    expect(alert).toContain("rate limited");
    expect(alert).not.toContain(META_TOKEN);
    expect(r.store.keys()).toContain(`${COMPANY_A}|pause-failed:OLL:kill_switch:${halt.id}:${AD}`);

    // Past the re-check's 15-minute window the retry goes on, with the truth in the run's failure line.
    let message = "";
    for (const iso of ["2026-10-21T10:10:00Z", "2026-10-21T10:15:00Z", "2026-10-21T10:20:00Z", "2026-10-21T10:30:00Z"]) message = await failingTick(r, iso);
    expect(message).not.toContain("no tick ran");
    expect(message).toMatch(/OLL kill_switch pause retry: pausing ad 301 failed again \(6 failed PAUSED writes since 2026-10-21T10:05:00.000Z, last error: .*rate limited.*\), retrying next tick/);
    expect(message).not.toContain(META_TOKEN);
    const [entry] = await readPendingUndos(r.harness.ctx, COMPANY_A);
    expect(entry).toMatchObject({ attempts: 6, lastAttemptAt: "2026-10-21T10:30:00.000Z" });
    expect(entry!.lastError).not.toContain(META_TOKEN);
    expect(pauseAlerts(r)).toHaveLength(1);
    expect(r.meta.ads[0]!.status).toBe("ACTIVE");
  });

  it("a failed alert gives its marker back and goes out on the next tick, once", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    refuseAdPause(r.meta);
    r.notifier.fail = new Error("Telegram 502");
    expect(await failingTick(r, "2026-10-21T10:05:00Z")).toMatch(/pause retry: alert: Error: Telegram 502/);
    expect(r.store.keys().some((key) => key.includes("pause-failed:"))).toBe(false);
    r.notifier.fail = null;
    await failingTick(r, "2026-10-21T10:10:00Z");
    expect(pauseAlerts(r)).toHaveLength(1);
    expect(pauseAlerts(r)[0]!.text).toContain("PAUSED epäonnistui 3 kertaa");
    await failingTick(r, "2026-10-21T10:15:00Z");
    expect(pauseAlerts(r)).toHaveLength(1);
  });

  it("a re-check that finds the object no longer ACTIVE is dropped silently (AC 4)", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    refuseAdPause(r.meta);
    await tick(r, "2026-10-21T10:05:00Z");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    expect(pauseAlerts(r)).toHaveLength(0);
  });

  it("when the retry cannot be stored the re-check stays, and its drop says the ticks ran and failed", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    refuseAdPause(r.meta);
    const state = r.harness.ctx.state;
    const set = state.set.bind(state);
    state.set = async (input, value) => {
      if (input.stateKey.startsWith("pending-undo:")) throw new Error("state down");
      return set(input, value);
    };
    expect(await failingTick(r, "2026-10-21T10:05:00Z")).toMatch(/kill_switch re-check: pause retry: not stored for the retry \(Error: state down\).*kill_switch re-check: retrying next tick/);
    expect(pauseAlerts(r)[0]!.text).toContain("Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa.");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ attempts: 1, lastError: expect.stringContaining("rate limited") });
    await failingTick(r, "2026-10-21T10:10:00Z");
    const dropped = await failingTick(r, "2026-10-21T10:20:00Z");
    expect(dropped).toMatch(/kill_switch re-check: ran 2 time\(s\) within 15 min .* but PAUSED failed and the pause retry could not be stored \(last error: .*rate limited.*\), dropped; pause the objects by hand in Meta/);
    expect(dropped).not.toContain("no tick ran");
    expect(dropped).not.toContain(META_TOKEN);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});

describe("the kill switch's own first pause fails (RK9-568, AC 5b and 5c)", () => {
  it("moves the ad to the retry, alerts once, and a later tick's success ends the entry with an audit row", async () => {
    const r = rig({ meta: activeMeta() });
    let refusing = true;
    refuseAdPause(r.meta, () => refusing);
    const result = await killSwitch(r);
    const halt = (await readHalt(r.harness.ctx, COMPANY_A, r.clock.now))!;
    expect(result).toMatchObject({ count: 1, errors: [{ id: AD, kind: "ad" }], retry: { stored: true, telegram: "sent" } });
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([
      { objectId: AD, kind: "ad", origin: "pause", haltRule: "kill_switch", gateRequestId: `kill_switch:${halt.id}`, attempts: 1, since: "2026-10-21T10:00:00.000Z" },
    ]);
    expect(pauseAlerts(r)).toHaveLength(1);
    // The pause notice says the failed one is retried.
    expect(r.notifier.messages.some((message) => message.text.includes("Niitä yritetään uudelleen 5 minuutin välein."))).toBe(true);
    const pauseRow = r.ruleActions().find((row) => row.action === "pause_all")!;
    expect(pauseRow.metrics).toMatchObject({ failedIds: [AD], retry: { stored: true, telegram: "sent" } });

    // The re-check lists the ad ACTIVE too: it adds an attempt to the same entry, no second alert.
    expect(await failingTick(r, "2026-10-21T10:05:00Z")).toMatch(/kill_switch re-check: 1 pause\(s\) failed .*moved to the pause retry/);
    expect(pauseAlerts(r)).toHaveLength(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ gateRequestId: `kill_switch:${halt.id}`, attempts: 3 }]);

    refusing = false;
    await tick(r, "2026-10-21T10:10:00Z");
    expect(r.meta.ads[0]!.status).toBe("PAUSED");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    expect(r.ruleActions().filter((row) => row.rule_id === `retry-kill_switch:${halt.id}`)).toMatchObject([
      {
        rule_type: "kill_switch",
        object_type: "ad",
        object_id: AD,
        action: "pause",
        applied: true,
        metrics: { origin: "pause", failedAttempts: 3, failedSince: "2026-10-21T10:00:00.000Z" },
      },
    ]);
    const writes = adPauses(r.meta);
    await tick(r, "2026-10-21T10:15:00Z");
    expect(adPauses(r.meta)).toBe(writes);
  });

  it("a PAUSED write that Meta answers without success counts as failed", async () => {
    const r = rig({ meta: activeMeta() });
    r.meta.fail = (call) => (call.method === "POST" && call.path === AD && call.body.status === "PAUSED" ? new Response(JSON.stringify({ success: false }), { status: 200 }) : null);
    const result = await killSwitch(r);
    expect(result).toMatchObject({ count: 1, errors: [{ id: AD, error: expect.stringContaining("Meta did not confirm status PAUSED") }], retry: { stored: true } });
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, origin: "pause" }]);
  });

  it("the scheduled pause and the cap pause put their failures in the retry too", async () => {
    const r = rig({
      meta: activeMeta(),
      config: brandConfig({ telegram: telegramBlock(), schedule: { scheduledPause: { enabled: true, at: "21:30" } } }),
    });
    refuseAdPause(r.meta);
    expect(await failingTick(r, "2026-10-21T18:31:00Z")).toMatch(/OLL scheduled pause: 1 pause\(s\) failed .*moved to the pause retry/);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, origin: "pause", haltRule: "scheduled_pause" }]);
    expect(pauseAlerts(r)[0]!.text).toContain("(ajastettu pysäytys)");

    const cap = rig({ meta: activeMeta() });
    refuseAdPause(cap.meta);
    const parsed = parseBrandConfig(brandConfig({ telegram: telegramBlock() }));
    if (parsed.state !== "enabled") throw new Error("test config invalid");
    const result = await pauseAll(
      { ctx: cap.harness.ctx, ledger: createLedger(cap.harness.ctx.db), notifier: cap.notifier, store: cap.store, now: () => cap.clock.now, closeCards: async () => ({ ids: [], announce: async () => undefined }) },
      COMPANY_A,
      parsed.config,
      { dryRun: false, rule: "pause_all_cap", reason: "cap", initiator: { source: "job", jobRunId: "job-1" }, notify: true },
    );
    expect(result.retry).toMatchObject({ stored: true, telegram: "sent" });
    expect(await readPendingUndos(cap.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, origin: "pause", haltRule: "pause_all_cap" }]);
    expect(pauseAlerts(cap)[0]!.text).toContain("(kulutuskatto 90 %)");
  });

  it("the data gate and a dry run store nothing", async () => {
    const r = rig({ meta: activeMeta() });
    refuseAdPause(r.meta);
    const parsed = parseBrandConfig(brandConfig({ telegram: telegramBlock() }));
    if (parsed.state !== "enabled") throw new Error("test config invalid");
    const deps = { ctx: r.harness.ctx, ledger: createLedger(r.harness.ctx.db), notifier: r.notifier, store: r.store, now: () => r.clock.now };
    const gate = await pauseAll(deps, COMPANY_A, parsed.config, { dryRun: false, rule: "data_gate", reason: "gate", initiator: { source: "job" }, notify: true });
    expect(gate.errors).toHaveLength(1);
    expect(gate.retry).toBeUndefined();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: true }, BOARD);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    expect(pauseAlerts(r)).toHaveLength(0);
  });
});

describe("after the halt ends, the RK9-565 drop rule holds (RK9-568, AC 5d)", () => {
  type Newer = { id: string; inFlight: boolean; unknown?: boolean; ageMinutes?: number } | null;
  async function failedKillSwitch(newer: () => Newer) {
    const queries: NewerActivationQuery[] = [];
    const hook: { lookup: (() => Promise<Newer>) | null } = { lookup: null };
    const r = rig({
      meta: activeMeta(),
      overrides: {
        newerActivation: async (_companyId, query) => {
          queries.push(query);
          const hit = await (hook.lookup ? hook.lookup() : newer());
          return hit ? { ageMinutes: 0, ...hit } : null;
        },
      },
    });
    refuseAdPause(r.meta);
    await killSwitch(r);
    const halt = (await readHalt(r.harness.ctx, COMPANY_A, r.clock.now))!;
    return { r, halt, queries, hook };
  }

  async function clearHalt(r: Rig, halt: HaltState): Promise<void> {
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, BOARD);
    expect(await readHalt(r.harness.ctx, COMPANY_A, r.clock.now)).toBeNull();
  }

  it("while the halt stands no newer activation is asked for: the tick pauses", async () => {
    const { r, queries } = await failedKillSwitch(() => ({ id: "gate-newer", inFlight: false }));
    await failingTick(r, "2026-10-21T10:05:00Z");
    expect(queries).toEqual([]);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
  });

  it("a cleared halt alone keeps the retry; a newer approved activation after the failure ends it with one alert and no write", async () => {
    let newer: { id: string; inFlight: boolean } | null = null;
    const { r, halt, queries } = await failedKillSwitch(() => newer);
    await clearHalt(r, halt);
    const message = await failingTick(r, "2026-10-21T10:05:00Z");
    expect(message).toMatch(/kill_switch pause retry: pausing ad 301 failed again/);
    expect(queries.at(-1)).toMatchObject({ objectId: AD, gateRequestId: `kill_switch:${halt.id}`, since: new Date("2026-10-21T10:00:00.000Z") });
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);

    newer = { id: "gate-newer", inFlight: false };
    const writes = adPauses(r.meta);
    await tick(r, "2026-10-21T10:10:00Z");
    expect(adPauses(r.meta)).toBe(writes);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    const dropped = r.notifier.messages.filter((entry) => entry.text.includes("pysäytyksen uudelleenyritys lopetettiin"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.text).toContain(`mainos ${AD}`);
    expect(r.harness.activity.filter((entry) => entry.message.includes(`kill_switch pause retry of ad ${AD} ended: superseded by gate-newer`))).toHaveLength(1);
  });

  it("a pause that fails on the object while the tick drops the entry keeps it: no drop alert, the retry goes on (verifier High)", async () => {
    const parsed = parseBrandConfig(brandConfig({ telegram: telegramBlock() }));
    if (parsed.state !== "enabled") throw new Error("test config invalid");
    let calls = 0;
    let ctx: Rig["harness"]["ctx"] | null = null;
    let notifier: Rig["notifier"] | null = null;
    let store: Rig["store"] | null = null;
    // The cap pause fails on the ad after the tick read the list, before it removes the superseded entry.
    const { r, halt, queries, hook } = await failedKillSwitch(() => null);
    ctx = r.harness.ctx;
    notifier = r.notifier;
    store = r.store;
    const lookup = async () => {
      calls += 1;
      if (calls === 1) {
        await reportPauseFailure({ ctx: ctx!, notifier: notifier!, store: store! }, COMPANY_A, parsed.config, {
          rule: "pause_all_cap",
          ref: "pause_all_cap:halt-2",
          failed: [{ kind: "ad", objectId: AD, error: "rate limited" }],
        }, new Date("2026-10-21T10:04:00Z"));
        return { id: "gate-newer", inFlight: false };
      }
      return null;
    };
    hook.lookup = lookup;
    await clearHalt(r, halt);
    await tick(r, "2026-10-21T10:05:00Z").catch(() => undefined);
    expect(queries).toHaveLength(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([
      { objectId: AD, gateRequestId: `kill_switch:${halt.id}`, failedAt: "2026-10-21T10:04:00.000Z", attempts: 2 },
    ]);
    expect(r.notifier.messages.some((entry) => entry.text.includes("uudelleenyritys lopetettiin"))).toBe(false);
    expect(r.harness.activity.some((entry) => entry.message.includes("ended: superseded"))).toBe(false);
    // The next tick asks again from the merged failure's time and pauses.
    await failingTick(r, "2026-10-21T10:10:00Z");
    expect(queries.at(-1)).toMatchObject({ since: new Date("2026-10-21T10:04:00.000Z") });
  });

  it("an acknowledgement does not take a failure merged after the preview", async () => {
    const { r, halt } = await failedKillSwitch(() => null);
    const preview = await r.harness.performAction<{ pendingUndo?: Array<{ key: string }> }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    const parsed = parseBrandConfig(brandConfig({ telegram: telegramBlock() }));
    if (parsed.state !== "enabled") throw new Error("test config invalid");
    await reportPauseFailure({ ctx: r.harness.ctx, notifier: r.notifier, store: r.store }, COMPANY_A, parsed.config, {
      rule: "scheduled_pause",
      ref: "scheduled_pause:halt-3",
      failed: [{ kind: "ad", objectId: AD, error: "rate limited" }],
    }, new Date("2026-10-21T10:02:00Z"));
    const result = await r.harness.performAction<{ acknowledgedUndos?: number }>(
      CLEAR_HALT_ACTION_KEY,
      { dryRun: false, confirm: true, since: halt.since, acknowledgeUndos: [preview.pendingUndo![0]!.key] },
      BOARD,
    );
    expect(result.acknowledgedUndos).toBeUndefined();
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, attempts: 2, failedAt: "2026-10-21T10:02:00.000Z" }]);
  });

  it("the board's acknowledgement of the previewed entry ends it", async () => {
    const { r, halt } = await failedKillSwitch(() => null);
    const preview = await r.harness.performAction<{ pendingUndo?: Array<{ key: string; origin?: string }> }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    expect(preview.pendingUndo).toMatchObject([{ key: `${AD}|kill_switch:${halt.id}`, origin: "pause" }]);
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since, acknowledgeUndos: [preview.pendingUndo![0]!.key] }, BOARD);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    const writes = adPauses(r.meta);
    await tick(r, "2026-10-21T10:05:00Z");
    expect(adPauses(r.meta)).toBe(writes);
  });
});
