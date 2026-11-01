// --- RK9 Custom (RK9-626): coord journal (epic RK9-620, key journal-inbox-api) ---
//
// The append-only typed journal of the coordination bus:
// - append(): validated, redacted, one-lined events; client_event_id dedupe;
//   rows from remote hosts and Grok are always stored as `unverified`.
// - delta(): the events after the actor's cursor that concern it (its repo,
//   issue or held leases, plus every deploy and ask-operator event). The
//   cursor advances in the same transaction; a peek does not move it.
// - formatRk9CoordDeltaLine(): the <= 400-char hook line.
// - board(): the full view, for explicit requests only (never from hooks).
//
// The journal has no UPDATE or DELETE path here; the DB trigger rejects both.
// Contract: docs/implementation-notes/coord-bus.md.
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rk9CoordActors,
  rk9CoordCursors,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeaseWaiters,
  rk9CoordLeases,
} from "@paperclipai/db";
import {
  parseRk9CoordActorId,
  type AppendRk9CoordEvent,
  type Rk9CoordTrust,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { rk9CoordTextHasSecret, toRk9CoordLine } from "./rk9-coord-text.js";

/** DB CHECK: summary is 1..300 characters. */
export const RK9_COORD_SUMMARY_MAX = 300;
/** Cap for each free-text payload field. */
export const RK9_COORD_PAYLOAD_TEXT_MAX = 500;
/** Hook line budget: ~100 tokens. */
export const RK9_COORD_LINE_MAX = 400;
export const RK9_COORD_LINE_TAIL = "rk9 board";
/** Event types every actor sees, whatever its repo or issue. */
export const RK9_COORD_GLOBAL_EVENT_TYPES = ["deploy", "ask-operator"] as const;
/** A new cursor starts this far back, so a fresh session is not flooded. */
export const RK9_COORD_NEW_CURSOR_LOOKBACK_MS = 24 * 3600 * 1000;
const DEFAULT_DELTA_LIMIT = 20;
const MAX_DELTA_LIMIT = 100;
const DEFAULT_PRESENCE_TTL_S = 300;

/** Presence TTL shared with the presence API (RK9-625): RK9_COORD_PRESENCE_TTL_S, default 300 s. */
export function rk9CoordPresenceTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.RK9_COORD_PRESENCE_TTL_S ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRESENCE_TTL_S;
}

/**
 * Trust stored on a journal row. The child spec's "verified=false" maps to
 * `unverified`: every remote host (coord host token, also its `cc` claims) and
 * Grok rows are unverified whatever the client sends. rk9claude's service
 * token is bound to that one service, so it keeps its resolved trust.
 */
export function rk9CoordJournalTrust(actor: Rk9CoordResolvedActor): Rk9CoordTrust {
  if (actor.kind === "remote" || actor.kind === "grok") return "unverified";
  if (actor.principal === "coord_token" && actor.kind !== "rk9claude") return "unverified";
  return actor.trust;
}

export interface Rk9CoordActorRow {
  id: string;
  actorRef: string;
  kind: string;
  name: string | null;
  issue: string | null;
  repo: string | null;
  lastSeenAt: Date;
  endedAt: Date | null;
}

const actorRowColumns = {
  id: rk9CoordActors.id,
  actorRef: rk9CoordActors.actorRef,
  kind: rk9CoordActors.kind,
  name: rk9CoordActors.name,
  issue: rk9CoordActors.issue,
  repo: rk9CoordActors.repo,
  lastSeenAt: rk9CoordActors.lastSeenAt,
  endedAt: rk9CoordActors.endedAt,
};

export async function findRk9CoordActorRow(
  db: Db,
  companyId: string,
  actorRef: string,
): Promise<Rk9CoordActorRow | null> {
  const [row] = await db
    .select(actorRowColumns)
    .from(rk9CoordActors)
    .where(and(eq(rk9CoordActors.companyId, companyId), eq(rk9CoordActors.actorRef, actorRef)))
    .limit(1);
  return row ?? null;
}

/**
 * The caller's actor row. The presence API (RK9-625) owns the row; when it
 * does not exist yet, insert a minimal stub with ON CONFLICT DO NOTHING (never
 * an UPDATE, and metadata stays `{}` so presence can detect its own first
 * registration).
 */
