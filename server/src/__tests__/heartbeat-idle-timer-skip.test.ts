import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Idle timer skip test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat idle-timer tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForIdle(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("heartbeat timer idle precheck", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-idle-timer-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await waitForIdle(db);
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(heartbeatConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimerAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, ...heartbeatConfig } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  const timerWake = {
    source: "timer" as const,
    triggerDetail: "system" as const,
    reason: "heartbeat_timer",
    requestedByActorType: "system" as const,
    requestedByActorId: "heartbeat_scheduler",
  };

  async function skippedReasons(agentId: string) {
    return db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")))
      .then((rows) => rows.map((row) => row.reason));
  }

  it("skips a timer wake when the agent has nothing assigned and stamps lastHeartbeatAt", async () => {
    const { agentId } = await seedAgent({});
    const before = new Date(Date.now() - 1_000);

    const run = await heartbeat.wakeup(agentId, timerWake);

    expect(run).toBeNull();
    expect(await skippedReasons(agentId)).toEqual(["heartbeat.idle"]);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(agent?.lastHeartbeatAt).not.toBeNull();
    expect(new Date(agent!.lastHeartbeatAt!).getTime()).toBeGreaterThan(before.getTime());
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("runs the timer wake when an actionable issue is assigned", async () => {
    const { companyId, agentId } = await seedAgent({});
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Do the thing",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, timerWake);

    expect(run).not.toBeNull();
    expect(await skippedReasons(agentId)).toEqual([]);
  });

  it("does not gate timer wakes when skipWhenIdle is false", async () => {
    const { agentId } = await seedAgent({ skipWhenIdle: false });

    const run = await heartbeat.wakeup(agentId, timerWake);

    expect(run).not.toBeNull();
    expect(await skippedReasons(agentId)).toEqual([]);
  });
});
