// --- RK9 Custom (RK9-626): coord inbox (epic RK9-620, key journal-inbox-api) ---
//
// Messages for coord actors that are not reachable right now.
// - send(): `to` is an actor id, an issue identifier or a name.
//   * issue identifier -> queued for whichever actor next claims with that
//     issue (exactly once);
//   * a Paperclip agent target (`agent_run:<runId>`, or the name of an agent of
//     the company when no coord actor has that name) -> an issue comment
//     through issueService.addComment plus an activity_log row; no inbox row;
//   * anything else -> an inbox row for that actor (to_actor_id) or name.
//   The answer carries target_live + name, so the CLI can suggest SendMessage.
// - claim(): GET /inbox/me. One UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
//   SKIP LOCKED) RETURNING: two concurrent claimers never get the same row.
//
// Contract: docs/implementation-notes/coord-bus.md.
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, rk9CoordActors, rk9CoordInbox } from "@paperclipai/db";
import { parseRk9CoordActorId, RK9_COORD_ISSUE_PATTERN, type SendRk9CoordInbox } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import {
  ensureRk9CoordActorRow,
  findRk9CoordActorRow,
  isRk9CoordActorLive,
  rk9CoordActorIssue,
  rk9CoordPresenceTtlSeconds,
  type Rk9CoordActorRow,
} from "./rk9-coord-journal.js";
import { toRk9CoordLine } from "./rk9-coord-text.js";

/** DB CHECK: body is 1..500 characters. */
export const RK9_COORD_INBOX_BODY_MAX = 500;
const CLAIM_LIMIT = 50;
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

  async function findIssue(companyId: string, identifier: string) {
    const [row] = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.identifier, identifier)))
      .limit(1);
    return row ?? null;
  }

  async function findIssueById(companyId: string, issueId: string) {
    const [row] = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
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
    // Least privilege (ADR): a coord token never reaches issues or comments.
    if (caller.paperclip.type === "coord_token") {
      throw coordError(403, "rk9_coord_kind_not_allowed", "A coord token cannot message a Paperclip agent");
    }
    let issue: { id: string; identifier: string | null } | null = null;
    if (input.issue) {
      issue = await findIssue(companyId, input.issue);
    } else if (target.runIssueId) {
      issue = await findIssueById(companyId, target.runIssueId);
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
    const commentBody = `${COMMENT_PREFIX} from \`${caller.actor.actorId}\` to ${target.agentName}:\n\n${body}`;
    const author =
      caller.paperclip.type === "agent"
        ? { agentId: caller.paperclip.agentId, runId: caller.paperclip.runId }
        : { userId: caller.paperclip.userId };
    // issueService.addComment does not wake the assignee: the agent sees the
    // comment on its next heartbeat. A message must not buy a heartbeat run.
    const comment = await issueService(db).addComment(issue.id, commentBody, author);
    await logActivity(db, {
      companyId,
      ...activityActor(caller),
      action: "rk9.coord.message_commented",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: {
        from: caller.actor.actorId,
        to: target.toValue,
        targetAgentId: target.agentId,
        commentId: comment.id,
      },
    });
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
    const [row] = await db
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
    await logActivity(db, {
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
    });
    return row!.id;
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
    if (named.length === 0) {
      const [agent] = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), sql`lower(${agents.name}) = lower(${to})`))
        .limit(1);
      if (agent) {
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
    opts: { agentId?: string | null } = {},
  ): Promise<Rk9CoordInboxMessage[]> {
    const now = clock();
    const self = await ensureRk9CoordActorRow(db, companyId, actor, opts.agentId ?? null);
    return claimForRow(companyId, self, now);
  }

  async function claimForRow(companyId: string, self: Rk9CoordActorRow, now: Date): Promise<Rk9CoordInboxMessage[]> {
    const issue = rk9CoordActorIssue(self);
    const at = sql`${now.toISOString()}::timestamptz`;
    const names = [self.actorRef, ...(self.name ? [self.name] : [])];
    const targets = [
      sql`i.to_actor_id = ${self.id}`,
      sql`i.to_name in (${sql.join(names.map((name) => sql`${name}`), sql`, `)})`,
    ];
    if (issue) targets.push(sql`i.to_issue = ${issue}`);
    const result = await db.execute<{
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
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
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

  return { send, claim };
}
// --- /RK9 Custom ---
