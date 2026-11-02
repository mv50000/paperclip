// RK9 Custom (RK9-627): coord lease engine routes against real Postgres:
// atomic acquire, FIFO queue under 20 parallel acquires, renew/release with
// fencing, adopt, break, hard-gate trust, company scope and the exact rk9 CLI
// bodies. RK9-648: queue leave, wait=false refresh, released-lease fencing,
// claim window cap, hard-gate TTL cap and the kind-first order.
// Contract: docs/implementation-notes/coord-leases.md.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { parseRk9CoordLeaseResource } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Actor = Express.Request["actor"];

describe("coord lease resource grammar", () => {
  it("accepts the frozen prefixes and rejects everything else", () => {
    for (const ok of [
      "prod:bk",
      "migrate:paperclip",
      "repo:mv50000/paperclip@work/RK9-627",
      "repo:paperclip",
      "vault:rk9/areas/operator_todo.md",
      "host:paperclip-01",
    ]) {
      expect(parseRk9CoordLeaseResource(ok), ok).not.toBeNull();
    }
    for (const bad of [
      "deploy:bk",
      "prod:",
      "prod",
      "prod:a b",
      "host:Paperclip",
      "vault:../etc/passwd",
      "repo:a/b/c",
      `prod:${"x".repeat(300)}`,
    ]) {
      expect(parseRk9CoordLeaseResource(bad), bad).toBeNull();
    }
    expect(parseRk9CoordLeaseResource("prod:bk")!.hardGate).toBe(true);
    expect(parseRk9CoordLeaseResource("repo:o/r@main")).toMatchObject({ hardGate: false, repo: "o/r" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-leases] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord lease engine against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let agentId = "";
  const runId = randomUUID();

  const boardKey = (cid = companyId): Actor =>
    ({
      type: "board",
      userId: "operator-user",
      companyIds: [cid],
      memberships: [{ companyId: cid, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      keyId: "board-key-1",
      source: "board_key",
    }) as Actor;
  const session = (): Actor =>
    ({
      type: "board",
      userId: "operator-user",
      sessionId: "sess-op",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      source: "session",
    }) as Actor;
  const agent = (source: "agent_key" | "agent_jwt"): Actor =>
    ({
      type: "agent",
      agentId,
      companyId,
      keyId: source === "agent_key" ? "agent-key-1" : undefined,
      keyScope: { kind: "standard" },
      runId,
      source,
    }) as Actor;
  const none = { type: "none", source: "none" } as Actor;

  function appFor(actor: Actor, principal?: Rk9CoordTokenPrincipal) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      if (principal) req.rk9CoordPrincipal = principal;
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

  const base = (cid = companyId) => `/api/companies/${cid}/rk9/coord/leases`;
  const cc = (n: number | string) => `cc:paperclip-01:sess-${n}`;

  function acquire(actorId: string, body: Record<string, unknown>, actor: Actor = boardKey()) {
    return request(appFor(actor)).post(`${base()}/acquire`).set("X-RK9-Actor", actorId).send(body);
  }

  async function leaseEvents(resource: string) {
    return db
      .select()
      .from(rk9CoordEvents)
      .where(and(eq(rk9CoordEvents.companyId, companyId), eq(rk9CoordEvents.resource, resource)))
      .orderBy(asc(rk9CoordEvents.id));
  }

  async function leaseActivity(resource: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), sql`${activityLog.details} ->> 'resource' = ${resource}`));
  }

  async function subtypes(resource: string) {
    return (await leaseEvents(resource)).map((event) => (event.payload as { subtype: string }).subtype);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-leases-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "RK9 leases", issuePrefix: "RKL" },
      { id: otherCompanyId, name: "Other leases", issuePrefix: "RKM" },
    ]);
    const [row] = await db
      .insert(agents)
      .values({ companyId, name: "Lease Coder", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    agentId = row!.id;
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", startedAt: new Date() });
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("serves the exact rk9 CLI acquire, renew and release bodies", async () => {
    const res = "prod:cli-app";
    // cmd_lease: body = {"resource", "ttl_s", "reason": reason or None, "wait": op == "wait"}
    const got = await acquire(cc("cli"), { resource: res, ttl_s: 1800, reason: null, wait: false });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ granted: true, resource: res, holder: cc("cli") });
    expect(typeof got.body.lease_id).toBe("string");
    expect(typeof got.body.fencing_token).toBe("number");
    const app = appFor(boardKey());
    // renew: {"fencing_token": rec.get("fencing_token"), "ttl_s": ttl}
    const renewed = await request(app)
      .post(`${base()}/${got.body.lease_id}/renew`)
      .set("X-RK9-Actor", cc("cli"))
      .send({ fencing_token: got.body.fencing_token, ttl_s: 3600 });
    expect(renewed.status).toBe(200);
    expect(new Date(renewed.body.expires_at).getTime()).toBeGreaterThan(new Date(got.body.expires_at).getTime());
    // release via write(): {"resource", "fencing_token"} + client_event_id
    const releaseBody = { resource: res, fencing_token: got.body.fencing_token, client_event_id: randomUUID() };
    const released = await request(app)
      .post(`${base()}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("cli"))
      .send(releaseBody);
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ released: true, noop: false });
    // Idempotent: the spool may replay the release; no second event.
    const again = await request(app)
      .post(`${base()}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("cli"))
      .send(releaseBody);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ released: false, noop: true });
    expect(await subtypes(res)).toEqual(["grant", "release"]);
    expect(await leaseActivity(res)).toHaveLength(2);
    for (const event of await leaseEvents(res)) {
      expect(JSON.stringify(event.payload)).not.toContain("fencing");
      expect(event.summary).not.toContain("fencing");
    }
    const status = await request(app).get(`${base()}/status`).query({ resource: res }).set("X-RK9-Actor", cc("cli"));
    expect(status.body).toMatchObject({ resource: res, held: false, holder: null, queue: [] });
  });

  it("grants exactly one of 20 parallel acquires and queues 19 in FIFO order", async () => {
    const res = "prod:race";
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => acquire(cc(`race-${i}`), { resource: res, ttl_s: 600, wait: true })),
    );
    for (const r of results) expect(r.status).toBe(200);
    const granted = results.filter((r) => r.body.granted === true);
    const queued = results.filter((r) => r.body.queued === true);
    expect(granted).toHaveLength(1);
    expect(queued).toHaveLength(19);
    const positions = queued.map((r) => r.body.position as number).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    for (const r of queued) expect(r.body.holder).toBe(granted[0]!.body.holder);
    // Positions follow arrival order: the waiter bigserial id.
    const waiters = await db
      .select({ id: rk9CoordLeaseWaiters.id, actor: rk9CoordActors.actorRef })
      .from(rk9CoordLeaseWaiters)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeaseWaiters.actorId))
      .where(and(eq(rk9CoordLeaseWaiters.companyId, companyId), eq(rk9CoordLeaseWaiters.resource, res)))
      .orderBy(asc(rk9CoordLeaseWaiters.id));
    const positionOf = new Map(
      results.map((r, i) => [cc(`race-${i}`), r.body.queued ? (r.body.position as number) : null]),
    );
    expect(waiters.map((w) => positionOf.get(w.actor))).toEqual(positions);
    const kinds = await subtypes(res);
    expect(kinds.filter((k) => k === "grant")).toHaveLength(1);
    expect(kinds.filter((k) => k === "queue")).toHaveLength(19);
    expect(kinds).toHaveLength(20);
    expect(await leaseActivity(res)).toHaveLength(20);
    // A waiter's poll keeps its place and writes nothing.
    const head = waiters[0]!.actor;
    const poll = await acquire(head, { resource: res, ttl_s: 600, wait: true });
    expect(poll.body).toMatchObject({ granted: false, queued: true, position: 1 });
    expect(await subtypes(res)).toHaveLength(20);
    // Status lists the queue in order.
    const status = await request(appFor(boardKey())).get(`${base()}/status`).query({ resource: res }).set("X-RK9-Actor", head);
    expect(status.body.queue).toHaveLength(19);
    expect(status.body.queue[0]).toEqual({ actor: head, position: 1 });
    expect(status.body.position).toBe(1);
    expect(status.body).not.toHaveProperty("fencing_token"); // only the granting answer carries it
  });

  it("answers 409 without queueing when wait=false and the holder is live", async () => {
    const res = "repo:mv50000/paperclip@nowait";
    await acquire(cc("nw-1"), { resource: res, ttl_s: 600 });
    const second = await acquire(cc("nw-2"), { resource: res, ttl_s: 600, wait: false });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: "rk9_coord_lease_held",
      granted: false,
      queued: false,
      holder: cc("nw-1"),
      position: null,
    });
    expect(second.body.eta).toBeTruthy();
    const waiters = await db.select().from(rk9CoordLeaseWaiters).where(eq(rk9CoordLeaseWaiters.resource, res));
    expect(waiters).toHaveLength(0);
    const events = await leaseEvents(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.repo).toBe("mv50000/paperclip");
  });

  it("needs the fencing token to release a hard-gate lease, and reports a queued caller with wait=false", async () => {
    const res = "prod:needtoken";
    const got = await acquire(cc("nt1"), { resource: res, ttl_s: 600 });
    const noToken = await request(appFor(boardKey()))
      .post(`${base()}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("nt1"))
      .send({ resource: res });
    expect(noToken.status).toBe(422);
    expect(noToken.body.code).toBe("rk9_coord_lease_fencing_required");
    // The holder check comes first: a non-holder without a token is 403, not 422.
    const stranger = await request(appFor(boardKey()))
      .post(`${base()}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("nt9"))
      .send({ resource: res });
    expect(stranger.status).toBe(403);
    await acquire(cc("nt2"), { resource: res, ttl_s: 600, wait: true });
    const again = await acquire(cc("nt2"), { resource: res, ttl_s: 600, wait: false });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ granted: false, queued: true, position: 1 });
    // Released once with the token, a replay without it is still a 200 no-op.
    const app = appFor(boardKey());
    const ok = await request(app)
      .post(`${base()}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("nt1"))
      .send({ resource: res, fencing_token: got.body.fencing_token });
    expect(ok.status).toBe(200);
    const replay = await request(app).post(`${base()}/${got.body.lease_id}/release`).set("X-RK9-Actor", cc("nt1")).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.noop).toBe(true);
    // nt2 was promoted with a short claim window; its next poll extends it to the TTL.
    const [promoted] = await db
      .select()
      .from(rk9CoordLeases)
      .where(and(eq(rk9CoordLeases.resource, res), sql`${rk9CoordLeases.releasedAt} is null`));
    const windowS = (promoted!.expiresAt.getTime() - promoted!.acquiredAt.getTime()) / 1000;
    expect(windowS).toBeLessThanOrEqual(300);
    const claim = await acquire(cc("nt2"), { resource: res, ttl_s: 3600, wait: true });
    expect(claim.body).toMatchObject({ granted: true, already_held: true });
    expect(new Date(claim.body.expires_at).getTime() - Date.now()).toBeGreaterThan(3000 * 1000);
  });

  it("validates the resource format with 422", async () => {
    for (const resource of ["deploy:bk", "prod:has space", "vault:../x", "host:UPPER"]) {
      const r = await acquire(cc("fmt"), { resource, ttl_s: 60 });
      expect(r.status, resource).toBe(422);
      expect(r.body.code).toBe("rk9_coord_lease_resource_invalid");
    }
    const bad = await acquire(cc("fmt"), { resource: "prod:x", ttl_s: 5 });
    expect(bad.status).toBe(400);
  });

  it("keeps leases company-scoped", async () => {
    const res = "prod:scoped";
    const got = await acquire(cc("scope"), { resource: res, ttl_s: 600 });
    const other = appFor(boardKey(otherCompanyId));
    const list = await request(other).get(base(otherCompanyId)).set("X-RK9-Actor", cc("scope"));
    expect(list.status).toBe(200);
    expect(list.body.leases.find((l: { resource: string }) => l.resource === res)).toBeUndefined();
    const release = await request(other)
      .post(`${base(otherCompanyId)}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("scope"))
      .send({ resource: res, fencing_token: got.body.fencing_token });
    expect(release.status).toBe(404);
    expect(release.body.code).toBe("rk9_coord_lease_not_found");
    // A board key of company A cannot reach company B at all.
    const cross = await request(appFor(boardKey())).get(base(otherCompanyId)).set("X-RK9-Actor", cc("scope"));
    expect(cross.status).toBe(403);
    const missing = await request(appFor(boardKey()))
      .post(`${base()}/${randomUUID()}/release`)
      .set("X-RK9-Actor", cc("scope"))
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("rk9_coord_lease_not_found");
    const malformed = await request(appFor(boardKey())).post(`${base()}/not-a-uuid/renew`).set("X-RK9-Actor", cc("scope")).send({ fencing_token: 1 });
    expect(malformed.status).toBe(404);
    expect(malformed.body.code).toBe("rk9_coord_lease_not_found");
  });

  it("rejects a stale fencing token, a renew after expiry and a non-holder", async () => {
    const res = "prod:fence";
    const app = appFor(boardKey());
    const got = await acquire(cc("f1"), { resource: res, ttl_s: 600 });
    await acquire(cc("f2"), { resource: res, ttl_s: 600, wait: true });
    const wrong = await request(app)
      .post(`${base()}/${got.body.lease_id}/renew`)
      .set("X-RK9-Actor", cc("f1"))
      .send({ fencing_token: got.body.fencing_token + 1000 });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("rk9_coord_lease_stale");
    const notHolder = await request(app)
      .post(`${base()}/${got.body.lease_id}/release`)
      .set("X-RK9-Actor", cc("f2"))
      .send({ fencing_token: got.body.fencing_token });
    expect(notHolder.status).toBe(403);
    expect(notHolder.body.code).toBe("rk9_coord_lease_not_holder");
    const valid = await request(app)
      .post(`${base()}/validate`)
      .set("X-RK9-Actor", cc("f2"))
      .send({ resource: res, fencing_token: got.body.fencing_token });
    expect(valid.status).toBe(200);
    expect(valid.body.valid).toBe(true);

    // Expire it: the renew answers 409, records the expiry and promotes f2.
    await db.update(rk9CoordLeases).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(rk9CoordLeases.id, got.body.lease_id));
    const late = await request(app)
      .post(`${base()}/${got.body.lease_id}/renew`)
      .set("X-RK9-Actor", cc("f1"))
      .send({ fencing_token: got.body.fencing_token, ttl_s: 600 });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "rk9_coord_lease_stale", release_reason: "ttl_expired" });
    for (const path of ["renew", "release"]) {
      const r = await request(app)
        .post(`${base()}/${got.body.lease_id}/${path}`)
        .set("X-RK9-Actor", cc("f1"))
        .send({ fencing_token: got.body.fencing_token });
      expect(r.status, path).toBe(409);
    }
    const stale = await request(app)
      .post(`${base()}/validate`)
      .set("X-RK9-Actor", cc("f1"))
      .send({ resource: res, fencing_token: got.body.fencing_token });
    expect(stale.status).toBe(409);
    expect(stale.body.valid).toBe(false);
    expect(await subtypes(res)).toEqual(["grant", "queue", "expire", "promote"]);
    const promoted = await acquire(cc("f2"), { resource: res, ttl_s: 600, wait: true });
    expect(promoted.body).toMatchObject({ granted: true, already_held: true, holder: cc("f2") });
    expect(promoted.body.fencing_token).toBeGreaterThan(got.body.fencing_token);
    const inbox = await db
      .select()
      .from(rk9CoordInbox)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordInbox.toActorId))
      .where(eq(rk9CoordActors.actorRef, cc("f2")));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.rk9_coord_inbox.kind).toBe("lease_promote");
    expect(await subtypes(res)).toHaveLength(4);
  });

  it("adopts an expired or dead-holder lease inline with a higher fencing token", async () => {
    const res = "host:adopt-node";
    const first = await acquire(cc("a1"), { resource: res, ttl_s: 600 });
    await db.update(rk9CoordLeases).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(rk9CoordLeases.id, first.body.lease_id));
    const second = await acquire(cc("a2"), { resource: res, ttl_s: 600 });
    expect(second.body).toMatchObject({ granted: true, adopted_from: cc("a1") });
    expect(second.body.fencing_token).toBeGreaterThan(first.body.fencing_token);
    const [old] = await db.select().from(rk9CoordLeases).where(eq(rk9CoordLeases.id, first.body.lease_id));
    expect(old!.releaseReason).toBe("ttl_expired");
    const events = await leaseEvents(res);
    expect(events.map((e) => (e.payload as { subtype: string }).subtype)).toEqual(["grant", "adopt"]);
    expect(events[1]!.payload).toMatchObject({ previous_holder: cc("a1"), release_reason: "ttl_expired" });
    expect(await leaseActivity(res)).toHaveLength(2);

    // Dead holder of a hard gate: only an explicit signal counts (presence ended after the grant).
    await db
      .update(rk9CoordActors)
      .set({ lastSeenAt: sql`now() - interval '1 hour'` })
      .where(eq(rk9CoordActors.actorRef, cc("a2")));
    await db.update(rk9CoordLeases).set({ acquiredAt: sql`now() - interval '1 hour'` }).where(eq(rk9CoordLeases.id, second.body.lease_id));
    const stillHeld = await acquire(cc("a3"), { resource: res, ttl_s: 600 });
    expect(stillHeld.status).toBe(409);
    await db.update(rk9CoordActors).set({ endedAt: sql`now()` }).where(eq(rk9CoordActors.actorRef, cc("a2")));
    const third = await acquire(cc("a3"), { resource: res, ttl_s: 600 });
    expect(third.body).toMatchObject({ granted: true, adopted_from: cc("a2") });
    const last = (await leaseEvents(res)).at(-1)!;
    expect(last.payload).toMatchObject({ subtype: "adopt", previous_holder: cc("a2"), release_reason: "presence_stale" });
  });

  it("lets only the operator or rk9claude break a live holder, always with a reason", async () => {
    const res = "prod:breakme";
    const got = await acquire(cc("b1"), { resource: res, ttl_s: 600 });
    await acquire(cc("b2"), { resource: res, ttl_s: 600, wait: true });
    const byCc = await request(appFor(boardKey()))
      .post(`${base()}/break`)
      .set("X-RK9-Actor", cc("b3"))
      .send({ resource: res, reason: "stuck" });
    expect(byCc.status).toBe(403);
    expect(byCc.body.code).toBe("rk9_coord_break_requires_operator");
    const noReason = await request(appFor(session())).post(`${base()}/break`).send({ resource: res, reason: "  " });
    expect(noReason.status).toBe(400);
    const op = await request(appFor(session())).post(`${base()}/break`).send({ resource: res, reason: "deploy stuck 40 min" });
    expect(op.status).toBe(200);
    expect(op.body).toMatchObject({ broken: true, previous_holder: cc("b1"), release_reason: "operator_break" });
    expect(op.body.promoted).toMatchObject({ holder: cc("b2") });
    const [old] = await db.select().from(rk9CoordLeases).where(eq(rk9CoordLeases.id, got.body.lease_id));
    expect(old!.releaseReason).toBe("operator_break");
    const events = await leaseEvents(res);
    expect(events.map((e) => (e.payload as { subtype: string }).subtype)).toEqual(["grant", "queue", "break", "promote"]);
    expect(events[2]!.actorRef).toBe("operator");
    expect(events[2]!.payload).toMatchObject({ broken_by: "operator", break_reason: "deploy stuck 40 min" });
    expect(await leaseActivity(res)).toHaveLength(4);

    // rk9claude (service token) may break too (ADR Q5).
    const rk9claude: Rk9CoordTokenPrincipal = { tokenId: "t-svc", companyId, principalKind: "service", principalName: "rk9claude" };
    const svc = await request(appFor(none, rk9claude))
      .post(`${base()}/break`)
      .set("X-RK9-Actor", "rk9claude")
      .send({ resource: res, reason: "alert remediation" });
    expect(svc.status).toBe(200);
    expect(svc.body).toMatchObject({ previous_holder: cc("b2"), release_reason: "operator_break" });

    // A non-operator break on a dead holder runs the dead-release path.
    const res2 = "prod:breakdead";
    await acquire(cc("d1"), { resource: res2, ttl_s: 600 });
    await db.update(rk9CoordActors).set({ endedAt: sql`now()` }).where(eq(rk9CoordActors.actorRef, cc("d1")));
    const dead = await request(appFor(boardKey())).post(`${base()}/break`).set("X-RK9-Actor", cc("d2")).send({ resource: res2, reason: "gone" });
    expect(dead.status).toBe(200);
    expect(dead.body.release_reason).toBe("presence_stale");
    expect(await subtypes(res2)).toEqual(["grant", "dead_release"]);
    const free = await request(appFor(session())).post(`${base()}/break`).send({ resource: res2, reason: "nothing" });
    expect(free.status).toBe(404);
    expect(free.body.code).toBe("rk9_coord_lease_not_found");
  });

  it("requires a run JWT for agent_run hard-gate leases and vouched trust for every hard gate", async () => {
    const byKey = await acquire(`agent_run:${runId}`, { resource: "prod:agent", ttl_s: 600 }, agent("agent_key"));
    expect(byKey.status).toBe(403);
    expect(byKey.body.code).toBe("rk9_coord_lease_run_jwt_required");
    const repoByKey = await acquire(`agent_run:${runId}`, { resource: "repo:agent-repo@main", ttl_s: 600 }, agent("agent_key"));
    expect(repoByKey.status).toBe(200);
    const byJwt = await acquire(`agent_run:${runId}`, { resource: "prod:agent", ttl_s: 600 }, agent("agent_jwt"));
    expect(byJwt.status).toBe(200);
    expect(byJwt.body.granted).toBe(true);
    // A sibling run with the agent key cannot release the JWT run's hard-gate lease.
    const sibling = await request(appFor(agent("agent_key")))
      .post(`${base()}/${byJwt.body.lease_id}/release`)
      .set("X-RK9-Actor", `agent_run:${runId}`)
      .send({ fencing_token: byJwt.body.fencing_token });
    expect(sibling.status).toBe(403);
    expect(sibling.body.code).toBe("rk9_coord_lease_run_jwt_required");
    const hostToken: Rk9CoordTokenPrincipal = { tokenId: "t-host", companyId, principalKind: "host", principalName: "mv-laptop" };
    const remote = await request(appFor(none, hostToken))
      .post(`${base()}/acquire`)
      .set("X-RK9-Actor", "remote:mv-laptop")
      .send({ resource: "host:mv-laptop", ttl_s: 600 });
    expect(remote.status).toBe(403);
    expect(remote.body.code).toBe("rk9_coord_lease_trust_insufficient");
  });

  it("denies grok every lease of any prefix and keeps remote on soft prefixes only (RK9-633)", async () => {
    const grokToken: Rk9CoordTokenPrincipal = { tokenId: "t-grok", companyId, principalKind: "service", principalName: "grok" };
    const grokApp = appFor(none, grokToken);
    const asGrok = (path: string, body: Record<string, unknown>) =>
      request(grokApp).post(`${base()}${path}`).set("X-RK9-Actor", "grok").send(body);

    for (const resource of ["repo:grok-repo@main", "vault:rk9/areas/grok.md", "prod:grok-app"]) {
      for (const wait of [false, true]) {
        const res = await asGrok("/acquire", { resource, ttl_s: 600, wait });
        expect(res.status, `${resource} wait=${wait}`).toBe(403);
        expect(res.body.code).toBe("rk9_coord_lease_kind_not_allowed");
      }
    }

    // A live holder on repo:, then grok tries break, renew and release on it.
    const held = await acquire(cc("grok-target"), { resource: "repo:grok-target@main", ttl_s: 600 });
    expect(held.body.granted).toBe(true);
    const brk = await asGrok("/break", { resource: "repo:grok-target@main", reason: "grok wants it" });
    expect(brk.status).toBe(403);
    expect(brk.body.code).toBe("rk9_coord_lease_kind_not_allowed");
    const renew = await asGrok(`/${held.body.lease_id}/renew`, { fencing_token: held.body.fencing_token, ttl_s: 600 });
    expect(renew.status).toBe(403);
    expect(renew.body.code).toBe("rk9_coord_lease_kind_not_allowed");
    const release = await asGrok(`/${held.body.lease_id}/release`, {
      resource: "repo:grok-target@main",
      fencing_token: held.body.fencing_token,
    });
    expect(release.status).toBe(403);
    expect(release.body.code).toBe("rk9_coord_lease_kind_not_allowed");
    expect(await subtypes("repo:grok-target@main")).toEqual(["grant"]);
    expect(await subtypes("repo:grok-repo@main")).toEqual([]);

    // remote keeps the ADR rule: soft prefixes yes, hard gates no.
    const hostToken: Rk9CoordTokenPrincipal = { tokenId: "t-host2", companyId, principalKind: "host", principalName: "mv-laptop" };
    const remoteApp = appFor(none, hostToken);
    const remoteRepo = await request(remoteApp)
      .post(`${base()}/acquire`)
      .set("X-RK9-Actor", "remote:mv-laptop")
      .send({ resource: "repo:remote-repo@main", ttl_s: 600 });
    expect(remoteRepo.status).toBe(200);
    expect(remoteRepo.body.granted).toBe(true);
    const remoteProd = await request(remoteApp)
      .post(`${base()}/acquire`)
      .set("X-RK9-Actor", "remote:mv-laptop")
      .send({ resource: "prod:remote-app", ttl_s: 600 });
    expect(remoteProd.status).toBe(403);
    expect(remoteProd.body.code).toBe("rk9_coord_lease_trust_insufficient");
  });

  it("lists leases with holder phase and queue, filtered by prefix and holder", async () => {
    const app = appFor(boardKey());
    await db
      .update(rk9CoordActors)
      .set({ phase: "deploying" })
      .where(eq(rk9CoordActors.actorRef, `agent_run:${runId}`));
    const list = await request(app).get(base()).query({ prefix: "prod" }).set("X-RK9-Actor", cc("viewer"));
    expect(list.status).toBe(200);
    for (const lease of list.body.leases) expect(lease.resource.startsWith("prod:")).toBe(true);
    const agentLease = list.body.leases.find((l: { resource: string }) => l.resource === "prod:agent");
    expect(agentLease).toMatchObject({ holder: `agent_run:${runId}`, holder_phase: "deploying", queue: [] });
    expect(agentLease).not.toHaveProperty("fencing_token");
    const byHolder = await request(app).get(base()).query({ holder: `agent_run:${runId}` });
    expect(byHolder.body.leases.map((l: { resource: string }) => l.resource).sort()).toEqual([
      "prod:agent",
      "repo:agent-repo@main",
    ]);
    const race = await request(app).get(`${base()}/status`).query({ resource: "prod:race" });
    expect(race.body.queue).toHaveLength(19);
    expect(race.body.held).toBe(true);
  });
  // --- RK9 Custom (RK9-648): lease engine follow-ups ---
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function waiterRow(resource: string, actorRef: string) {
    const [row] = await db
      .select({ waiter: rk9CoordLeaseWaiters })
      .from(rk9CoordLeaseWaiters)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeaseWaiters.actorId))
      .where(
        and(
          eq(rk9CoordLeaseWaiters.companyId, companyId),
          eq(rk9CoordLeaseWaiters.resource, resource),
          eq(rk9CoordActors.actorRef, actorRef),
        ),
      );
    return row?.waiter ?? null;
  }

  it("lets a waiter leave the queue idempotently without touching the lease (RK9-648)", async () => {
    const res = "prod:leave-app";
    const app = appFor(boardKey());
    const held = await acquire(cc("lv-h"), { resource: res, ttl_s: 600 });
    await acquire(cc("lv-1"), { resource: res, ttl_s: 600, wait: true });
    await acquire(cc("lv-2"), { resource: res, ttl_s: 600, wait: true });
    const leave = await request(app).post(`${base()}/leave`).set("X-RK9-Actor", cc("lv-1")).send({ resource: res });
    expect(leave.status).toBe(200);
    expect(leave.body).toEqual({ left: true, resource: res });
    expect(await waiterRow(res, cc("lv-1"))).toBeNull();
    // The next waiter moves up; the holder keeps its lease.
    const poll = await acquire(cc("lv-2"), { resource: res, ttl_s: 600, wait: true });
    expect(poll.body).toMatchObject({ queued: true, position: 1, holder: cc("lv-h") });
    const events = await leaseEvents(res);
    expect(events.map((e) => (e.payload as { subtype: string }).subtype)).toEqual(["grant", "queue", "queue", "dequeue"]);
    expect(events[3]!.payload).toMatchObject({ actor: cc("lv-1"), dequeue_reason: "left" });
    expect(await leaseActivity(res)).toHaveLength(4);
    // A second leave, a caller that never queued and an unknown actor: 200 left:false, nothing written.
    for (const who of [cc("lv-1"), cc("lv-h"), cc("lv-never-seen")]) {
      const again = await request(app).post(`${base()}/leave`).set("X-RK9-Actor", who).send({ resource: res });
      expect(again.status, who).toBe(200);
      expect(again.body).toEqual({ left: false, resource: res });
    }
    expect(await leaseEvents(res)).toHaveLength(4);
    const [lease] = await db.select().from(rk9CoordLeases).where(eq(rk9CoordLeases.id, held.body.lease_id));
    expect(lease!.releasedAt).toBeNull();
    // An agent key cannot dequeue a sibling run's hard-gate waiter (the same trust rule as acquire).
    const byKey = await request(appFor(agent("agent_key")))
      .post(`${base()}/leave`)
      .set("X-RK9-Actor", `agent_run:${runId}`)
      .send({ resource: res });
    expect(byKey.status).toBe(403);
    expect(byKey.body.code).toBe("rk9_coord_lease_run_jwt_required");
    // Bad bodies and resources.
    const noBody = await request(app).post(`${base()}/leave`).set("X-RK9-Actor", cc("lv-2")).send({});
    expect(noBody.status).toBe(400);
    const badRes = await request(app).post(`${base()}/leave`).set("X-RK9-Actor", cc("lv-2")).send({ resource: "deploy:x" });
    expect(badRes.status).toBe(422);
    expect(badRes.body.code).toBe("rk9_coord_lease_resource_invalid");
    // Company scope: the other company's queue is not this one.
    const other = await request(appFor(boardKey(otherCompanyId)))
      .post(`${base(otherCompanyId)}/leave`)
      .set("X-RK9-Actor", cc("lv-2"))
      .send({ resource: res });
    expect(other.body.left).toBe(false);
    expect(await waiterRow(res, cc("lv-2"))).not.toBeNull();
  });

  it("refreshes a queued caller's liveness on a wait=false poll (RK9-648 R1)", async () => {
    const res = "repo:poll-nowait@main";
    await acquire(cc("pn-h"), { resource: res, ttl_s: 600 });
    await acquire(cc("pn-w"), { resource: res, ttl_s: 600, wait: true });
    await db
      .update(rk9CoordLeaseWaiters)
      .set({ expiresAt: sql`now() + interval '5 seconds'` })
      .where(eq(rk9CoordLeaseWaiters.id, (await waiterRow(res, cc("pn-w")))!.id));
    const before = (await waiterRow(res, cc("pn-w")))!.expiresAt!.getTime();
    const poll = await acquire(cc("pn-w"), { resource: res, ttl_s: 600, wait: false });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ granted: false, queued: true, position: 1 });
    const after = (await waiterRow(res, cc("pn-w")))!.expiresAt!.getTime();
    expect(after).toBeGreaterThan(before + 60_000);
    expect(await subtypes(res)).toEqual(["grant", "queue"]);
  });

  it("answers 409 to a mismatched fencing token on an already released lease (RK9-648 R2)", async () => {
    const res = "prod:r2-app";
    const app = appFor(boardKey());
    const got = await acquire(cc("r2"), { resource: res, ttl_s: 600 });
    const url = `${base()}/${got.body.lease_id}/release`;
    const ok = await request(app).post(url).set("X-RK9-Actor", cc("r2")).send({ resource: res, fencing_token: got.body.fencing_token });
    expect(ok.status).toBe(200);
    const wrong = await request(app).post(url).set("X-RK9-Actor", cc("r2")).send({ resource: res, fencing_token: got.body.fencing_token + 1 });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: "rk9_coord_lease_stale", release_reason: "released" });
    const replay = await request(app).post(url).set("X-RK9-Actor", cc("r2")).send({ resource: res, fencing_token: got.body.fencing_token });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ released: false, noop: true });
    expect(await subtypes(res)).toEqual(["grant", "release"]);
  });

  it("caps the claim window of a promoted lease apart from a long dead-holder grace (RK9-648 R3)", async () => {
    vi.stubEnv("RK9_COORD_LEASE_DEAD_GRACE_S", "86400");
    const res = "repo:claim-cap@main";
    const app = appFor(boardKey());
    const got = await acquire(cc("cw-h"), { resource: res, ttl_s: 7200 });
    await acquire(cc("cw-w"), { resource: res, ttl_s: 7200, wait: true });
    const rel = await request(app).post(`${base()}/${got.body.lease_id}/release`).set("X-RK9-Actor", cc("cw-h")).send({ fencing_token: got.body.fencing_token });
    expect(rel.status).toBe(200);
    const [promoted] = await db
      .select()
      .from(rk9CoordLeases)
      .where(and(eq(rk9CoordLeases.companyId, companyId), eq(rk9CoordLeases.resource, res), sql`${rk9CoordLeases.releasedAt} is null`));
    const windowS = (promoted!.expiresAt.getTime() - promoted!.acquiredAt.getTime()) / 1000;
    expect(windowS).toBe(300);
    vi.stubEnv("RK9_COORD_LEASE_CLAIM_WINDOW_S", "60");
    await request(app).post(`${base()}/${promoted!.id}/release`).set("X-RK9-Actor", cc("cw-w")).send({ fencing_token: promoted!.fencingToken });
    const again = await acquire(cc("cw-x"), { resource: res, ttl_s: 7200 });
    await acquire(cc("cw-y"), { resource: res, ttl_s: 7200, wait: true });
    await request(app).post(`${base()}/${again.body.lease_id}/release`).set("X-RK9-Actor", cc("cw-x")).send({ fencing_token: again.body.fencing_token });
    const [second] = await db
      .select()
      .from(rk9CoordLeases)
      .where(and(eq(rk9CoordLeases.companyId, companyId), eq(rk9CoordLeases.resource, res), sql`${rk9CoordLeases.releasedAt} is null`));
    expect((second!.expiresAt.getTime() - second!.acquiredAt.getTime()) / 1000).toBe(60);
  });

  it("clamps a hard-gate TTL to the cap on acquire and renew, never a soft one (RK9-648)", async () => {
    const app = appFor(boardKey());
    const capMs = 21_600 * 1000;
    const hard = await acquire(cc("cap-h"), { resource: "migrate:cap-db", ttl_s: 86_400 });
    expect(hard.status).toBe(200);
    expect(new Date(hard.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(capMs + 5_000);
    expect(new Date(hard.body.expires_at).getTime() - Date.now()).toBeGreaterThan(capMs - 60_000);
    const renewed = await request(app)
      .post(`${base()}/${hard.body.lease_id}/renew`)
      .set("X-RK9-Actor", cc("cap-h"))
      .send({ fencing_token: hard.body.fencing_token, ttl_s: 86_400 });
    expect(renewed.status).toBe(200);
    expect(new Date(renewed.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(capMs + 5_000);
    const soft = await acquire(cc("cap-s"), { resource: "vault:rk9/areas/cap.md", ttl_s: 86_400 });
    expect(new Date(soft.body.expires_at).getTime() - Date.now()).toBeGreaterThan(86_000 * 1000);
    // The cap is configurable (never below 1 h); a short hard-gate request is never lengthened.
    vi.stubEnv("RK9_COORD_LEASE_HARD_GATE_TTL_MAX_S", "60");
    const host = await acquire(cc("cap-n"), { resource: "host:cap-node", ttl_s: 86_400 });
    expect(new Date(host.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(3_600_000 + 5_000);
    const short = await acquire(cc("cap-p"), { resource: "prod:cap-short", ttl_s: 120 });
    expect(new Date(short.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(125_000);
  });

  it("checks the grok kind before the body, the reason and the lease id (RK9-648)", async () => {
    const grokToken: Rk9CoordTokenPrincipal = { tokenId: "t-grok-648", companyId, principalKind: "service", principalName: "grok" };
    const grokApp = appFor(none, grokToken);
    const asGrok = (path: string, body: Record<string, unknown>) =>
      request(grokApp).post(`${base()}${path}`).set("X-RK9-Actor", "grok").send(body);
    const missing = randomUUID();
    const cases: Array<[string, Record<string, unknown>]> = [
      [`/${missing}/renew`, { fencing_token: 1, ttl_s: 600 }],
      [`/${missing}/release`, { fencing_token: 1 }],
      [`/${missing}/renew`, {}],
      ["/break", { resource: "prod:x", reason: "" }],
      ["/break", { resource: "deploy:x", reason: "r" }],
      ["/acquire", { resource: "deploy:x" }],
      ["/leave", { resource: "prod:x" }],
      ["/leave", {}],
    ];
    for (const [path, body] of cases) {
      const res = await asGrok(path, body);
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(403);
      expect(res.body.code).toBe("rk9_coord_lease_kind_not_allowed");
    }
  });
  // --- /RK9 Custom ---
});
