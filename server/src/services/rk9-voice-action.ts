// --- RK9 Custom (RK9-479): `voice_action` approvals. A voice assistant (Grok)
// proposes an internal issue action; the board approves it and the server
// executes the stored payload through the issue service in the approver's name.
// The payload is checked on create and resubmit, and again on approve, because
// the issue can move or disappear between the proposal and the decision.
//
// Only the HTTP approve route (web UI, Telegram listener) executes it. The Slack
// card and the plugin chat bridge refuse to approve a voice_action, because
// they do not show the operator the exact text that would be applied. ---
import type { Db } from "@paperclipai/db";
import { voiceActionApprovalPayloadSchema, type VoiceActionApprovalPayload } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { logActivity as logActivityFn } from "./activity-log.js";
import type { issueService } from "./issues.js";

type IssueService = ReturnType<typeof issueService>;
type ResolvedIssue = NonNullable<Awaited<ReturnType<IssueService["getById"]>>>;

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
  const issue = await issuesSvc.getById(payload.issueId);
  // The identifier is what the approval card shows the operator, so it must
  // name the same issue the action targets.
  if (!issue || issue.companyId !== companyId || issue.identifier !== payload.identifier) {
    return { ok: false, reason: ISSUE_NOT_IN_COMPANY };
  }
  return { ok: true, payload, issue };
}

/** Status changes that `PATCH /issues/:id` would refuse or handle with extra
 * route-only steps (execution-policy stages, outcome gates, run cancellation).
 * A voice proposal does not attempt them; the operator does it in the UI. */
async function statusChangeRefusal(
  issuesSvc: Pick<IssueService, "getDependencyReadiness">,
  issue: ResolvedIssue,
  status: NonNullable<VoiceActionApprovalPayload["status"]>,
): Promise<string | null> {
  if (issue.conversationAgentId) return "conversation issues cannot change status by voice";
  if (status === "blocked" && issue.status !== "blocked") {
    const readiness = await issuesSvc.getDependencyReadiness(issue.id);
    if (readiness.unresolvedBlockerCount === 0) {
      return "blocked requires an unresolved blocker; set it in Paperclip with a blocker or unblock owner";
    }
  }
  if (status === "done" || status === "cancelled") {
    if (issue.executionPolicy || issue.executionState) {
      return `the issue has an execution policy; set ${status} in Paperclip`;
    }
    if (issue.executionRunId || issue.checkoutRunId) {
      return `an agent run holds the issue; set ${status} in Paperclip`;
    }
  }
  return null;
}

type Outcome =
  | { ok: true; summary: string; details: Record<string, unknown> }
  | { ok: false; reason: string };

/** Executes an approved `voice_action`. Never throws: the outcome lands as an
 * approval comment and an activity entry, and the approval stays approved. */
export async function executeVoiceAction(
  db: Db,
  deps: {
    issuesSvc: Pick<IssueService, "getById" | "addComment" | "update" | "getDependencyReadiness">;
    approvalSvc: { addComment: (approvalId: string, body: string, actor: { userId?: string }) => Promise<unknown> };
    logActivity: typeof logActivityFn;
  },
  approval: { id: string; companyId: string; payload: unknown },
  decidedByUserId: string,
): Promise<void> {
  const { issuesSvc, approvalSvc, logActivity } = deps;
  let outcome: Outcome;
  let issueActivity: Parameters<typeof logActivityFn>[1] | null = null;
  try {
    const resolved = await resolveVoiceAction(issuesSvc, approval.companyId, approval.payload);
    if (!resolved.ok) {
      outcome = resolved;
    } else if (resolved.payload.action === "issue_comment") {
      const { payload, issue } = resolved;
      const comment = await issuesSvc.addComment(issue.id, payload.body!, { userId: decidedByUserId });
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
        summary: `kommentti lisätty tikettiin ${issue.identifier}`,
        details: { action: payload.action, issueId: issue.id, commentId: comment.id },
      };
    } else {
      const { payload, issue } = resolved;
      const status = payload.status!;
      const refusal = await statusChangeRefusal(issuesSvc, issue, status);
      const updated = refusal
        ? null
        : await issuesSvc.update(issue.id, {
            status,
            actorUserId: decidedByUserId,
            companyGuard: approval.companyId,
          });
      if (refusal || !updated) {
        outcome = { ok: false, reason: refusal ?? ISSUE_NOT_IN_COMPANY };
      } else {
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
          summary: `tiketin ${issue.identifier} tila: ${issue.status} → ${updated.status}`,
          details: { action: payload.action, issueId: issue.id, status: updated.status, previousStatus: issue.status },
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
  // change the reported outcome.
  try {
    if (issueActivity) await logActivity(db, issueActivity);
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
