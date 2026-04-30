import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendEmail = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  messageId: "outbound-message-1",
  providerMessageId: "em_123",
})));

vi.mock("../services/email/index.js", () => ({
  createEmailService: vi.fn(() => ({
    sendEmail: mockSendEmail,
    replyToMessage: vi.fn(),
  })),
}));

function makeInboundMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "email-message-1",
    companyId: "company-1",
    direction: "inbound",
    providerMessageId: "em_inbound_1",
    fromAddress: "customer@example.com",
    toAddresses: ["support@example.test"],
    ccAddresses: [],
    subject: "Need help",
    bodyText: "Body",
    attachments: [],
    headers: {},
    routeKey: "support",
    assignedAgentId: "agent-1",
    issueId: "issue-1",
    status: "received",
    receivedAt: new Date("2026-04-30T10:00:00Z"),
    sentAt: null,
    escalatedAt: null,
    autoRepliedAt: null,
    createdAt: new Date("2026-04-30T10:00:00Z"),
    ...overrides,
  };
}

function makeDb(row: Record<string, unknown> | null) {
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(async () => (row ? [row] : [])),
  };
  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  return {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({ set: updateSet })),
    __updateSet: updateSet,
    __updateWhere: updateWhere,
  };
}

async function createApp(db: ReturnType<typeof makeDb>, actor: Record<string, unknown>) {
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

describe("email routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets the assigned agent escalate an inbound email to the CEO", async () => {
    const db = makeDb(makeInboundMessage());
    const app = await createApp(db, {
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    await request(app)
      .post("/api/companies/company-1/email/escalate")
      .send({ messageId: "email-message-1", reason: "Refund approval required" })
      .expect(202)
      .expect((res) => {
        expect(res.body).toMatchObject({
          messageId: "outbound-message-1",
          providerMessageId: "em_123",
          escalatedMessageId: "email-message-1",
        });
      });

    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      routeKey: "support",
      to: [expect.any(String)],
      subject: "[Eskalaatio] Need help",
      inReplyToMessageId: "email-message-1",
      templateKey: "system.escalation.manual",
    }));
    expect(db.__updateSet).toHaveBeenCalledWith({ escalatedAt: expect.any(Date) });
  });

  it("rejects escalation from an agent that does not own the inbound email", async () => {
    const db = makeDb(makeInboundMessage({ assignedAgentId: "agent-2" }));
    const app = await createApp(db, {
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
    });

    await request(app)
      .post("/api/companies/company-1/email/escalate")
      .send({ messageId: "email-message-1", reason: "Need help" })
      .expect(403);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does not allow customer CC on CEO escalations", async () => {
    const db = makeDb(makeInboundMessage());
    const app = await createApp(db, {
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
    });

    await request(app)
      .post("/api/companies/company-1/email/escalate")
      .send({ messageId: "email-message-1", reason: "Need help", ccCustomer: true })
      .expect(422);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
