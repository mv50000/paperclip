// RK9-197: DB orchestration for the auto-pause rules. The rules themselves
// (rates, thresholds) are pure and unit-tested in `auto-pause-logic.ts`;
// this file only counts.
//
// Scope note: the issue text's spam-complaint rule also mentions a reply-body
// heuristic ("vastauksessa 'spam'/'älä lähetä'"). That can't be implemented
// here without touching the RK9-195 inbound pipeline (`inbound.ts`/
// `inbound-classify.ts`) — a `reply` event's payload is deliberately empty
// (PII minimization, see outreach-inbound.md), so no reply body text is ever
// persisted for this job to scan. RK9-197 is explicitly blocked from
// touching ENGINE/INBOUND, so this rule fires on the `complaint` event type
// only (already first-class in OUTREACH_EVENT_TYPES and already wired to
// suppress via `applyEventToProspect`) — a future inbound ticket can record
// `complaint` events itself once it adds the body heuristic; this job needs
// no change when it does.
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachEvents, outreachMessages, outreachSequences } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  evaluateAutoPause,
  OUTREACH_AUTO_PAUSE_ROLLING_DAYS,
  OUTREACH_DELIVERY_ERROR_WINDOW_HOURS,
  type OutreachAutoPauseDecision,
  type OutreachAutoPauseWindowCounts,
} from "./auto-pause-logic.js";
import { getActivePause, pauseSender } from "./sender-pauses.js";

async function distinctSenderIdentities(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ senderIdentity: outreachSequences.senderIdentity }).from(outreachSequences);
  return rows.map((r) => r.senderIdentity);
}

async function countEventType(
  db: Db,
  senderIdentity: string,
  type: "bounce_hard" | "complaint",
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachEvents)
    .innerJoin(outreachMessages, eq(outreachEvents.messageId, outreachMessages.id))
    .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
    .where(
      and(
        eq(outreachSequences.senderIdentity, senderIdentity),
        eq(outreachEvents.type, type),
        gte(outreachEvents.occurredAt, since),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

async function countSent(db: Db, senderIdentity: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachMessages)
    .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
    .where(
      and(
        eq(outreachSequences.senderIdentity, senderIdentity),
        eq(outreachMessages.status, "sent"),
        gte(outreachMessages.sentAt, since),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/**
 * SMTP 4xx failures aren't recorded as events (see `markMessageFailed` in
 * scheduler.ts — a transient reject just bumps `attempts`/`lastError`, it's
 * not a status change), so this counts `outreach_messages` rows directly:
 * `attempts > 0` only happens via the 4xx retry path (a 5xx hard bounce
 * short-circuits straight to `failed` without touching `attempts`), and
 * `updatedAt` approximates "when the most recent attempt happened" — it's
 * bumped on every retry. This is an approximation, not an exact per-attempt
 * log; see docs/implementation-notes/outreach-metrics.md.
 */
async function countDeliveryErrors(db: Db, senderIdentity: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachMessages)
    .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
    .where(
      and(
        eq(outreachSequences.senderIdentity, senderIdentity),
        sql`${outreachMessages.attempts} > 0`,
        gte(outreachMessages.updatedAt, since),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

async function windowCounts(db: Db, senderIdentity: string, now: Date): Promise<OutreachAutoPauseWindowCounts> {
  const rollingSince = new Date(now.getTime() - OUTREACH_AUTO_PAUSE_ROLLING_DAYS * 24 * 60 * 60 * 1000);
  const deliverySince = new Date(now.getTime() - OUTREACH_DELIVERY_ERROR_WINDOW_HOURS * 60 * 60 * 1000);

  const [sentCount, hardBounceCount, complaintCount, deliverySentCount, deliveryErrorCount] = await Promise.all([
    countSent(db, senderIdentity, rollingSince),
    countEventType(db, senderIdentity, "bounce_hard", rollingSince),
    countEventType(db, senderIdentity, "complaint", rollingSince),
    countSent(db, senderIdentity, deliverySince),
    countDeliveryErrors(db, senderIdentity, deliverySince),
  ]);

  return {
    sentCount,
    hardBounceCount,
    complaintCount,
    deliveryErrorCount,
    deliveryAttemptCount: deliverySentCount + deliveryErrorCount,
  };
}

export interface OutreachAutoPauseOutcome {
  senderIdentity: string;
  decision: OutreachAutoPauseDecision;
  /** `true` only when this tick is the one that actually created the pause row (not a re-check of an already-paused identity). */
  newlyPaused: boolean;
}

export async function runOutreachAutoPauseCheck(db: Db, now: Date = new Date()): Promise<OutreachAutoPauseOutcome[]> {
  const identities = await distinctSenderIdentities(db);
  const outcomes: OutreachAutoPauseOutcome[] = [];

  for (const senderIdentity of identities) {
    const activePause = await getActivePause(db, senderIdentity);
    if (activePause) {
      outcomes.push({
        senderIdentity,
        decision: { shouldPause: true, reason: activePause.reason as OutreachAutoPauseDecision["reason"], detail: {} },
        newlyPaused: false,
      });
      continue;
    }

    const counts = await windowCounts(db, senderIdentity, now);
    const decision = evaluateAutoPause(counts);
    let newlyPaused = false;
    if (decision.shouldPause && decision.reason) {
      const result = await pauseSender(db, { senderIdentity, reason: decision.reason, detail: decision.detail });
      newlyPaused = result.created;
      if (result.created) {
        logger.warn(
          { senderIdentity, reason: decision.reason, detail: decision.detail },
          "outreach auto-pause triggered",
        );
      }
    }
    outcomes.push({ senderIdentity, decision, newlyPaused });
  }
  return outcomes;
}

export interface OutreachAutoPauseCronHandle {
  stop(): void;
  runNow(): Promise<OutreachAutoPauseOutcome[]>;
}

export function startOutreachAutoPauseCron(db: Db, opts: { intervalMs: number }): OutreachAutoPauseCronHandle {
  async function tick(): Promise<OutreachAutoPauseOutcome[]> {
    return runOutreachAutoPauseCheck(db);
  }
  const interval = setInterval(() => {
    void tick().catch((err) => logger.error({ err }, "outreach auto-pause tick failed"));
  }, opts.intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  logger.info({ intervalMs: opts.intervalMs }, "outreach auto-pause checker started");
  return { stop: () => clearInterval(interval), runNow: tick };
}
