// RK9-479: a `voice_action` approval carries a voice-proposed issue action; the
// server executes the stored payload on approve in the approver's name.
// RK9-490: it has the side effects of the same action in the UI, refuses a
// stale proposal, and refuses what the UI would do with a route-only step.
// voice-action-wake-parity.test.ts compares the wakes with the issue routes.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";

vi.mock("../services/email/index.js", () => ({
  createEmailService: vi.fn(() => ({ sendEmail: vi.fn(), replyToMessage: vi.fn() })),
}));

const mockApprovalSvc = vi.hoisted(() => ({
  create: vi.fn(async (_companyId: string, input: Record<string, unknown>) => ({
    id: "approval-1",
    companyId: "company-1",
    ...input,
  })),
  getById: vi.fn(),
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(async () => ({ id: "approval-comment-1" })),
  listComments: vi.fn(async () => []),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockWakeup = vi.hoisted(() => vi.fn(async () => ({ id: "run-9" })));

vi.mock("../services/index.js", () => ({
  accessService: vi.fn(() => ({
    decide: vi.fn(async (input: { action: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_board",
      explanation: "test",
    })),
  })),
  approvalService: vi.fn(() => mockApprovalSvc),
  issueApprovalService: vi.fn(() => ({
    linkManyForApproval: vi.fn(async () => undefined),
    listIssuesForApproval: vi.fn(async () => []),
  })),
  heartbeatService: vi.fn(() => ({ wakeup: mockWakeup })),
  secretService: vi.fn(() => ({
    normalizeHireApprovalPayloadForPersistence: vi.fn(async (_c: string, p: unknown) => p),
  })),
  logActivity: mockLogActivity,
}));

const mockIssuesSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  addComment: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listReviewAttention: vi.fn(),
}));
vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => mockIssuesSvc),
  executeIssuePostCommitActions: vi.fn(async () => undefined),
}));

// The real helpers live in routes/issues.ts, which this route test does not
// load; the parity test runs them for real.
const mockIssueRouteHelpers = vi.hoisted(() => ({
  isApprovalReviewComment: vi.fn(() => false),
  shouldImplicitlyMoveCommentedIssueToTodo: vi.fn(() => false),
}));
vi.mock("../routes/issues.js", () => mockIssueRouteHelpers);

// Rows the status path reads from the activity log (the run handoff state).
const mockActivityRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockDeps = vi.hoisted(() => {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    then: (resolve: (rows: unknown[]) => unknown) => resolve(mockActivityRows.rows),
  };
  return {
  db: {
    select: () => query,
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  },
  heartbeat: {
    wakeup: vi.fn(async () => ({ id: "run-9" })),
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
  },
  runnerGoals: { projection: vi.fn() },
  recoveryActions: { getActiveForIssue: vi.fn() },
  treeControl: { getActivePauseHoldGate: vi.fn() },
  executionWorkspaces: { getById: vi.fn() },
  interactions: {
    expireRequestConfirmationsSupersededByComment: vi.fn(),
    expirePendingInteractionsForTerminalIssue: vi.fn(),
  },
  issueReferences: { syncComment: vi.fn() },
  externalObjects: { syncCommentSafely: vi.fn() },
  routines: { syncRunStatusForIssue: vi.fn() },
  environmentRuntime: { destroyReusableSandboxLeases: vi.fn() },
  taskWatchdogs: { reconcileForIssueAndAncestors: vi.fn() },
  markBlockedOwnerNotified: vi.fn(),
  };
});
vi.mock("../services/rk9-voice-action-deps.js", () => ({
  createVoiceActionDeps: vi.fn(() => ({ ...mockDeps, issuesSvc: mockIssuesSvc })),
}));
vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return { ...actual, findExistingIssueBlockersResolvedWakeForReadyState: vi.fn(async () => null) };
});

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const issue = {
  id: ISSUE_ID,
  companyId: "company-1",
  identifier: "RK9-469",
  title: "Grok connector",
  status: "in_progress",
  assigneeAgentId: null as string | null,
  parentId: null as string | null,
  executionWorkspaceId: null as string | null,
  executionRunId: null as string | null,
};

