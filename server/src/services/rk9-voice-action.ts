// --- RK9 Custom (RK9-479): `voice_action` approvals. A voice assistant (Grok)
// proposes an internal issue action; the board approves it and the server
// executes the stored payload through the issue service in the approver's name.
// The payload is checked on create and resubmit, and again on approve, because
// the issue can move or disappear between the proposal and the decision.
//
// Only the HTTP approve route (web UI, Telegram listener) executes it. The Slack
// card and the plugin chat bridge refuse to approve a voice_action, because
// they do not show the operator the exact text that would be applied.
//
// RK9-490: the action has the side effects of the same action in the UI
// (wakes, terminal clean-up). This module calls the services directly and does
// not share code with routes/issues.ts, which upstream changes all the time.
// Where the UI action takes a route-only step (stop a runner goal, reopen the
// issue, resolve a recovery action), the voice action is refused instead. ---
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import {
  isClosedIsolatedExecutionWorkspace,
  voiceActionApprovalPayloadSchema,
  type VoiceActionApprovalPayload,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactEventPayload } from "../redaction.js";
import { isApprovalReviewComment, shouldImplicitlyMoveCommentedIssueToTodo } from "../routes/issues.js";
import { publishActivity, type ActivityPublication, type logActivity as logActivityFn } from "./activity-log.js";
import type { environmentRuntimeService } from "./environment-runtime.js";
import type { executionWorkspaceService } from "./execution-workspaces.js";
import type { heartbeatService } from "./heartbeat.js";
import { shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";
import {
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
} from "./issue-dependency-wakeups.js";
import type { issueRecoveryActionService, issueThreadInteractionService, issueTreeControlService } from "./index.js";
import { executeIssuePostCommitActions, type IssuePostCommitAction, type issueService } from "./issues.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "./recovery/review-path-recovery.js";
import { deliverAgentUnblockNotification } from "./routable-blocked.js";
import type { runnerGoalService } from "./runner-goals.js";
import type { taskWatchdogService } from "./task-watchdogs.js";

type IssueService = ReturnType<typeof issueService>;
type ResolvedIssue = NonNullable<Awaited<ReturnType<IssueService["getById"]>>>;
type HeartbeatService = ReturnType<typeof heartbeatService>;
type WakeupRequest = NonNullable<Parameters<HeartbeatService["wakeup"]>[1]>;
type InteractionService = ReturnType<typeof issueThreadInteractionService>;

export const VOICE_ACTION_APPROVAL_TYPE = "voice_action";

/** Shown by approval surfaces that cannot display the payload. */
export const VOICE_ACTION_APPROVE_ELSEWHERE =
  "Grok-ehdotus hyväksytään Paperclipissa tai Telegramissa, jossa näkyy tarkka teksti.";

/** The services an approved voice_action calls (`createVoiceActionDeps`). */
export type VoiceActionDeps = {
  db: Db;
  issuesSvc: Pick<
    IssueService,
    | "getById"
    | "getByIdForUpdate"
    | "addComment"
    | "update"
    | "getDependencyReadiness"
    | "findMentionedAgents"
    | "listWakeableBlockedDependents"
    | "getWakeableParentAfterChildCompletion"
    | "getCurrentScheduledRetry"
    | "listReviewAttention"
  >;
  approvalSvc: { addComment: (approvalId: string, body: string, actor: { userId?: string }) => Promise<unknown> };
  logActivity: typeof logActivityFn;
  heartbeat: Pick<HeartbeatService, "wakeup" | "getRun" | "getActiveRunForAgent">;
  runnerGoals: Pick<ReturnType<typeof runnerGoalService>, "projection">;
  recoveryActions: Pick<ReturnType<typeof issueRecoveryActionService>, "getActiveForIssue">;
  treeControl: Pick<ReturnType<typeof issueTreeControlService>, "getActivePauseHoldGate">;
  executionWorkspaces: Pick<ReturnType<typeof executionWorkspaceService>, "getById">;
  interactions: Pick<
    InteractionService,
    "expireRequestConfirmationsSupersededByComment" | "expirePendingInteractionsForTerminalIssue"
  >;
  issueReferences: { syncComment: (commentId: string) => Promise<unknown> };
  externalObjects: { syncCommentSafely: (commentId: string) => Promise<unknown> };
  routines: { syncRunStatusForIssue: (issueId: string) => Promise<unknown> };
  taskWatchdogs: Pick<ReturnType<typeof taskWatchdogService>, "reconcileForIssueAndAncestors">;
  environmentRuntime: Pick<ReturnType<typeof environmentRuntimeService>, "destroyReusableSandboxLeases">;
  markBlockedOwnerNotified: (issue: { id: string; companyId: string }, notifiedAt: Date) => Promise<unknown>;
};

/** The approver as the issue routes see a board user. */
type VoiceActor = { actorType: "user"; actorId: string };

type ResolvedVoiceAction =
  | { ok: true; payload: VoiceActionApprovalPayload; issue: ResolvedIssue }
  | { ok: false; reason: string };

/** One message for "missing" and "other company" so a proposal cannot probe
 * for issues outside its own company. */
const ISSUE_NOT_IN_COMPANY = "issue not found in this company";

export async function resolveVoiceAction(
  issuesSvc: Pick<IssueService, "getById">,
  companyId: string,
  rawPayload: unknown,
): Promise<ResolvedVoiceAction> {
  // Unknown keys are dropped, not rejected: the Slack forwarder writes
  // `slackMessageRef` into the stored payload after create.
  const parsed = voiceActionApprovalPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `invalid payload (${detail})` };
  }
  const payload = parsed.data;
  // The approval view reads the payload through redactEventPayload. A body it
  // would mask cannot be shown to the operator exactly, so it is refused.
  if (payload.body !== undefined && redactEventPayload({ body: payload.body })?.body !== payload.body) {
    return { ok: false, reason: "body contains credential-like text that the approval view would hide" };
  }
  const issue = await issuesSvc.getById(payload.issueId);
  // The identifier is what the approval card shows the operator, so it must
  // name the same issue the action targets.
  if (!issue || issue.companyId !== companyId || issue.identifier !== payload.identifier) {
    return { ok: false, reason: ISSUE_NOT_IN_COMPANY };
  }
  return { ok: true, payload, issue };
}

