import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailRoutes, outreachSequences } from "@paperclipai/db";
import type { CreateOutreachSequence, UpdateOutreachSequence } from "@paperclipai/shared";

export async function listSequences(db: Db, companyId: string) {
  return db
    .select()
    .from(outreachSequences)
    .where(eq(outreachSequences.companyId, companyId))
    .orderBy(desc(outreachSequences.createdAt));
}

export async function getSequence(db: Db, companyId: string, id: string) {
  const [row] = await db
    .select()
    .from(outreachSequences)
    .where(and(eq(outreachSequences.companyId, companyId), eq(outreachSequences.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * RK9-224: candidate sequences for an AI-drafted message that didn't name a
 * `sequenceId` — active sequences whose first step targets `templateId`
 * (the `company` template slug the draft call requested). Multiple active
 * sequences per company are allowed (unenforced, see scheduler.ts), so the
 * caller must still treat anything but exactly one candidate as ambiguous.
 */
export async function listActiveSequencesForTemplate(db: Db, companyId: string, templateId: string) {
  const rows = await db
    .select()
    .from(outreachSequences)
    .where(and(eq(outreachSequences.companyId, companyId), eq(outreachSequences.active, true)));
  return rows.filter((row) => {
    const steps = row.steps as Array<{ dayOffset: number; templateId: string }> | null;
    return Array.isArray(steps) && steps.length > 0 && steps[0].templateId === templateId;
  });
}

/**
 * Give a sender identity the inbound route its replies need. Migration 9010
 * seeded one route per identity that existed on 17.9.2026; an identity added
 * later (rk9@outreach.rk9.fi, 26.9.) had none, so its replies were stored but
 * never opened an issue or escalated, and an unthreadable reply to it could
 * not be tied to a company at all (`resolveCompanyByRecipient`). Same values
 * as 9010: NULL agent and NULL auto-reply template on purpose — a human
 * answers a prospect's reply. An existing route is left as the operator set it.
 */
async function ensureSenderReplyRoute(db: Db, companyId: string, senderIdentity: string) {
  const at = senderIdentity.lastIndexOf("@");
  if (at <= 0 || at === senderIdentity.length - 1) return;
  await db
    .insert(emailRoutes)
    .values({
      companyId,
      localPart: senderIdentity.slice(0, at).toLowerCase(),
      domain: senderIdentity.slice(at + 1).toLowerCase(),
      routeKey: "outreach",
      assignedAgentId: null,
      autoReplyTemplateId: null,
      escalateAfterHours: 24,
      approvalRequired: true,
    })
    .onConflictDoNothing({ target: [emailRoutes.companyId, emailRoutes.localPart, emailRoutes.domain] });
}

export async function createSequence(db: Db, companyId: string, input: CreateOutreachSequence) {
  const [row] = await db
    .insert(outreachSequences)
    .values({ companyId, ...input, activatedAt: input.active ? new Date() : null })
    .onConflictDoNothing({ target: [outreachSequences.companyId, outreachSequences.name] })
    .returning();
  if (row) await ensureSenderReplyRoute(db, companyId, row.senderIdentity);
  return row ?? null;
}

export async function updateSequence(
  db: Db,
  companyId: string,
  id: string,
  patch: UpdateOutreachSequence,
) {
  const setClause: Record<string, unknown> = { ...patch, updatedAt: new Date() };
  // RK9-194: the warm-up ramp counts days since activation, not since
  // creation. Restart it on every false→true transition (checked against the
  // row's own current value in this same statement, so it's race-free), but
  // leave it untouched while already active or already inactive.
  if (patch.active === true) {
    setClause.activatedAt = sql`CASE WHEN ${outreachSequences.active} = false THEN now() ELSE ${outreachSequences.activatedAt} END`;
  }
  const [row] = await db
    .update(outreachSequences)
    .set(setClause)
    .where(and(eq(outreachSequences.companyId, companyId), eq(outreachSequences.id, id)))
    .returning();
  if (row && patch.senderIdentity !== undefined) await ensureSenderReplyRoute(db, companyId, row.senderIdentity);
  return row ?? null;
}

export async function deleteSequence(db: Db, companyId: string, id: string) {
  const deleted = await db
    .delete(outreachSequences)
    .where(and(eq(outreachSequences.companyId, companyId), eq(outreachSequences.id, id)))
    .returning({ id: outreachSequences.id });
  return deleted.length > 0;
}