const commentPayload = {
  action: "issue_comment",
  issueId: ISSUE_ID,
  identifier: "RK9-469",
  body: "Testattu autossa",
  source: "grok",
  issueStatusAtProposal: "in_progress",
  assigneeAgentIdAtProposal: null,
};
const statusPayload = {
  action: "issue_status",
  issueId: ISSUE_ID,
  identifier: "RK9-469",
  status: "done",
  source: "grok",
  issueStatusAtProposal: "in_progress",
  assigneeAgentIdAtProposal: null,
};
const assignedIssue = { ...issue, assigneeAgentId: AGENT_ID };
const assignedSnapshot = { assigneeAgentIdAtProposal: AGENT_ID };

function voiceApproval(payload: Record<string, unknown>, status = "approved") {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "voice_action",
    status,
    requestedByAgentId: null,
    requestedByUserId: "board-user",
    decisionNote: null,
    payload,
  };
}

const boardActor = { type: "board", source: "local_implicit", userId: "board-user" };

async function createApp(actor: Record<string, unknown> = boardActor) {
  const { approvalRoutes } = await import("../routes/approvals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", approvalRoutes({} as never));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

function approve(payload: Record<string, unknown>) {
  const approval = voiceApproval(payload);
  mockApprovalSvc.getById.mockResolvedValue(approval);
  mockApprovalSvc.approve.mockResolvedValue({ approval, applied: true });
}

async function approveAndRun(payload: Record<string, unknown>) {
  approve(payload);
  const res = await request(await createApp()).post("/api/approvals/approval-1/approve").send({});
  expect(res.status).toBe(200);
}

function approvalComment() {
  return String(mockApprovalSvc.addComment.mock.calls[0]?.[1] ?? "");
}

function activityActions() {
  return mockLogActivity.mock.calls.map((call) => (call as unknown as [unknown, { action: string }])[1].action);
}

function wakeReasons() {
  return (mockDeps.heartbeat.wakeup.mock.calls as unknown as Array<[string, { reason: string }]>).map(
    ([agentId, wakeup]) => `${agentId}:${wakeup.reason}`,
  );
}

describe("voice_action approve executes the stored payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssuesSvc.getById.mockResolvedValue(issue);
    // The locked re-read sees the same row as the first read unless a case says otherwise.
    mockIssuesSvc.getByIdForUpdate.mockImplementation(async () => mockIssuesSvc.getById());
    mockActivityRows.rows = [];
    mockIssuesSvc.addComment.mockResolvedValue({ id: "issue-comment-1", body: "Testattu autossa", createdByRunId: null });
    mockIssuesSvc.update.mockResolvedValue({ ...issue, status: "done" });
    mockIssuesSvc.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssuesSvc.findMentionedAgents.mockResolvedValue([]);
    mockIssuesSvc.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssuesSvc.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssuesSvc.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssuesSvc.listReviewAttention.mockResolvedValue(new Map());
    mockIssueRouteHelpers.isApprovalReviewComment.mockReturnValue(false);
    mockIssueRouteHelpers.shouldImplicitlyMoveCommentedIssueToTodo.mockReturnValue(false);
    mockDeps.heartbeat.getRun.mockResolvedValue(null);
    mockDeps.heartbeat.getActiveRunForAgent.mockResolvedValue(null);
    mockDeps.runnerGoals.projection.mockResolvedValue(null);
    mockDeps.recoveryActions.getActiveForIssue.mockResolvedValue(null);
    mockDeps.treeControl.getActivePauseHoldGate.mockResolvedValue(null);
    mockDeps.executionWorkspaces.getById.mockResolvedValue(null);
    mockDeps.interactions.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockDeps.interactions.expirePendingInteractionsForTerminalIssue.mockResolvedValue([]);
    mockDeps.issueReferences.syncComment.mockResolvedValue(undefined);
    mockDeps.externalObjects.syncCommentSafely.mockResolvedValue(undefined);
    mockDeps.routines.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockDeps.environmentRuntime.destroyReusableSandboxLeases.mockResolvedValue(undefined);
    mockDeps.taskWatchdogs.reconcileForIssueAndAncestors.mockResolvedValue(undefined);
  });

  it("posts the comment on the issue in the approver's name", async () => {
    await approveAndRun(commentPayload);

    expect(mockIssuesSvc.addComment).toHaveBeenCalledWith(ISSUE_ID, "Testattu autossa", { userId: "board-user" });
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(mockDeps.issueReferences.syncComment).toHaveBeenCalledWith("issue-comment-1");
    expect(approvalComment()).toContain("✅");
    expect(activityActions()).toEqual(
      expect.arrayContaining(["issue.comment_added", "voice_action.executed", "approval.approved"]),
    );
  });

  it("wakes the assignee and the mentioned agents once each", async () => {
    mockIssuesSvc.getById.mockResolvedValue(assignedIssue);
    mockIssuesSvc.findMentionedAgents.mockResolvedValue([AGENT_ID, "agent-9"]);
    await approveAndRun({ ...commentPayload, ...assignedSnapshot });

    // The assignee is also mentioned; the first wake (issue_commented) wins.
    expect(wakeReasons()).toEqual([`${AGENT_ID}:issue_commented`, "agent-9:issue_comment_mentioned"]);
    expect(mockDeps.heartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        payload: expect.objectContaining({ issueId: ISSUE_ID, commentId: "issue-comment-1", mutation: "comment" }),
      }),
    );
  });

  it("changes the issue status under a company guard", async () => {
    await approveAndRun(statusPayload);

    expect(mockIssuesSvc.update).toHaveBeenCalledWith(
      ISSUE_ID,
      { status: "done", actorUserId: "board-user", companyGuard: "company-1" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(mockDeps.routines.syncRunStatusForIssue).toHaveBeenCalledWith(ISSUE_ID);
    expect(mockDeps.interactions.expirePendingInteractionsForTerminalIssue).toHaveBeenCalled();
    expect(mockDeps.environmentRuntime.destroyReusableSandboxLeases).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE_ID, failureReason: "issue_terminal_done" }),
    );
    expect(approvalComment()).toContain("in_progress → done");
    expect(activityActions()).toEqual(expect.arrayContaining(["issue.updated", "voice_action.executed"]));
  });

  it("wakes the assignee when a backlog issue moves to todo", async () => {
    const backlog = { ...assignedIssue, status: "backlog" };
    mockIssuesSvc.getById.mockResolvedValue(backlog);
    mockIssuesSvc.update.mockResolvedValue({ ...backlog, status: "todo" });
    await approveAndRun({ ...statusPayload, status: "todo", issueStatusAtProposal: "backlog", ...assignedSnapshot });

    expect(wakeReasons()).toEqual([`${AGENT_ID}:issue_status_changed`]);
  });

  it.each([
    [
      "the assignee has an active goal",
      () => mockDeps.runnerGoals.projection.mockResolvedValue({ goal: { status: "active" }, pendingAction: null }),
      "done",
    ],
    [
      "the assignee has an active goal",
      () => mockDeps.runnerGoals.projection.mockResolvedValue({ goal: null, pendingAction: { id: "action-1" } }),
      "cancelled",
    ],
    [
      "an agent run is active",
      () =>
        mockDeps.heartbeat.getActiveRunForAgent.mockResolvedValue({
          id: "run-1",
          status: "running",
          contextSnapshot: { issueId: ISSUE_ID },
        }),
      "done",
    ],
    [
      "active recovery action",
      () => mockDeps.recoveryActions.getActiveForIssue.mockResolvedValue({ id: "recovery-1" }),
      "todo",
    ],
  ])("refuses the status change when %s (%s)", async (reason, arrange, status) => {
    mockIssuesSvc.getById.mockResolvedValue(assignedIssue);
    arrange();
    await approveAndRun({ ...statusPayload, status, ...assignedSnapshot });

    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(mockDeps.heartbeat.wakeup).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
    expect(activityActions()).toContain("voice_action.failed");
  });

  it("closes the issue when the assignee's goal is complete and its run is on another issue", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...assignedIssue, executionRunId: "run-old" });
    mockDeps.runnerGoals.projection.mockResolvedValue({ goal: { status: "complete" }, pendingAction: null });
    mockDeps.heartbeat.getRun.mockResolvedValue({ id: "run-old", status: "succeeded" });
    mockDeps.heartbeat.getActiveRunForAgent.mockResolvedValue({
      id: "run-2",
      status: "running",
      contextSnapshot: { issueId: "other-issue" },
    });
    await approveAndRun({ ...statusPayload, ...assignedSnapshot });

    expect(mockIssuesSvc.update).toHaveBeenCalled();
    expect(approvalComment()).toContain("✅");
  });

  it.each([
    ["the parent issue may get a stop report", "cancelled", { parentId: "parent-1" }],
    ["skill test issues", "done", { harnessKind: "skill_test" }],
  ])("refuses a status change that needs a route-only step: %s", async (reason, status, extra) => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, ...extra });
    await approveAndRun({ ...statusPayload, status });

    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
  });

  it("wakes the dependents and the parent when the issue is done", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, parentId: "parent-1" });
    mockIssuesSvc.update.mockResolvedValue({ ...issue, parentId: "parent-1", status: "done" });
    mockIssuesSvc.listWakeableBlockedDependents.mockResolvedValue([
      { id: "dependent-1", assigneeAgentId: "agent-2", blockerIssueIds: [ISSUE_ID], blockedTransitionAt: null },
    ]);
    mockIssuesSvc.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-3",
      childIssueIds: [ISSUE_ID],
      childIssueSummaries: [],
      childIssueSummaryTruncated: false,
    });
    await approveAndRun(statusPayload);

    expect(wakeReasons()).toEqual(["agent-2:issue_blockers_resolved", "agent-3:issue_children_completed"]);
  });

  it("reports the status change done when a side effect fails after the write", async () => {
    mockDeps.routines.syncRunStatusForIssue.mockRejectedValue(new Error("routine sync failed"));
    await approveAndRun(statusPayload);

    expect(approvalComment()).toContain("✅");
    expect(approvalComment()).toContain("sivuvaikutukset epäonnistuivat");
    expect(approvalComment()).not.toContain("routine sync failed");
    const executed = mockLogActivity.mock.calls
      .map((call) => (call as unknown as [unknown, { action: string; details: Record<string, unknown> }])[1])
      .find((entry) => entry.action === "voice_action.executed");
    expect(executed?.details).toEqual(expect.objectContaining({ failedSteps: ["routine_sync"] }));
  });

  it.each([
    ["the issue tree is paused", () => mockDeps.treeControl.getActivePauseHoldGate.mockResolvedValue({ holdId: "hold-1" }), "Task is paused"],
    [
      "the comment would reopen the issue",
      () => mockIssueRouteHelpers.shouldImplicitlyMoveCommentedIssueToTodo.mockReturnValue(true),
      "would reopen",
    ],
    [
      "the comment would resume a scheduled retry",
      () => {
        mockIssuesSvc.getById.mockResolvedValue(assignedIssue);
        mockIssuesSvc.getCurrentScheduledRetry.mockResolvedValue({ agentId: AGENT_ID });
      },
      "scheduled retry",
    ],
    [
      "the issue workspace is closed",
      () => {
        mockIssuesSvc.getById.mockResolvedValue({ ...issue, executionWorkspaceId: "workspace-1" });
        mockDeps.executionWorkspaces.getById.mockResolvedValue({
          id: "workspace-1",
          mode: "isolated_workspace",
          status: "archived",
          closedAt: new Date(),
        });
      },
      "closed workspace",
    ],
  ])("refuses a comment when %s", async (_name, arrange, reason) => {
    arrange();
    // The proposal snapshot matches the issue the case arranged.
    const current = (await mockIssuesSvc.getById()) as typeof issue;
    mockIssuesSvc.getById.mockClear();
    await approveAndRun({ ...commentPayload, assigneeAgentIdAtProposal: current.assigneeAgentId });

    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(mockDeps.heartbeat.wakeup).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
  });

  it("allows a comment on a blocked issue that keeps an open blocker", async () => {
    mockIssueRouteHelpers.shouldImplicitlyMoveCommentedIssueToTodo.mockReturnValue(true);
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, status: "blocked" });
    mockIssuesSvc.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 1 });
    await approveAndRun({ ...commentPayload, issueStatusAtProposal: "blocked" });

    expect(mockIssuesSvc.addComment).toHaveBeenCalled();
    expect(approvalComment()).toContain("✅");
  });

  it("refuses a comment that would steer the assignee's live goal session", async () => {
    mockIssuesSvc.getById.mockResolvedValue(assignedIssue);
    mockDeps.runnerGoals.projection.mockResolvedValue({ goal: { status: "active" }, workingNow: true, pendingAction: null });
    await approveAndRun({ ...commentPayload, ...assignedSnapshot });

    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("live goal session");
  });

  it("comments and wakes when the assignee's goal is not working now", async () => {
    mockIssuesSvc.getById.mockResolvedValue(assignedIssue);
    mockDeps.runnerGoals.projection.mockResolvedValue({ goal: { status: "active" }, workingNow: false, pendingAction: null });
    await approveAndRun({ ...commentPayload, ...assignedSnapshot });

    expect(mockIssuesSvc.addComment).toHaveBeenCalled();
    expect(wakeReasons()).toEqual([`${AGENT_ID}:issue_commented`]);
  });

  it("refuses a comment while the issue has an active recovery action", async () => {
    mockDeps.recoveryActions.getActiveForIssue.mockResolvedValue({ id: "recovery-1" });
    await approveAndRun(commentPayload);

    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("active recovery action");
  });

  it("still wakes the assignee when the mention lookup fails", async () => {
    mockIssuesSvc.getById.mockResolvedValue(assignedIssue);
    mockIssuesSvc.findMentionedAgents.mockRejectedValue(new Error("mention lookup failed"));
    await approveAndRun({ ...commentPayload, ...assignedSnapshot });

    expect(wakeReasons()).toEqual([`${AGENT_ID}:issue_commented`]);
    expect(approvalComment()).toContain("sivuvaikutukset epäonnistuivat");
  });

  it("refuses cancelled while the issue's execution run is running, also without an assignee", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, executionRunId: "run-1" });
    mockDeps.heartbeat.getRun.mockResolvedValue({ id: "run-1", status: "running" });
    await approveAndRun({ ...statusPayload, status: "cancelled" });

    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("an agent run is active");
  });

  it.each([
    ["the issue moved to review", { status: "in_review" }, "status changed after the proposal (in_progress → in_review)"],
    ["an execution policy was set", { executionPolicy: { stages: [] } }, "execution policy"],
    ["the issue moved to another company", { companyId: "company-2" }, "issue not found in this company"],
  ])("re-checks the locked row before the write: %s", async (_name, change, reason) => {
    mockIssuesSvc.getByIdForUpdate.mockResolvedValue({ ...issue, ...change });
    await approveAndRun(statusPayload);

    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(mockDeps.routines.syncRunStatusForIssue).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
  });

  it("writes the status inside the locking transaction", async () => {
    await approveAndRun(statusPayload);

    expect(mockIssuesSvc.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
      {},
      [],
      [],
    );
    expect(mockDeps.taskWatchdogs.reconcileForIssueAndAncestors).toHaveBeenCalledWith("company-1", ISSUE_ID, {
      runId: null,
    });
  });

  it("lets the parent wake win when the parent is also the dependent, as PATCH does", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, parentId: "parent-1" });
    mockIssuesSvc.update.mockResolvedValue({ ...issue, parentId: "parent-1", status: "done" });
    mockIssuesSvc.listWakeableBlockedDependents.mockResolvedValue([
      { id: "parent-1", assigneeAgentId: "agent-3", blockerIssueIds: [ISSUE_ID], blockedTransitionAt: null },
    ]);
    mockIssuesSvc.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-3",
      childIssueIds: [ISSUE_ID],
      childIssueSummaries: [],
      childIssueSummaryTruncated: false,
    });
    await approveAndRun(statusPayload);

    expect(wakeReasons()).toEqual(["agent-3:issue_children_completed"]);
  });

  it("logs the dependency wake for the rewake throttle", async () => {
    mockIssuesSvc.listWakeableBlockedDependents.mockResolvedValue([
      { id: "dependent-1", assigneeAgentId: "agent-2", blockerIssueIds: [ISSUE_ID], blockedTransitionAt: null },
    ]);
    await approveAndRun(statusPayload);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.blockers_resolved_wake_emitted",
        actorType: "system",
        actorId: "issue_update",
        entityId: "dependent-1",
        details: expect.objectContaining({ wakeupRunId: "run-9", resolvedBlockerIssueId: ISSUE_ID }),
      }),
    );
  });

  it("resolves a required run handoff when the issue leaves in_progress", async () => {
    mockActivityRows.rows = [
      { action: "issue.successful_run_handoff_required", runId: "run-1", details: { sourceRunId: "run-1" } },
    ];
    await approveAndRun(statusPayload);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.successful_run_handoff_resolved",
        details: expect.objectContaining({ sourceRunId: "run-1", resolvedByStatus: "done" }),
      }),
    );
  });

  it.each([
    ["the status changed", { status: "todo" }, "status changed after the proposal (in_progress → todo)"],
    ["the assignee changed", { assigneeAgentId: AGENT_ID }, "assignee changed after the proposal"],
  ])("refuses a stale proposal when %s", async (_name, change, reason) => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, ...change });
    await approveAndRun(statusPayload);

    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
  });

  it("refuses a stale comment proposal too", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, status: "done" });
    await approveAndRun(commentPayload);

    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("status changed after the proposal");
  });

  it("refuses a proposal stored before the issue snapshot existed", async () => {
    const { issueStatusAtProposal: _status, assigneeAgentIdAtProposal: _assignee, ...legacy } = statusPayload;
    await approveAndRun(legacy);

    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("no issue snapshot");
  });

  it("refuses an issue that belongs to another company", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, companyId: "company-2" });
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("issue not found in this company");
    expect(activityActions()).toContain("voice_action.failed");
  });

  it("refuses when the identifier names a different issue than the issue id", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, identifier: "RK9-1" });
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("issue not found in this company");
  });

  it("comments an error when the issue no longer exists", async () => {
    mockIssuesSvc.getById.mockResolvedValue(null);
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("⚠️");
    expect(activityActions()).toContain("voice_action.failed");
  });

  it("keeps the approval and comments a rule error from the issue service", async () => {
    mockIssuesSvc.update.mockRejectedValue(unprocessable("Invalid status transition"));
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(approvalComment()).toContain("Invalid status transition");
    expect(activityActions()).toEqual(expect.arrayContaining(["voice_action.failed", "approval.approved"]));
  });

  it("keeps internal error text out of the approval comment", async () => {
    mockIssuesSvc.update.mockRejectedValue(new Error("relation \"issues\" deadlock detected"));
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(approvalComment()).not.toContain("deadlock");
    expect(approvalComment()).toContain("see server log");
  });

  it("executes a payload that the Slack forwarder extended with slackMessageRef", async () => {
    approve({ ...commentPayload, slackMessageRef: { channel: "C1", ts: "1.2" } });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).toHaveBeenCalledWith(ISSUE_ID, "Testattu autossa", { userId: "board-user" });
    expect(approvalComment()).toContain("✅");
  });

  it("refuses a comment on a conversation issue", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, conversationAgentId: "agent-9" });
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("conversation issues cannot change by voice");
  });

  it("still records the outcome when the issue activity write fails", async () => {
    mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(approvalComment()).toContain("✅");
    expect(activityActions()).toContain("voice_action.executed");
  });

  it("refuses blocked when the issue has no unresolved blocker", async () => {
    approve({ ...statusPayload, status: "blocked" });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("blocked requires an unresolved blocker");
  });

  it("sets blocked when the issue has an unresolved blocker", async () => {
    mockIssuesSvc.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 1 });
    mockIssuesSvc.update.mockResolvedValue({ ...issue, status: "blocked" });
    approve({ ...statusPayload, status: "blocked" });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "blocked" }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ["the issue has an execution policy", "done", { executionPolicy: { stages: [] } }],
    ["the issue has an execution policy", "todo", { executionState: { status: "pending" } }],
    ["the issue is in review", "done", { status: "in_review" }, { issueStatusAtProposal: "in_review" }],
    ["conversation issues cannot change by voice", "backlog", { conversationAgentId: "agent-9" }],
  ])("refuses the status change when %s (%s)", async (reason, status, extra, snapshot = {}) => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, ...extra });
    approve({ ...statusPayload, status, ...snapshot });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
  });

  it("does nothing to the issue on reject", async () => {
    const rejected = voiceApproval(commentPayload, "rejected");
    mockApprovalSvc.getById.mockResolvedValue(rejected);
    mockApprovalSvc.reject.mockResolvedValue({ approval: rejected, applied: true });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/reject").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.getById).not.toHaveBeenCalled();
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(mockApprovalSvc.addComment).not.toHaveBeenCalled();
  });

  it("does not execute twice when the approval was already decided", async () => {
    const approval = voiceApproval(commentPayload);
    mockApprovalSvc.getById.mockResolvedValue(approval);
    mockApprovalSvc.approve.mockResolvedValue({ approval, applied: false });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
  });
});

