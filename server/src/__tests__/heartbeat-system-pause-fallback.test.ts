import { describe, expect, it } from "vitest";
import { createReadOnlySystemPause } from "../services/heartbeat.js";

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
