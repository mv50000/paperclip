import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getPolicy: vi.fn(async () => null),
  upsertMonitorRisk: vi.fn(async () => ({ id: "risk-entry-1", title: "Silent agent: TestAgent" })),
  resolveMonitorRisk: vi.fn(async () => []),
  ensureBuiltinCategories: vi.fn(async () => undefined),
}));

const mockIncidents = vi.hoisted(() => ({
  createIncident: vi.fn(async () => ({ id: "incident-1" })),
  listOpenIncidents: vi.fn(async () => []),
  findOpenByRiskEntryId: vi.fn(async () => []),
}));

vi.mock("../services/risk-registry.js", () => ({
  riskRegistryService: () => mockRegistry,
  computeRiskScore: (sev: string, lik: string) => {
    const sevMap: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, negligible: 1 };
    const likMap: Record<string, number> = { certain: 5, likely: 4, possible: 3, unlikely: 2, rare: 1 };
    return (sevMap[sev] ?? 1) * (likMap[lik] ?? 1);
  },
}));

vi.mock("../services/risk-incidents.js", () => ({
  riskIncidentService: () => mockIncidents,
}));

vi.mock("../services/risk-playbooks.js", () => ({
  PLAYBOOKS: { AGENT_SILENT: { code: "AGENT_SILENT", autoActions: [] } },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeAgent(overrides?: Partial<{
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: Date | null;
  runtimeConfig: Record<string, unknown>;
}>) {
  return {
    id: overrides?.id ?? "agent-1",
    name: overrides?.name ?? "TestAgent",
    status: overrides?.status ?? "active",
    lastHeartbeatAt: "lastHeartbeatAt" in (overrides ?? {})
      ? overrides!.lastHeartbeatAt
      : new Date(Date.now() - 24 * 60 * 60 * 1000),
    runtimeConfig: overrides?.runtimeConfig ?? { heartbeatIntervalSec: 3600 },
  };
}

function createDbStub(opts: {
  agents?: ReturnType<typeof makeAgent>[];
  agentsWithRoutines?: { agentId: string }[];
}) {
  const agentRows = opts.agents ?? [];
  const routineJoinRows = opts.agentsWithRoutines ?? [];

  const selectCallIndex = { current: 0 };

  function makeChain(rows: unknown[]): any {
    return {
      from: vi.fn(() => makeChain(rows)),
      where: vi.fn(() => makeChain(rows)),
      innerJoin: vi.fn(() => makeChain(rows)),
      orderBy: vi.fn(() => makeChain(rows)),
      limit: vi.fn(() => makeChain(rows)),
      then: vi.fn((resolve: (v: unknown) => unknown) => resolve(rows)),
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  }

  return {
    select: vi.fn(() => {
      const idx = selectCallIndex.current++;
      if (idx === 0) return makeChain(agentRows);
      if (idx === 1) return makeChain(routineJoinRows);
      return makeChain([]);
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    })),
  };
}

describe("runAgentHealthMonitor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRegistry.getPolicy.mockResolvedValue(null);
    mockRegistry.upsertMonitorRisk.mockResolvedValue({ id: "risk-entry-1", title: "Silent agent: TestAgent" });
    mockRegistry.resolveMonitorRisk.mockResolvedValue([]);
    mockIncidents.findOpenByRiskEntryId.mockResolvedValue([]);
  });

  it("skips agents without active routines (idle by design)", async () => {
    const db = createDbStub({
      agents: [makeAgent({ id: "idle-agent", name: "IdleAgent" })],
      agentsWithRoutines: [],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockRegistry.upsertMonitorRisk).not.toHaveBeenCalled();
    expect(mockIncidents.createIncident).not.toHaveBeenCalled();
    expect(mockRegistry.resolveMonitorRisk).toHaveBeenCalledWith(
      "company-1", "AGENT_SILENT", "agent", "idle-agent",
    );
    expect(result.incidentsCreated).toBe(0);
  });

  it("flags silent agents that have active routines", async () => {
    const db = createDbStub({
      agents: [makeAgent({ id: "active-agent", name: "ActiveAgent" })],
      agentsWithRoutines: [{ agentId: "active-agent" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockRegistry.upsertMonitorRisk).toHaveBeenCalledWith(
      "company-1", "AGENT_SILENT", "agent", "active-agent",
      expect.any(Object),
      expect.objectContaining({ title: "Silent agent: ActiveAgent" }),
    );
    expect(result.risksCreated).toBe(1);
  });

  it("does not create or resolve monitor risks when the policy is disabled", async () => {
    mockRegistry.getPolicy.mockResolvedValue({
      enabled: false,
      thresholdJson: {},
      autoActions: null,
      escalationSev: null,
    });
    const db = createDbStub({
      agents: [makeAgent({ id: "active-agent", name: "ActiveAgent" })],
      agentsWithRoutines: [{ agentId: "active-agent" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockRegistry.upsertMonitorRisk).not.toHaveBeenCalled();
    expect(mockRegistry.resolveMonitorRisk).not.toHaveBeenCalled();
    expect(mockIncidents.createIncident).not.toHaveBeenCalled();
    expect(result).toMatchObject({ risksCreated: 0, risksResolved: 0, incidentsCreated: 0 });
  });

  it("passes policy auto actions and escalation severity into created incidents", async () => {
    mockRegistry.getPolicy.mockResolvedValue({
      enabled: true,
      thresholdJson: {},
      autoActions: ["create_approval"],
      escalationSev: "sev2",
    });
    const db = createDbStub({
      agents: [makeAgent({ id: "active-agent", name: "ActiveAgent" })],
      agentsWithRoutines: [{ agentId: "active-agent" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    await service.runAgentHealthMonitor("company-1");

    expect(mockIncidents.createIncident).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        severity: "sev2",
        autoActionTypes: ["create_approval"],
      }),
    );
  });

  it("does not create duplicate incidents for same risk entry", async () => {
    mockIncidents.findOpenByRiskEntryId.mockResolvedValue([{ id: "existing-incident" }]);

    const db = createDbStub({
      agents: [makeAgent({ id: "agent-1" })],
      agentsWithRoutines: [{ agentId: "agent-1" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockIncidents.createIncident).not.toHaveBeenCalled();
    expect(result.incidentsCreated).toBe(0);
    expect(result.risksCreated).toBe(1);
  });

  it("skips paused agents", async () => {
    const db = createDbStub({
      agents: [makeAgent({ id: "paused-agent", status: "paused" })],
      agentsWithRoutines: [{ agentId: "paused-agent" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockRegistry.upsertMonitorRisk).not.toHaveBeenCalled();
    expect(result.risksCreated).toBe(0);
  });

  it("skips agents without lastHeartbeatAt", async () => {
    const db = createDbStub({
      agents: [makeAgent({ id: "new-agent", lastHeartbeatAt: null })],
      agentsWithRoutines: [{ agentId: "new-agent" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockRegistry.upsertMonitorRisk).not.toHaveBeenCalled();
  });

  it("resolves risk for agents within expected silence window", async () => {
    const db = createDbStub({
      agents: [makeAgent({ id: "healthy-agent", lastHeartbeatAt: new Date(Date.now() - 1000) })],
      agentsWithRoutines: [{ agentId: "healthy-agent" }],
    });

    const { riskMonitorService } = await import("../services/risk-monitors.js");
    const service = riskMonitorService(db as any);
    const result = await service.runAgentHealthMonitor("company-1");

    expect(mockRegistry.resolveMonitorRisk).toHaveBeenCalledWith(
      "company-1", "AGENT_SILENT", "agent", "healthy-agent",
    );
    expect(result.risksResolved).toBe(1);
  });
});