describe("voice_action payload is validated on create and resubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssuesSvc.getById.mockResolvedValue(issue);
  });

  it("stores the parsed proposal without extra keys", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({ type: "voice_action", payload: { ...statusPayload, summary: "Add a note to RK9-469" } });

    expect(res.status).toBe(201);
    expect(mockApprovalSvc.create).toHaveBeenCalledTimes(1);
    const stored = (mockApprovalSvc.create.mock.calls[0] as unknown as [string, { payload: Record<string, unknown> }])[1].payload;
    expect(stored).toEqual(statusPayload);
  });

  it("stores the issue state from the server, not from the proposal", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, status: "todo", assigneeAgentId: AGENT_ID });
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({
        type: "voice_action",
        payload: { ...commentPayload, issueStatusAtProposal: "done", assigneeAgentIdAtProposal: "not-a-uuid" },
      });

    expect(res.status).toBe(201);
    const stored = (mockApprovalSvc.create.mock.calls[0] as unknown as [string, { payload: Record<string, unknown> }])[1].payload;
    expect(stored).toEqual(
      expect.objectContaining({ issueStatusAtProposal: "todo", assigneeAgentIdAtProposal: AGENT_ID }),
    );
  });

  it.each([
    ["a comment without body", { ...commentPayload, body: undefined }],
    ["a status change without status", { ...statusPayload, status: undefined }],
    ["a status outside the allowlist", { ...statusPayload, status: "in_progress" }],
    ["a body over 1000 characters", { ...commentPayload, body: "x".repeat(1001) }],
    ["an unknown source", { ...commentPayload, source: "siri" }],
    ["a non-uuid issue id", { ...commentPayload, issueId: "RK9-469" }],
    [
      "a body the approval view would redact",
      // Built from parts so secret scanners do not flag a literal token.
      { ...commentPayload, body: `token ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "dGVzdC1zaWduYXR1cmUtdmFsdWU"].join(".")}` },
    ],
  ])("rejects %s", async (_name, payload) => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({ type: "voice_action", payload });

    expect(res.status).toBe(422);
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
  });

  it("refuses a voice_action proposal from an agent", async () => {
    const app = await createApp({ type: "agent", companyId: "company-1", agentId: "agent-1" });

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({ type: "voice_action", payload: commentPayload });

    expect(res.status).toBe(403);
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
  });

  it("rejects a proposal for another company's issue", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, companyId: "company-2" });
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/approvals")
      .send({ type: "voice_action", payload: commentPayload });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("issue not found in this company");
    expect(mockApprovalSvc.create).not.toHaveBeenCalled();
  });

  it("rejects a resubmitted payload for another company's issue", async () => {
    mockApprovalSvc.getById.mockResolvedValue(voiceApproval(commentPayload, "revision_requested"));
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, companyId: "company-2" });
    const app = await createApp();

    const res = await request(app)
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: commentPayload });

    expect(res.status).toBe(422);
    expect(mockApprovalSvc.resubmit).not.toHaveBeenCalled();
  });
});
