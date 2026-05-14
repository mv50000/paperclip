import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { HttpError } from "../errors.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.checkout concurrent 409 race", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-checkout-race-",
    );
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("exactly one of two concurrent checkouts succeeds and the other gets 409", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const issueId = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();

    // Set up company
    await db.insert(companies).values({
      id: companyId,
      name: "RaceCo",
      issuePrefix: "RACE",
      requireBoardApprovalForNewAgents: false,
    });

    // Set up two agents
    await db.insert(agents).values([
      {
        id: agentA,
        companyId,
        name: "AgentA",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentB,
        companyId,
        name: "AgentB",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Set up heartbeat runs for both agents (status "running" so they're valid)
    await db.insert(heartbeatRuns).values([
      {
        id: runA,
        companyId,
        agentId: agentA,
        status: "running",
        invocationSource: "on_demand",
      },
      {
        id: runB,
        companyId,
        agentId: agentB,
        status: "running",
        invocationSource: "on_demand",
      },
    ]);

    // Create an unassigned issue in "todo" status
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race condition target",
      status: "todo",
      priority: "medium",
    });

    // Fire two concurrent checkout requests
    const results = await Promise.allSettled([
      svc.checkout(issueId, agentA, ["todo"], runA),
      svc.checkout(issueId, agentB, ["todo"], runB),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one succeeds, one fails
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The failure must be a 409 HttpError
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).message).toBe("Issue checkout conflict");

    // The 409 details should include the lock state
    const details = (error as HttpError).details as Record<string, unknown>;
    expect(details.issueId).toBe(issueId);

    // The winner's agent must own the issue
    const winner = (fulfilled[0] as PromiseFulfilledResult<unknown>)
      .value as Record<string, unknown>;
    const winnerAgentId = winner.assigneeAgentId as string;
    expect([agentA, agentB]).toContain(winnerAgentId);
    expect(winner.status).toBe("in_progress");

    // The 409 details should reference the winning agent
    expect(details.assigneeAgentId).toBe(winnerAgentId);
  });

  it("sequential checkout by same agent with same run is idempotent (no self-409)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "IdempotentCo",
      issuePrefix: "IDEM",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotent checkout target",
      status: "todo",
      priority: "medium",
    });

    // First checkout succeeds
    const first = await svc.checkout(issueId, agentId, ["todo"], runId);
    expect(first.status).toBe("in_progress");
    expect(first.assigneeAgentId).toBe(agentId);

    // Second checkout with same agent + run should not 409
    const second = await svc.checkout(
      issueId,
      agentId,
      ["todo", "in_progress"],
      runId,
    );
    expect(second.id).toBe(issueId);
    expect(second.assigneeAgentId).toBe(agentId);
  });
});
