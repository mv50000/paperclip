// RK9 Custom (RK9-684 item 7): a lease acquire whose actor row the prune
// deleted (the insert fails on the foreign key) runs once more, then answers
// 503 `rk9_coord_lease_retry`, never 500. The race is forced: the mocked
// ensureRk9CoordActorRow hands out a row id that no longer exists, as after
// the prune's delete. Contract: docs/implementation-notes/coord-leases.md.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, rk9CoordActors, rk9CoordLeases } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const pruned = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../services/rk9-coord-journal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/rk9-coord-journal.js")>();
  return {
    ...real,
    ensureRk9CoordActorRow: async (...args: Parameters<typeof real.ensureRk9CoordActorRow>) => {
      const row = await real.ensureRk9CoordActorRow(...args);
      if (pruned.calls <= 0) return row;
      pruned.calls -= 1;
      return { ...row, id: randomUUID() };
    },
  };
});

type Actor = Express.Request["actor"];

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-leases-prune-race] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord lease acquire after the prune deleted its actor row", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const base = `/api/companies/${companyId}/rk9/coord/leases`;

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

  function acquire(actorId: string, resource: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = boardKey();
      next();
    });
    app.use("/api", rk9CoordRoutes(db, { boardHost: "paperclip-01", boardKeyIds: null, findAgentRun: async () => null }));
    app.use(errorHandler);
    return request(app).post(`${base}/acquire`).set("X-RK9-Actor", actorId).send({ resource, ttl_s: 600 });
  }

  async function activeHolder(resource: string) {
    const [row] = await db
      .select({ holder: rk9CoordActors.actorRef })
      .from(rk9CoordLeases)
      .innerJoin(rk9CoordActors, eq(rk9CoordActors.id, rk9CoordLeases.holderActorId))
      .where(and(eq(rk9CoordLeases.resource, resource), isNull(rk9CoordLeases.releasedAt)));
    return row?.holder ?? null;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-lease-prune-race-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "RK9 prune race", issuePrefix: "RKP" });
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("retries once and grants the lease", async () => {
    pruned.calls = 1;
    const res = await acquire("cc:paperclip-01:race-1", "prod:race-once");
    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(true);
    expect(pruned.calls).toBe(0);
    expect(await activeHolder("prod:race-once")).toBe("cc:paperclip-01:race-1");
  });

  it("answers 503 with a retryable code when the retry loses too", async () => {
    pruned.calls = 2;
    const res = await acquire("cc:paperclip-01:race-2", "prod:race-twice");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rk9_coord_lease_retry");
    expect(pruned.calls).toBe(0);
    expect(await activeHolder("prod:race-twice")).toBeNull();
  });
});
