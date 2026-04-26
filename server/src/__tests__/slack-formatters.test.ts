import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  formatBudgetExceeded,
  formatAgentStatus,
  formatHeartbeatFailureBurst,
} from "../services/slack/formatters.js";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

function makeEvent(type: LiveEvent["type"], payload: Record<string, unknown>): LiveEvent {
  return {
    id: 1,
    companyId: COMPANY_ID,
    type,
    createdAt: new Date().toISOString(),
    payload,
  };
}

describe("slack formatters", () => {
  const originalUrl = process.env.PAPERCLIP_PUBLIC_URL;
  beforeEach(() => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example.com";
  });
  afterEach(() => {
    if (originalUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = originalUrl;
  });

  it("formats budget exceeded with euro amounts", () => {
    const event = makeEvent("activity.logged", {
      type: "budget.exceeded",
      scopeName: "Alli-Audit",
      spentCents: 87_000,
      budgetCents: 100_000,
    });
    const msg = formatBudgetExceeded(event, "Alli-Audit");
    expect(msg.text).toContain("Budget exceeded");
    expect(msg.text).toContain("Alli-Audit");
    expect(JSON.stringify(msg.blocks)).toContain("€870.00");
    expect(JSON.stringify(msg.blocks)).toContain("€1000.00");
    expect(JSON.stringify(msg.blocks)).toContain("https://paperclip.example.com/companies/" + COMPANY_ID);
  });

  it("formats agent status with reason when paused", () => {
    const event = makeEvent("agent.status", {
      agentId: "a-1",
      agentName: "Auditor-7",
      status: "terminated",
      pauseReason: "model rate limit",
    });
    const msg = formatAgentStatus(event, "Alli-Audit");
    expect(msg.text).toContain("Auditor-7");
    expect(msg.text).toContain("terminated");
    expect(JSON.stringify(msg.blocks)).toContain("model rate limit");
  });

  it("formats heartbeat failure burst with consecutive count", () => {
    const event = makeEvent("heartbeat.run.status", {
      agentId: "a-1",
      agentName: "Auditor-7",
      status: "failed",
      error: "TypeError: cannot read 'foo' of undefined",
    });
    const msg = formatHeartbeatFailureBurst(event, "Alli-Audit", 3);
    expect(msg.text).toContain("3 runs in a row");
    expect(JSON.stringify(msg.blocks)).toContain("*3*");
    expect(JSON.stringify(msg.blocks)).toContain("TypeError");
  });

  it("falls back to default url when PAPERCLIP_PUBLIC_URL unset", () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;
    const event = makeEvent("activity.logged", {
      type: "budget.exceeded",
      scopeName: "X",
      spentCents: 100,
      budgetCents: 200,
    });
    const msg = formatBudgetExceeded(event, "X");
    expect(JSON.stringify(msg.blocks)).toContain("http://localhost:3100/companies/");
  });
});
