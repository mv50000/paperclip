// RK9-319: the tool-gateway half of the tainted-run gate only tightens an
// upstream decision. It turns an allowed write-level call from a tainted run
// into require_approval, which the gateway already sends to the board.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolAccessDecision } from "@paperclipai/shared";

const mockResolveActorTaint = vi.hoisted(() => vi.fn());
vi.mock("../services/rk9-run-taint.js", () => ({ resolveActorTaint: mockResolveActorTaint }));

import { rk9TaintedRunToolGate } from "../services/rk9-run-taint-tool-gate.js";

const allow: ToolAccessDecision = {
  decision: "allow",
  allowed: true,
  reasonCode: "allow_profile",
  explanation: "Tool access allowed by effective profile.",
  effectiveProfileIds: ["p1"],
  matchedPolicyIds: [],
};
const tainted = {
  tainted: true,
  runId: "run-1",
  sources: [{ kind: "email_body_read", at: "2026-10-10T08:00:00.000Z" }],
};
const clean = { tainted: false, runId: null, sources: [] };
const ctx = {
  companyId: "c1",
  actorType: "agent" as const,
  agentId: "a1",
  heartbeatRunId: "run-1",
  riskLevel: "write" as const,
};

describe("rk9TaintedRunToolGate", () => {
  beforeEach(() => mockResolveActorTaint.mockReset());

  it("requires approval for an allowed write call from a tainted run", async () => {
    mockResolveActorTaint.mockResolvedValue(tainted);
    const result = await rk9TaintedRunToolGate({} as never).apply(ctx, allow);
    expect(result).toMatchObject({
      decision: "require_approval",
      allowed: false,
      reasonCode: "requires_approval_tainted_run",
      effectiveProfileIds: ["p1"],
      policyExplanation: { upstreamReasonCode: "allow_profile", rk9TaintedRun: { runId: "run-1", sourceKinds: ["email_body_read"] } },
    });
    expect(mockResolveActorTaint).toHaveBeenCalledWith({}, "c1", {
      actorType: "agent",
      agentId: "a1",
      runId: "run-1",
      actorSource: "agent_jwt",
    });
  });

  it("fails closed on an unknown risk level and checks every active run without a run context", async () => {
    mockResolveActorTaint.mockResolvedValue(tainted);
    const result = await rk9TaintedRunToolGate({} as never).apply(
      { ...ctx, riskLevel: null, heartbeatRunId: null },
      allow,
    );
    expect(result.decision).toBe("require_approval");
    expect(mockResolveActorTaint).toHaveBeenCalledWith({}, "c1", expect.objectContaining({ runId: null, actorSource: "agent_key" }));
  });

  it("leaves read and low risk calls, clean runs and board users alone", async () => {
    mockResolveActorTaint.mockResolvedValue(tainted);
    const gate = rk9TaintedRunToolGate({} as never);
    expect(await gate.apply({ ...ctx, riskLevel: "read" }, allow)).toBe(allow);
    expect(await gate.apply({ ...ctx, riskLevel: "low" }, allow)).toBe(allow);
    expect(await gate.apply({ ...ctx, actorType: "user", agentId: null }, allow)).toBe(allow);
    mockResolveActorTaint.mockResolvedValue(clean);
    expect(await rk9TaintedRunToolGate({} as never).apply(ctx, allow)).toBe(allow);
  });

  it("never loosens a deny or an existing approval requirement", async () => {
    mockResolveActorTaint.mockResolvedValue(clean);
    const gate = rk9TaintedRunToolGate({} as never);
    const deny = { ...allow, decision: "deny" as const, allowed: false, reasonCode: "deny_default" as const };
    expect(await gate.apply(ctx, deny)).toBe(deny);
    expect(mockResolveActorTaint).not.toHaveBeenCalled();
  });

  it("keeps a tainted answer cached and re-checks a clean one after the short window", async () => {
    vi.useFakeTimers();
    try {
      const gate = rk9TaintedRunToolGate({} as never);
      mockResolveActorTaint.mockResolvedValue(clean);
      await gate.apply(ctx, allow);
      await gate.apply(ctx, allow);
      expect(mockResolveActorTaint).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_500);
      mockResolveActorTaint.mockResolvedValue(tainted);
      expect((await gate.apply(ctx, allow)).decision).toBe("require_approval");
      vi.advanceTimersByTime(60_000);
      expect((await gate.apply(ctx, allow)).decision).toBe("require_approval");
      expect(mockResolveActorTaint).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