/** The payload to store on create and resubmit: the parsed proposal plus the
 * issue state the operator sees, which approve compares against. */
export function voiceActionPayloadToPersist(
  resolved: Extract<ResolvedVoiceAction, { ok: true }>,
): VoiceActionApprovalPayload {
  return {
    ...resolved.payload,
    issueStatusAtProposal: resolved.issue.status,
    assigneeAgentIdAtProposal: resolved.issue.assigneeAgentId ?? null,
  };
}

/** The action applies only to the issue state the proposal was made for: a
 * later approval must not close an issue that was reopened, or wake an agent
 * that took the issue over, in between. */
function stalenessRefusal(
  payload: VoiceActionApprovalPayload,
  issue: Pick<ResolvedIssue, "status" | "assigneeAgentId">,
): string | null {
  if (payload.issueStatusAtProposal === undefined || payload.assigneeAgentIdAtProposal === undefined) {
    return "the proposal has no issue snapshot; propose it again";
  }
  if (issue.status !== payload.issueStatusAtProposal) {
    return `the issue status changed after the proposal (${payload.issueStatusAtProposal} → ${issue.status}); propose it again`;
  }
  if ((issue.assigneeAgentId ?? null) !== payload.assigneeAgentIdAtProposal) {
    return "the issue assignee changed after the proposal; propose it again";
  }
  return null;
}

/** Status changes that `PATCH /issues/:id` would refuse or handle with
 * route-only steps. A voice proposal does not attempt them; the operator does
 * it in the UI. */
