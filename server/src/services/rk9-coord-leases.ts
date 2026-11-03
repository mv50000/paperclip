// --- RK9 Custom (RK9-627): coord lease engine (epic RK9-620, key lease-engine) ---
//
// TTL leases with fencing tokens and a FIFO wait queue, on the tables of
// migration 9015 (rk9_coord_leases, rk9_coord_lease_waiters).
//
// Concurrency model: every state change of one (company, resource) runs in
// one transaction that first takes the transaction-scoped advisory lock of
// that resource. The lock serializes acquire, renew, release, break and the
// sweeper per resource, so the FIFO order is the waiter bigserial id and no
// position is ever computed with MAX()+1. The partial unique index
// rk9_coord_leases_active_resource_uq is the backstop.
//
// Clock: every transaction reads the DB clock once (now(), the transaction
// start time) and uses it for all comparisons and timestamps, so CLI hosts
// with a skewed clock cannot shorten or extend a lease.
//
// Every transition writes exactly one rk9_coord_events row (type `lease`,
// payload.subtype) and one activity_log row, in the same transaction:
//   grant, queue, release, expire, dead_release, adopt, break, promote,
//   dequeue (a dead waiter skipped at promotion), stuck (escalation signal,
//   once per lease). Renew is deliberately not journaled (the spec marks it
//   optional): it is frequent and changes no holder.
//
// Liveness of a holder or waiter (rk9CoordLeaseActorVerdict):
//   operator   -> always live (reachable through Telegram, TTL only);
//   agent_run  -> dead only when heartbeat_runs.status is terminal
//                 (succeeded, failed, cancelled, timed_out); an unknown run
//                 is treated conservatively (TTL only);
//   others     -> dead when the presence row is ended, or when neither the
//                 presence heartbeat nor the lease activity (acquire/renew,
//                 or the waiter's last poll) is newer than the grace period.
// Contract: docs/implementation-notes/coord-bus.md, coord-leases.md.
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  rk9CoordActors,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeaseWaiters,
  rk9CoordLeases,
} from "@paperclipai/db";
import {
  parseRk9CoordLeaseResource,
  rk9CoordTrustCanHoldHardGate,
  RK9_COORD_LEASE_TTL_DEFAULT_S,
  type Rk9CoordLeaseMode,
  type Rk9CoordLeaseResource,
  type Rk9CoordTrust,
} from "@paperclipai/shared";
import { isForeignKeyViolation } from "../db-errors.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { assertRk9CoordNoSecretFields, ensureRk9CoordActorRow, rk9CoordJournalTrust } from "./rk9-coord-journal.js";
import { resolveRk9CoordPresenceTtlS } from "./rk9-coord-presence.js";
import { toRk9CoordLine } from "./rk9-coord-text.js";

export const RK9_COORD_LEASE_HEARTBEAT_S_DEFAULT = 60;
export const RK9_COORD_LEASE_SWEEP_INTERVAL_MS_DEFAULT = 30_000;
export const RK9_COORD_LEASE_STUCK_S_DEFAULT = 1_800;
/** RK9-648 R3: the claim window of a promoted lease, capped apart from the dead-holder grace. */
export const RK9_COORD_LEASE_CLAIM_WINDOW_S_DEFAULT = 300;
/**
 * RK9-648: the largest TTL of a hard-gate lease (prod, migrate, host). A larger
 * request is clamped, never rejected (gate clients ask for up to 86 400 s and
 * renew the lease). A crashed hard-gate holder is released only by its TTL.
 */
export const RK9_COORD_LEASE_HARD_GATE_TTL_MAX_S_DEFAULT = 21_600;
/** heartbeat_runs statuses after which a run never runs again. `interrupted` can resume. */
export const RK9_COORD_TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
export const RK9_COORD_DEAD_RELEASE_REASONS = [
  "presence_stale",
  "heartbeat_run_terminal",
  "headless_run_ended",
  "remote_heartbeat_ttl",
] as const;
export type Rk9CoordDeadReleaseReason = (typeof RK9_COORD_DEAD_RELEASE_REASONS)[number];

/** Actor kinds that may break a LIVE holder's lease (parent decision on RK9-627, ADR Q5). */
export const RK9_COORD_LEASE_BREAK_KINDS: readonly string[] = ["operator", "rk9claude"];
/** Actor kinds that may not acquire, wait on, renew, release or break any lease (RK9-633). */
export const RK9_COORD_LEASE_DENIED_KINDS: readonly string[] = ["grok"];

const SWEEP_BATCH = 500;
/** Up to 50 000 active leases per sweep; the rest wait for the next tick. */
const SWEEP_MAX_PAGES = 100;
const LIST_LIMIT = 200;

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Dead-holder grace: RK9_COORD_LEASE_DEAD_GRACE_S, default 3 x the CLI
 * heartbeat interval (RK9_COORD_HEARTBEAT_S, default 60 s). The default never
 * drops below the presence TTL: an actor that presence still lists as live is
 * never released as dead.
 */
export function resolveRk9CoordLeaseDeadGraceS(env: NodeJS.ProcessEnv = process.env): number {
  if (env.RK9_COORD_LEASE_DEAD_GRACE_S) {
    return intEnv(env.RK9_COORD_LEASE_DEAD_GRACE_S, 300, 30, 86_400);
  }
  const heartbeatS = intEnv(env.RK9_COORD_HEARTBEAT_S, RK9_COORD_LEASE_HEARTBEAT_S_DEFAULT, 5, 3_600);
  return Math.max(3 * heartbeatS, resolveRk9CoordPresenceTtlS(env));
}

export function resolveRk9CoordLeaseStuckS(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RK9_COORD_LEASE_STUCK_S, RK9_COORD_LEASE_STUCK_S_DEFAULT, 60, 7 * 86_400);
}

/** RK9_COORD_LEASE_CLAIM_WINDOW_S, default 300 s, 30..3600 (RK9-648 R3). */
export function resolveRk9CoordLeaseClaimWindowS(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RK9_COORD_LEASE_CLAIM_WINDOW_S, RK9_COORD_LEASE_CLAIM_WINDOW_S_DEFAULT, 30, 3_600);
}

/**
 * RK9_COORD_LEASE_HARD_GATE_TTL_MAX_S, default 21 600 s (6 h), 3600..86 400 (RK9-648). The floor of 1 h
 * keeps every holder that renews at most every 1200 s (the rk9 gate library) inside the cap.
 */
export function resolveRk9CoordLeaseHardGateTtlMaxS(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RK9_COORD_LEASE_HARD_GATE_TTL_MAX_S, RK9_COORD_LEASE_HARD_GATE_TTL_MAX_S_DEFAULT, 3_600, 86_400);
}

/** The TTL a lease of `resource` gets: a hard-gate request above the cap is clamped to it. */
export function rk9CoordLeaseEffectiveTtlS(
  resource: Pick<Rk9CoordLeaseResource, "hardGate">,
  requestedS: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resource.hardGate ? Math.min(requestedS, resolveRk9CoordLeaseHardGateTtlMaxS(env)) : requestedS;
}

export function resolveRk9CoordLeaseSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RK9_COORD_LEASE_SWEEP_INTERVAL_MS, RK9_COORD_LEASE_SWEEP_INTERVAL_MS_DEFAULT, 1_000, 3_600_000);
}

function coordError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

// ---------------------------------------------------------------- liveness

export interface Rk9CoordLeaseActorState {
  kind: string;
  endedAt: Date | null;
  lastSeenAt: Date;
  /** heartbeat_runs.status of an agent_run actor; null when unknown. */
  runStatus: string | null;
}

export type Rk9CoordLeaseVerdict = { alive: true } | { alive: false; reason: Rk9CoordDeadReleaseReason };

function deadReasonFor(kind: string): Rk9CoordDeadReleaseReason {
  if (kind === "headless") return "headless_run_ended";
  if (kind === "remote") return "remote_heartbeat_ttl";
  return "presence_stale";
}

function runIsTerminal(actor: Rk9CoordLeaseActorState): boolean {
  return Boolean(actor.runStatus && (RK9_COORD_TERMINAL_RUN_STATUSES as readonly string[]).includes(actor.runStatus));
}

