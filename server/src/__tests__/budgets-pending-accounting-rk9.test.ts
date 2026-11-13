// RK9 fork regression (RK9-701): a run that ended without a final usage receipt must not lock a
// budget scope. Upstream v2026.1023.0 marks every finished run `cost_accounting_pending` and counts
// pending runs as a hard stop (budgets.ts observedBlocks). A claude_local run that is cancelled, times
// out or fails before its final result event reports `usageComplete: false`, so
// `accountingReceiptReady` is false, the accounting sweep skips it, and the run stays pending
// forever: every hard-stop policy of that agent or company then blocks, pauses and cancels work.
// The fork (a) never lets a pending run hard-stop a scope (as before 1023: spend counts once it is
// in the ledger) and (b) settles a receipt-less terminal run with its last known usage after a
// grace period, so it does not stay pending and needs no operator.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  accountingRuntimeBaselines,
  agentRuntimeState,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  budgetReservations,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import { reconcileRunCosts, RK9_RECEIPTLESS_SETTLE_AFTER_MS } from "../services/run-cost-accounting.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("receipt-less runs never lock a budget scope (fork, RK9-701)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-pending-rk9-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetReservations);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(accountingRuntimeBaselines);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(scopeType: "agent" | "company" = "agent") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pending Co",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
      id,
      companyId,
      name: `Pending Agent ${index}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType,
      scopeId: scopeType === "agent" ? agentId : companyId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 10_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    });
    return { companyId, agentId, otherAgentId };
  }

  async function terminalRun(
    companyId: string,
    agentId: string,
    input: { status: "cancelled" | "timed_out" | "failed"; finishedAgoMs: number; receiptReady: boolean },
  ) {
    const finishedAt = new Date(Date.now() - input.finishedAgoMs);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: input.status,
      costAccountingPending: true,
      createdAt: new Date(finishedAt.getTime() - 60_000),
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      usageJson: {
        accountingReceiptReady: input.receiptReady,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-sonnet-5-5",
        inputTokens: 1_200,
        cachedInputTokens: 0,
        outputTokens: 300,
        costUsd: null,
      },
    }).returning();
    return run!;
  }

  async function runRow(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  }

  async function agentStatus(agentId: string) {
    return db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!.status);
  }

  it.each(["cancelled", "timed_out", "failed"] as const)(
    "a %s run without a final receipt does not block the agent's next run",
    async (status) => {
      const { companyId, agentId } = await fixture("agent");
      await terminalRun(companyId, agentId, { status, finishedAgoMs: 60_000, receiptReady: false });
      const service = budgetService(db, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });

      expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
      expect(await agentStatus(agentId)).toBe("idle");
      expect(await db.select().from(budgetIncidents)).toHaveLength(0);
    },
  );

  it("a fresh pending run of one agent does not pause the company for another agent", async () => {
    // MEDIUM 2: the pending flag commits before accountRunCost takes the company lock.
    const { companyId, agentId, otherAgentId } = await fixture("company");
    await terminalRun(companyId, agentId, { status: "cancelled", finishedAgoMs: 1_000, receiptReady: true });
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    expect(await service.getInvocationBlock(companyId, otherAgentId)).toBeNull();
    const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    expect(company!.status).toBe("active");
    expect(cancelWorkForScope).not.toHaveBeenCalled();
  });

  it("settles a receipt-less terminal run with its last known usage after the grace period", async () => {
    const { companyId, agentId } = await fixture("agent");
    const stale = await terminalRun(companyId, agentId, {
      status: "timed_out", finishedAgoMs: RK9_RECEIPTLESS_SETTLE_AFTER_MS + 60_000, receiptReady: false,
    });

    const result = await reconcileRunCosts(db);

    expect(result.accounted).toBe(1);
    const settled = await runRow(stale.id);
    expect(settled.costAccountingPending).toBe(false);
    expect(settled.costAccountedAt).not.toBeNull();
    expect((settled.usageJson as Record<string, unknown>).rk9SettledWithoutReceipt).toBe(true);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, stale.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ billingType: "subscription_included", inputTokens: 1_200, outputTokens: 300, costCents: 0 });
    expect(await agentStatus(agentId)).toBe("idle");
  });

  it("keeps a receipt-less run pending inside the grace period, so a late receipt can still land", async () => {
    const { companyId, agentId } = await fixture("agent");
    const fresh = await terminalRun(companyId, agentId, { status: "cancelled", finishedAgoMs: 60_000, receiptReady: false });

    const result = await reconcileRunCosts(db);

    expect(result.accounted).toBe(0);
    expect((await runRow(fresh.id)).costAccountingPending).toBe(true);
  });

  it("still hard-stops on recorded spend at the budget", async () => {
    const { companyId, agentId } = await fixture("agent");
    await db.insert(costEvents).values({
      companyId, agentId, provider: "openai", biller: "openai", billingType: "metered_api",
      model: "gpt-boundary", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costCents: 10_000, occurredAt: new Date(),
    });
    const service = budgetService(db, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });

    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({ scopeType: "agent", scopeId: agentId });
  });
});
