// --- RK9 Custom (RK9-626): coord inbox (epic RK9-620, key journal-inbox-api) ---
//
// Messages for coord actors that are not reachable right now.
// - send(): `to` is an actor id, an issue identifier or a name.
//   * issue identifier -> queued for whichever actor next claims with that
//     issue (exactly once);
//   * a Paperclip agent target (`agent_run:<runId>`, or the name of an agent of
//     the company when no coord actor has that name) -> an issue comment
//     through issueService.addComment plus an activity_log row; no inbox row.
//     Only a board user (the operator's key or session) may do this: agents
//     comment through the issue comment API, which applies the low-trust
//     boundary, watchdog scope and visibility checks; coord tokens never
//     reach issues or agents (ADR least privilege), not even by lookup;
//   * anything else -> an inbox row for that actor (to_actor_id) or name.
//   The answer carries target_live + name, so the CLI can suggest SendMessage.
// - count(): GET /inbox/me?peek=1 or /inbox/me/count (RK9-676). A read
//   only: no claim, no actor row, no activity row. The count is capped at
//   one claim batch (50).
// - claim(): GET /inbox/me. One UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
//   SKIP LOCKED) RETURNING: two concurrent claimers never get the same row.
//   Only a local (board-key) or verified actor claims rows addressed by
//   name or issue; remote, grok and agent_run actors claim only rows
//   addressed to their exact actor id (operator decision 2.11.2026, RK9-641).
// - Every write logs activity_log in its own transaction (RK9-641): send
//   (`rk9.coord.inbox_sent`), a claim that delivers rows
//   (`rk9.coord.inbox_claimed`) and the agent-message comment
//   (`issue.comment_added` plus `rk9.coord.message_commented`).
//
// Contract: docs/implementation-notes/coord-bus.md.
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, rk9CoordActors, rk9CoordInbox } from "@paperclipai/db";
import { parseRk9CoordActorId, RK9_COORD_ISSUE_PATTERN, type SendRk9CoordInbox } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueReferenceService } from "./issue-references.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import {
  assertRk9CoordNoSecretFields,
  ensureRk9CoordActorRow,
  findRk9CoordActorRow,
  isRk9CoordActorLive,
  rk9CoordActorIssue,
  rk9CoordPresenceTtlSeconds,
  type Rk9CoordActivityActor,
  type Rk9CoordActorRow,
} from "./rk9-coord-journal.js";
import { toRk9CoordLine } from "./rk9-coord-text.js";

/** DB CHECK: body is 1..500 characters. */
export const RK9_COORD_INBOX_BODY_MAX = 500;
/** At most this many rows per claim; the peek count is capped at it too. */
export const RK9_COORD_INBOX_CLAIM_LIMIT = 50;
const CLAIM_LIMIT = RK9_COORD_INBOX_CLAIM_LIMIT;
const COMMENT_PREFIX = "**RK9 coord message**";

function coordError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

/** Who sent the request, as far as Paperclip authorship is concerned. */
export interface Rk9CoordInboxCaller {
  actor: Rk9CoordResolvedActor;
  /** The Paperclip principal behind the call, for comments and activity_log. */
  paperclip:
    | { type: "user"; userId: string }
    | { type: "agent"; agentId: string; runId: string | null; agentApiKeyId: string | null }
    | { type: "coord_token" };
  /**
   * RK9 Custom (RK9-701): the caller's upstream issue-privacy predicate (issueReadSqlCondition).
   * A message never lands as a comment on a private issue that the caller cannot read.
   */
  issueReadCondition?: SQL<boolean>;
}

export interface Rk9CoordInboxSendResult {
  delivery: "inbox" | "issue_comment";
  id: number | null;
  to: { kind: "actor" | "issue" | "name" | "agent"; value: string };
  /** True when the target is a live coord actor right now: the CLI can use SendMessage. */
  target_live: boolean;
  /** The target's session/agent name for SendMessage, when known. */
  name: string | null;
  issue: string | null;
  comment_id: string | null;
}

export interface Rk9CoordInboxMessage {
  id: number;
  kind: string;
  body: string;
  from: string;
  /** The sender's name, for a SendMessage reply. */
  name: string | null;
  /** True when the sender is live right now. */
  target_live: boolean;
  to: string;
  created_at: string;
}

/**
 * May this actor claim inbox rows addressed by name or issue? Only local
 * sessions (the paperclip-01 board key) and verified actors (operator,
 * rk9claude). Remote hosts, Grok and agent runs (even with a verified run
 * JWT) claim only rows addressed to their exact actor id, so a remote
 * token cannot set a session's name or issue in presence and read its
 * messages (operator decision 2.11.2026, RK9-641 items 3 and 6).
 */
