// RK9 Custom (RK9-621): coord router actor identity, company scope and the
// RK9-616 no-loopback rule. Contract: docs/implementation-notes/coord-identity.md.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordAgentRun, Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import { resolveRk9CoordBoardHost, resolveRk9CoordBoardKeyIds } from "../middleware/rk9-coord-actor.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";

const RK9 = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const OTHER_RUN = "55555555-5555-4555-8555-555555555555";
const FOREIGN_AGENT = "66666666-6666-4666-8666-666666666666";
const FINISHED_RUN = "88888888-8888-4888-8888-888888888888";

type Actor = Express.Request["actor"];

const boardKeyActor: Actor = {
  type: "board",
  userId: "user-1",
  companyIds: [RK9],
  memberships: [{ companyId: RK9, membershipRole: "owner", status: "active" }],
  isInstanceAdmin: true,
  keyId: "board-key-1",
  source: "board_key",
};

const sessionActor = (isInstanceAdmin: boolean): Actor => ({
  type: "board",
  userId: "user-1",
  sessionId: "sess-1",
  companyIds: [RK9],
  memberships: [{ companyId: RK9, membershipRole: "owner", status: "active" }],
  isInstanceAdmin,
  source: "session",
});

const agentActor = (source: "agent_key" | "agent_jwt", runId: string | null = RUN): Actor => ({
  type: "agent",
  agentId: AGENT,
  companyId: RK9,
  keyId: source === "agent_key" ? "agent-key-1" : undefined,
  runId: runId ?? undefined,
  source,
});

const runs: Record<string, Rk9CoordAgentRun> = {
  [RUN]: { companyId: RK9, agentId: AGENT, status: "running" },
  [OTHER_RUN]: { companyId: RK9, agentId: FOREIGN_AGENT, status: "running" },
  [FINISHED_RUN]: { companyId: RK9, agentId: AGENT, status: "succeeded" },
};

function makeApp(
  actor: Actor,
  principal?: Rk9CoordTokenPrincipal,
  boardKeyIds: readonly string[] | null = null,
) {
  const findAgentRun = vi.fn(async (runId: string) => runs[runId] ?? null);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    if (principal) req.rk9CoordPrincipal = principal;
    next();
  });
  app.use("/api", rk9CoordRoutes({} as Db, { boardHost: "paperclip-01", boardKeyIds, findAgentRun }));
  app.use("/api", (_req, res) => res.status(418).json({ fellThrough: true }));
  app.use(errorHandler);
  return { app, findAgentRun };
}

const whoami = (companyId = RK9) => `/api/companies/${companyId}/rk9/coord/whoami`;
const mutate = (companyId = RK9) => `/api/companies/${companyId}/rk9/coord/probe`;

