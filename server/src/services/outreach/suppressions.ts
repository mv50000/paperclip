import { desc, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachSuppressions } from "@paperclipai/db";
import type { OutreachSuppressionReason } from "@paperclipai/shared";
import { normalizeEmail } from "./logic.js";

// GLOBAL list (no company scope) — see docs/implementation-notes/outreach-data-model.md.
// There is intentionally no delete function: entries are permanent.

export async function listOutreachSuppressions(db: Db, limit = 500) {
  return db
    .select()
    .from(outreachSuppressions)
    .orderBy(desc(outreachSuppressions.createdAt))
    .limit(limit);
}

/** Returns the subset of `emails` (lower-cased) that are suppressed. */
export async function findOutreachSuppressed(db: Db, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const lowered = Array.from(new Set(emails.map(normalizeEmail)));
  const rows = await db
    .select({ email: outreachSuppressions.email })
    .from(outreachSuppressions)
    .where(inArray(outreachSuppressions.email, lowered));
  return new Set(rows.map((r) => r.email));
}

export async function addOutreachSuppression(
  db: Db,
  args: {
    email: string;
    reason: OutreachSuppressionReason;
    note?: string | null;
    sourceCompanyId?: string | null;
  },
) {
  const email = normalizeEmail(args.email);
  const [inserted] = await db
    .insert(outreachSuppressions)
    .values({
      email,
      reason: args.reason,
      note: args.note ?? null,
      sourceCompanyId: args.sourceCompanyId ?? null,
    })
    .onConflictDoNothing({ target: [outreachSuppressions.email] })
    .returning();
  if (inserted) return { entry: inserted, created: true as const };
  const [existing] = await db
    .select()
    .from(outreachSuppressions)
    .where(inArray(outreachSuppressions.email, [email]));
  return { entry: existing, created: false as const };
}
