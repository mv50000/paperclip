/**
 * RK9-580: the Lows of the re-check's drop alert (RK9-570 verifier).
 *
 * - A board user's clear of the halt before the drop tick sends no alert to
 *   pause by hand what the board may want running. A halt that ran out or
 *   cannot be read still alerts.
 * - The drop removes only the re-check the tick read, not a newer one a kill
 *   switch stored during the tick.
 * - The failure lines cap the stored last error at 300 characters.
 * - A re-check whose alert keeps failing is kept for RECHECK_ALERT_KEEP_MS
 *   past its window, then dropped.
 *
 * RK9-584 (RK9-580 verifier Lows):
 *
 * - A halt that ends within the window after failed runs (a scheduled pause
 *   shortly before 06:00, or a replaced halt) alerts like the drop at the
 *   window's end; a board user's clear still does not.
 * - A drop or a failed run's count leaves a re-check that a pause stored
 *   during the tick alone.
 * - A damaged due time whose alert failed is dropped with a line that says
 *   so, not "failed for 24 h".
 * - A replaced halt at the window's end alerts.
 *
 * Meta is a routing fake and Telegram a recording notifier: no real Meta or
 * Telegram call is made.
 */

import { describe, expect, it } from "vitest";
import { readHalt, setHalt, type HaltState } from "../../src/features/spend-guard/halt.js";
import { readRecheck, RECHECK_WINDOW_MS, scheduleRecheck } from "../../src/features/spend-guard/recheck.js";
import { CLEAR_HALT_ACTION_KEY, PAUSE_ALL_ACTION_KEY } from "../../src/features/spend-guard/register.js";
import { RECHECK_ALERT_KEEP_MS } from "../../src/features/spend-guard/scheduled-pause.js";
import { brandConfig, COMPANY_A } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";
import { rig, telegramBlock, type Rig } from "./rig.js";

const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-1" } };

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

function failListing(meta: FakeMeta): void {
  meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") ? new Error("graph down") : null);
}

async function killSwitch(r: Rig, iso = "2026-10-21T10:00:00Z"): Promise<HaltState> {
  r.clock.now = new Date(iso);
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

const recheckAlerts = (r: Rig) => r.notifier.messages.filter((message) => message.text.includes("uudelleentarkistus epäonnistui"));

describe("a halt cleared before the drop tick (RK9-580 item 1)", () => {
  it("a board user's clear after the failed ticks drops the re-check without the alert, and the run says why", async () => {
    const r = rig({ meta: activeMeta() });
    const halt = await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ attempts: 1 });

    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, BOARD);
    const message = await failingTick(r, "2026-10-21T10:20:00Z");
    expect(message).toMatch(/kill_switch re-check: ran 1 time\(s\) and failed each time \(last error: listing failed: .*graph down.*\); a board user cleared the halt, dropped without the alert/);
    expect(message).not.toContain("pause by hand");
    expect(recheckAlerts(r)).toEqual([]);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
    // The clear marker names the board as the clearer (RK9-582).
    expect(await r.harness.ctx.state.get({ scopeKind: "instance", namespace: "spend-guard", stateKey: `halt-cleared:${COMPANY_A}` })).toEqual({
      id: halt.id,
      by: "board",
    });
  });

  it("a clear marker that names the rules job still alerts (RK9-582)", async () => {
    const r = rig({ meta: activeMeta() });
    const halt = await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    await r.harness.ctx.state.set({ scopeKind: "instance", namespace: "spend-guard", stateKey: `halt-cleared:${COMPANY_A}` }, { id: halt.id, by: "rules_job" });
    expect(await readHalt(r.harness.ctx, COMPANY_A, new Date("2026-10-21T10:20:00Z"))).toBeNull();
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toMatch(/kill_switch re-check: ran 1 time\(s\) within 15 min .* and failed each time .*, dropped; check Meta and pause by hand/);
    expect(recheckAlerts(r)).toHaveLength(1);
  });

  it("a halt that ran out before the drop tick (the scheduled pause's 06:00) still alerts", async () => {
    const r = rig({ meta: activeMeta() });
    const halt = await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    await setHalt(r.harness.ctx, COMPANY_A, { ...halt, until: "2026-10-21T10:10:00.000Z" });
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toMatch(/kill_switch re-check: ran 1 time\(s\) within 15 min .*, dropped; check Meta and pause by hand/);
    expect(recheckAlerts(r)).toHaveLength(1);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });

  it("a clear within the window after a failed run drops it and says so", async () => {
    const r = rig({ meta: activeMeta() });
    const halt = await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, BOARD);
    expect(await failingTick(r, "2026-10-21T10:10:00Z")).toMatch(/kill_switch re-check: ran 1 time\(s\) and failed each time .*; a board user cleared the halt, dropped without the alert/);
    expect(recheckAlerts(r)).toEqual([]);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });

  it("a halt that cannot be read at the window's end still alerts", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    const state = r.harness.ctx.state;
    const get = state.get.bind(state);
    state.get = async (input) => {
      if (input.stateKey === `halt:${COMPANY_A}`) throw new Error("state down");
      return get(input);
    };
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toMatch(/kill_switch re-check: ran 1 time\(s\) within 15 min .* and failed each time .*, dropped; check Meta and pause by hand/);
    expect(recheckAlerts(r)).toHaveLength(1);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});

