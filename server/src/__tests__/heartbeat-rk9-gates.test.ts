// RK9-701 (port map doc/plans/2026-11-03-heartbeat-port-map.md, items 5-15, 20, 22):
// upstream v2026.1023.0 split heartbeat.ts into modules. The fork gates now live in
// heartbeat/rk9-gates.ts and reach queue.ts and scheduling.ts as a required dependency.
// These tests drive the real heartbeatService and check that each gate still blocks
// its path: enqueue, startNext/claim (resumeQueuedRuns), timer tick and the global cap.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const adapterContexts = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const mockBuildKnowledgeContext = vi.hoisted(() => vi.fn(async (): Promise<{ markdown: string } | null> => null));

vi.mock("../services/knowledge-injection.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/knowledge-injection.ts")>("../services/knowledge-injection.ts");
  return { ...actual, buildKnowledgeContext: mockBuildKnowledgeContext };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: { runId: string; context: Record<string, unknown> }) => {
    adapterContexts.set(ctx.runId, { ...ctx.context });
    return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "rk9 gates test run",
    provider: "test",
    model: "test-model",
    };
  }),
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

import { heartbeatService } from "../services/heartbeat.ts";
import { createRk9HeartbeatGates } from "../services/heartbeat/rk9-gates.ts";
import { HUMAN_PROXY_ADAPTER_TYPE } from "../services/human-proxy.ts";

