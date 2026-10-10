// RK9 Custom: only the board may remove an email suppression; both mutations write activity_log.
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockRemoveSuppression = vi.hoisted(() => vi.fn(async () => true));
const mockAddSuppression = vi.hoisted(() =>
  vi.fn(async (_db: unknown, args: { companyId: string; address: string; reason: string }) => ({
    id: "supp-1",
    companyId: args.companyId,
    address: args.address,
    reason: args.reason,
  })),
);
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/email/suppression.js", () => ({
  addSuppression: mockAddSuppression,
  listSuppressions: vi.fn(async () => []),
  removeSuppression: mockRemoveSuppression,
}));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/index.js")>()),
  logActivity: mockLogActivity,
}));

const boardActor = {
  type: "board",
  userId: "user-1",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
};
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  runId: RUN_ID,
  source: "agent_jwt",
};
const agentKeyActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  keyId: "key-1",
  runId: null,
  source: "agent_key",
};

// heartbeat_runs lookup used to keep a stale run id out of activity_log.run_id.
let runRows: Array<{ companyId: string }> = [];
function makeDb() {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => runRows),
  };
  return { select: vi.fn(() => chain) };
}

async function createApp(actor: Record<string, unknown>) {
  const { rk9EmailRoutes } = await import("../routes/rk9-email.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", rk9EmailRoutes(makeDb() as never));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

describe("email suppression routes", () => {
  beforeAll(async () => {
    await import("../routes/rk9-email.js");
  }, 60_000);

  beforeEach(() => {
    mockRemoveSuppression.mockClear();
    mockAddSuppression.mockClear();
    mockLogActivity.mockClear();
    runRows = [{ companyId: "company-1" }];
  });

  it.each([
    ["run JWT", agentActor],
    ["API key", agentKeyActor],
  ])("refuses an agent (%s) that tries to remove a suppression", async (_label, actor) => {
    const app = await createApp(actor);
    const res = await request(app).delete("/api/companies/company-1/email/suppression/supp-1");
    expect(res.status).toBe(403);
    expect(mockRemoveSuppression).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("lets the board remove a suppression and logs it", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).delete("/api/companies/company-1/email/suppression/supp-1");
    expect(res.status).toBe(204);
    expect(mockRemoveSuppression).toHaveBeenCalledWith(expect.anything(), "company-1", "supp-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        action: "email.suppression.removed",
        entityType: "email_suppression",
        entityId: "supp-1",
      }),
    );
    expect(mockLogActivity.mock.calls[0]?.[1]).not.toHaveProperty("details");
  });

  it("returns 404 and logs nothing when the suppression does not exist", async () => {
    mockRemoveSuppression.mockResolvedValueOnce(false);
    const app = await createApp(boardActor);
    const res = await request(app).delete("/api/companies/company-1/email/suppression/missing");
    expect(res.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("still lets an agent add a suppression and logs it with the run", async () => {
    const app = await createApp(agentActor);
    const res = await request(app)
      .post("/api/companies/company-1/email/suppression")
      .send({ address: "blocked@example.com", reason: "complaint" });
    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "agent",
        agentId: "agent-1",
        runId: RUN_ID,
        action: "email.suppression.added",
        entityId: "supp-1",
        details: { reason: "complaint" },
      }),
    );
  });

  it("logs an add with no run when the run id is stale or from another company", async () => {
    runRows = [];
    const app = await createApp(agentActor);
    const res = await request(app)
      .post("/api/companies/company-1/email/suppression")
      .send({ address: "blocked@example.com", reason: "manual" });
    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "email.suppression.added", runId: null }),
    );
  });

  it("names the agent API key on an add without a run", async () => {
    const app = await createApp(agentKeyActor);
    const res = await request(app)
      .post("/api/companies/company-1/email/suppression")
      .send({ address: "blocked@example.com" });
    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentApiKeyId: "key-1", runId: null, details: { reason: "manual" } }),
    );
  });
});
