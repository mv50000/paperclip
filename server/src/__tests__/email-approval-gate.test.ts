// RK9-82: agent-initiated outbound email on a gated route is parked behind an
// `email_send` approval; the server dispatches the stored payload on approve.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendEmail = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, messageId: "out-1", providerMessageId: "em_1" })),
);
const mockReplyToMessage = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, messageId: "out-2", providerMessageId: "em_2" })),
);
vi.mock("../services/email/index.js", () => ({
  createEmailService: vi.fn(() => ({
    sendEmail: mockSendEmail,
    replyToMessage: mockReplyToMessage,
  })),
}));

const mockApprovalCreate = vi.hoisted(() =>
  vi.fn(async (_companyId: string, input: Record<string, unknown>) => ({
    id: "approval-1",
    companyId: "company-1",
    ...input,
  })),
);
const mockApprovalSvc = vi.hoisted(() => ({
  create: mockApprovalCreate,
  getById: vi.fn(),
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(async () => ({ id: "comment-1" })),
  listComments: vi.fn(async () => []),
}));
const mockLinkMany = vi.hoisted(() => vi.fn(async () => undefined));
const mockListIssuesForApproval = vi.hoisted(() => vi.fn(async () => [{ id: "issue-1" }]));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockWakeup = vi.hoisted(() => vi.fn(async () => ({ id: "run-9" })));

vi.mock("../services/index.js", () => ({
  approvalService: vi.fn(() => mockApprovalSvc),
  issueApprovalService: vi.fn(() => ({
    linkManyForApproval: mockLinkMany,
    listIssuesForApproval: mockListIssuesForApproval,
  })),
  heartbeatService: vi.fn(() => ({ wakeup: mockWakeup })),
  secretService: vi.fn(() => ({
    normalizeHireApprovalPayloadForPersistence: vi.fn(async (_c: string, p: unknown) => p),
  })),
  logActivity: mockLogActivity,
}));

const inboundParent = {
  id: "email-message-1",
  companyId: "company-1",
  direction: "inbound",
  fromAddress: "customer@example.com",
  subject: "Need help",
  routeKey: "tuki",
  assignedAgentId: "agent-1",
  issueId: "issue-1",
};

const gatedRoute = {
  id: "route-1",
  companyId: "company-1",
  localPart: "tuki",
  domain: "sunspot.fi",
  routeKey: "tuki",
  approvalRequired: true,
};

/** Queue-based fake db: each select resolves the next queued result. */
function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const inserts: Array<{ values: Record<string, unknown> }> = [];
  const makeChain = () => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => void) => resolve(rows);
    return chain;
  };
  return {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => {
        inserts.push({ values: v });
        return Promise.resolve(undefined);
      },
    })),
    update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
    __inserts: inserts,
  };
}

async function createApp(db: unknown, actor: Record<string, unknown>) {
  const { emailRoutes } = await import("../routes/email.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", emailRoutes(db as never));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

const agentActor = { type: "agent", companyId: "company-1", agentId: "agent-1", runId: "run-1" };

describe("email send approval gate (agent actor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parks a reply on a gated route behind an email_send approval", async () => {
    const db = makeDb([[inboundParent], [gatedRoute]]);
    const app = await createApp(db, agentActor);

    const res = await request(app)
      .post("/api/companies/company-1/email/reply")
      .send({ inReplyToMessageId: "email-message-1", bodyMarkdown: "Hei! Autan mielelläni." });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "pending_approval", approvalId: "approval-1" });
    expect(mockReplyToMessage).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();

    const [, createInput] = mockApprovalCreate.mock.calls[0];
    expect(createInput).toMatchObject({
      type: "email_send",
      requestedByAgentId: "agent-1",
      payload: expect.objectContaining({
        kind: "reply",
        routeKey: "tuki",
        to: ["customer@example.com"],
        subject: "Re: Need help",
        bodyMarkdown: "Hei! Autan mielelläni.",
        inReplyToMessageId: "email-message-1",
      }),
    });
    expect(mockLinkMany).toHaveBeenCalledWith("approval-1", ["issue-1"], expect.anything());
    // Audit trail: pending_approval row written.
    const audit = (db.__inserts as Array<{ values: Record<string, unknown> }>).find(
      (i) => i.values.status === "pending_approval",
    );
    expect(audit?.values.fromAddress).toBe("tuki@sunspot.fi");
  });

  it("lets a reply through when the route is not gated", async () => {
    const db = makeDb([[inboundParent], [{ ...gatedRoute, approvalRequired: false }]]);
    const app = await createApp(db, agentActor);

    const res = await request(app)
      .post("/api/companies/company-1/email/reply")
      .send({ inReplyToMessageId: "email-message-1", bodyMarkdown: "Suoraan." });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ messageId: "out-2", providerMessageId: "em_2" });
    expect(mockReplyToMessage).toHaveBeenCalledTimes(1);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  it("404s a reply draft whose parent does not exist", async () => {
    const db = makeDb([[]]);
    const app = await createApp(db, agentActor);
    const res = await request(app)
      .post("/api/companies/company-1/email/reply")
      .send({ inReplyToMessageId: "missing", bodyMarkdown: "x" });
    expect(res.status).toBe(404);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });

  it("parks a direct send on a gated route", async () => {
    const db = makeDb([[gatedRoute]]);
    const app = await createApp(db, agentActor);

    const res = await request(app)
      .post("/api/companies/company-1/email/send")
      .send({ routeKey: "tuki", to: ["customer@example.com"], subject: "Hei", bodyMarkdown: "Moi" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does not gate board/user sends", async () => {
    const db = makeDb([]);
    const app = await createApp(db, { type: "user", userId: "board-user", companyId: "company-1" });

    const res = await request(app)
      .post("/api/companies/company-1/email/send")
      .send({ routeKey: "tuki", to: ["customer@example.com"], subject: "Hei", bodyMarkdown: "Moi" });

    expect(res.status).toBe(202);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockApprovalCreate).not.toHaveBeenCalled();
  });
});

