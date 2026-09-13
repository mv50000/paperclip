// RK9-194: the send scheduler and machine-API glue. DB/IO only — the actual
// decisions (window, cap, ramp, retry, SMTP classification) live in
// `scheduler-logic.ts` and are unit-tested there without a database.

import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachMessages, outreachProspects, outreachSequences } from "@paperclipai/db";
import type { OutreachProspectStatus } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { isProspectContactable } from "./logic.js";
import { getProspect } from "./prospects.js";
import { findOutreachSuppressed } from "./suppressions.js";
import { recordEvent } from "./events.js";
import {
  MAX_SEND_ATTEMPTS,
  classifySmtpCode,
  effectiveDailyCap,
  isWithinSendWindow,
  remainingDailyCapacity,
  retryDelayMs,
  zonedDayRange,
  type OutreachRampStep,
  type OutreachSendWindow,
} from "./scheduler-logic.js";
import {
  buildRawEmail,
  buildReferences,
  buildUnsubscribeHeaders,
  generateMessageId,
  generateUnsubscribeToken,
} from "./message-format.js";

type SequenceRow = typeof outreachSequences.$inferSelect;

function sendWindowOf(seq: SequenceRow): OutreachSendWindow {
  return seq.sendWindow as unknown as OutreachSendWindow;
}
function rampScheduleOf(seq: SequenceRow): OutreachRampStep[] {
  return seq.rampSchedule as unknown as OutreachRampStep[];
}

