// RK9 Custom (RK9-317): the stored permissions of a new agent keep the fork hire rule.
// Upstream v2026.916 grants canCreateAgents to every standard-trust agent on the create path;
// the fork pin in services/agent-permissions.ts limits the default to the CEO role. The route
// tests mock the agent service, so only this test sees what the create path persists.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres hire permission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("new agent hire permission default (RK9-317)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("hire-permission-default-rk9");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RK9",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createAgent(companyId: string, role: string, permissions?: Record<string, unknown>) {
    return agentService(db).create(companyId, {
      name: `${role}-${randomUUID().slice(0, 8)}`,
      role,
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      ...(permissions ? { permissions } : {}),
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  it("persists canCreateAgents=false for a standard-trust agent without an explicit grant", async () => {
    const companyId = await seedCompany();
    const created = await createAgent(companyId, "engineer");
    expect(created.permissions?.canCreateAgents).toBe(false);
    const [row] = await db.select({ permissions: agents.permissions }).from(agents);
    expect((row?.permissions as Record<string, unknown>).canCreateAgents).toBe(false);
  });

  it("persists canCreateAgents=true for the CEO role and for an explicit grant", async () => {
    const companyId = await seedCompany();
    const ceo = await createAgent(companyId, "ceo");
    expect(ceo.permissions?.canCreateAgents).toBe(true);
    const granted = await createAgent(companyId, "engineer", { canCreateAgents: true });
    expect(granted.permissions?.canCreateAgents).toBe(true);
  });
});
