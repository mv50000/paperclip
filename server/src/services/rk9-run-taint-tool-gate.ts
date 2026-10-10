// --- RK9 Custom (RK9-319) ---
// Tool-gateway half of the tainted-run gate. An allowed tool call above
// read/low risk from a tainted run becomes `require_approval`, which the
// gateway already turns into a board action request. A deny, a rate limit or
// an existing require_approval is never loosened. An unknown risk level fails
// closed.
import type { Db } from "@paperclipai/db";
import type { ToolAccessDecision, ToolRiskLevel } from "@paperclipai/shared";
import { resolveActorTaint, type RunTaintState } from "./rk9-run-taint.js";

const UNGATED_RISK_LEVELS = new Set<ToolRiskLevel>(["read", "low"]);
// Tool listing asks for one decision per tool. A taint never clears, so a
// tainted answer is kept; a clean answer is reused only for a moment.
const CLEAN_CACHE_MS = 2_000;

export interface TaintGateContext {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  agentId: string | null;
  heartbeatRunId: string | null;
  riskLevel: ToolRiskLevel | null;
}

export function rk9TaintedRunToolGate(db: Db) {
  const cache = new Map<string, { state: RunTaintState; at: number }>();

  async function taintFor(ctx: TaintGateContext): Promise<RunTaintState> {
    // A validated run context binds one run. Without one, every active run of
    // the agent counts (the same fail-closed rule as an unbound agent key).
    const key = `${ctx.companyId}:${ctx.agentId}:${ctx.heartbeatRunId ?? "*"}`;
    const hit = cache.get(key);
    if (hit && (hit.state.tainted || Date.now() - hit.at < CLEAN_CACHE_MS)) return hit.state;
    const state = await resolveActorTaint(db, ctx.companyId, {
      actorType: "agent",
      agentId: ctx.agentId,
      runId: ctx.heartbeatRunId,
      actorSource: ctx.heartbeatRunId ? "agent_jwt" : "agent_key",
    });
    if (cache.size > 500) cache.clear();
    cache.set(key, { state, at: Date.now() });
    return state;
  }

  async function apply(ctx: TaintGateContext, upstream: ToolAccessDecision): Promise<ToolAccessDecision> {
    if (upstream.decision !== "allow") return upstream;
    if (ctx.actorType !== "agent" || !ctx.agentId) return upstream;
    if (ctx.riskLevel && UNGATED_RISK_LEVELS.has(ctx.riskLevel)) return upstream;
    const taint = await taintFor(ctx);
    if (!taint.tainted) return upstream;
    return {
      ...upstream,
      decision: "require_approval",
      allowed: false,
      reasonCode: "requires_approval_tainted_run",
      explanation:
        "This run received untrusted external content (for example an inbound email), so a write-level tool call needs board approval.",
      policyExplanation: {
        ...(upstream.policyExplanation ?? {}),
        rk9TaintedRun: { runId: taint.runId, sourceKinds: taint.sources.map((s) => s.kind) },
        upstreamReasonCode: upstream.reasonCode,
      },
    };
  }

  return { apply };
}
// --- /RK9 Custom ---