/** Presence ended after the actor last touched the lease (an old ended_at does not count). */
function endedSince(actor: Rk9CoordLeaseActorState, since: Date | null): boolean {
  if (!actor.endedAt) return false;
  return !since || actor.endedAt.getTime() > since.getTime();
}

/**
 * Pure liveness rule for a lease HOLDER.
 * - operator: never dead (TTL only).
 * - agent_run: dead only when its heartbeat run is terminal.
 * - every other kind: dead when its presence ended after `lastActivityAt`
 *   (the lease's acquire/renew). A hard-gate lease is released early ONLY on
 *   that explicit signal: the CLI heartbeats presence from hooks, so a session
 *   inside one long tool call (a migration, a deploy) looks stale while it
 *   still works. An advisory lease (repo, vault) is also released when
 *   neither presence nor lease activity is newer than the grace period.
 */
export function rk9CoordLeaseActorVerdict(
  actor: Rk9CoordLeaseActorState,
  opts: { now: Date; graceS: number; hardGate: boolean; lastActivityAt: Date | null },
): Rk9CoordLeaseVerdict {
  if (actor.kind === "operator") return { alive: true };
  if (actor.kind === "agent_run") {
    return runIsTerminal(actor) ? { alive: false, reason: "heartbeat_run_terminal" } : { alive: true };
  }
  if (endedSince(actor, opts.lastActivityAt)) return { alive: false, reason: deadReasonFor(actor.kind) };
  if (opts.hardGate) return { alive: true };
  const now = opts.now.getTime();
  const graceMs = opts.graceS * 1000;
  if (actor.lastSeenAt.getTime() + graceMs > now) return { alive: true };
  if (opts.lastActivityAt && opts.lastActivityAt.getTime() + graceMs > now) return { alive: true };
  return { alive: false, reason: deadReasonFor(actor.kind) };
}

/**
 * Pure liveness rule for a WAITER: only its own polls count, never its
 * presence. A session whose `rk9 lease wait` timed out keeps heartbeating
 * presence from hooks, but it no longer waits; promoting it would block the
 * resource for a whole TTL. `pollUntil` is the waiter's expires_at (last
 * acquire poll + grace).
 */
export function rk9CoordLeaseWaiterAlive(
  actor: Rk9CoordLeaseActorState,
  opts: { now: Date; pollUntil: Date | null; lastPollAt: Date | null },
): boolean {
  if (actor.kind === "agent_run" && runIsTerminal(actor)) return false;
  if (endedSince(actor, opts.lastPollAt)) return false;
  return Boolean(opts.pollUntil && opts.pollUntil.getTime() > opts.now.getTime());
}

// ---------------------------------------------------------------- types

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type LeaseRow = typeof rk9CoordLeases.$inferSelect;
type WaiterRow = typeof rk9CoordLeaseWaiters.$inferSelect;

interface ActorInfo extends Rk9CoordLeaseActorState {
  id: string;
  actorRef: string;
  phase: string | null;
}

/** activity_log author of a coord mutation (routes/rk9-coord-events.ts rk9CoordActivityActor). */
export interface Rk9CoordLeaseActivityActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId?: string | null;
}

export interface Rk9CoordLeaseCaller {
  actor: Rk9CoordResolvedActor;
  activity: Rk9CoordLeaseActivityActor;
  /** Agent behind an agent_run actor (stub actor row). */
  agentId?: string | null;
}

interface EventAuthor {
  actorRef: string;
  actorKind: string;
  trust: Rk9CoordTrust;
  activity: Rk9CoordLeaseActivityActor;
}

export const RK9_COORD_LEASE_SWEEPER_ACTOR = "orch:rk9-lease-sweeper";
const SWEEPER_AUTHOR: EventAuthor = {
  actorRef: RK9_COORD_LEASE_SWEEPER_ACTOR,
  actorKind: "orch",
  trust: "verified",
  activity: { actorType: "system", actorId: "rk9-lease-sweeper", agentId: null, runId: null },
};

interface Ctx {
  tx: Tx;
  companyId: string;
  now: Date;
  graceS: number;
  /** Claim window of a promoted lease (RK9-648 R3). */
  claimWindowS: number;
  author: EventAuthor;
  publications: ActivityPublication[];
  /** Sweeper counter: dead waiters dequeued in this transaction. */
  stats?: { dequeued: number };
}

export interface Rk9CoordLeaseQueueEntry {
  actor: string;
  position: number;
}

export interface Rk9CoordLeaseGranted {
  granted: true;
  queued: false;
  resource: string;
  lease_id: string;
  fencing_token: number;
  expires_at: string;
  mode: Rk9CoordLeaseMode;
  holder: string;
  /** True when the caller already held this lease (re-entrant acquire, or a promoted waiter polling). */
  already_held: boolean;
  /** Previous holder of an adopted (expired or dead-holder) lease. */
  adopted_from: string | null;
}

export interface Rk9CoordLeaseNotGranted {
  granted: false;
  /** True when the caller is in the wait queue. */
  queued: boolean;
  resource: string;
  position: number | null;
  holder: string;
  holder_phase: string | null;
  expires_at: string;
  /** Estimated grant time: the holder's expiry plus the TTLs of the waiters ahead. */
  eta: string;
}

export type Rk9CoordLeaseAcquireResult = Rk9CoordLeaseGranted | Rk9CoordLeaseNotGranted;

export type Rk9CoordLeaseMutationResult =
  | { ok: true; lease_id: string; resource: string; expires_at: string | null; noop: boolean; release_reason: string | null }
  | { ok: false; code: "rk9_coord_lease_stale"; lease_id: string; resource: string; release_reason: string | null };

export interface Rk9CoordLeaseView {
  lease_id: string;
  resource: string;
  holder: string;
  holder_kind: string;
  holder_phase: string | null;
  mode: string;
  reason: string | null;
  acquired_at: string;
  renewed_at: string | null;
  expires_at: string;
  expired: boolean;
  queue: Rk9CoordLeaseQueueEntry[];
}

export interface Rk9CoordLeaseSweepResult {
  expired: number;
  deadReleased: number;
  promoted: number;
  dequeued: number;
  stuck: number;
  skipped: number;
}

// ---------------------------------------------------------------- helpers

function iso(date: Date): string {
  return date.toISOString();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function lockKey(companyId: string, resource: string): string {
  return `rk9_coord_lease:${companyId}:${resource}`;
}

async function lockResource(tx: Tx, companyId: string, resource: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(companyId, resource)}, 0))`);
}

async function tryLockResource(tx: Tx, companyId: string, resource: string): Promise<boolean> {
  const [row] = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey(companyId, resource)}, 0)) as locked`,
  );
  return row?.locked === true;
}

/**
 * The DB clock, read after the resource lock (clock_timestamp(), not now():
 * now() is the transaction start, before a possibly long lock wait).
 */
async function dbNow(tx: Tx | Db): Promise<Date> {
  const [row] = await tx.execute<{ now: string }>(
    sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
  );
  return new Date(row!.now);
}

function requireResource(value: string): Rk9CoordLeaseResource {
  const parsed = parseRk9CoordLeaseResource(value);
  if (!parsed) {
    throw coordError(
      422,
      "rk9_coord_lease_resource_invalid",
      "resource must be prod:<app>, migrate:<db>, repo:<repo>[@<branch>], vault:<note> or host:<node>",
    );
  }
  assertRk9CoordNoSecretFields({ resource: parsed.resource });
  return parsed;
}

/**
 * RK9-633: the grok service may acquire, wait on, renew, release or break no
 * lease of any prefix. `remote` keeps the ADR rule: soft prefixes are allowed,
 * hard gates are not.
 */
export function assertRk9CoordLeaseKind(actor: Rk9CoordResolvedActor) {
  if (RK9_COORD_LEASE_DENIED_KINDS.includes(actor.kind)) {
    throw coordError(403, "rk9_coord_lease_kind_not_allowed", `A ${actor.kind} actor cannot use leases`);
  }
}

/**
 * Hard-gate leases (prod, migrate, host) need verified or attributed trust.
 * An agent-key actor is `attributed` but can name any running sibling run of
 * its agent (ADR open point, RK9-621), so an agent_run actor must hold and
 * change a hard-gate lease with a run JWT (`verified`).
 */
