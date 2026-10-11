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
// RK9-490: the action has the same side effects as the same action in the UI.
// The issue routes own that logic and hand it over as `VoiceActionIssueEffects`;
// this module only orders the calls. ---
import type { Db } from "@paperclipai/db";
import { voiceActionApprovalPayloadSchema, type VoiceActionApprovalPayload } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactEventPayload } from "../redaction.js";
import type { logActivity as logActivityFn } from "./activity-log.js";
import type { getActorInfo } from "../routes/authz.js";
import type { issueService } from "./issues.js";

type IssueService = ReturnType<typeof issueService>;
type ResolvedIssue = NonNullable<Awaited<ReturnType<IssueService["getById"]>>>;
type UpdatedIssue = NonNullable<Awaited<ReturnType<IssueService["update"]>>>;
type IssueComment = Awaited<ReturnType<IssueService["addComment"]>>;
export type VoiceActionActor = ReturnType<typeof getActorInfo>;

/** Side effects of `PATCH /issues/:id` and `POST /issues/:id/comments`. The
 * issue routes implement them with the same functions the routes call. */
export type VoiceActionIssueEffects = {
  /** Refusal text when a board comment may not enter the issue (paused tree). */
  commentPauseRefusal(issue: ResolvedIssue): Promise<string | null>;
  /** Reference sync, goal steering, superseded confirmations, assignee and
   * @-mention wakes. */
  afterComment(input: { issue: ResolvedIssue; comment: IssueComment; actor: VoiceActionActor }): Promise<void>;
  /** Before the status write: stops the assignee's runner goal (and its run)
   * for done/cancelled and finds the run that cancelled must stop. Throws a
   * 409 when the goal cannot be stopped. */
  beforeStatusChange(
    issue: ResolvedIssue,
    status: NonNullable<VoiceActionApprovalPayload["status"]>,
  ): Promise<{ interruptedRunId: string | null; runToCancel: { id: string } | null }>;
  /** After the status write: unblock-owner wake, run cancellation, routine
   * sync, status/dependent/parent wakes and terminal clean-up. */
  afterStatusChange(input: {
    existing: ResolvedIssue;
    updated: UpdatedIssue;
    actor: VoiceActionActor;
    interruptedRunId: string | null;
    runToCancel: { id: string } | null;
  }): Promise<{ cancelledStatusRunId: string | null }>;
};

/** Filled by `issueRoutes`, read by the approve route at approval time. */
export type VoiceActionIssueEffectsSlot = { current: VoiceActionIssueEffects | null };

export function createVoiceActionIssueEffectsSlot(): VoiceActionIssueEffectsSlot {
  return { current: null };
}

export const VOICE_ACTION_APPROVAL_TYPE = "voice_action";

