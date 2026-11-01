// RK9 Custom (RK9-623): coord token resolution in actorMiddleware, the global
// deny-by-default guard, the token service and the operator-only management
// routes. Contract: docs/implementation-notes/coord-identity.md.
import { readFile } from "node:fs/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, rk9CoordTokens, type Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
import {
  isRk9CoordGuardAllowed,
  isRk9CoordRoutePath,
  rk9CoordTokenGuard,
  type Rk9CoordTokenResolver,
} from "../middleware/rk9-coord-token-auth.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { rk9CoordTokenRoutes } from "../routes/rk9-coord-tokens.js";
import {
  generateRk9CoordToken,
  hashRk9CoordToken,
  RK9_COORD_TOKEN_PATTERN,
  rk9CoordTokenService,
} from "../services/rk9-coord-tokens.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const RK9 = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const HOST_TOKEN = generateRk9CoordToken();
const SERVICE_TOKEN = generateRk9CoordToken();

const principals: Record<string, Rk9CoordTokenPrincipal> = {
  [HOST_TOKEN]: { tokenId: "t-host", companyId: RK9, principalKind: "host", principalName: "mv-laptop" },
  [SERVICE_TOKEN]: { tokenId: "t-svc", companyId: RK9, principalKind: "service", principalName: "rk9claude" },
};

/**
 * The real actor middleware, the real guard and the real coord router, plus
 * upstream-shaped stub routes that answer 200 if a request ever reaches them.
 */
function makeApp(deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const resolver: Rk9CoordTokenResolver = vi.fn(async (token: string) => principals[token] ?? null);
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware({} as Db, { deploymentMode, resolveRk9CoordToken: resolver }));
  app.use(rk9CoordTokenGuard());
  const api = Router();
  api.use(rk9CoordRoutes({} as Db, { boardHost: "paperclip-01", boardKeyIds: null, findAgentRun: async () => null }));
  api.use(rk9CoordTokenRoutes({} as Db, { boardKeyIds: null }));
  const reached = (_req: express.Request, res: express.Response) => res.status(200).json({ reached: true });
  api.get("/companies", reached);
  api.get("/companies/:companyId/issues", reached);
  api.post("/companies/:companyId/issues", reached);
  api.get("/agents/me", reached);
  api.patch("/agents/:agentId", reached);
  api.post("/companies/:companyId/approvals", reached);
  app.use("/api", api);
  app.get("/", reached);
  app.use(errorHandler);
  return { app, resolver };
}

const bearer = (token: string) => `Bearer ${token}`;
const whoami = (companyId = RK9) => `/api/companies/${companyId}/rk9/coord/whoami`;

describe("coord token bearer resolution", () => {
  it("resolves a host token to remote:<host> on the coord route", async () => {
    const { app } = makeApp();
    const res = await request(app).get(whoami()).set("Authorization", bearer(HOST_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ kind: "remote", actorId: "remote:mv-laptop", host: "mv-laptop", trust: "unverified" });
    expect(res.body.principal).toMatchObject({ source: "coord_token", tokenHost: "mv-laptop" });
  });

  it("binds a cc claim to the token host", async () => {
    const { app } = makeApp();
    const ok = await request(app).get(whoami()).set("Authorization", bearer(HOST_TOKEN)).set("X-RK9-Actor", "cc:mv-laptop:s1");
    expect(ok.status).toBe(200);
    expect(ok.body.actor).toMatchObject({ kind: "cc", host: "mv-laptop", trust: "attributed" });
    const other = await request(app).get(whoami()).set("Authorization", bearer(HOST_TOKEN)).set("X-RK9-Actor", "cc:paperclip-01:s1");
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("rk9_coord_host_mismatch");
    const remote = await request(app).get(whoami()).set("Authorization", bearer(HOST_TOKEN)).set("X-RK9-Actor", "remote:pve-01");
    expect(remote.status).toBe(403);
  });

  it("resolves a service token to its one service", async () => {
    const { app } = makeApp();
    const res = await request(app).get(whoami()).set("Authorization", bearer(SERVICE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ kind: "rk9claude", actorId: "rk9claude", trust: "verified" });
    const spoof = await request(app).get(whoami()).set("Authorization", bearer(SERVICE_TOKEN)).set("X-RK9-Actor", "operator");
    expect(spoof.status).toBe(403);
  });

  it("rejects another company's coord routes", async () => {
    const { app } = makeApp();
    const res = await request(app).get(whoami(OTHER)).set("Authorization", bearer(HOST_TOKEN));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_wrong_company");
  });

  it("rejects a mutation without an actor id or with a malformed one", async () => {
    const { app } = makeApp();
    const missing = await request(app).post(`/api/companies/${RK9}/rk9/coord/probe`).set("Authorization", bearer(HOST_TOKEN)).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("rk9_coord_actor_required");
    const malformed = await request(app)
      .post(`/api/companies/${RK9}/rk9/coord/probe`)
      .set("Authorization", bearer(HOST_TOKEN))
      .set("X-RK9-Actor", "cc:MV-LAPTOP:s1")
      .send({});
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("rk9_coord_actor_malformed");
  });

  it.each(["authenticated", "local_trusted"] as const)(
    "answers 401 for an unknown coord token and never falls through (%s)",
    async (mode) => {
      const { app } = makeApp(mode);
      for (const path of [whoami(), `/api/companies/${RK9}/issues`, "/api/companies"]) {
        const res = await request(app).get(path).set("Authorization", bearer(generateRk9CoordToken()));
        expect(res.status, path).toBe(401);
      }
      // A coord-shaped but malformed bearer is also 401, never the local board.
      const res = await request(app).get("/api/companies").set("Authorization", bearer("rk9_coord_short"));
      expect(res.status).toBe(401);
    },
  );

  it("never keeps the implicit local board for a valid coord token in local_trusted mode", async () => {
    const { app } = makeApp("local_trusted");
    const res = await request(app).get(whoami()).set("Authorization", bearer(HOST_TOKEN)).set("X-RK9-Actor", "operator");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("rk9_coord_kind_not_allowed");
  });
});

