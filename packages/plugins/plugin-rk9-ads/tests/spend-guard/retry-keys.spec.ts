/**
 * RK9-570: the pause retry's entry keys, its attempt counter, its alerts'
 * length, and the re-check that fails for its whole window.
 *
 * - An entry's key names its latest failure (`failedAt ?? since`), so an
 *   acknowledgement from an older preview takes neither a new entry of the
 *   same object and pause nor a failure merged after the preview, even two
 *   merges of one tick.
 * - A failed retry counts on the entry it read even when a pause failure
 *   was merged into it during the tick.
 * - Long alerts keep the heading and the instruction at the end.
 * - A re-check whose listing or halt read fails for its whole window says
 *   so and alerts once when it is dropped.
 *
 * Meta is a routing fake and Telegram a recording notifier: no real Meta or
 * Telegram call is made.
 */

import { describe, expect, it } from "vitest";
import { parseBrandConfig, type BrandConfig } from "../../src/config.js";
import { readHalt, type HaltState } from "../../src/features/spend-guard/halt.js";
import {
  addPendingUndos,
  ALERT_MAX_CHARS,
  readPendingUndos,
  reportPauseFailure,
  undoAlertText,
  undoEntryKey,
  type PendingUndo,
} from "../../src/features/spend-guard/pending-undo.js";
import { readRecheck } from "../../src/features/spend-guard/recheck.js";
import { CLEAR_HALT_ACTION_KEY, PAUSE_ALL_ACTION_KEY } from "../../src/features/spend-guard/register.js";
import { recheckDroppedKey } from "../../src/features/spend-guard/scheduled-pause.js";
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

function refuseAdPause(meta: FakeMeta, refusing: () => boolean = () => true): void {
  meta.fail = (call) =>
    refusing() && call.method === "POST" && call.path === AD && call.body.status === "PAUSED"
      ? new Response(JSON.stringify({ error: { message: `rate limited access_token=${META_TOKEN}`, code: 17 } }), { status: 400 })
      : null;
}

function config(): BrandConfig {
  const parsed = parseBrandConfig(brandConfig({ telegram: telegramBlock() }));
  if (parsed.state !== "enabled") throw new Error("test config invalid");
  return parsed.config;
}

async function killSwitch(r: Rig): Promise<HaltState> {
  r.clock.now = new Date("2026-10-21T10:00:00Z");
  await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
  return (await readHalt(r.harness.ctx, COMPANY_A, r.clock.now))!;
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

async function previewKeys(r: Rig): Promise<string[]> {
  const preview = await r.harness.performAction<{ pendingUndo?: Array<{ key: string }> }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
  return (preview.pendingUndo ?? []).map((entry) => entry.key);
}

async function acknowledge(r: Rig, keys: string[]): Promise<number | undefined> {
  const result = await r.harness.performAction<{ acknowledgedUndos?: number }>(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, acknowledgeUndos: keys }, BOARD);
  return result.acknowledgedUndos;
}

function pauseFailure(r: Rig, ref: string, iso: string) {
  return reportPauseFailure({ ctx: r.harness.ctx, notifier: r.notifier, store: r.store }, COMPANY_A, config(), {
    rule: "scheduled_pause",
    ref,
    failed: [{ kind: "ad", objectId: AD, error: "rate limited" }],
  }, new Date(iso));
}

