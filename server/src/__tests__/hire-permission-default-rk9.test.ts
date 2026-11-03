// RK9 Custom (RK9-317): the stored permissions of a new agent keep the fork hire rule.
// Upstream v2026.916 grants canCreateAgents to every standard-trust agent on the create path;
// the fork pin in services/agent-permissions.ts limits the default to the CEO role. The route
// tests mock the agent service, so only this test sees what the create path persists.
//
// RK9-707: upstream v2026.1023 has no `agentService.create` (hiring moves to the agent-lifecycle API,
// services/agent-lifecycle.ts, and `prepareAgentHire` in services/agent-hiring.ts), nor
// services/agent-permissions.ts. After the lift the DB cases below fail with a TypeError, not on the
// CEO assertion. In RK9-701 move them to the agent-lifecycle API / `prepareAgentHire` path and keep
// the CEO case. The pure-function cases call the fork pin (`normalizeAgentPermissions` + role)
// directly. They import the module lazily, so a lift that drops services/agent-permissions.ts fails
// them with a clear "module not found" instead of breaking the whole file at load.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";

describe("hire permission default as a pure function (RK9-317, RK9-707)", () => {
  let normalizeAgentPermissions!: typeof import("../services/agent-permissions.ts").normalizeAgentPermissions;
  beforeAll(async () => {
    ({ normalizeAgentPermissions } = await import("../services/agent-permissions.ts"));
  });
  const onCreate = (permissions: unknown, role: string) =>
    normalizeAgentPermissions(permissions, { context: "create", role }).canCreateAgents;

  it("grants canCreateAgents on create only to the CEO role", () => {
    expect(onCreate(undefined, "ceo")).toBe(true);
    expect(onCreate({}, " CEO ")).toBe(true);
    expect(onCreate(undefined, "engineer")).toBe(false);
    expect(onCreate({}, "cto")).toBe(false);
  });

  it("keeps an explicit grant or denial and never grants a low-trust CEO", () => {
    expect(onCreate({ canCreateAgents: true }, "engineer")).toBe(true);
    expect(onCreate({ canCreateAgents: false }, "ceo")).toBe(false);
    expect(onCreate({ trustPreset: LOW_TRUST_REVIEW_PRESET }, "ceo")).toBe(false);
  });

  it("does not grant the default to a stored row, even for the CEO", () => {
    expect(normalizeAgentPermissions({}, { context: "stored", role: "ceo" }).canCreateAgents).toBe(false);
  });
});

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
