// --- RK9 Custom (RK9-629): coord stall detection and operator escalation (epic RK9-620, key stall-escalator) ---
//
// A server tick finds jams that do not resolve on their own and hands them to
// the operator. The server DETECTS ONLY (parent decision 2.11.2026): it never
// calls Telegram and holds no Telegram credentials. rk9claude (RK9-634) reads
// the `escalated` journal events, sends the message with its own bot, runs the
// break button through POST /leases/break (kind rk9claude, with lease_id) and
// acks the delivery through POST /escalations/:id/ack.
//
// Two kinds of jam:
//   lease_stuck              a live holder, live waiters for > stuckS, and no
//                            holder progress (renew, acquire or phase change)
//                            for stuckS;
//   ask_operator_unanswered  an ask-operator or blocker journal event with no
//   blocker_unanswered       follow-up event (reply_to, same issue or same
//                            resource) for stuckS.
//
// Stages per jam ("episode", base key `lease:<leaseId>` or `event:<id>`):
//   1. nudge: an inbox message to the holder (or the event's author) and a
//      ledger row `nudge:<base>#<n>` (reason holder_nudge);
//   2. after recheckS, if the jam is still there: one escalation row
//      `<base>#<n>`, reserved under a global advisory lock BEFORE the journal
//      event is written, so a crash or a second server cannot double-escalate.
// Self-resolving cases never reach a stage: a released, expired or soon
// expiring lease, a dead holder (the sweeper releases it), a holder that
// renews or changes phase, waiters that stop polling, and a follow-up event.
//
// Ledger rules (rk9_coord_escalations, migration 9015):
//   - daily cap RK9_COORD_ESCALATE_DAY_MAX (default 6, as pcp-headsup
//     TG_DAY_MAX) over every company: one operator chat, one cap. Rows of the
//     current mode with status reserved, sent, failed or shadow count; a
//     failed send counts, so it is never retried in a loop;
//   - over the cap the escalation becomes a `suppressed` row (error
//     daily_cap) and writes no journal event;
//   - dedupe: after an escalation row (any status) the same base key waits
//     RK9_COORD_ESCALATE_DEDUPE_S (default 6 h). After that window a jam
//     escalates again only when the last escalation never reached the
//     operator (failed or suppressed), or when the holder made progress after
//     it and stalled again (a new episode). A delivered escalation is never
//     repeated for an unchanged jam, so open events cannot fill the cap;
//   - a nudge is valid for one round only: progress after it, or an
//     escalation after it, needs a new nudge and a new recheck.
// Modes (RK9_COORD_ESCALATE_MODE): off | shadow (default) | enforce. Shadow
// writes `shadow` rows and `escalated` events with payload.mode=shadow;
// rk9claude only logs those. Nudges run in both modes.
// No model calls. The tick is fail-open: an error is logged per candidate and
// per tick, and the server is never affected.
// Contract: docs/implementation-notes/coord-stall-escalator.md.
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  rk9CoordActors,
  rk9CoordEscalations,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeaseWaiters,
  rk9CoordLeases,
} from "@paperclipai/db";
import { parseRk9CoordLeaseResource, type AckRk9CoordEscalation, type Rk9CoordEscalationStatus } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { rk9CoordActorIssue } from "./rk9-coord-journal.js";
import { resolveRk9CoordLeaseDeadGraceS, rk9CoordLeaseActorVerdict } from "./rk9-coord-leases.js";
import { toRk9CoordLine } from "./rk9-coord-text.js";

export type Rk9CoordEscalateMode = "off" | "shadow" | "enforce";
export type Rk9CoordStallReason = "lease_stuck" | "ask_operator_unanswered" | "blocker_unanswered";

/** Author of nudges and `escalated` events (ADR actor_id grammar, kind orch). */
export const RK9_COORD_ESCALATOR_ACTOR = "orch:rk9-stall-escalator";
export const RK9_COORD_NUDGE_REASON = "holder_nudge";
export const RK9_COORD_STUCK_S_DEFAULT = 1_800;
export const RK9_COORD_ESCALATE_RECHECK_S_DEFAULT = 600;
export const RK9_COORD_ESCALATE_DEDUPE_S_DEFAULT = 6 * 3_600;
export const RK9_COORD_ESCALATE_DAY_MAX_DEFAULT = 6;
export const RK9_COORD_ESCALATE_LOOKBACK_S_DEFAULT = 86_400;
export const RK9_COORD_ESCALATE_INTERVAL_MS_DEFAULT = 60_000;
/**
 * Event authors whose blockers already reach the operator another way.
 * Unverified authors (remote hosts, Grok) are skipped by trust: their text
 * must not reach the operator's chat or use the cap.
 */
const SKIP_EVENT_AUTHOR_KINDS = ["operator", "rk9claude"];
const CANDIDATE_LIMIT = 500;
const WAITER_REFS_MAX = 5;
const MESSAGE_MAX = 1_000;
const INBOX_BODY_MAX = 500;
const CAP_LOCK_KEY = "rk9_coord_escalations:cap";
/** Ledger statuses that use the daily cap (suppressed rows do not). */
const CAP_STATUSES: Rk9CoordEscalationStatus[] = ["reserved", "sent", "failed", "shadow"];

// ---------------------------------------------------------------- config

