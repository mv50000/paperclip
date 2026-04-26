import { describe, expect, it, beforeEach } from "vitest";
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

  it("forwards agent.status only for terminated and error", () => {
    expect(
      classifyEvent(makeEvent("agent.status", { status: "running", agentId: "a-1" }), COMPANY_NAME),
    ).toEqual([]);
    expect(
      classifyEvent(makeEvent("agent.status", { status: "idle", agentId: "a-1" }), COMPANY_NAME),
    ).toEqual([]);
    const t1 = classifyEvent(
      makeEvent("agent.status", { status: "terminated", agentId: "a-2" }),
      COMPANY_NAME,
    );
    expect(t1.map((t) => t.target)).toEqual(["company"]);
    const t2 = classifyEvent(
      makeEvent("agent.status", { status: "error", agentId: "a-3" }),
      COMPANY_NAME,
    );
    expect(t2.map((t) => t.target)).toEqual(["company"]);
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

  it("resets heartbeat counter on successful completion", () => {
    const failed = makeEvent("heartbeat.run.status", { status: "failed", agentId: "a-1" });
    const completed = makeEvent("heartbeat.run.status", { status: "completed", agentId: "a-1" });

    classifyEvent(failed, COMPANY_NAME);
    classifyEvent(failed, COMPANY_NAME);
    classifyEvent(completed, COMPANY_NAME);
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
});
