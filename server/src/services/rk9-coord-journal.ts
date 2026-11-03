// --- RK9 Custom (RK9-626): coord journal (epic RK9-620, key journal-inbox-api) ---
//
// The append-only typed journal of the coordination bus:
// - append(): validated, redacted, one-lined events; client_event_id and
//   dedupe_key dedupe; rows from remote hosts and Grok, and every headsup,
//   are always stored as `unverified`.
// - delta(): the events after the actor's cursor that concern it (its repo,
//   issue or held leases, plus every deploy event). `cc` and `operator` get
//   every ask-operator; other kinds only their own questions (also of a
//   sibling run of the same agent) and the answers to them by an operator-side
//   actor (RK9_COORD_ASK_OPERATOR_ANSWER_KINDS, RK9-657). Never a headsup (RK9-647).
//   The cursor advances in the same transaction; a peek does not move it.
// - formatRk9CoordDeltaLine(): the <= 400-char hook line.
// - board(): the full view, for explicit requests only (never from hooks).
//   agent_run, grok and unverified viewers get an ask-operator without its
//   payload (rk9CoordBoardShowsAskOperatorPayload, RK9-657).
//
// The journal has no UPDATE or DELETE path here; the DB trigger rejects both.
// Contract: docs/implementation-notes/coord-bus.md.
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  rk9CoordActors,
  rk9CoordCursors,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeaseWaiters,
  rk9CoordLeases,
} from "@paperclipai/db";
import {
  parseRk9CoordActorId,
  RK9_COORD_DECISION_NOTE_PATTERN,
  type AppendRk9CoordEvent,
  type Rk9CoordTrust,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { rk9CoordIdentifierHasSecret, toRk9CoordLine } from "./rk9-coord-text.js";

/** DB CHECK: summary is 1..300 characters. */
export const RK9_COORD_SUMMARY_MAX = 300;
/** Cap for each free-text payload field. */
export const RK9_COORD_PAYLOAD_TEXT_MAX = 500;
/** Cap for a decision's rationale (`rk9 decision --why`, RK9-631: why <= 2000). */
export const RK9_COORD_RATIONALE_MAX = 2000;
/** dedupe_key of the one decision-vaulted event per decision (RK9-631). */
export const rk9CoordDecisionVaultedKey = (decisionId: number) => `decision-vaulted:${decisionId}`;
/** Hook line budget: ~100 tokens. */
export const RK9_COORD_LINE_MAX = 400;
export const RK9_COORD_LINE_TAIL = "rk9 board";
/** Event types every actor sees, whatever its repo or issue. */
export const RK9_COORD_GLOBAL_EVENT_TYPES = ["deploy", "ask-operator", "break-glass"] as const;
/**
 * RK9-647: an `ask-operator` is an operator-class question. These actor kinds
 * get every one in their delta. Any other kind gets only its own questions
 * (for an agent_run also those of another run of the same agent) and the
 * answers by an operator-side actor (RK9_COORD_ASK_OPERATOR_ANSWER_KINDS) whose
 * `ref_event_id` points at one of them: an agent session that saw another
 * actor's open question might decide it and bypass the approval gate.
 */
export const RK9_COORD_ASK_OPERATOR_DELTA_KINDS = ["cc", "operator"] as const;

/**
 * RK9-657 (operator decision 3.11.2026): the actor kinds whose event may
 * answer an `ask-operator`. A `cc` row answers only when it is not
 * `unverified`, i.e. a paperclip-01 session on the board key. A `cc:<host>`
 * claim through a host coord token is stored `unverified`
 * (rk9CoordJournalTrust) and never answers; neither do `agent_run`, `grok`,
 * `remote`, `rk9claude` and the other kinds. The delta and the stall
 * escalator apply the same rule (coord-bus.md, coord-stall-escalator.md).
 */
export const RK9_COORD_ASK_OPERATOR_ANSWER_KINDS = ["cc", "operator"] as const;

/**
 * RK9-657 (operator decision 3.11.2026): may this `GET /board` viewer read the
 * text of an `ask-operator`? `agent_run` and `grok` never do, nor does any
 * other viewer whose journal trust is `unverified` (a remote host token, also
 * its `cc` claims). They get rk9CoordHiddenPayloadView. A board-key read
 * without a claim is the operator's own key (null or undefined): full view.
 */
export function rk9CoordBoardShowsAskOperatorPayload(viewer: Rk9CoordResolvedActor | null | undefined): boolean {
  if (!viewer) return true;
  if (viewer.kind === "agent_run" || viewer.kind === "grok") return false;
  return rk9CoordJournalTrust(viewer) !== "unverified";
}
/**
 * "Mine" for ask-operator visibility (RK9-647, RK9-657): the actor itself, or
 * for an agent_run another run of the same agent (a primary-key lookup in
 * heartbeat_runs per candidate row; the CASE keeps the uuid cast off refs
 * that are not agent_run ids).
 */
function rk9CoordMineSql(ref: AnyColumn, companyId: string, actorId: string, agentId: string | null): SQL {
  const self = eq(ref, actorId);
  if (!agentId) return self;
  return or(
    self,
    sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${companyId} and ${heartbeatRuns.agentId} = ${agentId} and ${heartbeatRuns.id} = case when ${ref} ~ ${AGENT_RUN_REF_RX} then substring(${ref} from 11)::uuid end)`,
  )!;
}

/** RK9-647: types the delta never returns. A heads-up is delivered locally by the session's own hook. */
export const RK9_COORD_DELTA_HIDDEN_TYPES = ["headsup"] as const;
/** An `agent_run:<uuid>` actor ref; substring(ref from 11) is the run id. */
export const RK9_COORD_AGENT_RUN_REF_RX = "^agent_run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const AGENT_RUN_REF_RX = RK9_COORD_AGENT_RUN_REF_RX;
/** Summary prefix of a heads-up: the label says the observation is unverified. */
export const RK9_COORD_HEADSUP_SUMMARY_PREFIX = "[Heads up, varmistamaton]";

/**
 * RK9-647 (from RK9-633): event types a `grok` actor may post. Every other
 * type, server-only types included, is 403 rk9_coord_event_kind_not_allowed.
 * Grok rows are always `unverified` (rk9CoordJournalTrust).
 */
export const RK9_COORD_GROK_EVENT_TYPES = ["blocker", "handoff", "ask-operator"] as const;

/** RK9-647 (from RK9-632): the only actor kinds that may post a break-glass record. */
export const RK9_COORD_BREAK_GLASS_KINDS = ["cc", "operator", "rk9claude"] as const;

export function assertRk9CoordEventKindAllowed(actor: Pick<Rk9CoordResolvedActor, "kind">, type: unknown) {
  const deny = (allowedTypes?: readonly string[]) => {
    throw new HttpError(403, "This actor kind may not post this event type", {
      code: "rk9_coord_event_kind_not_allowed",
      ...(allowedTypes ? { allowed: [...allowedTypes] } : {}),
    });
  };
  if (actor.kind === "grok") {
    if (typeof type === "string" && (RK9_COORD_GROK_EVENT_TYPES as readonly string[]).includes(type)) return;
    deny(RK9_COORD_GROK_EVENT_TYPES);
  }
  if (type === "break-glass" && !(RK9_COORD_BREAK_GLASS_KINDS as readonly string[]).includes(actor.kind)) deny();
}

/**
 * Does this actor get every ask-operator in its delta? Kinds `cc` and
 * `operator`, and (RK9-657) not when the actor's journal trust is
 * `unverified`: a `cc:<host>` claim through a host coord token gets only its
 * own questions and their answers, as on the board.
 */
export function rk9CoordSeesAllAskOperator(actor: Rk9CoordResolvedActor): boolean {
  if (!(RK9_COORD_ASK_OPERATOR_DELTA_KINDS as readonly string[]).includes(actor.kind)) return false;
  return rk9CoordJournalTrust(actor) !== "unverified";
}
/** A new cursor starts this far back, so a fresh session is not flooded. */
export const RK9_COORD_NEW_CURSOR_LOOKBACK_MS = 24 * 3600 * 1000;
/** RK9-650: the delta also follows issues the caller handed off in this window. */
export const RK9_COORD_HANDOFF_FOLLOW_WINDOW_MS = 24 * 3600 * 1000;
/** RK9-650: at most this many handed-off issues are followed (newest handoff first). */
export const RK9_COORD_HANDOFF_FOLLOW_MAX = 50;
const DEFAULT_DELTA_LIMIT = 20;
const MAX_DELTA_LIMIT = 100;
const DEFAULT_PRESENCE_TTL_S = 300;

/** Presence TTL shared with the presence API (RK9-625): RK9_COORD_PRESENCE_TTL_S, default 300 s. */
export function rk9CoordPresenceTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.RK9_COORD_PRESENCE_TTL_S ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRESENCE_TTL_S;
}

/**
 * Stub rate limit (RK9-641, parent decision 3.11.2026): at most this many
 * new stub actor rows per company and host per rolling hour. A stub is the
 * row ensureRk9CoordActorRow inserts for an actor id that never registered
 * through PUT /actors/me. The count covers every actor row the host created
 * in the hour, registered or not, so registering a stub does not free budget.
 * RK9-676: the first registration through PUT /actors/me (an insert) takes
 * the same budget (assertRk9CoordNewActorBudget). Normal use stays far below it: a host creates one
 * stub per new session, worktree or headless run that reads the delta or
 * the inbox before registering (an /implement wave on paperclip-01 starts
 * about 20). A remote token that mints random `cc:<host>:<random>` ids hits
 * it and gets 429 `rk9_coord_stub_rate_limited`. Agent runs (server-verified
 * running runs) and actors without a host are not limited.
 * RK9_COORD_STUB_RATE_PER_HOUR overrides it; 0 turns the limit off.
 */
export const RK9_COORD_STUB_RATE_PER_HOUR_DEFAULT = 120;

export function rk9CoordStubRatePerHour(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.RK9_COORD_STUB_RATE_PER_HOUR ?? "", 10);
  if (!Number.isFinite(value) || value < 0) return RK9_COORD_STUB_RATE_PER_HOUR_DEFAULT;
  return Math.min(value, 100_000);
}

/**
 * Trust stored on a journal row. The child spec's "verified=false" maps to
 * `unverified`: every remote host (coord host token, also its `cc` claims) and
 * Grok rows are unverified whatever the client sends. rk9claude's service
 * token is bound to that one service, so it keeps its resolved trust.
 */
export function rk9CoordJournalTrust(actor: Rk9CoordResolvedActor, type?: string): Rk9CoordTrust {
  // RK9-647: a heads-up is an unverified observation whatever the credential.
  if (type === "headsup") return "unverified";
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

// A function, not a constant: a module-load read of the table breaks tests
// that mock @paperclipai/db without it (server-startup tests import presence).
const actorRowColumns = () => ({
  id: rk9CoordActors.id,
  actorRef: rk9CoordActors.actorRef,
  kind: rk9CoordActors.kind,
  name: rk9CoordActors.name,
  issue: rk9CoordActors.issue,
  repo: rk9CoordActors.repo,
  lastSeenAt: rk9CoordActors.lastSeenAt,
  endedAt: rk9CoordActors.endedAt,
});

export async function findRk9CoordActorRow(
  db: Db,
  companyId: string,
  actorRef: string,
): Promise<Rk9CoordActorRow | null> {
  const [row] = await db
    .select(actorRowColumns())
    .from(rk9CoordActors)
    .where(and(eq(rk9CoordActors.companyId, companyId), eq(rk9CoordActors.actorRef, actorRef)))
    .limit(1);
  return row ?? null;
}

/** activity_log author fields for a coord write (RK9-641). */
export interface Rk9CoordActivityActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId?: string | null;
}

/** Fallback author when the route gives none: the agent behind an agent_run, else the coord actor. */
function defaultActivityActor(actor: Rk9CoordResolvedActor, agentId: string | null): Rk9CoordActivityActor {
  if (actor.kind === "agent_run" && agentId) {
    const runId = parseRk9CoordActorId(actor.actorId)?.ref ?? null;
    return { actorType: "agent", actorId: agentId, agentId, runId };
  }
  return { actorType: "system", actorId: actor.actorId, agentId: null, runId: null };
}

/**
 * The per-host budget for new actor rows (RK9-641 stub limit; RK9-676 also
 * the first registration through PUT /actors/me). Call it inside the
 * transaction that inserts the row, before the insert. It takes the
 * transaction-scoped advisory lock of (company, host), so concurrent calls
 * cannot all pass the count. Returns "exists" when a row with this actor id
 * is already there (a concurrent insert won: reuse it), "ok" when the insert
 * may go ahead, and throws 429 `rk9_coord_stub_rate_limited` when the host
 * has created `RK9_COORD_STUB_RATE_PER_HOUR` rows in the last hour. Agent
 * runs and actors without a host are not limited.
 */
export async function assertRk9CoordNewActorBudget(
  tx: Db,
  companyId: string,
  actor: Pick<Rk9CoordResolvedActor, "actorId" | "host" | "kind">,
  now: Date = new Date(),
): Promise<"ok" | "exists"> {
  const limit = rk9CoordStubRatePerHour();
  if (limit <= 0 || !actor.host || actor.kind === "agent_run") return "ok";
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rk9_coord_stub:${companyId}:${actor.host}`}))`);
  const [existing] = await tx
    .select({ id: rk9CoordActors.id })
    .from(rk9CoordActors)
    .where(and(eq(rk9CoordActors.companyId, companyId), eq(rk9CoordActors.actorRef, actor.actorId)))
    .limit(1);
  if (existing) return "exists";
  const since = new Date(now.getTime() - 3600 * 1000);
  const [recent] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(rk9CoordActors)
    .where(
      and(
        eq(rk9CoordActors.companyId, companyId),
        eq(rk9CoordActors.host, actor.host),
        // Registered rows count too: registering a stub must not
        // reset the budget (verifier finding, RK9-641).
        gt(rk9CoordActors.createdAt, since),
      ),
    );
  if (Number(recent?.count ?? 0) >= limit) {
    throw new HttpError(429, "Too many new coord actors from this host; retry later", {
      code: "rk9_coord_stub_rate_limited",
      limitPerHour: limit,
    });
  }
  return "ok";
}

/**
 * The caller's actor row. The presence API (RK9-625) owns the row; when it
 * does not exist yet, insert a minimal stub with ON CONFLICT DO NOTHING (never
 * an UPDATE, and metadata stays `{}` so presence can detect its own first
 * registration). A stub insert writes one `rk9.coord.actor_stub_created`
 * activity row in the same transaction (RK9-641); a conflict writes none.
 */
export async function ensureRk9CoordActorRow(
  db: Db,
  companyId: string,
  actor: Rk9CoordResolvedActor,
  agentId: string | null = null,
  activityActor: Rk9CoordActivityActor | null = null,
): Promise<Rk9CoordActorRow> {
  const existing = await findRk9CoordActorRow(db, companyId, actor.actorId);
  if (existing) return existing;
  const parsed = parseRk9CoordActorId(actor.actorId);
  const runId = actor.kind === "agent_run" ? parsed?.ref ?? null : null;
  const publications: ActivityPublication[] = [];
  await db.transaction(async (tx) => {
    if ((await assertRk9CoordNewActorBudget(tx as unknown as Db, companyId, actor)) === "exists") return;
    const inserted = await tx
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
      .onConflictDoNothing()
      .returning({ id: rk9CoordActors.id });
    if (!inserted[0]) return;
    await logActivity(
      tx as unknown as Db,
      {
        companyId,
        ...(activityActor ?? defaultActivityActor(actor, agentId)),
        action: "rk9.coord.actor_stub_created",
        entityType: "rk9_coord_actor",
        entityId: inserted[0].id,
        details: { actor: actor.actorId, kind: actor.kind, host: actor.host, trust: actor.trust },
      },
      publications,
    );
  });
  for (const publication of publications) publishActivity(publication);
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
    if (value && rk9CoordIdentifierHasSecret(value)) {
      throw new HttpError(422, `${field} looks like it contains a secret`, { code: "rk9_coord_secret_in_field", field });
    }
  }
}

interface BuiltEvent {
  summary: string;
  payload: Record<string, unknown>;
  vaultPath: string | null;
  refEventId: number | null;
  /** Producer dedupe key, stored in `dedupe_key` (unique per company and type). */
  dedupeKey?: string | null;
  /** Lease resource the event concerns, stored in `resource`. */
  resource?: string | null;
}

/** Per-type payload and one-line summary; every free-text field is redacted and capped. */
export function buildRk9CoordEvent(input: AppendRk9CoordEvent, actorId: string): BuiltEvent {
  switch (input.type) {
    case "decision": {
      const title = requiredLine(input.title);
      const payload: Record<string, unknown> = { title, rationale: requiredLine(input.rationale, RK9_COORD_RATIONALE_MAX) };
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
    case "decision-vaulted": {
      const pushed = input.pushed !== false;
      return {
        summary: `#${input.ref_event_id} -> ${input.vault_path} @${input.commit.slice(0, 7)}${pushed ? "" : " (push pending)"}`,
        payload: { ref_event_id: input.ref_event_id, vault_path: input.vault_path, commit: input.commit, pushed },
        vaultPath: input.vault_path,
        refEventId: input.ref_event_id,
        dedupeKey: rk9CoordDecisionVaultedKey(input.ref_event_id),
      };
    }
    case "headsup": {
      const text = requiredLine(input.text);
      const payload: Record<string, unknown> = { text };
      const explanation = line(input.explanation, 1000);
      if (explanation) payload.explanation = explanation;
      payload.class = input.class;
      // A rule names why a heads-up is operator class; `other` has none.
      if (input.class === "operator" && input.class_rule) payload.class_rule = input.class_rule;
      payload.observation_key = input.observation_key;
      if (input.session_id) payload.session_id = input.session_id;
      // The observer is the resolved caller, never a client claim.
      payload.observed_actor = actorId;
      payload.verified = false;
      if (input.issue) payload.issue = input.issue;
      return {
        summary: `${RK9_COORD_HEADSUP_SUMMARY_PREFIX} ${text}`,
        payload,
        vaultPath: null,
        refEventId: null,
        dedupeKey: input.observation_key,
      };
    }
    case "break-glass": {
      const reason = requiredLine(input.reason, 1000);
      return {
        summary: `BREAK-GLASS ${input.gate} ${input.resource}: ${reason}`,
        payload: { resource: input.resource, gate: input.gate, reason },
        vaultPath: null,
        refEventId: null,
        resource: input.resource,
      };
    }
  }
}