export function assertRk9CoordLeaseTrust(actor: Rk9CoordResolvedActor, resource: Rk9CoordLeaseResource) {
  assertRk9CoordLeaseKind(actor);
  if (!resource.hardGate) return;
  if (!rk9CoordTrustCanHoldHardGate(actor.trust)) {
    throw coordError(
      403,
      "rk9_coord_lease_trust_insufficient",
      `An ${actor.trust} actor cannot hold a ${resource.prefix}: lease; ask the operator`,
    );
  }
  if (actor.kind === "agent_run" && actor.trust !== "verified") {
    throw coordError(
      403,
      "rk9_coord_lease_run_jwt_required",
      `An agent run needs its run JWT (not an agent key) for a ${resource.prefix}: lease`,
    );
  }
}

function authorFor(caller: Rk9CoordLeaseCaller): EventAuthor {
  return {
    actorRef: caller.actor.actorId,
    actorKind: caller.actor.kind,
    trust: rk9CoordJournalTrust(caller.actor),
    activity: caller.activity,
  };
}

async function loadActors(tx: Tx | Db, ids: string[]): Promise<Map<string, ActorInfo>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({
      id: rk9CoordActors.id,
      actorRef: rk9CoordActors.actorRef,
      kind: rk9CoordActors.kind,
      phase: rk9CoordActors.phase,
      lastSeenAt: rk9CoordActors.lastSeenAt,
      endedAt: rk9CoordActors.endedAt,
      runStatus: heartbeatRuns.status,
    })
    .from(rk9CoordActors)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, rk9CoordActors.runId))
    .where(inArray(rk9CoordActors.id, unique));
  return new Map(rows.map((row) => [row.id, { ...row, runStatus: row.runStatus ?? null }]));
}

function holderVerdict(holder: ActorInfo | undefined, lease: LeaseRow, ctx: Pick<Ctx, "now" | "graceS">) {
  // A holder row cannot vanish (FK cascade deletes its leases), but be safe: TTL only.
  if (!holder) return { alive: true } as Rk9CoordLeaseVerdict;
  return rk9CoordLeaseActorVerdict(holder, {
    now: ctx.now,
    graceS: ctx.graceS,
    hardGate: parseRk9CoordLeaseResource(lease.resource)?.hardGate ?? true,
    lastActivityAt: lease.renewedAt ?? lease.acquiredAt,
  });
}

function isExpired(lease: Pick<LeaseRow, "expiresAt">, now: Date): boolean {
  return lease.expiresAt.getTime() <= now.getTime();
}

async function selectActiveLease(tx: Tx, companyId: string, resource: string, skipLocked = false) {
  const query = tx
    .select()
    .from(rk9CoordLeases)
    .where(
      and(
        eq(rk9CoordLeases.companyId, companyId),
        eq(rk9CoordLeases.resource, resource),
        isNull(rk9CoordLeases.releasedAt),
      ),
    )
    .limit(1);
  const [row] = await (skipLocked ? query.for("update", { skipLocked: true }) : query.for("update"));
  return row ?? null;
}

/** One transition: one journal row of type `lease` plus one activity_log row. */
async function transition(
  ctx: Ctx,
  input: {
    subtype: string;
    resource: string;
    leaseId: string | null;
    summary: string;
    payload: Record<string, unknown>;
    dedupeKey?: string;
    /** Kept out of the journal (every coord reader sees it); activity_log only. */
    fencingToken?: number | null;
  },
): Promise<number | null> {
  const parsed = parseRk9CoordLeaseResource(input.resource);
  const repo = parsed?.repo && parsed.repo.length <= 200 ? parsed.repo : null;
  const payload = { subtype: input.subtype, resource: input.resource, lease_id: input.leaseId, ...input.payload };
  const insert = ctx.tx.insert(rk9CoordEvents).values({
    companyId: ctx.companyId,
    type: "lease",
    actorRef: ctx.author.actorRef,
    actorKind: ctx.author.actorKind,
    trust: ctx.author.trust,
    resource: input.resource,
    repo,
    summary: toRk9CoordLine(input.summary, 300) ?? `lease ${input.subtype}`,
    payload,
    dedupeKey: input.dedupeKey ?? null,
  });
  const rows = input.dedupeKey
    ? await insert.onConflictDoNothing().returning({ id: rk9CoordEvents.id })
    : await insert.returning({ id: rk9CoordEvents.id });
  const eventId = rows[0]?.id ?? null;
  if (eventId === null) return null;
  const details: Record<string, unknown> = { subtype: input.subtype, resource: input.resource, event_id: eventId };
  for (const key of ["holder", "previous_holder", "release_reason", "position", "actor"]) {
    if (payload[key as keyof typeof payload] !== undefined) details[key] = payload[key as keyof typeof payload];
  }
  if (input.fencingToken !== undefined && input.fencingToken !== null) details.fencing_token = input.fencingToken;
  await logActivity(
    ctx.tx as unknown as Db,
    {
      companyId: ctx.companyId,
      ...ctx.author.activity,
      action: `rk9.coord.lease_${input.subtype}`,
      entityType: "rk9_coord_lease",
      entityId: input.leaseId ?? input.resource,
      details,
    },
    ctx.publications,
  );
  return eventId;
}

async function insertLease(
  ctx: Ctx,
  input: { resource: string; holderActorId: string; ttlS: number; reason: string | null; mode: Rk9CoordLeaseMode },
): Promise<LeaseRow> {
  const [row] = await ctx.tx
    .insert(rk9CoordLeases)
    .values({
      companyId: ctx.companyId,
      resource: input.resource,
      holderActorId: input.holderActorId,
      mode: input.mode,
      reason: input.reason,
      acquiredAt: ctx.now,
      expiresAt: addSeconds(ctx.now, input.ttlS),
    })
    .returning();
  return row!;
}

async function markReleased(ctx: Ctx, lease: LeaseRow, reason: string) {
  await ctx.tx
    .update(rk9CoordLeases)
    .set({ releasedAt: ctx.now, releaseReason: reason })
    .where(and(eq(rk9CoordLeases.id, lease.id), isNull(rk9CoordLeases.releasedAt)));
}

function waiterAlive(ctx: Pick<Ctx, "now" | "graceS">, actor: ActorInfo, waiter: WaiterRow): boolean {
  return rk9CoordLeaseWaiterAlive(actor, {
    now: ctx.now,
    pollUntil: waiter.expiresAt,
    lastPollAt: waiter.expiresAt ? addSeconds(waiter.expiresAt, -ctx.graceS) : waiter.enqueuedAt,
  });
}

/** Remove every waiter of `resource` that no longer polls (one `dequeue` event each). */
async function dequeueDeadWaiters(ctx: Ctx, resource: string): Promise<number> {
  const waiters = await ctx.tx
    .select()
    .from(rk9CoordLeaseWaiters)
    .where(and(eq(rk9CoordLeaseWaiters.companyId, ctx.companyId), eq(rk9CoordLeaseWaiters.resource, resource)))
    .orderBy(asc(rk9CoordLeaseWaiters.id))
    .for("update");
  const actors = await loadActors(ctx.tx, waiters.map((waiter) => waiter.actorId));
  let removed = 0;
  for (const waiter of waiters) {
    const actor = actors.get(waiter.actorId);
    if (actor && waiterAlive(ctx, actor, waiter)) continue;
    await ctx.tx.delete(rk9CoordLeaseWaiters).where(eq(rk9CoordLeaseWaiters.id, waiter.id));
    const actorRef = actor?.actorRef ?? "unknown";
    await transition(ctx, {
      subtype: "dequeue",
      resource,
      leaseId: null,
      summary: `dequeue ${resource}: ${actorRef} (waiter_gone)`,
      payload: { actor: actorRef, dequeue_reason: "waiter_gone" },
    });
    removed += 1;
    if (ctx.stats) ctx.stats.dequeued += 1;
  }
  return removed;
}