describe("an entry's key names its latest failure (RK9-570 items 1 and 2)", () => {
  it("a new entry of the same object and pause is not taken by an older preview's key", async () => {
    const r = rig({ meta: activeMeta() });
    let refusing = true;
    refuseAdPause(r.meta, () => refusing);
    const halt = await killSwitch(r);
    const [stale] = await previewKeys(r);
    expect(stale).toBe(`${AD}|kill_switch:${halt.id}|2026-10-21T10:00:00.000Z`);

    // Meta confirms on the next tick: the entry ends. Then the same pause fails on the ad again.
    refusing = false;
    r.clock.now = new Date("2026-10-21T10:05:00Z");
    await r.harness.runJob("scheduled-pause").catch(() => undefined);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    await pauseFailure(r, `kill_switch:${halt.id}`, "2026-10-21T10:07:00Z");

    expect(await acknowledge(r, [stale!])).toBe(0);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, gateRequestId: `kill_switch:${halt.id}`, since: "2026-10-21T10:07:00.000Z" }]);
    expect(await acknowledge(r, await previewKeys(r))).toBe(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });

  it("two failures merged with one `now` give two keys: the first one's key does not take the second", async () => {
    const r = rig({ meta: activeMeta() });
    refuseAdPause(r.meta);
    await killSwitch(r);
    await pauseFailure(r, "scheduled_pause:halt-3", "2026-10-21T10:02:00Z");
    const [afterFirst] = await previewKeys(r);
    // The scheduled pause and its re-check run in one tick with the same `now`.
    await pauseFailure(r, "scheduled_pause:halt-3", "2026-10-21T10:02:00Z");
    const [entry] = await readPendingUndos(r.harness.ctx, COMPANY_A);
    expect(entry).toMatchObject({ attempts: 3, failedAt: "2026-10-21T10:02:00.001Z", since: "2026-10-21T10:00:00.000Z" });
    expect(undoEntryKey(entry!)).not.toBe(afterFirst);

    expect(await acknowledge(r, [afterFirst!])).toBe(0);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
  });

  it("an entry stored before RK9-568 (no origin, attempts or failedAt) is keyed by its `since` and can be acknowledged; the old key form takes nothing", async () => {
    const r = rig({ meta: activeMeta() });
    const legacy: PendingUndo = { objectId: AD, kind: "ad", gateRequestId: "gate-7", brandCode: "OLL", haltRule: "kill_switch", since: "2026-10-20T09:00:00.000Z", error: "x" };
    await addPendingUndos(r.harness.ctx, COMPANY_A, [legacy]);
    const keys = await previewKeys(r);
    expect(keys).toEqual([`${AD}|gate-7|2026-10-20T09:00:00.000Z`]);
    // A preview opened before the deploy holds the old form: nothing is taken, and the UI says so.
    expect(await acknowledge(r, [`${AD}|gate-7`])).toBe(0);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
    expect(await acknowledge(r, keys)).toBe(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });
});

describe("a failed retry counts on the entry it read (RK9-570 item 3)", () => {
  it("a pause failure merged during the tick keeps the tick's attempt", async () => {
    let hook: (() => Promise<void>) | null = null;
    const r = rig({
      meta: activeMeta(),
      overrides: {
        newerActivation: async () => {
          const run = hook;
          hook = null;
          if (run) await run();
          return null;
        },
      },
    });
    refuseAdPause(r.meta);
    const halt = await killSwitch(r);
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, BOARD);
    // The cap pause fails on the ad after the tick read the list, before its PAUSED write fails.
    hook = async () => {
      await pauseFailure(r, "pause_all_cap:halt-2", "2026-10-21T10:04:00Z");
    };
    const message = await failingTick(r, "2026-10-21T10:05:00Z");
    expect(message).toMatch(/kill_switch pause retry: pausing ad 301 failed again/);
    // The kill switch's write, the merged cap pause's and the tick's retry.
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([
      { objectId: AD, attempts: 3, failedAt: "2026-10-21T10:04:00.000Z", lastAttemptAt: "2026-10-21T10:05:00.000Z" },
    ]);
  });
});

describe("a long alert keeps its heading and instruction (RK9-570 item 5)", () => {
  const many = (origin: "pause" | "activation", permanent = false) =>
    Array.from({ length: 300 }, (_, i) => ({
      kind: "ad" as const,
      objectId: `1202000000${String(i).padStart(5, "0")}`,
      gateRequestId: "kill_switch:halt-1",
      origin,
      haltRule: "kill_switch" as const,
      attempts: 2,
      error: `rate limited ${"x".repeat(150)}`,
      ...(permanent ? { permanentError: "object_missing" as const } : {}),
    }));

  it.each([
    ["pause failed", "failed", many("pause"), "Pysäytystä yritetään uudelleen 5 minuutin välein"],
    ["pause not stored", "failed", many("pause"), "Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa."],
    ["activation undo failed", "failed", many("activation"), "Peruutusta yritetään uudelleen 5 minuutin välein"],
    ["permanent", "permanent", many("pause", true), "kuittaa merkintä boardissa."],
    ["dropped", "dropped", many("pause"), "Tarkista tila Metassa."],
    ["overlap", "overlap", many("activation"), "Jos mainoksen pitää olla käynnissä, lähetä uusi kortti ja hyväksy se."],
  ] as const)("%s", (name, kind, entries, instruction) => {
    const text = undoAlertText(config(), kind, entries, name !== "pause not stored", { id: "gate-newer" });
    expect(text.length).toBeLessThanOrEqual(ALERT_MAX_CHARS);
    expect(text.split("\n")[0]).toMatch(/^(⚠️|ℹ️) /);
    expect(text.endsWith(instruction) || text.split("\n").at(-1)!.includes(instruction)).toBe(true);
    expect(text).toContain("viesti lyhennetty Telegramin pituusrajaan: 300 kohdetta yhteensä.");
    expect(text).toContain("mainos 120200000000000");
  });

  it("a short alert is unchanged: no cut note", () => {
    const text = undoAlertText(config(), "failed", many("pause").slice(0, 2));
    expect(text).not.toContain("lyhennetty");
    expect(text.split("\n")).toHaveLength(5);
  });
});

