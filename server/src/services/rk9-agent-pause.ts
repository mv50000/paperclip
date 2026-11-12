// --- RK9 Custom (52b995085, RK9-701): which paused agents the fork hides and refuses ---
// The fork hides paused agents from agents.list() and refuses to assign issues to them.
// Upstream v2026.1023.0 also uses status "paused" for an agent that the lifecycle worker is
// still preparing (lifecycleState "preparing" / "verifying" / "resuming"), including every
// new hire. Those agents are not operator-paused: they must stay visible (a failed
// preparation needs a retry from the board) and assignable (work waits until they are ready).
import { and, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { agents } from "@paperclipai/db";

// Fail closed: every paused agent counts as held unless the lifecycle is preparing it with no
// hold. Same rule as upstream isAgentAwaitingSetup (modules/agent-lifecycle/domain).
const PREPARING_LIFECYCLE_STATES = ["preparing", "verifying", "resuming"] as const;

/** True for an agent paused by an operator, a budget or another hold, not one still being prepared. */
export function isRk9HeldPausedAgent(agent: {
  status: string;
  lifecycleState?: string | null;
  lifecycleHolds?: readonly string[] | null;
}): boolean {
  if (agent.status !== "paused") return false;
  const preparing = (PREPARING_LIFECYCLE_STATES as readonly string[]).includes(agent.lifecycleState ?? "");
  return !preparing || (agent.lifecycleHolds?.length ?? 0) > 0;
}

/** SQL twin of isRk9HeldPausedAgent, negated: keeps every agent except a held paused one. */
export function notRk9HeldPausedAgentCondition(): SQL {
  return or(
    ne(agents.status, "paused"),
    and(
      inArray(agents.lifecycleState, [...PREPARING_LIFECYCLE_STATES]),
      sql`jsonb_array_length(${agents.lifecycleHolds}) = 0`,
    ),
  )!;
}
// --- /RK9 Custom ---