describe("coord whoami: board key on paperclip-01", () => {
  it("echoes the server-resolved actor for a valid claim", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", "cc:paperclip-01:abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companyId: RK9,
      actor: {
        kind: "cc",
        actorId: "cc:paperclip-01:abc-123",
        host: "paperclip-01",
        trust: "attributed",
        canHoldHardGate: true,
      },
      principal: { source: "board_key", agentId: null, runId: null, tokenHost: null },
    });
  });

  it.each(["worktree:RK9-621", "headless:run-1", "orch:implement", "operator"])("accepts local kind %s", async (claim) => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
    expect(res.status).toBe(200);
    expect(res.body.actor.actorId).toBe(claim);
    expect(res.body.actor.host).toBe("paperclip-01");
  });

  it("returns a null actor for a read without a claim", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami());
    expect(res.status).toBe(200);
    expect(res.body.actor).toBeNull();
  });

  it("rejects a cc claim for another host (the board key never leaves paperclip-01)", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", "cc:mv-laptop:abc");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_host_mismatch");
  });

  it.each([
    `agent_run:${RUN}`,
    "remote:mv-laptop",
    "rk9claude",
    "grok",
  ])("rejects kind %s through the board key", async (claim) => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_kind_not_allowed");
  });

  it.each(["", "CC:paperclip-01:x", "cc:paperclip-01:a b", "operator,grok", "board"])(
    "rejects malformed claim %j with 400 even on a read",
    async (claim) => {
      const { app } = makeApp(boardKeyActor);
      const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("rk9_coord_actor_malformed");
    },
  );

  it("rejects a mutation without an actor id", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).post(mutate()).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("rk9_coord_actor_required");
  });

  it("rejects a mutation with a malformed actor id", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).post(mutate()).set("X-RK9-Actor", "cc:paperclip-01").send({});
    expect(res.status).toBe(400);
  });

  it("lets a valid mutation reach the coord router (404 for an unknown sub-route, not a fall-through)", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).post(mutate()).set("X-RK9-Actor", "worktree:RK9-621").send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("rk9_coord_not_found");
  });

  it("rejects another company's coord routes", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami(OTHER)).set("X-RK9-Actor", "operator");
    expect(res.status).toBe(403);
  });

  it("rejects a board key of a non-admin company member (board keys are per user)", async () => {
    const { app } = makeApp({ ...boardKeyActor, isInstanceAdmin: false });
    for (const claim of ["operator", "cc:paperclip-01:abc"]) {
      const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("rk9_coord_untrusted_principal");
    }
    const post = await request(app).post(mutate()).set("X-RK9-Actor", "operator").send({});
    expect(post.status).toBe(403);
  });

  it("pins board keys by id when RK9_COORD_BOARD_KEY_IDS is configured", async () => {
    const allowed = makeApp(boardKeyActor, undefined, ["board-key-1"]);
    expect((await request(allowed.app).get(whoami()).set("X-RK9-Actor", "operator")).status).toBe(200);
    const other = makeApp({ ...boardKeyActor, keyId: "board-key-2" }, undefined, ["board-key-1"]);
    const res = await request(other.app).get(whoami()).set("X-RK9-Actor", "operator");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_board_key_not_allowed");
  });

  it("rejects a non-UUID company id", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(whoami("RK9")).set("X-RK9-Actor", "operator");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("rk9_coord_company_invalid");
  });
});

describe("coord whoami: signed-in operator", () => {
  it("is always the verified operator", async () => {
    const { app } = makeApp(sessionActor(true));
    const res = await request(app).get(whoami());
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ kind: "operator", actorId: "operator", trust: "verified" });
  });

  it("rejects a session claiming another actor", async () => {
    const { app } = makeApp(sessionActor(true));
    const res = await request(app).get(whoami()).set("X-RK9-Actor", "cc:paperclip-01:x");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_actor_spoof");
  });

  it("rejects a non-admin session user", async () => {
    const { app } = makeApp(sessionActor(false));
    const res = await request(app).get(whoami());
    expect(res.status).toBe(403);
  });
});