/**
 * RK9-646: the host whose decisions an unverified caller may close besides
 * its own. Only a host token (`cc` or `remote` actor, host bound to the
 * token, not claimed) has one; Grok and other services have none.
 */
export function rk9CoordVaultOwnerHost(actor: Rk9CoordResolvedActor): string | null {
  if (actor.principal !== "coord_token" || (actor.kind !== "cc" && actor.kind !== "remote")) return null;
  return actor.host || null;
}

/**
 * Who may close a decision's vault write (RK9-631): the decision's own actor,
 * a caller whose journal rows are not `unverified`, or (RK9-646) a host token
 * of the host the decision was written on (`cc:<host>:*` or `remote:<host>`),
 * so a retry from a new session on the same host works. A remote host token
 * or Grok cannot mark another host's decision as vaulted.
 */
export function rk9CoordMayVaultDecision(actor: Rk9CoordResolvedActor, decisionActorRef: string): boolean {
  if (actor.actorId === decisionActorRef || rk9CoordJournalTrust(actor) !== "unverified") return true;
  const host = rk9CoordVaultOwnerHost(actor);
  if (!host) return false;
  const parsed = parseRk9CoordActorId(decisionActorRef);
  return parsed !== null && (parsed.kind === "cc" || parsed.kind === "remote") && parsed.host === host;
}

