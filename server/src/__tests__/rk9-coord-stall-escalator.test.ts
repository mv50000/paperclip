// RK9 Custom (RK9-629): coord stall escalator. Pure detector rules, message
// text and config, then the tick against real Postgres with a fake clock:
// exactly-once escalation, ledger dedupe, daily cap, failed-send quota, shadow
// mode, self-resolving cases, unanswered blocker/ask-operator events, the
// report and ack routes, the lease_id break guard and the rk9claude delta.
// No Telegram anywhere: the server only detects (parent decision 2.11.2026).
// Contract: docs/implementation-notes/coord-stall-escalator.md.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  rk9CoordActors,
  rk9CoordEscalations,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeaseWaiters,
  rk9CoordLeases,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import {
  evaluateRk9CoordStuckLease,
  evaluateRk9CoordUnansweredEvent,
  formatRk9CoordEscalationMessage,
  resolveRk9CoordEscalatorConfig,
  rk9CoordEscalationService,
  runRk9CoordStallTick,
  RK9_COORD_ESCALATOR_ACTOR,
  type Rk9CoordEscalatorConfig,
  type Rk9CoordStallCandidate,
  type Rk9CoordStuckLeaseFacts,
} from "../services/rk9-coord-stall-escalator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Actor = Express.Request["actor"];
const MIN = 60_000;

describe("stall detector: stuck lease rule", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * MIN);
  const opts = { now, stuckS: 1800, recheckS: 600, graceS: 300 };
  const base = (): Rk9CoordStuckLeaseFacts => ({
    acquiredAt: ago(60),
    renewedAt: ago(45),
    expiresAt: new Date(now.getTime() + 3 * 3600_000),
    resource: "prod:app",
    holder: { kind: "cc", endedAt: null, lastSeenAt: ago(1), runStatus: null, phaseAt: ago(50) },
    liveWaiters: 2,
    oldestWaiterAt: ago(40),
  });

  it("flags a live holder with waiters > stuckS and no renew or phase progress", () => {
    expect(evaluateRk9CoordStuckLease(base(), opts)).toEqual({ stuck: true, ageS: 45 * 60, waitedS: 40 * 60, progressAt: ago(45) });
  });

  it("never flags the self-resolving cases", () => {
    const why = (facts: Rk9CoordStuckLeaseFacts) => {
      const verdict = evaluateRk9CoordStuckLease(facts, opts);
      return verdict.stuck ? "stuck" : verdict.why;
    };
    expect(why({ ...base(), expiresAt: ago(1) })).toBe("expired");
    expect(why({ ...base(), expiresAt: new Date(now.getTime() + 5 * MIN) })).toBe("expiring");
    // Advisory lease, stale presence and old activity: the sweeper releases it.
    expect(why({ ...base(), resource: "repo:o/r@main", holder: { ...base().holder, lastSeenAt: ago(120) } })).toBe("holder_dead");
    // Hard gate: an explicit end signal after the last renew.
    expect(why({ ...base(), holder: { ...base().holder, endedAt: ago(10) } })).toBe("holder_dead");
    expect(why({ ...base(), holder: { ...base().holder, kind: "agent_run", runStatus: "failed" } })).toBe("holder_dead");
    expect(why({ ...base(), liveWaiters: 0, oldestWaiterAt: null })).toBe("no_waiters");
    expect(why({ ...base(), oldestWaiterAt: ago(20) })).toBe("waiting_short");
    expect(why({ ...base(), renewedAt: ago(5) })).toBe("progress");
    expect(why({ ...base(), holder: { ...base().holder, phaseAt: ago(2) } })).toBe("progress");
    // A holder promoted recently is progress, even when the waiter is old.
    expect(why({ ...base(), acquiredAt: ago(3), renewedAt: null })).toBe("progress");
  });

  it("keeps a hard-gate holder with a stale heartbeat (crashed or in one long tool call) a candidate", () => {
    const facts = { ...base(), holder: { ...base().holder, lastSeenAt: ago(120) } };
    expect(evaluateRk9CoordStuckLease(facts, opts).stuck).toBe(true);
  });
});

describe("stall detector: unanswered journal events", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const opts = { now, stuckS: 1800, lookbackS: 86_400 };
  const facts = (over: Partial<Parameters<typeof evaluateRk9CoordUnansweredEvent>[0]> = {}) => ({
    type: "blocker",
    actorRef: "worktree:RK9-1",
    actorKind: "worktree",
    trust: "attributed",
    createdAt: new Date(now.getTime() - 40 * MIN),
    hasFollowUp: false,
    ...over,
  });

  it("maps blocker and ask-operator to their reasons and skips the rest", () => {
    expect(evaluateRk9CoordUnansweredEvent(facts(), opts)).toEqual({ unanswered: true, ageS: 2400, reason: "blocker_unanswered" });
    expect(evaluateRk9CoordUnansweredEvent(facts({ type: "ask-operator" }), opts)).toMatchObject({
      reason: "ask_operator_unanswered",
    });
    const why = (over: Parameters<typeof facts>[0]) => {
      const verdict = evaluateRk9CoordUnansweredEvent(facts(over), opts);
      return verdict.unanswered ? "unanswered" : verdict.why;
    };
    expect(why({ type: "decision" })).toBe("type");
    expect(why({ actorRef: RK9_COORD_ESCALATOR_ACTOR, actorKind: "orch" })).toBe("author");
    expect(why({ actorRef: "rk9claude", actorKind: "rk9claude" })).toBe("author");
    expect(why({ actorRef: "operator", actorKind: "operator" })).toBe("author");
    // Unverified authors (remote hosts, Grok) never reach the operator's chat.
    expect(why({ actorRef: "grok", actorKind: "grok", trust: "unverified" })).toBe("author");
    expect(why({ hasFollowUp: true })).toBe("follow_up");
    expect(why({ createdAt: new Date(now.getTime() - 10 * MIN) })).toBe("young");
    expect(why({ createdAt: new Date(now.getTime() - 2 * 86_400_000) })).toBe("old");
  });
});