/** True when a live waiter stands ahead of `selfActorId` (or anywhere, when the caller is not queued). */
async function hasLiveWaiterAhead(ctx: Ctx, resource: string, selfActorId: string): Promise<boolean> {
  const waiters = await ctx.tx
    .select()
    .from(rk9CoordLeaseWaiters)
    .where(and(eq(rk9CoordLeaseWaiters.companyId, ctx.companyId), eq(rk9CoordLeaseWaiters.resource, resource)))
    .orderBy(asc(rk9CoordLeaseWaiters.id));
  const actors = await loadActors(ctx.tx, waiters.map((waiter) => waiter.actorId));
  for (const waiter of waiters) {
    if (waiter.actorId === selfActorId) return false;
    const actor = actors.get(waiter.actorId);
    if (actor && waiterAlive(ctx, actor, waiter)) return true;
  }
  return false;
}

/**
 * Promote the first live waiter of `resource`. Dead waiters ahead of it are
 * dequeued (one `dequeue` event each). Stops without promoting when it
 * reaches `stopAtActorId` (the caller's own queue entry). The caller must hold
 * the resource lock and have released any active lease.
 */
async function promoteNext(
  ctx: Ctx,
  resource: string,
  opts: { stopAtActorId?: string | null } = {},
): Promise<{ lease: LeaseRow; holder: ActorInfo } | null> {
  const waiters = await ctx.tx
    .select()
    .from(rk9CoordLeaseWaiters)
    .where(and(eq(rk9CoordLeaseWaiters.companyId, ctx.companyId), eq(rk9CoordLeaseWaiters.resource, resource)))
    .orderBy(asc(rk9CoordLeaseWaiters.id))
    .for("update");
  if (waiters.length === 0) return null;
  const actors = await loadActors(ctx.tx, waiters.map((waiter) => waiter.actorId));
  for (const waiter of waiters) {
    if (opts.stopAtActorId && waiter.actorId === opts.stopAtActorId) return null;
    const actor = actors.get(waiter.actorId);
    const alive = actor ? waiterAlive(ctx, actor, waiter) : false;
    await ctx.tx.delete(rk9CoordLeaseWaiters).where(eq(rk9CoordLeaseWaiters.id, waiter.id));
    const actorRef = actor?.actorRef ?? "unknown";
    if (!alive) {
      if (ctx.stats) ctx.stats.dequeued += 1;
      await transition(ctx, {
        subtype: "dequeue",
        resource,
        leaseId: null,
        summary: `dequeue ${resource}: ${actorRef} (waiter_gone)`,
        payload: { actor: actorRef, dequeue_reason: "waiter_gone" },
      });
      continue;
    }
    const lease = await insertLease(ctx, {
      resource,
      holderActorId: waiter.actorId,
      // Claim window: a promoted waiter may have gone (Ctrl-C on `rk9 lease
      // wait`). The lease first lives for at most the grace period and the
      // claim window cap (RK9-648 R3: the grace can be up to 86 400 s); the
      // holder's next acquire poll (already_held) extends it to its TTL.
      ttlS: Math.min(waiter.requestedTtlSeconds ?? RK9_COORD_LEASE_TTL_DEFAULT_S, ctx.graceS, ctx.claimWindowS),
      reason: waiter.reason,
      mode: waiter.mode,
    });
    await transition(ctx, {
      subtype: "promote",
      resource,
      leaseId: lease.id,
      summary: `promote ${resource} -> ${actorRef}`,
      payload: { holder: actorRef, expires_at: iso(lease.expiresAt) },
      fencingToken: lease.fencingToken,
    });
    await ctx.tx.insert(rk9CoordInbox).values({
      companyId: ctx.companyId,
      toActorId: waiter.actorId,
      fromActorRef: ctx.author.actorRef,
      kind: "lease_promote",
      body:
        toRk9CoordLine(
          `Lease granted from the queue: ${resource} (expires ${iso(lease.expiresAt)}). Run rk9 lease wait ${resource} to pick it up.`,
          500,
        ) ?? `Lease granted: ${resource}`,
    });
    return { lease, holder: actor! };
  }
  return null;
}

async function queueSnapshot(tx: Tx | Db, companyId: string, resources: string[]) {
  const out = new Map<string, Rk9CoordLeaseQueueEntry[]>();
  if (resources.length === 0) return out;
  const rows = await tx
    .select({ resource: rk9CoordLeaseWaiters.resource, actor: rk9CoordActors.actorRef })
    .from(rk9CoordLeaseWaiters)
    .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeaseWaiters.actorId))
    .where(and(eq(rk9CoordLeaseWaiters.companyId, companyId), inArray(rk9CoordLeaseWaiters.resource, resources)))
    .orderBy(asc(rk9CoordLeaseWaiters.id));
  for (const row of rows) {
    const queue = out.get(row.resource) ?? [];
    queue.push({ actor: row.actor, position: queue.length + 1 });
    out.set(row.resource, queue);
  }
  return out;
}

/** Release `lease` with `reason`, record one transition, then promote the next live waiter. */
async function releaseAndPromote(
  ctx: Ctx,
  lease: LeaseRow,
  holderRef: string,
  input: { subtype: string; reason: string; extra?: Record<string, unknown> },
) {
  await markReleased(ctx, lease, input.reason);
  await transition(ctx, {
    subtype: input.subtype,
    resource: lease.resource,
    leaseId: lease.id,
    summary: `${input.subtype} ${lease.resource}: ${holderRef} (${input.reason})`,
    payload: {
      holder: holderRef,
      release_reason: input.reason,
      ...(input.extra ?? {}),
    },
    fencingToken: lease.fencingToken,
  });
  return promoteNext(ctx, lease.resource);
}

// ---------------------------------------------------------------- service

export interface Rk9CoordLeaseServiceOptions {
  env?: NodeJS.ProcessEnv;
}

