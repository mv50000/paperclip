// --- RK9 Custom (RK9-626): coord bus retention ---
//
// Periods (coord-bus.md "Retention"):
// - events: 90 days; `decision` and `decision-vaulted`: 366 days (>= 1 year);
// - ended actors: 7 days after ended_at (cascades to their cursors, inbox
//   rows, leases and waiters);
// - delivered inbox rows and expired undelivered ones: 30 days;
// - released leases: 30 days.
//
// The journal trigger rejects every DELETE unless the transaction sets
// `rk9.coord_events_prune = 'on'` (SET LOCAL via set_config(..., true)). This
// prune is the only code that sets it. Deletes run in id batches, so no
// transaction holds many locks, and a re-run over pruned data deletes nothing.
import { and, inArray, isNotNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rk9CoordActors, rk9CoordEvents, rk9CoordInbox, rk9CoordLeases } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const DAY_MS = 24 * 3600 * 1000;
const BATCH = 5_000;
const MAX_BATCHES = 100;

export const RK9_COORD_RETENTION = {
  eventDays: 90,
  // 366 days: at least one calendar year, also across a leap day.
  decisionDays: 366,
  endedActorDays: 7,
  inboxDays: 30,
  releasedLeaseDays: 30,
} as const;

const LONG_LIVED_EVENT_TYPES = ["decision", "decision-vaulted"];

export interface Rk9CoordPruneResult {
  events: number;
  actors: number;
  inbox: number;
  leases: number;
}

async function batched(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const deleted = await run();
    total += deleted;
    if (deleted < BATCH) return total;
  }
  logger.warn({ total }, "rk9 coord retention hit its batch limit; the next run continues");
  return total;
}

export async function pruneRk9Coord(db: Db, opts: { now?: Date } = {}): Promise<Rk9CoordPruneResult> {
  const now = opts.now ?? new Date();
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const eventCutoff = before(RK9_COORD_RETENTION.eventDays);
  const decisionCutoff = before(RK9_COORD_RETENTION.decisionDays);

  const expiredEvents: SQL = or(
    and(notInArray(rk9CoordEvents.type, LONG_LIVED_EVENT_TYPES), lt(rk9CoordEvents.createdAt, eventCutoff)),
    and(inArray(rk9CoordEvents.type, LONG_LIVED_EVENT_TYPES), lt(rk9CoordEvents.createdAt, decisionCutoff)),
  )!;
  const events = await batched(() =>
    db.transaction(async (tx) => {
      // Transaction-local: the trigger exception ends with this transaction.
      await tx.execute(sql`select set_config('rk9.coord_events_prune', 'on', true)`);
      const rows = await tx
        .delete(rk9CoordEvents)
        .where(
          inArray(
            rk9CoordEvents.id,
            tx.select({ id: rk9CoordEvents.id }).from(rk9CoordEvents).where(expiredEvents).orderBy(rk9CoordEvents.id).limit(BATCH),
          ),
        )
        .returning({ id: rk9CoordEvents.id });
      return rows.length;
    }),
  );

  const endedCutoff = before(RK9_COORD_RETENTION.endedActorDays);
  const actors = await batched(async () => {
    const rows = await db
      .delete(rk9CoordActors)
      .where(
        inArray(
          rk9CoordActors.id,
          db
            .select({ id: rk9CoordActors.id })
            .from(rk9CoordActors)
            .where(and(isNotNull(rk9CoordActors.endedAt), lt(rk9CoordActors.endedAt, endedCutoff)))
            .limit(BATCH),
        ),
      )
      .returning({ id: rk9CoordActors.id });
    return rows.length;
  });

  const inboxCutoff = before(RK9_COORD_RETENTION.inboxDays);
  const inbox = await batched(async () => {
    const rows = await db
      .delete(rk9CoordInbox)
      .where(
        inArray(
          rk9CoordInbox.id,
          db
            .select({ id: rk9CoordInbox.id })
            .from(rk9CoordInbox)
            .where(
              or(
                and(isNotNull(rk9CoordInbox.deliveredAt), lt(rk9CoordInbox.deliveredAt, inboxCutoff)),
                and(isNotNull(rk9CoordInbox.expiresAt), lt(rk9CoordInbox.expiresAt, inboxCutoff)),
              ),
            )
            .orderBy(rk9CoordInbox.id)
            .limit(BATCH),
        ),
      )
      .returning({ id: rk9CoordInbox.id });
    return rows.length;
  });

  const leaseCutoff = before(RK9_COORD_RETENTION.releasedLeaseDays);
  const leases = await batched(async () => {
    const rows = await db
      .delete(rk9CoordLeases)
      .where(
        inArray(
          rk9CoordLeases.id,
          db
            .select({ id: rk9CoordLeases.id })
            .from(rk9CoordLeases)
            .where(and(isNotNull(rk9CoordLeases.releasedAt), lt(rk9CoordLeases.releasedAt, leaseCutoff)))
            .limit(BATCH),
        ),
      )
      .returning({ id: rk9CoordLeases.id });
    return rows.length;
  });

  const result = { events, actors, inbox, leases };
  if (events + actors + inbox + leases > 0) logger.info(result, "pruned rk9 coord bus rows");
  return result;
}

/**
 * Run the prune on startup and then every `intervalMs` (default 6 h). Returns
 * a stop function. A self-rescheduling timeout (not setInterval): the next run
 * starts only after the previous one has finished, and the startup order of
 * the server's setInterval schedulers stays as it was.
 */
export function startRk9CoordRetention(db: Db, intervalMs: number = 6 * 3600 * 1000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    void pruneRk9Coord(db)
      .catch((err) => {
        logger.warn({ err }, "rk9 coord retention sweep failed");
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(run, intervalMs);
        timer.unref?.();
      });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
// --- /RK9 Custom ---
