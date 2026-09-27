// RK9 Custom (RK9-313): locks who may hire against the real authorization service.
//
// From v2026.609.0 the hire routes ask access.decide("agents:create") instead of
// checking canCreateAgents themselves. hire-approval-policy.test.ts mocks that call,
// so this file runs the real authorizationService on embedded Postgres. The fork rule
// from 0071 and RK9-309: an agent may hire only as CEO, with canCreateAgents, or with
// an explicit agents:create grant. A standard-trust agent without those is denied.
// If an upgrade stage turns a deny here into an allow, pin the fork rule back before
// merge (doc/upgrade/defaults-hardening.md).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { authorizationService } from "../services/authorization.js";
import { normalizeAgentPermissions } from "../services/agent-permissions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("hire authorization (RK9-313)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hire-authorization-rk9-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db
      .insert(companies)
      .values({ name: `Hire ${randomUUID()}`, issuePrefix: `HR${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  // Same path as agent creation: permissions go through normalizeAgentPermissions.
  async function createAgent(companyId: string, role: string, permissions?: Record<string, unknown>) {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role,
        permissions: normalizeAgentPermissions(permissions, role),
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function decideCreate(companyId: string, agentId: string) {
    return authorizationService(db).decide({
      actor: { type: "agent", agentId, companyId, source: "agent_jwt" },
      action: "agents:create",
      resource: { type: "company", companyId },
    });
  }

  it("denies a standard-trust agent with default permissions", async () => {
    const company = await createCompany();
    for (const role of ["engineer", "cto", "cmo", "qa", "general"]) {
      const agent = await createAgent(company.id, role);
      const decision = await decideCreate(company.id, agent.id);
      expect(decision, role).toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    }
  });

  it("allows the CEO role", async () => {
    const company = await createCompany();
    const ceo = await createAgent(company.id, "ceo");
    expect(await decideCreate(company.id, ceo.id)).toMatchObject({
      allowed: true,
      reason: "allow_legacy_agent_creator",
    });
  });

  it("allows an agent with canCreateAgents set explicitly", async () => {
    const company = await createCompany();
    const agent = await createAgent(company.id, "engineer", { canCreateAgents: true });
    expect(await decideCreate(company.id, agent.id)).toMatchObject({ allowed: true });
  });

  it("allows an agent with an explicit agents:create grant", async () => {
    const company = await createCompany();
    const agent = await createAgent(company.id, "engineer");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "agents:create",
      scope: null,
      grantedByUserId: null,
    });
    expect(await decideCreate(company.id, agent.id)).toMatchObject({ allowed: true });
  });

  it("denies an agent from another company", async () => {
    const company = await createCompany();
    const other = await createCompany();
    const ceo = await createAgent(other.id, "ceo");
    expect(await decideCreate(company.id, ceo.id)).toMatchObject({ allowed: false });
  });
});
