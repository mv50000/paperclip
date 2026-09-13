import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachProspects, outreachSuppressions } from "@paperclipai/db";
import type { OutreachSuppressionReason } from "@paperclipai/shared";
import { PROSPECT_TERMINAL_STATUSES, normalizeEmail } from "./logic.js";

// GLOBAL list (no company scope) — see docs/implementation-notes/outreach-data-model.md.
// There is intentionally no delete function: entries are permanent.

export async function listOutreachSuppressions(db: Db, limit?: number) {
  return db
    .select()
    .from(outreachSuppressions)
    .orderBy(desc(outreachSuppressions.createdAt))
    .limit(Math.max(1, Math.min(1000, limit ?? 500)));
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
    /** The prospect whose own event caused this; it gets its reason-specific
     * status (`bounced`/`unsubscribed`) from the caller, not `suppressed`. */
    excludeProspectId?: string | null;
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
  // Suppression is global: every company's non-terminal prospect with this
  // e-mail becomes `suppressed` so the human review gate and the sender both
  // see it without a second lookup. Runs AFTER the insert so an import racing
  // this call either sees the row (and rejects) or gets flipped here.
  const flipConditions = [
    eq(outreachProspects.email, email),
    notInArray(outreachProspects.status, [...PROSPECT_TERMINAL_STATUSES]),
  ];
  if (args.excludeProspectId) flipConditions.push(ne(outreachProspects.id, args.excludeProspectId));
  await db
    .update(outreachProspects)
    .set({ status: "suppressed", updatedAt: new Date() })
    .where(and(...flipConditions));
  if (inserted) return { entry: inserted, created: true as const };
  const [existing] = await db
    .select()
    .from(outreachSuppressions)
    .where(inArray(outreachSuppressions.email, [email]));
  return { entry: existing, created: false as const };
}
