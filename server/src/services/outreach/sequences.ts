import { and, desc, eq } from "drizzle-orm";
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

export async function createSequence(db: Db, companyId: string, input: CreateOutreachSequence) {
  const [row] = await db
    .insert(outreachSequences)
    .values({ companyId, ...input })
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
  const [row] = await db
    .update(outreachSequences)
    .set({ ...patch, updatedAt: new Date() })
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