export function rk9CoordLeaseService(db: Db, opts: Rk9CoordLeaseServiceOptions = {}) {
  const env = opts.env ?? process.env;

  async function inTx<T>(
    companyId: string,
    author: EventAuthor,
    resource: string | null,
    run: (ctx: Ctx) => Promise<T>,
  ): Promise<T> {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      if (resource) await lockResource(tx, companyId, resource);
      const now = await dbNow(tx);
      return run({
        tx,
        companyId,
        now,
        graceS: resolveRk9CoordLeaseDeadGraceS(env),
        claimWindowS: resolveRk9CoordLeaseClaimWindowS(env),
        author,
        publications,
      });
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function notGranted(
    ctx: Ctx,
    lease: LeaseRow,
    holder: ActorInfo | undefined,
    selfActorId: string,
    queued: boolean,
  ): Promise<Rk9CoordLeaseNotGranted> {
    const waiters = await ctx.tx
      .select({ actorId: rk9CoordLeaseWaiters.actorId, ttl: rk9CoordLeaseWaiters.requestedTtlSeconds })
      .from(rk9CoordLeaseWaiters)
      .where(and(eq(rk9CoordLeaseWaiters.companyId, ctx.companyId), eq(rk9CoordLeaseWaiters.resource, lease.resource)))
      .orderBy(asc(rk9CoordLeaseWaiters.id));
    const index = waiters.findIndex((waiter) => waiter.actorId === selfActorId);
    const ahead = index >= 0 ? waiters.slice(0, index) : waiters;
    // RK9-664: a waiter row queued before the cap existed (RK9-648) can still ask for up to 86 400 s.
    // Clamp it here like a grant, so the ETA never counts more than the waiter can hold.
    const parsed = parseRk9CoordLeaseResource(lease.resource);
    const aheadS = ahead.reduce(
      (sum, waiter) =>
        sum +
        (parsed
          ? rk9CoordLeaseEffectiveTtlS(parsed, waiter.ttl ?? RK9_COORD_LEASE_TTL_DEFAULT_S, env)
          : (waiter.ttl ?? RK9_COORD_LEASE_TTL_DEFAULT_S)),
      0,
    );
    const base = lease.expiresAt.getTime() > ctx.now.getTime() ? lease.expiresAt : ctx.now;
    return {
      granted: false,
      queued,
      resource: lease.resource,
      position: index >= 0 ? index + 1 : null,
      holder: holder?.actorRef ?? "unknown",
      holder_phase: holder?.phase ?? null,
      expires_at: iso(lease.expiresAt),
      eta: iso(addSeconds(base, aheadS)),
    };
  }

  function grantedView(lease: LeaseRow, holderRef: string, alreadyHeld: boolean, adoptedFrom: string | null) {
    return {
      granted: true as const,
      queued: false as const,
      resource: lease.resource,
      lease_id: lease.id,
      fencing_token: lease.fencingToken,
      expires_at: iso(lease.expiresAt),
      mode: lease.mode,
      holder: holderRef,
      already_held: alreadyHeld,
      adopted_from: adoptedFrom,
    };
  }

  /**
   * POST /leases/acquire. One transaction under the resource lock:
   * - free resource -> grant (unless live waiters are ahead: then they go first);
   * - caller already holds it -> granted, no event;
   * - expired or dead holder -> adopt (one event, previous holder in the
   *   payload) when no live waiter is ahead of the caller; otherwise the old
   *   lease is released, the head waiter promoted, and the caller queued;
   * - live holder -> queue (wait=true) or a not-granted answer (wait=false; 409 at the route).
   *
   * RK9-684 item 7: the prune (rk9-coord-retention.ts) may delete a stale
   * stub actor row while this acquire waits on its row lock; the lease or
   * waiter insert then fails on the foreign key. The acquire runs once more
   * (ensureRk9CoordActorRow creates a fresh row) and then answers 503
   * `rk9_coord_lease_retry`, never 500.
   */
  async function acquire(
    companyId: string,
    caller: Rk9CoordLeaseCaller,
    input: { resource: string; ttlS?: number; reason?: string | null; wait?: boolean; mode?: Rk9CoordLeaseMode },
  ): Promise<Rk9CoordLeaseAcquireResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await acquireOnce(companyId, caller, input);
      } catch (err) {
        if (!isForeignKeyViolation(err)) throw err;
        logger.warn(
          { event: "rk9_coord_lease_acquire_actor_pruned", companyId, actor: caller.actor.actorId, attempt },
          "lease acquire lost its actor row to the prune",
        );
        if (attempt >= 2) {
          // The code is the retry signal: the error handler passes only `code`.
          throw coordError(503, "rk9_coord_lease_retry", "The actor row was pruned during the acquire; try again");
        }
      }
    }
  }

  async function acquireOnce(
    companyId: string,
    caller: Rk9CoordLeaseCaller,
    input: { resource: string; ttlS?: number; reason?: string | null; wait?: boolean; mode?: Rk9CoordLeaseMode },
  ): Promise<Rk9CoordLeaseAcquireResult> {
    assertRk9CoordLeaseKind(caller.actor);
    const parsed = requireResource(input.resource);
    assertRk9CoordLeaseTrust(caller.actor, parsed);
    const self = await ensureRk9CoordActorRow(db, companyId, caller.actor, caller.agentId ?? null);
    const ttlS = rk9CoordLeaseEffectiveTtlS(parsed, input.ttlS ?? RK9_COORD_LEASE_TTL_DEFAULT_S, env);
    const reason = toRk9CoordLine(input.reason ?? null, 300);
    const mode = input.mode ?? "enforce";
    const wait = input.wait === true;
    const resource = parsed.resource;

    return inTx(companyId, authorFor(caller), resource, async (ctx) => {
      const grant = async (adopted: { lease: LeaseRow; holderRef: string; reason: string } | null) => {
        await ctx.tx
          .delete(rk9CoordLeaseWaiters)
          .where(
            and(
              eq(rk9CoordLeaseWaiters.companyId, companyId),
              eq(rk9CoordLeaseWaiters.resource, resource),
              eq(rk9CoordLeaseWaiters.actorId, self.id),
            ),
          );
        if (adopted) await markReleased(ctx, adopted.lease, adopted.reason);
        const lease = await insertLease(ctx, { resource, holderActorId: self.id, ttlS, reason, mode });
        await transition(ctx, {
          subtype: adopted ? "adopt" : "grant",
          resource,
          leaseId: lease.id,
          summary: adopted
            ? `adopt ${resource} from ${adopted.holderRef} (${adopted.reason})`
            : `grant ${resource}`,
          fencingToken: lease.fencingToken,
          payload: {
            holder: self.actorRef,
            expires_at: iso(lease.expiresAt),
            ...(reason ? { reason } : {}),
            ...(adopted
              ? {
                  previous_holder: adopted.holderRef,
                  previous_lease_id: adopted.lease.id,
                  release_reason: adopted.reason,
                }
              : {}),
          },
        });
        return grantedView(lease, self.actorRef, false, adopted?.holderRef ?? null);
      };

      let active = await selectActiveLease(ctx.tx, companyId, resource);
      let holder: ActorInfo | undefined;
      if (active) {
        holder = (await loadActors(ctx.tx, [active.holderActorId])).get(active.holderActorId);
        const expired = isExpired(active, ctx.now);
        if (active.holderActorId === self.id && !expired) {
          if (active.renewedAt === null) {
            // First poll of the holder (a promoted waiter claiming its lease):
            // extend the claim window to the requested TTL, never shorten it.
            const claimed = addSeconds(ctx.now, ttlS);
            if (claimed.getTime() > active.expiresAt.getTime()) {
              const [updated] = await ctx.tx
                .update(rk9CoordLeases)
                .set({ expiresAt: claimed, renewedAt: ctx.now })
                .where(eq(rk9CoordLeases.id, active.id))
                .returning();
              if (updated) active = updated;
            }
          }
          return grantedView(active, self.actorRef, true, null);
        }
        const verdict = holderVerdict(holder, active, ctx);
        if (expired || !verdict.alive) {
          const releaseReason = expired ? "ttl_expired" : (verdict as { reason: string }).reason;
          const holderRef = holder?.actorRef ?? "unknown";
          // Nobody live ahead of the caller: inline takeover; the adopt event records the release (one event).
          if (!(await hasLiveWaiterAhead(ctx, resource, self.id))) {
            return grant({ lease: active, holderRef, reason: releaseReason });
          }
          // FIFO: the stale lease goes to the head waiter first (release event, then promote).
          const promoted = await releaseAndPromote(ctx, active, holderRef, {
            subtype: expired ? "expire" : "dead_release",
            reason: releaseReason,
          });
          if (!promoted) return grant(null);
          active = promoted.lease;
          holder = promoted.holder;
        }
      } else {
        const promoted = await promoteNext(ctx, resource, { stopAtActorId: self.id });
        if (!promoted) return grant(null);
        active = promoted.lease;
        holder = promoted.holder;
      }

      // A live holder that is not the caller.
      if (!wait) {
        const view = await notGranted(ctx, active, holder, self.id, false);
        if (view.position === null) return view;
        // Already in the queue from an earlier wait: say so (no 409, place
        // kept). RK9-648 R1: like a wait=true poll, it refreshes the waiter's
        // liveness, so a caller that polls with wait=false is not dequeued.
        await ctx.tx
          .update(rk9CoordLeaseWaiters)
          .set({ expiresAt: addSeconds(ctx.now, ctx.graceS) })
          .where(
            and(
              eq(rk9CoordLeaseWaiters.companyId, companyId),
              eq(rk9CoordLeaseWaiters.resource, resource),
              eq(rk9CoordLeaseWaiters.actorId, self.id),
            ),
          );
        return { ...view, queued: true };
      }
      const [waiter] = await ctx.tx
        .insert(rk9CoordLeaseWaiters)
        .values({
          companyId,
          resource,
          actorId: self.id,
          mode,
          reason,
          requestedTtlSeconds: ttlS,
          enqueuedAt: ctx.now,
          expiresAt: addSeconds(ctx.now, ctx.graceS),
        })
        .onConflictDoUpdate({
          target: [rk9CoordLeaseWaiters.companyId, rk9CoordLeaseWaiters.resource, rk9CoordLeaseWaiters.actorId],
          // A poll keeps the queue place and refreshes the waiter's liveness.
          set: { expiresAt: addSeconds(ctx.now, ctx.graceS) },
        })
        .returning({ id: rk9CoordLeaseWaiters.id, inserted: sql<boolean>`(xmax = 0)` });
      const view = await notGranted(ctx, active, holder, self.id, true);
      if (waiter?.inserted) {
        await transition(ctx, {
          subtype: "queue",
          resource,
          leaseId: active.id,
          summary: `queue ${resource}: ${self.actorRef} at ${view.position} behind ${view.holder}`,
          payload: { actor: self.actorRef, holder: view.holder, position: view.position },
        });
      }
      return view;
    });
  }

  async function loadOwnLease(
    companyId: string,
    caller: Rk9CoordLeaseCaller,
    leaseId: string,
  ): Promise<{ lease: LeaseRow; parsed: Rk9CoordLeaseResource; selfId: string | null }> {
    const [lease] = await db
      .select()
      .from(rk9CoordLeases)
      .where(and(eq(rk9CoordLeases.id, leaseId), eq(rk9CoordLeases.companyId, companyId)))
      .limit(1);
    if (!lease) throw coordError(404, "rk9_coord_lease_not_found", "No such lease");
    const parsed = parseRk9CoordLeaseResource(lease.resource);
    if (!parsed) throw coordError(404, "rk9_coord_lease_not_found", "No such lease");
    const [self] = await db
      .select({ id: rk9CoordActors.id })
      .from(rk9CoordActors)
      .where(and(eq(rk9CoordActors.companyId, companyId), eq(rk9CoordActors.actorRef, caller.actor.actorId)))
      .limit(1);
    return { lease, parsed, selfId: self?.id ?? null };
  }

  /** Lock, re-read the lease row, and apply the holder/trust/fencing checks shared by renew and release. */
  async function lockedOwnLease(
    ctx: Ctx,
    caller: Rk9CoordLeaseCaller,
    leaseId: string,
    selfId: string | null,
    parsed: Rk9CoordLeaseResource,
    fencingToken: number | null | undefined,
  ) {
    assertRk9CoordLeaseKind(caller.actor);
    const [lease] = await ctx.tx
      .select()
      .from(rk9CoordLeases)
      .where(and(eq(rk9CoordLeases.id, leaseId), eq(rk9CoordLeases.companyId, ctx.companyId)))
      .for("update");
    if (!lease) throw coordError(404, "rk9_coord_lease_not_found", "No such lease");
    if (!selfId || lease.holderActorId !== selfId) {
      throw coordError(403, "rk9_coord_lease_not_holder", "Only the holder may change this lease (the operator uses break)");
    }
    assertRk9CoordLeaseTrust(caller.actor, parsed);
    const fencingMismatch = fencingToken !== null && fencingToken !== undefined && fencingToken !== lease.fencingToken;
    return { lease, fencingMismatch };
  }

  /** An expired, unswept lease of the caller: record the expiry and promote, then report it stale. */
  async function expireStale(ctx: Ctx, lease: LeaseRow, holderRef: string) {
    // The expiry is the sweeper's transition, whoever triggers it.
    await releaseAndPromote({ ...ctx, author: SWEEPER_AUTHOR }, lease, holderRef, { subtype: "expire", reason: "ttl_expired" });
  }

  /** POST /leases/:leaseId/renew: the holder with the current fencing token extends expires_at. */
  async function renew(
    companyId: string,
    caller: Rk9CoordLeaseCaller,
    leaseId: string,
    input: { fencingToken: number; ttlS?: number },
  ): Promise<Rk9CoordLeaseMutationResult> {
    // Kind first (RK9-648): a denied kind learns nothing about which lease ids exist.
    assertRk9CoordLeaseKind(caller.actor);
    const { lease: found, parsed, selfId } = await loadOwnLease(companyId, caller, leaseId);
    return inTx(companyId, authorFor(caller), found.resource, async (ctx) => {
      const { lease, fencingMismatch } = await lockedOwnLease(ctx, caller, leaseId, selfId, parsed, input.fencingToken);
      if (lease.releasedAt || fencingMismatch) {
        return { ok: false, code: "rk9_coord_lease_stale", lease_id: lease.id, resource: lease.resource, release_reason: lease.releaseReason };
      }
      if (isExpired(lease, ctx.now)) {
        await expireStale(ctx, lease, caller.actor.actorId);
        return { ok: false, code: "rk9_coord_lease_stale", lease_id: lease.id, resource: lease.resource, release_reason: "ttl_expired" };
      }
      const expiresAt = addSeconds(ctx.now, rk9CoordLeaseEffectiveTtlS(parsed, input.ttlS ?? RK9_COORD_LEASE_TTL_DEFAULT_S, env));
      await ctx.tx
        .update(rk9CoordLeases)
        .set({ expiresAt, renewedAt: ctx.now })
        .where(eq(rk9CoordLeases.id, lease.id));
      return { ok: true, lease_id: lease.id, resource: lease.resource, expires_at: iso(expiresAt), noop: false, release_reason: null };
    });
  }

  /**
   * POST /leases/:leaseId/release. Idempotent: a lease the holder already
   * released answers ok+noop with no second event. A lease lost to expiry,
   * takeover or break, or a stale fencing token, is `stale` (409).
   */
  async function release(
    companyId: string,
    caller: Rk9CoordLeaseCaller,
    leaseId: string,
    input: { fencingToken?: number | null },
  ): Promise<Rk9CoordLeaseMutationResult> {
    assertRk9CoordLeaseKind(caller.actor);
    const { lease: found, parsed, selfId } = await loadOwnLease(companyId, caller, leaseId);
    return inTx(companyId, authorFor(caller), found.resource, async (ctx) => {
      const { lease, fencingMismatch } = await lockedOwnLease(ctx, caller, leaseId, selfId, parsed, input.fencingToken);
      // A replay of the holder's own release is a no-op; a token that is not
      // this lease's (RK9-648 R2) is 409 even after the release.
      if (lease.releasedAt && lease.releaseReason === "released" && !fencingMismatch) {
        return { ok: true, lease_id: lease.id, resource: lease.resource, expires_at: null, noop: true, release_reason: "released" };
      }
      // Hard gate: an ACCIDENT guard (a stale local lease record, a wrong id),
      // not authentication. Board-key sessions on one host are attributed, so
      // a session that names another actor id can still act as it (ADR), and
      // fencing tokens come from one global sequence. Downstream gates must
      // check the holder identity, not only a valid token.
      if (parsed.hardGate && (input.fencingToken === null || input.fencingToken === undefined)) {
        throw coordError(422, "rk9_coord_lease_fencing_required", "Releasing a hard-gate lease needs its fencing_token");
      }
      if (fencingMismatch || lease.releasedAt) {
        return { ok: false, code: "rk9_coord_lease_stale", lease_id: lease.id, resource: lease.resource, release_reason: lease.releaseReason };
      }
      if (isExpired(lease, ctx.now)) {
        await expireStale(ctx, lease, caller.actor.actorId);
        return { ok: false, code: "rk9_coord_lease_stale", lease_id: lease.id, resource: lease.resource, release_reason: "ttl_expired" };
      }
      await releaseAndPromote(ctx, lease, caller.actor.actorId, { subtype: "release", reason: "released" });
      return { ok: true, lease_id: lease.id, resource: lease.resource, expires_at: null, noop: false, release_reason: "released" };
    });
  }

  /**
   * POST /leases/break, always journaled.
   * - Live holder: only `operator` (signed-in instance-admin session) and
   *   `rk9claude` (Q5: emergency actions are logged, never blocked) may break
   *   it (release_reason operator_break); every other kind is 403
   *   rk9_coord_break_requires_operator, so one AI session cannot free
   *   another session's live hard-gate lease.
   * - Expired or dead holder: nothing to break. A non-operator caller runs the
   *   sweeper's path (expire / dead_release with the liveness reason) instead.
   * Both paths promote the next live waiter.
   */
  async function breakLease(
    companyId: string,
    caller: Rk9CoordLeaseCaller,
    input: { resource: string; reason: string; leaseId?: string | null },
  ) {
    assertRk9CoordLeaseKind(caller.actor); // RK9-648: before the resource and reason checks
    const parsed = requireResource(input.resource);
    const reason = toRk9CoordLine(input.reason, 300);
    if (!reason) throw coordError(422, "rk9_coord_lease_break_reason_required", "break needs a non-empty reason");
    assertRk9CoordLeaseTrust(caller.actor, parsed);
    const mayBreakLive = RK9_COORD_LEASE_BREAK_KINDS.includes(caller.actor.kind);
    return inTx(companyId, authorFor(caller), parsed.resource, async (ctx) => {
      const lease = await selectActiveLease(ctx.tx, companyId, parsed.resource);
      if (!lease) throw coordError(404, "rk9_coord_lease_not_found", "No active lease on this resource");
      // RK9 Custom (RK9-629): a break aimed at one lease (the Telegram
      // escalation button) never breaks the lease of a later holder.
      if (input.leaseId && lease.id !== input.leaseId.toLowerCase()) {
        throw coordError(
          409,
          "rk9_coord_lease_changed",
          "The resource now has a different lease; the escalated lease is already released",
        );
      }
      const holder = (await loadActors(ctx.tx, [lease.holderActorId])).get(lease.holderActorId);
      const holderRef = holder?.actorRef ?? "unknown";
      const expired = isExpired(lease, ctx.now);
      const verdict = holderVerdict(holder, lease, ctx);
      const stale = expired || !verdict.alive;
      if (!stale && !mayBreakLive) {
        throw coordError(
          403,
          "rk9_coord_break_requires_operator",
          "Breaking a live holder's lease needs the operator (signed-in session) or rk9claude",
        );
      }
      const operatorBreak = mayBreakLive;
      const releaseReason = operatorBreak
        ? "operator_break"
        : expired
          ? "ttl_expired"
          : (verdict as { reason: string }).reason;
      const subtype = operatorBreak ? "break" : expired ? "expire" : "dead_release";
      const promoted = await releaseAndPromote(ctx, lease, holderRef, {
        subtype,
        reason: releaseReason,
        extra: { broken_by: caller.actor.actorId, break_reason: reason },
      });
      return {
        broken: true,
        resource: parsed.resource,
        lease_id: lease.id,
        previous_holder: holderRef,
        release_reason: releaseReason,
        promoted: promoted ? { holder: promoted.holder.actorRef, lease_id: promoted.lease.id } : null,
      };
    });
  }

  /**
   * POST /leases/leave (RK9-648): the caller leaves the wait queue of
   * `resource`, for `rk9 lease wait` on Ctrl-C or timeout. Without it an
   * abandoned waiter stays until the grace period ends (sweeper step 2b).
   * Idempotent: a caller that is not queued gets `left:false` and nothing is
   * written. It never touches a lease, also not one promoted to the caller
   * that the caller has not claimed yet: that one expires after the claim
   * window. The leave is journaled as `dequeue` (dequeue_reason `left`).
   */
  async function leaveQueue(companyId: string, caller: Rk9CoordLeaseCaller, input: { resource: string }) {
    assertRk9CoordLeaseKind(caller.actor);
    const parsed = requireResource(input.resource);
    // The same trust as acquire: an agent key cannot dequeue a sibling run that waits with its run JWT.
    assertRk9CoordLeaseTrust(caller.actor, parsed);
    const [self] = await db
      .select({ id: rk9CoordActors.id })
      .from(rk9CoordActors)
      .where(and(eq(rk9CoordActors.companyId, companyId), eq(rk9CoordActors.actorRef, caller.actor.actorId)))
      .limit(1);
    if (!self) return { left: false, resource: parsed.resource };
    return inTx(companyId, authorFor(caller), parsed.resource, async (ctx) => {
      const removed = await ctx.tx
        .delete(rk9CoordLeaseWaiters)
        .where(
          and(
            eq(rk9CoordLeaseWaiters.companyId, companyId),
            eq(rk9CoordLeaseWaiters.resource, parsed.resource),
            eq(rk9CoordLeaseWaiters.actorId, self.id),
          ),
        )
        .returning({ id: rk9CoordLeaseWaiters.id });
      if (removed.length === 0) return { left: false, resource: parsed.resource };
      await transition(ctx, {
        subtype: "dequeue",
        resource: parsed.resource,
        leaseId: null,
        summary: `dequeue ${parsed.resource}: ${caller.actor.actorId} (left)`,
        payload: { actor: caller.actor.actorId, dequeue_reason: "left" },
      });
      return { left: true, resource: parsed.resource };
    });
  }

  /** POST /leases/validate: is `fencingToken` the current, unexpired token of `resource`? */
  async function validateToken(companyId: string, input: { resource: string; fencingToken: number }) {
    const parsed = requireResource(input.resource);
    const now = await dbNow(db);
    const [row] = await db
      .select({ lease: rk9CoordLeases, holder: rk9CoordActors.actorRef })
      .from(rk9CoordLeases)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeases.holderActorId))
      .where(
        and(
          eq(rk9CoordLeases.companyId, companyId),
          eq(rk9CoordLeases.resource, parsed.resource),
          isNull(rk9CoordLeases.releasedAt),
        ),
      )
      .limit(1);
    const valid = Boolean(row && row.lease.fencingToken === input.fencingToken && !isExpired(row.lease, now));
    return {
      valid,
      resource: parsed.resource,
      lease_id: valid ? row!.lease.id : null,
      holder: valid ? row!.holder : null,
      expires_at: valid ? iso(row!.lease.expiresAt) : null,
    };
  }

  /** Active leases with holder phase and queue (GET /leases). */
  async function list(
    companyId: string,
    filter: { prefix?: string; holder?: string; resource?: string } = {},
    viewerActorId: string | null = null,
  ): Promise<Rk9CoordLeaseView[]> {
    const now = await dbNow(db);
    const conds: SQL[] = [eq(rk9CoordLeases.companyId, companyId), isNull(rk9CoordLeases.releasedAt)];
    if (filter.resource) conds.push(eq(rk9CoordLeases.resource, filter.resource));
    if (filter.prefix) {
      conds.push(sql`left(${rk9CoordLeases.resource}, ${filter.prefix.length + 1}::int) = ${`${filter.prefix}:`}::text`);
    }
    if (filter.holder) conds.push(eq(rk9CoordActors.actorRef, filter.holder));
    const rows = await db
      .select({
        lease: rk9CoordLeases,
        holder: rk9CoordActors.actorRef,
        holderKind: rk9CoordActors.kind,
        holderPhase: rk9CoordActors.phase,
      })
      .from(rk9CoordLeases)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeases.holderActorId))
      .where(and(...conds))
      .orderBy(asc(rk9CoordLeases.resource))
      .limit(LIST_LIMIT);
    const queues = await queueSnapshot(db, companyId, rows.map((row) => row.lease.resource));
    return rows.map((row) => ({
      lease_id: row.lease.id,
      resource: row.lease.resource,
      holder: row.holder,
      holder_kind: row.holderKind,
      holder_phase: row.holderPhase,
      mode: row.lease.mode,
      reason: row.lease.reason,
      acquired_at: iso(row.lease.acquiredAt),
      renewed_at: row.lease.renewedAt ? iso(row.lease.renewedAt) : null,
      expires_at: iso(row.lease.expiresAt),
      expired: isExpired(row.lease, now),
      queue: queues.get(row.lease.resource) ?? [],
    }));
  }

  /** One resource (GET /leases/status?resource=): holder, phase, expiry, queue, the caller's position. */
  async function status(companyId: string, resource: string, viewerActorId: string | null) {
    const parsed = requireResource(resource);
    const [lease] = await list(companyId, { resource: parsed.resource }, viewerActorId);
    const queue = lease?.queue ?? (await queueSnapshot(db, companyId, [parsed.resource])).get(parsed.resource) ?? [];
    const mine = viewerActorId ? queue.find((entry) => entry.actor === viewerActorId) : undefined;
    return {
      resource: parsed.resource,
      held: Boolean(lease),
      holder: lease?.holder ?? null,
      holder_kind: lease?.holder_kind ?? null,
      holder_phase: lease?.holder_phase ?? null,
      lease_id: lease?.lease_id ?? null,
      mode: lease?.mode ?? null,
      expires_at: lease?.expires_at ?? null,
      expired: lease?.expired ?? false,
      position: mine?.position ?? null,
      queue,
    };
  }

  return { acquire, renew, release, breakLease, leaveQueue, validateToken, list, status };
}

