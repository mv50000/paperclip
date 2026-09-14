// RK9-197: `outreach_sender_pauses` CRUD. GLOBAL, like `suppressions.ts` —
// see the schema comment in packages/db/src/schema/outreach.ts for why a
// sender identity isn't scoped to one company.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachSenderPauses } from "@paperclipai/db";
import type { OutreachPauseReason } from "@paperclipai/shared";

export type OutreachSenderPause = typeof outreachSenderPauses.$inferSelect;

/** The active pause for an identity, or `null` if it isn't currently paused. */
export async function getActivePause(db: Db, senderIdentity: string): Promise<OutreachSenderPause | null> {
  const [row] = await db
    .select()
    .from(outreachSenderPauses)
    .where(and(eq(outreachSenderPauses.senderIdentity, senderIdentity), isNull(outreachSenderPauses.resumedAt)))
    .limit(1);
  return row ?? null;
}

/** Every identity with an active pause right now — the scheduler's gate and the `/metrics` gauge both use this. */
export async function listActivePauses(db: Db): Promise<OutreachSenderPause[]> {
  return db.select().from(outreachSenderPauses).where(isNull(outreachSenderPauses.resumedAt));
}

/** Pause + resume history for one identity, newest first — for operator triage. */
export async function listPauseHistory(db: Db, senderIdentity: string, limit = 50): Promise<OutreachSenderPause[]> {
  return db
    .select()
    .from(outreachSenderPauses)
    .where(eq(outreachSenderPauses.senderIdentity, senderIdentity))
    .orderBy(desc(outreachSenderPauses.pausedAt))
    .limit(Math.max(1, Math.min(200, limit)));
}

export interface PauseSenderResult {
  /** `false` when the identity was already paused — the existing pause is returned unchanged, not extended/overwritten. */
  created: boolean;
  pause: OutreachSenderPause;
}

/**
 * Idempotent: an identity already paused stays on its original pause row (so
 * `pausedAt`/`reason`/`detail` reflect what actually triggered the pause,
 * not the latest tick that merely re-confirmed it). Relies on the partial
 * unique index (`outreach_sender_pauses_active_identity_unique_idx`) to make
 * the re-check-then-insert race-safe under concurrent auto-pause ticks.
 */
export async function pauseSender(
  db: Db,
  args: { senderIdentity: string; reason: OutreachPauseReason; detail?: Record<string, unknown> },
): Promise<PauseSenderResult> {
  const existing = await getActivePause(db, args.senderIdentity);
  if (existing) return { created: false, pause: existing };
  try {
    const [row] = await db
      .insert(outreachSenderPauses)
      .values({ senderIdentity: args.senderIdentity, reason: args.reason, detail: args.detail ?? {} })
      .returning();
    return { created: true, pause: row };
  } catch {
    // Lost the race to a concurrent tick that inserted first — the unique
    // index rejected ours. Return the winner's row instead of throwing.
    const winner = await getActivePause(db, args.senderIdentity);
    if (winner) return { created: false, pause: winner };
    throw new Error(`pauseSender: insert failed and no active pause found for ${args.senderIdentity}`);
  }
}

export type ResumeSenderResult = { ok: true; pause: OutreachSenderPause } | { ok: false; reason: "not_paused" };

/** Resume always requires an explicit caller-supplied `resumedBy` — see routes/outreach.ts, which is the only route allowed to call this (board actor only). */
export async function resumeSender(db: Db, senderIdentity: string, resumedBy: string): Promise<ResumeSenderResult> {
  const now = new Date();
  const [updated] = await db
    .update(outreachSenderPauses)
    .set({ resumedAt: now, resumedBy, updatedAt: now })
    .where(and(eq(outreachSenderPauses.senderIdentity, senderIdentity), isNull(outreachSenderPauses.resumedAt)))
    .returning();
  if (!updated) return { ok: false, reason: "not_paused" };
  return { ok: true, pause: updated };
}