async function statusChangeRefusal(
  deps: VoiceActionDeps,
  issue: ResolvedIssue,
  status: NonNullable<VoiceActionApprovalPayload["status"]>,
): Promise<string | null> {
  const { issuesSvc, heartbeat, runnerGoals, recoveryActions } = deps;
  const stateRefusal = issueStateRefusal(issue, status);
  if (stateRefusal) return stateRefusal;
  if (status === "blocked" && issue.status !== "blocked") {
    const readiness = await issuesSvc.getDependencyReadiness(issue.id);
    if (readiness.unresolvedBlockerCount === 0) {
      return "blocked requires an unresolved blocker; set it in Paperclip with a blocker or unblock owner";
    }
  }
  // PATCH resolves or cancels an active recovery action on a status change.
  if (await recoveryActions.getActiveForIssue(issue.companyId, issue.id)) {
    return `the issue has an active recovery action; set ${status} in Paperclip`;
  }
  if ((status === "done" || status === "cancelled") && issue.status !== status) {
    // PATCH stops the assignee's goal and cancels the run first. A voice
    // action does not.
    if (issue.assigneeAgentId) {
      const goal = await runnerGoals.projection(issue.companyId, issue.id, issue.assigneeAgentId);
      if (goal?.pendingAction || (goal?.goal && goal.goal.status !== "complete")) {
        return `the assignee has an active goal on the issue; set ${status} in Paperclip`;
      }
    }
    if (await activeIssueRun(heartbeat, issue)) {
      return `an agent run is active on the issue; set ${status} in Paperclip`;
    }
  }
  return null;
}

/** The refusals that read only the issue row. They run again on the locked
 * row right before the write. */
function issueStateRefusal(
  issue: Pick<
    ResolvedIssue,
    "conversationAgentId" | "executionPolicy" | "executionState" | "status" | "harnessKind" | "parentId"
  >,
  status: NonNullable<VoiceActionApprovalPayload["status"]>,
): string | null {
  if (issue.conversationAgentId) return "conversation issues cannot change by voice";
  if (issue.executionPolicy || issue.executionState) {
    return `the issue has an execution policy; set ${status} in Paperclip`;
  }
  if (issue.status === "in_review") return `the issue is in review; set ${status} in Paperclip`;
  if (issue.harnessKind === "skill_test") return `skill test issues complete their test run; set ${status} in Paperclip`;
  // PATCH may post a stop report to the parent for these.
  if (issue.parentId && issue.status !== status && (status === "blocked" || status === "cancelled")) {
    return `the parent issue may get a stop report; set ${status} in Paperclip`;
  }
  return null;
}

/** The running run on the issue: its execution run, or the assignee's active
 * run whose context names this issue. */
async function activeIssueRun(
  heartbeat: VoiceActionDeps["heartbeat"],
  issue: { id: string; assigneeAgentId: string | null; executionRunId?: string | null },
) {
  const executionRun = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;
  if (executionRun?.status === "running") return executionRun;
  if (!issue.assigneeAgentId) return null;
  const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
  const context = activeRun?.contextSnapshot as Record<string, unknown> | null | undefined;
  return activeRun?.status === "running" && context?.issueId === issue.id ? activeRun : null;
}

/** Comments that `POST /issues/:id/comments` would turn into more than a
 * comment. A voice proposal does not attempt them. */
