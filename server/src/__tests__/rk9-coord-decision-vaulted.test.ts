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

  // RK9-646: a decision's vault_note has the same grammar, so every noted decision can be closed.
  it.each([
    ["other company", "saatavilla/areas/x.md"],
    ["dot dot", "rk9/areas/../x.md"],
    ["sub dir", "rk9/areas/a/b.md"],
    ["daily", "rk9/daily/2026-11-02.md"],
    ["upper case", "rk9/areas/Decision.md"],
    ["no .md", "rk9/areas/decision_log"],
  ])("decision vault_note rejects %s", (_label, vaultNote) => {
    expect(appendRk9CoordEventSchema.safeParse({ type: "decision", title: "t", rationale: "r", vault_note: vaultNote }).success).toBe(false);
  });

  it("decision vault_note accepts an rk9/ decision note", () => {
    const body = { type: "decision", title: "t", rationale: "r", vault_note: "rk9/resources/coord_bus.md" };
    expect(appendRk9CoordEventSchema.safeParse(body).success).toBe(true);
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

  it("a host token closes and lists the decisions of its own host, not another host's (RK9-646)", async () => {
    const laptop = appFor(none, hostToken(companyId));
    const desktop = appFor(none, { ...hostToken(companyId), tokenId: "t-host-2", principalName: "mv-desktop" });
    const first = await post(companyId, "cc:mv-laptop:sess-old", {
      type: "decision",
      title: "host decision",
      rationale: "r",
      vault_note: note,
    }, laptop);
    expect(first.status).toBe(201);
    const bare = await post(companyId, "remote:mv-laptop", {
      type: "decision",
      title: "bare host decision",
      rationale: "r",
      vault_note: note,
    }, laptop);
    expect(bare.status).toBe(201);
    const ids = [first.body.event.id, bare.body.event.id];

    // A new session on the same host sees and closes both.
    const listed = await pending(companyId, "cc:mv-laptop:sess-new", "?limit=100", laptop);
    expect(listed.body.events.map((e: { id: number }) => e.id)).toEqual(expect.arrayContaining(ids));
    // Another host sees neither and may not close them.
    const other = await pending(companyId, "cc:mv-desktop:sess-1", "?limit=100", desktop);
    for (const id of ids) expect(other.body.events.map((e: { id: number }) => e.id)).not.toContain(id);
    const body = { type: "decision-vaulted", vault_path: note, commit: "abc1234" };
    let res = await post(companyId, "cc:mv-desktop:sess-1", { ...body, ref_event_id: ids[0] }, desktop);
    expect(res.status).toBe(403);

    res = await post(companyId, "cc:mv-laptop:sess-new", { ...body, ref_event_id: ids[0] }, laptop);
    expect(res.status).toBe(201);
    res = await post(companyId, "remote:mv-laptop", { ...body, ref_event_id: ids[1] }, laptop);
    expect(res.status).toBe(201);
  });

  it("the host list leaves out a legacy cc row with a bad session, like the close check (RK9-683)", async () => {
    const laptop = appFor(none, hostToken(companyId));
    const good = await post(companyId, "cc:mv-laptop:sess-ok", {
      type: "decision", title: "good session", rationale: "r", vault_note: note,
    }, laptop);
    expect(good.status).toBe(201);
    // The API refuses this actor id; a legacy row can only exist from before the grammar.
    const [legacy] = await db.insert(rk9CoordEvents).values({
      companyId,
      type: "decision",
      actorRef: "cc:mv-laptop:bad session",
      actorKind: "cc",
      trust: "unverified",
      summary: "legacy bad-session decision",
      payload: { title: "legacy", rationale: "r" },
      vaultPath: note,
    }).returning();
    const listed = await pending(companyId, "cc:mv-laptop:sess-new", "?limit=100", laptop);
    const ids = listed.body.events.map((e: { id: number }) => e.id);
    expect(ids).toContain(good.body.event.id);
    expect(ids).not.toContain(legacy!.id);
    const res = await post(companyId, "cc:mv-laptop:sess-new", {
      type: "decision-vaulted", vault_path: note, commit: "abc1234", ref_event_id: legacy!.id,
    }, laptop);
    expect(res.status).toBe(403);
  });

  it("an unverified caller gets 403 before any 404/409 existence answer (RK9-646)", async () => {
    const remote = appFor(none, hostToken(companyId));
    const theirs = await decision(companyId, "worktree:RK9-631", "oracle");
    const body = { type: "decision-vaulted", vault_path: note, commit: "abc1234" };
    // Missing event and another host's event answer the same.
    let res = await post(companyId, "cc:mv-laptop:sess-9", { ...body, ref_event_id: theirs.id + 100000 }, remote);
    expect(res.status).toBe(403);
    expect(res.body.code ?? res.body.details?.code).toBe("rk9_coord_vault_owner_required");
    res = await post(companyId, "cc:mv-laptop:sess-9", { ...body, ref_event_id: theirs.id, vault_path: "rk9/areas/other.md" }, remote);
    expect(res.status).toBe(403);
    // A trusted caller still gets the precise answers.
    res = await post(companyId, "worktree:RK9-631", { ...body, ref_event_id: theirs.id + 100000 });
    expect(res.status).toBe(404);
    res = await post(companyId, "worktree:RK9-631", { ...body, ref_event_id: theirs.id, vault_path: "rk9/areas/other.md" });
    expect(res.status).toBe(409);
  });

  it("leaves legacy decisions with a non-rk9 vault_path out of vault-pending (RK9-646)", async () => {
    const legacyCompany = randomUUID();
    await db.insert(companies).values({ id: legacyCompany, name: "Legacy vault", issuePrefix: "RKL" });
    const rows = await db
      .insert(rk9CoordEvents)
      .values(
        ["saatavilla/areas/x.md", "rk9/areas/Upper.md", "rk9/areas/a/b.md", note].map((vaultPath) => ({
          companyId: legacyCompany,
          type: "decision",
          actorRef: "worktree:RK9-631",
          actorKind: "worktree",
          trust: "attributed" as const,
          summary: `legacy ${vaultPath}`,
          payload: { title: "legacy", rationale: "r", vault_note: vaultPath },
          vaultPath,
        })),
      )
      .returning();
    const res = await pending(legacyCompany, "worktree:RK9-631", "?limit=100", appFor(boardKey([legacyCompany])));
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: number }) => e.id)).toEqual([rows[3]!.id]);
    expect(res.body.next_after).toBeNull();
    const one = await pending(legacyCompany, "worktree:RK9-631", `?id=${rows[0]!.id}`, appFor(boardKey([legacyCompany])));
    expect(one.body.events).toEqual([]);
  });

  it("pages vault-pending with after and next_after (RK9-646)", async () => {
    const pagedCompany = randomUUID();
    await db.insert(companies).values({ id: pagedCompany, name: "Paged vault", issuePrefix: "RKG" });
    const app = appFor(boardKey([pagedCompany]));
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await post(pagedCompany, "worktree:RK9-631", { type: "decision", title: `p${i}`, rationale: "r", vault_note: note }, app);
      expect(res.status).toBe(201);
      ids.push(res.body.event.id);
    }
    const seen: number[] = [];
    let after: number | null = 0;
    let pages = 0;
    while (after !== null && pages < 10) {
      const res = await pending(pagedCompany, "worktree:RK9-631", `?limit=2&after=${after}`, app);
      expect(res.status).toBe(200);
      seen.push(...res.body.events.map((e: { id: number }) => e.id));
      after = res.body.next_after;
      pages += 1;
    }
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
    const bad = await pending(pagedCompany, "worktree:RK9-631", "?after=-1", app);
    expect(bad.status).toBe(400);
  });

  it("vault-pending needs a resolved actor", async () => {
    const res = await request(appFor(boardKey([companyId]))).get(`${base(companyId)}/events/vault-pending`);
    expect(res.status).toBe(400);
  });
});
// --- /RK9 Custom ---