describe("coord whoami: agent callers are agent_run, derived server-side", () => {
  it.each(["agent_key", "agent_jwt"] as const)("%s resolves to agent_run:<runId>", async (source) => {
    const { app, findAgentRun } = makeApp(agentActor(source));
    const res = await request(app).get(whoami());
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({
      kind: "agent_run",
      actorId: `agent_run:${RUN}`,
      host: null,
      trust: "verified",
      canHoldHardGate: true,
    });
    expect(res.body.principal).toMatchObject({ source, agentId: AGENT, runId: RUN });
    expect(findAgentRun).toHaveBeenCalledWith(RUN);
  });

  it("accepts a header that equals the derived id", async () => {
    const { app } = makeApp(agentActor("agent_key"));
    const res = await request(app).post(mutate()).set("X-RK9-Actor", `agent_run:${RUN}`).send({});
    expect(res.status).toBe(404); // reached the router; no sub-route yet
  });

  it("does not need a header on a mutation (the id is derived)", async () => {
    const { app } = makeApp(agentActor("agent_jwt"));
    const res = await request(app).post(mutate()).send({});
    expect(res.status).toBe(404);
  });

  it.each(["cc:paperclip-01:abc", "operator", `agent_run:${OTHER_RUN}`, "worktree:RK9-621", "grok"])(
    "rejects a spoofed claim %s",
    async (claim) => {
      const { app } = makeApp(agentActor("agent_key"));
      const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("rk9_coord_actor_spoof");
    },
  );

  it("rejects an agent key whose run id belongs to another agent", async () => {
    const { app } = makeApp(agentActor("agent_key", OTHER_RUN));
    const res = await request(app).get(whoami());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_agent_run_unbound");
  });

  it("rejects a run id of the same agent that is no longer running", async () => {
    for (const source of ["agent_key", "agent_jwt"] as const) {
      const { app } = makeApp(agentActor(source, FINISHED_RUN));
      const res = await request(app).get(whoami());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("rk9_coord_agent_run_not_live");
    }
  });

  it.each([
    { kind: "task_bridge", projectIds: [] },
    { kind: "skill_test", issueId: "99999999-9999-4999-8999-999999999999" },
  ])("rejects a scoped agent key ($kind)", async (keyScope) => {
    const { app } = makeApp({ ...agentActor("agent_key"), keyScope: keyScope as never });
    const res = await request(app).get(whoami());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_scoped_key");
  });

  it("accepts a standard-scope agent key", async () => {
    const { app } = makeApp({ ...agentActor("agent_key"), keyScope: { kind: "standard" } });
    expect((await request(app).get(whoami())).status).toBe(200);
  });

  it("rejects an agent key with an unknown run id", async () => {
    const { app } = makeApp(agentActor("agent_key", "77777777-7777-4777-8777-777777777777"));
    const res = await request(app).get(whoami());
    expect(res.status).toBe(403);
  });

  it("rejects an agent call outside a run", async () => {
    const { app } = makeApp(agentActor("agent_key", null));
    const res = await request(app).get(whoami());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_agent_run_required");
  });

  it("rejects another company's coord routes", async () => {
    const { app } = makeApp(agentActor("agent_jwt"));
    const res = await request(app).get(whoami(OTHER));
    expect(res.status).toBe(403);
  });
});

describe("coord routes never derive company scope from loopback (RK9-616)", () => {
  it("rejects an unauthenticated loopback request in local_trusted mode", async () => {
    const app = express();
    app.use(actorMiddleware({} as Db, { deploymentMode: "local_trusted" }));
    app.use("/api", rk9CoordRoutes({} as Db, { boardHost: "paperclip-01", findAgentRun: async () => null }));
    app.use(errorHandler);
    for (const claim of [undefined, "operator", "cc:paperclip-01:abc"]) {
      const req = request(app).get(whoami());
      const res = claim ? await req.set("X-RK9-Actor", claim) : await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("rk9_coord_untrusted_principal");
    }
    const post = await request(app).post(mutate()).set("X-RK9-Actor", "operator").send({});
    expect(post.status).toBe(401);
  });

  it("rejects an anonymous actor", async () => {
    const { app } = makeApp({ type: "none", source: "none" });
    const res = await request(app).get(whoami()).set("X-RK9-Actor", "operator");
    expect(res.status).toBe(401);
  });

  it("rejects a cloud tenant board actor", async () => {
    const { app } = makeApp({ ...boardKeyActor, source: "cloud_tenant" });
    const res = await request(app).get(whoami()).set("X-RK9-Actor", "operator");
    expect(res.status).toBe(401);
  });
});

