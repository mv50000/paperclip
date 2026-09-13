import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOutreach = vi.hoisted(() => ({
  importProspects: vi.fn(),
  listProspects: vi.fn(),
  getProspect: vi.fn(),
  createProspect: vi.fn(),
  updateProspect: vi.fn(),
  deleteProspect: vi.fn(),
  listSequences: vi.fn(),
  getSequence: vi.fn(),
  createSequence: vi.fn(),
  updateSequence: vi.fn(),
  deleteSequence: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  createDraftMessage: vi.fn(),
  approveMessage: vi.fn(),
  rejectMessage: vi.fn(),
  listEvents: vi.fn(),
  recordEvent: vi.fn(),
  listOutreachSuppressions: vi.fn(),
  addOutreachSuppression: vi.fn(),
  findOutreachSuppressed: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/outreach/index.js", () => mockOutreach);
vi.mock("../services/index.js", () => ({ logActivity: mockLogActivity }));

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
};

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
  vi.resetModules();
  const [{ errorHandler }, { outreachRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/outreach.js") as Promise<typeof import("../routes/outreach.js")>,
  ]);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", outreachRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, build: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no tcp port");
    return await build(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

describe.sequential("outreach routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockOutreach)) mock.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("imports a 100-prospect JSON batch and reports rejected rows", async () => {
    const prospects = Array.from({ length: 100 }, (_, i) => ({
      orgName: `Org ${i}`,
      email: `Contact${i}@Example.fi`,
      source: "prh",
      businessId: "1234567-8",
    }));
    mockOutreach.importProspects.mockResolvedValue({
      imported: 97,
      rejected: [
        { index: 5, email: "contact5@example.fi", reason: "duplicate_existing" },
        { index: 9, email: "contact9@example.fi", reason: "suppressed" },
        { index: 42, email: "contact42@example.fi", reason: "duplicate_in_batch" },
      ],
      ids: [],
    });

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/prospects/import").send({ prospects }),
    );

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(97);
    expect(res.body.rejected).toHaveLength(3);
    const [, companyId, rows] = mockOutreach.importProspects.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(rows).toHaveLength(100);
    // Validator normalised the e-mail and filled the legal basis before the service saw it.
    expect(rows[0].email).toBe("contact0@example.fi");
    expect(rows[0].legalBasis).toBe("b2b_legitimate_interest");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "outreach.prospects.imported", companyId: "company-1" }),
    );
  });

  it("rejects an import that is missing source/legal fields with 400 and never touches the service", async () => {
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/outreach/prospects/import")
        .send({ prospects: [{ orgName: "X", email: "x@example.fi" }] }),
    );
    expect(res.status).toBe(400);
    expect(mockOutreach.importProspects).not.toHaveBeenCalled();
  });

  it("forbids an agent of another company", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-9", companyId: "company-2" });
    const res = await requestApp(app, (base) => request(base).get("/api/companies/company-1/outreach/prospects"));
    expect(res.status).toBe(403);
    expect(mockOutreach.listProspects).not.toHaveBeenCalled();
  });

  it("forbids viewer members from writing", async () => {
    const app = await createApp({
      ...BOARD_ACTOR,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    const res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/suppressions").send({ email: "a@b.fi" }),
    );
    expect(res.status).toBe(403);
    expect(mockOutreach.addOutreachSuppression).not.toHaveBeenCalled();
  });

  it("approve maps service verdicts to 404/409 and audits success", async () => {
    mockOutreach.approveMessage.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const app = await createApp();
    let res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/messages/11111111-1111-1111-1111-111111111111/approve").send({}),
    );
    expect(res.status).toBe(404);

    mockOutreach.approveMessage.mockResolvedValueOnce({ ok: false, reason: "prospect_not_contactable", status: "draft" });
    res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/messages/11111111-1111-1111-1111-111111111111/approve"),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("prospect_not_contactable");

    mockOutreach.approveMessage.mockResolvedValueOnce({ ok: true, message: { id: "m1", status: "approved" } });
    res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/messages/11111111-1111-1111-1111-111111111111/approve"),
    );
    expect(res.status).toBe(200);
    expect(mockOutreach.approveMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      "company-1",
      "11111111-1111-1111-1111-111111111111",
      "user-1",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "outreach.message.approved" }));
  });

  it("reject requires a reason", async () => {
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/messages/11111111-1111-1111-1111-111111111111/reject").send({}),
    );
    expect(res.status).toBe(400);
    expect(mockOutreach.rejectMessage).not.toHaveBeenCalled();
  });

  it("agents cannot write the global suppression list directly nor via opt-out events", async () => {
    const agent = { type: "agent", agentId: "agent-1", companyId: "company-1" };
    const app = await createApp(agent);
    let res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/suppressions").send({ email: "a@b.fi" }),
    );
    expect(res.status).toBe(403);
    expect(mockOutreach.addOutreachSuppression).not.toHaveBeenCalled();

    for (const type of ["unsubscribe", "complaint", "bounce_hard"]) {
      res = await requestApp(app, (base) =>
        request(base)
          .post("/api/companies/company-1/outreach/events")
          .send({ prospectId: "11111111-1111-1111-1111-111111111111", type }),
      );
      expect(res.status).toBe(403);
    }
    expect(mockOutreach.recordEvent).not.toHaveBeenCalled();

    // Informational events are fine for agents.
    mockOutreach.recordEvent.mockResolvedValue({
      ok: true,
      event: { id: "e1", type: "reply", prospectId: "11111111-1111-1111-1111-111111111111" },
      prospectStatus: "replied",
      suppressed: false,
    });
    res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/outreach/events")
        .send({ prospectId: "11111111-1111-1111-1111-111111111111", type: "reply" }),
    );
    expect(res.status).toBe(201);
  });

  it("board actors can record opt-out events", async () => {
    mockOutreach.recordEvent.mockResolvedValue({
      ok: true,
      event: { id: "e2", type: "unsubscribe", prospectId: "11111111-1111-1111-1111-111111111111" },
      prospectStatus: "unsubscribed",
      suppressed: true,
    });
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post("/api/companies/company-1/outreach/events")
        .send({ prospectId: "11111111-1111-1111-1111-111111111111", type: "unsubscribe" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.suppressed).toBe(true);
  });

  it("malformed path ids are 404, not 500", async () => {
    const app = await createApp();
    const res = await requestApp(app, (base) => request(base).get("/api/companies/company-1/outreach/prospects/not-a-uuid"));
    expect(res.status).toBe(404);
    expect(mockOutreach.getProspect).not.toHaveBeenCalled();
  });

  it("prospect PATCH maps the service's invalid_transition to 409", async () => {
    mockOutreach.updateProspect.mockResolvedValueOnce({ ok: false, reason: "invalid_transition" });
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .patch("/api/companies/company-1/outreach/prospects/11111111-1111-1111-1111-111111111111")
        .send({ status: "approved" }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });

  it("suppression add is idempotent (201 on create, 200 on existing) and has no DELETE route", async () => {
    mockOutreach.addOutreachSuppression
      .mockResolvedValueOnce({ created: true, entry: { id: "s1", email: "a@b.fi", reason: "manual" } })
      .mockResolvedValueOnce({ created: false, entry: { id: "s1", email: "a@b.fi", reason: "manual" } });
    const app = await createApp();
    let res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/suppressions").send({ email: "A@B.fi" }),
    );
    expect(res.status).toBe(201);
    expect(mockOutreach.addOutreachSuppression).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: "a@b.fi", reason: "manual", sourceCompanyId: "company-1" }),
    );
    res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/suppressions").send({ email: "a@b.fi" }),
    );
    expect(res.status).toBe(200);
    res = await requestApp(app, (base) => request(base).delete("/api/companies/company-1/outreach/suppressions/s1"));
    expect(res.status).toBe(404);
  });

  it("suppression check returns only the suppressed subset", async () => {
    mockOutreach.findOutreachSuppressed.mockResolvedValue(new Set(["b@x.fi"]));
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post("/api/companies/company-1/outreach/suppressions/check").send({ emails: ["A@x.fi", "B@x.fi"] }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suppressed: ["b@x.fi"] });
  });

  it("ignores unknown status filters instead of passing them to the service", async () => {
    mockOutreach.listProspects.mockResolvedValue([]);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get("/api/companies/company-1/outreach/prospects?status=bogus&limit=10"),
    );
    expect(res.status).toBe(200);
    expect(mockOutreach.listProspects).toHaveBeenCalledWith(expect.anything(), "company-1", { status: undefined, limit: 10 });
  });
});
