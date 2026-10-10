// --- RK9 Custom (RK9-319) ---
// Server-side taint for heartbeat runs that received untrusted external
// content (inbound email, outreach replies). A tainted run's outward actions go
// through an existing approval gate (email `pending_approval`, GitHub credential
// denial, tool-gateway `require_approval`). The guard lives on the server, not
// in the prompt: the model cannot be trained to refuse, so the trusted broker
// keeps the authority (confused deputy, Buzz 26.9.).
//
// Invariants:
// - Only the server marks a run. No route writes `rk9_run_taints` from agent
//   input, and no code path deletes or clears a row.
// - Every query is bound to the run's company and agent.
// - Sources hold references (message id, issue id, run id), never content.
//
// Limit (RK9-156): the gate covers actions through the Paperclip API. An agent
// with Bash can still send data out directly (curl). This module does not solve
// that.
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db, Rk9RunTaintSource } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  rk9EmailMessages,
  rk9RunTaints,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";

export type { Rk9RunTaintSource };
export type RunTaintSourceKind = Rk9RunTaintSource["kind"];

export const RUN_TAINTED_ACTIVITY = "heartbeat_run.tainted";
export const RUN_TAINTED_EVENT = "rk9.run.tainted";
const MAX_SOURCES = 20;
const EMAIL_WAKE_SOURCES = new Set(["email.inbound", "email.inbound_reply"]);
const ACTIVE_RUN_STATUSES = ["queued", "running"];

type RunRow = typeof heartbeatRuns.$inferSelect;
type RunLike = Pick<
  RunRow,
  "id" | "companyId" | "agentId" | "contextSnapshot" | "wakeupRequestId" | "sessionIdBefore"
>;

export interface RunTaintState {
  tainted: boolean;
  /** The tainted run that decided the state (null when clean, or when the actor's run is unknown). */
  runId: string | null;
  sources: Rk9RunTaintSource[];
}

const CLEAN: RunTaintState = { tainted: false, runId: null, sources: [] };

function readString(record: unknown, key: string): string | null {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sameSource(a: Rk9RunTaintSource, b: Rk9RunTaintSource): boolean {
  return (
    a.kind === b.kind &&
    (a.messageId ?? null) === (b.messageId ?? null) &&
    (a.issueId ?? null) === (b.issueId ?? null) &&
    (a.sourceRunId ?? null) === (b.sourceRunId ?? null) &&
    (a.sessionId ?? null) === (b.sessionId ?? null)
  );
}

/** Read the stored taint of one run, bound to its company. */
export async function getRunTaint(
  db: Db,
  companyId: string,
  runId: string,
): Promise<{ taintedAt: Date; sources: Rk9RunTaintSource[] } | null> {
  const [row] = await db
    .select({ taintedAt: rk9RunTaints.taintedAt, sources: rk9RunTaints.sources })
    .from(rk9RunTaints)
    .where(and(eq(rk9RunTaints.runId, runId), eq(rk9RunTaints.companyId, companyId)))
    .limit(1);
  return row ? { taintedAt: row.taintedAt, sources: Array.isArray(row.sources) ? row.sources : [] } : null;
}

/**
 * Mark a run tainted. Idempotent and monotonic: a second mark only appends a
 * new source (at most MAX_SOURCES). The run must belong to the given company
 * and agent, so one company can never mark another company's run.
 *
 * The first mark writes an activity_log row and a run-log event.
 */
export async function markRunTainted(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    source: Omit<Rk9RunTaintSource, "at"> & { at?: string };
  },
): Promise<{ marked: boolean; firstMark: boolean }> {
  const [run] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .limit(1);
  if (!run) return { marked: false, firstMark: false };

  const source: Rk9RunTaintSource = { ...input.source, at: input.source.at ?? new Date().toISOString() };
  const existing = await getRunTaint(db, input.companyId, input.runId);
  if (existing && (existing.sources.length >= MAX_SOURCES || existing.sources.some((s) => sameSource(s, source)))) {
    return { marked: true, firstMark: false };
  }

  const now = new Date();
  const [row] = await db
    .insert(rk9RunTaints)
    .values({
      runId: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      taintedAt: now,
      sources: [source],
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rk9RunTaints.runId,
      set: {
        sources: sql`case when jsonb_array_length(${rk9RunTaints.sources}) >= ${MAX_SOURCES} then ${rk9RunTaints.sources} else ${rk9RunTaints.sources} || ${JSON.stringify([source])}::jsonb end`,
        updatedAt: now,
      },
      where: and(
        eq(rk9RunTaints.companyId, input.companyId),
        eq(rk9RunTaints.agentId, input.agentId),
      ),
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const firstMark = row?.inserted === true;
  if (!firstMark) return { marked: true, firstMark: false };

  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "rk9-run-taint",
    action: RUN_TAINTED_ACTIVITY,
    entityType: "heartbeat_run",
    entityId: input.runId,
    agentId: input.agentId,
    runId: input.runId,
    details: { source },
  });
  try {
    await appendHeartbeatRunEvent(db, {
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      eventType: RUN_TAINTED_EVENT,
      stream: "system",
      level: "warn",
      message: "Run received untrusted external content; outward actions need approval",
      payload: { source },
    });
  } catch (err) {
    // The stored mark and activity row are the authority; the run-log event is visibility only.
    logger.warn({ err, runId: input.runId }, "rk9 run taint: run-log event append failed");
  }
  return { marked: true, firstMark: true };
}

