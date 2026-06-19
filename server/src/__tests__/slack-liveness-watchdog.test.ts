import { describe, expect, it } from "vitest";
import {
  isOverdue,
  isWatchedAgent,
  shouldAlertStale,
  clearStale,
  parseHeartbeatPolicy,
  type StaleState,
} from "../services/slack/liveness-watchdog.js";

const NOW = new Date("2026-06-19T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

// lastHeartbeatAt `ageHours` before NOW
function heartbeatAt(ageHours: number): Date {
  return new Date(NOW.getTime() - ageHours * HOUR_MS);
}

describe("liveness watchdog — parseHeartbeatPolicy", () => {
  it("reads enabled + intervalSec from runtimeConfig.heartbeat", () => {
    expect(parseHeartbeatPolicy({ heartbeat: { enabled: true, intervalSec: 3600 } })).toEqual({
      enabled: true,
      intervalSec: 3600,
    });
  });

  it("defaults to disabled / zero interval for missing or malformed config", () => {
    expect(parseHeartbeatPolicy({})).toEqual({ enabled: false, intervalSec: 0 });
    expect(parseHeartbeatPolicy(null)).toEqual({ enabled: false, intervalSec: 0 });
    expect(parseHeartbeatPolicy({ heartbeat: { enabled: "yes", intervalSec: -5 } })).toEqual({
      enabled: false,
      intervalSec: 0,
    });
  });
});

describe("liveness watchdog — isOverdue (threshold logic)", () => {
  const interval = 3600; // 1h
  const multiplier = 3; // threshold = 3h

  it("is not overdue just under the threshold", () => {
    expect(
      isOverdue({ lastHeartbeatAt: heartbeatAt(2.99), createdAt: heartbeatAt(100), intervalSec: interval }, NOW, multiplier),
    ).toBe(false);
  });

  it("is not overdue exactly at the threshold (strictly greater)", () => {
    expect(
      isOverdue({ lastHeartbeatAt: heartbeatAt(3), createdAt: heartbeatAt(100), intervalSec: interval }, NOW, multiplier),
    ).toBe(false);
  });

  it("is overdue just past the threshold", () => {
    expect(
      isOverdue({ lastHeartbeatAt: heartbeatAt(3.01), createdAt: heartbeatAt(100), intervalSec: interval }, NOW, multiplier),
    ).toBe(true);
  });

  it("falls back to createdAt when the agent has never run", () => {
    // never ran, created 4h ago, threshold 3h → overdue
    expect(
      isOverdue({ lastHeartbeatAt: null, createdAt: heartbeatAt(4), intervalSec: interval }, NOW, multiplier),
    ).toBe(true);
    // never ran, created 1h ago, threshold 3h → not yet overdue (not flagged on creation)
    expect(
      isOverdue({ lastHeartbeatAt: null, createdAt: heartbeatAt(1), intervalSec: interval }, NOW, multiplier),
    ).toBe(false);
  });

  it("respects the multiplier (a 4h-cadence agent overdue at >8h with multiplier 2)", () => {
    expect(
      isOverdue({ lastHeartbeatAt: heartbeatAt(7), createdAt: heartbeatAt(100), intervalSec: 4 * 3600 }, NOW, 2),
    ).toBe(false);
    expect(
      isOverdue({ lastHeartbeatAt: heartbeatAt(9), createdAt: heartbeatAt(100), intervalSec: 4 * 3600 }, NOW, 2),
    ).toBe(true);
  });

  it("is never overdue when there is no timer interval", () => {
    expect(
      isOverdue({ lastHeartbeatAt: heartbeatAt(1000), createdAt: heartbeatAt(1000), intervalSec: 0 }, NOW, multiplier),
    ).toBe(false);
  });
});

describe("liveness watchdog — isWatchedAgent (exclusions)", () => {
  const base = { status: "idle", adapterType: "process", heartbeatEnabled: true, intervalSec: 3600 };

  it("watches a normal active timer-heartbeat agent", () => {
    expect(isWatchedAgent(base)).toBe(true);
    expect(isWatchedAgent({ ...base, status: "running" })).toBe(true);
    // an errored agent that stopped running is exactly what we want surfaced
    expect(isWatchedAgent({ ...base, status: "error" })).toBe(true);
  });

  it("does not watch paused / terminated / pending_approval agents", () => {
    expect(isWatchedAgent({ ...base, status: "paused" })).toBe(false);
    expect(isWatchedAgent({ ...base, status: "terminated" })).toBe(false);
    expect(isWatchedAgent({ ...base, status: "pending_approval" })).toBe(false);
  });

  it("does not watch human-proxy agents", () => {
    expect(isWatchedAgent({ ...base, adapterType: "human_proxy" })).toBe(false);
  });

  it("does not watch heartbeat-disabled agents", () => {
    expect(isWatchedAgent({ ...base, heartbeatEnabled: false })).toBe(false);
  });

  it("does not watch event-driven agents (no timer interval)", () => {
    expect(isWatchedAgent({ ...base, intervalSec: 0 })).toBe(false);
  });
});

describe("liveness watchdog — debounce (once per episode, reset on recovery)", () => {
  const key = "company-1:agent-1";

  it("alerts on the first stale tick", () => {
    const state = new Map<string, StaleState>();
    expect(shouldAlertStale(state, key, NOW.getTime())).toBe(true);
  });

  it("does not re-alert on subsequent stale ticks (no repeat per tick)", () => {
    const state = new Map<string, StaleState>();
    expect(shouldAlertStale(state, key, NOW.getTime())).toBe(true);
    expect(shouldAlertStale(state, key, NOW.getTime() + 5 * 60 * 1000)).toBe(false);
    expect(shouldAlertStale(state, key, NOW.getTime() + 60 * 60 * 1000)).toBe(false);
  });

  it("re-alerts after the agent recovers (clearStale) and goes stale again", () => {
    const state = new Map<string, StaleState>();
    expect(shouldAlertStale(state, key, NOW.getTime())).toBe(true);
    expect(shouldAlertStale(state, key, NOW.getTime())).toBe(false);

    // agent ran again → watchdog re-arms it
    clearStale(state, key);
    expect(state.has(key)).toBe(false);

    // a new outage alerts again
    expect(shouldAlertStale(state, key, NOW.getTime() + 2 * 60 * 60 * 1000)).toBe(true);
  });

  it("tracks agents independently by key", () => {
    const state = new Map<string, StaleState>();
    expect(shouldAlertStale(state, "c:a1", NOW.getTime())).toBe(true);
    expect(shouldAlertStale(state, "c:a2", NOW.getTime())).toBe(true);
    expect(shouldAlertStale(state, "c:a1", NOW.getTime())).toBe(false);
    expect(shouldAlertStale(state, "c:a2", NOW.getTime())).toBe(false);
  });
});