async function commentRefusal(deps: VoiceActionDeps, issue: ResolvedIssue, actor: VoiceActor, body: string) {
  const { issuesSvc, treeControl, executionWorkspaces, runnerGoals, recoveryActions } = deps;
  if (await treeControl.getActivePauseHoldGate(issue.companyId, issue.id)) {
    return "Task is paused. Resume it before sending a message";
  }
  // The comment route re-evaluates an active recovery action after the comment.
  if (await recoveryActions.getActiveForIssue(issue.companyId, issue.id)) {
    return "the issue has an active recovery action; comment in Paperclip";
  }
  if (issue.executionWorkspaceId) {
    const workspace = await executionWorkspaces.getById(issue.executionWorkspaceId);
    if (workspace && isClosedIsolatedExecutionWorkspace(workspace)) {
      return "a comment would reopen the issue's closed workspace; comment in Paperclip";
    }
  }
  if (issue.status === "in_review" && isApprovalReviewComment(body)) {
    return "the comment reads as a review approval; approve the review in Paperclip";
  }
  const movesToTodo = shouldImplicitlyMoveCommentedIssueToTodo({
    issueStatus: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRunId: null,
    checkoutRunId: issue.checkoutRunId,
    executionRunId: issue.executionRunId,
  });
  // A blocked issue with an open blocker stays blocked in the comment route.
  if (
    movesToTodo &&
    (issue.status !== "blocked" || (await issuesSvc.getDependencyReadiness(issue.id)).unresolvedBlockerCount === 0)
  ) {
    return `a comment would reopen the ${issue.status} issue; reopen it in Paperclip`;
  }
  // The comment route steers a goal that is working now into its live turn.
  if (issue.assigneeAgentId) {
    const goal = await runnerGoals.projection(issue.companyId, issue.id, issue.assigneeAgentId);
    if (goal?.goal?.status === "active" && goal.workingNow) {
      return "the comment would steer the assignee's live goal session; comment in Paperclip";
    }
  }
  // The comment route resumes a scheduled retry of the assignee.
  if (issue.status === "in_progress" && issue.assigneeAgentId) {
    const retry = await issuesSvc.getCurrentScheduledRetry(issue.id);
    if (retry && retry.agentId === issue.assigneeAgentId) {
      return "a comment would resume the scheduled retry; comment in Paperclip";
    }
  }
  return null;
}

/** Collects wakes and enqueues one per agent and issue. The comment route
 * keeps the first wake for a key; PATCH keeps the last one. */
function createWakeBatch(
  deps: VoiceActionDeps,
  issue: { id: string; companyId: string },
  actor: VoiceActor,
  merge: "first_wins" | "last_wins",
) {
  const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
  const add = (agentId: string, wakeup: WakeupRequest) => {
    const wakeIssueId =
      wakeup.payload && typeof wakeup.payload.issueId === "string" ? wakeup.payload.issueId : issue.id;
    const key = `${agentId}:${wakeIssueId}`;
    if (merge === "last_wins" || !wakeups.has(key)) wakeups.set(key, { agentId, wakeup });
  };
  const addDependencyResolved = async (dependent: {
    id: string;
    assigneeAgentId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: Date | string | null;
  }) => {
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: dependent.id,
      blockerIssueIds: dependent.blockerIssueIds,
      blockedTransitionAt: dependent.blockedTransitionAt,
    });
    try {
      const existingWake = await findExistingIssueBlockersResolvedWakeForReadyState(deps.db, {
        companyId: issue.companyId,
        dependentIssueId: dependent.id,
        blockerIssueIds: dependent.blockerIssueIds,
        blockedTransitionAt: dependent.blockedTransitionAt,
      });
      if (existingWake) return;
    } catch (err) {
      logger.warn({ err, issueId: dependent.id, idempotencyKey }, "voice_action: failed to check existing dependency wake");
    }
    add(dependent.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
      payload: {
        issueId: dependent.id,
        resolvedBlockerIssueId: issue.id,
        blockerIssueIds: dependent.blockerIssueIds,
        mutation: "blocker_done",
      },
      idempotencyKey,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
      contextSnapshot: {
        issueId: dependent.id,
        taskId: dependent.id,
        wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        source: "issue.blockers_resolved",
        resolvedBlockerIssueId: issue.id,
        blockerIssueIds: dependent.blockerIssueIds,
      },
    });
  };
  const dispatch = async () => {
    for (const { agentId, wakeup } of wakeups.values()) {
      try {
        const wakeRun = await deps.heartbeat.wakeup(agentId, wakeup);
        if (wakeup.reason !== ISSUE_BLOCKERS_RESOLVED_WAKE_REASON) continue;
        // The rewake throttle reads this entry as new input for the dependent.
        const payload = wakeup.payload ?? {};
        await deps.logActivity(deps.db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "issue_update",
          agentId,
          action: "issue.blockers_resolved_wake_emitted",
          entityType: "issue",
          entityId: typeof payload.issueId === "string" ? payload.issueId : issue.id,
          details: {
            source: wakeup.contextSnapshot?.source ?? "issue.update",
            wakeupRunId: wakeRun?.id ?? null,
            idempotencyKey: wakeup.idempotencyKey ?? null,
            resolvedBlockerIssueId:
              typeof payload.resolvedBlockerIssueId === "string" ? payload.resolvedBlockerIssueId : null,
            blockerIssueIds: Array.isArray(payload.blockerIssueIds) ? payload.blockerIssueIds : [],
          },
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, agentId }, "voice_action: failed to wake agent");
      }
    }
  };
  return { add, addDependencyResolved, dispatch };
}

