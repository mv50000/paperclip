import { describe, expect, it } from "vitest";
import {
  type AlertState,
  selectAlertableRepos,
  splitHealth,
} from "./webhook-monitor-alerting.js";

const OPTS = { throttleHours: 6, failureGrowthThreshold: 2 };
const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();

function state(partial: Partial<AlertState> = {}): AlertState {
  return {
    repoAlertedAt: {},
    repoLastFailureCount: {},
    repoLastError: {},
    ...partial,
  };
}

const blind = (repo: string, error: string) => ({
  repo,
  recentFailures: 0,
  error,
});
const failing = (repo: string, recentFailures: number) => ({
  repo,
  recentFailures,
  error: null,
});

describe("splitHealth", () => {
  it("separates a repo that could not be checked from one whose deliveries failed", () => {
    const { failing: f, blind: b } = splitHealth([
      blind("mv50000/paperclip", "403 Forbidden"),
      failing("rk9-ai/bk", 3),
    ]);
    expect(f.map((r) => r.repo)).toEqual(["rk9-ai/bk"]);
    expect(b.map((r) => r.repo)).toEqual(["mv50000/paperclip"]);
  });
});

describe("selectAlertableRepos", () => {
  it("alerts the first time a repo goes blind", () => {
    const { alertable, throttled } = selectAlertableRepos(
      [blind("mv50000/paperclip", "403 Forbidden")],
      state(),
      NOW,
      OPTS,
    );
    expect(alertable.map((r) => r.repo)).toEqual(["mv50000/paperclip"]);
    expect(throttled).toEqual([]);
  });

  // RK9-226: the same unreadable hook posted 72 alerts in three days because
  // errors skipped the throttle entirely.
  it("silences an unchanged error inside the throttle window", () => {
    const { alertable, throttled } = selectAlertableRepos(
      [blind("mv50000/paperclip", "403 Forbidden")],
      state({
        repoAlertedAt: { "mv50000/paperclip": hoursAgo(1) },
        repoLastError: { "mv50000/paperclip": "403 Forbidden" },
      }),
      NOW,
      OPTS,
    );
    expect(alertable).toEqual([]);
    expect(throttled).toEqual(["mv50000/paperclip"]);
  });

  it("re-alerts the same error once the throttle window has passed", () => {
    const { alertable } = selectAlertableRepos(
      [blind("mv50000/paperclip", "403 Forbidden")],
      state({
        repoAlertedAt: { "mv50000/paperclip": hoursAgo(7) },
        repoLastError: { "mv50000/paperclip": "403 Forbidden" },
      }),
      NOW,
      OPTS,
    );
    expect(alertable.map((r) => r.repo)).toEqual(["mv50000/paperclip"]);
  });

  it("alerts immediately when the error text changes inside the window", () => {
    const { alertable } = selectAlertableRepos(
      [blind("mv50000/paperclip", "404 Not Found")],
      state({
        repoAlertedAt: { "mv50000/paperclip": hoursAgo(1) },
        repoLastError: { "mv50000/paperclip": "403 Forbidden" },
      }),
      NOW,
      OPTS,
    );
    expect(alertable.map((r) => r.repo)).toEqual(["mv50000/paperclip"]);
  });

  it("alerts when a blind repo becomes readable and turns out to be failing", () => {
    const { alertable } = selectAlertableRepos(
      [failing("mv50000/paperclip", 1)],
      state({
        repoAlertedAt: { "mv50000/paperclip": hoursAgo(1) },
        repoLastError: { "mv50000/paperclip": "403 Forbidden" },
      }),
      NOW,
      OPTS,
    );
    expect(alertable.map((r) => r.repo)).toEqual(["mv50000/paperclip"]);
  });

  it("silences a delivery failure that has not grown inside the window", () => {
    const { alertable, throttled } = selectAlertableRepos(
      [failing("rk9-ai/bk", 3)],
      state({
        repoAlertedAt: { "rk9-ai/bk": hoursAgo(2) },
        repoLastFailureCount: { "rk9-ai/bk": 3 },
      }),
      NOW,
      OPTS,
    );
    expect(alertable).toEqual([]);
    expect(throttled).toEqual(["rk9-ai/bk"]);
  });

  it("alerts when failures doubled inside the window", () => {
    const { alertable } = selectAlertableRepos(
      [failing("rk9-ai/bk", 6)],
      state({
        repoAlertedAt: { "rk9-ai/bk": hoursAgo(2) },
        repoLastFailureCount: { "rk9-ai/bk": 3 },
      }),
      NOW,
      OPTS,
    );
    expect(alertable.map((r) => r.repo)).toEqual(["rk9-ai/bk"]);
  });

  it("treats a corrupt timestamp as no throttle rather than muting the repo", () => {
    const { alertable } = selectAlertableRepos(
      [blind("mv50000/paperclip", "403 Forbidden")],
      state({
        repoAlertedAt: { "mv50000/paperclip": "not-a-date" },
        repoLastError: { "mv50000/paperclip": "403 Forbidden" },
      }),
      NOW,
      OPTS,
    );
    expect(alertable.map((r) => r.repo)).toEqual(["mv50000/paperclip"]);
  });
});
