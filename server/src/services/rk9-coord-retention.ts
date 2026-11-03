// --- RK9 Custom (RK9-626): coord bus retention ---
//
// Periods (coord-bus.md "Retention"):
// - events: 90 days; `decision` and `decision-vaulted`: 366 days (>= 1 year);
// - ended actors: 7 days after ended_at (cascades to their cursors, inbox
//   rows, leases and waiters);
// - never-ended actors (RK9-641): a stub that never registered (no
//   presence marker: rows from ensureRk9CoordActorRow, agent_run stubs) 7
//   days after its last activity, any other actor 30 days after it. Last
//   activity is the latest of last_seen_at, the cursor's updated_at, an
//   inbox claim and a lease acquire, renew or release. An actor that holds
//   an unreleased lease, waits in a lease queue or has an undelivered,
//   unexpired inbox row is kept;
// - delivered inbox rows and expired undelivered ones: 30 days; undelivered
//   rows without expires_at: 30 days after created_at (RK9-641);
// - released leases: 30 days.
//
// The journal trigger rejects every DELETE unless the transaction sets
// `rk9.coord_events_prune = 'on'` (SET LOCAL via set_config(..., true)). This
// prune is the only code that sets it. Deletes run in id batches, so no
// transaction holds many locks, and a re-run over pruned data deletes nothing.
import { and, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rk9CoordActors, rk9CoordEvents, rk9CoordInbox, rk9CoordLeases } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { RK9_COORD_REGISTERED_MARKER } from "./rk9-coord-presence.js";

const DAY_MS = 24 * 3600 * 1000;
const BATCH = 5_000;
const MAX_BATCHES = 100;

export const RK9_COORD_RETENTION = {
  eventDays: 90,
  // 366 days: at least one calendar year, also across a leap day.
  decisionDays: 366,
  endedActorDays: 7,
  /** Never-ended actor without a presence registration (a stub), after its last activity. */
  stubActorDays: 7,
  /** Never-ended registered actor (crashed session), after its last activity. */
  staleActorDays: 30,
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

  // RK9-641: never-ended rows (stubs, crashed sessions) would stay forever.
  const stubCutoff = before(RK9_COORD_RETENTION.stubActorDays).toISOString();
  const staleCutoff = before(RK9_COORD_RETENTION.staleActorDays).toISOString();
  const nowIso = now.toISOString();
  const staleActors = await batched(async () => {
    // Last activity: presence refresh, a delta call (every non-peek delta
    // touches the cursor), an inbox claim, or a lease acquire, renew or
    // release (GREATEST ignores NULLs). Kept whatever their age: holders of
    // an unreleased lease (the sweeper journals its expiry first), queued
    // waiters, and targets of an undelivered, unexpired inbox row (the
    // cascade would delete the message; it is pruned after inboxDays and the
    // actor after it). The outer WHERE repeats the staleness test on the
    // target row, so a concurrent presence PUT that refreshes last_seen_at
    // wins (Postgres re-checks it on the updated row).
    const result = await db.execute<{ id: string }>(sql`
      delete from rk9_coord_actors t
      where t.id in (
        select a.id
        from rk9_coord_actors a
        left join rk9_coord_cursors c on c.company_id = a.company_id and c.actor_id = a.id
        where a.ended_at is null
          and greatest(
            a.last_seen_at,
            c.updated_at,
            (select max(i.delivered_at) from rk9_coord_inbox i where i.delivered_to_actor_id = a.id),
            (
              select max(greatest(l.acquired_at, l.renewed_at, l.released_at))
              from rk9_coord_leases l
              where l.holder_actor_id = a.id
            )
          ) < case
            when (a.metadata ->> ${RK9_COORD_REGISTERED_MARKER}::text) is null then ${stubCutoff}::timestamptz
            else ${staleCutoff}::timestamptz
          end
          and not exists (
            select 1 from rk9_coord_leases l where l.holder_actor_id = a.id and l.released_at is null
          )
          and not exists (select 1 from rk9_coord_lease_waiters w where w.actor_id = a.id)
          and not exists (
            select 1 from rk9_coord_inbox i
            where i.to_actor_id = a.id
              and i.delivered_at is null
              and (i.expires_at is null or i.expires_at > ${nowIso}::timestamptz)
          )
        limit ${BATCH}
      )
        and t.ended_at is null
        and t.last_seen_at < case
          when (t.metadata ->> ${RK9_COORD_REGISTERED_MARKER}::text) is null then ${stubCutoff}::timestamptz
          else ${staleCutoff}::timestamptz
        end
      returning t.id
    `);
    return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])).length;
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
                and(
                  isNull(rk9CoordInbox.deliveredAt),
                  isNull(rk9CoordInbox.expiresAt),
                  lt(rk9CoordInbox.createdAt, inboxCutoff),
                ),
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

  const result = { events, actors: actors + staleActors, inbox, leases };
  if (result.events + result.actors + result.inbox + result.leases > 0) logger.info(result, "pruned rk9 coord bus rows");
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
