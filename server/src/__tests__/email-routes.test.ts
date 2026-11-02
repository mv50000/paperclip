import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// RK9-667: list route chain is select().from().where().orderBy().limit(); capture each stage so the
// tests can render the where clause to SQL and check the filters the route built.
function makeListDb(rows: Array<Record<string, unknown>>) {
  const captured: { where?: unknown; orderBy?: unknown[]; limit?: number; fields?: Record<string, unknown> } = {};
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn((w: unknown) => {
      captured.where = w;
      return chain;
    }),
    orderBy: vi.fn((...o: unknown[]) => {
      captured.orderBy = o;
      return chain;
    }),
    limit: vi.fn(async (n: number) => {
      captured.limit = n;
      return rows;
    }),
  };
  return {
    select: vi.fn((fields: Record<string, unknown>) => {
      captured.fields = fields;
      return chain;
    }),
    update: vi.fn(),
    __captured: captured,
  };
}

const dialect = new PgDialect();
const renderWhere = (db: ReturnType<typeof makeListDb>) => dialect.sqlToQuery(db.__captured.where as never);

const boardActor = { type: "board", userId: "user-1", source: "local_implicit", isInstanceAdmin: true };

async function createApp(db: ReturnType<typeof makeDb> | ReturnType<typeof makeListDb>, actor: Record<string, unknown>) {
  const { rk9EmailRoutes: emailRoutes } = await import("../routes/rk9-email.js");
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
  // The cold import of the route graph can take over 5 s on a loaded CI runner. Warm it here so the
  // first test's timeout covers only the request; a timed-out request would otherwise keep running
  // and call the send mock during the next test (RK9-314).
  beforeAll(async () => {
    await import("../routes/rk9-email.js");
  }, 60_000);

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

  describe("GET /companies/:companyId/email/messages (RK9-667)", () => {
    const row = {
      id: "email-message-1",
      direction: "inbound",
      fromAddress: "customer@example.com",
      toAddresses: ["support@example.test"],
      subject: "Need help",
      status: "received",
      classification: null,
      routeKey: "support",
      receivedAt: "2026-04-30T10:00:00.000Z",
      sentAt: null,
      createdAt: "2026-04-30T10:00:00.000Z",
      issueId: "issue-1",
      assignedAgentId: "agent-1",
    };

    it("lets a board actor list metadata only (no body)", async () => {
      const db = makeListDb([row]);
      const app = await createApp(db, boardActor);
      const res = await request(app).get("/api/companies/company-1/email/messages").expect(200);
      expect(res.body).toEqual([row]);
      expect(Object.keys(db.__captured.fields ?? {}).sort()).toEqual(
        [
          "assignedAgentId", "classification", "createdAt", "direction", "fromAddress", "id", "issueId",
          "receivedAt", "routeKey", "sentAt", "status", "subject", "toAddresses",
        ].sort(),
      );
      expect(db.__captured.limit).toBe(50);
      expect(db.__captured.orderBy).toHaveLength(2);
      const { sql: where, params } = renderWhere(db);
      expect(where).not.toContain("coalesce");
      expect(params).toEqual(["company-1"]);
    });

    it("rejects an agent actor", async () => {
      const db = makeListDb([row]);
      const app = await createApp(db, { type: "agent", companyId: "company-1", agentId: "agent-1" });
      await request(app).get("/api/companies/company-1/email/messages").expect(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it("filters by direction and since", async () => {
      const db = makeListDb([]);
      const app = await createApp(db, boardActor);
      await request(app)
        .get("/api/companies/company-1/email/messages")
        .query({ direction: "inbound", since: "2026-04-30T09:00:00Z", limit: "200" })
        .expect(200);
      const { sql: where, params } = renderWhere(db);
      expect(where).toContain("coalesce");
      expect(where).toContain("> $");
      expect(params).toEqual(["company-1", "inbound", "2026-04-30T09:00:00.000Z"]);
      expect(db.__captured.limit).toBe(200);
    });

    it.each([
      ["direction=sideways"],
      ["since=not-a-date"],
      ["since="],
      ["limit=0"],
      ["limit=201"],
      ["limit=abc"],
      ["limit=1.5"],
    ])("rejects invalid query %s", async (qs) => {
      const db = makeListDb([]);
      const app = await createApp(db, boardActor);
      await request(app).get(`/api/companies/company-1/email/messages?${qs}`).expect(422);
      expect(db.select).not.toHaveBeenCalled();
    });

    it("does not shadow the single-message route", async () => {
      const db = makeDb(makeInboundMessage());
      const app = await createApp(db, boardActor);
      const res = await request(app).get("/api/companies/company-1/email/messages/email-message-1").expect(200);
      expect(res.body).toMatchObject({ id: "email-message-1", bodyLength: 4 });
    });
  });
});
