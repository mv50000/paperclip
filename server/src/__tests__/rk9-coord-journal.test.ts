// RK9 Custom (RK9-626): coord journal routes, delta cursor, line format,
// redaction, the append-only trigger and the retention prune, against real
// Postgres. Contract: docs/implementation-notes/coord-bus.md.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  rk9CoordActors,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeases,
} from "@paperclipai/db";
import { appendRk9CoordEventSchema } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { formatRk9CoordDeltaLine, RK9_COORD_LINE_MAX } from "../services/rk9-coord-journal.js";
import { pruneRk9Coord } from "../services/rk9-coord-retention.js";
import { rk9CoordIdentifierHasSecret, toRk9CoordLine } from "../services/rk9-coord-text.js";
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

function fakeEvent(i: number) {
  return {
    type: i % 2 === 0 ? "blocker" : "deploy",
    issue: "RK9-626",
    summary: `event number ${i} with a reasonably long summary text to fill the budget`,
    actor: "worktree:RK9-625",
  };
}

describe("coord journal units", () => {
  it("renders 50 events into at most 400 chars with a +N more tail", () => {
    const events = Array.from({ length: 50 }, (_, i) => fakeEvent(i));
    const line = formatRk9CoordDeltaLine(events, 50);
    expect(line.length).toBeLessThanOrEqual(RK9_COORD_LINE_MAX);
    const match = /\+(\d+) more: rk9 board$/.exec(line);
    expect(match).not.toBeNull();
    const shown = (line.match(/ @RK9-625/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown + Number(match![1])).toBe(50);
  });

  it("has no tail when everything fits, and cuts a single huge event", () => {
    expect(formatRk9CoordDeltaLine([fakeEvent(1)], 1)).toMatch(/^rk9: deploy RK9-626: event number 1 .* @RK9-625$/);
    const huge = { ...fakeEvent(2), summary: "x".repeat(1000) };
    const line = formatRk9CoordDeltaLine([huge, fakeEvent(3)], 2);
    expect(line.length).toBeLessThanOrEqual(RK9_COORD_LINE_MAX);
    expect(line).toMatch(/…( · \+1 more: rk9 board)$/);
  });

  it("redacts secrets, collapses to one line and caps", () => {
    const raw = "deploy ok\n\ttoken=supersecretvalue ghp_abcdefghijkl Bearer abcdefgh12345 rk9_coord_AAAAAAAAAAAAAAA https://user:pw@host";
    const out = toRk9CoordLine(raw, 500)!;
    expect(out).not.toMatch(/\n|\t/);
    expect(out).not.toContain("supersecretvalue");
    expect(out).not.toContain("ghp_abcdefghijkl");
    expect(out).not.toContain("abcdefgh12345");
    expect(out).not.toContain("rk9_coord_AAAA");
    expect(out).not.toContain("user:pw@");
    expect(out.startsWith("deploy ok [redacted]")).toBe(true);
    expect(toRk9CoordLine("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
    expect(toRk9CoordLine(" \n ", 10)).toBeNull();
    // Control characters cannot split a secret past the pattern (\s misses C0).
    expect(toRk9CoordLine("Bearer\u0001abcdefgh12345", 200)).toBe("[redacted]");
    expect(toRk9CoordLine("token\u0001=\u0001secretvalue1", 200)).not.toContain("secretvalue1");
    expect(toRk9CoordLine("a\u0000b", 200)).toBe("ab");
    // Zero-width and bidi characters cannot split a secret either.
    expect(toRk9CoordLine("ghp_\u200bABCDEFGHIJKLMNOPQRSTUVWXYZ0123", 200)).toBe("[redacted]");
    expect(toRk9CoordLine("ok \u202ehidden text", 200)).toBe("ok hidden text");
    expect(toRk9CoordLine("ghp_\u00adABCDEFGHIJKLMNOPQRSTUVWXYZ0123", 200)).toBe("[redacted]");
    // Plural keyword forms are redacted as well as the singular ones. The
    // canary value is built at runtime so the secret scanner of this repo
    // does not flag the test source.
    const canary = ["abcd", "efgh", "1234"].join("");
    for (const raw of [
      `passwords=${"hunter2"}${"hunter2"}`,
      `secrets: ${canary}`,
      `tokens="${canary}"`,
      `api_keys=${canary}`,
      `apiKeys: ${canary}`,
      `PASSWORDS = ${"hunter2"}${"hunter2"}`,
      `password=${"hunter2"}${"hunter2"}`,
    ]) {
      const out = toRk9CoordLine(`note ${raw} end`, 200)!;
      expect(out, raw).toContain("[redacted]");
      expect(out, raw).not.toMatch(/hunter2hunter2|abcdefgh1234/);
    }
    // A pattern that spans a tab is redacted on the raw text.
    expect(toRk9CoordLine("ssh://user:pa\tssword@host", 200)).not.toContain("ssword");
  });

  it("flags secrets in identifiers only at a word start", () => {
    for (const ok of ["rk9-ai/task-runner", "kiosk-frontend", "disk-monitor", "task-3f9e2a1b-aaaa"]) {
      expect(rk9CoordIdentifierHasSecret(ok), ok).toBe(false);
    }
    for (const bad of ["sk-abcdefghijklmnop", "pcp_board_abcdefghijkl", "rk9-ai/ghp_abcdefghijkl", "rk9_coord_AAAAAAAA"]) {
      expect(rk9CoordIdentifierHasSecret(bad), bad).toBe(true);
    }
  });

  it("keeps the line within 400 UTF-16 units with astral characters", () => {
    const emoji = "\u{1F680}".repeat(290);
    const events = Array.from({ length: 5 }, (_, i) => ({ ...fakeEvent(i), summary: emoji }));
    const line = formatRk9CoordDeltaLine(events, 5);
    expect(line.length).toBeLessThanOrEqual(RK9_COORD_LINE_MAX);
    expect(line).toMatch(/\+4 more: rk9 board$/);
    // No lone surrogate from a cut inside a pair.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(line)).toBe(false);
  });

  it("validates the discriminated union", () => {
    expect(appendRk9CoordEventSchema.safeParse({ type: "lease", resource: "prod:x" }).success).toBe(false);
    expect(appendRk9CoordEventSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(appendRk9CoordEventSchema.safeParse({ type: "deploy", app: "bk", result: "success" }).success).toBe(false);
    expect(appendRk9CoordEventSchema.safeParse({ type: "blocker", what: "x" }).success).toBe(false);
    expect(
      appendRk9CoordEventSchema.safeParse({ type: "ask-operator", question: "go?", urgency: "high" }).success,
    ).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-journal] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord journal against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let companySeq = 0;

  async function newCompany() {
    const id = randomUUID();
    companySeq += 1;
    await db.insert(companies).values({ id, name: `Coord ${companySeq}`, issuePrefix: `RJ${companySeq}` });
    return id;
  }

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

  const hostToken = (cid: string): Rk9CoordTokenPrincipal => ({
    tokenId: "t-host",
    companyId: cid,
    principalKind: "host",
    principalName: "mv-laptop",
  });
  const none = { type: "none", source: "none" } as Actor;

  const base = (cid: string) => `/api/companies/${cid}/rk9/coord`;

  async function post(cid: string, actorId: string, body: Record<string, unknown>, actor: Actor = boardKey([cid])) {
    return request(appFor(actor)).post(`${base(cid)}/events`).set("X-RK9-Actor", actorId).send(body);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-journal-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "RK9 journal", issuePrefix: "RKJ" },
      { id: otherCompanyId, name: "Other journal", issuePrefix: "RKX" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("appends a typed event with redacted one-line text and an activity row", async () => {
    const res = await post(companyId, "worktree:RK9-626", {
      type: "decision",
      issue: "RK9-626",
      repo: "mv50000/paperclip",
      title: "Use the\nline format",
      rationale: "Saves tokens; password=hunter2hunter2 must not leak",
      vault_note: "rk9/resources/coord_bus.md",
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.event).toMatchObject({
      type: "decision",
      actor: "worktree:RK9-626",
      actor_kind: "worktree",
      trust: "attributed",
      issue: "RK9-626",
      summary: "Use the line format",
      vault_path: "rk9/resources/coord_bus.md",
    });
    expect(JSON.stringify(res.body.event.payload)).not.toContain("hunter2hunter2");
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "rk9.coord.event_appended")));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.entityId).toBe(String(res.body.event.id));
  });

  it("forces unverified trust for remote host rows whatever the client sends", async () => {
    const app = appFor(none, hostToken(companyId));
    const res = await request(app)
      .post(`${base(companyId)}/events`)
      .set("X-RK9-Actor", "cc:mv-laptop:sess-1")
      .send({ type: "blocker", issue: "RK9-626", what: "waiting", trust: "verified", verified: true });
    expect(res.status).toBe(201);
    expect(res.body.event.trust).toBe("unverified");
    const [row] = await db.select().from(rk9CoordEvents).where(eq(rk9CoordEvents.id, res.body.event.id));
    expect(row!.trust).toBe("unverified");
    expect(row!.payload).not.toHaveProperty("verified");
  });

  it("overwrites the ask-operator actor with the resolved caller", async () => {
    const res = await post(companyId, "worktree:RK9-626", {
      type: "ask-operator",
      question: "Merge now?",
      urgency: "high",
      options: ["yes", "no"],
      actor: "operator",
      reply_to: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.event.payload).toMatchObject({ actor: "worktree:RK9-626", urgency: "high", options: ["yes", "no"] });
    expect(res.body.event.ref_event_id).toBe(1);
    expect(res.body.event.summary).toBe("[high] Merge now?");
  });

  it("rejects unknown types and missing fields with 400", async () => {
    for (const body of [
      { type: "lease", resource: "prod:bk" },
      { type: "bogus" },
      { type: "deploy", app: "bk", result: "success" },
      { type: "handoff", summary: "no issue" },
      {},
    ]) {
      const res = await post(companyId, "worktree:RK9-626", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("dedupes a spool replay on client_event_id", async () => {
    const body = { type: "done", issue: "RK9-626", pr: 244, client_event_id: "spool-1" };
    const first = await post(companyId, "worktree:RK9-626", body);
    const second = await post(companyId, "worktree:RK9-626", body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.event.id).toBe(first.body.event.id);
    expect(first.body.event.summary).toBe("PR #244");
  });

  it("rejects secrets in verbatim fields and a client_event_id of another actor", async () => {
    const vault = await post(companyId, "worktree:RK9-626", {
      type: "decision",
      title: "t",
      rationale: "r",
      vault_note: "pcp_board_abcdefghijklmnop1234",
    });
    expect(vault.status).toBe(422);
    expect(vault.body.code).toBe("rk9_coord_secret_in_field");
    const app = await post(companyId, "worktree:RK9-626", {
      type: "deploy",
      app: "sk-abcdefghijklmnopqrstuv",
      sha: "abcdef1",
      result: "success",
    });
    expect(app.status).toBe(422);
    const mine = await post(companyId, "worktree:RK9-626", { type: "blocker", issue: "RK9-626", what: "a", client_event_id: "shared-1" });
    expect(mine.status).toBe(201);
    const theirs = await post(companyId, "worktree:RK9-625", { type: "blocker", issue: "RK9-625", what: "b", client_event_id: "shared-1" });
    expect(theirs.status).toBe(409);
    expect(theirs.body.code).toBe("rk9_coord_client_event_conflict");
    // Ordinary names that contain `sk-` mid-word are not secrets.
    const normal = await post(companyId, "worktree:RK9-626", {
      type: "deploy",
      app: "kiosk-frontend",
      repo: "rk9-ai/task-runner",
      sha: "abcdef1",
      result: "success",
    });
    expect(normal.status).toBe(201);
  });

  it("has no PATCH, PUT or DELETE route for events", async () => {
    const created = await post(companyId, "worktree:RK9-626", { type: "blocker", issue: "RK9-626", what: "x" });
    const id = created.body.event.id;
    const app = appFor(boardKey([companyId]));
    for (const method of ["patch", "put", "delete"] as const) {
      for (const path of [`${base(companyId)}/events/${id}`, `${base(companyId)}/events`]) {
        const res = await request(app)[method](path).set("X-RK9-Actor", "worktree:RK9-626").send({ summary: "y" });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.code).toBe("rk9_coord_not_found");
      }
    }
  });

  it("rejects UPDATE and DELETE on the events table in the database", async () => {
    const created = await post(companyId, "worktree:RK9-626", { type: "blocker", issue: "RK9-626", what: "x" });
    const id = created.body.event.id as number;
    const codeOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "no-error";
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } };
        return e.cause?.code ?? e.code;
      }
    };
    expect(await codeOf(() => db.execute(sql`update rk9_coord_events set summary = 'tampered' where id = ${id}`))).toBe("23001");
    expect(await codeOf(() => db.execute(sql`delete from rk9_coord_events where id = ${id}`))).toBe("23001");
    const [row] = await db.select().from(rk9CoordEvents).where(eq(rk9CoordEvents.id, id));
    expect(row!.summary).toBe("x");
  });

  it("returns only the actor's events after its cursor, advances it atomically and honors peek", async () => {
    const cid = await newCompany();
    const app = appFor(boardKey([cid]));
    const me = "worktree:RKD-1";
    const delta = (query = "") =>
      request(app).get(`${base(cid)}/events/delta${query}`).set("X-RK9-Actor", me);

    // A peek writes nothing, not even the stub row.
    expect((await delta("?peek=1")).status).toBe(204);
    expect(
      await db.select().from(rk9CoordActors).where(and(eq(rk9CoordActors.companyId, cid), eq(rk9CoordActors.actorRef, me))),
    ).toHaveLength(0);
    // The actor registers (stub row) with a repo; it holds a lease.
    expect((await delta()).status).toBe(204);
    const [self] = await db
      .select()
      .from(rk9CoordActors)
      .where(and(eq(rk9CoordActors.companyId, cid), eq(rk9CoordActors.actorRef, me)));
    expect(self!.issue).toBe("RKD-1");
    await db.update(rk9CoordActors).set({ repo: "rk9-ai/bk" }).where(eq(rk9CoordActors.id, self!.id));
    await db.insert(rk9CoordLeases).values({
      companyId: cid,
      resource: "prod:bk",
      holderActorId: self!.id,
      expiresAt: new Date(Date.now() + 600_000),
    });

    const other = "worktree:RKD-2";
    await post(cid, other, { type: "blocker", issue: "RKD-1", what: "mine by issue" });
    await post(cid, other, { type: "blocker", issue: "RKD-2", what: "not mine" });
    await post(cid, other, { type: "deploy", app: "saatavilla", sha: "abcdef1234", result: "success" });
    await post(cid, other, { type: "decision", repo: "rk9-ai/bk", title: "mine by repo", rationale: "r" });
    await post(cid, me, { type: "blocker", issue: "RKD-1", what: "my own event" });
    await post(cid, other, { type: "ask-operator", question: "global ask", urgency: "low" });
    // A lease event (server-produced type) on the held resource.
    await db.insert(rk9CoordEvents).values({
      companyId: cid,
      type: "lease",
      actorRef: other,
      actorKind: "worktree",
      trust: "attributed",
      resource: "prod:bk",
      summary: "queued behind you",
    });

    const peeked = await delta("?peek=1");
    expect(peeked.status).toBe(200);
    expect(peeked.body.peek).toBe(true);
    const again = await delta("?peek=1");
    expect(again.body.events).toHaveLength(peeked.body.events.length);

    const first = await delta();
    expect(first.status).toBe(200);
    const summaries = first.body.events.map((event: { summary: string }) => event.summary);
    expect(summaries).toEqual([
      "mine by issue",
      "saatavilla abcdef1 success",
      "mine by repo",
      "[low] global ask",
      "queued behind you",
    ]);
    expect(first.body.total).toBe(5);
    expect(first.body.cursor).toBeGreaterThan(first.body.previous_cursor);

    const second = await delta();
    expect(second.status).toBe(204);
    expect(second.text).toBe("");
    const line = await delta("?fmt=line");
    expect(line.status).toBe(204);
    expect(line.text).toBe("");

    // ?actorId must name the caller.
    const spoof = await delta(`?actorId=${encodeURIComponent(other)}`);
    expect(spoof.status).toBe(403);
    expect(spoof.body.code).toBe("rk9_coord_actor_spoof");
    expect((await delta(`?actorId=${encodeURIComponent(me)}`)).status).toBe(204);

    // Concurrent consumers of one actor: exactly one gets the new event.
    await post(cid, other, { type: "blocker", issue: "RKD-1", what: "race" });
    const results = await Promise.all([delta(), delta(), delta()]);
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 204)).toHaveLength(2);
  });

  it("returns a <= 400-char text/plain line with +N more for 50 matching events", async () => {
    const cid = await newCompany();
    const app = appFor(boardKey([cid]));
    const me = "worktree:RKL-1";
    expect((await request(app).get(`${base(cid)}/events/delta`).set("X-RK9-Actor", me)).status).toBe(204);
    await db.insert(rk9CoordEvents).values(
      Array.from({ length: 50 }, (_, i) => ({
        companyId: cid,
        type: "blocker",
        actorRef: "worktree:RKL-2",
        actorKind: "worktree",
        trust: "attributed",
        issue: "RKL-1",
        summary: `blocker number ${i} waits for the migration window`,
      })),
    );
    const res = await request(app).get(`${base(cid)}/events/delta?fmt=line`).set("X-RK9-Actor", me);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text.length).toBeLessThanOrEqual(400);
    expect(res.text).toMatch(/^rk9: blocker RKL-1: blocker number 49 /);
    expect(res.text).toMatch(/\+\d+ more: rk9 board$/);
    expect((await request(app).get(`${base(cid)}/events/delta?fmt=line`).set("X-RK9-Actor", me)).status).toBe(204);
  });

  it("keeps companies apart", async () => {
    const res = await request(appFor(boardKey([companyId])))
      .get(`${base(otherCompanyId)}/events/delta`)
      .set("X-RK9-Actor", "worktree:RK9-626");
    expect(res.status).toBe(403);
    const write = await post(otherCompanyId, "worktree:RK9-626", { type: "blocker", issue: "RK9-626", what: "x" }, boardKey([companyId]));
    expect(write.status).toBe(403);
    const token = await request(appFor(none, hostToken(companyId)))
      .get(`${base(otherCompanyId)}/board`)
      .set("X-RK9-Actor", "remote:mv-laptop");
    expect(token.status).toBe(403);
    expect(token.body.code).toBe("rk9_coord_wrong_company");
    // The other company's delta never sees this company's events.
    const own = await request(appFor(boardKey([otherCompanyId])))
      .get(`${base(otherCompanyId)}/events/delta`)
      .set("X-RK9-Actor", "worktree:RK9-626");
    expect(own.status).toBe(204);
  });

  it("serves the full board, without message bodies for unverified viewers", async () => {
    const cid = await newCompany();
    await post(cid, "worktree:RKB-1", { type: "blocker", issue: "RKB-1", what: "board event" });
    await db.insert(rk9CoordInbox).values({ companyId: cid, toIssue: "RKB-9", fromActorRef: "worktree:RKB-1", body: "hello" });
    const board = await request(appFor(boardKey([cid]))).get(`${base(cid)}/board`);
    expect(board.status).toBe(200);
    expect(board.body.events[0]).toMatchObject({ summary: "board event" });
    expect(Array.isArray(board.body.actors)).toBe(true);
    expect(board.body.inbox[0]).toMatchObject({ to: "RKB-9", body: "hello" });
    expect(Array.isArray(board.body.leases)).toBe(true);
    const remote = await request(appFor(none, hostToken(cid))).get(`${base(cid)}/board`);
    expect(remote.status).toBe(200);
    expect(remote.body.inbox[0].body).toBeNull();
  });

  it("prunes old events, ended actors and old inbox rows idempotently and keeps decisions a year", async () => {
    const cid = await newCompany();
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);
    const event = (type: string, days: number, summary: string) => ({
      companyId: cid,
      type,
      actorRef: "worktree:RKR-1",
      actorKind: "worktree",
      trust: "attributed",
      summary,
      createdAt: daysAgo(days),
    });
    await db.insert(rk9CoordEvents).values([
      event("deploy", 100, "old deploy"),
      event("deploy", 10, "new deploy"),
      event("decision", 200, "decision 200d"),
      event("decision-vaulted", 300, "vaulted 300d"),
      event("decision", 365, "decision 365d"),
      event("decision", 400, "decision 400d"),
    ]);
    await db.insert(rk9CoordActors).values([
      { companyId: cid, kind: "orch", actorRef: "orch:ended-old", trust: "attributed", endedAt: daysAgo(8) },
      { companyId: cid, kind: "orch", actorRef: "orch:ended-new", trust: "attributed", endedAt: daysAgo(1) },
      { companyId: cid, kind: "orch", actorRef: "orch:live", trust: "attributed" },
    ]);
    await db.insert(rk9CoordInbox).values([
      { companyId: cid, toName: "x", fromActorRef: "orch:live", body: "old", deliveredAt: daysAgo(31) },
      { companyId: cid, toName: "x", fromActorRef: "orch:live", body: "fresh", deliveredAt: daysAgo(1) },
      { companyId: cid, toName: "x", fromActorRef: "orch:live", body: "pending" },
    ]);

    const first = await pruneRk9Coord(db, { now });
    expect(first.events).toBeGreaterThanOrEqual(2);
    const events = await db.select({ summary: rk9CoordEvents.summary }).from(rk9CoordEvents).where(eq(rk9CoordEvents.companyId, cid));
    expect(events.map((row) => row.summary).sort()).toEqual(["decision 200d", "decision 365d", "new deploy", "vaulted 300d"]);
    const actors = await db.select({ ref: rk9CoordActors.actorRef }).from(rk9CoordActors).where(eq(rk9CoordActors.companyId, cid));
    expect(actors.map((row) => row.ref).sort()).toEqual(["orch:ended-new", "orch:live"]);
    const inbox = await db.select({ body: rk9CoordInbox.body }).from(rk9CoordInbox).where(eq(rk9CoordInbox.companyId, cid));
    expect(inbox.map((row) => row.body).sort()).toEqual(["fresh", "pending"]);

    const second = await pruneRk9Coord(db, { now });
    expect(second).toEqual({ events: 0, actors: 0, inbox: 0, leases: 0 });

    // The prune exception is transaction-local: a plain DELETE still fails.
    await expect(db.execute(sql`delete from rk9_coord_events where company_id = ${cid}`)).rejects.toThrow();
  });
});