/** After the comment: what `POST /issues/:id/comments` does for a plain board
 * comment. Returns the steps that failed. */
async function afterComment(
  deps: VoiceActionDeps,
  issue: ResolvedIssue,
  comment: Awaited<ReturnType<IssueService["addComment"]>>,
  actor: VoiceActor,
): Promise<string[]> {
  const { issuesSvc } = deps;
  const failedSteps: string[] = [];
  const attempt = async (step: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      logger.warn({ err, issueId: issue.id, step }, "voice_action comment side effect failed");
      failedSteps.push(step);
    }
  };
  await attempt("reference_sync", () => deps.issueReferences.syncComment(comment.id));
  await attempt("external_object_sync", () => deps.externalObjects.syncCommentSafely(comment.id));
  let lostReviewPathRef: string | null = null;
  await attempt("superseded_confirmations", async () => {
    const expired = await deps.interactions.expireRequestConfirmationsSupersededByComment(issue, comment, {
      agentId: null,
      userId: actor.actorId,
    });
    await logExpiredInteractions(deps, issue, expired, actor, "issue.comment");
    if (issue.status !== "in_review" || expired.length === 0) return;
    const attention = (await issuesSvc.listReviewAttention(issue.companyId, [issue])).get(issue.id);
    if (attention?.state !== "stalled") return;
    const ids = expired.map((interaction) => interaction.id).sort();
    lostReviewPathRef = ids.length === 1 ? ids[0]! : `interactions:${ids.join(",")}`;
  });
  // A failed mention lookup must not drop the assignee wake.
  let mentionedIds: string[] = [];
  await attempt("mention_lookup", async () => {
    mentionedIds = await issuesSvc.findMentionedAgents(issue.companyId, comment.body);
  });
  await attempt("wakes", async () => {
    const batch = createWakeBatch(deps, issue, actor, "first_wins");
    // The assignee may have changed while the comment was written.
    const current = (await issuesSvc.getById(issue.id)) ?? issue;
    const assigneeId = current.assigneeAgentId;
    const wakeAssignee = shouldWakeAssigneeForIssueComment({
      selfComment: false,
      resumeRequested: false,
      commentCreatedByRunId: comment.createdByRunId,
      issueAtCommentStart: issue,
      reopened: false,
      currentStatus: current.status,
    });
    if (assigneeId && wakeAssignee) {
      const reviewPath = lostReviewPathRef
        ? {
            reviewPathLost: true,
            reviewPathConsumedRef: lostReviewPathRef,
            reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
          }
        : {};
      batch.add(assigneeId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: issue.id, commentId: comment.id, mutation: "comment", ...reviewPath },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          commentId: comment.id,
          wakeCommentId: comment.id,
          source: "issue.comment",
          wakeReason: "issue_commented",
          ...reviewPath,
        },
      });
    }
    for (const mentionedId of mentionedIds) {
      batch.add(mentionedId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId: issue.id, commentId: comment.id },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          commentId: comment.id,
          wakeCommentId: comment.id,
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        },
      });
    }
    await batch.dispatch();
  });
  await attempt("task_watchdog", () =>
    deps.taskWatchdogs.reconcileForIssueAndAncestors(issue.companyId, issue.id, { runId: null }),
  );
  return failedSteps;
}

