// RK9-490: an approved voice_action wakes the same agents with the same wake
// requests as the same board action through the issue routes. Both paths run
// against the same mocked services, and the wakeup calls are compared.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceActionDeps } from "../services/rk9-voice-action.js";

// The first test imports the large routes/issues.ts module (see
// issue-dependency-wakeups-routes.test.ts for the cold-start note).
vi.setConfig({ testTimeout: 30000 });

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEPENDENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const DEPENDENT_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const PARENT_AGENT_ID = "66666666-6666-4666-8666-666666666666";

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listReviewAttention: vi.fn(),
}));
const mockPauseGate = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown> | null> => null));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));
const mockRecoveryActions = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
}));
const mockFindExistingWake = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  nativeQuestionRunToCancel: vi.fn(async () => null),
  validateNativeQuestionResponseInput: vi.fn(),
}));

vi.mock("../services/runner-goals.js", () => ({
  runnerGoalService: () => mockRunnerGoalService,
  RunnerGoalActionError: class RunnerGoalActionError extends Error {},
  RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return { ...actual, findExistingIssueBlockersResolvedWakeForReadyState: mockFindExistingWake };
});

vi.mock("../services/index.js", () => ({
  companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1" })) }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({ ambiguous: false, agent: { id: raw } })),
  }),
  companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => mockRecoveryActions,
  issueTreeControlService: () => ({ getActivePauseHoldGate: mockPauseGate }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
  questionResponseDeliveryService: () => ({ deliver: vi.fn(async () => undefined) }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

function createRouteDb() {
  const emptyRows: unknown[] = [];
  const whereResult = {
    limit: vi.fn(async () => emptyRows),
    then: async (resolve: (rows: unknown[]) => unknown) => resolve(emptyRows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  (whereResult as Record<string, unknown>).orderBy = vi.fn(() => whereResult);
  return {
    select: vi.fn(() => ({ from: vi.fn(() => query) })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(createRouteDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function runVoiceAction(payload: Record<string, unknown>) {
  const { executeVoiceAction } = await import("../services/rk9-voice-action.js");
  const approvalSvc = { addComment: vi.fn(async () => ({})) };
  const deps = {
    db: createRouteDb(),
    issuesSvc: mockIssueService,
    approvalSvc,
    logActivity: vi.fn(async () => undefined),
    heartbeat: mockHeartbeatService,
    runnerGoals: mockRunnerGoalService,
    recoveryActions: mockRecoveryActions,
    treeControl: { getActivePauseHoldGate: mockPauseGate },
    executionWorkspaces: { getById: vi.fn(async () => null) },
    interactions: mockInteractionService,
    issueReferences: { syncComment: async () => undefined },
    externalObjects: { syncCommentSafely: async () => undefined },
    routines: { syncRunStatusForIssue: vi.fn(async () => undefined) },
    environmentRuntime: { destroyReusableSandboxLeases: vi.fn(async () => undefined) },
    taskWatchdogs: { reconcileForIssueAndAncestors: vi.fn(async () => undefined) },
    markBlockedOwnerNotified: vi.fn(async () => undefined),
  } as unknown as VoiceActionDeps;
  await executeVoiceAction(deps, { id: "approval-1", companyId: "company-1", payload }, "local-board");
  // The parity cases expect every side effect step to succeed.
  expect(String(approvalSvc.addComment.mock.calls[0]?.[1] ?? "")).not.toContain("sivuvaikutukset");
  return String(approvalSvc.addComment.mock.calls[0]?.[1] ?? "");
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    identifier: "PAP-999",
    title: "Parity test",
    description: null,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

/** The wakeup calls, ordered by agent so batching order does not matter. */
function wakeCalls() {
  return (mockHeartbeatService.wakeup.mock.calls as unknown as Array<[string, Record<string, unknown>]>)
    .map(([agentId, wakeup]) => ({ agentId, wakeup }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

async function settledWakeCalls(expectedCount: number) {
  await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(expectedCount));
  // Let any extra fire-and-forget wake land before the calls are read.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return wakeCalls();
}

function resetMocks() {
  vi.clearAllMocks();
  mockPauseGate.mockResolvedValue(null);
  mockFindExistingWake.mockResolvedValue(null);
  mockIssueService.getAncestors.mockResolvedValue([]);
  mockIssueService.getByIdentifier.mockResolvedValue(null);
  mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
  mockIssueService.getComment.mockResolvedValue(null);
  mockIssueService.getCommentCursor.mockResolvedValue({ totalComments: 0, latestCommentId: null, latestCommentAt: null });
  mockIssueService.findMentionedAgents.mockResolvedValue([]);
  mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
  mockIssueService.getDependencyReadiness.mockResolvedValue({
    issueId: ISSUE_ID,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
  });
  mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
  mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
  mockIssueService.listReviewAttention.mockResolvedValue(new Map());
}

function snapshotOf(issue: ReturnType<typeof makeIssue>) {
  return { issueStatusAtProposal: issue.status, assigneeAgentIdAtProposal: issue.assigneeAgentId };
}

describe("voice_action wakes match the issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    resetMocks();
  });

  it("wakes the assignee and a mentioned agent like a board comment", async () => {
    const existing = makeIssue();
    const body = "Testattu autossa, katso @Reviewer";
    const comment = {
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body,
      authorUserId: "local-board",
      createdByRunId: null,
      createdAt: new Date("2026-10-11T10:00:00Z"),
    };
    const arrange = () => {
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue(comment);
      mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    };

    arrange();
    const res = await request(await createApp()).post(`/api/issues/${ISSUE_ID}/comments`).send({ body });
    expect(res.status).toBe(201);
    const routeWakes = await settledWakeCalls(2);

    resetMocks();
    arrange();
    const outcome = await runVoiceAction({
      action: "issue_comment",
      issueId: ISSUE_ID,
      identifier: "PAP-999",
      body,
      source: "grok",
      ...snapshotOf(existing),
    });
    expect(outcome).toContain("✅");
    expect(wakeCalls()).toEqual(routeWakes);
    expect(routeWakes.map((call) => call.wakeup.reason)).toEqual(["issue_commented", "issue_comment_mentioned"]);
  });

  it("wakes the dependent and the parent like a board PATCH to done", async () => {
    const existing = makeIssue({ parentId: PARENT_ID });
    const arrange = () => {
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
      mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
        { id: DEPENDENT_ID, assigneeAgentId: DEPENDENT_AGENT_ID, blockerIssueIds: [ISSUE_ID], blockedTransitionAt: null },
      ]);
      mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
        id: PARENT_ID,
        assigneeAgentId: PARENT_AGENT_ID,
        childIssueIds: [ISSUE_ID],
        childIssueSummaries: [{ id: ISSUE_ID, identifier: "PAP-999", title: "Parity test", status: "done" }],
        childIssueSummaryTruncated: false,
      });
    };

    arrange();
    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });
    expect(res.status).toBe(200);
    const routeWakes = await settledWakeCalls(2);

    resetMocks();
    arrange();
    const outcome = await runVoiceAction({
      action: "issue_status",
      issueId: ISSUE_ID,
      identifier: "PAP-999",
      status: "done",
      source: "grok",
      ...snapshotOf(existing),
    });
    expect(outcome).toContain("✅");
    expect(wakeCalls()).toEqual(routeWakes);
    expect(routeWakes.map((call) => call.wakeup.reason)).toEqual(["issue_blockers_resolved", "issue_children_completed"]);
  });

  it("keeps the last wake like PATCH when the parent is also the dependent", async () => {
    const existing = makeIssue({ parentId: PARENT_ID });
    const arrange = () => {
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
      mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
        { id: PARENT_ID, assigneeAgentId: PARENT_AGENT_ID, blockerIssueIds: [ISSUE_ID], blockedTransitionAt: null },
      ]);
      mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
        id: PARENT_ID,
        assigneeAgentId: PARENT_AGENT_ID,
        childIssueIds: [ISSUE_ID],
        childIssueSummaries: [],
        childIssueSummaryTruncated: false,
      });
    };

    arrange();
    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });
    expect(res.status).toBe(200);
    const routeWakes = await settledWakeCalls(1);

    resetMocks();
    arrange();
    const outcome = await runVoiceAction({
      action: "issue_status",
      issueId: ISSUE_ID,
      identifier: "PAP-999",
      status: "done",
      source: "grok",
      ...snapshotOf(existing),
    });
    expect(outcome).toContain("✅");
    expect(wakeCalls()).toEqual(routeWakes);
  });

  it.each(["blocked", "backlog"])("wakes the assignee like a board PATCH from %s to todo", async (fromStatus) => {
    const existing = makeIssue({ status: fromStatus });
    const arrange = () => {
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue({ ...existing, status: "todo" });
    };

    arrange();
    const res = await request(await createApp()).patch(`/api/issues/${ISSUE_ID}`).send({ status: "todo" });
    expect(res.status).toBe(200);
    const routeWakes = await settledWakeCalls(1);

    resetMocks();
    arrange();
    const outcome = await runVoiceAction({
      action: "issue_status",
      issueId: ISSUE_ID,
      identifier: "PAP-999",
      status: "todo",
      source: "grok",
      ...snapshotOf(existing),
    });
    expect(outcome).toContain("✅");
    expect(wakeCalls()).toEqual(routeWakes);
    expect(routeWakes[0]?.wakeup.reason).toBe("issue_status_changed");
  });

  it("refuses a comment that the comment route would turn into a reopen", async () => {
    const existing = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(existing);

    const outcome = await runVoiceAction({
      action: "issue_comment",
      issueId: ISSUE_ID,
      identifier: "PAP-999",
      body: "Vielä yksi asia",
      source: "grok",
      ...snapshotOf(existing),
    });

    expect(outcome).toContain("would reopen the done issue");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