export async function ensureRk9CoordActorRow(
  db: Db,
  companyId: string,
  actor: Rk9CoordResolvedActor,
  agentId: string | null = null,
): Promise<Rk9CoordActorRow> {
  const existing = await findRk9CoordActorRow(db, companyId, actor.actorId);
  if (existing) return existing;
  const parsed = parseRk9CoordActorId(actor.actorId);
  const runId = actor.kind === "agent_run" ? parsed?.ref ?? null : null;
  await db
    .insert(rk9CoordActors)
    .values({
      companyId,
      kind: actor.kind,
      actorRef: actor.actorId,
      host: actor.host,
      externalId: parsed?.ref ?? null,
      trust: actor.trust,
      agentId: actor.kind === "agent_run" ? agentId : null,
      runId,
      issue: actor.kind === "worktree" ? parsed?.ref ?? null : null,
    })
    .onConflictDoNothing();
  const row = await findRk9CoordActorRow(db, companyId, actor.actorId);
  if (!row) throw new Error("rk9 coord actor row missing after insert");
  return row;
}

/** Issue the actor works on: its presence row, or the worktree id itself. */
export function rk9CoordActorIssue(row: Pick<Rk9CoordActorRow, "issue" | "actorRef">): string | null {
  if (row.issue) return row.issue;
  const parsed = parseRk9CoordActorId(row.actorRef);
  return parsed?.kind === "worktree" ? parsed.ref : null;
}

export function isRk9CoordActorLive(
  row: Pick<Rk9CoordActorRow, "lastSeenAt" | "endedAt"> | null,
  now: Date = new Date(),
  ttlSeconds: number = rk9CoordPresenceTtlSeconds(),
): boolean {
  if (!row || row.endedAt) return false;
  return row.lastSeenAt.getTime() > now.getTime() - ttlSeconds * 1000;
}

type EventRow = typeof rk9CoordEvents.$inferSelect;

export interface Rk9CoordEventView {
  id: number;
  type: string;
  actor: string;
  actor_kind: string;
  trust: string;
  issue: string | null;
  repo: string | null;
  resource: string | null;
  summary: string;
  payload: Record<string, unknown>;
  ref_event_id: number | null;
  vault_path: string | null;
  client_event_id: string | null;
  occurred_at: string | null;
  created_at: string;
}

