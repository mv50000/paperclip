import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachProspects } from "@paperclipai/db";
import type {
  CreateOutreachProspect,
  OutreachProspectStatus,
  UpdateOutreachProspect,
} from "@paperclipai/shared";
import { classifyImport, type ImportRejection } from "./logic.js";
import { findOutreachSuppressed } from "./suppressions.js";

export async function listProspects(
  db: Db,
  companyId: string,
  opts: { status?: OutreachProspectStatus; limit?: number } = {},
) {
  const conditions = [eq(outreachProspects.companyId, companyId)];
  if (opts.status) conditions.push(eq(outreachProspects.status, opts.status));
  return db
    .select()
    .from(outreachProspects)
    .where(and(...conditions))
    .orderBy(desc(outreachProspects.createdAt))
    .limit(Math.max(1, Math.min(1000, opts.limit ?? 200)));
}

export async function getProspect(db: Db, companyId: string, id: string) {
  const [row] = await db
    .select()
    .from(outreachProspects)
    .where(and(eq(outreachProspects.companyId, companyId), eq(outreachProspects.id, id)))
    .limit(1);
  return row ?? null;
}

export interface ImportResult {
  imported: number;
  rejected: ImportRejection[];
  ids: string[];
}

/**
 * Bulk import. Rejects (and reports) rows that are on the global suppression
 * list, already exist for this company, or repeat within the batch. Accepted
 * rows are inserted in one statement; a concurrent insert of the same e-mail
 * is absorbed by ON CONFLICT DO NOTHING and reported as duplicate_existing.
 */
export async function importProspects(
  db: Db,
  companyId: string,
  rows: CreateOutreachProspect[],
): Promise<ImportResult> {
  const emails = rows.map((r) => r.email);
  const [suppressed, existingRows] = await Promise.all([
    findOutreachSuppressed(db, emails),
    db
      .select({ email: outreachProspects.email })
      .from(outreachProspects)
      .where(and(eq(outreachProspects.companyId, companyId), inArray(outreachProspects.email, emails))),
  ]);
  const { accepted, rejected } = classifyImport(
    rows,
    existingRows.map((r) => r.email),
    suppressed,
  );
  if (accepted.length === 0) return { imported: 0, rejected, ids: [] };

  const inserted = await db
    .insert(outreachProspects)
    .values(
      accepted.map(({ row }) => ({
        companyId,
        orgName: row.orgName,
        businessId: row.businessId ?? null,
        email: row.email,
        contactName: row.contactName ?? null,
        role: row.role ?? null,
        source: row.source,
        sourceUrl: row.sourceUrl ?? null,
        legalBasis: row.legalBasis,
        enrichment: row.enrichment ?? {},
      })),
    )
    .onConflictDoNothing({ target: [outreachProspects.companyId, outreachProspects.email] })
    .returning({ id: outreachProspects.id, email: outreachProspects.email });

  const insertedEmails = new Set(inserted.map((r) => r.email));
  const raced = accepted
    .filter(({ row }) => !insertedEmails.has(row.email))
    .map(({ index, row }) => ({ index, email: row.email, reason: "duplicate_existing" as const }));

  return {
    imported: inserted.length,
    rejected: [...rejected, ...raced].sort((a, b) => a.index - b.index),
    ids: inserted.map((r) => r.id),
  };
}

export async function createProspect(db: Db, companyId: string, input: CreateOutreachProspect) {
  const result = await importProspects(db, companyId, [input]);
  if (result.imported === 1) return { ok: true as const, prospect: await getProspect(db, companyId, result.ids[0]) };
  return { ok: false as const, reason: result.rejected[0]?.reason ?? "duplicate_existing" };
}

export async function updateProspect(
  db: Db,
  companyId: string,
  id: string,
  patch: UpdateOutreachProspect,
) {
  const [row] = await db
    .update(outreachProspects)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(outreachProspects.companyId, companyId), eq(outreachProspects.id, id)))
    .returning();
  return row ?? null;
}

export async function setProspectStatus(
  db: Db,
  companyId: string,
  id: string,
  status: OutreachProspectStatus,
) {
  const [row] = await db
    .update(outreachProspects)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(outreachProspects.companyId, companyId), eq(outreachProspects.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteProspect(db: Db, companyId: string, id: string) {
  const deleted = await db
    .delete(outreachProspects)
    .where(and(eq(outreachProspects.companyId, companyId), eq(outreachProspects.id, id)))
    .returning({ id: outreachProspects.id });
  return deleted.length > 0;
}