/** RK9-657: the summary a restricted board viewer gets instead of the question. */
export const RK9_COORD_HIDDEN_ASK_SUMMARY = "[ask-operator]";

/**
 * RK9-657 (operator decision 3.11.2026, refined by the parent): the board view
 * of an `ask-operator`, and of the `escalated` event of an unanswered one (its
 * payload repeats the question), for a viewer that may not read the question
 * (rk9CoordBoardShowsAskOperatorPayload). The viewer sees that the issue has
 * an open question, not its text: id, type, issue, actor and times. An
 * ask-operator summary becomes RK9_COORD_HIDDEN_ASK_SUMMARY; an escalation
 * summary names no question text and stays. The other fields keep their
 * keys, null or empty, so a client that reads them does not break.
 */
export interface Rk9CoordHiddenPayloadView {
  id: number;
  type: string;
  actor: string;
  actor_kind: string;
  trust: null;
  issue: string | null;
  repo: null;
  resource: null;
  summary: string;
  payload: Record<string, never>;
  ref_event_id: null;
  vault_path: null;
  client_event_id: null;
  occurred_at: string | null;
  created_at: string;
  payload_hidden: true;
}

/** RK9-657: does this row carry an ask-operator question in its payload? */
export function rk9CoordIsAskOperatorRow(row: Pick<EventRow, "type" | "payload">): boolean {
  if (row.type === "ask-operator") return true;
  const payload = row.payload as Record<string, unknown> | null;
  return row.type === "escalated" && payload?.reason === "ask_operator_unanswered";
}