describe("deny by default: a coord token gets 403 on every non-coord route", () => {
  it.each([
    ["GET", "/api/companies"],
    ["GET", `/api/companies/${RK9}/issues`],
    ["POST", `/api/companies/${RK9}/issues`],
    ["GET", "/api/agents/me"],
    ["PATCH", `/api/agents/${randomUUID()}`],
    ["POST", `/api/companies/${RK9}/approvals`],
    ["GET", `/api/companies/${RK9}/rk9/coord-tokens`],
    ["POST", `/api/companies/${RK9}/rk9/coord-tokens`],
    ["GET", `/API/companies/${RK9}/rk9/coord/whoami`],
    ["GET", `/api/companies/${RK9}/rk9/coordx/whoami`],
    ["GET", "/"],
    ["GET", "/api/does-not-exist"],
  ])("%s %s", async (method, path) => {
    const { app } = makeApp();
    for (const token of [HOST_TOKEN, SERVICE_TOKEN]) {
      const res = await request(app)[method.toLowerCase() as "get"](path).set("Authorization", bearer(token)).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("rk9_coord_token_route_forbidden");
    }
  });

  it("leaves requests without a coord token alone", async () => {
    const { app } = makeApp("local_trusted");
    const res = await request(app).get(`/api/companies/${RK9}/issues`);
    expect(res.status).toBe(200);
  });

  it("matches only the coord route prefix", () => {
    expect(isRk9CoordRoutePath(`/api/companies/${RK9}/rk9/coord/whoami`)).toBe(true);
    expect(isRk9CoordRoutePath(`/api/companies/${RK9}/rk9/coord`)).toBe(true);
    expect(isRk9CoordRoutePath(`/api/companies/${RK9}/rk9/coord-tokens`)).toBe(false);
    expect(isRk9CoordRoutePath(`/api/companies/${RK9}/issues/rk9/coord/x`)).toBe(false);
    expect(isRk9CoordRoutePath(`//api/companies/${RK9}/rk9/coord/whoami`)).toBe(false);
  });

  // Verifier round 1 (H1): parseurl falls back to url.parse for a target with
  // `#`, `\\` or whitespace, so Express could route a path the raw-URL check
  // never saw. supertest normalises URLs, so these go over a raw socket.
  it.each([
    `/api/companies/${RK9}\\issues#/rk9/coord/`,
    `/api/companies/${RK9}\\rk9\\coord-tokens#/rk9/coord/`,
    `/api/companies/${RK9}#/rk9/coord/`,
    `/api/companies/${RK9}/rk9/coord/whoami\\..\\..\\..\\issues`,
  ])("denies the crafted raw target %s", async (target) => {
    const { app } = makeApp();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${HOST_TOKEN}\r\nConnection: close\r\n\r\n`,
          );
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString("utf8")));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
      expect(status, raw.slice(0, 200)).not.toBe(200);
      expect(raw).not.toContain('"reached":true');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("requires the raw and the routed path to agree", () => {
    const coord = `/api/companies/${RK9}/rk9/coord/whoami`;
    expect(isRk9CoordGuardAllowed(coord, coord)).toBe(true);
    expect(isRk9CoordGuardAllowed(`${coord}?x=1`, coord)).toBe(true);
    expect(isRk9CoordGuardAllowed(`/api/companies/${RK9}#/rk9/coord/`, `/api/companies/${RK9}`)).toBe(false);
    expect(isRk9CoordGuardAllowed(coord, `/api/companies/${RK9}/issues`)).toBe(false);
    expect(isRk9CoordGuardAllowed(`/api/companies/${RK9}/issues`, coord)).toBe(false);
    expect(isRk9CoordGuardAllowed(`${coord}\\x`, coord)).toBe(false);
    expect(isRk9CoordGuardAllowed(`http://evil${coord}`, coord)).toBe(false);
  });

  it("is mounted in app.ts right after the actor middleware, before every API router", async () => {
    const source = await readFile(new URL("../app.ts", import.meta.url), "utf8");
    const actor = source.indexOf("actorMiddleware(db, {");
    const guard = source.indexOf("app.use(rk9CoordTokenGuard());");
    const cloudControl = source.indexOf("app.use(cloudControlMiddleware());");
    const apiRouter = source.indexOf("const api = Router();");
    expect(actor).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(actor);
    expect(guard).toBeLessThan(cloudControl);
    expect(guard).toBeLessThan(apiRouter);
    const between = source.slice(actor, guard);
    expect(between.match(/app\.use\(/g) ?? []).toHaveLength(0);
  });
});

describe("token format", () => {
  it("is rk9_coord_ plus 43 base64url characters and unique per call", () => {
    const a = generateRk9CoordToken();
    const b = generateRk9CoordToken();
    expect(a).toMatch(RK9_COORD_TOKEN_PATTERN);
    expect(a).toHaveLength(53);
    expect(a).not.toBe(b);
    expect(hashRk9CoordToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-tokens] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord tokens against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  type Actor = Express.Request["actor"];
  const operatorKey: Actor = {
    type: "board",
    userId: "operator-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    keyId: "board-key-1",
    source: "board_key",
  };

  /** Management routes with an injected board actor (board-key auth is upstream's). */
  function manageApp(actor: Actor, boardKeyIds: readonly string[] | null = null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", rk9CoordTokenRoutes(db, { boardKeyIds }));
    app.use(errorHandler);
    return app;
  }

  /** The real chain with the real DB-backed token resolver. */
  function liveApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use(rk9CoordTokenGuard());
    app.use("/api", rk9CoordRoutes(db, { boardHost: "paperclip-01", boardKeyIds: null }));
    app.get("/api/companies/:companyId/issues", (_req, res) => res.json({ reached: true }));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-tokens-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "RK9 coord", issuePrefix: "RKC" },
      { id: otherCompanyId, name: "Other coord", issuePrefix: "RKO" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("issues, resolves, rotates and revokes with effect on the next request", async () => {
    const app = manageApp(operatorKey);
    const issued = await request(app)
      .post(`/api/companies/${companyId}/rk9/coord-tokens`)
      .send({ principalKind: "host", principalName: "mv-laptop", label: "laptop" });
    expect(issued.status).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store");
    const token = issued.body.token as string;
    expect(token).toMatch(RK9_COORD_TOKEN_PATTERN);
    expect(issued.body.record).toMatchObject({ principalKind: "host", principalName: "mv-laptop", tokenPrefix: token.slice(0, 14) });
    expect(issued.body.record).not.toHaveProperty("tokenHash");

    // Only the hash is stored.
    const rows = await db.select().from(rk9CoordTokens).where(eq(rk9CoordTokens.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashRk9CoordToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);

    const live = liveApp();
    const ok = await request(live).get(`/api/companies/${companyId}/rk9/coord/whoami`).set("Authorization", bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.body.actor.actorId).toBe("remote:mv-laptop");
    const [touched] = await db.select().from(rk9CoordTokens).where(eq(rk9CoordTokens.id, issued.body.record.id));
    expect(touched!.lastUsedAt).not.toBeNull();
    const denied = await request(live).get(`/api/companies/${companyId}/issues`).set("Authorization", bearer(token));
    expect(denied.status).toBe(403);

    // One active token per host.
    const dup = await request(app)
      .post(`/api/companies/${companyId}/rk9/coord-tokens`)
      .send({ principalKind: "host", principalName: "mv-laptop" });
    expect(dup.status).toBe(409);

    const rotated = await request(app).post(`/api/companies/${companyId}/rk9/coord-tokens/${issued.body.record.id}/rotate`).send({});
    expect(rotated.status).toBe(201);
    const newToken = rotated.body.token as string;
    expect(newToken).not.toBe(token);
    expect(rotated.body.record).toMatchObject({ rotatedFromTokenId: issued.body.record.id, label: "laptop" });
    expect((await request(live).get(`/api/companies/${companyId}/rk9/coord/whoami`).set("Authorization", bearer(token))).status).toBe(401);
    expect((await request(live).get(`/api/companies/${companyId}/rk9/coord/whoami`).set("Authorization", bearer(newToken))).status).toBe(200);

    const revoked = await request(app).post(`/api/companies/${companyId}/rk9/coord-tokens/${rotated.body.record.id}/revoke`).send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.record.revokedAt).not.toBeNull();
    expect((await request(live).get(`/api/companies/${companyId}/rk9/coord/whoami`).set("Authorization", bearer(newToken))).status).toBe(401);
    const again = await request(app).post(`/api/companies/${companyId}/rk9/coord-tokens/${rotated.body.record.id}/revoke`).send({});
    expect(again.status).toBe(404);

    const list = await request(app).get(`/api/companies/${companyId}/rk9/coord-tokens`);
    expect(list.status).toBe(200);
    expect(list.body.tokens).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain(newToken);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash/);

    // Audit rows carry ids and names, never the token.
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityType, "rk9_coord_token"));
    expect(audit.map((row) => row.action).sort()).toEqual([
      "rk9_coord.token_issued",
      "rk9_coord.token_revoked",
      "rk9_coord.token_revoked",
      "rk9_coord.token_rotated",
    ]);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(newToken);
  });

  it("refuses an expired token", async () => {
    const service = rk9CoordTokenService(db);
    const { token } = await service.issue({
      companyId,
      principalKind: "service",
      principalName: "grok",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await service.resolve(token)).toMatchObject({ principalName: "grok" });
    expect(await service.resolve(token, new Date(Date.now() + 120_000))).toBeNull();
  });

  it("refuses to rotate an expired token into another dead token", async () => {
    const service = rk9CoordTokenService(db);
    const { record } = await service.issue({
      companyId,
      principalKind: "host",
      principalName: "short-lived",
      expiresAt: new Date(Date.now() + 1_000),
    });
    await db.update(rk9CoordTokens).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(rk9CoordTokens.id, record.id));
    const app = manageApp(operatorKey);
    const refused = await request(app).post(`/api/companies/${companyId}/rk9/coord-tokens/${record.id}/rotate`).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("rk9_coord_token_expiry_past");
    const [still] = await db.select().from(rk9CoordTokens).where(eq(rk9CoordTokens.id, record.id));
    expect(still!.revokedAt).toBeNull();
    const rotated = await request(app)
      .post(`/api/companies/${companyId}/rk9/coord-tokens/${record.id}/rotate`)
      .send({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(rotated.status).toBe(201);
    expect(await service.resolve(rotated.body.token)).toMatchObject({ principalName: "short-lived" });
  });

  it("does not rotate or revoke another company's token", async () => {
    const service = rk9CoordTokenService(db);
    const { record } = await service.issue({ companyId: otherCompanyId, principalKind: "host", principalName: "pve-01" });
    const app = manageApp(operatorKey);
    for (const action of ["rotate", "revoke"]) {
      const res = await request(app).post(`/api/companies/${companyId}/rk9/coord-tokens/${record.id}/${action}`).send({});
      expect(res.status, action).toBe(404);
    }
    // And the operator key has no access to the other company at all.
    const res = await request(app).get(`/api/companies/${otherCompanyId}/rk9/coord-tokens`);
    expect(res.status).toBe(403);
  });

  it("lets only the operator manage tokens", async () => {
    const body = { principalKind: "host", principalName: "ci-runner" };
    const path = `/api/companies/${companyId}/rk9/coord-tokens`;
    const cases: Array<[Actor, number, readonly string[] | null]> = [
      [{ type: "none", source: "none" }, 401, null],
      [{ ...operatorKey, source: "local_implicit", keyId: undefined }, 401, null],
      [{ ...operatorKey, isInstanceAdmin: false }, 403, null],
      [{ type: "agent", agentId: randomUUID(), companyId, keyScope: { kind: "standard" }, source: "agent_key" }, 401, null],
      [operatorKey, 403, ["another-key"]],
    ];
    for (const [actor, status, keyIds] of cases) {
      const res = await request(manageApp(actor, keyIds)).post(path).send(body);
      expect(res.status, JSON.stringify(actor)).toBe(status);
    }
    // A signed-in instance-admin session may.
    const session = await request(manageApp({ ...operatorKey, source: "session", keyId: undefined, sessionId: "s" }))
      .post(path)
      .send(body);
    expect(session.status).toBe(201);
  });

  it("validates the principal before storing anything", async () => {
    const app = manageApp(operatorKey);
    const path = `/api/companies/${companyId}/rk9/coord-tokens`;
    for (const body of [
      { principalKind: "host", principalName: "MV_Laptop" },
      { principalKind: "service", principalName: "openai" },
      { principalKind: "user", principalName: "x" },
      { principalKind: "host", principalName: "ok-host", extra: true },
    ]) {
      const res = await request(app).post(path).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const past = await request(app)
      .post(path)
      .send({ principalKind: "host", principalName: "past-host", expiresAt: "2020-01-01T00:00:00Z" });
    expect(past.status).toBe(422);
  });
});
