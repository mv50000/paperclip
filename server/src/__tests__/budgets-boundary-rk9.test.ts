// RK9 fork regression: budget hard stop at exactly 100 % (RK9-701).
// Upstream v2026.1023.0 replaced the stub-based budgets-service.test.ts with a
// PostgreSQL-backed one, and the fork's boundary cases went with it. They are
// rebuilt here against a real database. Upstream 1023 also compares money as
// numeric(24,7) text (`compareCents`), so the 99.99 / 100.01 cents cases now
// exercise the real column type instead of a stubbed number.
// The last case locks the 1023 default `unpriced_usage_policy = 'block'`: one
// unpriced, non-subscription cost event hard-stops the scope even below 100 %.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget boundary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("budget hard stop at the exact 100 % boundary (fork, RK9-701)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-boundary-rk9-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(input: { unpricedUsagePolicy?: "block" | "allow" } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Boundary Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Boundary Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
      ...(input.unpricedUsagePolicy ? { unpricedUsagePolicy: input.unpricedUsagePolicy } : {}),
    });
    return { companyId, agentId };
  }

  async function spend(
    companyId: string,
    agentId: string,
    costCents: number,
    extra: Partial<typeof costEvents.$inferInsert> = {},
  ) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-boundary",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
        costCents,
        occurredAt: new Date(),
        ...extra,
      })
      .returning();
    return event!;
  }

  async function agentState(agentId: string) {
    return db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
  }

  async function hardIncidents() {
    return db.select().from(budgetIncidents).then((rows) => rows.filter((row) => row.thresholdType === "hard"));
  }

  it("pauses the agent when spend is exactly 100 % of the budget", async () => {
    const { companyId, agentId } = await fixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    await service.evaluateCostEvent(await spend(companyId, agentId, 100));

    expect(await agentState(agentId)).toEqual({ status: "paused", pauseReason: "budget" });
    const [incident] = await hardIncidents();
    expect(incident).toMatchObject({ amountLimit: 100, amountObserved: 100, status: "open" });
    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({ type: "budget_override_required", status: "pending" });
    expect(cancelWorkForScope).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, scopeType: "agent", scopeId: agentId }),
    );
  });

  it("does not pause the agent at 99.99 % of the budget", async () => {
    const { companyId, agentId } = await fixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    await service.evaluateCostEvent(await spend(companyId, agentId, 99.99));

    expect(await agentState(agentId)).toEqual({ status: "active", pauseReason: null });
    expect(await hardIncidents()).toEqual([]);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
  });

  it("pauses the agent just over the budget (100.01 %)", async () => {
    const { companyId, agentId } = await fixture();
    const service = budgetService(db, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });

    await service.evaluateCostEvent(await spend(companyId, agentId, 100.01));

    expect(await agentState(agentId)).toEqual({ status: "paused", pauseReason: "budget" });
    const [incident] = await hardIncidents();
    expect(incident).toMatchObject({ amountLimit: 100, amountObserved: 100.01 });
  });

  it("blocks invocation at exactly 100 % spend even before the cost event is evaluated", async () => {
    const { companyId, agentId } = await fixture();
    await spend(companyId, agentId, 100);
    const service = budgetService(db);

    const block = await service.getInvocationBlock(companyId, agentId);

    expect(block).toMatchObject({ scopeType: "agent", scopeId: agentId });
  });

  it("hard-stops on one unpriced metered event under the 1023 default, and not when the policy allows it", async () => {
    const blocked = await fixture();
    const service = budgetService(db, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });
    await spend(blocked.companyId, blocked.agentId, 0, { costStatus: "unpriced" });
    expect(await service.getInvocationBlock(blocked.companyId, blocked.agentId)).toMatchObject({
      scopeType: "agent",
      scopeId: blocked.agentId,
    });

    const allowed = await fixture({ unpricedUsagePolicy: "allow" });
    await spend(allowed.companyId, allowed.agentId, 0, { costStatus: "unpriced" });
    expect(await service.getInvocationBlock(allowed.companyId, allowed.agentId)).toBeNull();

    // A subscription-included event never counts as unpriced usage.
    const subscription = await fixture();
    await spend(subscription.companyId, subscription.agentId, 0, {
      costStatus: "unpriced",
      billingType: "subscription_included",
    });
    expect(await service.getInvocationBlock(subscription.companyId, subscription.agentId)).toBeNull();
  });
});
