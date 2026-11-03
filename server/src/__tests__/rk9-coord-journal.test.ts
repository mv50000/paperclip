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
  agents,
  companies,
  heartbeatRuns,
  createDb,
  rk9CoordActors,
  rk9CoordCursors,
  rk9CoordEvents,
  rk9CoordInbox,
  rk9CoordLeases,
} from "@paperclipai/db";
import { appendRk9CoordEventSchema } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordAgentRun, Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
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

  it("validates the headsup body (RK9-647)", () => {
    const ok = { type: "headsup", text: "CI is red on master", class: "other", observation_key: "0123abcd" };
    expect(appendRk9CoordEventSchema.safeParse(ok).success).toBe(true);
    expect(
      appendRk9CoordEventSchema.safeParse({
        ...ok,
        class: "operator",
        class_rule: "prod_write",
        explanation: "why",
        session_id: "3f9e2a1b-aaaa.1",
        issue: "RK9-636",
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...ok, text: "   " },
      { ...ok, text: "x".repeat(2001) },
      { ...ok, explanation: "x".repeat(4001) },
      { ...ok, class: "decision" },
      { ...ok, class_rule: "Prod" },
      { ...ok, class_rule: "a".repeat(41) },
      { ...ok, observation_key: "0123ABCD" },
      { ...ok, observation_key: "0123abc" },
      { ...ok, observation_key: "a".repeat(65) },
      { ...ok, session_id: "-bad" },
      { ...ok, issue: "rk9-1" },
      { type: "headsup", text: "x", class: "other" },
    ]) {
      expect(appendRk9CoordEventSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
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

  function appFor(
    actor: Actor,
    principal?: Rk9CoordTokenPrincipal,
    findAgentRun: (runId: string) => Promise<Rk9CoordAgentRun | null> = async () => null,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      if (principal) req.rk9CoordPrincipal = principal;
      next();
    });
    app.use("/api", rk9CoordRoutes(db, { boardHost: "paperclip-01", boardKeyIds: null, findAgentRun }));
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

  it("lets grok post only blocker, handoff and ask-operator, always unverified (RK9-647)", async () => {
    const grok = request(appFor(none, { tokenId: "t-grok", companyId, principalKind: "service", principalName: "grok" }));
    const send = (body: Record<string, unknown>) => grok.post(`${base(companyId)}/events`).set("X-RK9-Actor", "grok").send(body);
    const allowed = await send({ type: "blocker", issue: "RK9-626", what: "grok sees a blocker", trust: "verified" });
    expect(allowed.status).toBe(201);
    expect(allowed.body.event).toMatchObject({ actor: "grok", actor_kind: "grok", trust: "unverified" });
    for (const body of [
      { type: "decision", title: "t", rationale: "r" },
      { type: "deploy", app: "bk", sha: "abcdef1", result: "success" },
      { type: "done", issue: "RK9-626" },
      { type: "headsup", text: "x", class: "other", observation_key: "abcdef01" },
      { type: "decision-vaulted", ref_event_id: 1, vault_path: "rk9/resources/x.md", commit: "abcdef1" },
      { type: "lease", resource: "prod:bk" },
      {},
    ]) {
      const denied = await send(body);
      expect(denied.status, JSON.stringify(body)).toBe(403);
      expect(denied.body.code).toBe("rk9_coord_event_kind_not_allowed");
    }
  });

  it("records break-glass for cc, operator and rk9claude only, visible in every delta (RK9-647)", async () => {
    const cid = await newCompany();
    const wt = "worktree:RKG-1";
    const wtDelta = () => request(appFor(boardKey([cid]))).get(`${base(cid)}/events/delta`).set("X-RK9-Actor", wt);
    expect((await wtDelta()).status).toBe(204);
    const body = { type: "break-glass", resource: "prod:bk", gate: "deploy", reason: "hotfix\nwhile CI is down" };
    const cc = await post(cid, "cc:paperclip-01:sess-bg", body);
    expect(cc.status).toBe(201);
    expect(cc.body.event).toMatchObject({
      type: "break-glass",
      actor_kind: "cc",
      trust: "attributed",
      resource: "prod:bk",
      summary: "BREAK-GLASS deploy prod:bk: hotfix while CI is down",
      payload: { resource: "prod:bk", gate: "deploy", reason: "hotfix while CI is down" },
    });
    const rk9claude = await request(appFor(none, { tokenId: "t-rc", companyId: cid, principalKind: "service", principalName: "rk9claude" }))
      .post(`${base(cid)}/events`)
      .set("X-RK9-Actor", "rk9claude")
      .send({ ...body, gate: "host", resource: "host:pve1", reason: "node down" });
    expect(rk9claude.status).toBe(201);
    expect(rk9claude.body.event.trust).toBe("verified");
    // Denied kinds get 403, also with an invalid body (the gate runs first).
    for (const actorId of ["worktree:RKG-2", "headless:3f9e2a1b-aaaa", "orch:wave"]) {
      const denied = await post(cid, actorId, body);
      expect(denied.status, actorId).toBe(403);
      expect(denied.body.code).toBe("rk9_coord_event_kind_not_allowed");
    }
    expect((await post(cid, "worktree:RKG-2", { type: "break-glass" })).status).toBe(403);
    for (const [principal, actorId] of [
      [{ tokenId: "t-g", companyId: cid, principalKind: "service", principalName: "grok" }, "grok"],
      [hostToken(cid), "remote:mv-laptop"],
    ] as const) {
      const denied = await request(appFor(none, principal as Rk9CoordTokenPrincipal))
        .post(`${base(cid)}/events`)
        .set("X-RK9-Actor", actorId)
        .send(body);
      expect(denied.status, actorId).toBe(403);
      expect(denied.body.code).toBe("rk9_coord_event_kind_not_allowed");
    }
    // An allowed kind with a missing reason, a bad gate or a bad resource is 400.
    for (const bad of [
      { type: "break-glass", resource: "prod:bk", gate: "deploy" },
      { ...body, reason: "   " },
      { ...body, gate: "lease" },
      { ...body, resource: "bk" },
      { ...body, resource: "prod:../x" },
    ]) {
      expect((await post(cid, "cc:paperclip-01:sess-bg", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // Every actor sees it, like deploy.
    const delta = await wtDelta();
    expect(delta.status).toBe(200);
    expect(delta.body.events.map((event: { type: string }) => event.type)).toEqual(["break-glass", "break-glass"]);
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

  it("stores a headsup as unverified with the observed actor and the label (RK9-647)", async () => {
    const cid = await newCompany();
    const res = await post(cid, "worktree:RKH-1", {
      type: "headsup",
      text: "Deploy\nwindow is open; password=hunter2hunter2",
      explanation: `${"e".repeat(1500)}`,
      class: "operator",
      class_rule: "prod_write",
      observation_key: "deadbeef01",
      session_id: "sess-1",
      issue: "RKH-1",
      repo: "rk9-ai/bk",
      trust: "verified",
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    const event = res.body.event;
    // Board key + worktree is normally attributed; a headsup is always unverified.
    expect(event.trust).toBe("unverified");
    expect(event.type).toBe("headsup");
    expect(event.issue).toBe("RKH-1");
    expect(event.summary.startsWith("[Heads up, varmistamaton] Deploy window is open; ")).toBe(true);
    expect(event.summary).not.toContain("hunter2hunter2");
    expect(event.summary.length).toBeLessThanOrEqual(300);
    expect(event.payload).toMatchObject({
      class: "operator",
      class_rule: "prod_write",
      observation_key: "deadbeef01",
      session_id: "sess-1",
      observed_actor: "worktree:RKH-1",
      verified: false,
      issue: "RKH-1",
    });
    expect(event.payload.text).not.toContain("hunter2hunter2");
    expect(event.payload.explanation.length).toBe(1000);
    const [row] = await db.select().from(rk9CoordEvents).where(eq(rk9CoordEvents.id, event.id));
    expect(row!.dedupeKey).toBe("deadbeef01");
    expect(row!.trust).toBe("unverified");
    // The server never creates an ask-operator from a headsup.
    const asks = await db
      .select()
      .from(rk9CoordEvents)
      .where(and(eq(rk9CoordEvents.companyId, cid), eq(rk9CoordEvents.type, "ask-operator")));
    expect(asks).toHaveLength(0);

    // class=other drops class_rule; a long text is capped in payload and summary.
    const other = await post(cid, "worktree:RKH-1", {
      type: "headsup",
      text: "y".repeat(2000),
      class: "other",
      class_rule: "ignored_rule",
      observation_key: "deadbeef02",
    });
    expect(other.status).toBe(201);
    expect(other.body.event.payload).not.toHaveProperty("class_rule");
    expect(other.body.event.payload).not.toHaveProperty("explanation");
    expect(other.body.event.payload.text.length).toBe(500);
    expect(other.body.event.summary.length).toBe(300);
  });

  it("dedupes on (company, type, dedupe_key) for any actor and keeps the client_event_id path (RK9-647)", async () => {
    const cid = await newCompany();
    const body = { type: "headsup", text: "same observation", class: "other", observation_key: "cafe0001" };
    const first = await post(cid, "worktree:RKP-1", body);
    expect(first.status).toBe(201);
    // Another actor, another credential path: the stored row, not a 500.
    const second = await post(cid, "worktree:RKP-2", { ...body, text: "worded differently" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true, event: { id: first.body.event.id, actor: "worktree:RKP-1" } });
    const remote = await request(appFor(none, hostToken(cid)))
      .post(`${base(cid)}/events`)
      .set("X-RK9-Actor", "remote:mv-laptop")
      .send(body);
    expect(remote.status).toBe(200);
    expect(remote.body.event.id).toBe(first.body.event.id);
    // A fresh client_event_id does not bypass the dedupe key.
    const withClientId = await post(cid, "worktree:RKP-2", { ...body, client_event_id: "hu-1" });
    expect(withClientId.status).toBe(200);
    expect(withClientId.body.event.id).toBe(first.body.event.id);
    // The key is per type: the same key on another type would be a new row,
    // and a new key is a new event.
    const fresh = await post(cid, "worktree:RKP-2", { ...body, observation_key: "cafe0002" });
    expect(fresh.status).toBe(201);
    const rows = await db
      .select()
      .from(rk9CoordEvents)
      .where(and(eq(rk9CoordEvents.companyId, cid), eq(rk9CoordEvents.type, "headsup")));
    expect(rows).toHaveLength(2);
    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, cid), eq(activityLog.action, "rk9.coord.event_appended")));
    expect(activity).toHaveLength(2);

    // client_event_id path unchanged: same actor replay is 200, another actor is 409.
    const spool = { type: "headsup", text: "spooled", class: "other", observation_key: "cafe0003", client_event_id: "hu-spool" };
    expect((await post(cid, "worktree:RKP-1", spool)).status).toBe(201);
    const replay = await post(cid, "worktree:RKP-1", spool);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    const stolen = await post(cid, "worktree:RKP-2", { ...spool, observation_key: "cafe0004" });
    expect(stolen.status).toBe(409);
    expect(stolen.body.code).toBe("rk9_coord_client_event_conflict");
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
    // RK9-647: a worktree never gets ask-operator (not even by issue) or headsup.
    await post(cid, other, { type: "ask-operator", question: "ask on my issue", urgency: "low", issue: "RKD-1" });
    await post(cid, other, { type: "headsup", text: "my issue", class: "other", observation_key: "beef0001", issue: "RKD-1" });
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
      "queued behind you",
    ]);
    expect(first.body.total).toBe(4);
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

  it("follows the issues the caller handed off in the last 24 h, at most 50 (RK9-650)", async () => {
    const cid = await newCompany();
    const app = appFor(boardKey([cid]));
    const parent = "cc:paperclip-01:parent-650";
    const child = "worktree:RKD-650";
    const delta = () => request(app).get(`${base(cid)}/events/delta`).set("X-RK9-Actor", parent);
    expect((await delta()).status).toBe(204);

    await post(cid, parent, { type: "handoff", issue: "RKD-650", summary: "go", to: "headless" });
    // Another actor's handoff does not widen the parent's concerns.
    await post(cid, "cc:paperclip-01:other-650", { type: "handoff", issue: "RKD-651", summary: "go" });
    await post(cid, child, { type: "done", issue: "RKD-650", pr: 7 });
    await post(cid, child, { type: "blocker", issue: "RKD-650", what: "stuck" });
    await post(cid, "worktree:RKD-651", { type: "done", issue: "RKD-651", pr: 8 });
    await post(cid, "worktree:RKD-652", { type: "done", issue: "RKD-652", pr: 9 });
    const seen = await delta();
    expect(seen.status).toBe(200);
    expect(seen.body.events.map((event: { type: string; issue: string }) => `${event.type}:${event.issue}`)).toEqual([
      "done:RKD-650",
      "blocker:RKD-650",
    ]);
    // The cursor moved past them.
    expect((await delta()).status).toBe(204);

    // A handoff older than 24 h is not followed.
    await db.insert(rk9CoordEvents).values({
      companyId: cid,
      type: "handoff",
      actorRef: parent,
      actorKind: "cc",
      trust: "attributed",
      issue: "RKD-660",
      summary: "old",
      createdAt: new Date(Date.now() - 25 * 3600 * 1000),
    });
    await post(cid, "worktree:RKD-660", { type: "done", issue: "RKD-660", pr: 10 });
    expect((await delta()).status).toBe(204);

    // Only the newest 50 handed-off issues are followed.
    await db.insert(rk9CoordEvents).values(
      Array.from({ length: 51 }, (_, i) => ({
        companyId: cid,
        type: "handoff",
        actorRef: parent,
        actorKind: "cc",
        trust: "attributed",
        issue: `RKD-7${String(i).padStart(2, "0")}`,
        summary: "bulk",
      })),
    );
    await post(cid, "worktree:RKD-700", { type: "done", issue: "RKD-700", pr: 11 });
    await post(cid, "worktree:RKD-750", { type: "done", issue: "RKD-750", pr: 12 });
    const capped = await delta();
    expect(capped.status).toBe(200);
    expect(capped.body.events.map((event: { issue: string }) => event.issue)).toEqual(["RKD-750"]);
  });

  it("gives ask-operator only to cc and never a headsup (RK9-647)", async () => {
    const cid = await newCompany();
    const app = appFor(boardKey([cid]));
    const cc = "cc:paperclip-01:sess-ask";
    const wt = "worktree:RKA-1";
    const delta = (actorId: string, query = "") =>
      request(app).get(`${base(cid)}/events/delta${query}`).set("X-RK9-Actor", actorId);
    expect((await delta(cc)).status).toBe(204);
    expect((await delta(wt)).status).toBe(204);
    await post(cid, "worktree:RKA-2", { type: "ask-operator", question: "merge now?", urgency: "high", issue: "RKA-1" });
    await post(cid, "worktree:RKA-2", {
      type: "headsup",
      text: "seen something",
      class: "operator",
      class_rule: "prod_write",
      observation_key: "abcd0001",
      issue: "RKA-1",
    });
    await post(cid, "worktree:RKA-2", { type: "deploy", app: "bk", sha: "abcdef1", result: "success" });

    const forCc = await delta(cc);
    expect(forCc.status).toBe(200);
    expect(forCc.body.events.map((event: { type: string }) => event.type)).toEqual(["ask-operator", "deploy"]);
    const forWt = await delta(wt);
    expect(forWt.status).toBe(200);
    expect(forWt.body.events.map((event: { type: string }) => event.type)).toEqual(["deploy"]);
    expect(forWt.body.total).toBe(1);

    // The board still lists the headsup with its labelled summary, without the explanation.
    await post(cid, "worktree:RKA-2", {
      type: "headsup",
      text: "board check",
      explanation: "long reasoning",
      class: "other",
      observation_key: "abcd0002",
    });
    const board = await request(app).get(`${base(cid)}/board`);
    expect(board.status).toBe(200);
    const headsup = board.body.events.find((event: { summary: string }) => event.summary.endsWith("board check"));
    expect(headsup).toMatchObject({ type: "headsup", trust: "unverified", summary: "[Heads up, varmistamaton] board check" });
    expect(headsup.payload).not.toHaveProperty("explanation");
    expect(headsup.payload).toMatchObject({ text: "board check", verified: false });
    // Only a headsup is trimmed on the board; the stored row keeps it.
    const [row] = await db.select().from(rk9CoordEvents).where(eq(rk9CoordEvents.id, headsup.id));
    expect(row!.payload).toHaveProperty("explanation", "long reasoning");
  });

  it("gives an agent only its own questions and their answers; operator and cc see all (RK9-647)", async () => {
    const cid = await newCompany();
    const [agentA, agentB] = await db
      .insert(agents)
      .values(
        ["Asker A", "Asker B"].map((name) => ({
          companyId: cid,
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
        { companyId: cid, agentId: agentA!.id, status: "running" },
        { companyId: cid, agentId: agentA!.id, status: "running" },
        { companyId: cid, agentId: agentB!.id, status: "running" },
      ])
      .returning();
    const runs = new Map([runA1!, runA2!, runB1!].map((run) => [run.id, run]));
    const findRun = async (runId: string) => {
      const run = runs.get(runId);
      return run ? { companyId: run.companyId, agentId: run.agentId, status: run.status } : null;
    };
    const agentApp = (run: { id: string; agentId: string }) =>
      appFor(
        {
          type: "agent",
          agentId: run.agentId,
          companyId: cid,
          runId: run.id,
          source: "agent_jwt",
          keyScope: { kind: "standard" },
        } as unknown as Actor,
        undefined,
        findRun,
      );
    const operatorApp = appFor({
      type: "board",
      userId: "operator-user",
      companyIds: [cid],
      memberships: [{ companyId: cid, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      source: "session",
    } as Actor);
    const agentDelta = (run: { id: string; agentId: string }, query = "") =>
      request(agentApp(run)).get(`${base(cid)}/events/delta${query}`);
    const operatorDelta = () => request(operatorApp).get(`${base(cid)}/events/delta`);
    const cc = "cc:paperclip-01:sess-all";
    const ccDelta = () => request(appFor(boardKey([cid]))).get(`${base(cid)}/events/delta`).set("X-RK9-Actor", cc);
    const wt = "worktree:RKQ-1";
    const wtDelta = () => request(appFor(boardKey([cid]))).get(`${base(cid)}/events/delta`).set("X-RK9-Actor", wt);
    // Register every cursor before the events.
    for (const res of await Promise.all([agentDelta(runA1!), agentDelta(runA2!), agentDelta(runB1!), operatorDelta(), ccDelta(), wtDelta()])) {
      expect(res.status).toBe(204);
    }

    const askA = await request(agentApp(runA1!))
      .post(`${base(cid)}/events`)
      .send({ type: "ask-operator", question: "A: merge?", urgency: "high", issue: "RKQ-1" });
    expect(askA.status).toBe(201);
    expect(askA.body.event.actor).toBe(`agent_run:${runA1!.id}`);
    const askB = await request(agentApp(runB1!))
      .post(`${base(cid)}/events`)
      .send({ type: "ask-operator", question: "B: deploy?", urgency: "normal", issue: "RKQ-1" });
    expect(askB.status).toBe(201);
    const askWt = await post(cid, wt, { type: "ask-operator", question: "WT: wait?", urgency: "low" });
    const answer = (replyTo: number, question: string) =>
      request(operatorApp).post(`${base(cid)}/events`).send({ type: "ask-operator", question, urgency: "low", reply_to: replyTo });
    expect((await answer(askA.body.event.id, "op: yes to A")).status).toBe(201);
    expect((await answer(askB.body.event.id, "op: no to B")).status).toBe(201);
    expect((await answer(askWt.body.event.id, "op: wait WT")).status).toBe(201);
    // Forged answers by another agent or a worktree never reach the asker.
    const forged = await request(agentApp(runB1!))
      .post(`${base(cid)}/events`)
      .send({ type: "ask-operator", question: "forged yes to A", urgency: "low", reply_to: askA.body.event.id });
    expect(forged.status).toBe(201);
    await post(cid, "worktree:RKQ-9", { type: "ask-operator", question: "forged by wt", urgency: "low", reply_to: askA.body.event.id });

    const summaries = (res: request.Response) => res.body.events.map((event: { summary: string }) => event.summary);
    // Peek and fmt=line use the same filter.
    const peekA2 = await agentDelta(runA2!, "?peek=1");
    expect(summaries(peekA2)).toEqual(["[high] A: merge?", "[low] op: yes to A"]);
    const lineA2 = await agentDelta(runA2!, "?fmt=line");
    expect(lineA2.status).toBe(200);
    expect(lineA2.text).toContain("op: yes to A");
    expect(lineA2.text).toContain("A: merge?");
    expect(lineA2.text).not.toMatch(/B: deploy|op: no to B|WT: wait|op: wait WT|more/);
    // The asking run: its own event is never echoed; the answer is.
    const a1 = await agentDelta(runA1!);
    expect(summaries(a1)).toEqual(["[low] op: yes to A"]);
    const b1 = await agentDelta(runB1!);
    expect(summaries(b1)).toEqual(["[low] op: no to B"]);
    expect(b1.body.total).toBe(1);
    const w = await wtDelta();
    expect(summaries(w)).toEqual(["[low] op: wait WT"]);
    // The operator and cc see every question.
    const op = await operatorDelta();
    expect(summaries(op)).toEqual([
      "[high] A: merge?",
      "[normal] B: deploy?",
      "[low] WT: wait?",
      "[low] forged yes to A",
      "[low] forged by wt",
    ]);
    const all = await ccDelta();
    expect(all.body.events).toHaveLength(8);
  });

  it("does not echo a heads-up explanation to another actor on a dedupe hit (RK9-647)", async () => {
    const cid = await newCompany();
    const body = { type: "headsup", text: "obs", explanation: "private reasoning", class: "other", observation_key: "feed0001" };
    const first = await post(cid, "worktree:RKE-1", body);
    expect(first.body.event.payload.explanation).toBe("private reasoning");
    const mine = await post(cid, "worktree:RKE-1", body);
    expect(mine.status).toBe(200);
    expect(mine.body.event.payload.explanation).toBe("private reasoning");
    const theirs = await post(cid, "worktree:RKE-2", body);
    expect(theirs.status).toBe(200);
    expect(theirs.body.event.id).toBe(first.body.event.id);
    expect(theirs.body.event.payload).not.toHaveProperty("explanation");
    const secretRule = await post(cid, "worktree:RKE-1", { ...body, observation_key: "feed0002", class: "operator", class_rule: ["sk", "live", "abcdefghijkl"].join("_") });
    expect(secretRule.status).toBe(422);
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

  it("prunes never-ended stubs and stale actors by last activity, and old undelivered inbox rows (RK9-641)", async () => {
    const cid = await newCompany();
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);
    const registered = { presence_registered_at: "nonce" };
    const rows = await db
      .insert(rk9CoordActors)
      .values([
        { companyId: cid, kind: "cc", actorRef: "cc:h:stub-old", trust: "attributed", lastSeenAt: daysAgo(8) },
        { companyId: cid, kind: "cc", actorRef: "cc:h:stub-new", trust: "attributed", lastSeenAt: daysAgo(2) },
        { companyId: cid, kind: "cc", actorRef: "cc:h:stub-cursor", trust: "attributed", lastSeenAt: daysAgo(20) },
        { companyId: cid, kind: "cc", actorRef: "cc:h:stub-lease", trust: "attributed", lastSeenAt: daysAgo(20) },
        { companyId: cid, kind: "cc", actorRef: "cc:h:reg-8d", trust: "attributed", lastSeenAt: daysAgo(8), metadata: registered },
        { companyId: cid, kind: "cc", actorRef: "cc:h:reg-31d", trust: "attributed", lastSeenAt: daysAgo(31), metadata: registered },
      ])
      .returning({ id: rk9CoordActors.id, ref: rk9CoordActors.actorRef });
    const id = (ref: string) => rows.find((row) => row.ref === ref)!.id;
    // A delta call 1 day ago keeps the stub: its cursor moved.
    await db.insert(rk9CoordCursors).values({ companyId: cid, actorId: id("cc:h:stub-cursor"), lastEventId: 0, updatedAt: daysAgo(1) });
    await db.insert(rk9CoordLeases).values({
      companyId: cid,
      resource: "prod:rkp",
      holderActorId: id("cc:h:stub-lease"),
      expiresAt: new Date(now.getTime() + 600_000),
    });
    await db.insert(rk9CoordInbox).values([
      { companyId: cid, toName: "x", fromActorRef: "orch:live", body: "pending-old", createdAt: daysAgo(31) },
      { companyId: cid, toName: "x", fromActorRef: "orch:live", body: "pending-new", createdAt: daysAgo(29) },
    ]);

    await pruneRk9Coord(db, { now });
    const left = await db.select({ ref: rk9CoordActors.actorRef }).from(rk9CoordActors).where(eq(rk9CoordActors.companyId, cid));
    expect(left.map((row) => row.ref).sort()).toEqual(["cc:h:reg-8d", "cc:h:stub-cursor", "cc:h:stub-lease", "cc:h:stub-new"]);
    const inbox = await db.select({ body: rk9CoordInbox.body }).from(rk9CoordInbox).where(eq(rk9CoordInbox.companyId, cid));
    expect(inbox.map((row) => row.body)).toEqual(["pending-new"]);
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