async function countSentOrQueuedToday(
  db: Db,
  senderIdentity: string,
  range: { start: Date; end: Date },
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachMessages)
    .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
    .where(
      and(
        eq(outreachSequences.senderIdentity, senderIdentity),
        or(
          and(
            eq(outreachMessages.status, "sent"),
            gte(outreachMessages.sentAt, range.start),
            lt(outreachMessages.sentAt, range.end),
          ),
          and(
            eq(outreachMessages.status, "queued"),
            gte(outreachMessages.queuedAt, range.start),
            lt(outreachMessages.queuedAt, range.end),
          ),
        ),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/** A message whose prospect is no longer contactable never leaves the queue silently. */
async function rejectAsNoLongerContactable(db: Db, id: string, fromStatus: "approved" | "queued") {
  const now = new Date();
  await db
    .update(outreachMessages)
    .set({
      status: "rejected",
      rejectedBy: "system:scheduler",
      rejectedAt: now,
      rejectReason: "prospect_no_longer_contactable",
      updatedAt: now,
    })
    .where(and(eq(outreachMessages.id, id), eq(outreachMessages.status, fromStatus)));
}

export interface QueueDueMessagesResult {
  queued: number;
  rejected: number;
}

// Arbitrary but stable — Postgres advisory locks are keyed by a plain int8,
// shared across every advisory-lock user on this DB (see plugin-database.ts
// for the other user), so this key must not collide with another one.
const SCHEDULER_LOCK_KEY = 0x524b39_194;

async function tryAcquireSchedulerLock(tx: Db): Promise<boolean> {
  const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}) AS locked`);
  const rows = (result as unknown as { rows?: Array<{ locked: boolean }> }).rows;
  return rows?.[0]?.locked === true;
}

/**
 * Runs once a minute (see `startOutreachSendCron`). For every active sequence
 * whose send window is open right now, promotes the oldest `approved`
 * messages to `queued` up to the sender identity's ramp-adjusted daily cap.
 * A sequence past its cap is simply skipped — its remaining `approved`
 * messages stay put and are picked up on a later tick once the day rolls
 * over (or capacity frees up, which never happens mid-day by design).
 *
 * Wrapped in one DB transaction holding a `pg_try_advisory_xact_lock` for its
 * whole duration: a slow tick that outlives its interval, or a second server
 * process briefly running during a rolling deploy (the DB is shared
 * dev/prod, so more than one process CAN be live), would otherwise both read
 * the same "already sent today" count and jointly overshoot the daily cap.
 * A tick that can't get the lock is a no-op, not an error — the next one
 * will pick up whatever is still due.
 */
export async function queueDueMessages(db: Db, now: Date = new Date()): Promise<QueueDueMessagesResult> {
  return db.transaction(async (tx) => {
    // A drizzle transaction handle is structurally missing `Db`'s `$client`
    // field, which nothing here actually uses (only .select/.update/.execute
    // are called) — cast rather than widen every service function's `db: Db`
    // parameter (getProspect, findOutreachSuppressed, ...) just for this.
    const txDb = tx as unknown as Db;
    if (!(await tryAcquireSchedulerLock(txDb))) {
      logger.info("outreach send-scheduler tick skipped: another tick already holds the lock");
      return { queued: 0, rejected: 0 };
    }
    return runQueueDueMessages(txDb, now);
  });
}

async function runQueueDueMessages(db: Db, now: Date): Promise<QueueDueMessagesResult> {
  const sequences = await db.select().from(outreachSequences).where(eq(outreachSequences.active, true));
  let queued = 0;
  let rejected = 0;
  // Multiple active sequences can share one sender identity; track what this
  // tick has already reserved for it so they don't jointly overshoot the cap.
  const reservedThisTick = new Map<string, number>();

  for (const seq of sequences) {
    const window = sendWindowOf(seq);
    if (!isWithinSendWindow(window, now)) continue;

    const range = zonedDayRange(window.tz, now);
    const alreadyCounted = await countSentOrQueuedToday(db, seq.senderIdentity, range);
    const reserved = reservedThisTick.get(seq.senderIdentity) ?? 0;
    const remaining = remainingDailyCapacity(
      { dailyCap: seq.dailyCap, rampSchedule: rampScheduleOf(seq), activatedAt: seq.activatedAt },
      now,
      alreadyCounted + reserved,
    );
    if (remaining <= 0) continue;

    const candidates = await db
      .select()
      .from(outreachMessages)
      .where(and(eq(outreachMessages.sequenceId, seq.id), eq(outreachMessages.status, "approved")))
      .orderBy(asc(outreachMessages.createdAt))
      .limit(remaining);

    for (const message of candidates) {
      const prospect = await getProspect(db, seq.companyId, message.prospectId);
      const suppressed =
        !!prospect?.email && (await findOutreachSuppressed(db, [prospect.email])).size > 0;
      if (!prospect || !isProspectContactable(prospect.status as OutreachProspectStatus) || suppressed) {
        await rejectAsNoLongerContactable(db, message.id, "approved");
        rejected += 1;
        continue;
      }
      const [updated] = await db
        .update(outreachMessages)
        .set({
          status: "queued",
          queuedAt: now,
          unsubscribeToken: message.unsubscribeToken ?? generateUnsubscribeToken(),
          updatedAt: now,
        })
        .where(and(eq(outreachMessages.id, message.id), eq(outreachMessages.status, "approved")))
        .returning();
      if (updated) {
        queued += 1;
        reservedThisTick.set(seq.senderIdentity, (reservedThisTick.get(seq.senderIdentity) ?? 0) + 1);
      }
    }
  }
  return { queued, rejected };
}

export interface SendQueueItem {
  id: string;
  envelopeFrom: string;
  envelopeTo: string;
  raw: string;
}

/**
 * What the rk9-prod sender daemon fetches to actually dial Postfix. Composes
 * the full raw RFC 5322 message here (the daemon has no DB access), and does
 * the send-time suppression/contactability re-check the spec requires
 * ("tarkistus lähetyshetkellä, ei vain importissa") — this is the last gate
 * before a message leaves the building.
 */
export async function listSendQueue(
  db: Db,
  opts: { limit?: number; unsubscribeBaseUrl: string },
): Promise<SendQueueItem[]> {
  const now = new Date();
  const rows = await db
    .select({
      message: outreachMessages,
      prospectEmail: outreachProspects.email,
      prospectStatus: outreachProspects.status,
      senderIdentity: outreachSequences.senderIdentity,
    })
    .from(outreachMessages)
    .innerJoin(outreachProspects, eq(outreachMessages.prospectId, outreachProspects.id))
    .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
    .where(
      and(
        eq(outreachMessages.status, "queued"),
        or(isNull(outreachMessages.nextRetryAt), lte(outreachMessages.nextRetryAt, now)),
      ),
    )
    .orderBy(asc(outreachMessages.queuedAt))
    .limit(Math.max(1, Math.min(50, opts.limit ?? 10)));

  const items: SendQueueItem[] = [];
  for (const row of rows) {
    const suppressed =
      !!row.prospectEmail && (await findOutreachSuppressed(db, [row.prospectEmail])).size > 0;
    if (!row.prospectEmail || !isProspectContactable(row.prospectStatus as OutreachProspectStatus) || suppressed) {
      await rejectAsNoLongerContactable(db, row.message.id, "queued");
      continue;
    }

    const domain = row.senderIdentity.split("@")[1] ?? row.senderIdentity;
    const patch: Record<string, unknown> = {};
    const unsubscribeToken = row.message.unsubscribeToken ?? generateUnsubscribeToken();
    if (!row.message.unsubscribeToken) patch.unsubscribeToken = unsubscribeToken;
    const messageId = row.message.messageId ?? generateMessageId(domain);
    if (!row.message.messageId) patch.messageId = messageId;
    if (Object.keys(patch).length > 0) {
      await db.update(outreachMessages).set({ ...patch, updatedAt: now }).where(eq(outreachMessages.id, row.message.id));
    }

    items.push({
      id: row.message.id,
      envelopeFrom: row.senderIdentity,
      envelopeTo: row.prospectEmail,
      raw: buildRawEmail({
        from: row.senderIdentity,
        to: row.prospectEmail,
        subject: row.message.subject,
        bodyText: row.message.bodyText,
        bodyHtml: row.message.bodyHtml,
        messageId,
        inReplyTo: row.message.inReplyTo,
        references: buildReferences(row.message.inReplyTo, null),
        unsubscribe: buildUnsubscribeHeaders(domain, opts.unsubscribeBaseUrl, unsubscribeToken),
      }),
    });
  }
  return items;
}

export type ReportSendResult =
  | { ok: true; message: typeof outreachMessages.$inferSelect }
  | { ok: false; reason: "not_found" | "invalid_transition" };

export async function markMessageSent(db: Db, id: string, sentAt: Date = new Date()): Promise<ReportSendResult> {
  const [updated] = await db
    .update(outreachMessages)
    .set({ status: "sent", sentAt, lastError: null, nextRetryAt: null, updatedAt: sentAt })
    .where(and(eq(outreachMessages.id, id), eq(outreachMessages.status, "queued")))
    .returning();
  return updated ? { ok: true, message: updated } : { ok: false, reason: "invalid_transition" };
}

/**
 * SMTP 4xx → bump `attempts`/`nextRetryAt` and stay `queued` (a transient
 * failure is not a status change); after `MAX_SEND_ATTEMPTS` it gives up
 * (`failed`, no auto-suppression). SMTP 5xx → `failed` + a `bounce_hard`
 * event, which suppresses the prospect globally (see `logic.ts`).
 */
export async function markMessageFailed(
  db: Db,
  id: string,
  smtpCode: number,
  response: string,
): Promise<ReportSendResult> {
  const message = await db
    .select()
    .from(outreachMessages)
    .where(eq(outreachMessages.id, id))
    .then((rows) => rows[0] ?? null);
  if (!message) return { ok: false, reason: "not_found" };

  const outcome = classifySmtpCode(smtpCode);
  const now = new Date();

  if (outcome === "bounce_hard") {
    const [updated] = await db
      .update(outreachMessages)
      .set({ status: "failed", lastError: response, updatedAt: now })
      .where(and(eq(outreachMessages.id, id), eq(outreachMessages.status, "queued")))
      .returning();
    if (!updated) return { ok: false, reason: "invalid_transition" };
    await recordEvent(db, message.companyId, {
      prospectId: message.prospectId,
      messageId: message.id,
      type: "bounce_hard",
      payload: { smtpCode, response },
    });
    return { ok: true, message: updated };
  }

  const attempts = message.attempts + 1;
  if (attempts >= MAX_SEND_ATTEMPTS) {
    const [updated] = await db
      .update(outreachMessages)
      .set({ status: "failed", attempts, lastError: response, nextRetryAt: null, updatedAt: now })
      .where(and(eq(outreachMessages.id, id), eq(outreachMessages.status, "queued")))
      .returning();
    return updated ? { ok: true, message: updated } : { ok: false, reason: "invalid_transition" };
  }
  const [updated] = await db
    .update(outreachMessages)
    .set({
      attempts,
      lastError: response,
      nextRetryAt: new Date(now.getTime() + retryDelayMs(attempts)),
      updatedAt: now,
    })
    .where(and(eq(outreachMessages.id, id), eq(outreachMessages.status, "queued")))
    .returning();
  return updated ? { ok: true, message: updated } : { ok: false, reason: "invalid_transition" };
}

export interface OutreachSendCronHandle {
  stop(): void;
  runNow(): Promise<QueueDueMessagesResult>;
}

export function startOutreachSendCron(db: Db, opts: { intervalMs: number }): OutreachSendCronHandle {
  async function tick(): Promise<QueueDueMessagesResult> {
    return queueDueMessages(db);
  }
  const interval = setInterval(() => {
    void tick().catch((err) => {
      // queueDueMessages does not throw for per-message failures; a thrown
      // error here means the query itself failed. Let the next tick retry.
      logger.error({ err }, "outreach send-scheduler tick failed");
    });
  }, opts.intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  logger.info({ intervalMs: opts.intervalMs }, "outreach send scheduler started");
  return { stop: () => clearInterval(interval), runNow: tick };
}