/** After the status write: what `PATCH /issues/:id` does for a board status
 * change that passed `statusChangeRefusal`. Returns the steps that failed. */
async function afterStatusChange(
  deps: VoiceActionDeps,
  existing: ResolvedIssue,
  updated: NonNullable<Awaited<ReturnType<IssueService["update"]>>>,
  actor: VoiceActor,
): Promise<string[]> {
  const { issuesSvc } = deps;
  const failedSteps: string[] = [];
  const attempt = async (step: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      logger.warn({ err, issueId: existing.id, step }, "voice_action status side effect failed");
      failedSteps.push(step);
    }
  };
  const issue = updated;
  if (existing.status === "in_progress" && issue.status !== "in_progress") {
    await attempt("run_handoff_resolution", () => resolveRunHandoff(deps, issue, actor));
  }
  if (existing.status !== "blocked" && issue.status === "blocked") {
    await attempt("unblock_owner_wake", () =>
      deliverAgentUnblockNotification({
        issue,
        wakeup: deps.heartbeat.wakeup,
        markNotified: (notifiedAt) => deps.markBlockedOwnerNotified(issue, notifiedAt),
      }),
    );
  }
  await attempt("routine_sync", () => deps.routines.syncRunStatusForIssue(issue.id));
  const batch = createWakeBatch(deps, issue, actor, "last_wins");
  const becameTerminal =
    !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
  await attempt("status_wakes", async () => {
    const wakesAssignee =
      (existing.status === "backlog" && issue.status !== "backlog") ||
      (["blocked", "done", "cancelled"].includes(existing.status) && issue.status === "todo");
    if (wakesAssignee && issue.assigneeAgentId) {
      batch.add(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: { issueId: issue.id, mutation: "update" },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: { issueId: issue.id, source: "issue.status_change" },
      });
    }
    if (existing.status !== "done" && issue.status === "done") {
      for (const dependent of await issuesSvc.listWakeableBlockedDependents(issue.id)) {
        await batch.addDependencyResolved(dependent);
      }
    }
  });
  if (becameTerminal) {
    await attempt("terminal_cleanup", async () => {
      const expired = await deps.interactions.expirePendingInteractionsForTerminalIssue(issue, {
        agentId: null,
        userId: actor.actorId,
      });
      await logExpiredInteractions(deps, issue, expired, actor, "issue.status_transition.issue_closed");
      await deps.environmentRuntime.destroyReusableSandboxLeases({
        companyId: issue.companyId,
        issueId: issue.id,
        executionWorkspaceId: issue.executionWorkspaceId ?? null,
        failureReason: `issue_terminal_${issue.status}`,
      });
    });
    if (issue.parentId) {
      const parentId = issue.parentId;
      await attempt("parent_wake", async () => {
        const parent = await issuesSvc.getWakeableParentAfterChildCompletion(parentId);
        if (!parent) return;
        batch.add(parent.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_children_completed",
          payload: {
            issueId: parent.id,
            completedChildIssueId: issue.id,
            childIssueIds: parent.childIssueIds,
            childIssueSummaries: parent.childIssueSummaries,
            childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: parent.id,
            taskId: parent.id,
            wakeReason: "issue_children_completed",
            source: "issue.children_completed",
            completedChildIssueId: issue.id,
            childIssueIds: parent.childIssueIds,
            childIssueSummaries: parent.childIssueSummaries,
            childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
          },
        });
      });
    }
  }
  await attempt("dispatch_wakes", () => batch.dispatch());
  await attempt("task_watchdog", () =>
    deps.taskWatchdogs.reconcileForIssueAndAncestors(issue.companyId, issue.id, { runId: null }),
  );
  return failedSteps;
}

