// RK9 Custom (RK9-309): locks the fork's hire gate before the upstream upgrade.
//
// Upstream lets standard-trust agents hire in later tags. The fork keeps the
// line from 0071_default_hire_approval_off: only the board, a CEO (or an agent
// with an explicit canCreateAgents / agents:create grant) may hire, and when
// the company sets requireBoardApprovalForNewAgents the hire lands in
// pending_approval with a hire_agent approval instead of going live.
// If an upgrade stage turns any of these red, the new upstream default must be
// pinned back (see doc/UPSTREAM-UPGRADE.md, section "Oletusten kovennus").
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPermissionsForRole, normalizeAgentPermissions } from "../services/agent-permissions.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const standardAgentId = "11111111-1111-4111-8111-111111111111";
const ceoAgentId = "33333333-3333-4333-8333-333333333333";
const hiredAgentId = "44444444-4444-4444-8444-444444444444";

function makeAgent(overrides: Record<string, unknown>) {
  return {
    id: standardAgentId,
    companyId,
    name: "Builder",
    urlKey: "builder",
    role: "engineer",
    title: "Builder",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-09-26T00:00:00.000Z"),
    updatedAt: new Date("2026-09-26T00:00:00.000Z"),
    ...overrides,
  };
}

const standardAgent = makeAgent({});
const ceoAgent = makeAgent({
  id: ceoAgentId,
  name: "CEO",
  urlKey: "ceo",
  role: "ceo",
  title: "CEO",
  permissions: { canCreateAgents: true },
});

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  const services = {
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => ({ upsertPolicy: vi.fn() }),
    heartbeatService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({ list: vi.fn() }),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
    environmentService: () => ({ getById: vi.fn() }),
  };

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
  vi.doMock("../services/agents.js", () => ({ agentService: services.agentService }));
  vi.doMock("../services/access.js", () => ({ accessService: services.accessService }));
  vi.doMock("../services/approvals.js", () => ({ approvalService: services.approvalService }));
  vi.doMock("../services/company-skills.js", () => ({ companySkillService: services.companySkillService }));
  vi.doMock("../services/budgets.js", () => ({ budgetService: services.budgetService }));
  vi.doMock("../services/heartbeat.js", () => ({ heartbeatService: services.heartbeatService }));
  vi.doMock("../services/issue-approvals.js", () => ({ issueApprovalService: services.issueApprovalService }));
  vi.doMock("../services/issues.js", () => ({ issueService: services.issueService }));
  vi.doMock("../services/secrets.js", () => ({ secretService: services.secretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: services.environmentService }));
  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: services.agentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));
  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: services.workspaceOperationService,
  }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/index.js", () => services);
}

function createDbStub(requireBoardApprovalForNewAgents: boolean) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{ id: companyId, name: "RK9", requireBoardApprovalForNewAgents }])),
          ),
        }),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>, requireBoardApprovalForNewAgents: boolean) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub(requireBoardApprovalForNewAgents) as any));
  app.use(errorHandler);
  return app;
}

function agentActor(agentId: string) {
  return { type: "agent", agentId, companyId, source: "agent_key", runId: "run-1" };
}

const hireBody = {
  name: "Recruit",
  role: "engineer",
  adapterType: "process",
  adapterConfig: {},
};

// The first test pays the cold import of routes/agents.js, which can exceed the 5 s default.
describe.sequential("hire approval policy (RK9-309)", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.resetAllMocks();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === ceoAgentId ? ceoAgent : id === standardAgentId ? standardAgent : null,
    );
    mockAgentService.list.mockResolvedValue([standardAgent, ceoAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) =>
      makeAgent({ ...input, id: hiredAgentId }),
    );
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) =>
      makeAgent({ ...patch, id }),
    );
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId,
      ...input,
    }));
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({ bundle: null, adapterConfig: agent.adapterConfig ?? {} }),
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects a hire request from a standard-trust agent", async () => {
    const app = await createApp(agentActor(standardAgentId), false);

    const res = await request(app).post(`/api/companies/${companyId}/agent-hires`).send(hireBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("can create agents");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects direct agent creation from a standard-trust agent", async () => {
    const app = await createApp(agentActor(standardAgentId), false);

    const res = await request(app).post(`/api/companies/${companyId}/agents`).send(hireBody);

    expect(res.status).toBe(403);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("routes a CEO hire to pending approval when the company requires board approval", async () => {
    const app = await createApp(agentActor(ceoAgentId), true);

    const res = await request(app).post(`/api/companies/${companyId}/agent-hires`).send(hireBody);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        type: "hire_agent",
        status: "pending",
        requestedByAgentId: ceoAgentId,
      }),
    );
    expect(res.body.approval).toMatchObject({ type: "hire_agent", status: "pending" });
  });

  it("does not let an explicit agents:create grant bypass the board approval gate", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const app = await createApp(agentActor(standardAgentId), true);

    const res = await request(app).post(`/api/companies/${companyId}/agent-hires`).send(hireBody);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ type: "hire_agent", requestedByAgentId: standardAgentId }),
    );
  });

  it("blocks the direct-create shortcut for a CEO when the company requires board approval", async () => {
    const app = await createApp(agentActor(ceoAgentId), true);

    const res = await request(app).post(`/api/companies/${companyId}/agents`).send(hireBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("/agent-hires");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("does not let an agent approve a pending hire", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ id: hiredAgentId, status: "pending_approval" }));
    const app = await createApp(agentActor(ceoAgentId), true);

    const res = await request(app).post(`/api/agents/${hiredAgentId}/approve`).send({});

    expect(res.status).toBe(403);
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
  });

  // Fork default since 0071: the approval gate is off unless the company opts in.
  // A CEO hire then goes live at once. Keep this visible so an upgrade that
  // changes the default is noticed.
  it("auto-activates a CEO hire when the company has not opted into board approval", async () => {
    const app = await createApp(agentActor(ceoAgentId), false);

    const res = await request(app).post(`/api/companies/${companyId}/agent-hires`).send(hireBody);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ status: "idle" }),
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });
});

// Tripwire for v2026.916.1: upstream makes canCreateAgents default-on for every
// standard-trust agent created through the hire/create path. The fork grants
// it only to the CEO role. When this turns red during an upgrade stage, keep
// the fork default (or require board approval for every company) before merge.
describe("default hire permission (RK9-309)", () => {
  it("grants canCreateAgents by default only to the CEO role", () => {
    expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
    for (const role of ["engineer", "cto", "cmo", "qa", "general"]) {
      expect(defaultPermissionsForRole(role).canCreateAgents).toBe(false);
    }
  });

  it("keeps a new standard-trust agent without an explicit grant unable to hire", () => {
    expect(normalizeAgentPermissions(undefined, "engineer").canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({}, "engineer").canCreateAgents).toBe(false);
  });
});
