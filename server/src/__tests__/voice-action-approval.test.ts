// RK9-479: a `voice_action` approval carries a voice-proposed issue action; the
// server executes the stored payload on approve in the approver's name.
// RK9-490: it runs the issue routes' side effects and refuses a stale proposal.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conflict, unprocessable } from "../errors.js";

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
  addComment: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listReviewAttention: vi.fn(async () => new Map()),
}));
vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => mockIssuesSvc),
}));

const mockIssueEffects = vi.hoisted(() => ({
  commentRefusal: vi.fn(),
  statusChangeRefusal: vi.fn(),
  afterComment: vi.fn(),
  beforeStatusChange: vi.fn(),
  afterStatusChange: vi.fn(),
}));
const effectsSlot = vi.hoisted(() => ({ current: null as unknown }));

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const issue = {
  id: ISSUE_ID,
  companyId: "company-1",
  identifier: "RK9-469",
  title: "Grok connector",
  status: "in_progress",
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
  app.use("/api", approvalRoutes({} as never, { voiceActionIssueEffects: effectsSlot as never }));
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

function approvalComment() {
  return String(mockApprovalSvc.addComment.mock.calls[0]?.[1] ?? "");
}

function activityActions() {
  return mockLogActivity.mock.calls.map((call) => (call as unknown as [unknown, { action: string }])[1].action);
}

describe("voice_action approve executes the stored payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssuesSvc.getById.mockResolvedValue(issue);
    mockIssuesSvc.addComment.mockResolvedValue({ id: "issue-comment-1", body: "Testattu autossa" });
    mockIssuesSvc.update.mockResolvedValue({ ...issue, status: "done" });
    mockIssuesSvc.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    effectsSlot.current = mockIssueEffects;
    mockIssueEffects.commentRefusal.mockResolvedValue(null);
    mockIssueEffects.statusChangeRefusal.mockResolvedValue(null);
    mockIssueEffects.afterComment.mockResolvedValue(undefined);
    mockIssueEffects.beforeStatusChange.mockResolvedValue({ interruptedRunId: null, runToCancel: null });
    mockIssueEffects.afterStatusChange.mockResolvedValue({ cancelledStatusRunId: null, failedSteps: [] });
  });

  it("posts the comment on the issue in the approver's name", async () => {
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).toHaveBeenCalledWith(ISSUE_ID, "Testattu autossa", { userId: "board-user" });
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    // The comment wakes the assignee as a board comment would.
    expect(mockIssueEffects.afterComment).toHaveBeenCalledWith({
      issue,
      comment: expect.objectContaining({ id: "issue-comment-1" }),
      actor: expect.objectContaining({ actorType: "user", actorId: "board-user" }),
    });
    expect(approvalComment()).toContain("✅");
    expect(activityActions()).toEqual(
      expect.arrayContaining(["issue.comment_added", "voice_action.executed", "approval.approved"]),
    );
  });

  it("changes the issue status under a company guard", async () => {
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).toHaveBeenCalledWith(ISSUE_ID, {
      status: "done",
      actorUserId: "board-user",
      companyGuard: "company-1",
    });
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(mockIssueEffects.beforeStatusChange).toHaveBeenCalledWith(issue, "done");
    expect(mockIssueEffects.afterStatusChange).toHaveBeenCalledWith({
      existing: issue,
      updated: { ...issue, status: "done" },
      actor: expect.objectContaining({ actorType: "user", actorId: "board-user" }),
      interruptedRunId: null,
      runToCancel: null,
    });
    expect(mockIssueEffects.beforeStatusChange.mock.invocationCallOrder[0]).toBeLessThan(
      mockIssuesSvc.update.mock.invocationCallOrder[0]!,
    );
    expect(approvalComment()).toContain("in_progress → done");
    expect(activityActions()).toEqual(expect.arrayContaining(["issue.updated", "voice_action.executed"]));
  });

  it("stops the assignee's run like PATCH /issues/:id and records the stopped runs", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, status: "in_progress", executionRunId: "run-1" });
    mockIssuesSvc.update.mockResolvedValue({ ...issue, status: "cancelled" });
    mockIssueEffects.beforeStatusChange.mockResolvedValue({ interruptedRunId: "run-1", runToCancel: { id: "run-1" } });
    approve({ ...statusPayload, status: "cancelled" });
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "cancelled" }));
    expect(mockIssueEffects.afterStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ interruptedRunId: "run-1", runToCancel: { id: "run-1" } }),
    );
    const updatedActivity = mockLogActivity.mock.calls
      .map((call) => (call as unknown as [unknown, { action: string; details: Record<string, unknown> }])[1])
      .find((entry) => entry.action === "issue.updated");
    expect(updatedActivity?.details).toEqual(expect.objectContaining({ interruptedRunId: "run-1" }));
  });

  it("does not change the status when the runner goal cannot be stopped", async () => {
    mockIssueEffects.beforeStatusChange.mockRejectedValue(
      conflict("The current agent goal has a control action still in progress"),
    );
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("control action still in progress");
    expect(activityActions()).toContain("voice_action.failed");
  });

  it("reports the status change done when a side effect fails after the write", async () => {
    mockIssueEffects.afterStatusChange.mockRejectedValue(new Error("routine sync failed"));
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(approvalComment()).toContain("✅");
    expect(approvalComment()).toContain("sivuvaikutukset epäonnistuivat");
    expect(approvalComment()).not.toContain("routine sync failed");
  });

  it("names failed side effect steps after the write", async () => {
    mockIssueEffects.afterStatusChange.mockResolvedValue({ cancelledStatusRunId: null, failedSteps: ["routine_sync"] });
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(approvalComment()).toContain("✅");
    expect(approvalComment()).toContain("sivuvaikutukset epäonnistuivat");
  });

  it("refuses the write when the issue changed while the runner goal stopped", async () => {
    mockIssuesSvc.getById
      .mockResolvedValueOnce(issue)
      .mockResolvedValueOnce({ ...issue, status: "in_review" });
    mockIssueEffects.beforeStatusChange.mockResolvedValue({ interruptedRunId: "run-1", runToCancel: null });
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssueEffects.beforeStatusChange).toHaveBeenCalled();
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(mockIssueEffects.afterStatusChange).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("status changed after the proposal (in_progress → in_review)");
    expect(approvalComment()).toContain("run-1 was already stopped");
  });

  it("refuses a status change that needs a route-only step", async () => {
    mockIssueEffects.statusChangeRefusal.mockResolvedValue("skill test issues complete their test run; set done in Paperclip");
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssueEffects.beforeStatusChange).not.toHaveBeenCalled();
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("skill test issues");
  });

  it("refuses a comment while the issue tree is paused", async () => {
    mockIssueEffects.commentRefusal.mockResolvedValue("Task is paused. Resume it before sending a message.");
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(mockIssueEffects.afterComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("Task is paused");
  });

  it.each([
    ["the status changed", { status: "todo" }, "status changed after the proposal (in_progress → todo)"],
    ["the assignee changed", { assigneeAgentId: AGENT_ID }, "assignee changed after the proposal"],
  ])("refuses a stale proposal when %s", async (_name, change, reason) => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, ...change });
    approve(statusPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssueEffects.beforeStatusChange).not.toHaveBeenCalled();
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain(reason);
  });

  it("refuses a stale comment proposal too", async () => {
    mockIssuesSvc.getById.mockResolvedValue({ ...issue, status: "done" });
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("status changed after the proposal");
  });

  it("refuses a proposal stored before the issue snapshot existed", async () => {
    const { issueStatusAtProposal: _status, assigneeAgentIdAtProposal: _assignee, ...legacy } = statusPayload;
    approve(legacy);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.update).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("no issue snapshot");
  });

  it("refuses the action when the issue side effects are not wired", async () => {
    effectsSlot.current = null;
    approve(commentPayload);
    const app = await createApp();

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockIssuesSvc.addComment).not.toHaveBeenCalled();
    expect(approvalComment()).toContain("issue side effects are not available");
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
    expect(mockIssuesSvc.update).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({ status: "blocked" }));
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