/** PATCH marks a required successful-run handoff resolved when the issue
 * leaves in_progress. */
async function resolveRunHandoff(
  deps: VoiceActionDeps,
  issue: { id: string; companyId: string; identifier?: string | null; status: string },
  actor: VoiceActor,
) {
  const latest = await deps.db
    .select({ action: activityLog.action, runId: activityLog.runId, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        inArray(activityLog.action, [
          "issue.successful_run_handoff_required",
          "issue.successful_run_handoff_resolved",
          "issue.successful_run_handoff_escalated",
        ]),
      ),
    )
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (latest?.action !== "issue.successful_run_handoff_required") return;
  const details = (latest.details ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  await deps.logActivity(deps.db, {
    companyId: issue.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "issue.successful_run_handoff_resolved",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier ?? null,
      sourceRunId: text(details.sourceRunId) ?? text(details.source_run_id) ?? text(details.resumeFromRunId) ?? latest.runId,
      correctiveRunId: text(details.correctiveRunId) ?? text(details.corrective_run_id) ?? null,
      resolvedByStatus: issue.status,
    },
  });
}

/** The same activity entry the issue routes write for an expired interaction. */
async function logExpiredInteractions(
  deps: VoiceActionDeps,
  issue: { id: string; companyId: string; identifier?: string | null },
  interactions: Array<{ id: string; kind: string; status: string; result?: unknown }>,
  actor: VoiceActor,
  source: string,
) {
  for (const interaction of interactions) {
    await deps.logActivity(deps.db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "issue.thread_interaction_expired",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier ?? null,
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        source,
        result: interaction.result ?? null,
      },
    });
  }
}

type Outcome =
  | { ok: true; summary: string; details: Record<string, unknown> }
  | { ok: false; reason: string };

const SIDE_EFFECTS_FAILED = "sivuvaikutukset epäonnistuivat, ks. palvelinloki";

/** Executes an approved `voice_action`. Never throws: the outcome lands as an
 * approval comment and an activity entry, and the approval stays approved. */