describe("createRk9HeartbeatGates (no database)", () => {
  const unusedDb = new Proxy({}, {
    get: () => {
      throw new Error("unexpected database access");
    },
  }) as Db;
  const unusedIssues = {
    list: vi.fn(),
    listDependencyReadiness: vi.fn(),
  } as unknown as Parameters<typeof createRk9HeartbeatGates>[1]["issuesSvc"];

  it("rotates the resume order so a low global cap is shared across agents", () => {
    const gates = createRk9HeartbeatGates(unusedDb, {
      instanceSettings: { getGeneral: vi.fn() } as never,
      issuesSvc: unusedIssues,
    });
    expect(gates.orderAgentsForResume(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(gates.orderAgentsForResume(["a", "b", "c"])).toEqual(["b", "c", "a"]);
    expect(gates.orderAgentsForResume(["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(gates.orderAgentsForResume([])).toEqual([]);
  });

  it("reads the global cap from instance settings, falls back to the option and caches", async () => {
    const getGeneral = vi.fn(async () => ({ maxGlobalConcurrentRuns: null }));
    const gates = createRk9HeartbeatGates(unusedDb, {
      maxGlobalConcurrentRunsDefault: 3,
      instanceSettings: { getGeneral } as never,
      issuesSvc: unusedIssues,
    });
    expect(await gates.getGlobalMaxConcurrentRuns()).toBe(3);
    expect(await gates.getGlobalMaxConcurrentRuns()).toBe(3);
    expect(getGeneral).toHaveBeenCalledTimes(1);

    const configured = createRk9HeartbeatGates(unusedDb, {
      maxGlobalConcurrentRunsDefault: 3,
      instanceSettings: { getGeneral: vi.fn(async () => ({ maxGlobalConcurrentRuns: 7 })) } as never,
      issuesSvc: unusedIssues,
    });
    expect(await configured.getGlobalMaxConcurrentRuns()).toBe(7);
  });

  it("uses the systemPause option when given, so the owning service decides", async () => {
    const systemPause = { isPaused: vi.fn(async () => true), getState: vi.fn(async () => null) };
    const gates = createRk9HeartbeatGates(unusedDb, {
      systemPause: systemPause as never,
      instanceSettings: { getGeneral: vi.fn() } as never,
      issuesSvc: unusedIssues,
    });
    expect(await gates.systemPause.isPaused()).toBe(true);
    expect(systemPause.isPaused).toHaveBeenCalled();
  });
});

describe("RK9-319 taint hook placement in claimQueuedRun (port map item 22)", () => {
  // A DB-backed native review claim needs a full interaction and decision fixture.
  // rk9-run-taint-claim-path.test.ts drives the ordinary claim. This structural check
  // locks the part that fixture cannot reach: the hook runs for native review claims too.
  const source = readFileSync(new URL("../services/heartbeat/queue.ts", import.meta.url), "utf8");

  it("calls markRunIfTaintingContext once, after the claim and outside the native review branch", () => {
    const calls = source.match(/await markRunIfTaintingContext\(db, claimed\);/g) ?? [];
    expect(calls).toHaveLength(1);
    const hook = source.indexOf("await markRunIfTaintingContext(db, claimed);");
    const claimedGuard = source.lastIndexOf("if (!claimed) return null;", hook);
    const nativeBranch = source.indexOf("if (!nativeReviewContext) {", hook);
    expect(claimedGuard).toBeGreaterThan(0);
    expect(nativeBranch).toBeGreaterThan(hook);
    // Nothing between the claim guard and the hook opens a native review branch.
    expect(source.slice(claimedGuard, hook)).not.toMatch(/if \(!?nativeReviewContext\)/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RK9 gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("fork heartbeat gates on the 1023 module paths (RK9-701)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-gates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
    mockBuildKnowledgeContext.mockReset();
    mockBuildKnowledgeContext.mockResolvedValue(null);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: { companyStatus?: "active" | "paused"; adapterType?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Gate Co",
      status: input.companyStatus ?? "active",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GateAgent",
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, skipWhenIdle: false } },
      permissions: {},
      lastHeartbeatAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: "responsible-user",
      contextSnapshot: { wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function skippedReasons(agentId: string) {
    return db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.status === "skipped").map((row) => row.reason));
  }

  const onDemandWake = {
    source: "on_demand" as const,
    triggerDetail: "manual" as const,
    reason: "issue_commented",
    requestedByActorType: "user" as const,
  };
  const timerWake = {
    source: "timer" as const,
    triggerDetail: "system" as const,
    reason: "heartbeat_timer",
    requestedByActorType: "system" as const,
  };

  it("keeps a queued run queued while the system is paused and starts it after resume (startNext/claim)", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);
    let paused = true;
    const systemPause = {
      isPaused: vi.fn(async () => paused),
      getState: vi.fn(async () => (paused
        ? { pausedAt: new Date().toISOString(), pausedUntil: null, reason: "gate test", source: "manual" as const }
        : null)),
    };
    const heartbeat = heartbeatService(db, { runtimeEnv: {}, systemPause: systemPause as never });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(runId)).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    paused = false;
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runStatus(runId)).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("does not tick timers while the system is paused", async () => {
    await seedAgent();
    const systemPause = { isPaused: vi.fn(async () => true), getState: vi.fn(async () => null) };
    const heartbeat = heartbeatService(db, { runtimeEnv: {}, systemPause: systemPause as never });

    expect(await heartbeat.tickTimers(new Date())).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("refuses an on-demand wake with 409 and skips a timer wake for a paused company", async () => {
    const { agentId } = await seedAgent({ companyStatus: "paused" });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await expect(heartbeat.wakeup(agentId, onDemandWake)).rejects.toMatchObject({
      status: 409,
      message: "Company is paused",
    });
    expect(await heartbeat.wakeup(agentId, timerWake)).toBeNull();

    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toEqual([]);
    expect(await skippedReasons(agentId)).toEqual(["company.paused", "company.paused"]);
  });

  it("does not start a queued run of a paused company", async () => {
    const { companyId, agentId } = await seedAgent({ companyStatus: "paused" });
    const runId = await seedQueuedRun(companyId, agentId);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(runId)).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Leave no queued run behind for the next test's resumeQueuedRuns.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  });

  it("skips every wake of a human-proxy agent and never times it", async () => {
    const { agentId } = await seedAgent({ adapterType: HUMAN_PROXY_ADAPTER_TYPE });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    expect(await heartbeat.wakeup(agentId, onDemandWake)).toBeNull();
    expect(await skippedReasons(agentId)).toEqual(["agent.human_proxy"]);

    // The tick also wakes the timer-enabled agents of earlier tests; let those runs finish.
    await heartbeat.tickTimers(new Date());
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toEqual([]);
    expect(await skippedReasons(agentId)).toEqual(["agent.human_proxy"]);
  });

  it("holds new runs in the queue at the global cap and exposes the cap and running count", async () => {
    const { agentId } = await seedAgent();
    const capped = heartbeatService(db, { runtimeEnv: {}, maxGlobalConcurrentRunsDefault: 0 });

    // The active-execution set is module-wide: let earlier tests' executions settle first.
    await capped.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    expect(await capped.getGlobalMaxConcurrentRuns()).toBe(0);
    expect(capped.getGlobalRunningCount()).toBe(0);

    const run = await capped.wakeup(agentId, onDemandWake);
    expect(run).not.toBeNull();
    await capped.drainActiveRunExecutions();
    expect(await runStatus(run!.id)).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const open = heartbeatService(db, { runtimeEnv: {}, maxGlobalConcurrentRunsDefault: 5 });
    await open.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, open);
    expect(await runStatus(run!.id)).toBe("succeeded");
  });

  // Port map item 19: the knowledge preamble must reach the adapter context, and a
  // failing preamble build must not fail the run.
  it("puts the knowledge-recall preamble into the adapter context", async () => {
    mockBuildKnowledgeContext.mockResolvedValue({ markdown: "## Knowledge\n- gate fact" });
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await runStatus(runId)).toBe("succeeded");
    expect(mockBuildKnowledgeContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId, agent: expect.objectContaining({ id: agentId }) }),
    );
    expect(adapterContexts.get(runId)?.paperclipKnowledgeContext).toBe("## Knowledge\n- gate fact");
  });

  it("runs without a preamble when the knowledge build throws", async () => {
    mockBuildKnowledgeContext.mockRejectedValue(new Error("recall down"));
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await runStatus(runId)).toBe("succeeded");
    expect(adapterContexts.get(runId)).toBeDefined();
    expect(adapterContexts.get(runId)?.paperclipKnowledgeContext).toBeUndefined();
  });
});
