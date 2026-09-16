import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachSequences } from "@paperclipai/db";
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

export async function createSequence(db: Db, companyId: string, input: CreateOutreachSequence) {
  const [row] = await db
    .insert(outreachSequences)
    .values({ companyId, ...input, activatedAt: input.active ? new Date() : null })
    .onConflictDoNothing({ target: [outreachSequences.companyId, outreachSequences.name] })
    .returning();
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
  return row ?? null;
}

export async function deleteSequence(db: Db, companyId: string, id: string) {
  const deleted = await db
    .delete(outreachSequences)
    .where(and(eq(outreachSequences.companyId, companyId), eq(outreachSequences.id, id)))
    .returning({ id: outreachSequences.id });
  return deleted.length > 0;
}
