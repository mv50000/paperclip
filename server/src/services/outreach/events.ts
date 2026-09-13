import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachEvents } from "@paperclipai/db";
import type { CreateOutreachEvent, OutreachEventType, OutreachProspectStatus } from "@paperclipai/shared";
import { applyEventToProspect } from "./logic.js";
import { getMessage } from "./messages.js";
import { getProspect, setProspectStatus } from "./prospects.js";
import { addOutreachSuppression } from "./suppressions.js";

export async function listEvents(
  db: Db,
  companyId: string,
  opts: { type?: OutreachEventType; prospectId?: string; limit?: number } = {},
) {
  const conditions = [eq(outreachEvents.companyId, companyId)];
  if (opts.type) conditions.push(eq(outreachEvents.type, opts.type));
  if (opts.prospectId) conditions.push(eq(outreachEvents.prospectId, opts.prospectId));
  return db
    .select()
    .from(outreachEvents)
    .where(and(...conditions))
    .orderBy(desc(outreachEvents.occurredAt))
    .limit(Math.max(1, Math.min(1000, opts.limit ?? 200)));
}

export type RecordEventResult =
  | {
      ok: true;
      event: typeof outreachEvents.$inferSelect;
      prospectStatus: OutreachProspectStatus;
      suppressed: boolean;
    }
  | { ok: false; reason: "prospect_not_found" | "message_not_found" };

/**
 * Record an event and apply its side effects: prospect status transition and,
 * for opt-outs / hard bounces, a permanent GLOBAL suppression entry.
 */
export async function recordEvent(
  db: Db,
  companyId: string,
  input: CreateOutreachEvent,
): Promise<RecordEventResult> {
  const prospect = await getProspect(db, companyId, input.prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  if (input.messageId) {
    const message = await getMessage(db, companyId, input.messageId);
    if (!message || message.prospectId !== prospect.id) return { ok: false, reason: "message_not_found" };
  }

  const effect = applyEventToProspect(prospect.status as OutreachProspectStatus, input.type);

  // Order matters (no transaction across these autocommit statements): the
  // legally important write — the global suppression row — goes first, so a
  // failure later leaves the opt-out recorded and a retry is harmless.
  if (effect.suppress) {
    await addOutreachSuppression(db, {
      email: prospect.email,
      reason: effect.suppress,
      sourceCompanyId: companyId,
      note: `${input.type} event`,
      // This prospect gets `bounced`/`unsubscribed` below, not the generic `suppressed`.
      excludeProspectId: prospect.id,
    });
  }
  let prospectStatus = prospect.status as OutreachProspectStatus;
  if (effect.prospectStatus) {
    // Guarded on the status we read: a concurrent event wins or loses cleanly.
    const updated = await setProspectStatus(
      db,
      companyId,
      prospect.id,
      effect.prospectStatus,
      prospect.status as OutreachProspectStatus,
    );
    const fresh = updated ?? (await getProspect(db, companyId, prospect.id));
    prospectStatus = (fresh?.status ?? prospectStatus) as OutreachProspectStatus;
  }

  const [event] = await db
    .insert(outreachEvents)
    .values({
      companyId,
      prospectId: prospect.id,
      messageId: input.messageId ?? null,
      type: input.type,
      payload: input.payload,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return { ok: true, event, prospectStatus, suppressed: effect.suppress !== null };
}
