// RK9 Custom (RK9-627): coord lease sweeper against real Postgres: TTL
// expiry, dead-holder release per liveness source, FIFO promotion that skips
// dead waiters, inbox notification, stuck signal, idempotent re-runs and
// concurrent ticks. Contract: docs/implementation-notes/coord-leases.md.
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
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeaseWaiters,
  rk9CoordLeases,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import {
  resolveRk9CoordLeaseDeadGraceS,
  rk9CoordLeaseActorVerdict,
  rk9CoordLeaseWaiterAlive,
  sweepRk9CoordLeases,
} from "../services/rk9-coord-leases.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Actor = Express.Request["actor"];

describe("coord lease liveness rule", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const old = new Date("2026-11-02T11:00:00Z");
  const fresh = new Date("2026-11-02T11:59:00Z");
  const opts = { now, graceS: 300, hardGate: false, lastActivityAt: old };
  const hard = { ...opts, hardGate: true };

  it("maps each liveness source to its release reason", () => {
    expect(rk9CoordLeaseActorVerdict({ kind: "cc", endedAt: null, lastSeenAt: old, runStatus: null }, opts)).toEqual({
      alive: false,
      reason: "presence_stale",
    });
    expect(rk9CoordLeaseActorVerdict({ kind: "headless", endedAt: fresh, lastSeenAt: fresh, runStatus: null }, hard)).toEqual({
      alive: false,
      reason: "headless_run_ended",
    });
    expect(rk9CoordLeaseActorVerdict({ kind: "remote", endedAt: null, lastSeenAt: old, runStatus: null }, opts)).toEqual({
      alive: false,
      reason: "remote_heartbeat_ttl",
    });
    for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) {
      expect(rk9CoordLeaseActorVerdict({ kind: "agent_run", endedAt: null, lastSeenAt: fresh, runStatus: status }, opts)).toEqual({
        alive: false,
        reason: "heartbeat_run_terminal",
      });
    }
  });

  it("is conservative for live signals, unknown runs and the operator", () => {
    expect(rk9CoordLeaseActorVerdict({ kind: "cc", endedAt: null, lastSeenAt: fresh, runStatus: null }, opts).alive).toBe(true);
    // A recent renew keeps a holder live even without a presence heartbeat.
    expect(
      rk9CoordLeaseActorVerdict(
        { kind: "worktree", endedAt: null, lastSeenAt: old, runStatus: null },
        { ...opts, lastActivityAt: fresh },
      ).alive,
    ).toBe(true);
    // Hard gate: a stale presence (a session inside one long tool call) is not a death signal.
    expect(rk9CoordLeaseActorVerdict({ kind: "cc", endedAt: null, lastSeenAt: old, runStatus: null }, hard).alive).toBe(true);
    // An ended_at older than the lease activity (a re-registered session) does not count.
    expect(
      rk9CoordLeaseActorVerdict({ kind: "cc", endedAt: old, lastSeenAt: old, runStatus: null }, { ...hard, lastActivityAt: fresh }).alive,
    ).toBe(true);
    for (const status of ["running", "queued", "scheduled_retry", "interrupted", null]) {
      expect(rk9CoordLeaseActorVerdict({ kind: "agent_run", endedAt: null, lastSeenAt: old, runStatus: status }, opts).alive).toBe(true);
    }
    expect(rk9CoordLeaseActorVerdict({ kind: "operator", endedAt: old, lastSeenAt: old, runStatus: null }, opts).alive).toBe(true);
  });

  it("judges a waiter only by its polls, never by presence", () => {
    const live = { kind: "cc", endedAt: null, lastSeenAt: fresh, runStatus: null };
    expect(rk9CoordLeaseWaiterAlive(live, { now, pollUntil: old, lastPollAt: old })).toBe(false);
    expect(rk9CoordLeaseWaiterAlive(live, { now, pollUntil: new Date(now.getTime() + 1000), lastPollAt: fresh })).toBe(true);
    expect(
      rk9CoordLeaseWaiterAlive({ ...live, kind: "agent_run", runStatus: "failed" }, { now, pollUntil: new Date(now.getTime() + 1000), lastPollAt: fresh }),
    ).toBe(false);
    expect(
      rk9CoordLeaseWaiterAlive({ ...live, endedAt: now }, { now, pollUntil: new Date(now.getTime() + 1000), lastPollAt: fresh }),
    ).toBe(false);
  });

  it("defaults the grace to 3x the heartbeat, never below the presence TTL", () => {
    expect(resolveRk9CoordLeaseDeadGraceS({} as NodeJS.ProcessEnv)).toBe(300);
    expect(resolveRk9CoordLeaseDeadGraceS({ RK9_COORD_HEARTBEAT_S: "200" } as NodeJS.ProcessEnv)).toBe(600);
    expect(resolveRk9CoordLeaseDeadGraceS({ RK9_COORD_PRESENCE_TTL_S: "60" } as NodeJS.ProcessEnv)).toBe(180);
    expect(resolveRk9CoordLeaseDeadGraceS({ RK9_COORD_LEASE_DEAD_GRACE_S: "90" } as NodeJS.ProcessEnv)).toBe(90);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-leases-sweeper] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord lease sweeper against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  let agentId = "";
  const runId = randomUUID();
  const env = {} as NodeJS.ProcessEnv;

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
  const agentJwt = (): Actor =>
    ({ type: "agent", agentId, companyId, keyScope: { kind: "standard" }, runId, source: "agent_jwt" }) as Actor;

  function appFor(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
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
  }

  const cc = (n: string) => `cc:paperclip-01:sweep-${n}`;
  const base = `/api/companies/${companyId}/rk9/coord/leases`;

  function acquire(actorId: string, resource: string, wait = false, actor: Actor = boardKey()) {
    return request(appFor(actor)).post(`${base}/acquire`).set("X-RK9-Actor", actorId).send({ resource, ttl_s: 600, wait });
  }

  async function subtypes(resource: string) {
    const rows = await db
      .select({ payload: rk9CoordEvents.payload })
      .from(rk9CoordEvents)
      .where(and(eq(rk9CoordEvents.companyId, companyId), eq(rk9CoordEvents.resource, resource)))
      .orderBy(asc(rk9CoordEvents.id));
    return rows.map((row) => (row.payload as { subtype: string }).subtype);
  }

  async function activityCount(resource: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), sql`${activityLog.details} ->> 'resource' = ${resource}`));
    return rows.length;
  }

  async function activeHolder(resource: string) {
    const [row] = await db
      .select({ holder: rk9CoordActors.actorRef, reason: rk9CoordLeases.releaseReason })
      .from(rk9CoordLeases)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeases.holderActorId))
      .where(and(eq(rk9CoordLeases.resource, resource), sql`${rk9CoordLeases.releasedAt} is null`));
    return row?.holder ?? null;
  }

  async function makeStale(actorRef: string) {
    await db.update(rk9CoordActors).set({ lastSeenAt: sql`now() - interval '1 hour'` }).where(eq(rk9CoordActors.actorRef, actorRef));
  }

  async function ageLease(resource: string) {
    await db
      .update(rk9CoordLeases)
      .set({ acquiredAt: sql`now() - interval '1 hour'` })
      .where(and(eq(rk9CoordLeases.resource, resource), sql`${rk9CoordLeases.releasedAt} is null`));
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-lease-sweeper-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "RK9 sweeper", issuePrefix: "RKS" });
    const [row] = await db
      .insert(agents)
      .values({ companyId, name: "Sweep Coder", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    agentId = row!.id;
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date() });
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("expires a lease past its TTL, promotes the next live waiter, notifies it, and re-runs as a no-op", async () => {
    const res = "prod:ttl";
    await acquire(cc("t1"), res);
    await acquire(cc("t2"), res, true);
    await db.update(rk9CoordLeases).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(rk9CoordLeases.resource, res));
    const first = await sweepRk9CoordLeases(db, { env });
    expect(first).toMatchObject({ expired: 1, promoted: 1 });
    const [old] = await db
      .select()
      .from(rk9CoordLeases)
      .where(and(eq(rk9CoordLeases.resource, res), sql`${rk9CoordLeases.releasedAt} is not null`));
    expect(old!.releaseReason).toBe("ttl_expired");
    expect(await activeHolder(res)).toBe(cc("t2"));
    expect(await subtypes(res)).toEqual(["grant", "queue", "expire", "promote"]);
    expect(await activityCount(res)).toBe(4);
    const inbox = await db
      .select({ kind: rk9CoordInbox.kind, body: rk9CoordInbox.body, from: rk9CoordInbox.fromActorRef })
      .from(rk9CoordInbox)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordInbox.toActorId))
      .where(eq(rk9CoordActors.actorRef, cc("t2")));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "lease_promote", from: "orch:rk9-lease-sweeper" });
    expect(inbox[0]!.body).toContain(res);

    const second = await sweepRk9CoordLeases(db, { env });
    expect(second).toMatchObject({ expired: 0, deadReleased: 0, promoted: 0, dequeued: 0 });
    expect(await subtypes(res)).toHaveLength(4);
    expect(await activityCount(res)).toBe(4);
  });

  it("releases a dead holder of an advisory lease (presence_stale) and skips dead waiters", async () => {
    const res = "repo:o/dead@main";
    await acquire(cc("d1"), res);
    await acquire(cc("d2"), res, true);
    await acquire(cc("d3"), res, true);
    await makeStale(cc("d1"));
    await ageLease(res);
    // d2 stopped polling (its presence stays fresh): it no longer waits.
    const [d2] = await db.select({ id: rk9CoordActors.id }).from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, cc("d2")));
    await db
      .update(rk9CoordLeaseWaiters)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(and(eq(rk9CoordLeaseWaiters.resource, res), eq(rk9CoordLeaseWaiters.actorId, d2!.id)));
    const result = await sweepRk9CoordLeases(db, { env });
    expect(result).toMatchObject({ deadReleased: 1, promoted: 1, dequeued: 1 });
    expect(await activeHolder(res)).toBe(cc("d3"));
    expect(await subtypes(res)).toEqual(["grant", "queue", "queue", "dead_release", "dequeue", "promote"]);
    const events = await db
      .select({ payload: rk9CoordEvents.payload })
      .from(rk9CoordEvents)
      .where(eq(rk9CoordEvents.resource, res))
      .orderBy(asc(rk9CoordEvents.id));
    expect(events[3]!.payload).toMatchObject({ release_reason: "presence_stale", holder: cc("d1") });
    expect(await db.select().from(rk9CoordLeaseWaiters).where(eq(rk9CoordLeaseWaiters.resource, res))).toHaveLength(0);
    expect(await activityCount(res)).toBe(6);
  });

  it("releases a hard-gate holder only on an explicit signal (presence ended), not on stale presence", async () => {
    const res = "migrate:longrun";
    await acquire(cc("h1"), res);
    await makeStale(cc("h1"));
    await ageLease(res);
    expect((await sweepRk9CoordLeases(db, { env })).deadReleased).toBe(0);
    expect(await activeHolder(res)).toBe(cc("h1"));
    await db.update(rk9CoordActors).set({ endedAt: sql`now()` }).where(eq(rk9CoordActors.actorRef, cc("h1")));
    expect((await sweepRk9CoordLeases(db, { env })).deadReleased).toBe(1);
    expect(await subtypes(res)).toEqual(["grant", "dead_release"]);
  });

  it("keeps a live holder whose presence is stale but who renewed recently", async () => {
    const res = "repo:o/live@main";
    const got = await acquire(cc("r1"), res);
    await makeStale(cc("r1"));
    await ageLease(res);
    await request(appFor(boardKey()))
      .post(`${base}/${got.body.lease_id}/renew`)
      .set("X-RK9-Actor", cc("r1"))
      .send({ fencing_token: got.body.fencing_token, ttl_s: 600 });
    const result = await sweepRk9CoordLeases(db, { env });
    expect(result.deadReleased).toBe(0);
    expect(await activeHolder(res)).toBe(cc("r1"));
  });

  it("releases an agent_run lease when its heartbeat run is terminal", async () => {
    const res = "prod:agent-run";
    const got = await acquire(`agent_run:${runId}`, res, false, agentJwt());
    expect(got.body.granted).toBe(true);
    // Still running: nothing happens, however old the presence row is.
    await makeStale(`agent_run:${runId}`);
    await ageLease(res);
    expect((await sweepRk9CoordLeases(db, { env })).deadReleased).toBe(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const result = await sweepRk9CoordLeases(db, { env });
    expect(result.deadReleased).toBe(1);
    const [row] = await db.select().from(rk9CoordLeases).where(eq(rk9CoordLeases.id, got.body.lease_id));
    expect(row!.releaseReason).toBe("heartbeat_run_terminal");
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, runId));
  });

  it("releases each stale lease once when two sweeps run concurrently", async () => {
    const resources = ["prod:conc-a", "prod:conc-b", "prod:conc-c"];
    for (const [i, res] of resources.entries()) {
      await acquire(cc(`c${i}`), res);
      await acquire(cc(`cw${i}`), res, true);
    }
    await db
      .update(rk9CoordLeases)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(sql`${rk9CoordLeases.resource} in ('prod:conc-a', 'prod:conc-b', 'prod:conc-c') and ${rk9CoordLeases.releasedAt} is null`);
    const results = await Promise.all([sweepRk9CoordLeases(db, { env }), sweepRk9CoordLeases(db, { env })]);
    const rerun = await sweepRk9CoordLeases(db, { env });
    const expired = results.reduce((sum, r) => sum + r.expired, 0) + rerun.expired;
    expect(expired).toBe(3);
    for (const [i, res] of resources.entries()) {
      expect(await subtypes(res)).toEqual(["grant", "queue", "expire", "promote"]);
      expect(await activeHolder(res)).toBe(cc(`cw${i}`));
    }
  });

  it("promotes the head of a queue that has no active lease", async () => {
    const res = "vault:rk9/areas/orphan.md";
    const got = await acquire(cc("o1"), res);
    await acquire(cc("o2"), res, true);
    // Simulate a crash between the release and the promotion.
    await db
      .update(rk9CoordLeases)
      .set({ releasedAt: sql`now()`, releaseReason: "released" })
      .where(eq(rk9CoordLeases.id, got.body.lease_id));
    const result = await sweepRk9CoordLeases(db, { env });
    expect(result.promoted).toBe(1);
    expect(await activeHolder(res)).toBe(cc("o2"));
  });

  it("dequeues waiters that stopped polling and does not escalate them as stuck", async () => {
    const res = "host:abandoned-node";
    await acquire(cc("ab1"), res);
    await acquire(cc("ab2"), res, true);
    await db
      .update(rk9CoordLeaseWaiters)
      .set({ enqueuedAt: sql`now() - interval '2 hours'`, expiresAt: sql`now() - interval '1 second'` })
      .where(eq(rk9CoordLeaseWaiters.resource, res));
    const result = await sweepRk9CoordLeases(db, { env });
    expect(result).toMatchObject({ dequeued: 1, stuck: 0 });
    expect(await subtypes(res)).toEqual(["grant", "queue", "dequeue"]);
    expect(await db.select().from(rk9CoordLeaseWaiters).where(eq(rk9CoordLeaseWaiters.resource, res))).toHaveLength(0);
    expect(await activeHolder(res)).toBe(cc("ab1"));
  });

  it("emits one stuck event per lease whose head waiter waits too long", async () => {
    const res = "host:stuck-node";
    await acquire(cc("s1"), res);
    await acquire(cc("s2"), res, true);
    await db
      .update(rk9CoordLeaseWaiters)
      .set({ enqueuedAt: sql`now() - interval '2 hours'` })
      .where(eq(rk9CoordLeaseWaiters.resource, res));
    const first = await sweepRk9CoordLeases(db, { env });
    expect(first.stuck).toBe(1);
    const second = await sweepRk9CoordLeases(db, { env });
    expect(second.stuck).toBe(0);
    expect(await subtypes(res)).toEqual(["grant", "queue", "stuck"]);
    expect(await activityCount(res)).toBe(3);
    expect(await activeHolder(res)).toBe(cc("s1"));
  });
});