describe("stall escalation message and config", () => {
  const candidate = (over: Partial<Rk9CoordStallCandidate> = {}): Rk9CoordStallCandidate => ({
    companyId: "c",
    baseKey: "lease:x",
    reason: "lease_stuck",
    resource: "prod:saatavilla",
    leaseId: randomUUID(),
    issue: "RK9-629",
    sourceEventId: null,
    sourceType: null,
    sourceSummary: null,
    holder: { actor: "cc:paperclip-01:abc", kind: "cc", host: "paperclip-01", issue: "RK9-629", phase: "deploying", rowId: null },
    waiter: "worktree:RK9-633",
    waiters: 2,
    waiterRefs: ["worktree:RK9-633", "cc:paperclip-01:def"],
    waitedS: 52 * 60,
    ageS: 47 * 60,
    progressAt: null,
    ...over,
  });

  it("names resource, holder, phase, age, waiters and the break command", () => {
    const text = formatRk9CoordEscalationMessage(candidate());
    expect(text).toContain("prod:saatavilla");
    expect(text).toContain("cc:paperclip-01:abc (cc, host paperclip-01, issue RK9-629)");
    expect(text).toContain("Phase: deploying");
    expect(text).toContain("no progress for 47 min");
    expect(text).toContain("Waiting: 2 (oldest 52 min): worktree:RK9-633, cc:paperclip-01:def");
    expect(text).toContain('rk9 lease break prod:saatavilla --reason "stuck >30 min"');
  });

  it("redacts a secret in client text and stays within 1000 characters", () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const text = formatRk9CoordEscalationMessage(
      candidate({ holder: { ...candidate().holder, phase: `deploy with ${secret}` }, waiterRefs: Array(5).fill("x".repeat(300)) }),
    );
    expect(text).not.toContain(secret);
    expect(Array.from(text).length).toBeLessThanOrEqual(1000);
    const event = formatRk9CoordEscalationMessage(
      candidate({ reason: "blocker_unanswered", resource: null, sourceEventId: 42, sourceType: "blocker", sourceSummary: "need prod DB access" }),
    );
    expect(event).toContain("blocker unanswered for 47 min: RK9-629");
    expect(event).toContain("What: need prod DB access");
    expect(event).not.toContain("rk9 lease break");
  });

  it("defaults to shadow, never turns on by a typo, and reads RK9_COORD_STUCK_S", () => {
    const cfg = resolveRk9CoordEscalatorConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ mode: "shadow", stuckS: 1800, recheckS: 600, dedupeS: 21_600, dayMax: 6 });
    expect(resolveRk9CoordEscalatorConfig({ RK9_COORD_ESCALATE_MODE: "enforce " } as NodeJS.ProcessEnv).mode).toBe("enforce");
    expect(resolveRk9CoordEscalatorConfig({ RK9_COORD_ESCALATE_MODE: "OFF" } as NodeJS.ProcessEnv).mode).toBe("off");
    expect(resolveRk9CoordEscalatorConfig({ RK9_COORD_ESCALATE_MODE: "enforec" } as NodeJS.ProcessEnv).mode).toBe("shadow");
    expect(resolveRk9CoordEscalatorConfig({ RK9_COORD_STUCK_S: "900" } as NodeJS.ProcessEnv).stuckS).toBe(900);
    expect(resolveRk9CoordEscalatorConfig({ RK9_COORD_LEASE_STUCK_S: "1200" } as NodeJS.ProcessEnv).stuckS).toBe(1200);
    // Settings that would silently switch escalation off are clamped.
    expect(
      resolveRk9CoordEscalatorConfig({ RK9_COORD_ESCALATE_RECHECK_S: "7200", RK9_COORD_ESCALATE_DEDUPE_S: "3600" } as NodeJS.ProcessEnv)
        .recheckS,
    ).toBe(1800);
    expect(
      resolveRk9CoordEscalatorConfig({ RK9_COORD_STUCK_S: "86400", RK9_COORD_ESCALATE_LOOKBACK_S: "3600" } as NodeJS.ProcessEnv)
        .lookbackS,
    ).toBe(172_800);
    // The lookback also outlasts a long recheck.
    expect(
      resolveRk9CoordEscalatorConfig({ RK9_COORD_ESCALATE_RECHECK_S: "7200", RK9_COORD_ESCALATE_LOOKBACK_S: "3600" } as NodeJS.ProcessEnv)
        .lookbackS,
    ).toBe(1800 + 21_600 + 120);
    // The lookback outlasts stuck + dedupe + two ticks, so a failed or
    // suppressed send can still escalate again.
    expect(
      resolveRk9CoordEscalatorConfig({ RK9_COORD_ESCALATE_LOOKBACK_S: "3600" } as NodeJS.ProcessEnv).lookbackS,
    ).toBe(1800 + 21_600 + 120);
    expect(
      resolveRk9CoordEscalatorConfig({
        RK9_COORD_ESCALATE_LOOKBACK_S: "3600",
        RK9_COORD_ESCALATE_INTERVAL_MS: "600000",
      } as NodeJS.ProcessEnv).lookbackS,
    ).toBe(1800 + 21_600 + 1200);
    expect(formatRk9CoordEscalationMessage(candidate(), 900)).toContain('--reason "stuck >15 min"');
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-stall-escalator] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord stall escalator against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-stall-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "RK9 stall", issuePrefix: "RKT" });
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);

  async function makeActor(
    actorRef: string,
    fields: Partial<typeof rk9CoordActors.$inferInsert> = {},
  ): Promise<string> {
    const kind = actorRef.split(":")[0]!;
    const [row] = await db
      .insert(rk9CoordActors)
      .values({ companyId, kind, actorRef, trust: "attributed", lastSeenAt: new Date(), ...fields })
      .onConflictDoUpdate({ target: [rk9CoordActors.companyId, rk9CoordActors.actorRef], set: { ...fields } })
      .returning({ id: rk9CoordActors.id });
    return row!.id;
  }

  /** A jam at time T: holder quiet for 45 min, one waiter for 40 min that keeps polling. */
  async function stuckLease(
    resource: string,
    T: Date,
    over: {
      lease?: Partial<typeof rk9CoordLeases.$inferInsert>;
      holder?: Partial<typeof rk9CoordActors.$inferInsert>;
      waiterPollUntil?: Date;
    } = {},
  ) {
    const tag = resource.replace(/[^a-z0-9]/gi, "-");
    const holderId = await makeActor(`cc:paperclip-01:h-${tag}`, {
      host: "paperclip-01",
      issue: "RK9-629",
      phase: "deploying",
      phaseAt: at(T, -50),
      lastSeenAt: at(T, -1),
      ...over.holder,
    });
    const waiterId = await makeActor(`cc:paperclip-01:w-${tag}`, { lastSeenAt: at(T, -1) });
    const [lease] = await db
      .insert(rk9CoordLeases)
      .values({
        companyId,
        resource,
        holderActorId: holderId,
        acquiredAt: at(T, -60),
        renewedAt: at(T, -45),
        expiresAt: at(T, 48 * 60),
        ...over.lease,
      })
      .returning();
    await db.insert(rk9CoordLeaseWaiters).values({
      companyId,
      resource,
      actorId: waiterId,
      enqueuedAt: at(T, -40),
      expiresAt: over.waiterPollUntil ?? at(T, 48 * 60),
    });
    return { leaseId: lease!.id, holderId, waiterId };
  }

  const tick = (now: Date, config: Partial<Rk9CoordEscalatorConfig> = {}) =>
    runRk9CoordStallTick(db, { env: {} as NodeJS.ProcessEnv, config: { mode: "enforce", ...config }, now: () => now });

  async function ledger(prefixLike: string) {
    return db
      .select()
      .from(rk9CoordEscalations)
      .where(and(eq(rk9CoordEscalations.companyId, companyId), sql`${rk9CoordEscalations.episodeKey} like ${prefixLike}`))
      .orderBy(asc(rk9CoordEscalations.reservedAt), asc(rk9CoordEscalations.episodeKey));
  }

  async function escalatedEvents(leaseOrEvent: string) {
    return db
      .select()
      .from(rk9CoordEvents)
      .where(
        and(
          eq(rk9CoordEvents.companyId, companyId),
          eq(rk9CoordEvents.type, "escalated"),
          sql`${rk9CoordEvents.payload} ->> 'episode_key' like ${`${leaseOrEvent}#%`}`,
        ),
      )
      .orderBy(asc(rk9CoordEvents.id));
  }

  it("nudges the holder first, then escalates exactly once and suppresses repeated ticks", async () => {
    const T = new Date("2026-01-05T10:00:00Z");
    const { leaseId, holderId } = await stuckLease("prod:stuck-once", T);

    expect(await tick(T)).toMatchObject({ nudged: 1, escalated: 0 });
    const inbox = await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.toActorId, holderId));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "stall_nudge", fromActorRef: RK9_COORD_ESCALATOR_ACTOR });
    expect(inbox[0]!.body).toContain("prod:stuck-once");
    expect(await ledger(`nudge:lease:${leaseId}#%`)).toHaveLength(1);
    expect(await escalatedEvents(`lease:${leaseId}`)).toHaveLength(0);

    // Before the recheck: still waiting, no second nudge.
    expect(await tick(at(T, 5))).toMatchObject({ waiting: 1, nudged: 0, escalated: 0 });

    // Recheck: the jam persists -> one reservation and one escalated event.
    expect(await tick(at(T, 11))).toMatchObject({ escalated: 1 });
    const rows = await ledger(`lease:${leaseId}#%`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "reserved", mode: "enforce", reason: "lease_stuck", resource: "prod:stuck-once", issue: "RK9-629" });
    const events = await escalatedEvents(`lease:${leaseId}`);
    expect(events).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(events[0]!.id);
    expect(events[0]).toMatchObject({ actorRef: RK9_COORD_ESCALATOR_ACTOR, actorKind: "orch", resource: "prod:stuck-once", issue: "RK9-629" });
    expect(events[0]!.payload).toMatchObject({
      escalation_id: rows[0]!.id,
      reason: "lease_stuck",
      mode: "enforce",
      resource: "prod:stuck-once",
      lease_id: leaseId,
      holder: "cc:paperclip-01:h-prod-stuck-once",
      holder_kind: "cc",
      holder_host: "paperclip-01",
      holder_issue: "RK9-629",
      holder_phase: "deploying",
      waiter: "cc:paperclip-01:w-prod-stuck-once",
      waiters: 1,
      waited_s: 51 * 60,
      age_s: 56 * 60,
      breakable: true,
      cap: { limit: 6, used: 1, exceeded: false },
      break_command: 'rk9 lease break prod:stuck-once --reason "stuck >30 min"',
    });
    expect(String(events[0]!.payload.message)).toContain("rk9 lease break prod:stuck-once");
    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, rows[0]!.id)));
    expect(activity.map((row) => row.action)).toEqual(["rk9.coord.escalation_reserved"]);

    // Repeated ticks of the same episode, inside the 6 h dedupe window: nothing new.
    for (const min of [12, 30, 120, 300]) {
      expect(await tick(at(T, min))).toMatchObject({ escalated: 0, nudged: 0 });
    }
    expect(await ledger(`lease:${leaseId}#%`)).toHaveLength(1);
    expect(await ledger(`nudge:lease:${leaseId}#%`)).toHaveLength(1);
    expect(await escalatedEvents(`lease:${leaseId}`)).toHaveLength(1);
  });

  it("reserves once when two servers tick the same jam concurrently", async () => {
    const T = new Date("2026-02-05T10:00:00Z");
    const { leaseId } = await stuckLease("prod:stuck-race", T);
    await Promise.all([tick(T), tick(T)]);
    expect(await ledger(`nudge:lease:${leaseId}#%`)).toHaveLength(1);
    await Promise.all([tick(at(T, 11)), tick(at(T, 11)), tick(at(T, 11))]);
    expect(await ledger(`lease:${leaseId}#%`)).toHaveLength(1);
    expect(await escalatedEvents(`lease:${leaseId}`)).toHaveLength(1);
  });

  it("never nudges or escalates a self-resolving case", async () => {
    const T = new Date("2026-03-05T10:00:00Z");
    const cases = [
      await stuckLease("prod:sr-renewed", T, { lease: { renewedAt: at(T, -5) } }),
      await stuckLease("prod:sr-phase", T, { holder: { phaseAt: at(T, -2) } }),
      await stuckLease("prod:sr-released", T, { lease: { releasedAt: at(T, -1), releaseReason: "released" } }),
      await stuckLease("prod:sr-ttl", T, { lease: { expiresAt: at(T, -1) } }),
      await stuckLease("prod:sr-expiring", T, { lease: { expiresAt: at(T, 5) } }),
      await stuckLease("repo:o/sr-dead@main", T, { holder: { lastSeenAt: at(T, -120) } }),
      await stuckLease("prod:sr-ended", T, { holder: { endedAt: at(T, -10) } }),
      await stuckLease("prod:sr-nopoll", T, { waiterPollUntil: at(T, -1) }),
    ];
    // Up to T+20: the renew (T-5) and the phase change (T-2) are still inside stuckS.
    for (const min of [0, 11, 20]) {
      const result = await tick(at(T, min));
      expect(result).toMatchObject({ nudged: 0, escalated: 0, shadow: 0, suppressed: 0 });
    }
    for (const { leaseId, holderId } of cases) {
      expect(await ledger(`%lease:${leaseId}#%`)).toHaveLength(0);
      expect(await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.toActorId, holderId))).toHaveLength(0);
    }

    // Progress after the nudge resolves the jam: no escalation at the recheck.
    const { leaseId } = await stuckLease("prod:sr-after-nudge", T);
    expect(await tick(T)).toMatchObject({ nudged: 1 });
    await db.update(rk9CoordLeases).set({ renewedAt: at(T, 3) }).where(eq(rk9CoordLeases.id, leaseId));
    expect(await tick(at(T, 11))).toMatchObject({ escalated: 0 });
    expect(await tick(at(T, 20))).toMatchObject({ escalated: 0 });
    expect(await ledger(`lease:${leaseId}#%`)).toHaveLength(0);
  });

  it("starts a new round (nudge, then recheck) when the holder progresses and stalls again", async () => {
    const T = new Date("2026-03-20T10:00:00Z");
    const { leaseId } = await stuckLease("prod:round", T);
    expect(await tick(T)).toMatchObject({ nudged: 1 });
    // The holder renews at T+5 and then stalls again for stuckS.
    await db.update(rk9CoordLeases).set({ renewedAt: at(T, 5) }).where(eq(rk9CoordLeases.id, leaseId));
    expect(await tick(at(T, 34))).toMatchObject({ nudged: 0, escalated: 0 });
    // T+36: stuck again. The old nudge predates the progress: a new nudge, no escalation yet.
    expect(await tick(at(T, 36))).toMatchObject({ nudged: 1, escalated: 0 });
    expect(await ledger(`nudge:lease:${leaseId}#%`)).toHaveLength(2);
    expect(await tick(at(T, 40))).toMatchObject({ waiting: 1, escalated: 0 });
    expect(await tick(at(T, 47))).toMatchObject({ escalated: 1 });
    // Delivered: no repeat after the dedupe window while nothing changes.
    expect(await tick(at(T, 47 + 7 * 60))).toMatchObject({ nudged: 0, escalated: 0, deduped: 1 });
    // Progress after the escalation and a new stall: a new round, a new escalation.
    await db.update(rk9CoordLeases).set({ renewedAt: at(T, 8 * 60) }).where(eq(rk9CoordLeases.id, leaseId));
    expect(await tick(at(T, 8 * 60 + 31))).toMatchObject({ nudged: 1 });
    expect(await tick(at(T, 8 * 60 + 42))).toMatchObject({ escalated: 1 });
    expect((await ledger(`lease:${leaseId}#%`)).map((row) => row.episodeKey)).toEqual([`lease:${leaseId}#1`, `lease:${leaseId}#2`]);
  });

  it("applies the daily cap, counts a failed send, never retries it, and allows a new escalation after the window", async () => {
    const T = new Date("2026-04-05T10:00:00Z");
    const jams = [
      await stuckLease("prod:cap-a", T),
      await stuckLease("prod:cap-b", T),
      await stuckLease("prod:cap-c", T),
    ];
    const cfg = { dayMax: 2 };
    expect(await tick(T, cfg)).toMatchObject({ nudged: 3 });
    expect(await tick(at(T, 11), cfg)).toMatchObject({ escalated: 2, suppressed: 1 });
    const all = (await Promise.all(jams.map(({ leaseId }) => ledger(`lease:${leaseId}#%`)))).flat();
    expect(all.map((row) => row.status).sort()).toEqual(["reserved", "reserved", "suppressed"]);
    const suppressed = all.find((row) => row.status === "suppressed")!;
    expect(suppressed).toMatchObject({ error: "daily_cap", eventId: null });

    // rk9claude reports a failed send: the row stays failed and still counts.
    const reserved = all.filter((row) => row.status === "reserved");
    await db.update(rk9CoordEscalations).set({ status: "failed", error: "tg 502" }).where(eq(rk9CoordEscalations.id, reserved[0]!.id));
    expect(await tick(at(T, 20), cfg)).toMatchObject({ escalated: 0, suppressed: 0, nudged: 0 });
    expect(await tick(at(T, 120), cfg)).toMatchObject({ escalated: 0, suppressed: 0, nudged: 0 });

    // After the dedupe window (6 h) and the cap window (24 h): the failed and
    // the suppressed jam (never seen by the operator) get a new round; the
    // delivered one is not repeated while the jam is unchanged.
    expect(await tick(at(T, 25 * 60), cfg)).toMatchObject({ nudged: 2 });
    expect(await tick(at(T, 25 * 60 + 11), cfg)).toMatchObject({ escalated: 2, suppressed: 0 });
    const keysOf = async (leaseId: string) => (await ledger(`lease:${leaseId}#%`)).map((row) => row.episodeKey);
    const failedJam = jams.find(({ leaseId }) => reserved[0]!.episodeKey.startsWith(`lease:${leaseId}#`))!;
    const suppressedJam = jams.find(({ leaseId }) => suppressed.episodeKey.startsWith(`lease:${leaseId}#`))!;
    const deliveredJam = jams.find((jam) => jam !== failedJam && jam !== suppressedJam)!;
    expect(await keysOf(failedJam.leaseId)).toEqual([`lease:${failedJam.leaseId}#1`, `lease:${failedJam.leaseId}#2`]);
    expect(await keysOf(suppressedJam.leaseId)).toEqual([`lease:${suppressedJam.leaseId}#1`, `lease:${suppressedJam.leaseId}#2`]);
    expect(await keysOf(deliveredJam.leaseId)).toEqual([`lease:${deliveredJam.leaseId}#1`]);
  });

  it("shadow mode writes shadow rows and events with mode=shadow, and counts its own cap", async () => {
    const T = new Date("2026-05-05T10:00:00Z");
    const { leaseId } = await stuckLease("prod:shadow-1", T);
    const shadow = { mode: "shadow" as const };
    expect(await tick(T, shadow)).toMatchObject({ mode: "shadow", nudged: 1 });
    expect(await tick(at(T, 11), shadow)).toMatchObject({ shadow: 1, escalated: 0 });
    const [row] = await ledger(`lease:${leaseId}#%`);
    expect(row).toMatchObject({ status: "shadow", mode: "shadow" });
    const [event] = await escalatedEvents(`lease:${leaseId}`);
    expect(event!.payload).toMatchObject({ mode: "shadow", escalation_id: row!.id });
    // Mode off does nothing at all.
    expect(await tick(at(T, 600), { mode: "off" })).toMatchObject({ mode: "off", candidates: 0 });
    // Switch to enforce: the shadow row never reached the operator, so the
    // unchanged jam gets a new round after the dedupe window.
    expect(await tick(at(T, 2 * 60), { mode: "enforce" })).toMatchObject({ deduped: 1, nudged: 0 });
    expect(await tick(at(T, 7 * 60), { mode: "enforce" })).toMatchObject({ nudged: 1 });
    expect(await tick(at(T, 7 * 60 + 11), { mode: "enforce" })).toMatchObject({ escalated: 1 });
    expect((await ledger(`lease:${leaseId}#%`)).map((r) => [r.mode, r.status])).toEqual([
      ["shadow", "shadow"],
      ["enforce", "reserved"],
    ]);
    // A mode flap (or a second server in the other mode) does not repeat the
    // delivered jam: a row of each mode now exists after the last progress.
    expect(await tick(at(T, 14 * 60), { mode: "shadow" })).toMatchObject({ deduped: 1, nudged: 0 });
    expect(await tick(at(T, 14 * 60 + 11), { mode: "enforce" })).toMatchObject({ deduped: 1, nudged: 0 });
    expect(await ledger(`lease:${leaseId}#%`)).toHaveLength(2);
  });

  it("escalates an unanswered blocker and ask-operator, but not answered ones or rk9claude's", async () => {
    const T = new Date("2026-06-05T10:00:00Z");
    const authorId = await makeActor("worktree:RKT-1", { issue: "RKT-1", lastSeenAt: at(T, -1) });
    const insertEvent = async (values: Partial<typeof rk9CoordEvents.$inferInsert>) => {
      const [row] = await db
        .insert(rk9CoordEvents)
        .values({
          companyId,
          type: "blocker",
          actorRef: "worktree:RKT-1",
          actorKind: "worktree",
          trust: "attributed",
          summary: "blocked",
          payload: {},
          createdAt: at(T, -40),
          ...values,
        })
        .returning({ id: rk9CoordEvents.id });
      return row!.id;
    };
    const blocker = await insertEvent({ issue: "RKT-1", summary: "need migrate:paperclip window" });
    const ask = await insertEvent({
      type: "ask-operator",
      actorRef: "cc:paperclip-01:asker",
      actorKind: "cc",
      issue: "RKT-2",
      summary: "[high] merge now?",
      createdAt: at(T, -35),
    });
    const answered = await insertEvent({ type: "ask-operator", issue: "RKT-3", summary: "[low] ok?" });
    await insertEvent({ type: "decision", actorRef: "operator", actorKind: "operator", summary: "yes", refEventId: answered, createdAt: at(T, -30) });
    const sameIssue = await insertEvent({ issue: "RKT-4", summary: "stuck" });
    await insertEvent({ type: "done", issue: "RKT-4", summary: "RKT-4 done", createdAt: at(T, -20) });
    const byRk9claude = await insertEvent({ actorRef: "rk9claude", actorKind: "rk9claude", issue: "RKT-5", summary: "alert" });
    const viaHeadsup = await insertEvent({ issue: "RKT-6", summary: "stuck too" });
    await insertEvent({ type: "headsup", actorRef: "cc:paperclip-01:x", actorKind: "cc", issue: "RKT-6", summary: "heads up", createdAt: at(T, -20) });
    // The asker's own decision on the issue does not answer its question.
    const ownDecision = await insertEvent({
      type: "ask-operator",
      actorRef: "cc:paperclip-01:asker2",
      actorKind: "cc",
      issue: "RKT-7",
      summary: "[normal] which db?",
    });
    await insertEvent({ type: "decision", actorRef: "cc:paperclip-01:asker2", actorKind: "cc", issue: "RKT-7", summary: "picked one", createdAt: at(T, -30) });
    // An unverified actor cannot silence a blocker, and an unverified author is not escalated.
    const grokReply = await insertEvent({ issue: "RKT-8", summary: "stuck 8" });
    await insertEvent({ type: "handoff", actorRef: "grok", actorKind: "grok", trust: "unverified", issue: "RKT-8", summary: "x", createdAt: at(T, -30) });
    const byRemote = await insertEvent({ actorRef: "remote:mv-laptop:a", actorKind: "remote", trust: "unverified", issue: "RKT-9", summary: "r" });

    expect(await tick(T)).toMatchObject({ nudged: 5 });
    const toAuthor = await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.toActorId, authorId));
    // blocker, viaHeadsup and grokReply are by worktree:RKT-1.
    expect(toAuthor.map((row) => row.kind)).toEqual(["stall_nudge", "stall_nudge", "stall_nudge"]);
    // The ask-operator author has no actor row: the nudge goes to its issue.
    const toIssue = await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.toIssue, "RKT-2"));
    expect(toIssue).toHaveLength(1);

    expect(await tick(at(T, 11))).toMatchObject({ escalated: 5 });
    const blockerEvents = await escalatedEvents(`event:${blocker}`);
    expect(blockerEvents).toHaveLength(1);
    expect(blockerEvents[0]).toMatchObject({ refEventId: blocker, issue: "RKT-1" });
    expect(blockerEvents[0]!.payload).toMatchObject({ reason: "blocker_unanswered", breakable: false, source_event_id: blocker, lease_id: null });
    const [askEvent] = await escalatedEvents(`event:${ask}`);
    expect(askEvent!.payload).toMatchObject({ reason: "ask_operator_unanswered" });
    // The question text reaches only rk9claude and the operator: no issue, repo or resource routing.
    expect(askEvent).toMatchObject({ issue: null, repo: null, resource: null });
    expect(await escalatedEvents(`event:${ownDecision}`)).toHaveLength(1);
    expect(await escalatedEvents(`event:${grokReply}`)).toHaveLength(1);
    expect(await ledger(`%event:${byRemote}#%`)).toHaveLength(0);
    expect(await escalatedEvents(`event:${viaHeadsup}`)).toHaveLength(1);
    for (const id of [answered, sameIssue, byRk9claude]) {
      expect(await ledger(`%event:${id}#%`)).toHaveLength(0);
    }
    // The escalator's own events are no follow-up and are never escalated themselves;
    // a delivered event escalation is not repeated after the dedupe window.
    expect(await tick(at(T, 30))).toMatchObject({ escalated: 0, nudged: 0 });
    expect(await tick(at(T, 7 * 60))).toMatchObject({ escalated: 0, nudged: 0 });
  });

  it("counts only operator-side answers and the author's own progress; a shared issue mutes nothing (RK9-657, RK9-662, RK9-677)", async () => {
    const T = new Date("2026-07-10T10:00:00Z");
    const [agentA, agentB] = await db
      .insert(agents)
      .values(
        ["Stall A", "Stall B"].map((name) => ({
          companyId,
          name,
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
        })),
      )
      .returning();
    const [runA1, runA2, runB1] = await db
      .insert(heartbeatRuns)
      .values([
        { companyId, agentId: agentA!.id, status: "running" },
        { companyId, agentId: agentA!.id, status: "succeeded" },
        { companyId, agentId: agentB!.id, status: "running" },
      ])
      .returning();
    const runRef = (run: { id: string }) => `agent_run:${run.id}`;
    const insertEvent = async (values: Partial<typeof rk9CoordEvents.$inferInsert>) => {
      const [row] = await db
        .insert(rk9CoordEvents)
        .values({
          companyId,
          type: "blocker",
          actorRef: "worktree:RKU-0",
          actorKind: "worktree",
          trust: "attributed",
          summary: "blocked",
          payload: {},
          createdAt: at(T, -40),
          ...values,
        })
        .returning({ id: rk9CoordEvents.id });
      return row!.id;
    };
    const later = { createdAt: at(T, -30) };
    const ask = (issue: string, over: Partial<typeof rk9CoordEvents.$inferInsert> = {}) =>
      insertEvent({ type: "ask-operator", issue, summary: `[normal] ${issue}?`, ...over });
    const hostCc = { actorRef: "cc:mv-laptop:s1", actorKind: "cc", trust: "unverified" };
    const boardCc = { actorRef: "cc:paperclip-01:s1", actorKind: "cc", trust: "attributed" };
    const rk9claude = { actorRef: "rk9claude", actorKind: "rk9claude", trust: "verified" };
    const otherRun = { actorRef: runRef(runB1!), actorKind: "agent_run", trust: "verified" };

    // ask-operator
    const hostCcReply = await ask("RKU-1");
    await insertEvent({ type: "ask-operator", ...hostCc, summary: "[low] yes", refEventId: hostCcReply, ...later });
    const agentReply = await ask("RKU-2");
    await insertEvent({ type: "ask-operator", ...otherRun, summary: "[low] yes", refEventId: agentReply, ...later });
    const boardCcReply = await ask("RKU-3");
    await insertEvent({ type: "ask-operator", ...boardCc, summary: "[low] yes", refEventId: boardCcReply, ...later });
    const operatorOnIssue = await ask("RKU-4");
    await insertEvent({ type: "decision", actorRef: "operator", actorKind: "operator", issue: "RKU-4", summary: "go", ...later });
    const sharedAsk = await ask("RKU-5");
    await insertEvent({ ...rk9claude, issue: "RKU-5", summary: "alert", ...later });
    await insertEvent({ type: "done", ...rk9claude, issue: "RKU-5", summary: "RKU-5 done", ...later });
    const askerDone = await ask("RKU-6", { actorRef: runRef(runA1!), actorKind: "agent_run", trust: "verified" });
    await insertEvent({ type: "done", actorRef: runRef(runA2!), actorKind: "agent_run", trust: "verified", issue: "RKU-6", summary: "done", ...later });
    const otherDone = await ask("RKU-7");
    await insertEvent({ type: "done", ...otherRun, issue: "RKU-7", summary: "RKU-7 done", ...later });
    // The asker's own reply_to or phase does not answer its question.
    const selfReply = await ask("RKU-13");
    await insertEvent({ type: "ask-operator", summary: "[low] still?", refEventId: selfReply, ...later });
    // blocker
    const sharedBlocker = await insertEvent({ issue: "RKU-8", summary: "waits" });
    await insertEvent({ ...rk9claude, issue: "RKU-8", summary: "alert", ...later });
    await insertEvent({ type: "done", ...rk9claude, issue: "RKU-8", summary: "RKU-8 done", ...later });
    const siblingRun = await insertEvent({ actorRef: runRef(runA1!), actorKind: "agent_run", trust: "verified", issue: "RKU-9" });
    await insertEvent({ type: "handoff", actorRef: runRef(runA2!), actorKind: "agent_run", trust: "verified", issue: "RKU-9", summary: "moved", ...later });
    const otherAgent = await insertEvent({ actorRef: runRef(runA1!), actorKind: "agent_run", trust: "verified", issue: "RKU-10" });
    await insertEvent({ type: "handoff", ...otherRun, issue: "RKU-10", summary: "not mine", ...later });
    const boardCcOnBlocker = await insertEvent({ issue: "RKU-11" });
    await insertEvent({ type: "handoff", ...boardCc, issue: "RKU-11", summary: "unblocked", ...later });
    const ownProgress = await insertEvent({ issue: "RKU-12" });
    await insertEvent({ type: "handoff", issue: "RKU-12", summary: "moved on", ...later });
    // A resource match by the operator side answers; by another agent it does not.
    const operatorOnResource = await ask("RKU-14", { resource: "prod:rku14" });
    await insertEvent({ type: "decision", actorRef: "operator", actorKind: "operator", resource: "prod:rku14", summary: "ok", ...later });
    const agentOnResource = await ask("RKU-15", { resource: "prod:rku15" });
    await insertEvent({ type: "decision", ...otherRun, resource: "prod:rku15", summary: "ok", ...later });
    // A cc asker closes its own question with done; a board cc's reply_to answers it.
    const ccAskerDone = await ask("RKU-16", boardCc);
    await insertEvent({ type: "done", ...boardCc, issue: "RKU-16", summary: "done", ...later });

    await tick(T);
    const nudged = async (id: number) => (await ledger(`%event:${id}#%`)).length > 0;
    for (const [name, id] of Object.entries({ hostCcReply, agentReply, sharedAsk, otherDone, selfReply, sharedBlocker, otherAgent, agentOnResource })) {
      expect(await nudged(id), `${name} stays unanswered`).toBe(true);
    }
    for (const [name, id] of Object.entries({ boardCcReply, operatorOnIssue, askerDone, siblingRun, boardCcOnBlocker, ownProgress, operatorOnResource, ccAskerDone })) {
      expect(await nudged(id), `${name} is answered`).toBe(false);
    }
  });

  describe("routes", () => {
    const rk9claude: Rk9CoordTokenPrincipal = { tokenId: "t-svc", companyId, principalKind: "service", principalName: "rk9claude" };
    const none = { type: "none", source: "none" } as Actor;
    const boardKey = (): Actor =>
      ({
        type: "board",
        userId: "operator-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: true,
        keyId: "board-key-1",
        source: "board_key",
      }) as Actor;

    function appFor(actor: Actor, principal?: Rk9CoordTokenPrincipal) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actor;
        if (principal) req.rk9CoordPrincipal = principal;
        next();
      });
      app.use("/api", rk9CoordRoutes(db, { boardHost: "paperclip-01", boardKeyIds: null, findAgentRun: async () => null }));
      app.use(errorHandler);
      return app;
    }
    const coord = `/api/companies/${companyId}/rk9/coord`;
    const asSvc = () => appFor(none, rk9claude);

    it("acks a reserved escalation once, only as rk9claude or the operator, and reports it", async () => {
      // Real clock: the delta's new-cursor lookback is relative to the DB time.
      const T = new Date();
      const { leaseId } = await stuckLease("prod:route-ack", T);
      await tick(T, { dayMax: 100 });
      await tick(at(T, 11), { dayMax: 100 });
      const [row] = await ledger(`lease:${leaseId}#%`);
      expect(row!.status).toBe("reserved");

      const report = await request(appFor(boardKey())).get(`${coord}/escalations`);
      expect(report.status).toBe(200);
      expect(report.body).toMatchObject({ mode: "shadow", config: { stuck_s: 1800, recheck_s: 600, day_max: 6 } });
      const listed = report.body.escalations.find((e: { id: string }) => e.id === row!.id);
      expect(listed).toMatchObject({ kind: "escalation", status: "reserved", resource: "prod:route-ack" });
      expect(listed.message).toContain("prod:route-ack");
      expect(report.body.escalations.every((e: { kind: string }) => e.kind === "escalation")).toBe(true);
      const withNudges = await request(appFor(boardKey())).get(`${coord}/escalations?nudges=true&limit=200`);
      expect(withNudges.body.escalations.some((e: { kind: string }) => e.kind === "nudge")).toBe(true);
      const reserved = await request(appFor(boardKey())).get(`${coord}/escalations?status=reserved&limit=200`);
      expect(reserved.body.escalations.every((e: { status: string }) => e.status === "reserved")).toBe(true);

      // rk9claude sees the escalated event in its delta.
      const delta = await request(asSvc()).get(`${coord}/events/delta`).set("X-RK9-Actor", "rk9claude");
      expect(delta.status).toBe(200);
      const seen = delta.body.events.filter((e: { type: string }) => e.type === "escalated");
      expect(seen.some((e: { payload: { escalation_id: string } }) => e.payload.escalation_id === row!.id)).toBe(true);

      const byCc = await request(appFor(boardKey()))
        .post(`${coord}/escalations/${row!.id}/ack`)
        .set("X-RK9-Actor", "cc:paperclip-01:someone")
        .send({ status: "sent" });
      expect(byCc.status).toBe(403);
      expect(byCc.body.code).toBe("rk9_coord_escalation_ack_forbidden");

      const ok = await request(asSvc())
        .post(`${coord}/escalations/${row!.id}/ack`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ status: "sent", channel_message_id: "4711" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: row!.id, status: "sent", channel_message_id: "4711" });
      expect(ok.body.sent_at).toBeTruthy();
      const again = await request(asSvc())
        .post(`${coord}/escalations/${row!.id}/ack`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ status: "failed", error: "late" });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("rk9_coord_escalation_not_reserved");
      const missing = await request(asSvc())
        .post(`${coord}/escalations/${randomUUID()}/ack`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ status: "sent" });
      expect(missing.status).toBe(404);
      const notUuid = await request(asSvc()).post(`${coord}/escalations/nope/ack`).set("X-RK9-Actor", "rk9claude").send({ status: "sent" });
      expect(notUuid.status).toBe(404);
      const badBody = await request(asSvc())
        .post(`${coord}/escalations/${row!.id}/ack`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ status: "delivered" });
      expect(badBody.status).toBe(400);
      const acks = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, row!.id)));
      expect(acks.map((a) => a.action).sort()).toEqual(["rk9.coord.escalation_reserved", "rk9.coord.escalation_sent"]);
    });

    it("hides the question text, resource and issue of an ask escalation from agent runs, grok, worktree and headless on GET /escalations (RK9-657, RK9-689)", async () => {
      const runId = randomUUID();
      const agentId = randomUUID();
      const agentApp = () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = {
            type: "agent",
            agentId,
            companyId,
            runId,
            source: "agent_jwt",
            keyScope: { kind: "standard" },
          } as unknown as Actor;
          next();
        });
        app.use(
          "/api",
          rk9CoordRoutes(db, {
            boardHost: "paperclip-01",
            boardKeyIds: null,
            findAgentRun: async (id) => (id === runId ? { companyId, agentId, status: "running" } : null),
          }),
        );
        app.use(errorHandler);
        return app;
      };
      const [askRow, leaseRow] = await db
        .insert(rk9CoordEscalations)
        .values([
          {
            companyId,
            episodeKey: `event:${randomUUID()}#1`,
            reason: "ask_operator_unanswered",
            mode: "shadow",
            status: "shadow",
            resource: "repo:rks",
            issue: "RKS-7",
            message: "What: [high] rotate sigma keys?",
          },
          {
            companyId,
            episodeKey: `lease:${randomUUID()}#1`,
            reason: "lease_stuck",
            mode: "shadow",
            status: "shadow",
            resource: "prod:sigma",
            issue: "RKS-8",
            message: "Coord jam: prod:sigma",
          },
        ])
        .returning();
      type View = { id: string; message: string | null; resource: string | null; issue: string | null };
      const find = (res: request.Response, id: string) => (res.body.escalations as View[]).find((row) => row.id === id);
      const grokApp = () => appFor(none, { tokenId: "t-g", companyId, principalKind: "service", principalName: "grok" });
      // RK9-689: worktree and headless claims on the board key are restricted too.
      const claimApp = (claim: string) => ({ app: appFor(boardKey()), claim });
      const restricted = [
        { app: agentApp(), claim: null },
        { app: grokApp(), claim: null },
        claimApp("worktree:RKS-1"),
        claimApp("headless:run-s1"),
      ];
      for (const { app, claim } of restricted) {
        const req = request(app).get(`${coord}/escalations?limit=200`);
        const res = claim ? await req.set("X-RK9-Actor", claim) : await req;
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain("sigma keys");
        // Low 1: the hidden view drops resource and issue too, as the board does.
        expect(find(res, askRow!.id)).toMatchObject({ message: null, resource: null, issue: null });
        // A lease jam keeps its resource and issue for every reader.
        expect(find(res, leaseRow!.id)).toMatchObject({ resource: "prod:sigma", issue: "RKS-8" });
      }
      // Low 2: grok is withText false anyway; only the askText rule nulls the ask row's resource and issue.
      const grokRes = await request(grokApp()).get(`${coord}/escalations?limit=200`);
      expect(find(grokRes, leaseRow!.id)!.message).toBeNull();
      expect(find(grokRes, askRow!.id)).toMatchObject({ resource: null, issue: null });
      const service = rk9CoordEscalationService(db);
      const unverifiedNoAskRule = await service.list(companyId, { withText: false, limit: 200 });
      expect(unverifiedNoAskRule.find((row) => row.id === askRow!.id)).toMatchObject({ message: null, resource: "repo:rks", issue: "RKS-7" });
      const textNoAsk = await service.list(companyId, { withText: true, askText: false, limit: 200 });
      expect(textNoAsk.find((row) => row.id === askRow!.id)).toMatchObject({ message: null, resource: null, issue: null });
      expect(textNoAsk.find((row) => row.id === leaseRow!.id)!.message).toBe("Coord jam: prod:sigma");
      // An agent run still reads a lease jam's text; the operator side and orch read both.
      const agentRes = await request(agentApp()).get(`${coord}/escalations?limit=200`);
      expect(find(agentRes, leaseRow!.id)!.message).toBe("Coord jam: prod:sigma");
      for (const res of [
        await request(appFor(boardKey())).get(`${coord}/escalations?limit=200`),
        await request(appFor(boardKey())).get(`${coord}/escalations?limit=200`).set("X-RK9-Actor", "orch:rk9-orchestrator"),
      ]) {
        expect(find(res, askRow!.id)).toMatchObject({
          message: "What: [high] rotate sigma keys?",
          resource: "repo:rks",
          issue: "RKS-7",
        });
      }
    });

    it("shows a failed escalation on the board and refuses to ack a shadow row", async () => {
      const T = new Date();
      const { leaseId } = await stuckLease("prod:route-failed", T);
      await tick(T, { dayMax: 100 });
      await tick(at(T, 11), { dayMax: 100 });
      const [row] = await ledger(`lease:${leaseId}#%`);
      const failed = await request(asSvc())
        .post(`${coord}/escalations/${row!.id}/ack`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ status: "failed", error: "telegram 502" });
      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({ status: "failed", error: "telegram 502" });
      const board = await request(appFor(boardKey())).get(`${coord}/board`);
      expect(board.status).toBe(200);
      expect(board.body.escalations_attention).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: row!.id, status: "failed", resource: "prod:route-failed" })]),
      );

      // A capped (suppressed) escalation is on the board too.
      const cappedJam = await stuckLease("prod:route-capped", T);
      await tick(T, { dayMax: 0 });
      await tick(at(T, 11), { dayMax: 0 });
      const [capped] = await ledger(`lease:${cappedJam.leaseId}#%`);
      expect(capped).toMatchObject({ status: "suppressed", error: "daily_cap" });
      const board2 = await request(appFor(boardKey())).get(`${coord}/board`);
      expect(board2.body.escalations_attention).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: capped!.id, status: "suppressed", error: "daily_cap" })]),
      );

      const shadowJam = await stuckLease("prod:route-shadow", T);
      await tick(T, { mode: "shadow", dayMax: 100 });
      await tick(at(T, 11), { mode: "shadow", dayMax: 100 });
      const [shadowRow] = await ledger(`lease:${shadowJam.leaseId}#%`);
      expect(shadowRow!.status).toBe("shadow");

      // A suppressed shadow row is only a dry run: not on the board.
      const shadowCapped = await stuckLease("prod:route-shadow-capped", T);
      await tick(T, { mode: "shadow", dayMax: 0 });
      await tick(at(T, 11), { mode: "shadow", dayMax: 0 });
      const [shadowCappedRow] = await ledger(`lease:${shadowCapped.leaseId}#%`);
      expect(shadowCappedRow).toMatchObject({ status: "suppressed", mode: "shadow" });
      const board3 = await request(appFor(boardKey())).get(`${coord}/board`);
      expect(board3.body.escalations_attention.map((r: { id: string }) => r.id)).not.toContain(shadowCappedRow!.id);
      const refused = await request(asSvc())
        .post(`${coord}/escalations/${shadowRow!.id}/ack`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ status: "sent" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("rk9_coord_escalation_not_reserved");
    });

    it("breaks only the escalated lease when lease_id is given", async () => {
      const resource = "prod:route-break";
      const holder = "cc:paperclip-01:brk-holder";
      const got = await request(appFor(boardKey()))
        .post(`${coord}/leases/acquire`)
        .set("X-RK9-Actor", holder)
        .send({ resource, ttl_s: 600 });
      expect(got.status).toBe(200);
      const changed = await request(asSvc())
        .post(`${coord}/leases/break`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ resource, lease_id: randomUUID(), reason: "operator via TG" });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe("rk9_coord_lease_changed");
      const [still] = await db.select().from(rk9CoordLeases).where(eq(rk9CoordLeases.id, got.body.lease_id));
      expect(still!.releasedAt).toBeNull();
      const badId = await request(asSvc())
        .post(`${coord}/leases/break`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ resource, lease_id: "not-a-uuid", reason: "operator via TG" });
      expect(badId.status).toBe(400);
      const broken = await request(asSvc())
        .post(`${coord}/leases/break`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ resource, lease_id: got.body.lease_id, reason: "operator via TG" });
      expect(broken.status).toBe(200);
      expect(broken.body).toMatchObject({ broken: true, previous_holder: holder, release_reason: "operator_break" });
      const gone = await request(asSvc())
        .post(`${coord}/leases/break`)
        .set("X-RK9-Actor", "rk9claude")
        .send({ resource, lease_id: got.body.lease_id, reason: "operator via TG" });
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe("rk9_coord_lease_not_found");
      // The break is journaled and has an activity row (lease engine, RK9-627).
      const breakEvents = await db
        .select({ payload: rk9CoordEvents.payload })
        .from(rk9CoordEvents)
        .where(and(eq(rk9CoordEvents.resource, resource), sql`${rk9CoordEvents.payload} ->> 'subtype' = 'break'`));
      expect(breakEvents).toHaveLength(1);
      const breakActivity = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(eq(activityLog.action, "rk9.coord.lease_break"), sql`${activityLog.details} ->> 'resource' = ${resource}`));
      expect(breakActivity).toHaveLength(1);
    });
  });
});