describe("the drop removes only the re-check the tick read (RK9-580 item 2)", () => {
  it("a kill switch run during the re-check's Telegram notice keeps its own re-check", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    let newer: Promise<unknown> | null = null;
    const hook = <T extends unknown[], R>(send: (...args: T) => Promise<R>) =>
      async (...args: T): Promise<R> => {
        if (!newer && r.clock.now.toISOString() === "2026-10-21T10:05:00.000Z") {
          newer = r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä 2" }, BOARD);
          await newer;
        }
        return send(...args);
      };
    r.notifier.sendMessage = hook(r.notifier.sendMessage.bind(r.notifier));
    r.notifier.sendPauseCard = hook(r.notifier.sendPauseCard.bind(r.notifier));

    r.clock.now = new Date("2026-10-21T10:05:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(newer).not.toBeNull();
    expect(r.meta.ads[0]!.status).toBe("PAUSED");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ dueAt: "2026-10-21T10:06:00.000Z" });
  });

  it("without a newer one the re-check is dropped as before", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    r.clock.now = new Date("2026-10-21T10:05:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});

/** A re-check whose ticks failed, stored without a halt so no halt read runs. */
async function failedRecheck(r: Rig, lastError: string): Promise<void> {
  await scheduleRecheck(r.harness.ctx, COMPANY_A, { rule: "kill_switch", haltId: null, dueAt: "2026-10-21T10:01:00.000Z", reason: "hätä", attempts: 2, lastError });
}

describe("the failure lines cap the last error (RK9-580 item 3)", () => {
  const long = `listing failed: ${"x".repeat(2000)}`;

  it("the kept line, while the alert fails", async () => {
    const r = rig({ meta: activeMeta() });
    await failedRecheck(r, long);
    r.notifier.fail = new Error("Telegram 502");
    const message = await failingTick(r, "2026-10-21T10:20:00Z");
    expect(message).toContain("kept to send it next tick");
    const line = message.split("; ").find((part) => part.includes("kill_switch re-check: ran 2 time(s)"))!;
    expect(line).toContain(long.slice(0, 300));
    expect(line).not.toContain(long.slice(0, 301));
  });

  it("the drop line, after the alert went out", async () => {
    const r = rig({ meta: activeMeta() });
    await failedRecheck(r, long);
    const message = await failingTick(r, "2026-10-21T10:20:00Z");
    expect(message).toContain("dropped; check Meta and pause by hand");
    expect(message).toContain(long.slice(0, 300));
    expect(message).not.toContain(long.slice(0, 301));
    expect(recheckAlerts(r)).toHaveLength(1);
  });
});

describe("a re-check whose alert keeps failing is kept for a day (RK9-580 item 4)", () => {
  it("is kept until RECHECK_ALERT_KEEP_MS past its window, then dropped with a last line", async () => {
    const r = rig({ meta: activeMeta() });
    await failedRecheck(r, "listing failed: graph down");
    r.notifier.fail = new Error("Telegram 502");
    const due = Date.parse("2026-10-21T10:01:00.000Z");
    const end = due + RECHECK_WINDOW_MS + RECHECK_ALERT_KEEP_MS;

    expect(await failingTick(r, new Date(end).toISOString())).toContain("kept to send it next tick");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).not.toBeNull();

    const last = await failingTick(r, new Date(end + 5 * 60_000).toISOString());
    expect(last).toMatch(/kill_switch re-check: ran 2 time\(s\) .*; check Meta and pause by hand what is still ACTIVE\. The alert failed for 24 h \(.*Telegram 502.*\): dropped unsent/);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
    expect(r.store.keys().some((key) => key.includes("recheck-dropped:"))).toBe(false);
  });

  it("a brand without Telegram drops at the window's end as before", async () => {
    const r = rig({ meta: activeMeta(), config: brandConfig({}) });
    await failedRecheck(r, "listing failed: graph down");
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toContain("dropped; check Meta and pause by hand");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});

describe("a halt that ends within the window after failed runs (RK9-584 item 1)", () => {
  it("a scheduled pause at 05:45 whose halt runs out at 06:00 alerts at once", async () => {
    // 05:45 EEST is 02:45Z; the halt ends at 06:00 local, 03:00Z.
    const config = brandConfig({ telegram: telegramBlock(), schedule: { scheduledPause: { enabled: true, at: "05:45" } } });
    const r = rig({ meta: activeMeta(), config });
    r.clock.now = new Date("2026-10-21T02:45:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "scheduled_pause")).toMatchObject({ dueAt: "2026-10-21T02:46:00.000Z" });
    expect((await readHalt(r.harness.ctx, COMPANY_A, r.clock.now))?.until).toBe("2026-10-21T03:00:00.000Z");
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T02:50:00Z");
    await failingTick(r, "2026-10-21T02:55:00Z");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "scheduled_pause")).toMatchObject({ attempts: 2 });

    const message = await failingTick(r, "2026-10-21T03:00:00Z");
    expect(message).toMatch(/scheduled_pause re-check: ran 2 time\(s\) and failed each time \(last error: listing failed: .*graph down.*\); its halt is no longer in force, dropped; check Meta and pause by hand/);
    expect(recheckAlerts(r)).toHaveLength(1);
    expect(recheckAlerts(r)[0]!.text).toContain("ajastetun pysäytyksen uudelleentarkistus epäonnistui 2 kertaa");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "scheduled_pause")).toBeNull();
  });

  it("a halt replaced within the window alerts too", async () => {
    const r = rig({ meta: activeMeta() });
    const halt = await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    await setHalt(r.harness.ctx, COMPANY_A, { ...halt, id: "newer-halt", since: "2026-10-21T10:07:00.000Z" });
    expect(await failingTick(r, "2026-10-21T10:10:00Z")).toMatch(/kill_switch re-check: ran 1 time\(s\) and failed each time .*; its halt is no longer in force, dropped; check Meta/);
    expect(recheckAlerts(r)).toHaveLength(1);
  });

  it("with no failed run the re-check still drops silently", async () => {
    const config = brandConfig({ telegram: telegramBlock(), schedule: { scheduledPause: { enabled: true, at: "05:59" } } });
    const r = rig({ meta: activeMeta(), config });
    r.clock.now = new Date("2026-10-21T02:59:00Z");
    await r.harness.runJob("scheduled-pause");
    reactivate(r.meta);
    r.clock.now = new Date("2026-10-21T03:00:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(recheckAlerts(r)).toEqual([]);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "scheduled_pause")).toBeNull();
    expect(r.meta.ads[0]!.status).toBe("ACTIVE");
  });
});

describe("a pause that stores a re-check during the tick keeps it (RK9-584 item 2)", () => {
  const newer = { rule: "kill_switch" as const, haltId: "newer-halt", dueAt: "2026-10-21T10:06:00.000Z", reason: "hätä 2" };

  /**
   * Stores the newer re-check right before the first write to `stateKey`.
   * These tests check the new invariant (the drop and the count write only
   * their own keys with the re-check's id). They do not replay master's
   * read-then-delete race, whose window had no write to hook.
   */
  function storeNewerBefore(r: Rig, stateKey: string): void {
    const state = r.harness.ctx.state;
    const set = state.set.bind(state);
    let pending = true;
    state.set = async (input, value) => {
      if (pending && input.stateKey === stateKey) {
        pending = false;
        await scheduleRecheck(r.harness.ctx, COMPANY_A, newer);
      }
      return set(input, value);
    };
  }

  it("between the tick's read and its drop", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    storeNewerBefore(r, `recheck-done:${COMPANY_A}:kill_switch`);
    r.clock.now = new Date("2026-10-21T10:05:00Z");
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.ads[0]!.status).toBe("PAUSED");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ haltId: "newer-halt", dueAt: newer.dueAt });
  });

  it("between the tick's read and its failed run's count, which the newer one does not inherit", async () => {
    const r = rig({ meta: activeMeta() });
    await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    storeNewerBefore(r, `recheck-attempts:${COMPANY_A}:kill_switch`);
    await failingTick(r, "2026-10-21T10:05:00Z");
    const kept = await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch");
    expect(kept).toMatchObject({ haltId: "newer-halt", dueAt: newer.dueAt });
    expect(kept?.attempts).toBeUndefined();
  });

  it("a re-check stored before RK9-584 (no id, its count inline) still counts and drops", async () => {
    const r = rig({ meta: activeMeta() });
    const key = { scopeKind: "instance" as const, namespace: "spend-guard", stateKey: `recheck:${COMPANY_A}:kill_switch` };
    await r.harness.ctx.state.set(key, { rule: "kill_switch", haltId: null, dueAt: "2026-10-21T10:01:00.000Z", reason: "hätä", attempts: 1, lastError: "listing failed: old" });
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toMatchObject({ attempts: 2, lastError: expect.stringContaining("graph down") });
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toMatch(/ran 2 time\(s\) within 15 min .*, dropped; check Meta/);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});

