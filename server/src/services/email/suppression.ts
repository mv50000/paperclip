import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailSuppressionList } from "@paperclipai/db";

export interface SuppressionEntry {
  id: string;
  address: string;
  reason: string;
  createdAt: Date;
}

export async function listSuppressions(db: Db, companyId: string): Promise<SuppressionEntry[]> {
  const rows = await db
    .select()
    .from(emailSuppressionList)
    .where(eq(emailSuppressionList.companyId, companyId));
  return rows.map((r) => ({
    id: r.id,
    address: r.address.toLowerCase(),
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

export async function findSuppressed(
  db: Db,
  companyId: string,
  addresses: string[],
): Promise<string[]> {
  if (addresses.length === 0) return [];
  const lowered = addresses.map((a) => a.toLowerCase());
  const rows = await db
    .select({ address: emailSuppressionList.address })
    .from(emailSuppressionList)
    .where(
      and(
        eq(emailSuppressionList.companyId, companyId),
        inArray(emailSuppressionList.address, lowered),
      ),
    );
  return rows.map((r) => r.address.toLowerCase());
}

export async function addSuppression(
  db: Db,
  args: {
    companyId: string;
    address: string;
    reason: "bounce_hard" | "bounce_soft_repeated" | "complaint" | "manual";
    sourceMessageId?: string | null;
  },
): Promise<SuppressionEntry> {
  const [row] = await db
    .insert(emailSuppressionList)
    .values({
      companyId: args.companyId,
      address: args.address.toLowerCase(),
      reason: args.reason,
      sourceMessageId: args.sourceMessageId ?? null,
    })
    .onConflictDoNothing({
      target: [emailSuppressionList.companyId, emailSuppressionList.address],
    })
    .returning();
  if (row) {
    return {
      id: row.id,
      address: row.address,
      reason: row.reason,
      createdAt: row.createdAt,
    };
  }
  // Already existed — fetch it.
  const [existing] = await db
    .select()
    .from(emailSuppressionList)
    .where(
      and(
        eq(emailSuppressionList.companyId, args.companyId),
        eq(emailSuppressionList.address, args.address.toLowerCase()),
      ),
    );
  return {
    id: existing.id,
    address: existing.address,
    reason: existing.reason,
    createdAt: existing.createdAt,
  };
}

export async function removeSuppression(db: Db, companyId: string, id: string): Promise<boolean> {
  const result = await db
    .delete(emailSuppressionList)
    .where(and(eq(emailSuppressionList.companyId, companyId), eq(emailSuppressionList.id, id)))
    .returning({ id: emailSuppressionList.id });
  return result.length > 0;
}