/**
 * Decide from server-held state whether a run has received untrusted content.
 * Returns the matching sources, or an empty list for a clean run.
 */
export async function taintingSourcesForRun(db: Db, run: RunLike): Promise<Rk9RunTaintSource[]> {
  const at = new Date().toISOString();
  const ctx = run.contextSnapshot ?? {};
  const sources: Rk9RunTaintSource[] = [];
  const ctxIssueId = readString(ctx, "issueId") ?? readString(ctx, "taskId");

  // 1. The server woke the run for an inbound email.
  const ctxSource = readString(ctx, "source");
  const wakeReason = readString(ctx, "wakeReason");
  if ((ctxSource && EMAIL_WAKE_SOURCES.has(ctxSource)) || wakeReason?.startsWith("email_inbound")) {
    sources.push({ kind: "email_inbound_wake", at, issueId: ctxIssueId });
  }

  // 2. The run works on an issue that carries inbound email (also covers an
  //    outreach reply that the agent picks up without a wake).
  const issueIds = new Set<string>();
  if (ctxIssueId) issueIds.add(ctxIssueId);
  const heldIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, run.companyId),
        or(eq(issues.checkoutRunId, run.id), eq(issues.executionRunId, run.id)),
      ),
    )
    .limit(20);
  for (const issue of heldIssues) issueIds.add(issue.id);
  if (issueIds.size > 0) {
    const ids = [...issueIds].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length > 0) {
      const [message] = await db
        .select({ id: rk9EmailMessages.id, issueId: rk9EmailMessages.issueId })
        .from(rk9EmailMessages)
        .where(
          and(
            eq(rk9EmailMessages.companyId, run.companyId),
            eq(rk9EmailMessages.direction, "inbound"),
            inArray(rk9EmailMessages.issueId, ids),
          ),
        )
        .limit(1);
      if (message) {
        sources.push({ kind: "email_issue_context", at, issueId: message.issueId, messageId: message.id });
      }
    }
  }

  // 3. A tainted run of another (or the same) agent requested this wake:
  //    second-order injection through comments or assignments.
  const agentWakes = await db
    .select({
      requestedByActorId: agentWakeupRequests.requestedByActorId,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.requestedByActorType, "agent"),
        isNotNull(agentWakeupRequests.requestedByActorId),
        run.wakeupRequestId
          ? or(eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id))
          : eq(agentWakeupRequests.runId, run.id),
      ),
    )
    .limit(20);
  for (const wake of agentWakes) {
    const requester = wake.requestedByActorId;
    if (!requester || !/^[0-9a-f-]{36}$/i.test(requester)) continue;
    const requestedAt = new Date(wake.requestedAt).toISOString();
    const [sourceRun] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(rk9RunTaints, eq(rk9RunTaints.runId, heartbeatRuns.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, requester),
          sql`${rk9RunTaints.taintedAt} <= ${requestedAt}::timestamptz`,
          sql`(${heartbeatRuns.finishedAt} is null or ${heartbeatRuns.finishedAt} >= ${requestedAt}::timestamptz)`,
        ),
      )
      .limit(1);
    if (sourceRun && sourceRun.id !== run.id) {
      sources.push({ kind: "propagated_wake", at, sourceRunId: sourceRun.id });
      break;
    }
  }

  // 4. The run resumes a provider session that a tainted run already used:
  //    the untrusted text is still in the conversation.
  if (run.sessionIdBefore) {
    const [prior] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(rk9RunTaints, eq(rk9RunTaints.runId, heartbeatRuns.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.sessionIdAfter, run.sessionIdBefore),
        ),
      )
      .limit(1);
    if (prior && prior.id !== run.id) {
      sources.push({ kind: "resumed_session", at, sourceRunId: prior.id, sessionId: run.sessionIdBefore });
    }
  }

  return sources;
}

