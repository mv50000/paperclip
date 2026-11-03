// RK9-693 (nosto prep, RK9-675 option C): upstream v2026.1023 adds `unpriced_usage_policy`
// with default 'block'. The fork has no such policy: a claude_local subscription run is
// recorded with costCents = 0 and must never trip a budget hard stop or auto-pause the agent.
// Wanted value after the lift (RK9-701): unpriced_usage_policy = 'allow' (do not block, do not
// pause) for claude_local subscription usage. If the lift changes this behaviour, this test fails.
import { randomUUID } from "node:crypto";
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
import { eq } from "drizzle-orm";
import { costService } from "../services/costs.ts";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("claude_local subscription usage never auto-pauses (RK9-693)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("nosto-budget-unpriced-rk9");
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

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RK9",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Subscription Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(budgetPolicies).values([
      {
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
      {
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      },
    ]);
    return { companyId, agentId };
  }

  it("keeps the agent active and raises no incident for unpriced subscription runs", async () => {
    const { companyId, agentId } = await fixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const costs = costService(db, { cancelWorkForScope });

    for (let i = 0; i < 3; i += 1) {
      await costs.createEvent(companyId, {
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-sonnet-5-5",
        inputTokens: 5_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 500_000,
        costCents: 0,
        occurredAt: new Date(),
      });
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("active");
    expect(agent?.pauseReason ?? null).toBeNull();
    expect(await db.select().from(budgetIncidents)).toHaveLength(0);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();
  });

  it("control: a priced metered run over the limit still pauses (the hard stop itself stays)", async () => {
    const { companyId, agentId } = await fixture();
    const costs = costService(db, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });
    await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 10,
      costCents: 150,
      occurredAt: new Date(),
    });
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("paused");
  });
});