// ---------------------------------------------------------------- sweeper

/**
 * One sweep over every company:
 * 1. active leases past their TTL -> `expire` (ttl_expired); leases whose
 *    holder is dead -> `dead_release` (presence_stale, heartbeat_run_terminal,
 *    headless_run_ended, remote_heartbeat_ttl); then the next live waiter is
 *    promoted (dead waiters dequeued) and gets an inbox message;
 * 2. queues without an active lease -> promote the head live waiter;
 * 3. a lease whose head waiter has waited longer than RK9_COORD_LEASE_STUCK_S
 *    -> one `stuck` event per lease (dedupe key), for the escalation child.
 *
 * Idempotent and safe across restarts and instances: each resource is handled
 * in its own transaction under pg_try_advisory_xact_lock (a busy resource is
 * skipped until the next tick), the lease row is re-read FOR UPDATE SKIP
 * LOCKED and the verdict recomputed, so a re-run over a swept state changes
 * nothing.
 */
export async function sweepRk9CoordLeases(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<Rk9CoordLeaseSweepResult> {
  const env = opts.env ?? process.env;
  const graceS = resolveRk9CoordLeaseDeadGraceS(env);
  const claimWindowS = resolveRk9CoordLeaseClaimWindowS(env);
  const stuckS = resolveRk9CoordLeaseStuckS(env);
  const result: Rk9CoordLeaseSweepResult = { expired: 0, deadReleased: 0, promoted: 0, dequeued: 0, stuck: 0, skipped: 0 };

  async function inResourceTx(companyId: string, resource: string, run: (ctx: Ctx) => Promise<void>) {
    const publications: ActivityPublication[] = [];
    const stats = { dequeued: 0 };
    await db.transaction(async (tx) => {
      if (!(await tryLockResource(tx, companyId, resource))) {
        result.skipped += 1;
        return;
      }
      const now = await dbNow(tx);
      await run({ tx, companyId, now, graceS, claimWindowS, author: SWEEPER_AUTHOR, publications, stats });
    });
    // Counted only after the commit: a rolled-back transaction changed nothing.
    result.dequeued += stats.dequeued;
    for (const publication of publications) publishActivity(publication);
  }

  // 1. expired or dead-holder leases, every active lease in keyset pages.
  const now = await dbNow(db);
  const active: LeaseRow[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    const rows: LeaseRow[] = await db
      .select()
      .from(rk9CoordLeases)
      .where(and(isNull(rk9CoordLeases.releasedAt), afterId ? sql`${rk9CoordLeases.id} > ${afterId}::uuid` : undefined))
      .orderBy(asc(rk9CoordLeases.id))
      .limit(SWEEP_BATCH);
    active.push(...rows);
    if (rows.length < SWEEP_BATCH) break;
    afterId = rows[rows.length - 1]!.id;
  }
  const holders = await loadActors(db, active.map((lease) => lease.holderActorId));
  for (const candidate of active) {
    const expired = isExpired(candidate, now);
    const verdict = holderVerdict(holders.get(candidate.holderActorId), candidate, { now, graceS });
    if (!expired && verdict.alive) continue;
    await inResourceTx(candidate.companyId, candidate.resource, async (ctx) => {
      const lease = await selectActiveLease(ctx.tx, ctx.companyId, candidate.resource, true);
      if (!lease || lease.id !== candidate.id) return;
      const holder = (await loadActors(ctx.tx, [lease.holderActorId])).get(lease.holderActorId);
      const isPastTtl = isExpired(lease, ctx.now);
      const current = holderVerdict(holder, lease, ctx);
      if (!isPastTtl && current.alive) return;
      const reason = isPastTtl ? "ttl_expired" : (current as { reason: string }).reason;
      const promoted = await releaseAndPromote(ctx, lease, holder?.actorRef ?? "unknown", {
        subtype: isPastTtl ? "expire" : "dead_release",
        reason,
      });
      if (isPastTtl) result.expired += 1;
      else result.deadReleased += 1;
      if (promoted) result.promoted += 1;
    });
  }

  // 2. queues with no active lease (e.g. every waiter was dead at the last release).
  const orphanQueues = await db
    .selectDistinct({ companyId: rk9CoordLeaseWaiters.companyId, resource: rk9CoordLeaseWaiters.resource })
    .from(rk9CoordLeaseWaiters)
    .where(
      sql`not exists (select 1 from ${rk9CoordLeases} l where l.company_id = ${rk9CoordLeaseWaiters.companyId} and l.resource = ${rk9CoordLeaseWaiters.resource} and l.released_at is null)`,
    )
    .limit(SWEEP_BATCH);
  for (const queue of orphanQueues) {
    await inResourceTx(queue.companyId, queue.resource, async (ctx) => {
      if (await selectActiveLease(ctx.tx, ctx.companyId, queue.resource)) return;
      if (await promoteNext(ctx, queue.resource)) result.promoted += 1;
    });
  }

  // 2b. waiters that stopped polling: dequeue them (one `dequeue` event each),
  // so status, ETA and the stuck signal do not count abandoned rows.
  const staleQueues = await db
    .selectDistinct({ companyId: rk9CoordLeaseWaiters.companyId, resource: rk9CoordLeaseWaiters.resource })
    .from(rk9CoordLeaseWaiters)
    .where(sql`${rk9CoordLeaseWaiters.expiresAt} is null or ${rk9CoordLeaseWaiters.expiresAt} <= ${now.toISOString()}::timestamptz`)
    .limit(SWEEP_BATCH);
  for (const queue of staleQueues) {
    await inResourceTx(queue.companyId, queue.resource, async (ctx) => {
      await dequeueDeadWaiters(ctx, queue.resource);
    });
  }

  // 3. stuck signal: one event per lease whose head waiter waits too long.
  const stuckCutoff = new Date(now.getTime() - stuckS * 1000);
  const stuck = await db
    .select({
      leaseId: rk9CoordLeases.id,
      companyId: rk9CoordLeases.companyId,
      resource: rk9CoordLeases.resource,
      holder: rk9CoordActors.actorRef,
      waiters: sql<number>`count(${rk9CoordLeaseWaiters.id})::int`,
      oldest: sql<string>`to_char(min(${rk9CoordLeaseWaiters.enqueuedAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(rk9CoordLeases)
    .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeases.holderActorId))
    .innerJoin(
      rk9CoordLeaseWaiters,
      and(
        eq(rk9CoordLeaseWaiters.companyId, rk9CoordLeases.companyId),
        eq(rk9CoordLeaseWaiters.resource, rk9CoordLeases.resource),
      ),
    )
    // Only waiters that still poll count: an abandoned queue row is no escalation.
    .where(and(isNull(rk9CoordLeases.releasedAt), sql`${rk9CoordLeaseWaiters.expiresAt} > ${now.toISOString()}::timestamptz`))
    .groupBy(rk9CoordLeases.id, rk9CoordLeases.companyId, rk9CoordLeases.resource, rk9CoordActors.actorRef)
    .having(sql`min(${rk9CoordLeaseWaiters.enqueuedAt}) <= ${stuckCutoff.toISOString()}::timestamptz`)
    .limit(SWEEP_BATCH);
  for (const row of stuck) {
    await inResourceTx(row.companyId, row.resource, async (ctx) => {
      // Re-check under the lock: the lease may have been released since the scan.
      const lease = await selectActiveLease(ctx.tx, ctx.companyId, row.resource, true);
      if (!lease || lease.id !== row.leaseId) return;
      const eventId = await transition(ctx, {
        subtype: "stuck",
        resource: row.resource,
        leaseId: row.leaseId,
        summary: `stuck ${row.resource}: held by ${row.holder}, ${row.waiters} waiting since ${row.oldest}`,
        payload: { holder: row.holder, waiters: row.waiters, waiting_since: row.oldest },
        dedupeKey: `lease-stuck:${row.leaseId}`,
      });
      if (eventId !== null) result.stuck += 1;
    });
  }

  if (result.expired + result.deadReleased + result.promoted + result.dequeued + result.stuck > 0) {
    logger.info(result, "rk9 coord lease sweep");
  }
  return result;
}

/**
 * Run the sweep on startup and then every RK9_COORD_LEASE_SWEEP_INTERVAL_MS
 * (default 30 s). A self-rescheduling timeout: the next sweep starts only
 * after the previous one finished. Returns a stop function.
 */
export function startRk9CoordLeaseSweeper(db: Db, intervalMs: number = resolveRk9CoordLeaseSweepIntervalMs()): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    void sweepRk9CoordLeases(db)
      .catch((err) => {
        logger.warn({ err }, "rk9 coord lease sweep failed");
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(run, intervalMs);
        timer.unref?.();
      });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
// --- /RK9 Custom ---