export function rk9CoordMayClaimByNameOrIssue(actor: Rk9CoordResolvedActor): boolean {
  if (actor.kind === "remote" || actor.kind === "grok" || actor.kind === "agent_run") return false;
  return actor.principal === "board_key" || actor.trust === "verified";
}

function activityActor(caller: Rk9CoordInboxCaller) {
  const { paperclip } = caller;
  if (paperclip.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: paperclip.agentId,
      agentId: paperclip.agentId,
      runId: paperclip.runId,
      agentApiKeyId: paperclip.agentApiKeyId,
    };
  }
  if (paperclip.type === "user") {
    return { actorType: "user" as const, actorId: paperclip.userId, agentId: null, runId: null };
  }
  return { actorType: "system" as const, actorId: caller.actor.actorId, agentId: null, runId: null };
}

/**
 * Only a board user may turn a coord message into an issue comment. Checked
 * before any agent or run lookup, so a coord token learns nothing about
 * agents or runs from the answer.
 */
function assertMayMessageAgents(caller: Rk9CoordInboxCaller) {
  if (caller.paperclip.type === "coord_token") {
    throw coordError(403, "rk9_coord_kind_not_allowed", "A coord token cannot message a Paperclip agent");
  }
  if (caller.paperclip.type === "agent") {
    throw coordError(
      403,
      "rk9_coord_kind_not_allowed",
      "Agents message other agents through the issue comment API, not the coord inbox",
    );
  }
}