describe("a damaged due time whose alert failed (RK9-584 item 3)", () => {
  it("is dropped with a line that names the due time, not the 24 h cap", async () => {
    const r = rig({ meta: activeMeta() });
    await scheduleRecheck(r.harness.ctx, COMPANY_A, { rule: "kill_switch", haltId: null, dueAt: "not-a-time", reason: "hätä", attempts: 2, lastError: "listing failed: graph down" });
    r.notifier.fail = new Error("Telegram 502");
    const message = await failingTick(r, "2026-10-21T10:20:00Z");
    expect(message).toMatch(/kill_switch re-check: ran 2 time\(s\) .*The alert failed \(.*Telegram 502.*\) and the due time cannot be read: dropped unsent/);
    expect(message).not.toContain("failed for 24 h");
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});

describe("a replaced halt at the window's end (RK9-584 item 4)", () => {
  it("still alerts", async () => {
    const r = rig({ meta: activeMeta() });
    const halt = await killSwitch(r);
    reactivate(r.meta);
    failListing(r.meta);
    await failingTick(r, "2026-10-21T10:05:00Z");
    await setHalt(r.harness.ctx, COMPANY_A, { ...halt, id: "newer-halt", since: "2026-10-21T10:07:00.000Z" });
    expect(await failingTick(r, "2026-10-21T10:20:00Z")).toMatch(/kill_switch re-check: ran 1 time\(s\) within 15 min .* and failed each time .*, dropped; check Meta and pause by hand/);
    expect(recheckAlerts(r)).toHaveLength(1);
    expect(await readRecheck(r.harness.ctx, COMPANY_A, "kill_switch")).toBeNull();
  });
});
