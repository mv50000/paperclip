import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

// RK9-479: voice-proposed issue action. The server executes it on approve, so
// the payload is validated on create, resubmit and again on approve. Unknown
// keys are stripped, not rejected: the Slack forwarder stores
// `slackMessageRef` in the payload after create.
export const VOICE_ACTION_KINDS = ["issue_comment", "issue_status"] as const;
export const VOICE_ACTION_STATUSES = ["todo", "backlog", "blocked", "done", "cancelled"] as const;
export const VOICE_ACTION_BODY_MAX_LENGTH = 1000;

export const voiceActionApprovalPayloadSchema = z
  .object({
    action: z.enum(VOICE_ACTION_KINDS),
    issueId: z.string().guid(),
    identifier: z.string().trim().min(1).max(64),
    body: z.string().trim().min(1).max(VOICE_ACTION_BODY_MAX_LENGTH).optional(),
    status: z.enum(VOICE_ACTION_STATUSES).optional(),
    source: z.literal("grok"),
  })
  .superRefine((value, ctx) => {
    if (value.action === "issue_comment" && value.body === undefined) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "issue_comment requires body" });
    }
    if (value.action === "issue_status" && value.status === undefined) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "issue_status requires status" });
    }
  });

export type VoiceActionApprovalPayload = z.infer<typeof voiceActionApprovalPayloadSchema>;