describe("approve dispatches the stored email_send payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const emailSendApproval = {
    id: "approval-1",
    companyId: "company-1",
    type: "email_send",
    status: "approved",
    requestedByAgentId: "agent-1",
    decisionNote: null,
    payload: {
      kind: "reply",
      routeKey: "tuki",
      to: ["customer@example.com"],
      subject: "Re: Need help",
      bodyMarkdown: "Hei! Tässä vastaus.",
      inReplyToMessageId: "email-message-1",
      agentId: "agent-1",
    },
  };

  async function createApprovalsApp(actor: Record<string, unknown>) {
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

  const boardActor = { type: "board", source: "local_implicit", userId: "board-user" };

  it("sends the draft server-side and wakes the requester on approve", async () => {
    mockApprovalSvc.getById.mockResolvedValue(emailSendApproval);
    mockApprovalSvc.approve.mockResolvedValue({ approval: emailSendApproval, applied: true });
    const app = await createApprovalsApp(boardActor);

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockReplyToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        inReplyToMessageId: "email-message-1",
        bodyMarkdown: "Hei! Tässä vastaus.",
      }),
    );
    // Outcome comment lands before the requester wakeup fires.
    expect(mockApprovalSvc.addComment).toHaveBeenCalled();
    expect(mockWakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({ reason: "approval_approved" }));
  });

  it("comments the failure instead of dropping it when dispatch fails", async () => {
    mockApprovalSvc.getById.mockResolvedValue(emailSendApproval);
    mockApprovalSvc.approve.mockResolvedValue({ approval: emailSendApproval, applied: true });
    mockReplyToMessage.mockResolvedValueOnce({ ok: false, reason: "rate_limit" } as never);
    const app = await createApprovalsApp(boardActor);

    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    const commentBody = String(mockApprovalSvc.addComment.mock.calls[0][1]);
    expect(commentBody).toContain("rate_limit");
  });

  it("wakes the requester with the decision note on reject", async () => {
    const rejected = { ...emailSendApproval, status: "rejected", decisionNote: "Sävy uusiksi" };
    mockApprovalSvc.getById.mockResolvedValue(rejected);
    mockApprovalSvc.reject.mockResolvedValue({ approval: rejected, applied: true });
    const app = await createApprovalsApp(boardActor);

    const res = await request(app)
      .post("/api/approvals/approval-1/reject")
      .send({ decisionNote: "Sävy uusiksi" });

    expect(res.status).toBe(200);
    expect(mockReplyToMessage).not.toHaveBeenCalled();
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "approval_rejected",
        payload: expect.objectContaining({ decisionNote: "Sävy uusiksi" }),
      }),
    );
  });

  it("wakes the requester on request-revision", async () => {
    const revision = { ...emailSendApproval, status: "revision_requested", decisionNote: "Lisää yksityiskohtia" };
    mockApprovalSvc.getById.mockResolvedValue(revision);
    mockApprovalSvc.requestRevision.mockResolvedValue(revision);
    const app = await createApprovalsApp(boardActor);

    const res = await request(app)
      .post("/api/approvals/approval-1/request-revision")
      .send({ decisionNote: "Lisää yksityiskohtia" });

    expect(res.status).toBe(200);
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ reason: "approval_revision_requested" }),
    );
  });
});