export function rk9CoordEventView(row: EventRow): Rk9CoordEventView {
  return {
    id: row.id,
    type: row.type,
    actor: row.actorRef,
    actor_kind: row.actorKind,
    trust: row.trust,
    issue: row.issue,
    repo: row.repo,
    resource: row.resource,
    summary: row.summary,
    payload: row.payload,
    ref_event_id: row.refEventId,
    vault_path: row.vaultPath,
    client_event_id: row.clientEventId,
    occurred_at: row.occurredAt ? row.occurredAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

function line(text: string | undefined, max = RK9_COORD_PAYLOAD_TEXT_MAX): string | null {
  return toRk9CoordLine(text, max);
}

function requiredLine(text: string, max = RK9_COORD_PAYLOAD_TEXT_MAX): string {
  return line(text, max) ?? "[empty]";
}

/**
 * Fields stored verbatim (grammar-restricted, not one-lined) must not carry
 * a secret: a match is 422 instead of a silent store.
 */
export function assertRk9CoordNoSecretFields(fields: Record<string, string | null | undefined>) {
  for (const [field, value] of Object.entries(fields)) {
    if (value && rk9CoordTextHasSecret(value)) {
      throw new HttpError(422, `${field} looks like it contains a secret`, { code: "rk9_coord_secret_in_field", field });
    }
  }
}

interface BuiltEvent {
  summary: string;
  payload: Record<string, unknown>;
  vaultPath: string | null;
  refEventId: number | null;
}

/** Per-type payload and one-line summary; every free-text field is redacted and capped. */
export function buildRk9CoordEvent(input: AppendRk9CoordEvent, actorId: string): BuiltEvent {
  switch (input.type) {
    case "decision": {
      const title = requiredLine(input.title);
      const payload: Record<string, unknown> = { title, rationale: requiredLine(input.rationale, 1000) };
      if (input.vault_note) payload.vault_note = input.vault_note;
      return { summary: title, payload, vaultPath: input.vault_note ?? null, refEventId: null };
    }
    case "deploy": {
      const sha = input.sha.toLowerCase();
      return {
        summary: `${input.app} ${sha.slice(0, 7)} ${input.result}`,
        payload: { app: input.app, sha, result: input.result },
        vaultPath: null,
        refEventId: null,
      };
    }
    case "handoff": {
      const summary = requiredLine(input.summary);
      const to = line(input.to, 200);
      const payload: Record<string, unknown> = { issue: input.issue, summary };
      if (to) payload.to = to;
      return { summary: to ? `-> ${to}: ${summary}` : summary, payload, vaultPath: null, refEventId: null };
    }
    case "blocker": {
      const what = requiredLine(input.what);
      return { summary: what, payload: { issue: input.issue, what }, vaultPath: null, refEventId: null };
    }
    case "done": {
      const pr = typeof input.pr === "string" ? line(input.pr, 300) : input.pr ?? null;
      const payload: Record<string, unknown> = { issue: input.issue };
      if (pr !== null) payload.pr = pr;
      return {
        summary: pr !== null ? `PR ${typeof pr === "number" ? `#${pr}` : pr}` : `${input.issue} done`,
        payload,
        vaultPath: null,
        refEventId: null,
      };
    }
    case "ask-operator": {
      const question = requiredLine(input.question);
      const payload: Record<string, unknown> = {
        question,
        urgency: input.urgency,
        // The asker is the resolved caller, never the client's claim.
        actor: actorId,
      };
      if (input.options) payload.options = input.options.map((option) => requiredLine(option, 200));
      if (input.issue) payload.issue = input.issue;
      if (input.reply_to !== undefined) payload.reply_to = input.reply_to;
      return {
        summary: `[${input.urgency}] ${question}`,
        payload,
        vaultPath: null,
        refEventId: input.reply_to ?? null,
      };
    }
  }
}

export interface Rk9CoordDelta {
  events: Rk9CoordEventView[];
  /** Matching events after the old cursor, including those not returned. */
  total: number;
  more: number;
  cursor: number;
  previous_cursor: number;
  peek: boolean;
}

export interface Rk9CoordDeltaOptions {
  peek?: boolean;
  limit?: number;
  /** Extra filters for a caller whose presence row has no repo/issue yet. */
  repo?: string | null;
  issue?: string | null;
  agentId?: string | null;
  now?: Date;
}

function shortActor(ref: string): string {
  const parsed = parseRk9CoordActorId(ref);
  if (!parsed) return ref.slice(0, 24);
  switch (parsed.kind) {
    case "cc":
      return `cc:${parsed.ref!.slice(0, 8)}`;
    case "agent_run":
      return `run:${parsed.ref!.slice(0, 8)}`;
    case "worktree":
      return parsed.ref!;
    case "headless":
      return `headless:${parsed.ref!.slice(0, 8)}`;
    default:
      return ref.slice(0, 24);
  }
}

function deltaItem(event: Pick<Rk9CoordEventView, "type" | "issue" | "summary" | "actor">): string {
  return `${event.type}${event.issue ? ` ${event.issue}` : ""}: ${event.summary} @${shortActor(event.actor)}`;
}

/**
 * The hook line: newest events first, `" · "`-separated, at most `max`
 * characters, and `+N more: rk9 board` when some matching events do not fit.
 */
export function formatRk9CoordDeltaLine(
  events: ReadonlyArray<Pick<Rk9CoordEventView, "type" | "issue" | "summary" | "actor">>,
  total: number,
  max: number = RK9_COORD_LINE_MAX,
): string {
  // Lengths are UTF-16 units (String.length), the stricter of the two
  // counts: a line within `max` units is within `max` code points too.
  const head = "rk9:";
  const sep = " · ";
  const tail = (rest: number, hasItems: boolean) =>
    rest > 0 ? `${hasItems ? sep : " "}+${rest} more: ${RK9_COORD_LINE_TAIL}` : "";
  let out = head;
  let shown = 0;
  for (const event of events) {
    const item = deltaItem(event);
    const prefix = shown === 0 ? " " : sep;
    const restAfter = total - (shown + 1);
    const room = max - out.length - prefix.length - tail(restAfter, true).length;
    if (item.length <= room) {
      out += prefix + item;
      shown += 1;
      continue;
    }
    // A single long first item is cut rather than dropped.
    if (shown === 0 && room >= 24) {
      let cut = "";
      for (const point of Array.from(item)) {
        if (cut.length + point.length > room - 1) break;
        cut += point;
      }
      out += `${prefix}${cut}…`;
      shown += 1;
    }
    break;
  }
  return out + tail(total - shown, shown > 0);
}

export function rk9CoordJournalService(db: Db) {
  async function append(
    companyId: string,
    actor: Rk9CoordResolvedActor,
    input: AppendRk9CoordEvent,
  ): Promise<{ event: Rk9CoordEventView; duplicate: boolean }> {
    assertRk9CoordNoSecretFields({
      repo: input.repo,
      client_event_id: input.client_event_id,
      vault_note: input.type === "decision" ? input.vault_note : undefined,
      app: input.type === "deploy" ? input.app : undefined,
    });
    const built = buildRk9CoordEvent(input, actor.actorId);
    const summary = toRk9CoordLine(built.summary, RK9_COORD_SUMMARY_MAX) ?? input.type;
    const inserted = await db
      .insert(rk9CoordEvents)
      .values({
        companyId,
        type: input.type,
        actorRef: actor.actorId,
        actorKind: actor.kind,
        trust: rk9CoordJournalTrust(actor),
        issue: input.issue ?? null,
        repo: input.repo ?? null,
        summary,
        payload: built.payload,
        clientEventId: input.client_event_id ?? null,
        refEventId: built.refEventId,
        vaultPath: built.vaultPath,
        occurredAt: input.occurred_at ? new Date(input.occurred_at) : null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { event: rk9CoordEventView(inserted[0]), duplicate: false };
    // Spool replay: the client event id is already stored.
    if (input.client_event_id) {
      const [existing] = await db
        .select()
        .from(rk9CoordEvents)
        .where(and(eq(rk9CoordEvents.companyId, companyId), eq(rk9CoordEvents.clientEventId, input.client_event_id)))
        .limit(1);
      // A client event id belongs to the actor that stored it first.
      if (existing && existing.actorRef !== actor.actorId) {
        throw new HttpError(409, "client_event_id was already used by another actor", {
          code: "rk9_coord_client_event_conflict",
        });
      }
      if (existing) return { event: rk9CoordEventView(existing), duplicate: true };
    }
    throw new Error("rk9 coord event insert conflicted without a client_event_id");
  }

  /**
   * Events after the actor's cursor that concern it. Returns null when there
   * is nothing new (the route answers 204). Without `peek`, the cursor moves
   * to the newest company event the snapshot saw, in the same transaction
   * that read the cursor row FOR UPDATE: two concurrent calls of one actor
   * serialize, and the second sees nothing new.
   */
  async function delta(
    companyId: string,
    actor: Rk9CoordResolvedActor,
    opts: Rk9CoordDeltaOptions = {},
  ): Promise<Rk9CoordDelta | null> {
    const peek = opts.peek === true;
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_DELTA_LIMIT, 1), MAX_DELTA_LIMIT);
    // A peek writes nothing: without an actor row it reads with a virtual one.
    const self: { id: string | null; issue: string | null; repo: string | null; actorRef: string } = peek
      ? (await findRk9CoordActorRow(db, companyId, actor.actorId)) ?? {
          id: null,
          issue: null,
          repo: null,
          actorRef: actor.actorId,
        }
      : await ensureRk9CoordActorRow(db, companyId, actor, opts.agentId ?? null);
    const now = opts.now ?? new Date();

    return db.transaction(async (tx) => {
      const lockCursor = async () => {
        if (!self.id) return [];
        const query = tx
          .select({ lastEventId: rk9CoordCursors.lastEventId })
          .from(rk9CoordCursors)
          .where(and(eq(rk9CoordCursors.companyId, companyId), eq(rk9CoordCursors.actorId, self.id)));
        return peek ? query : query.for("update");
      };
      let [cursorRow] = await lockCursor();
      if (!cursorRow) {
        // A new cursor starts at the newest event older than the lookback.
        const lookback = new Date(now.getTime() - RK9_COORD_NEW_CURSOR_LOOKBACK_MS);
        const [start] = await tx
          .select({ id: sql<number | null>`max(${rk9CoordEvents.id})` })
          .from(rk9CoordEvents)
          .where(and(eq(rk9CoordEvents.companyId, companyId), lte(rk9CoordEvents.createdAt, lookback)));
        const initial = Number(start?.id ?? 0);
        if (peek) {
          cursorRow = { lastEventId: initial };
        } else {
          await tx.insert(rk9CoordCursors).values({ companyId, actorId: self.id!, lastEventId: initial }).onConflictDoNothing();
          [cursorRow] = await lockCursor();
        }
      }
      const cursor = Number(cursorRow!.lastEventId);

      const held = self.id
        ? await tx
            .select({ resource: rk9CoordLeases.resource })
            .from(rk9CoordLeases)
            .where(
              and(
                eq(rk9CoordLeases.companyId, companyId),
                eq(rk9CoordLeases.holderActorId, self.id),
                isNull(rk9CoordLeases.releasedAt),
              ),
            )
        : [];

      // Fix the window first: count, rows and the new cursor all use
      // (cursor, newCursor]. READ COMMITTED gives each statement a fresh
      // snapshot, so an unbounded later read could see an event the cursor
      // has not passed (returned twice) or skip one (count 0, cursor past it).
      const [newest] = await tx
        .select({ id: sql<number | null>`max(${rk9CoordEvents.id})` })
        .from(rk9CoordEvents)
        .where(and(eq(rk9CoordEvents.companyId, companyId), gt(rk9CoordEvents.id, cursor)));
      const newCursor = Math.max(cursor, Number(newest?.id ?? 0));

      const repos = [...new Set([self.repo, opts.repo].filter((value): value is string => Boolean(value)))];
      const issues = [
        ...new Set([rk9CoordActorIssue(self), opts.issue].filter((value): value is string => Boolean(value))),
      ];
      const resources = [...new Set(held.map((lease) => lease.resource))];
      const concerns: SQL[] = [inArray(rk9CoordEvents.type, [...RK9_COORD_GLOBAL_EVENT_TYPES])];
      if (repos.length > 0) concerns.push(inArray(rk9CoordEvents.repo, repos));
      if (issues.length > 0) concerns.push(inArray(rk9CoordEvents.issue, issues));
      if (resources.length > 0) {
        concerns.push(and(isNotNull(rk9CoordEvents.resource), inArray(rk9CoordEvents.resource, resources))!);
      }
      const matching = and(
        eq(rk9CoordEvents.companyId, companyId),
        gt(rk9CoordEvents.id, cursor),
        lte(rk9CoordEvents.id, newCursor),
        // An actor is never told about its own events.
        ne(rk9CoordEvents.actorRef, actor.actorId),
        or(...concerns),
      );

      const [counts] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(rk9CoordEvents)
        .where(matching);
      const total = Number(counts?.total ?? 0);

      if (!peek && newCursor > cursor) {
        await tx
          .update(rk9CoordCursors)
          .set({ lastEventId: newCursor, updatedAt: now })
          .where(and(eq(rk9CoordCursors.companyId, companyId), eq(rk9CoordCursors.actorId, self.id!)));
      }
      if (total === 0) return null;

      const rows = await tx
        .select()
        .from(rk9CoordEvents)
        .where(matching)
        .orderBy(desc(rk9CoordEvents.id))
        .limit(limit);
      const events = rows.reverse().map(rk9CoordEventView);
      return {
        events,
        total,
        more: total - events.length,
        cursor: peek ? cursor : newCursor,
        previous_cursor: cursor,
        peek,
      };
    });
  }

  /** The full view: live presence, active leases with queues, recent events, pending inbox. */
  async function board(companyId: string, opts: { viewerTrust: Rk9CoordTrust; now?: Date; eventLimit?: number }) {
    const now = opts.now ?? new Date();
    const ttl = rk9CoordPresenceTtlSeconds();
    const liveSince = new Date(now.getTime() - ttl * 1000);
    const actors = await db
      .select({
        id: rk9CoordActors.id,
        kind: rk9CoordActors.kind,
        actor: rk9CoordActors.actorRef,
        host: rk9CoordActors.host,
        name: rk9CoordActors.name,
        issue: rk9CoordActors.issue,
        repo: rk9CoordActors.repo,
        branch: rk9CoordActors.branch,
        phase: rk9CoordActors.phase,
        lastSeenAt: rk9CoordActors.lastSeenAt,
      })
      .from(rk9CoordActors)
      .where(
        and(
          eq(rk9CoordActors.companyId, companyId),
          isNull(rk9CoordActors.endedAt),
          gt(rk9CoordActors.lastSeenAt, liveSince),
        ),
      )
      .orderBy(desc(rk9CoordActors.lastSeenAt))
      .limit(200);

    const leases = await db
      .select({
        id: rk9CoordLeases.id,
        resource: rk9CoordLeases.resource,
        holder: rk9CoordActors.actorRef,
        holderPhase: rk9CoordActors.phase,
        fencingToken: rk9CoordLeases.fencingToken,
        mode: rk9CoordLeases.mode,
        reason: rk9CoordLeases.reason,
        acquiredAt: rk9CoordLeases.acquiredAt,
        expiresAt: rk9CoordLeases.expiresAt,
      })
      .from(rk9CoordLeases)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeases.holderActorId))
      .where(and(eq(rk9CoordLeases.companyId, companyId), isNull(rk9CoordLeases.releasedAt)))
      .orderBy(rk9CoordLeases.resource)
      .limit(200);
    const waiters = await db
      .select({ resource: rk9CoordLeaseWaiters.resource, actor: rk9CoordActors.actorRef })
      .from(rk9CoordLeaseWaiters)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeaseWaiters.actorId))
      .where(eq(rk9CoordLeaseWaiters.companyId, companyId))
      .orderBy(rk9CoordLeaseWaiters.id)
      .limit(500);
    const queues = new Map<string, string[]>();
    for (const waiter of waiters) {
      const queue = queues.get(waiter.resource) ?? [];
      queue.push(waiter.actor);
      queues.set(waiter.resource, queue);
    }

    const events = await db
      .select()
      .from(rk9CoordEvents)
      .where(eq(rk9CoordEvents.companyId, companyId))
      .orderBy(desc(rk9CoordEvents.id))
      .limit(Math.min(Math.max(opts.eventLimit ?? 20, 1), 100));

    const inbox = await db
      .select({
        id: rk9CoordInbox.id,
        toActor: rk9CoordActors.actorRef,
        toIssue: rk9CoordInbox.toIssue,
        toName: rk9CoordInbox.toName,
        from: rk9CoordInbox.fromActorRef,
        kind: rk9CoordInbox.kind,
        body: rk9CoordInbox.body,
        createdAt: rk9CoordInbox.createdAt,
        expiresAt: rk9CoordInbox.expiresAt,
      })
      .from(rk9CoordInbox)
      .leftJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordInbox.toActorId))
      .where(
        and(
          eq(rk9CoordInbox.companyId, companyId),
          isNull(rk9CoordInbox.deliveredAt),
          or(isNull(rk9CoordInbox.expiresAt), gt(rk9CoordInbox.expiresAt, now)),
        ),
      )
      .orderBy(rk9CoordInbox.id)
      .limit(100);

    // Unverified viewers (remote hosts, Grok) see who messages whom, not what.
    const showBodies = opts.viewerTrust !== "unverified";
    return {
      generated_at: now.toISOString(),
      presence_ttl_s: ttl,
      actors: actors.map((row) => ({
        kind: row.kind,
        actor: row.actor,
        host: row.host,
        name: row.name,
        issue: row.issue,
        repo: row.repo,
        branch: row.branch,
        phase: row.phase,
        age_s: Math.max(0, Math.round((now.getTime() - row.lastSeenAt.getTime()) / 1000)),
      })),
      leases: leases.map((row) => ({
        resource: row.resource,
        holder: row.holder,
        holder_phase: row.holderPhase,
        fencing_token: row.fencingToken,
        mode: row.mode,
        reason: row.reason,
        acquired_at: row.acquiredAt.toISOString(),
        expires_at: row.expiresAt.toISOString(),
        queue: queues.get(row.resource) ?? [],
      })),
      events: events.map(rk9CoordEventView),
      inbox: inbox.map((row) => ({
        id: row.id,
        to: row.toActor ?? row.toIssue ?? row.toName,
        from: row.from,
        kind: row.kind,
        body: showBodies ? row.body : null,
        created_at: row.createdAt.toISOString(),
        expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
      })),
    };
  }

  return { append, delta, board };
}
// --- /RK9 Custom ---
