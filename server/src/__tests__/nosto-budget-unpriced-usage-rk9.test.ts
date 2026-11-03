// RK9-693 (nosto prep, RK9-675 option C), RK9-707: upstream v2026.1023 adds `unpriced_usage_policy`
// with default 'block'. 1023 counts an event as unpriced only when
// `cost_status = 'unpriced' AND billing_type <> 'subscription_included'` (budgets.ts
// computeObservedSpends), so a subscription_included fixture passes under both 'block' and 'allow'.
// The real risk is a claude_local run that reports billing_type `api` (stored as `metered_api`) or
// no billing type (`unknown`) with no price: the heartbeat stores it as cost_status 'unpriced'
// (resolveLedgerCostStatus). The fork never blocks on it. Wanted value after the lift (RK9-701):
// unpriced_usage_policy = 'allow' (no hard stop, no auto-pause). Under the 1023 default 'block' the
// unpriced cases below fail on the `active` / no-incident / no-block assertions.
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

describeEmbeddedPostgres("unpriced claude_local usage never auto-pauses (RK9-693, RK9-707)", () => {
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

  async function expectNotPaused(companyId: string, agentId: string, cancelWorkForScope: ReturnType<typeof vi.fn>) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("active");
    expect(agent?.pauseReason ?? null).toBeNull();
    expect(await db.select().from(budgetIncidents)).toHaveLength(0);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();
  }

  it("a claude_local run with token usage and no price is stored as unpriced", async () => {
    // The precondition for the cases below: an unpriced run reaches the ledger as cost_status 'unpriced'.
    // Imported lazily: 1023 moves the function to services/heartbeat/run-state.ts, and a missing
    // export must fail only this case, not the budget cases.
    const { resolveLedgerCostStatus } = await import("../services/heartbeat.ts");
    expect(
      resolveLedgerCostStatus({ costUsd: null, inputTokens: 5_000, cachedInputTokens: 0, outputTokens: 500 }),
    ).toBe("unpriced");
  });

  // `metered_api` is what the heartbeat stores for an adapter billing type `api` (normalizeLedgerBillingType).
  it.each(["metered_api", "unknown"] as const)(
    "keeps the agent active for an unpriced claude_local run with billing_type %s (policy allow)",
    async (billingType) => {
      const { companyId, agentId } = await fixture();
      const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
      const costs = costService(db, { cancelWorkForScope });

      for (let i = 0; i < 3; i += 1) {
        await costs.createEvent(companyId, {
          agentId,
          provider: "anthropic",
          biller: "anthropic",
          billingType,
          costStatus: "unpriced",
          model: "claude-sonnet-5-5",
          inputTokens: 5_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 500_000,
          costCents: 0,
          occurredAt: new Date(),
        });
      }

      const stored = await db.select().from(costEvents);
      expect(stored.map((row) => [row.billingType, row.costStatus])).toEqual(
        Array.from({ length: 3 }, () => [billingType, "unpriced"]),
      );
      await expectNotPaused(companyId, agentId, cancelWorkForScope);
    },
  );

  it("keeps the agent active for an unpriced subscription_included run", async () => {
    // 1023 exempts subscription_included from the unpriced count, so this case alone cannot tell
    // 'block' from 'allow'. It stays as a regression guard for the subscription path.
    const { companyId, agentId } = await fixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const costs = costService(db, { cancelWorkForScope });
    await costs.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      costStatus: "unpriced",
      model: "claude-sonnet-5-5",
      inputTokens: 5_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 500_000,
      costCents: 0,
      occurredAt: new Date(),
    });
    await expectNotPaused(companyId, agentId, cancelWorkForScope);
  });

  // 1023 also blocks while a finished run has heartbeat_runs.cost_accounting_pending = true
  // (budgets.ts computeObservedSpends, `pendingRunCount - recoveringRunCount > 0`). The fork has no
  // such column, so the case cannot be modelled yet. Activate in RK9-701.
  it.todo("a finished claude_local run with cost accounting pending does not pause the agent (RK9-701)");

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