/**
 * Return the run's taint. A run that is not yet marked but whose context is
 * tainting is marked now (lazy mark), so the gate never depends on the claim
 * hook having run.
 */
export async function resolveRunTaint(db: Db, run: RunLike): Promise<RunTaintState> {
  const stored = await getRunTaint(db, run.companyId, run.id);
  if (stored) return { tainted: true, runId: run.id, sources: stored.sources };
  const sources = await taintingSourcesForRun(db, run);
  if (sources.length === 0) return CLEAN;
  for (const source of sources) {
    await markRunTainted(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id, source });
  }
  return { tainted: true, runId: run.id, sources };
}

/** Claim hook (heartbeat.ts): mark a run whose context is tainting. Never throws. */
export async function markRunIfTaintingContext(db: Db, run: RunLike): Promise<void> {
  try {
    await resolveRunTaint(db, run);
  } catch (err) {
    // The gates re-check lazily, so a failed claim-time mark only delays visibility.
    logger.warn({ err, runId: run.id }, "rk9 run taint: claim-time check failed");
  }
}

export interface TaintActor {
  actorType: "agent" | "user";
  agentId: string | null;
  runId: string | null;
  actorSource: string;
}

async function loadAgentRun(db: Db, companyId: string, agentId: string, runId: string) {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
      ),
    )
    .limit(1);
  return run ?? null;
}

async function loadActiveAgentRuns(db: Db, companyId: string, agentId: string) {
  return db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .limit(50);
}

/**
 * The runs an agent request speaks for. A signed run JWT binds exactly one
 * run. A long-lived agent key does not bind a run (the X-Paperclip-Run-Id
 * header is optional and unsigned), so every active run of the agent counts:
 * fail closed at the agent level.
 */
async function runsForActor(db: Db, companyId: string, actor: TaintActor) {
  if (actor.actorType !== "agent" || !actor.agentId) return { runs: [] as RunRow[], unboundJwt: false };
  if (actor.actorSource === "agent_jwt") {
    const run = actor.runId ? await loadAgentRun(db, companyId, actor.agentId, actor.runId) : null;
    return { runs: run ? [run] : [], unboundJwt: !run };
  }
  const runs = await loadActiveAgentRuns(db, companyId, actor.agentId);
  if (actor.runId && !runs.some((r) => r.id === actor.runId)) {
    const headerRun = await loadAgentRun(db, companyId, actor.agentId, actor.runId);
    if (headerRun) runs.push(headerRun);
  }
  return { runs, unboundJwt: false };
}

/**
 * Taint of the actor behind a request. Board users and the system are never
 * tainted. An agent JWT whose run cannot be found in the company fails closed.
 */
export async function resolveActorTaint(db: Db, companyId: string, actor: TaintActor): Promise<RunTaintState> {
  if (actor.actorType !== "agent") return CLEAN;
  const { runs, unboundJwt } = await runsForActor(db, companyId, actor);
  if (unboundJwt) return { tainted: true, runId: actor.runId, sources: [] };
  for (const run of runs) {
    const state = await resolveRunTaint(db, run);
    if (state.tainted) return state;
  }
  return CLEAN;
}

/**
 * Mark the runs of an agent that just received an inbound email body. With a
 * run JWT, that run; with an agent key, every active run of the agent.
 */
export async function markActorRunsTainted(
  db: Db,
  companyId: string,
  actor: TaintActor,
  source: Omit<Rk9RunTaintSource, "at">,
): Promise<string[]> {
  if (actor.actorType !== "agent" || !actor.agentId) return [];
  const { runs } = await runsForActor(db, companyId, actor);
  const marked: string[] = [];
  for (const run of runs) {
    const result = await markRunTainted(db, { companyId, agentId: actor.agentId, runId: run.id, source });
    if (result.marked) marked.push(run.id);
  }
  return marked;
}
// --- /RK9 Custom ---
