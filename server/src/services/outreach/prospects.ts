import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachProspects } from "@paperclipai/db";
import type {
  CreateOutreachProspect,
  OutreachProspectStatus,
  UpdateOutreachProspect,
} from "@paperclipai/shared";
import { PROSPECT_TERMINAL_STATUSES, classifyImport, type ImportRejection } from "./logic.js";
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
  // RK9-196: rows may have no e-mail yet (filled in later by enrichment or
  // manual review) — they have nothing to dedupe/suppress-check against.
  const emails = rows.map((r) => r.email).filter((e): e is string => !!e);
  const [suppressed, existingRows] = await Promise.all([
    findOutreachSuppressed(db, emails),
    emails.length === 0
      ? Promise.resolve([] as Array<{ email: string | null }>)
      : db
          .select({ email: outreachProspects.email })
          .from(outreachProspects)
          .where(and(eq(outreachProspects.companyId, companyId), inArray(outreachProspects.email, emails))),
  ]);
  const { accepted, rejected } = classifyImport(
    rows,
    existingRows.map((r) => r.email).filter((e): e is string => e !== null),
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
        email: row.email ?? null,
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
  // Only a non-null e-mail is unique-constrained; a null-email row never
  // conflicts (Postgres treats every NULL as distinct) so it never races.
  const raced = accepted
    .filter(({ row }) => row.email && !insertedEmails.has(row.email))
    .map(({ index, row }) => ({ index, email: row.email as string, reason: "duplicate_existing" as const }));

  return {
    imported: inserted.length,
    rejected: [...rejected, ...raced].sort((a, b) => a.index - b.index),
    ids: inserted.map((r) => r.id),
  };
}

export async function createProspect(db: Db, companyId: string, input: CreateOutreachProspect) {
  const result = await importProspects(db, companyId, [input]);
  if (result.imported === 1) {
    const prospect = await getProspect(db, companyId, result.ids[0]);
    if (prospect) return { ok: true as const, prospect };
  }
  return { ok: false as const, reason: result.rejected[0]?.reason ?? "duplicate_existing" };
}

/**
 * Field edits. A `status` edit is only applied while the row is still in the
 * manual-review states (`new`/`approved`) — checked in the WHERE clause so a
 * concurrent bounce/unsubscribe cannot be overwritten. Returns
 * `invalid_transition` when the guard rejects it.
 */
function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}

export async function updateProspect(
  db: Db,
  companyId: string,
  id: string,
  patch: UpdateOutreachProspect,
): Promise<
  | { ok: true; prospect: typeof outreachProspects.$inferSelect }
  | { ok: false; reason: "not_found" | "invalid_transition" | "duplicate_email" }
> {
  const conditions = [eq(outreachProspects.companyId, companyId), eq(outreachProspects.id, id)];
  if (patch.status) conditions.push(inArray(outreachProspects.status, ["new", "approved"]));
  let row: typeof outreachProspects.$inferSelect | undefined;
  try {
    [row] = await db
      .update(outreachProspects)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
  } catch (error) {
    // RK9-196: enrichment/manual review can set `email` to an address another
    // prospect of this company already has — the (company_id, email) unique
    // index rejects it rather than silently merging two prospects.
    if (isUniqueViolation(error)) return { ok: false, reason: "duplicate_email" };
    throw error;
  }
  if (row) return { ok: true, prospect: row };
  const existing = await getProspect(db, companyId, id);
  return { ok: false, reason: existing ? "invalid_transition" : "not_found" };
}

/**
 * Event-driven status change. `expectedStatus` is re-checked in the WHERE so
 * two concurrent events (e.g. unsubscribe + auto-reply) cannot both win; a
 * terminal status is additionally never overwritten. Returns null when the
 * guard rejected the update.
 */
export async function setProspectStatus(
  db: Db,
  companyId: string,
  id: string,
  status: OutreachProspectStatus,
  expectedStatus: OutreachProspectStatus,
) {
  const [row] = await db
    .update(outreachProspects)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(outreachProspects.companyId, companyId),
        eq(outreachProspects.id, id),
        eq(outreachProspects.status, expectedStatus),
        notInArray(outreachProspects.status, [...PROSPECT_TERMINAL_STATUSES]),
      ),
    )
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
