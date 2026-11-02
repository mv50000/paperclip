// RK9 Custom (RK9-631): `rk9 decision --vault` server half. The decision-vaulted
// follow-up event (one per decision, append-only) and the vault-pending list
// that `rk9 decision --retry` reads, against real Postgres.
// Contract: docs/implementation-notes/coord-bus.md ("Decision vault").
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, rk9CoordEvents } from "@paperclipai/db";
import { appendRk9CoordEventSchema, RK9_COORD_DECISION_NOTE_PATTERN } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
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

describe("decision-vaulted schema", () => {
  const ok = { type: "decision-vaulted", ref_event_id: 5, vault_path: "rk9/areas/decision_log.md", commit: "abc1234" };

  it("accepts a well-formed follow-up", () => {
    expect(appendRk9CoordEventSchema.safeParse(ok).success).toBe(true);
    expect(appendRk9CoordEventSchema.safeParse({ ...ok, pushed: false }).success).toBe(true);
  });

  it.each([
    ["no ref", { ...ok, ref_event_id: undefined }],
    ["ref 0", { ...ok, ref_event_id: 0 }],
    ["other company", { ...ok, vault_path: "saatavilla/areas/x.md" }],
    ["personal", { ...ok, vault_path: "personal/areas/x.md" }],
    ["dot dot", { ...ok, vault_path: "rk9/areas/../x.md" }],
    ["sub dir", { ...ok, vault_path: "rk9/areas/a/b.md" }],
    ["daily", { ...ok, vault_path: "rk9/daily/2026-11-02.md" }],
    ["upper case", { ...ok, vault_path: "rk9/areas/Decision.md" }],
    ["dot name", { ...ok, vault_path: "rk9/areas/..md" }],
    ["short commit", { ...ok, commit: "abc12" }],
    ["upper commit", { ...ok, commit: "ABC1234" }],
  ])("rejects %s", (_label, body) => {
    expect(appendRk9CoordEventSchema.safeParse(body).success).toBe(false);
  });

  it("note pattern matches the vault-mcp decision_append grammar", () => {
    expect(RK9_COORD_DECISION_NOTE_PATTERN.test("rk9/tacit/x_y-z.v2.md")).toBe(true);
    expect(RK9_COORD_DECISION_NOTE_PATTERN.test("rk9/areas/.md")).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-decision-vaulted] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("decision vault follow-up against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const note = "rk9/areas/decision_log.md";

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

  function post(cid: string, actorId: string, body: Record<string, unknown>, app = appFor(boardKey([cid]))) {
    return request(app).post(`${base(cid)}/events`).set("X-RK9-Actor", actorId).send(body);
  }
  function pending(cid: string, actorId: string, query = "", app = appFor(boardKey([cid]))) {
    return request(app).get(`${base(cid)}/events/vault-pending${query}`).set("X-RK9-Actor", actorId);
  }
  async function decision(cid: string, actorId: string, title: string, vaultNote: string | null = note) {
    const res = await post(cid, actorId, {
      type: "decision",
      issue: "RK9-631",
      repo: "rk9-ai/claude-config",
      title,
      rationale: "x".repeat(1500),
      ...(vaultNote ? { vault_note: vaultNote } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.event as { id: number; payload: { rationale: string } };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-vaulted-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "RK9 vault", issuePrefix: "RKV" },
      { id: otherCompanyId, name: "Other vault", issuePrefix: "RKW" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("keeps a 1500-character rationale (cap 2000)", async () => {
    const d = await decision(companyId, "worktree:RK9-631", "long why");
    expect(d.payload.rationale).toHaveLength(1500);
  });

  it("lists a pending decision, closes it once, and a retry is a duplicate", async () => {
    const d = await decision(companyId, "worktree:RK9-631", "pick the default note");
    let res = await pending(companyId, "worktree:RK9-631", `?id=${d.id}`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: number }) => e.id)).toEqual([d.id]);
    expect(res.body.events[0]).toMatchObject({ vault_path: note, issue: "RK9-631" });

    const body = { type: "decision-vaulted", ref_event_id: d.id, vault_path: note, commit: "abc1234", pushed: false };
    res = await post(companyId, "cc:paperclip-01:sess-2", body);
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({
      type: "decision-vaulted",
      ref_event_id: d.id,
      vault_path: note,
      issue: "RK9-631",
      repo: "rk9-ai/claude-config",
      payload: { commit: "abc1234", pushed: false },
    });
    expect(res.body.event.summary).toBe(`#${d.id} -> ${note} @abc1234 (push pending)`);

    // A second retry (even with another commit) never adds a second follow-up.
    res = await post(companyId, "worktree:RK9-631", { ...body, commit: "def5678" });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.event.payload.commit).toBe("abc1234");
    const rows = await db
      .select()
      .from(rk9CoordEvents)
      .where(and(eq(rk9CoordEvents.companyId, companyId), eq(rk9CoordEvents.refEventId, d.id)));
    expect(rows).toHaveLength(1);

    res = await pending(companyId, "worktree:RK9-631", `?id=${d.id}`);
    expect(res.body.events).toEqual([]);
  });

  it("two concurrent follow-ups store one row", async () => {
    const d = await decision(companyId, "worktree:RK9-631", "race");
    const body = { type: "decision-vaulted", ref_event_id: d.id, vault_path: note, commit: "1234567" };
    const results = await Promise.all([1, 2, 3].map(() => post(companyId, "worktree:RK9-631", body)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const rows = await db
      .select()
      .from(rk9CoordEvents)
      .where(and(eq(rk9CoordEvents.companyId, companyId), eq(rk9CoordEvents.refEventId, d.id)));
    expect(rows).toHaveLength(1);
  });

  it("refuses a follow-up for a missing, foreign, non-decision or mismatched event", async () => {
    const d = await decision(companyId, "worktree:RK9-631", "refusals");
    const body = { type: "decision-vaulted", ref_event_id: d.id, vault_path: note, commit: "abc1234" };
    let res = await post(companyId, "worktree:RK9-631", { ...body, ref_event_id: d.id + 100000 });
    expect(res.status).toBe(404);
    expect(res.body.code ?? res.body.details?.code).toBe("rk9_coord_event_not_found");

    res = await post(otherCompanyId, "worktree:RK9-631", body);
    expect(res.status).toBe(404);

    const blocker = await post(companyId, "worktree:RK9-631", { type: "blocker", issue: "RK9-631", what: "x" });
    res = await post(companyId, "worktree:RK9-631", { ...body, ref_event_id: blocker.body.event.id });
    expect(res.status).toBe(404);

    res = await post(companyId, "worktree:RK9-631", { ...body, vault_path: "rk9/areas/other_note.md" });
    expect(res.status).toBe(409);

    const plain = await decision(companyId, "worktree:RK9-631", "no vault", null);
    res = await post(companyId, "worktree:RK9-631", { ...body, ref_event_id: plain.id });
    expect(res.status).toBe(409);
    res = await pending(companyId, "worktree:RK9-631", `?id=${plain.id}`);
    expect(res.body.events).toEqual([]);
  });

  it("a remote host token closes and lists only its own decisions", async () => {
    const remote = appFor(none, hostToken(companyId));
    const mine = await post(companyId, "cc:mv-laptop:sess-9", {
      type: "decision",
      title: "remote decision",
      rationale: "r",
      vault_note: note,
    }, remote);
    expect(mine.status).toBe(201);
    expect(mine.body.event.trust).toBe("unverified");
    const theirs = await decision(companyId, "worktree:RK9-631", "local decision");

    const listed = await pending(companyId, "cc:mv-laptop:sess-9", "?limit=100", remote);
    const ids = listed.body.events.map((e: { id: number }) => e.id);
    expect(ids).toContain(mine.body.event.id);
    expect(ids).not.toContain(theirs.id);

    const body = { type: "decision-vaulted", vault_path: note, commit: "abc1234" };
    let res = await post(companyId, "cc:mv-laptop:sess-9", { ...body, ref_event_id: theirs.id }, remote);
    expect(res.status).toBe(403);
    res = await post(companyId, "cc:mv-laptop:sess-9", { ...body, ref_event_id: mine.body.event.id }, remote);
    expect(res.status).toBe(201);
  });

  it("vault-pending needs a resolved actor", async () => {
    const res = await request(appFor(boardKey([companyId]))).get(`${base(companyId)}/events/vault-pending`);
    expect(res.status).toBe(400);
  });
});
// --- /RK9 Custom ---