export interface Rk9CoordEscalatorConfig {
  mode: Rk9CoordEscalateMode;
  stuckS: number;
  recheckS: number;
  dedupeS: number;
  dayMax: number;
  lookbackS: number;
  graceS: number;
  intervalMs: number;
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Unknown values fall back to shadow: a typo never turns escalation on. */
export function resolveRk9CoordEscalateMode(env: NodeJS.ProcessEnv = process.env): Rk9CoordEscalateMode {
  const raw = (env.RK9_COORD_ESCALATE_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "enforce") return raw;
  return "shadow";
}

export function resolveRk9CoordEscalatorConfig(env: NodeJS.ProcessEnv = process.env): Rk9CoordEscalatorConfig {
  // RK9_COORD_STUCK_S (spec name); the lease engine's RK9_COORD_LEASE_STUCK_S is the fallback.
  const stuckS = intEnv(env.RK9_COORD_STUCK_S ?? env.RK9_COORD_LEASE_STUCK_S, RK9_COORD_STUCK_S_DEFAULT, 60, 7 * 86_400);
  const dedupeS = intEnv(env.RK9_COORD_ESCALATE_DEDUPE_S, RK9_COORD_ESCALATE_DEDUPE_S_DEFAULT, 600, 7 * 86_400);
  return {
    mode: resolveRk9CoordEscalateMode(env),
    stuckS,
    // The recheck must end well inside the dedupe window, or a nudge would
    // expire before its recheck and nothing would ever escalate.
    recheckS: Math.min(
      intEnv(env.RK9_COORD_ESCALATE_RECHECK_S, RK9_COORD_ESCALATE_RECHECK_S_DEFAULT, 30, 86_400),
      Math.floor(dedupeS / 2),
    ),
    dedupeS,
    dayMax: intEnv(env.RK9_COORD_ESCALATE_DAY_MAX, RK9_COORD_ESCALATE_DAY_MAX_DEFAULT, 0, 100),
    // An event must stay in the lookback past its threshold and its recheck.
    lookbackS: Math.max(
      intEnv(env.RK9_COORD_ESCALATE_LOOKBACK_S, RK9_COORD_ESCALATE_LOOKBACK_S_DEFAULT, 3_600, 30 * 86_400),
      2 * stuckS,
      stuckS + 2 * Math.min(intEnv(env.RK9_COORD_ESCALATE_RECHECK_S, RK9_COORD_ESCALATE_RECHECK_S_DEFAULT, 30, 86_400), Math.floor(dedupeS / 2)),
    ),
    graceS: resolveRk9CoordLeaseDeadGraceS(env),
    intervalMs: intEnv(env.RK9_COORD_ESCALATE_INTERVAL_MS, RK9_COORD_ESCALATE_INTERVAL_MS_DEFAULT, 1_000, 3_600_000),
  };
}

// ---------------------------------------------------------------- pure detector

export interface Rk9CoordStuckLeaseFacts {
  acquiredAt: Date;
  renewedAt: Date | null;
  expiresAt: Date;
  resource: string;
  holder: { kind: string; endedAt: Date | null; lastSeenAt: Date; runStatus: string | null; phaseAt: Date | null };
  /** Waiters that still poll (expires_at in the future). */
  liveWaiters: number;
  oldestWaiterAt: Date | null;
}

export type Rk9CoordStuckLeaseVerdict =
  | { stuck: true; ageS: number; waitedS: number; progressAt: Date }
  | { stuck: false; why: "expired" | "expiring" | "holder_dead" | "no_waiters" | "waiting_short" | "progress" };

const secondsBetween = (later: Date, earlier: Date) => Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 1000));

/**
 * Is this lease a jam? Every self-resolving case answers stuck=false:
 * - the lease is past its TTL or expires before the recheck (TTL resolves it);
 * - the holder is dead by the lease engine's own rule (the sweeper releases it);
 * - no waiter still polls, or the oldest one waits for less than stuckS;
 * - the holder made progress within stuckS: acquired or renewed the lease, or
 *   changed its presence phase.
 */
export function evaluateRk9CoordStuckLease(
  facts: Rk9CoordStuckLeaseFacts,
  opts: { now: Date; stuckS: number; recheckS: number; graceS: number },
): Rk9CoordStuckLeaseVerdict {
  const { now } = opts;
  if (facts.expiresAt.getTime() <= now.getTime()) return { stuck: false, why: "expired" };
  if (facts.expiresAt.getTime() <= now.getTime() + opts.recheckS * 1000) return { stuck: false, why: "expiring" };
  const lastActivityAt = facts.renewedAt ?? facts.acquiredAt;
  const verdict = rk9CoordLeaseActorVerdict(facts.holder, {
    now,
    graceS: opts.graceS,
    hardGate: parseRk9CoordLeaseResource(facts.resource)?.hardGate ?? true,
    lastActivityAt,
  });
  if (!verdict.alive) return { stuck: false, why: "holder_dead" };
  if (facts.liveWaiters <= 0 || !facts.oldestWaiterAt) return { stuck: false, why: "no_waiters" };
  const waitedS = secondsBetween(now, facts.oldestWaiterAt);
  if (waitedS < opts.stuckS) return { stuck: false, why: "waiting_short" };
  const progressAt =
    facts.holder.phaseAt && facts.holder.phaseAt.getTime() > lastActivityAt.getTime() ? facts.holder.phaseAt : lastActivityAt;
  const ageS = secondsBetween(now, progressAt);
  if (ageS < opts.stuckS) return { stuck: false, why: "progress" };
  return { stuck: true, ageS, waitedS, progressAt };
}

export interface Rk9CoordJournalAskFacts {
  type: string;
  actorRef: string;
  actorKind: string;
  trust: string;
  createdAt: Date;
  hasFollowUp: boolean;
}

export type Rk9CoordUnansweredVerdict =
  | { unanswered: true; ageS: number; reason: Rk9CoordStallReason }
  | { unanswered: false; why: "type" | "author" | "follow_up" | "young" | "old" };

