import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";

vi.mock("../services/knowledge-recall.js", () => ({ recallKnowledge: vi.fn() }));

const { knowledgeRoutes } = await import("../routes/knowledge.js");
const { errorHandler } = await import("../middleware/index.js");
const { _resetQmdMcpSessionForTests, probeQmdDaemon } = await import("../services/qmd-mcp-client.js");

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", knowledgeRoutes({} as never));
  app.use(errorHandler);
  return app;
}

async function getStatus(actor: Record<string, unknown>) {
  const server = createApp(actor).listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/knowledge/qmd-status`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const admin = { type: "board", userId: "u1", source: "session", isInstanceAdmin: true };
const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

describe("GET /knowledge/qmd-status (RK9-369)", () => {
  beforeEach(() => {
    _resetQmdMcpSessionForTests();
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetQmdMcpSessionForTests();
  });

  it("returns 200 while the daemon is healthy", async () => {
    const res = await getStatus(admin);
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
  });

  it("returns 503 once the failure threshold is reached", async () => {
    for (let i = 0; i < 3; i++) await probeQmdDaemon({ fetchImpl: down });
    const res = await getStatus(admin);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ healthy: false, consecutiveFailures: 3, lastError: "ECONNREFUSED" });
  });

  it("rejects non-admin callers", async () => {
    const res = await getStatus({ type: "agent", agentId: "a", companyId: "c", runId: null });
    expect(res.status).toBe(403);
  });
});