describe("a re-check whose every run fails within its window (RK9-568 verifier L1)", () => {
  const recheckAlerts = (r: Rig) => r.notifier.messages.filter((message) => message.text.includes("uudelleentarkistus epäonnistui"));

  it("a listing that keeps failing counts each run; the drop says so and alerts once", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    const recheck = (await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch"))!;
    reactivate(r.meta);
    r.meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") ? new Error(`graph down access_token=${META_TOKEN}`) : null);
    await failingTick(r, "2026-10-21T10:05:00Z");
    await failingTick(r, "2026-10-21T10:10:00Z");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ attempts: 2, lastError: expect.stringContaining("listing failed:") });

    const dropped = await failingTick(r, "2026-10-21T10:20:00Z");
    expect(dropped).toMatch(/kill_switch re-check: ran 2 time\(s\) within 15 min .* and failed each time \(last error: listing failed: .*graph down.*\), dropped/);
    expect(dropped).not.toContain("no tick ran");
    expect(dropped).not.toContain(META_TOKEN);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
    expect(recheckAlerts(r)).toHaveLength(1);
    const alert = recheckAlerts(r)[0]!.text;
    expect(alert).toContain("hätäkatkaisimen uudelleentarkistus epäonnistui 2 kertaa 15 minuutin aikana");
    expect(alert).toContain("pysäytä käsin");
    expect(alert).not.toContain(META_TOKEN);
    expect(r.store.keys()).toContain(`${COMPANY_A}|${recheckDroppedKey("OLL", "kill_switch", recheck.dueAt)}`);
  });

  it("a halt that cannot be read counts as a failed run too", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    const state = r.harness.ctx.state;
    const get = state.get.bind(state);
    state.get = async (input) => {
      if (input.stateKey === `halt:${COMPANY_A}`) throw new Error("state down");
      return get(input);
    };
    expect(await failingTick(r, "2026-10-21T10:05:00Z")).toMatch(/kill_switch re-check: halt not read \(Error: state down\), retrying next tick/);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ attempts: 1, lastError: "halt not read: Error: state down" });
  });

  it("a run whose pause ran but whose drop failed is not counted as failed", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    const state = r.harness.ctx.state;
    const del = state.delete.bind(state);
    let refuse = true;
    state.delete = async (input) => {
      if (refuse && input.stateKey === `recheck:${COMPANY_A}:kill_switch`) {
        refuse = false;
        throw new Error("state down");
      }
      return del(input);
    };
    expect(await failingTick(r, "2026-10-21T10:05:00Z")).toMatch(/OLL kill_switch re-check: Error: state down/);
    const kept = await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch");
    expect(kept?.attempts).toBeUndefined();
    expect(r.meta.ads[0]!.status).toBe("PAUSED");
  });

  it("a failed alert keeps the re-check, and the next tick sends it and drops it", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    r.meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") ? new Error("graph down") : null);
    await failingTick(r, "2026-10-21T10:05:00Z");
    r.notifier.fail = new Error("Telegram 502");
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toMatch(
      /kill_switch re-check: ran 1 time\(s\) within 15 min .* and failed each time \(last error: listing failed: .*graph down.*\); check Meta and pause by hand what is still ACTIVE\. The alert failed \(.*Telegram 502.*\): kept to send it next tick/,
    );
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).not.toBeNull();
    expect(r.store.keys().some((key) => key.includes("recheck-dropped:"))).toBe(false);
    r.notifier.fail = null;
    expect(await failingTick(r, "2026-10-21T10:25:00Z")).toMatch(/ran 1 time\(s\) within 15 min .* and failed each time/);
    expect(recheckAlerts(r)).toHaveLength(1);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});