export async function executeVoiceAction(
  deps: VoiceActionDeps,
  approval: { id: string; companyId: string; payload: unknown },
  decidedByUserId: string,
): Promise<void> {
  const { db, issuesSvc, approvalSvc, logActivity } = deps;
  const actor: VoiceActor = { actorType: "user", actorId: decidedByUserId };
  let outcome: Outcome;
  let issueActivity: Parameters<typeof logActivityFn>[1] | null = null;
  try {
    const resolved = await resolveVoiceAction(issuesSvc, approval.companyId, approval.payload);
    const refusal = !resolved.ok
      ? resolved.reason
      : resolved.issue.conversationAgentId
        ? // Only the conversation owner may post into an agent chat transcript.
          "conversation issues cannot change by voice"
        : stalenessRefusal(resolved.payload, resolved.issue) ??
          (resolved.payload.action === "issue_comment"
            ? await commentRefusal(deps, resolved.issue, actor, resolved.payload.body!)
            : await statusChangeRefusal(deps, resolved.issue, resolved.payload.status!));
    if (refusal || !resolved.ok) {
      outcome = { ok: false, reason: refusal ?? ISSUE_NOT_IN_COMPANY };
    } else if (resolved.payload.action === "issue_comment") {
      const { payload, issue } = resolved;
      const comment = await issuesSvc.addComment(issue.id, payload.body!, { userId: decidedByUserId });
      // The comment is committed; a failed wake must not report it as not added.
      const failedSteps = await afterComment(deps, issue, comment, actor);
      issueActivity = {
        companyId: issue.companyId,
        actorType: "user",
        actorId: decidedByUserId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          source: "voice_action",
          approvalId: approval.id,
        },
      };
      outcome = {
        ok: true,
        summary:
          `kommentti lisätty tikettiin ${issue.identifier}` + (failedSteps.length ? ` (${SIDE_EFFECTS_FAILED})` : ""),
        details: { action: payload.action, issueId: issue.id, commentId: comment.id, failedSteps },
      };
    } else {
      const { payload, issue } = resolved;
      const status = payload.status!;
      // The checks above read the issue before several lookups. Like PATCH,
      // the write re-reads the row under a lock and repeats the row checks.
      const publications: ActivityPublication[] = [];
      const postCommitActions: IssuePostCommitAction[] = [];
      const write = await db.transaction(async (tx) => {
        const locked = await issuesSvc.getByIdForUpdate(issue.id, tx);
        if (!locked || locked.companyId !== approval.companyId) return { refusal: ISSUE_NOT_IN_COMPANY };
        const lockedRefusal = stalenessRefusal(payload, locked) ?? issueStateRefusal(locked, status);
        if (lockedRefusal) return { refusal: lockedRefusal };
        const row = await issuesSvc.update(
          issue.id,
          { status, actorUserId: decidedByUserId, companyGuard: approval.companyId },
          tx,
          publications,
          postCommitActions,
        );
        return row ? { updated: row } : { refusal: ISSUE_NOT_IN_COMPANY };
      });
      const updated = "updated" in write ? write.updated : null;
      if (!updated) {
        outcome = { ok: false, reason: ("refusal" in write && write.refusal) || ISSUE_NOT_IN_COMPANY };
      } else {
        for (const publication of publications) publishActivity(publication);
        const failedSteps: string[] = [];
        try {
          await executeIssuePostCommitActions(db, postCommitActions);
        } catch (err) {
          logger.warn({ err, issueId: issue.id }, "voice_action post-commit actions failed");
          failedSteps.push("post_commit_actions");
        }
        failedSteps.push(...(await afterStatusChange(deps, issue, updated, actor)));
        issueActivity = {
          companyId: issue.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            status: updated.status,
            identifier: issue.identifier,
            _previous: { status: issue.status },
            source: "voice_action",
            approvalId: approval.id,
          },
        };
        outcome = {
          ok: true,
          summary:
            `tiketin ${issue.identifier} tila: ${issue.status} → ${updated.status}` +
            (failedSteps.length ? ` (${SIDE_EFFECTS_FAILED})` : ""),
          details: {
            action: payload.action,
            issueId: issue.id,
            status: updated.status,
            previousStatus: issue.status,
            failedSteps,
          },
        };
      }
    }
  } catch (err) {
    logger.error({ err, approvalId: approval.id }, "approved voice_action threw");
    // A 4xx from the issue service is a rule the operator can act on; anything
    // else may carry internal detail, so it stays in the server log.
    outcome = {
      ok: false,
      reason:
        err instanceof HttpError && err.status < 500
          ? err.message
          : "unexpected error while applying the action (see server log)",
    };
  }

  // The issue write is done or refused at this point; recording it must not
  // change the reported outcome, and one failed record must not skip the rest.
  if (issueActivity) {
    try {
      await logActivity(db, issueActivity);
    } catch (err) {
      logger.error({ err, approvalId: approval.id }, "failed to log voice_action issue activity");
    }
  }
  try {
    await approvalSvc.addComment(
      approval.id,
      outcome.ok
        ? `✅ Toteutettu: ${outcome.summary}.`
        : `⚠️ Hyväksytty, mutta toimea ei toteutettu: ${outcome.reason}.`,
      { userId: decidedByUserId },
    );
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: outcome.ok ? "voice_action.executed" : "voice_action.failed",
      entityType: "approval",
      entityId: approval.id,
      details: outcome.ok ? outcome.details : { reason: outcome.reason },
    });
  } catch (err) {
    logger.error({ err, approvalId: approval.id }, "failed to record voice_action outcome");
  }
}
// --- end RK9 Custom ---
