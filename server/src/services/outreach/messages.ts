import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachMessages } from "@paperclipai/db";
import type {
  CreateOutreachMessage,
  OutreachMessageStatus,
  OutreachProspectStatus,
  UpdateOutreachMessage,
} from "@paperclipai/shared";
import { canApproveMessage, canTransitionMessage } from "./logic.js";
import { getProspect } from "./prospects.js";
import { getSequence } from "./sequences.js";
import { findOutreachSuppressed } from "./suppressions.js";
import { PROSPECT_TERMINAL_STATUSES } from "./logic.js";

export async function listMessages(
  db: Db,
  companyId: string,
  opts: { status?: OutreachMessageStatus; prospectId?: string; limit?: number } = {},
) {
  const conditions = [eq(outreachMessages.companyId, companyId)];
  if (opts.status) conditions.push(eq(outreachMessages.status, opts.status));
  if (opts.prospectId) conditions.push(eq(outreachMessages.prospectId, opts.prospectId));
  return db
    .select()
    .from(outreachMessages)
    .where(and(...conditions))
    .orderBy(desc(outreachMessages.createdAt))
    .limit(Math.max(1, Math.min(1000, opts.limit ?? 200)));
}

export async function getMessage(db: Db, companyId: string, id: string) {
  const [row] = await db
    .select()
    .from(outreachMessages)
    .where(and(eq(outreachMessages.companyId, companyId), eq(outreachMessages.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Company-agnostic lookup for the scheduler and the sender/report machine
 * routes, which only have a message id (the daemon doesn't know companyId).
 * Never expose this behind a company-scoped or agent-scoped route.
 */
export async function getMessageById(db: Db, id: string) {
  const [row] = await db.select().from(outreachMessages).where(eq(outreachMessages.id, id)).limit(1);
  return row ?? null;
}

/**
 * RK9-194: the public `/u/:token` unsubscribe route's only lookup — a token
 * is unguessable (24 random bytes) so no further scoping is needed.
 */
export async function getMessageByUnsubscribeToken(db: Db, token: string) {
  const [row] = await db
    .select()
    .from(outreachMessages)
    .where(eq(outreachMessages.unsubscribeToken, token))
    .limit(1);
  return row ?? null;
}

export type CreateMessageResult =
  | { ok: true; message: typeof outreachMessages.$inferSelect }
  | { ok: false; reason: "prospect_not_found" | "sequence_not_found" | "prospect_not_contactable" };

/** Create a draft. The prospect and (optional) sequence must belong to the same company. */
export async function createDraftMessage(
  db: Db,
  companyId: string,
  input: CreateOutreachMessage,
): Promise<CreateMessageResult> {
  const prospect = await getProspect(db, companyId, input.prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  if (
    PROSPECT_TERMINAL_STATUSES.has(prospect.status as OutreachProspectStatus) ||
    (prospect.email && (await findOutreachSuppressed(db, [prospect.email])).size > 0)
  ) {
    return { ok: false, reason: "prospect_not_contactable" };
  }
  if (input.sequenceId) {
    const sequence = await getSequence(db, companyId, input.sequenceId);
    if (!sequence) return { ok: false, reason: "sequence_not_found" };
  }
  const [message] = await db
    .insert(outreachMessages)
    .values({
      companyId,
      prospectId: input.prospectId,
      sequenceId: input.sequenceId ?? null,
      step: input.step,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      inReplyTo: input.inReplyTo ?? null,
      status: "draft",
    })
    .returning();
  return { ok: true, message };
}

export type UpdateDraftResult =
  | { ok: true; message: typeof outreachMessages.$inferSelect }
  | { ok: false; reason: "not_found" | "not_a_draft" };

/**
 * Review-tool "edit" action (RK9-196): rewrite a still-`draft` message before
 * approving/rejecting it. Re-checks `status = 'draft'` in the WHERE so an
 * edit racing an approve/reject cannot resurrect a decided message.
 */
export async function updateDraftMessage(
  db: Db,
  companyId: string,
  id: string,
  patch: UpdateOutreachMessage,
): Promise<UpdateDraftResult> {
  const [updated] = await db
    .update(outreachMessages)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(outreachMessages.companyId, companyId), eq(outreachMessages.id, id), eq(outreachMessages.status, "draft")))
    .returning();
  if (updated) return { ok: true, message: updated };
  const existing = await getMessage(db, companyId, id);
  return { ok: false, reason: existing ? "not_a_draft" : "not_found" };
}

export type ReviewResult =
  | { ok: true; message: typeof outreachMessages.$inferSelect }
  | {
      ok: false;
      reason: "not_found" | "invalid_transition" | "prospect_not_contactable";
      status?: OutreachMessageStatus;
    };

export async function approveMessage(
  db: Db,
  companyId: string,
  id: string,
  actorId: string,
): Promise<ReviewResult> {
  const message = await getMessage(db, companyId, id);
  if (!message) return { ok: false, reason: "not_found" };
  const prospect = await getProspect(db, companyId, message.prospectId);
  const verdict = canApproveMessage(
    message.status as OutreachMessageStatus,
    (prospect?.status ?? "suppressed") as OutreachProspectStatus,
  );
  if (!verdict.ok) return { ok: false, reason: verdict.reason, status: message.status as OutreachMessageStatus };
  // The global suppression list is the last word, whatever the prospect status says.
  if (prospect?.email && (await findOutreachSuppressed(db, [prospect.email])).size > 0) {
    return { ok: false, reason: "prospect_not_contactable", status: message.status as OutreachMessageStatus };
  }
  const now = new Date();
  const [updated] = await db
    .update(outreachMessages)
    .set({ status: "approved", approvedBy: actorId, approvedAt: now, rejectReason: null, updatedAt: now })
    // Re-check status in the WHERE so two concurrent reviewers cannot both win.
    .where(
      and(
        eq(outreachMessages.companyId, companyId),
        eq(outreachMessages.id, id),
        eq(outreachMessages.status, message.status),
      ),
    )
    .returning();
  if (!updated) return { ok: false, reason: "invalid_transition" };
  return { ok: true, message: updated };
}

export async function rejectMessage(
  db: Db,
  companyId: string,
  id: string,
  actorId: string,
  reason: string,
): Promise<ReviewResult> {
  const message = await getMessage(db, companyId, id);
  if (!message) return { ok: false, reason: "not_found" };
  if (!canTransitionMessage(message.status as OutreachMessageStatus, "rejected")) {
    return { ok: false, reason: "invalid_transition", status: message.status as OutreachMessageStatus };
  }
  const now = new Date();
  const [updated] = await db
    .update(outreachMessages)
    .set({ status: "rejected", rejectedBy: actorId, rejectedAt: now, rejectReason: reason, updatedAt: now })
    .where(
      and(
        eq(outreachMessages.companyId, companyId),
        eq(outreachMessages.id, id),
        eq(outreachMessages.status, message.status),
      ),
    )
    .returning();
  if (!updated) return { ok: false, reason: "invalid_transition" };
  return { ok: true, message: updated };
}