/** Is this ask-operator or blocker event still waiting for a follow-up past stuckS? */
export function evaluateRk9CoordUnansweredEvent(
  facts: Rk9CoordJournalAskFacts,
  opts: { now: Date; stuckS: number; lookbackS: number },
): Rk9CoordUnansweredVerdict {
  if (facts.type !== "ask-operator" && facts.type !== "blocker") return { unanswered: false, why: "type" };
  if (
    facts.actorRef === RK9_COORD_ESCALATOR_ACTOR ||
    SKIP_EVENT_AUTHOR_KINDS.includes(facts.actorKind) ||
    facts.trust === "unverified"
  ) {
    return { unanswered: false, why: "author" };
  }
  if (facts.hasFollowUp) return { unanswered: false, why: "follow_up" };
  const ageS = secondsBetween(opts.now, facts.createdAt);
  if (ageS < opts.stuckS) return { unanswered: false, why: "young" };
  if (ageS > opts.lookbackS) return { unanswered: false, why: "old" };
  return { unanswered: true, ageS, reason: facts.type === "ask-operator" ? "ask_operator_unanswered" : "blocker_unanswered" };
}

// ---------------------------------------------------------------- candidates and text

export interface Rk9CoordStallCandidate {
  companyId: string;
  /** `lease:<leaseId>` or `event:<id>`; ledger rows add `#<n>`. */
  baseKey: string;
  reason: Rk9CoordStallReason;
  resource: string | null;
  leaseId: string | null;
  issue: string | null;
  sourceEventId: number | null;
  sourceType: string | null;
  sourceSummary: string | null;
  holder: {
    actor: string;
    kind: string;
    host: string | null;
    issue: string | null;
    phase: string | null;
    /** rk9_coord_actors.id for the nudge; null when the author has no row. */
    rowId: string | null;
  };
  waiter: string | null;
  waiters: number;
  waiterRefs: string[];
  waitedS: number | null;
  ageS: number;
  /** Last holder progress (lease jams); null for event jams. */
  progressAt: Date | null;
}

const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;
const oneLine = (text: string | null | undefined, max: number) => toRk9CoordLine(text ?? null, max);

/** `rk9 lease break` one-liner for the message (only an operator session or rk9claude may run it). */
export function rk9CoordBreakCommand(resource: string, stuckS: number = RK9_COORD_STUCK_S_DEFAULT): string {
  return `rk9 lease break ${resource} --reason "stuck >${minutes(stuckS)}"`;
}

/**
 * Plain-text Telegram message (no parse_mode), at most 1000 characters. Every
 * client-written field goes through the coord redaction and is one-lined and
 * shortened; no fencing token, prompt text or secret is ever included.
 */
export function formatRk9CoordEscalationMessage(
  candidate: Rk9CoordStallCandidate,
  stuckS: number = RK9_COORD_STUCK_S_DEFAULT,
): string {
  const holder = candidate.holder;
  const who = [holder.kind, holder.host ? `host ${holder.host}` : null, holder.issue ? `issue ${holder.issue}` : null]
    .filter(Boolean)
    .join(", ");
  const holderLine = `${oneLine(holder.actor, 200) ?? "unknown"} (${oneLine(who, 200) ?? holder.kind})`;
  const lines: string[] = [];
  if (candidate.reason === "lease_stuck" && candidate.resource) {
    const resource = oneLine(candidate.resource, 200) ?? candidate.resource;
    lines.push(`⚠️ Coord jam: ${resource} (no progress for ${minutes(candidate.ageS)})`);
    lines.push(`Holder: ${holderLine}`);
    lines.push(`Phase: ${oneLine(holder.phase, 120) ?? "none"}`);
    const refs = candidate.waiterRefs.map((ref) => oneLine(ref, 120)).filter(Boolean).join(", ");
    lines.push(
      `Waiting: ${candidate.waiters} (oldest ${minutes(candidate.waitedS ?? 0)})${refs ? `: ${refs}` : ""}${candidate.waiters > candidate.waiterRefs.length ? ", …" : ""}`,
    );
    lines.push(`Break: tap the button, or from an operator session: ${rk9CoordBreakCommand(resource, stuckS)}`);
  } else {
    const label = candidate.reason === "ask_operator_unanswered" ? "ask-operator" : "blocker";
    const target = oneLine(candidate.issue ?? candidate.resource, 100) ?? `journal #${candidate.sourceEventId}`;
    lines.push(`⚠️ Coord ${label} unanswered for ${minutes(candidate.ageS)}: ${target}`);
    lines.push(`By: ${holderLine}`);
    lines.push(`What: ${oneLine(candidate.sourceSummary, 300) ?? "(no summary)"}`);
    lines.push(`Journal #${candidate.sourceEventId}: answer with a follow-up event (reply_to or the same issue).`);
  }
  const text = lines.join("\n");
  const points = Array.from(text);
  return points.length <= MESSAGE_MAX ? text : `${points.slice(0, MESSAGE_MAX - 1).join("")}…`;
}

function nudgeBody(candidate: Rk9CoordStallCandidate, recheckS: number): string {
  const body =
    candidate.reason === "lease_stuck"
      ? `Stall check: ${candidate.resource} has ${candidate.waiters} waiting for ${minutes(candidate.waitedS ?? 0)}, and your lease shows no progress (renew or phase) for ${minutes(candidate.ageS)}. Release it, renew it or update your phase; otherwise the operator gets a Telegram escalation in ${minutes(recheckS)}.`
      : `Stall check: your ${candidate.sourceType} #${candidate.sourceEventId}${candidate.issue ? ` on ${candidate.issue}` : ""} has had no follow-up for ${minutes(candidate.ageS)}. Post a follow-up event, or it is escalated to the operator by Telegram in ${minutes(recheckS)}.`;
  return oneLine(body, INBOX_BODY_MAX) ?? "Stall check";
}

// ---------------------------------------------------------------- DB helpers

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type LedgerRow = typeof rk9CoordEscalations.$inferSelect;

async function dbNow(db: Db | Tx): Promise<Date> {
  const [row] = await db.execute<{ now: string }>(
    sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
  );
  return new Date(row!.now);
}

const iso = (date: Date) => date.toISOString();
const isoSql = (date: Date) => sql`${iso(date)}::timestamptz`;
/** `to_char` keeps timestamps as ISO strings regardless of the driver's type parsing. */
const isoOf = (column: unknown) => sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const dateOf = (value: string | null | undefined) => (value ? new Date(value) : null);

