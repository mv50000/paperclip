// RK9-708 (follow-up to RK9-694 port map, item 22): the taint hook must run on
// the real claim path. rk9-run-taint-e2e.test.ts calls markRunIfTaintingContext
// directly, so it stays green even if the hook call disappears from
// claimQueuedRun. This test drives a queued run through
// heartbeat.resumeQueuedRuns() -> claimQueuedRun -> adapter and checks that a
// tainting context marks the run before the adapter starts.
//
// It must fail if the `markRunIfTaintingContext(db, claimed)` call is removed
// from claimQueuedRun (heartbeat.ts today, heartbeat/queue.ts after the 1023
// port). Nothing else in this path marks the run: the adapter is a mock and the
// lazy gates in rk9-run-taint.ts are not reached.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  rk9RunTaints,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Taint state per run id at the moment the adapter is invoked.
const taintAtAdapterStart = vi.hoisted(() => new Map<string, boolean>());
const adapterDb = vi.hoisted(() => ({ current: null as unknown }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: { runId: string }) => {
    const { rk9RunTaints: taints } = await import("@paperclipai/db");
    const { eq: eqOp } = await import("drizzle-orm");
    const db = adapterDb.current as ReturnType<typeof import("@paperclipai/db").createDb>;
    const rows = await db.select({ runId: taints.runId }).from(taints).where(eqOp(taints.runId, ctx.runId));
    taintAtAdapterStart.set(ctx.runId, rows.length > 0);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "taint claim-path test run",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres taint claim-path tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("RK9-319 taint hook on the real claim path (RK9-708)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-taint-claim-");
    db = createDb(tempDb.connectionString);
    adapterDb.current = db;
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRun(contextSnapshot: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Taint Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tuki",
      role: "support",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: "responsible-user",
      contextSnapshot,
    });
    return { companyId, agentId, runId };
  }

  async function claimThroughHeartbeat(runId: string) {
    // Clean env: a worktree host sets PAPERCLIP_IN_WORKTREE, which suppresses scheduling.
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [run] = await db
      .select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    // The drain gives up silently; require that the run really finished.
    expect(run?.status).toBe("succeeded");
    return run;
  }

  it("marks a run woken by an inbound email tainted before the adapter starts", async () => {
    const { runId } = await seedQueuedRun({ source: "email.inbound", wakeReason: "email_inbound" });

    const run = await claimThroughHeartbeat(runId);

    // The run really went through claimQueuedRun (left the queue and started).
    expect(run?.startedAt).not.toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(taintAtAdapterStart.get(runId)).toBe(true);

    const [taint] = await db.select().from(rk9RunTaints).where(eq(rk9RunTaints.runId, runId));
    expect(taint?.sources.map((s) => s.kind)).toContain("email_inbound_wake");
  });

  it("leaves a run with a clean context unmarked", async () => {
    const { runId } = await seedQueuedRun({ wakeReason: "issue_assigned" });

    const run = await claimThroughHeartbeat(runId);

    expect(run?.startedAt).not.toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(taintAtAdapterStart.get(runId)).toBe(false);
    expect(await db.select().from(rk9RunTaints).where(eq(rk9RunTaints.runId, runId))).toEqual([]);
  });
});
