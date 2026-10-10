// --- RK9 Custom (RK9-479): `voice_action` approvals. A voice assistant (Grok)
// proposes an internal issue action; the board approves it and the server
// executes the stored payload through the issue service in the approver's name.
// The payload is checked on create and resubmit, and again on approve, because
// the issue can move or disappear between the proposal and the decision. ---
import type { Db } from "@paperclipai/db";
import { voiceActionApprovalPayloadSchema, type VoiceActionApprovalPayload } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/index.js";
import type { issueService } from "../services/issues.js";

type IssueService = ReturnType<typeof issueService>;

type ResolvedVoiceAction =
  | { ok: true; payload: VoiceActionApprovalPayload; issue: { id: string; companyId: string; identifier: string | null; title: string; status: string } }
  | { ok: false; reason: string };

/** One message for "missing" and "other company" so a proposal cannot probe
 * for issues outside its own company. */
const ISSUE_NOT_IN_COMPANY = "issue not found in this company";

export async function resolveVoiceAction(
  issuesSvc: IssueService,
  companyId: string,
  rawPayload: unknown,
): Promise<ResolvedVoiceAction> {
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

/** Executes an approved `voice_action`. Never throws: the outcome lands as an
 * approval comment and an activity entry, and the approval stays approved. */
export async function executeVoiceAction(
  db: Db,
  issuesSvc: IssueService,
  approvalSvc: { addComment: (approvalId: string, body: string, actor: { userId?: string }) => Promise<unknown> },
  approval: { id: string; companyId: string; payload: unknown },
  decidedByUserId: string,
): Promise<void> {
  let outcome: { ok: true; summary: string; details: Record<string, unknown> } | { ok: false; reason: string };
  try {
    const resolved = await resolveVoiceAction(issuesSvc, approval.companyId, approval.payload);
    if (!resolved.ok) {
      outcome = resolved;
    } else {
      const { payload, issue } = resolved;
      if (payload.action === "issue_comment") {
        const comment = await issuesSvc.addComment(issue.id, payload.body!, { userId: decidedByUserId });
        await logActivity(db, {
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
        });
        outcome = {
          ok: true,
          summary: `kommentti lisätty tikettiin ${issue.identifier}`,
          details: { action: payload.action, issueId: issue.id, commentId: comment.id },
        };
      } else {
        const updated = await issuesSvc.update(issue.id, {
          status: payload.status!,
          actorUserId: decidedByUserId,
          companyGuard: approval.companyId,
        });
        if (!updated) {
          outcome = { ok: false, reason: ISSUE_NOT_IN_COMPANY };
        } else {
          await logActivity(db, {
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
          });
          outcome = {
            ok: true,
            summary: `tiketin ${issue.identifier} tila: ${issue.status} → ${updated.status}`,
            details: { action: payload.action, issueId: issue.id, status: updated.status, previousStatus: issue.status },
          };
        }
      }
    }
  } catch (err) {
    logger.error({ err, approvalId: approval.id }, "approved voice_action threw");
    outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
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
