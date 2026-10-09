import { describe, expect, it } from "vitest";
import { createReadOnlySystemPause } from "../services/heartbeat.js";
import { conflict, isSystemPausedConflict } from "../errors.js";

function svc(systemPause: unknown) {
  return { getGeneral: async () => ({ systemPause }) } as any;
}

describe("createReadOnlySystemPause (route-built heartbeatService fallback)", () => {
  it("is not paused without state", async () => {
    expect(await createReadOnlySystemPause(svc(null)).isPaused()).toBe(false);
  });
  it("is paused for a manual pause", async () => {
    const state = { pausedAt: "2026-01-01T00:00:00Z", pausedUntil: null, reason: "r", source: "manual" };
    const p = createReadOnlySystemPause(svc(state));
    expect(await p.isPaused()).toBe(true);
    expect((await p.getState())?.reason).toBe("r");
  });
  it("treats an expired auto pause as resumed and an active one as paused", async () => {
    const mk = (until: string) => ({ pausedAt: "x", pausedUntil: until, reason: "r", source: "auto" });
    const now = new Date("2026-06-01T00:00:00Z");
    expect(await createReadOnlySystemPause(svc(mk("2026-05-01T00:00:00Z"))).isPaused(now)).toBe(false);
    expect(await createReadOnlySystemPause(svc(mk("2026-07-01T00:00:00Z"))).isPaused(now)).toBe(true);
  });
});

describe("createReadOnlySystemPause cache", () => {
  it("reads instance settings once within the TTL and again after it", async () => {
    let reads = 0;
    const instanceSvc = { getGeneral: async () => { reads += 1; return { systemPause: null }; } } as any;
    const pause = createReadOnlySystemPause(instanceSvc, 20);
    await pause.isPaused();
    await pause.isPaused();
    await pause.getState();
    expect(reads).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pause.isPaused();
    expect(reads).toBe(2);
  });
});

describe("isSystemPausedConflict", () => {
  it("matches only the system pause conflict", () => {
    expect(isSystemPausedConflict(conflict("System paused: r"))).toBe(true);
    expect(isSystemPausedConflict(conflict("Company paused"))).toBe(false);
    expect(isSystemPausedConflict(new Error("System paused: r"))).toBe(false);
  });
});
