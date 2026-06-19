import { describe, expect, it, beforeEach, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { classifyEvent, __testing__ } from "../services/slack/event-forwarder.js";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const COMPANY_NAME = "Alli-Audit";

function makeEvent(type: LiveEvent["type"], payload: Record<string, unknown>): LiveEvent {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    companyId: COMPANY_ID,
    type,
    createdAt: new Date().toISOString(),
    payload,
  };
}

describe("slack event classifier", () => {
  beforeEach(() => {
    __testing__.resetState();
  });

  it("ignores non-budget activity events", () => {
    const targets = classifyEvent(
      makeEvent("activity.logged", { type: "issue.created" }),
      COMPANY_NAME,
    );
    expect(targets).toEqual([]);
  });

  it("forwards budget.exceeded to both company and board channels", () => {
    const targets = classifyEvent(
      makeEvent("activity.logged", {
        type: "budget.exceeded",
        scopeName: "Alli-Audit",
        spentCents: 100_000,
        budgetCents: 80_000,
      }),
      COMPANY_NAME,
    );
    expect(targets.map((t) => t.target).sort()).toEqual(["board", "company"]);
  });

  it("debounces duplicate budget.exceeded within 30s", () => {
    const eventA = makeEvent("activity.logged", {
      type: "budget.exceeded",
      scopeId: "scope-1",
      spentCents: 100,
      budgetCents: 50,
    });
    const eventB = makeEvent("activity.logged", {
      type: "budget.exceeded",
      scopeId: "scope-1",
      spentCents: 200,
      budgetCents: 50,
    });
    expect(classifyEvent(eventA, COMPANY_NAME)).not.toEqual([]);
    expect(classifyEvent(eventB, COMPANY_NAME)).toEqual([]);
  });

  it("does not debounce different scopes", () => {
    const a = makeEvent("activity.logged", { type: "budget.exceeded", scopeId: "scope-1" });
    const b = makeEvent("activity.logged", { type: "budget.exceeded", scopeId: "scope-2" });
    expect(classifyEvent(a, COMPANY_NAME)).not.toEqual([]);
    expect(classifyEvent(b, COMPANY_NAME)).not.toEqual([]);
  });

  it("forwards agent.status only for terminated; transient error flips are suppressed", () => {
    expect(
      classifyEvent(makeEvent("agent.status", { status: "running", agentId: "a-1" }), COMPANY_NAME),
    ).toEqual([]);
    expect(
      classifyEvent(makeEvent("agent.status", { status: "idle", agentId: "a-1" }), COMPANY_NAME),
    ).toEqual([]);
    // A hard stop still alerts.
    const t1 = classifyEvent(
      makeEvent("agent.status", { status: "terminated", agentId: "a-2" }),
      COMPANY_NAME,
    );
    expect(t1.map((t) => t.target)).toEqual(["company"]);
    // A transient "error" flip is intentionally NOT a standalone alert — an agent that
    // fails one run recovers on the next; genuine outages surface via the failure burst.
    const t2 = classifyEvent(
      makeEvent("agent.status", { status: "error", agentId: "a-3" }),
      COMPANY_NAME,
    );
    expect(t2).toEqual([]);
  });

  it("notifies heartbeat failures only after 3 consecutive failures", () => {
    const failed = (agentId: string) =>
      makeEvent("heartbeat.run.status", { status: "failed", agentId });

    expect(classifyEvent(failed("a-1"), COMPANY_NAME)).toEqual([]);
    expect(classifyEvent(failed("a-1"), COMPANY_NAME)).toEqual([]);
    const third = classifyEvent(failed("a-1"), COMPANY_NAME);
    expect(third.map((t) => t.target)).toEqual(["company"]);
    expect(third[0].message.text).toContain("3 runs in a row");
  });

  it("resets heartbeat counter on a successful run", () => {
    const failed = makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-1" });
    const succeeded = makeEvent("heartbeat.run.status", { status: "succeeded", agentId: "a-1" });

    classifyEvent(failed, COMPANY_NAME);
    classifyEvent(failed, COMPANY_NAME);
    classifyEvent(succeeded, COMPANY_NAME);
    expect(classifyEvent(failed, COMPANY_NAME)).toEqual([]);
    expect(classifyEvent(failed, COMPANY_NAME)).toEqual([]);
    expect(classifyEvent(failed, COMPANY_NAME).map((t) => t.target)).toEqual(["company"]);
  });

  it("tracks heartbeat counters separately per agent", () => {
    classifyEvent(makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-1" }), COMPANY_NAME);
    classifyEvent(makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-2" }), COMPANY_NAME);
    classifyEvent(makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-1" }), COMPANY_NAME);
    classifyEvent(makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-2" }), COMPANY_NAME);
    const aThird = classifyEvent(
      makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-1" }),
      COMPANY_NAME,
    );
    const bThird = classifyEvent(
      makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-2" }),
      COMPANY_NAME,
    );
    expect(aThird.length).toBe(1);
    expect(bThird.length).toBe(1);
  });

  it("accumulates failures across long gaps (consecutive since success, no time window)", () => {
    // Regression guard: a 4h-cadence agent must still reach the threshold. The old
    // 30-minute window reset the counter between spaced failures, so slow agents never
    // triggered the burst and multi-week outages went unflagged.
    vi.useFakeTimers();
    try {
      const failed = () => makeEvent("heartbeat.run.status", { status: "failed", agentId: "slow-1" });
      vi.setSystemTime(new Date("2026-06-18T00:00:00Z"));
      expect(classifyEvent(failed(), COMPANY_NAME)).toEqual([]);
      vi.setSystemTime(new Date("2026-06-18T04:00:00Z"));
      expect(classifyEvent(failed(), COMPANY_NAME)).toEqual([]);
      vi.setSystemTime(new Date("2026-06-18T08:00:00Z"));
      const third = classifyEvent(failed(), COMPANY_NAME);
      expect(third.map((t) => t.target)).toEqual(["company"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies once per outage episode, not on every subsequent failure", () => {
    const failed = () => makeEvent("heartbeat.run.status", { status: "failed", agentId: "stuck-1" });
    classifyEvent(failed(), COMPANY_NAME);
    classifyEvent(failed(), COMPANY_NAME);
    expect(classifyEvent(failed(), COMPANY_NAME).map((t) => t.target)).toEqual(["company"]); // 3rd: alert
    expect(classifyEvent(failed(), COMPANY_NAME)).toEqual([]); // 4th: quiet
    expect(classifyEvent(failed(), COMPANY_NAME)).toEqual([]); // 5th: quiet
  });

  it("re-notifies after a successful run resets the episode", () => {
    const failed = () => makeEvent("heartbeat.run.status", { status: "failed", agentId: "x-1" });
    const succeeded = () => makeEvent("heartbeat.run.status", { status: "succeeded", agentId: "x-1" });
    classifyEvent(failed(), COMPANY_NAME);
    classifyEvent(failed(), COMPANY_NAME);
    expect(classifyEvent(failed(), COMPANY_NAME).map((t) => t.target)).toEqual(["company"]); // episode 1
    classifyEvent(succeeded(), COMPANY_NAME); // recovery resets the streak + notified flag
    classifyEvent(failed(), COMPANY_NAME);
    classifyEvent(failed(), COMPANY_NAME);
    expect(classifyEvent(failed(), COMPANY_NAME).map((t) => t.target)).toEqual(["company"]); // episode 2 alerts again
  });

  it("uses the resolved agent name in the burst alert instead of (unknown)", () => {
    const failed = () => makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-1" });
    classifyEvent(failed(), COMPANY_NAME, null, "CTO");
    classifyEvent(failed(), COMPANY_NAME, null, "CTO");
    const third = classifyEvent(failed(), COMPANY_NAME, null, "CTO");
    expect(third[0].message.text).toContain("CTO");
    expect(JSON.stringify(third[0].message.blocks)).not.toContain("(unknown)");
  });

  it("ignores unhandled event types", () => {
    expect(
      classifyEvent(makeEvent("heartbeat.run.queued", { agentId: "a-1" }), COMPANY_NAME),
    ).toEqual([]);
    expect(
      classifyEvent(makeEvent("heartbeat.run.log", { agentId: "a-1", message: "x" }), COMPANY_NAME),
    ).toEqual([]);
    expect(
      classifyEvent(makeEvent("plugin.ui.updated", {}), COMPANY_NAME),
    ).toEqual([]);
  });

  it("forwards approval.created to company channel only", () => {
    const targets = classifyEvent(
      makeEvent("approval.created", {
        id: "ap-1",
        type: "hire_agent",
        title: "Hire DataAnalyst-3",
      }),
      COMPANY_NAME,
    );
    expect(targets.map((t) => t.target)).toEqual(["company"]);
    expect(JSON.stringify(targets[0].message.blocks)).toContain("ap-1");
  });

  it("debounces duplicate approval.created within 30s", () => {
    const a = makeEvent("approval.created", { id: "ap-2", type: "hire_agent", title: "X" });
    const b = makeEvent("approval.created", { id: "ap-2", type: "hire_agent", title: "X" });
    expect(classifyEvent(a, COMPANY_NAME)).not.toEqual([]);
    expect(classifyEvent(b, COMPANY_NAME)).toEqual([]);
  });

  it("ignores approval.created without id", () => {
    expect(
      classifyEvent(makeEvent("approval.created", { type: "hire_agent" }), COMPANY_NAME),
    ).toEqual([]);
  });

  it("does not produce a new channel post for approval.decided", () => {
    expect(
      classifyEvent(
        makeEvent("approval.decided", { id: "ap-3", decision: "approved" }),
        COMPANY_NAME,
      ),
    ).toEqual([]);
  });
});