/** Shown by approval surfaces that cannot display the payload. */
export const VOICE_ACTION_APPROVE_ELSEWHERE =
  "Grok-ehdotus hyväksytään Paperclipissa tai Telegramissa, jossa näkyy tarkka teksti.";

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
function stalenessRefusal(payload: VoiceActionApprovalPayload, issue: ResolvedIssue): string | null {
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

/** Status changes that `PATCH /issues/:id` would refuse or handle with extra
 * route-only steps (execution-policy stages, review verdict rules, outcome
 * gates). A voice proposal does not attempt them; the operator does it in the
 * UI. A run that holds the issue is stopped as the route does it (RK9-490). */
async function statusChangeRefusal(
  issuesSvc: Pick<IssueService, "getDependencyReadiness">,
  issue: ResolvedIssue,
  status: NonNullable<VoiceActionApprovalPayload["status"]>,
): Promise<string | null> {
  if (issue.conversationAgentId) return "conversation issues cannot change by voice";
  if (issue.executionPolicy || issue.executionState) {
    return `the issue has an execution policy; set ${status} in Paperclip`;
  }
  if (issue.status === "in_review") return `the issue is in review; set ${status} in Paperclip`;
  if (status === "blocked" && issue.status !== "blocked") {
    const readiness = await issuesSvc.getDependencyReadiness(issue.id);
    if (readiness.unresolvedBlockerCount === 0) {
      return "blocked requires an unresolved blocker; set it in Paperclip with a blocker or unblock owner";
    }
  }
  return null;
}

type Outcome =
  | { ok: true; summary: string; details: Record<string, unknown> }
  | { ok: false; reason: string };

const SIDE_EFFECTS_FAILED = "sivuvaikutukset epäonnistuivat, ks. palvelinloki";

/** Executes an approved `voice_action`. Never throws: the outcome lands as an
 * approval comment and an activity entry, and the approval stays approved. */
export async function executeVoiceAction(
  db: Db,
  deps: {
    issuesSvc: Pick<IssueService, "getById" | "addComment" | "update" | "getDependencyReadiness">;
    approvalSvc: { addComment: (approvalId: string, body: string, actor: { userId?: string }) => Promise<unknown> };
    logActivity: typeof logActivityFn;
    /** Null when the issue routes are not mounted; the action is then refused
     * rather than applied without the UI side effects. */
    issueEffects: VoiceActionIssueEffects | null;
  },
  approval: { id: string; companyId: string; payload: unknown },
  decidedByUserId: string,
  actor: VoiceActionActor,
): Promise<void> {
  const { issuesSvc, approvalSvc, logActivity, issueEffects } = deps;
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
          (issueEffects ? null : "issue side effects are not available on this server");
    if (refusal || !resolved.ok || !issueEffects) {
      outcome = { ok: false, reason: refusal ?? ISSUE_NOT_IN_COMPANY };
    } else if (resolved.payload.action === "issue_comment") {
      const { payload, issue } = resolved;
      const pauseRefusal = await issueEffects.commentPauseRefusal(issue);
      if (pauseRefusal) {
        outcome = { ok: false, reason: pauseRefusal };
      } else {
        const comment = await issuesSvc.addComment(issue.id, payload.body!, { userId: decidedByUserId });
        let sideEffectsFailed = false;
        try {
          await issueEffects.afterComment({ issue, comment, actor });
        } catch (err) {
          // The comment is committed; a failed wake must not report it as not added.
          logger.error({ err, approvalId: approval.id }, "voice_action comment side effects failed");
          sideEffectsFailed = true;
        }
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
            `kommentti lisätty tikettiin ${issue.identifier}` + (sideEffectsFailed ? ` (${SIDE_EFFECTS_FAILED})` : ""),
          details: { action: payload.action, issueId: issue.id, commentId: comment.id, sideEffectsFailed },
        };
      }
    } else {
      const { payload, issue } = resolved;
      const status = payload.status!;
      const statusRefusal = await statusChangeRefusal(issuesSvc, issue, status);
      if (statusRefusal) {
        outcome = { ok: false, reason: statusRefusal };
      } else {
        const { interruptedRunId, runToCancel } = await issueEffects.beforeStatusChange(issue, status);
        const updated = await issuesSvc.update(issue.id, {
          status,
          actorUserId: decidedByUserId,
          companyGuard: approval.companyId,
        });
        if (!updated) {
          outcome = { ok: false, reason: ISSUE_NOT_IN_COMPANY };
        } else {
          let cancelledStatusRunId: string | null = null;
          let sideEffectsFailed = false;
          try {
            ({ cancelledStatusRunId } = await issueEffects.afterStatusChange({
              existing: issue,
              updated,
              actor,
              interruptedRunId,
              runToCancel,
            }));
          } catch (err) {
            logger.error({ err, approvalId: approval.id }, "voice_action status side effects failed");
            sideEffectsFailed = true;
          }
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
              ...(interruptedRunId ? { interruptedRunId } : {}),
              ...(cancelledStatusRunId ? { cancelledStatusRunId } : {}),
              source: "voice_action",
              approvalId: approval.id,
            },
          };
          outcome = {
            ok: true,
            summary:
              `tiketin ${issue.identifier} tila: ${issue.status} → ${updated.status}` +
              (sideEffectsFailed ? ` (${SIDE_EFFECTS_FAILED})` : ""),
            details: {
              action: payload.action,
              issueId: issue.id,
              status: updated.status,
              previousStatus: issue.status,
              interruptedRunId,
              cancelledStatusRunId,
              sideEffectsFailed,
            },
          };
        }
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