export function rk9CoordHiddenPayloadView(row: EventRow): Rk9CoordHiddenPayloadView {
  return {
    id: row.id,
    type: row.type,
    actor: row.actorRef,
    actor_kind: row.actorKind,
    trust: null,
    issue: row.issue,
    repo: null,
    resource: null,
    summary: row.type === "ask-operator" ? RK9_COORD_HIDDEN_ASK_SUMMARY : row.summary,
    payload: {},
    ref_event_id: null,
    vault_path: null,
    client_event_id: null,
    occurred_at: row.occurredAt ? row.occurredAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    payload_hidden: true,
  };
}

/** Board view of an event: a heads-up shows its summary, not its explanation. */
export function rk9CoordBoardEventView(row: EventRow): Rk9CoordEventView {
  const view = rk9CoordEventView(row);
  if (view.type === "headsup" && "explanation" in view.payload) {
    const { explanation: _explanation, ...rest } = view.payload;
    view.payload = rest;
  }
  return view;
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
  /**
   * activity_log author for the stub insert. The cursor move itself writes
   * no activity row (RK9-641 decision): it is read bookkeeping that runs on
   * every hook prompt, and the cursor row holds its own updated_at.
   */
  activityActor?: Rk9CoordActivityActor | null;
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
  /**
   * Append one event. The `rk9.coord.event_appended` activity row is written
   * in the insert's transaction (RK9-641): a failed log rolls the insert
   * back, so a client retry cannot get `duplicate: true` for an unlogged
   * event. A duplicate writes no row.
   */
  async function append(
    companyId: string,
    actor: Rk9CoordResolvedActor,
    input: AppendRk9CoordEvent,
    opts: { activityActor?: Rk9CoordActivityActor | null; agentId?: string | null } = {},
  ): Promise<{ event: Rk9CoordEventView; duplicate: boolean }> {
    assertRk9CoordEventKindAllowed(actor, input.type);
    assertRk9CoordNoSecretFields({
      repo: input.repo,
      client_event_id: input.client_event_id,
      vault_note: input.type === "decision" ? input.vault_note : undefined,
      app: input.type === "deploy" ? input.app : undefined,
      session_id: input.type === "headsup" ? input.session_id : undefined,
      class_rule: input.type === "headsup" ? input.class_rule : undefined,
      resource: input.type === "break-glass" ? input.resource : undefined,
    });
    let issue = ("issue" in input ? input.issue : undefined) ?? null;
    let repo = input.repo ?? null;
    if (input.type === "decision-vaulted") {
      // The follow-up must name a stored decision of this company, with the same vault note.
      const [decision] = await db
        .select()
        .from(rk9CoordEvents)
        .where(
          and(
            eq(rk9CoordEvents.companyId, companyId),
            eq(rk9CoordEvents.id, input.ref_event_id),
            eq(rk9CoordEvents.type, "decision"),
          ),
        )
        .limit(1);
      // RK9-646: the owner check runs first. An unverified caller gets the
      // same 403 for a missing event as for another actor's one, so the
      // 404/409 answers are no existence oracle for it.
      const ownerDenied = () =>
        new HttpError(403, "Only the decision's actor, its host or a trusted caller may mark it vaulted", {
          code: "rk9_coord_vault_owner_required",
        });
      if (!decision) {
        if (rk9CoordJournalTrust(actor) === "unverified") throw ownerDenied();
        throw new HttpError(404, "No decision event with that id", { code: "rk9_coord_event_not_found" });
      }
      if (!rk9CoordMayVaultDecision(actor, decision.actorRef)) throw ownerDenied();
      if (decision.vaultPath !== input.vault_path) {
        throw new HttpError(409, "vault_path differs from the decision's vault note", {
          code: "rk9_coord_vault_path_mismatch",
        });
      }
      // Route the follow-up to the same readers as the decision.
      issue ??= decision.issue;
      repo ??= decision.repo;
    }
    const built = buildRk9CoordEvent(input, actor.actorId);
    const summary = toRk9CoordLine(built.summary, RK9_COORD_SUMMARY_MAX) ?? input.type;
    const publications: ActivityPublication[] = [];
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(rk9CoordEvents)
        .values({
          companyId,
          type: input.type,
          actorRef: actor.actorId,
          actorKind: actor.kind,
          trust: rk9CoordJournalTrust(actor, input.type),
          issue,
          repo,
          summary,
          payload: built.payload,
          clientEventId: input.client_event_id ?? null,
          refEventId: built.refEventId,
          vaultPath: built.vaultPath,
          dedupeKey: built.dedupeKey ?? null,
          resource: built.resource ?? null,
          occurredAt: input.occurred_at ? new Date(input.occurred_at) : null,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0];
      if (row) {
        await logActivity(
          tx as unknown as Db,
          {
            companyId,
            ...(opts.activityActor ?? defaultActivityActor(actor, opts.agentId ?? null)),
            action: "rk9.coord.event_appended",
            entityType: "rk9_coord_event",
            entityId: String(row.id),
            details: { type: row.type, actor: row.actorRef, issue: row.issue, trust: row.trust },
          },
          publications,
        );
      }
      return rows;
    });
    for (const publication of publications) publishActivity(publication);
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
    // Producer dedupe (RK9-631 decision-vaulted, RK9-647 headsup): a stored
    // (company, type, dedupe_key) answers the stored row for any actor.
    if (built.dedupeKey) {
      const [existing] = await db
        .select()
        .from(rk9CoordEvents)
        .where(
          and(
            eq(rk9CoordEvents.companyId, companyId),
            eq(rk9CoordEvents.type, input.type),
            eq(rk9CoordEvents.dedupeKey, built.dedupeKey),
          ),
        )
        .limit(1);
      // Another actor gets the board view: a heads-up explanation stays hidden.
      if (existing) {
        const event = existing.actorRef === actor.actorId ? rk9CoordEventView(existing) : rk9CoordBoardEventView(existing);
        return { event, duplicate: true };
      }
    }
    throw new Error("rk9 coord event insert conflicted without a matching client_event_id or dedupe_key");
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
      : await ensureRk9CoordActorRow(db, companyId, actor, opts.agentId ?? null, opts.activityActor ?? null);
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

      // RK9-647: which ask-operator events this actor may see.
      const agentId = actor.kind === "agent_run" ? opts.agentId ?? null : null;
      const mine = (ref: AnyColumn): SQL => rk9CoordMineSql(ref, companyId, actor.actorId, agentId);
      let askOperatorVisible: SQL | undefined;
      if (!rk9CoordSeesAllAskOperator(actor)) {
        const asked = alias(rk9CoordEvents, "asked");
        const myQuestions = tx
          .select({ id: asked.id })
          .from(asked)
          .where(and(eq(asked.companyId, companyId), eq(asked.type, "ask-operator"), mine(asked.actorRef)));
        askOperatorVisible = or(
          ne(rk9CoordEvents.type, "ask-operator"),
          mine(rk9CoordEvents.actorRef),
          // Only the operator side answers: an agent or an unverified actor
          // cannot push a forged approval into another agent's delta.
          // RK9-657: RK9_COORD_ASK_OPERATOR_ANSWER_KINDS and not unverified, so a host-token cc claim
          // (stored unverified) is not an answer either.
          and(
            inArray(rk9CoordEvents.actorKind, [...RK9_COORD_ASK_OPERATOR_ANSWER_KINDS]),
            ne(rk9CoordEvents.trust, "unverified"),
            isNotNull(rk9CoordEvents.refEventId),
            inArray(rk9CoordEvents.refEventId, myQuestions),
          ),
        );
      }
      const concerns: SQL[] = [inArray(rk9CoordEvents.type, [...RK9_COORD_GLOBAL_EVENT_TYPES])];
      // RK9 Custom (RK9-629): rk9claude sends the escalation Telegram, the operator reads it.
      if (actor.kind === "rk9claude" || actor.kind === "operator") concerns.push(eq(rk9CoordEvents.type, "escalated"));
      if (repos.length > 0) concerns.push(inArray(rk9CoordEvents.repo, repos));
      if (issues.length > 0) concerns.push(inArray(rk9CoordEvents.issue, issues));
      // RK9-650: the /implement parent has no ticket of its own. Follow the
      // issues it handed off (done, blocker, ... written by pcp-wait as
      // worktree:<ID>) so those events reach its prompt delta.
      const handoffs = alias(rk9CoordEvents, "handoffs");
      const handedOff = tx
        .select({ issue: handoffs.issue })
        .from(handoffs)
        .where(
          and(
            eq(handoffs.companyId, companyId),
            eq(handoffs.type, "handoff"),
            eq(handoffs.actorRef, actor.actorId),
            isNotNull(handoffs.issue),
            gte(handoffs.createdAt, new Date(now.getTime() - RK9_COORD_HANDOFF_FOLLOW_WINDOW_MS)),
          ),
        )
        .groupBy(handoffs.issue)
        .orderBy(desc(sql`max(${handoffs.id})`))
        .limit(RK9_COORD_HANDOFF_FOLLOW_MAX);
      concerns.push(inArray(rk9CoordEvents.issue, handedOff));
      if (resources.length > 0) {
        concerns.push(and(isNotNull(rk9CoordEvents.resource), inArray(rk9CoordEvents.resource, resources))!);
      }
      const matching = and(
        eq(rk9CoordEvents.companyId, companyId),
        gt(rk9CoordEvents.id, cursor),
        lte(rk9CoordEvents.id, newCursor),
        // An actor is never told about its own events.
        ne(rk9CoordEvents.actorRef, actor.actorId),
        // RK9-647: never a heads-up; ask-operator by the rule above.
        notInArray(rk9CoordEvents.type, [...RK9_COORD_DELTA_HIDDEN_TYPES]),
        askOperatorVisible,
        or(...concerns),
      );

      // Count and rows in one statement (RK9-641): `count(*) over ()` is
      // computed before LIMIT on the same snapshot as the rows, so `total`
      // and `more` always agree with the returned events.
      const rows = await tx
        .select({ event: rk9CoordEvents, total: sql<number>`(count(*) over ())::int` })
        .from(rk9CoordEvents)
        .where(matching)
        .orderBy(desc(rk9CoordEvents.id))
        .limit(limit);
      const total = Number(rows[0]?.total ?? 0);

      // Every non-peek call touches updated_at, also when nothing is new:
      // retention (RK9-641) reads it as the actor's last activity.
      if (!peek) {
        await tx
          .update(rk9CoordCursors)
          .set({ lastEventId: newCursor, updatedAt: now })
          .where(and(eq(rk9CoordCursors.companyId, companyId), eq(rk9CoordCursors.actorId, self.id!)));
      }
      if (total === 0) return null;

      const events = rows.reverse().map((row) => rk9CoordEventView(row.event));
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
  async function board(
    companyId: string,
    opts: {
      viewerTrust: Rk9CoordTrust;
      /**
       * RK9-657: false gives every ask-operator row (rk9CoordIsAskOperatorRow)
       * as rk9CoordHiddenPayloadView, except the viewer's own questions and
       * the answers to them (rk9CoordBoardAskerRows). Default true.
       */
      askOperatorPayloads?: boolean;
      /** The restricted viewer, for its own questions (agentId: an agent_run's agent, for sibling runs). */
      viewer?: { actorId: string; agentId: string | null } | null;
      now?: Date;
      eventLimit?: number;
    },
  ) {
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
    const showAskPayloads = opts.askOperatorPayloads !== false;
    const askerRows = showAskPayloads ? new Set<number>() : await askerVisibleRows(companyId, events, opts.viewer ?? null);
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
      events: events.map((row) =>
        !showAskPayloads && rk9CoordIsAskOperatorRow(row) && !askerRows.has(row.id)
          ? rk9CoordHiddenPayloadView(row)
          : rk9CoordBoardEventView(row),
      ),
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

  /**
   * RK9-657 (parent refinement 3.11.2026): the ask-operator rows of `events`
   * a restricted board viewer still reads in full: its own questions (also of
   * a sibling run of the same agent), the answers to them (an operator-side
   * actor, RK9_COORD_ASK_OPERATOR_ANSWER_KINDS and not unverified, whose
   * reply_to points at one of them, the delta's rule) and the escalation of
   * one of them. Every other ask-operator row stays hidden. An operator-side
   * ask-operator that is only on the same issue is NOT shown: any actor can
   * pick the issue of its own question, so that match would let grok or
   * another agent read the operator side's questions on any issue (RK9-657
   * verifier). The operator's other events on the issue (decision, done,
   * phase) are never hidden.
   */
  async function askerVisibleRows(
    companyId: string,
    events: EventRow[],
    viewer: { actorId: string; agentId: string | null } | null,
  ): Promise<Set<number>> {
    const visible = new Set<number>();
    if (!viewer) return visible;
    const candidates = events.filter((row) => rk9CoordIsAskOperatorRow(row));
    if (candidates.length === 0) return visible;
    const answerer = (row: EventRow) =>
      (RK9_COORD_ASK_OPERATOR_ANSWER_KINDS as readonly string[]).includes(row.actorKind) && row.trust !== "unverified";
    const ids = new Set<number>();
    for (const row of candidates) {
      if (row.type === "ask-operator") ids.add(row.id);
      if (row.refEventId !== null) ids.add(row.refEventId);
    }
    const mineRows = await db
      .select({ id: rk9CoordEvents.id })
      .from(rk9CoordEvents)
      .where(
        and(
          eq(rk9CoordEvents.companyId, companyId),
          eq(rk9CoordEvents.type, "ask-operator"),
          rk9CoordMineSql(rk9CoordEvents.actorRef, companyId, viewer.actorId, viewer.agentId),
          inArray(rk9CoordEvents.id, [...ids]),
        ),
      );
    const mineIds = new Set(mineRows.map((row) => row.id));
    for (const row of candidates) {
      if (row.type === "escalated") {
        if (row.refEventId !== null && mineIds.has(row.refEventId)) visible.add(row.id);
        continue;
      }
      if (mineIds.has(row.id)) visible.add(row.id);
      else if (answerer(row) && row.refEventId !== null && mineIds.has(row.refEventId)) visible.add(row.id);
    }
    return visible;
  }

  /**
   * Decisions written with a vault note that have no decision-vaulted
   * follow-up yet (RK9-631, `rk9 decision --retry`). Oldest first. An
   * unverified caller (remote host token, Grok) sees only the decisions it
   * may close (its own, and for a host token those of its host, RK9-646),
   * the same rule as the follow-up write.
   * RK9-646: a legacy row whose vault_path is not an rk9/ decision note can
   * never be closed (decision-vaulted refuses the path), so it is left out.
   * `after` pages: only ids above it; `nextAfter` is the last id of a full
   * page, else null.
   */
  async function vaultPending(
    companyId: string,
    actor: Rk9CoordResolvedActor,
    opts: { id?: number; limit?: number; after?: number } = {},
  ): Promise<{ events: Rk9CoordEventView[]; nextAfter: number | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const conditions: SQL[] = [
      eq(rk9CoordEvents.companyId, companyId),
      eq(rk9CoordEvents.type, "decision"),
      isNotNull(rk9CoordEvents.vaultPath),
      sql`${rk9CoordEvents.vaultPath} ~ ${RK9_COORD_DECISION_NOTE_PATTERN.source}`,
      // The dedupe key of the follow-up hits rk9_coord_events_dedupe_uq.
      sql`not exists (select 1 from rk9_coord_events v where v.company_id = ${rk9CoordEvents.companyId} and v.type = 'decision-vaulted' and v.dedupe_key = 'decision-vaulted:' || ${rk9CoordEvents.id}::text)`,
    ];
    if (opts.id !== undefined) conditions.push(eq(rk9CoordEvents.id, opts.id));
    if (opts.after !== undefined) conditions.push(gt(rk9CoordEvents.id, opts.after));
    if (rk9CoordJournalTrust(actor) === "unverified") {
      const host = rk9CoordVaultOwnerHost(actor);
      // The host comes from the token, never from the request; split_part
      // compares it literally (no LIKE wildcard in a host label).
      conditions.push(
        host
          ? or(
              eq(rk9CoordEvents.actorRef, actor.actorId),
              eq(rk9CoordEvents.actorRef, `remote:${host}`),
              sql`(split_part(${rk9CoordEvents.actorRef}, ':', 1) = 'cc' and split_part(${rk9CoordEvents.actorRef}, ':', 2) = ${host})`,
            )!
          : eq(rk9CoordEvents.actorRef, actor.actorId),
      );
    }
    const rows = await db
      .select()
      .from(rk9CoordEvents)
      .where(and(...conditions))
      .orderBy(rk9CoordEvents.id)
      .limit(limit);
    const nextAfter = rows.length === limit ? rows[rows.length - 1]!.id : null;
    return { events: rows.map(rk9CoordEventView), nextAfter };
  }

  return { append, delta, board, vaultPending };
}
// --- /RK9 Custom ---
