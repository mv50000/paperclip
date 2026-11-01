// RK9 Custom (RK9-626): coord inbox send/claim, exactly-once issue delivery
// under concurrent claims, and Paperclip-agent targets becoming issue
// comments, against real Postgres. Contract: docs/implementation-notes/coord-bus.md.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  rk9CoordActors,
  rk9CoordInbox,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordResolvedActor, Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { rk9CoordInboxService } from "../services/rk9-coord-inbox.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type Actor = Express.Request["actor"];

function boardKey(companyIds: string[]): Actor {
  return {
    type: "board",
    userId: "operator-user",
    companyIds,
    memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })),
    isInstanceAdmin: true,
    keyId: "board-key-1",
    source: "board_key",
  } as Actor;
}

const worktree = (issue: string): Rk9CoordResolvedActor => ({
  kind: "worktree",
  actorId: `worktree:${issue}`,
  host: "paperclip-01",
  trust: "attributed",
  principal: "board_key",
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-inbox] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord inbox against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  let issueId = "";
  let runId = "";

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
  const base = (cid = companyId) => `/api/companies/${cid}/rk9/coord`;
  const send = (actorId: string, body: Record<string, unknown>, actor: Actor = boardKey([companyId]), cid = companyId) =>
    request(appFor(actor)).post(`${base(cid)}/inbox`).set("X-RK9-Actor", actorId).send(body);
  const claim = (actorId: string, actor: Actor = boardKey([companyId])) =>
    request(appFor(actor)).get(`${base()}/inbox/me`).set("X-RK9-Actor", actorId);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-inbox-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "RK9 inbox", issuePrefix: "RKI" },
      { id: otherCompanyId, name: "Other inbox", issuePrefix: "RKO" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Tuki", role: "support", adapterType: "claude_local" });
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Agent issue", identifier: "RKI-77", issueNumber: 77, assigneeAgentId: agentId })
      .returning();
    issueId = issue!.id;
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        contextSnapshot: { issueId },
        startedAt: new Date(),
      })
      .returning();
    runId = run!.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("delivers to a registered actor once, with target_live and the sender's name", async () => {
    // Recipient and sender register (presence would set name; the test does it directly).
    await db.insert(rk9CoordActors).values([
      { companyId, kind: "cc", actorRef: "cc:paperclip-01:recv-1", host: "paperclip-01", trust: "attributed", name: "RK9-701" },
      { companyId, kind: "orch", actorRef: "orch:main", host: "paperclip-01", trust: "attributed", name: "paperclip-b0" },
    ]);
    const sent = await send("orch:main", { to: "cc:paperclip-01:recv-1", body: "please\nrebase   on master" });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      delivery: "inbox",
      to: { kind: "actor", value: "cc:paperclip-01:recv-1" },
      target_live: true,
      name: "RK9-701",
    });
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "rk9.coord.inbox_sent")));
    expect(activity).toHaveLength(1);

    const got = await claim("cc:paperclip-01:recv-1");
    expect(got.status).toBe(200);
    expect(got.body.messages).toEqual([
      expect.objectContaining({ body: "please rebase on master", from: "orch:main", name: "paperclip-b0", target_live: true }),
    ]);
    expect((await claim("cc:paperclip-01:recv-1")).status).toBe(204);
  });

  it("keeps a message for an unregistered actor id or name until that actor claims", async () => {
    const sent = await send("orch:main", { to: "worktree:RKI-5", body: "for the worktree" });
    expect(sent.body).toMatchObject({ delivery: "inbox", to: { kind: "name" }, target_live: false });
    const named = await send("orch:main", { to: "night-orch", body: "for a name" });
    expect(named.body).toMatchObject({ delivery: "inbox", to: { kind: "name", value: "night-orch" }, target_live: false });
    const got = await claim("worktree:RKI-5");
    expect(got.body.messages.map((m: { body: string }) => m.body)).toEqual(["for the worktree"]);
    await db.insert(rk9CoordActors).values({ companyId, kind: "orch", actorRef: "orch:night", trust: "attributed", name: "night-orch" });
    const byName = await claim("orch:night");
    expect(byName.body.messages.map((m: { body: string }) => m.body)).toEqual(["for a name"]);
  });

  it("delivers an issue-addressed message exactly once to the first of two simultaneous claimers", async () => {
    // Two actors registered with the same issue.
    await db.insert(rk9CoordActors).values({
      companyId,
      kind: "cc",
      actorRef: "cc:paperclip-01:race-b",
      host: "paperclip-01",
      trust: "attributed",
      issue: "RKI-9",
    });
    const sent = await send("orch:main", { to: "RKI-9", body: "who takes it" });
    expect(sent.body).toMatchObject({ delivery: "inbox", to: { kind: "issue", value: "RKI-9" }, target_live: true });
    const [a, b] = await Promise.all([claim("worktree:RKI-9"), claim("cc:paperclip-01:race-b")]);
    const winners = [a, b].filter((res) => res.status === 200);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.body.messages).toHaveLength(1);
    expect([a, b].filter((res) => res.status === 204)).toHaveLength(1);
    const [row] = await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.id, sent.body.id));
    expect(row!.deliveredAt).not.toBeNull();
    expect(row!.deliveredToActorId).not.toBeNull();
  });

  it("never hands one message to two claimers under load", async () => {
    const inbox = rk9CoordInboxService(db);
    const caller = { actor: worktree("RKI-1"), paperclip: { type: "user" as const, userId: "operator-user" } };
    for (let i = 0; i < 30; i += 1) {
      await inbox.send(companyId, caller, { to: "RKI-40", body: `message ${i}` });
    }
    const claimers = ["a", "b", "c", "d", "e"].map((id): Rk9CoordResolvedActor => ({
      kind: "cc",
      actorId: `cc:paperclip-01:load-${id}`,
      host: "paperclip-01",
      trust: "attributed",
      principal: "board_key",
    }));
    for (const actor of claimers) {
      await db.insert(rk9CoordActors).values({
        companyId,
        kind: "cc",
        actorRef: actor.actorId,
        host: "paperclip-01",
        trust: "attributed",
        issue: "RKI-40",
      });
    }
    const rounds = await Promise.all(claimers.map((actor) => inbox.claim(companyId, actor)));
    const ids = rounds.flat().map((message) => message.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it("turns a message to a Paperclip agent run into an issue comment with an activity row", async () => {
    const before = await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.companyId, companyId));
    const res = await send("worktree:RKI-1", { to: `agent_run:${runId}`, body: "lease prod:bk is free" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ delivery: "issue_comment", issue: "RKI-77", name: "Tuki", id: null });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("lease prod:bk is free");
    expect(comments[0]!.body).toContain("worktree:RKI-1");
    expect(comments[0]!.authorUserId).toBe("operator-user");
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "rk9.coord.message_commented")));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.entityId).toBe(issueId);
    const after = await db.select().from(rk9CoordInbox).where(eq(rk9CoordInbox.companyId, companyId));
    expect(after).toHaveLength(before.length);
  });

  it("addresses a Paperclip agent by name with an explicit issue, and rejects one without", async () => {
    const ok = await send("worktree:RKI-1", { to: "tuki", body: "by name", issue: "RKI-77" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ delivery: "issue_comment", name: "Tuki" });
    const missing = await send("worktree:RKI-1", { to: "Tuki", body: "no issue" });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("rk9_coord_inbox_issue_required");
    const unknownIssue = await send("worktree:RKI-1", { to: "Tuki", body: "bad issue", issue: "RKI-999" });
    expect(unknownIssue.status).toBe(404);
    expect(unknownIssue.body.code).toBe("rk9_coord_inbox_target_not_found");
    const unknownRun = await send("worktree:RKI-1", { to: `agent_run:${randomUUID()}`, body: "x" });
    expect(unknownRun.status).toBe(404);
    expect(unknownRun.body.code).toBe("rk9_coord_inbox_target_not_found");
  });

  it("does not let a coord token write issue comments", async () => {
    const principal: Rk9CoordTokenPrincipal = { tokenId: "t", companyId, principalKind: "host", principalName: "mv-laptop" };
    const res = await request(appFor({ type: "none", source: "none" } as Actor, principal))
      .post(`${base()}/inbox`)
      .set("X-RK9-Actor", "remote:mv-laptop")
      .send({ to: `agent_run:${runId}`, body: "x" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_kind_not_allowed");
    // Plain inbox messages still work for a remote host.
    const plain = await request(appFor({ type: "none", source: "none" } as Actor, principal))
      .post(`${base()}/inbox`)
      .set("X-RK9-Actor", "remote:mv-laptop")
      .send({ to: "RKI-50", body: "from the laptop" });
    expect(plain.status).toBe(201);
  });

  it("validates the body and keeps companies apart", async () => {
    expect((await send("orch:main", { to: "RKI-9" })).status).toBe(400);
    expect((await send("orch:main", { body: "x" })).status).toBe(400);
    const cross = await send("orch:main", { to: "RKI-9", body: "x" }, boardKey([companyId]), otherCompanyId);
    expect(cross.status).toBe(403);
    const crossClaim = await request(appFor(boardKey([companyId])))
      .get(`${base(otherCompanyId)}/inbox/me`)
      .set("X-RK9-Actor", "worktree:RKI-9");
    expect(crossClaim.status).toBe(403);
    // A message in this company is never claimed through another company.
    await send("orch:main", { to: "RKI-60", body: "company scoped" });
    const other = await request(appFor(boardKey([otherCompanyId])))
      .get(`${base(otherCompanyId)}/inbox/me`)
      .set("X-RK9-Actor", "worktree:RKI-60");
    expect(other.status).toBe(204);
    // Claims need an actor.
    const anonymous = await request(appFor(boardKey([companyId]))).get(`${base()}/inbox/me`);
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.code).toBe("rk9_coord_actor_required");
  });
});