describe("coord token principal (contract for RK9-623)", () => {
  const hostToken: Rk9CoordTokenPrincipal = {
    tokenId: "tok-1",
    companyId: RK9,
    principalKind: "host",
    principalName: "mv-laptop",
  };
  const anon: Actor = { type: "none", source: "none" };

  it("defaults to remote:<host> and marks it unverified", async () => {
    const { app } = makeApp(anon, hostToken);
    const res = await request(app).get(whoami());
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({
      kind: "remote",
      actorId: "remote:mv-laptop",
      host: "mv-laptop",
      trust: "unverified",
      canHoldHardGate: false,
    });
    expect(res.body.principal).toMatchObject({ source: "coord_token", tokenHost: "mv-laptop" });
  });

  it("accepts a cc claim on its own host", async () => {
    const { app } = makeApp(anon, hostToken);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", "cc:mv-laptop:s1");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ kind: "cc", host: "mv-laptop", trust: "attributed" });
  });

  it.each(["cc:paperclip-01:s1", "remote:htpc"])("rejects claim %s for another host", async (claim) => {
    const { app } = makeApp(anon, hostToken);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_host_mismatch");
  });

  it.each(["operator", "worktree:RK9-1", "rk9claude", `agent_run:${RUN}`])("rejects kind %s", async (claim) => {
    const { app } = makeApp(anon, hostToken);
    const res = await request(app).get(whoami()).set("X-RK9-Actor", claim);
    expect(res.status).toBe(403);
  });

  it("rejects another company's coord routes", async () => {
    const { app } = makeApp(anon, hostToken);
    const res = await request(app).get(whoami(OTHER));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_wrong_company");
    const malformed = await request(app).get(whoami(OTHER)).set("X-RK9-Actor", "remote:");
    expect(malformed.status).toBe(403);
    expect(malformed.body.code).toBe("rk9_coord_wrong_company");
  });

  it("requires an actor id on a mutation", async () => {
    const { app } = makeApp(anon, hostToken);
    const res = await request(app).post(mutate()).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("rk9_coord_actor_required");
    const ok = await request(app).post(mutate()).set("X-RK9-Actor", "remote:mv-laptop").send({});
    expect(ok.status).toBe(404); // reached the router; no sub-route yet
    const bad = await request(app).post(mutate()).set("X-RK9-Actor", "remote:").send({});
    expect(bad.status).toBe(400);
  });

  it("binds service tokens to their one service", async () => {
    const rk9claude: Rk9CoordTokenPrincipal = { ...hostToken, principalKind: "service", principalName: "rk9claude" };
    const ok = await request(makeApp(anon, rk9claude).app).get(whoami());
    expect(ok.body.actor).toMatchObject({ kind: "rk9claude", trust: "verified" });
    const grok: Rk9CoordTokenPrincipal = { ...hostToken, principalKind: "service", principalName: "grok" };
    const g = await request(makeApp(anon, grok).app).get(whoami());
    expect(g.body.actor).toMatchObject({ kind: "grok", trust: "unverified", canHoldHardGate: false });
    const spoof = await request(makeApp(anon, grok).app).get(whoami()).set("X-RK9-Actor", "rk9claude");
    expect(spoof.status).toBe(403);
  });

  it("refuses a coord token combined with another credential", async () => {
    const { app } = makeApp(boardKeyActor, hostToken);
    const res = await request(app).get(whoami());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_mixed_credentials");
  });
});

describe("non-coord paths", () => {
  it("are not handled by the coord router", async () => {
    const { app } = makeApp(boardKeyActor);
    const res = await request(app).get(`/api/companies/${RK9}/issues`);
    expect(res.status).toBe(418);
  });
});

describe("resolveRk9CoordBoardKeyIds", () => {
  it("parses a comma list and treats empty as unset", () => {
    expect(resolveRk9CoordBoardKeyIds({})).toBeNull();
    expect(resolveRk9CoordBoardKeyIds({ RK9_COORD_BOARD_KEY_IDS: " , " })).toBeNull();
    expect(resolveRk9CoordBoardKeyIds({ RK9_COORD_BOARD_KEY_IDS: "a, b" })).toEqual(["a", "b"]);
  });
});

describe("resolveRk9CoordBoardHost", () => {
  it("defaults to paperclip-01 and honours RK9_COORD_BOARD_HOST", () => {
    expect(resolveRk9CoordBoardHost({})).toBe("paperclip-01");
    expect(resolveRk9CoordBoardHost({ RK9_COORD_BOARD_HOST: " Paperclip-02 " })).toBe("paperclip-02");
  });
});