/** Newest ledger row whose key is `<prefix>#<n>`. */
async function latestRow(db: Db | Tx, companyId: string, prefix: string): Promise<LedgerRow | null> {
  const [row] = await db
    .select()
    .from(rk9CoordEscalations)
    .where(and(eq(rk9CoordEscalations.companyId, companyId), sql`starts_with(${rk9CoordEscalations.episodeKey}, ${`${prefix}#`})`))
    .orderBy(desc(rk9CoordEscalations.reservedAt))
    .limit(1);
  return row ?? null;
}

async function nextKey(tx: Tx, companyId: string, prefix: string): Promise<string> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(rk9CoordEscalations)
    .where(and(eq(rk9CoordEscalations.companyId, companyId), sql`starts_with(${rk9CoordEscalations.episodeKey}, ${`${prefix}#`})`));
  return `${prefix}#${Number(row?.n ?? 0) + 1}`;
}

const ESCALATOR_ACTIVITY = {
  actorType: "system" as const,
  actorId: "rk9-stall-escalator",
  agentId: null,
  runId: null,
};

async function leaseCandidates(db: Db, now: Date, config: Rk9CoordEscalatorConfig): Promise<Rk9CoordStallCandidate[]> {
  const holder = alias(rk9CoordActors, "rk9_stall_holder");
  const waiterActor = alias(rk9CoordActors, "rk9_stall_waiter");
  const cutoff = new Date(now.getTime() - config.stuckS * 1000);
  const rows = await db
    .select({
      leaseId: rk9CoordLeases.id,
      companyId: rk9CoordLeases.companyId,
      resource: rk9CoordLeases.resource,
      acquiredAt: isoOf(rk9CoordLeases.acquiredAt),
      renewedAt: isoOf(rk9CoordLeases.renewedAt),
      expiresAt: isoOf(rk9CoordLeases.expiresAt),
      holderId: holder.id,
      holderRef: holder.actorRef,
      holderKind: holder.kind,
      holderHost: holder.host,
      holderIssue: holder.issue,
      holderPhase: holder.phase,
      holderPhaseAt: isoOf(holder.phaseAt),
      holderLastSeenAt: isoOf(holder.lastSeenAt),
      holderEndedAt: isoOf(holder.endedAt),
      runStatus: heartbeatRuns.status,
      waiters: sql<number>`count(${rk9CoordLeaseWaiters.id})::int`,
      oldest: isoOf(sql`min(${rk9CoordLeaseWaiters.enqueuedAt})`),
      waiterRefs: sql<string[]>`(array_agg(${waiterActor.actorRef} order by ${rk9CoordLeaseWaiters.id}))[1:${sql.raw(String(WAITER_REFS_MAX))}]`,
    })
    .from(rk9CoordLeases)
    .innerJoin(holder, eq(holder.id, rk9CoordLeases.holderActorId))
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, holder.runId))
    .innerJoin(
      rk9CoordLeaseWaiters,
      and(
        eq(rk9CoordLeaseWaiters.companyId, rk9CoordLeases.companyId),
        eq(rk9CoordLeaseWaiters.resource, rk9CoordLeases.resource),
        // Only waiters that still poll count: an abandoned queue row is no jam.
        sql`${rk9CoordLeaseWaiters.expiresAt} > ${isoSql(now)}`,
      ),
    )
    .innerJoin(waiterActor, eq(waiterActor.id, rk9CoordLeaseWaiters.actorId))
    .where(isNull(rk9CoordLeases.releasedAt))
    .groupBy(rk9CoordLeases.id, holder.id, heartbeatRuns.id)
    .having(sql`min(${rk9CoordLeaseWaiters.enqueuedAt}) <= ${isoSql(cutoff)}`)
    .orderBy(asc(rk9CoordLeases.id))
    .limit(CANDIDATE_LIMIT);

  const out: Rk9CoordStallCandidate[] = [];
  for (const row of rows) {
    const verdict = evaluateRk9CoordStuckLease(
      {
        acquiredAt: new Date(row.acquiredAt!),
        renewedAt: dateOf(row.renewedAt),
        expiresAt: new Date(row.expiresAt!),
        resource: row.resource,
        holder: {
          kind: row.holderKind,
          endedAt: dateOf(row.holderEndedAt),
          lastSeenAt: new Date(row.holderLastSeenAt!),
          runStatus: row.runStatus ?? null,
          phaseAt: dateOf(row.holderPhaseAt),
        },
        liveWaiters: Number(row.waiters),
        oldestWaiterAt: dateOf(row.oldest),
      },
      { now, stuckS: config.stuckS, recheckS: config.recheckS, graceS: config.graceS },
    );
    if (!verdict.stuck) continue;
    const issue = rk9CoordActorIssue({ issue: row.holderIssue, actorRef: row.holderRef });
    const waiterRefs = Array.isArray(row.waiterRefs) ? row.waiterRefs.filter((ref) => typeof ref === "string") : [];
    out.push({
      companyId: row.companyId,
      baseKey: `lease:${row.leaseId}`,
      reason: "lease_stuck",
      resource: row.resource,
      leaseId: row.leaseId,
      issue,
      sourceEventId: null,
      sourceType: null,
      sourceSummary: null,
      holder: {
        actor: row.holderRef,
        kind: row.holderKind,
        host: row.holderHost,
        issue,
        phase: row.holderPhase,
        rowId: row.holderId,
      },
      waiter: waiterRefs[0] ?? null,
      waiters: Number(row.waiters),
      waiterRefs,
      waitedS: verdict.waitedS,
      ageS: verdict.ageS,
      progressAt: verdict.progressAt,
    });
  }
  return out;
}

async function eventCandidates(db: Db, now: Date, config: Rk9CoordEscalatorConfig): Promise<Rk9CoordStallCandidate[]> {
  const cutoff = new Date(now.getTime() - config.stuckS * 1000);
  const lookback = new Date(now.getTime() - config.lookbackS * 1000);
  // A follow-up: a later event of the same company by a non-unverified
  // actor, other than the escalator, a heads-up or an automatic lease event,
  // that either answers the event (reply_to / ref_event_id) or concerns the
  // same issue or resource. For an ask-operator, the asker's own events on
  // the issue count only when they close it (`done`): a question is not
  // answered by its asker posting a phase or a decision. For a blocker, any
  // later event of the author on the issue shows that the work moved.
  const followUp = sql`exists (
    select 1 from ${rk9CoordEvents} f
    where f.company_id = ${rk9CoordEvents.companyId}
      and f.id > ${rk9CoordEvents.id}
      and f.actor_ref <> ${RK9_COORD_ESCALATOR_ACTOR}
      and f.type not in ('headsup', 'lease', 'escalated')
      and f.trust <> 'unverified'
      and (
        f.ref_event_id = ${rk9CoordEvents.id}
        or (
          (${rk9CoordEvents.type} = 'blocker' or f.actor_ref <> ${rk9CoordEvents.actorRef} or f.type = 'done')
          and (
            (${rk9CoordEvents.issue} is not null and f.issue = ${rk9CoordEvents.issue})
            or (${rk9CoordEvents.resource} is not null and f.resource = ${rk9CoordEvents.resource})
          )
        )
      )
  )`;
  const rows = await db
    .select({
      id: rk9CoordEvents.id,
      companyId: rk9CoordEvents.companyId,
      type: rk9CoordEvents.type,
      actorRef: rk9CoordEvents.actorRef,
      actorKind: rk9CoordEvents.actorKind,
      trust: rk9CoordEvents.trust,
      issue: rk9CoordEvents.issue,
      resource: rk9CoordEvents.resource,
      summary: rk9CoordEvents.summary,
      createdAt: isoOf(rk9CoordEvents.createdAt),
      hasFollowUp: sql<boolean>`${followUp}`,
    })
    .from(rk9CoordEvents)
    .where(
      and(
        inArray(rk9CoordEvents.type, ["ask-operator", "blocker"]),
        ne(rk9CoordEvents.actorRef, RK9_COORD_ESCALATOR_ACTOR),
        // Filter before the LIMIT: unverified or skipped authors cannot crowd out real events.
        ne(rk9CoordEvents.trust, "unverified"),
        sql`${rk9CoordEvents.actorKind} not in ('operator', 'rk9claude')`,
        sql`${rk9CoordEvents.createdAt} <= ${isoSql(cutoff)}`,
        sql`${rk9CoordEvents.createdAt} > ${isoSql(lookback)}`,
        sql`not ${followUp}`,
      ),
    )
    .orderBy(asc(rk9CoordEvents.id))
    .limit(CANDIDATE_LIMIT);

  const out: Rk9CoordStallCandidate[] = [];
  for (const row of rows) {
    const verdict = evaluateRk9CoordUnansweredEvent(
      {
        type: row.type,
        actorRef: row.actorRef,
        actorKind: row.actorKind,
        trust: row.trust,
        createdAt: new Date(row.createdAt!),
        hasFollowUp: row.hasFollowUp === true,
      },
      { now, stuckS: config.stuckS, lookbackS: config.lookbackS },
    );
    if (!verdict.unanswered) continue;
    out.push({
      companyId: row.companyId,
      baseKey: `event:${row.id}`,
      reason: verdict.reason,
      resource: row.resource,
      leaseId: null,
      issue: row.issue,
      sourceEventId: Number(row.id),
      sourceType: row.type,
      sourceSummary: row.summary,
      holder: { actor: row.actorRef, kind: row.actorKind, host: null, issue: row.issue, phase: null, rowId: null },
      waiter: null,
      waiters: 0,
      waiterRefs: [],
      waitedS: null,
      ageS: verdict.ageS,
      progressAt: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- rounds

const ledgerMode = (config: Pick<Rk9CoordEscalatorConfig, "mode">): "shadow" | "enforce" =>
  config.mode === "enforce" ? "enforce" : "shadow";

/**
 * May the jam escalate again after `last`? Never inside the dedupe window.
 * After it: only when `last` never reached the operator (failed, suppressed,
 * or written in another mode, e.g. shadow before the switch to enforce), or
 * when the holder made progress after it and stalled again.
 */
export function rk9CoordMayEscalateAgain(
  last: Pick<LedgerRow, "status" | "reservedAt" | "mode"> | null,
  candidate: Pick<Rk9CoordStallCandidate, "progressAt">,
  now: Date,
  dedupeS: number,
  mode: "shadow" | "enforce",
): boolean {
  if (!last) return true;
  if (now.getTime() - last.reservedAt.getTime() < dedupeS * 1000) return false;
  if (last.status === "failed" || last.status === "suppressed" || last.mode !== mode) return true;
  return candidate.progressAt !== null && candidate.progressAt.getTime() > last.reservedAt.getTime();
}

/**
 * Does `nudge` still cover this round? Not when it is older than the dedupe
 * window, older than the holder's last progress, or not newer than the last
 * escalation: each of those starts a new round with a new nudge and recheck.
 */
export function rk9CoordNudgeCoversRound(
  nudge: Pick<LedgerRow, "reservedAt"> | null,
  last: Pick<LedgerRow, "reservedAt"> | null,
  candidate: Pick<Rk9CoordStallCandidate, "progressAt">,
  now: Date,
  dedupeS: number,
): boolean {
  if (!nudge) return false;
  const at = nudge.reservedAt.getTime();
  if (now.getTime() - at >= dedupeS * 1000) return false;
  if (candidate.progressAt && at < candidate.progressAt.getTime()) return false;
  if (last && at <= last.reservedAt.getTime()) return false;
  return true;
}

// ---------------------------------------------------------------- stages

async function writeNudge(db: Db, candidate: Rk9CoordStallCandidate, now: Date, config: Rk9CoordEscalatorConfig) {
  const publications: ActivityPublication[] = [];
  const body = nudgeBody(candidate, config.recheckS);
  const written = await db.transaction(async (tx) => {
    // One nudge per round even with two servers: serialize on the jam and
    // re-check the ledger under the lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`rk9_coord_escalations:nudge:${candidate.companyId}:${candidate.baseKey}`}, 0))`,
    );
    const last = await latestRow(tx, candidate.companyId, candidate.baseKey);
    if (!rk9CoordMayEscalateAgain(last, candidate, now, config.dedupeS, ledgerMode(config))) return false;
    const current = await latestRow(tx, candidate.companyId, `nudge:${candidate.baseKey}`);
    if (rk9CoordNudgeCoversRound(current, last, candidate, now, config.dedupeS)) return false;
    const key = await nextKey(tx, candidate.companyId, `nudge:${candidate.baseKey}`);
    const [row] = await tx
      .insert(rk9CoordEscalations)
      .values({
        companyId: candidate.companyId,
        episodeKey: key,
        reason: RK9_COORD_NUDGE_REASON,
        resource: candidate.resource,
        issue: candidate.issue,
        mode: config.mode === "enforce" ? "enforce" : "shadow",
        status: "sent",
        message: body,
        reservedAt: now,
        sentAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: rk9CoordEscalations.id });
    // Another server wrote this nudge first.
    if (!row) return false;
    let toActorId = candidate.holder.rowId;
    if (!toActorId) {
      const [author] = await tx
        .select({ id: rk9CoordActors.id })
        .from(rk9CoordActors)
        .where(and(eq(rk9CoordActors.companyId, candidate.companyId), eq(rk9CoordActors.actorRef, candidate.holder.actor)))
        .limit(1);
      toActorId = author?.id ?? null;
    }
    // Exactly one inbox target; an author without a row or an issue gets no message.
    if (toActorId || candidate.issue) {
      await tx.insert(rk9CoordInbox).values({
        companyId: candidate.companyId,
        toActorId: toActorId ?? null,
        toIssue: toActorId ? null : candidate.issue,
        fromActorRef: RK9_COORD_ESCALATOR_ACTOR,
        kind: "stall_nudge",
        body,
        createdAt: now,
        expiresAt: new Date(now.getTime() + config.dedupeS * 1000),
      });
    }
    await logActivity(
      tx as unknown as Db,
      {
        companyId: candidate.companyId,
        ...ESCALATOR_ACTIVITY,
        action: "rk9.coord.stall_nudge",
        entityType: "rk9_coord_escalation",
        entityId: row.id,
        details: {
          episode_key: key,
          reason: candidate.reason,
          resource: candidate.resource,
          issue: candidate.issue,
          holder: candidate.holder.actor,
          delivered: Boolean(toActorId || candidate.issue),
        },
      },
      publications,
    );
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  return written;
}

export interface Rk9CoordEscalationOutcome {
  status: Rk9CoordEscalationStatus;
  escalationId: string;
  eventId: number | null;
}

async function escalate(
  db: Db,
  candidate: Rk9CoordStallCandidate,
  now: Date,
  config: Rk9CoordEscalatorConfig,
): Promise<Rk9CoordEscalationOutcome | null> {
  const publications: ActivityPublication[] = [];
  const mode = config.mode === "enforce" ? "enforce" : "shadow";
  const outcome = await db.transaction(async (tx) => {
    // One cap and one reservation order across every server and company.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CAP_LOCK_KEY}, 0))`);
    const last = await latestRow(tx, candidate.companyId, candidate.baseKey);
    if (!rk9CoordMayEscalateAgain(last, candidate, now, config.dedupeS, ledgerMode(config))) return null;
    const nudge = await latestRow(tx, candidate.companyId, `nudge:${candidate.baseKey}`);
    if (!rk9CoordNudgeCoversRound(nudge, last, candidate, now, config.dedupeS)) return null;
    if (now.getTime() - nudge!.reservedAt.getTime() < config.recheckS * 1000) return null;
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(rk9CoordEscalations)
      .where(
        and(
          ne(rk9CoordEscalations.reason, RK9_COORD_NUDGE_REASON),
          eq(rk9CoordEscalations.mode, mode),
          inArray(rk9CoordEscalations.status, CAP_STATUSES),
          sql`${rk9CoordEscalations.reservedAt} > ${isoSql(new Date(now.getTime() - 86_400_000))}`,
        ),
      );
    const usedCount = Number(used?.n ?? 0);
    const exceeded = usedCount >= config.dayMax;
    const status: Rk9CoordEscalationStatus = exceeded ? "suppressed" : mode === "shadow" ? "shadow" : "reserved";
    const key = await nextKey(tx, candidate.companyId, candidate.baseKey);
    const message = formatRk9CoordEscalationMessage(candidate, config.stuckS);
    const [row] = await tx
      .insert(rk9CoordEscalations)
      .values({
        companyId: candidate.companyId,
        episodeKey: key,
        reason: candidate.reason,
        resource: candidate.resource,
        issue: candidate.issue,
        mode,
        status,
        message,
        error: exceeded ? "daily_cap" : null,
        reservedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: rk9CoordEscalations.id });
    if (!row) return null;

    let eventId: number | null = null;
    if (!exceeded) {
      const parsed = candidate.resource ? parseRk9CoordLeaseResource(candidate.resource) : null;
      const payload: Record<string, unknown> = {
        escalation_id: row.id,
        episode_key: key,
        reason: candidate.reason,
        mode,
        resource: candidate.resource,
        lease_id: candidate.leaseId,
        holder: candidate.holder.actor,
        holder_kind: candidate.holder.kind,
        holder_host: candidate.holder.host,
        holder_issue: candidate.holder.issue,
        holder_phase: oneLine(candidate.holder.phase, 140),
        waiter: candidate.waiter,
        waiters: candidate.waiters,
        waited_s: candidate.waitedS,
        age_s: candidate.ageS,
        breakable: candidate.reason === "lease_stuck",
        cap: { limit: config.dayMax, used: usedCount + 1, exceeded: false },
        message,
        source_event_id: candidate.sourceEventId,
        break_command:
          candidate.reason === "lease_stuck" && candidate.resource ? rk9CoordBreakCommand(candidate.resource, config.stuckS) : null,
      };
      const subject = candidate.resource ?? candidate.issue ?? `#${candidate.sourceEventId}`;
      // An ask-operator is visible only to its asker and the operator (RK9-647
      // delta rule). Its escalation carries the question text, so it gets no
      // issue, repo or resource routing: only rk9claude and the operator see
      // type `escalated` without them.
      const routed = candidate.reason !== "ask_operator_unanswered";
      const [event] = await tx
        .insert(rk9CoordEvents)
        .values({
          companyId: candidate.companyId,
          type: "escalated",
          actorRef: RK9_COORD_ESCALATOR_ACTOR,
          actorKind: "orch",
          trust: "verified",
          issue: routed ? candidate.issue : null,
          repo: routed && parsed?.repo && parsed.repo.length <= 200 ? parsed.repo : null,
          resource: routed ? candidate.resource : null,
          summary:
            oneLine(`escalated to operator (${mode}): ${candidate.reason} ${subject}, ${minutes(candidate.ageS)}`, 300) ??
            "escalated to operator",
          payload,
          refEventId: candidate.sourceEventId,
          dedupeKey: `escalation:${key}`,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: rk9CoordEvents.id });
      eventId = event?.id ?? null;
      if (eventId !== null) {
        await tx.update(rk9CoordEscalations).set({ eventId }).where(eq(rk9CoordEscalations.id, row.id));
      }
    }
    await logActivity(
      tx as unknown as Db,
      {
        companyId: candidate.companyId,
        ...ESCALATOR_ACTIVITY,
        action: `rk9.coord.escalation_${status}`,
        entityType: "rk9_coord_escalation",
        entityId: row.id,
        details: {
          episode_key: key,
          reason: candidate.reason,
          mode,
          resource: candidate.resource,
          issue: candidate.issue,
          holder: candidate.holder.actor,
          event_id: eventId,
          cap_used: usedCount,
          cap_limit: config.dayMax,
        },
      },
      publications,
    );
    return { status, escalationId: row.id, eventId };
  });
  for (const publication of publications) publishActivity(publication);
  return outcome;
}

// ---------------------------------------------------------------- tick

export interface Rk9CoordStallTickResult {
  mode: Rk9CoordEscalateMode;
  candidates: number;
  nudged: number;
  waiting: number;
  deduped: number;
  escalated: number;
  shadow: number;
  suppressed: number;
  errors: number;
}

export interface Rk9CoordStallTickOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<Rk9CoordEscalatorConfig>;
  /** Injectable clock (tests); the default is the DB clock. */
  now?: () => Date;
}

/**
 * One detector pass over every company. Per candidate: within the dedupe
 * window after an escalation -> nothing; no recent nudge -> nudge; a nudge
 * younger than recheckS -> wait; otherwise escalate (reserve, then journal).
 */
export async function runRk9CoordStallTick(db: Db, opts: Rk9CoordStallTickOptions = {}): Promise<Rk9CoordStallTickResult> {
  const config = { ...resolveRk9CoordEscalatorConfig(opts.env ?? process.env), ...(opts.config ?? {}) };
  const result: Rk9CoordStallTickResult = {
    mode: config.mode,
    candidates: 0,
    nudged: 0,
    waiting: 0,
    deduped: 0,
    escalated: 0,
    shadow: 0,
    suppressed: 0,
    errors: 0,
  };
  if (config.mode === "off") return result;
  const now = opts.now ? opts.now() : await dbNow(db);
  const candidates = [...(await leaseCandidates(db, now, config)), ...(await eventCandidates(db, now, config))];
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    try {
      const last = await latestRow(db, candidate.companyId, candidate.baseKey);
      if (!rk9CoordMayEscalateAgain(last, candidate, now, config.dedupeS, ledgerMode(config))) {
        result.deduped += 1;
        continue;
      }
      const nudge = await latestRow(db, candidate.companyId, `nudge:${candidate.baseKey}`);
      if (!rk9CoordNudgeCoversRound(nudge, last, candidate, now, config.dedupeS)) {
        if (await writeNudge(db, candidate, now, config)) result.nudged += 1;
        continue;
      }
      if (now.getTime() - nudge!.reservedAt.getTime() < config.recheckS * 1000) {
        result.waiting += 1;
        continue;
      }
      const outcome = await escalate(db, candidate, now, config);
      if (!outcome) result.deduped += 1;
      else if (outcome.status === "suppressed") result.suppressed += 1;
      else if (outcome.status === "shadow") result.shadow += 1;
      else result.escalated += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn({ err, episode: candidate.baseKey }, "rk9 coord stall escalation failed for one candidate");
    }
  }
  if (result.nudged + result.escalated + result.shadow + result.suppressed + result.errors > 0) {
    logger.info(result, "rk9 coord stall tick");
  }
  return result;
}

/**
 * Run the detector every RK9_COORD_ESCALATE_INTERVAL_MS (default 60 s), first
 * after one interval so the lease sweeper has released dead holders. Mode off
 * starts nothing. Fail-open: a failed tick is logged and the next one runs.
 */
export function startRk9CoordStallEscalator(db: Db, env: NodeJS.ProcessEnv = process.env): () => void {
  const config = resolveRk9CoordEscalatorConfig(env);
  if (config.mode === "off") {
    logger.info("rk9 coord stall escalator is off (RK9_COORD_ESCALATE_MODE=off)");
    return () => {};
  }
  logger.info(
    { mode: config.mode, stuckS: config.stuckS, recheckS: config.recheckS, dayMax: config.dayMax },
    "rk9 coord stall escalator started",
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, config.intervalMs);
    timer.unref?.();
  };
  const run = () => {
    void runRk9CoordStallTick(db, { env })
      .catch((err) => {
        logger.warn({ err }, "rk9 coord stall tick failed");
      })
      .finally(schedule);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------- report and ack

export interface Rk9CoordEscalationView {
  id: string;
  episode_key: string;
  kind: "nudge" | "escalation";
  reason: string;
  resource: string | null;
  issue: string | null;
  mode: string;
  status: string;
  event_id: number | null;
  message: string | null;
  channel_message_id: string | null;
  error: string | null;
  reserved_at: string;
  sent_at: string | null;
}

function escalationView(row: LedgerRow, opts: { withText: boolean }): Rk9CoordEscalationView {
  return {
    id: row.id,
    episode_key: row.episodeKey,
    kind: row.reason === RK9_COORD_NUDGE_REASON ? "nudge" : "escalation",
    reason: row.reason,
    resource: row.resource,
    issue: row.issue,
    mode: row.mode,
    status: row.status,
    event_id: row.eventId,
    message: opts.withText ? row.message : null,
    channel_message_id: row.channelMessageId,
    error: opts.withText ? row.error : null,
    reserved_at: iso(row.reservedAt),
    sent_at: row.sentAt ? iso(row.sentAt) : null,
  };
}

export function rk9CoordEscalationService(db: Db) {
  /** The shadow report: newest ledger rows of the company. */
  async function list(
    companyId: string,
    opts: { status?: Rk9CoordEscalationStatus; limit?: number; nudges?: boolean; withText: boolean },
  ) {
    const rows = await db
      .select()
      .from(rk9CoordEscalations)
      .where(
        and(
          eq(rk9CoordEscalations.companyId, companyId),
          opts.status ? eq(rk9CoordEscalations.status, opts.status) : undefined,
          opts.nudges ? undefined : ne(rk9CoordEscalations.reason, RK9_COORD_NUDGE_REASON),
        ),
      )
      .orderBy(desc(rk9CoordEscalations.reservedAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    return rows.map((row) => escalationView(row, { withText: opts.withText }));
  }

  /**
   * Escalations that need a look on the board, from the last 7 days: failed
   * sends, suppressed ones (daily cap: rk9claude never saw them), and reserved
   * rows that rk9claude has not acked within recheckS.
   */
  async function attention(companyId: string, now: Date = new Date(), recheckS = RK9_COORD_ESCALATE_RECHECK_S_DEFAULT) {
    const rows = await db
      .select()
      .from(rk9CoordEscalations)
      .where(
        and(
          eq(rk9CoordEscalations.companyId, companyId),
          ne(rk9CoordEscalations.reason, RK9_COORD_NUDGE_REASON),
          sql`${rk9CoordEscalations.reservedAt} > ${isoSql(new Date(now.getTime() - 7 * 86_400_000))}`,
          sql`(${rk9CoordEscalations.status} in ('failed', 'suppressed') or (${rk9CoordEscalations.status} = 'reserved' and ${rk9CoordEscalations.reservedAt} <= ${isoSql(new Date(now.getTime() - recheckS * 1000))}))`,
        ),
      )
      .orderBy(desc(rk9CoordEscalations.reservedAt))
      .limit(20);
    return rows.map((row) => {
      const view = escalationView(row, { withText: false });
      return {
        id: view.id,
        reason: view.reason,
        resource: view.resource,
        issue: view.issue,
        status: row.status === "reserved" ? "unacked" : view.status,
        error: row.status === "suppressed" ? row.error : null,
        reserved_at: view.reserved_at,
      };
    });
  }

  /**
   * rk9claude's delivery result for a reserved escalation. One-shot: only a
   * `reserved` row changes, so a failed send stays failed (no retry loop).
   */
  async function ack(
    companyId: string,
    escalationId: string,
    input: AckRk9CoordEscalation,
    activity: { actorType: "agent" | "user" | "system"; actorId: string; agentId: string | null; runId: string | null },
    actorRef: string,
  ) {
    const publications: ActivityPublication[] = [];
    const error = input.status === "failed" ? oneLine(input.error ?? "send failed", 500) : null;
    const channelMessageId = input.status === "sent" ? oneLine(input.channel_message_id, 128) : null;
    const updated = await db.transaction(async (tx) => {
      const now = await dbNow(tx);
      const [row] = await tx
        .update(rk9CoordEscalations)
        .set({
          status: input.status,
          sentAt: input.status === "sent" ? now : null,
          channelMessageId,
          error,
        })
        .where(
          and(
            eq(rk9CoordEscalations.companyId, companyId),
            eq(rk9CoordEscalations.id, escalationId),
            eq(rk9CoordEscalations.status, "reserved"),
          ),
        )
        .returning();
      if (!row) return null;
      await logActivity(
        tx as unknown as Db,
        {
          companyId,
          ...activity,
          action: `rk9.coord.escalation_${input.status}`,
          entityType: "rk9_coord_escalation",
          entityId: row.id,
          details: { episode_key: row.episodeKey, reason: row.reason, resource: row.resource, acked_by: actorRef, error },
        },
        publications,
      );
      return row;
    });
    for (const publication of publications) publishActivity(publication);
    if (updated) return escalationView(updated, { withText: true });
    const [existing] = await db
      .select({ status: rk9CoordEscalations.status })
      .from(rk9CoordEscalations)
      .where(and(eq(rk9CoordEscalations.companyId, companyId), eq(rk9CoordEscalations.id, escalationId)))
      .limit(1);
    if (!existing) {
      throw new HttpError(404, "No such escalation", { code: "rk9_coord_escalation_not_found" });
    }
    throw new HttpError(409, `The escalation is ${existing.status}, not reserved`, {
      code: "rk9_coord_escalation_not_reserved",
      status: existing.status,
    });
  }

  return { list, attention, ack };
}
// --- /RK9 Custom ---
