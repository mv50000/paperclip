import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionLogDedupe, STRANDED_DECISION_LOG_INTERVAL_MS } from "./decision-log-dedupe.js";

const HOUR = STRANDED_DECISION_LOG_INTERVAL_MS;

describe("createDecisionLogDedupe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("logs the first hit and suppresses repeats until the hour passes", () => {
    const d = createDecisionLogDedupe();
    expect(d.check("i1", "skipped_no_agent", "fp").log).toBe(true);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(d.check("i1", "skipped_no_agent", "fp").log).toBe(false);
    expect(d.check("i1", "skipped_no_agent", "fp").log).toBe(false);
    vi.advanceTimersByTime(HOUR);
    expect(d.check("i1", "skipped_no_agent", "fp")).toEqual({ log: true, suppressedSinceLastLog: 2 });
  });

  it("logs a decision change immediately and reports the old suppressed count", () => {
    const d = createDecisionLogDedupe();
    d.check("i1", "skipped_no_agent", "fp");
    d.check("i1", "skipped_no_agent", "fp");
    const v = d.check("i1", "skipped_budget_blocked", "fp");
    expect(v.log).toBe(true);
    expect(v.suppressedSinceLastLog).toBe(0);
    expect(v.previousDecisionSuppressed).toEqual({ decision: "skipped_no_agent", count: 1 });
  });

  it("logs when the fingerprint (status or run) changes within the window", () => {
    const d = createDecisionLogDedupe();
    d.check("i1", "skipped_latest_run_succeeded", "in_progress|run-1|succeeded");
    expect(d.check("i1", "skipped_latest_run_succeeded", "in_progress|run-1|succeeded").log).toBe(false);
    expect(d.check("i1", "skipped_latest_run_succeeded", "in_progress|run-2|succeeded").log).toBe(true);
  });

  it("never dedupes non-skipped decisions", () => {
    const d = createDecisionLogDedupe();
    for (const decision of ["continuation_requeued", "dispatch_requeued", "assignment_dispatched"]) {
      expect(d.check("i1", decision, "fp").log).toBe(true);
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(d.check("i1", decision, "fp").log).toBe(true);
    }
  });

  it("logs the next skip right after an action", () => {
    const d = createDecisionLogDedupe();
    d.check("i1", "skipped_no_agent", "fp");
    d.check("i1", "dispatch_requeued", "fp");
    expect(d.check("i1", "skipped_no_agent", "fp").log).toBe(true);
  });

  it("evicts stale entries from memory once the map grows past the cap", () => {
    const d = createDecisionLogDedupe();
    for (let i = 0; i < 400; i++) d.check(`old-${i}`, "skipped_no_agent", "fp");
    vi.advanceTimersByTime(3 * HOUR);
    for (let i = 0; i < 101; i++) d.check(`new-${i}`, "skipped_no_agent", "fp");
    expect(d.size()).toBe(101);
  });
});