export function rk9CoordInboxService(db: Db, opts: { now?: () => Date } = {}) {
  const clock = opts.now ?? (() => new Date());

  async function liveActorsByIssue(companyId: string, issue: string, now: Date) {
    const since = new Date(now.getTime() - rk9CoordPresenceTtlSeconds() * 1000);
    return db
      .select({ name: rk9CoordActors.name, actorRef: rk9CoordActors.actorRef })
      .from(rk9CoordActors)
      .where(
        and(
          eq(rk9CoordActors.companyId, companyId),
          isNull(rk9CoordActors.endedAt),
          gt(rk9CoordActors.lastSeenAt, since),
          or(eq(rk9CoordActors.issue, issue), eq(rk9CoordActors.actorRef, `worktree:${issue}`)),
        ),
      )
      .limit(5);
  }

  async function actorsByName(companyId: string, name: string) {
    return db
      .select({
        id: rk9CoordActors.id,
        actorRef: rk9CoordActors.actorRef,
        kind: rk9CoordActors.kind,
        name: rk9CoordActors.name,
        issue: rk9CoordActors.issue,
        repo: rk9CoordActors.repo,
        lastSeenAt: rk9CoordActors.lastSeenAt,
        endedAt: rk9CoordActors.endedAt,
      })
      .from(rk9CoordActors)
      .where(and(eq(rk9CoordActors.companyId, companyId), eq(rk9CoordActors.name, name)))
      .limit(20);
  }

  async function findIssue(companyId: string, identifier: string, readCondition?: SQL<boolean>) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        conversationAgentId: issues.conversationAgentId,
      })
      .from(issues)
      // RK9 Custom (RK9-701): a hidden issue is not resolved by identifier.
      .where(and(eq(issues.companyId, companyId), eq(issues.identifier, identifier), visibleIssueCondition(), readCondition))
      .limit(1);
    return row ?? null;
  }

  async function findIssueById(companyId: string, issueId: string, readCondition?: SQL<boolean>) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        conversationAgentId: issues.conversationAgentId,
      })
      .from(issues)
      // RK9 Custom (RK9-701): a hidden issue is not resolved by id.
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), visibleIssueCondition(), readCondition))
      .limit(1);
    return row ?? null;
  }

  /** A message to a Paperclip agent becomes a comment on the agent's issue. */
  async function commentForAgent(
    companyId: string,
    caller: Rk9CoordInboxCaller,
    input: SendRk9CoordInbox,
    body: string,
    target: { agentId: string; agentName: string; runIssueId: string | null; toValue: string },
  ): Promise<Rk9CoordInboxSendResult> {
    assertMayMessageAgents(caller);
    if (caller.paperclip.type !== "user") throw new Error("unreachable");
    let issue: { id: string; identifier: string | null; title: string; conversationAgentId: string | null } | null = null;
    if (input.issue) {
      issue = await findIssue(companyId, input.issue, caller.issueReadCondition);
    } else if (target.runIssueId) {
      issue = await findIssueById(companyId, target.runIssueId, caller.issueReadCondition);
    } else {
      throw coordError(
        422,
        "rk9_coord_inbox_issue_required",
        "A message to a Paperclip agent needs an issue (body.issue) to comment on",
      );
    }
    if (!issue) {
      throw coordError(404, "rk9_coord_inbox_target_not_found", "The issue for this agent message was not found");
    }
    // Agent Chat conversations have their own message contract.
    if (issue.conversationAgentId) {
      throw coordError(422, "rk9_coord_inbox_target_not_allowed", "Agent Chat conversations do not take coord messages");
    }
    // Same rule as the board comment route: no new messages into a paused tree.
    const hold = await issueTreeControlService(db).getActivePauseHoldGate(companyId, issue.id);
    if (hold) {
      throw coordError(409, "rk9_coord_inbox_issue_paused", "The issue is paused; resume it before sending a message");
    }
    const commentBody = `${COMMENT_PREFIX} from \`${caller.actor.actorId}\` to ${target.agentName}:\n\n${body}`;
    const author = { userId: caller.paperclip.userId };
    // issueService.addComment does not wake the assignee: the agent sees the
    // comment on its next heartbeat. A message must not buy a heartbeat run.
    // RK9-641: the same activity row and live event as POST
    // /issues/:id/comments (`issue.comment_added`, published after the
    // commit) plus the coord row, in the comment's transaction, and the
    // issue-reference index after it. External-object sync is left out: it
    // needs the plugin worker manager of the issue routes.
    const publications: ActivityPublication[] = [];
    const commented = issue;
    const comment = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const added = await issueService(txDb).addComment(commented.id, commentBody, author, undefined, txDb);
      await logActivity(
        txDb,
        {
          companyId,
          ...activityActor(caller),
          action: "issue.comment_added",
          entityType: "issue",
          entityId: commented.id,
          details: {
            commentId: added.id,
            bodySnippet: added.body.slice(0, 120),
            identifier: commented.identifier,
            issueTitle: commented.title,
            coordInbox: true,
          },
        },
        publications,
      );
      await logActivity(
        txDb,
        {
          companyId,
          ...activityActor(caller),
          action: "rk9.coord.message_commented",
          entityType: "issue",
          entityId: commented.id,
          details: {
            from: caller.actor.actorId,
            to: target.toValue,
            targetAgentId: target.agentId,
            commentId: added.id,
          },
        },
        publications,
      );
      return added;
    });
    for (const publication of publications) publishActivity(publication);
    try {
      await issueReferenceService(db).syncComment(comment.id);
    } catch (err) {
      logger.warn({ err, issueId: issue.id, commentId: comment.id }, "rk9 coord message: could not index comment references");
    }
    return {
      delivery: "issue_comment",
      id: null,
      to: { kind: "agent", value: target.toValue },
      target_live: false,
      name: target.agentName,
      issue: issue.identifier,
      comment_id: comment.id,
    };
  }

  async function insertMessage(
    companyId: string,
    caller: Rk9CoordInboxCaller,
    input: SendRk9CoordInbox,
    body: string,
    target: { toActorId?: string; toIssue?: string; toName?: string },
    now: Date,
  ) {
    const sender = await findRk9CoordActorRow(db, companyId, caller.actor.actorId);
    // Insert and activity row in one transaction (RK9-641).
    const publications: ActivityPublication[] = [];
    const id = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [row] = await txDb
        .insert(rk9CoordInbox)
        .values({
          companyId,
          toActorId: target.toActorId ?? null,
          toIssue: target.toIssue ?? null,
          toName: target.toName ?? null,
          fromActorId: sender?.id ?? null,
          fromActorRef: caller.actor.actorId,
          kind: input.kind ?? "message",
          body,
          expiresAt: input.expires_in_s ? new Date(now.getTime() + input.expires_in_s * 1000) : null,
        })
        .returning({ id: rk9CoordInbox.id });
      await logActivity(
        txDb,
        {
          companyId,
          ...activityActor(caller),
          action: "rk9.coord.inbox_sent",
          entityType: "rk9_coord_inbox",
          entityId: String(row!.id),
          details: {
            from: caller.actor.actorId,
            to: target.toActorId ? input.to : target.toIssue ?? target.toName ?? input.to,
            kind: input.kind ?? "message",
          },
        },
        publications,
      );
      return row!.id;
    });
    for (const publication of publications) publishActivity(publication);
    return id;
  }

  async function send(
    companyId: string,
    caller: Rk9CoordInboxCaller,
    input: SendRk9CoordInbox,
  ): Promise<Rk9CoordInboxSendResult> {
    const now = clock();
    const body = toRk9CoordLine(input.body, RK9_COORD_INBOX_BODY_MAX);
    if (!body) throw coordError(400, "rk9_coord_inbox_body_empty", "The message body is empty after redaction");
    const to = input.to;
    // `to` is stored verbatim (to_name) and shown on the board.
    assertRk9CoordNoSecretFields({ to });

    // 1. Issue identifier: the first actor that claims with this issue gets it.
    if (RK9_COORD_ISSUE_PATTERN.test(to)) {
      const live = await liveActorsByIssue(companyId, to, now);
      const id = await insertMessage(companyId, caller, input, body, { toIssue: to }, now);
      return {
        delivery: "inbox",
        id,
        to: { kind: "issue", value: to },
        target_live: live.length > 0,
        name: live.find((row) => row.name)?.name ?? null,
        issue: to,
        comment_id: null,
      };
    }

    // 2. Actor id.
    const parsed = parseRk9CoordActorId(to);
    if (parsed) {
      if (parsed.kind === "agent_run") {
        assertMayMessageAgents(caller);
        const [run] = await db
          .select({
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
          .where(and(eq(heartbeatRuns.id, parsed.ref!), eq(heartbeatRuns.companyId, companyId)))
          .limit(1);
        if (!run) {
          throw coordError(404, "rk9_coord_inbox_target_not_found", "No heartbeat run with this id in this company");
        }
        const runIssueId = run.issueId && /^[0-9a-f-]{36}$/i.test(run.issueId) ? run.issueId : null;
        return commentForAgent(companyId, caller, input, body, {
          agentId: run.agentId,
          agentName: run.agentName,
          runIssueId,
          toValue: to,
        });
      }
      const row = await findRk9CoordActorRow(db, companyId, to);
      const id = await insertMessage(
        companyId,
        caller,
        input,
        body,
        row ? { toActorId: row.id } : { toName: to },
        now,
      );
      return {
        delivery: "inbox",
        id,
        to: { kind: row ? "actor" : "name", value: to },
        target_live: isRk9CoordActorLive(row, now),
        name: row?.name ?? null,
        issue: null,
        comment_id: null,
      };
    }

    // 3. Name: a coord actor name first, then a Paperclip agent name.
    const named = await actorsByName(companyId, to);
    // Coord tokens never look agents up (ADR: a token does not expose agents).
    if (named.length === 0 && caller.paperclip.type !== "coord_token") {
      const [agent] = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), sql`lower(${agents.name}) = lower(${to})`))
        .limit(1);
      if (agent) {
        // An agent caller gets 403 here instead of a message nobody claims.
        return commentForAgent(companyId, caller, input, body, {
          agentId: agent.id,
          agentName: agent.name,
          runIssueId: null,
          toValue: to,
        });
      }
    }
    const id = await insertMessage(companyId, caller, input, body, { toName: to }, now);
    const live = named.find((row) => isRk9CoordActorLive(row, now));
    return {
      delivery: "inbox",
      id,
      to: { kind: "name", value: to },
      target_live: Boolean(live),
      name: live?.name ?? (named.length > 0 ? to : null),
      issue: null,
      comment_id: null,
    };
  }

  /**
   * Claim and mark delivered every pending message for the caller: rows
   * addressed to its actor row, to its actor id or name, or to the issue it
   * works on. Exactly-once: SKIP LOCKED in the subquery plus the re-checked
   * `delivered_at IS NULL` in the UPDATE.
   */
  async function claim(
    companyId: string,
    actor: Rk9CoordResolvedActor,
    opts: { agentId?: string | null; activityActor?: Rk9CoordActivityActor | null } = {},
  ): Promise<Rk9CoordInboxMessage[]> {
    const now = clock();
    const self = await ensureRk9CoordActorRow(db, companyId, actor, opts.agentId ?? null, opts.activityActor ?? null);
    return claimForRow(companyId, actor, self, now, opts.activityActor ?? null);
  }

  /**
   * The rows a claim by this actor would take: its actor row, its actor id
   * held as a name, and (local or verified actors only) its name and issue.
   * `self` is null when the actor has no row yet (peek does not create one).
   */
  function claimTargets(actor: Rk9CoordResolvedActor, self: Rk9CoordActorRow | null) {
    // The exact actor id: the actor row, or a name row that holds the id
    // (send() stores an actor id without a row as to_name).
    const targets = [sql`i.to_name = ${actor.actorId}`];
    if (self) targets.push(sql`i.to_actor_id = ${self.id}`);
    if (rk9CoordMayClaimByNameOrIssue(actor)) {
      if (self?.name) targets.push(sql`i.to_name = ${self.name}`);
      const issue = rk9CoordActorIssue(self ?? { issue: null, actorRef: actor.actorId });
      if (issue) targets.push(sql`i.to_issue = ${issue}`);
    }
    return targets;
  }

  /**
   * RK9-676: GET /inbox/me?peek=1 and GET /inbox/me/count. Counts the
   * messages a claim would deliver, without claiming them: no UPDATE, no
   * actor row (an unknown actor counts its id-addressed rows only), no
   * activity row. The CLI background refresh calls it for the status line;
   * before RK9-676 the server ignored `peek` and the refresh consumed the
   * messages that `rk9 inbox` should show.
   */
  async function count(companyId: string, actor: Rk9CoordResolvedActor): Promise<number> {
    const at = sql`${clock().toISOString()}::timestamptz`;
    const self = await findRk9CoordActorRow(db, companyId, actor.actorId);
    const result = await db.execute<{ count: string | number }>(sql`
      select count(*)::int as count from (
        select i.id from rk9_coord_inbox i
        where i.company_id = ${companyId}
          and i.delivered_at is null
          and (i.expires_at is null or i.expires_at > ${at})
          and (${sql.join(claimTargets(actor, self), sql` or `)})
        limit ${CLAIM_LIMIT}
      ) pending
    `);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return Number((rows[0] as { count?: string | number } | undefined)?.count ?? 0);
  }

  async function claimForRow(
    companyId: string,
    actor: Rk9CoordResolvedActor,
    self: Rk9CoordActorRow,
    now: Date,
    activity: Rk9CoordActivityActor | null,
  ): Promise<Rk9CoordInboxMessage[]> {
    const at = sql`${now.toISOString()}::timestamptz`;
    const targets = claimTargets(actor, self);
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const claimedRows = await txDb.execute<{
        id: string | number;
        kind: string;
        body: string;
        from_actor_ref: string;
        from_actor_id: string | null;
        to_actor_id: string | null;
        to_issue: string | null;
        to_name: string | null;
        created_at: string | Date;
      }>(sql`
        update rk9_coord_inbox
        set delivered_at = ${at}, delivered_to_actor_id = ${self.id}
        where delivered_at is null
          and company_id = ${companyId}
          and id in (
            select i.id from rk9_coord_inbox i
            where i.company_id = ${companyId}
              and i.delivered_at is null
              and (i.expires_at is null or i.expires_at > ${at})
              and (${sql.join(targets, sql` or `)})
            order by i.id
            limit ${CLAIM_LIMIT}
            for update skip locked
          )
        returning id, kind, body, from_actor_ref, from_actor_id, to_actor_id, to_issue, to_name, created_at
      `);
      const list = Array.isArray(claimedRows) ? claimedRows : ((claimedRows as { rows?: unknown[] }).rows ?? []);
      // A claim that delivers rows changes them (delivered_at,
      // delivered_to_actor_id): one activity row per claim call, in the
      // same transaction (RK9-641). An empty claim writes none.
      if (list.length > 0) {
        const ids = (list as Array<Record<string, unknown>>).map((row) => Number(row.id)).sort((a, b) => a - b);
        await logActivity(
          txDb,
          {
            companyId,
            ...(activity ?? { actorType: "system" as const, actorId: actor.actorId, agentId: null, runId: null }),
            action: "rk9.coord.inbox_claimed",
            entityType: "rk9_coord_actor",
            entityId: self.id,
            details: { actor: actor.actorId, count: ids.length, ids },
          },
          publications,
        );
      }
      return list;
    });
    for (const publication of publications) publishActivity(publication);
    const rows = result;
    const claimed = (rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      kind: String(row.kind),
      body: String(row.body),
      fromRef: String(row.from_actor_ref),
      to: String(row.to_issue ?? row.to_name ?? self.actorRef),
      createdAt: new Date(row.created_at as string),
    }));
    claimed.sort((a, b) => a.id - b.id);
    const senders = new Map<string, Rk9CoordActorRow | null>();
    for (const message of claimed) {
      if (!senders.has(message.fromRef)) {
        senders.set(message.fromRef, await findRk9CoordActorRow(db, companyId, message.fromRef));
      }
    }
    return claimed.map((message) => {
      const sender = senders.get(message.fromRef) ?? null;
      return {
        id: message.id,
        kind: message.kind,
        body: message.body,
        from: message.fromRef,
        name: sender?.name ?? null,
        target_live: isRk9CoordActorLive(sender, now),
        to: message.to,
        created_at: message.createdAt.toISOString(),
      };
    });
  }

  return { send, claim, count };
}
// --- /RK9 Custom ---
