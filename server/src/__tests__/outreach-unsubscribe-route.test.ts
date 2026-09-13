import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOutreach = vi.hoisted(() => ({
  getMessageByUnsubscribeToken: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("../services/outreach/index.js", () => mockOutreach);

async function createApp() {
  vi.resetModules();
  const { unsubscribeRoutes } = await import("../routes/unsubscribe.js");
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(unsubscribeRoutes({} as any));
  return app;
}

describe("unsubscribe route (public, no auth)", () => {
  beforeEach(() => {
    mockOutreach.getMessageByUnsubscribeToken.mockReset();
    mockOutreach.recordEvent.mockReset();
  });

  it("GET suppresses the prospect and shows the confirmation page", async () => {
    mockOutreach.getMessageByUnsubscribeToken.mockResolvedValue({
      id: "msg-1",
      companyId: "company-1",
      prospectId: "prospect-1",
    });
    mockOutreach.recordEvent.mockResolvedValue({ ok: true });

    const app = await createApp();
    const res = await request(app).get("/u/tok-abc");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Olet peruuttanut tilauksen");
    expect(mockOutreach.recordEvent).toHaveBeenCalledWith(
      {},
      "company-1",
      expect.objectContaining({ prospectId: "prospect-1", messageId: "msg-1", type: "unsubscribe" }),
    );
  });

  it("POST (RFC 8058 one-click) also suppresses", async () => {
    mockOutreach.getMessageByUnsubscribeToken.mockResolvedValue({
      id: "msg-2",
      companyId: "company-1",
      prospectId: "prospect-2",
    });
    mockOutreach.recordEvent.mockResolvedValue({ ok: true });

    const app = await createApp();
    const res = await request(app).post("/u/tok-def").send("List-Unsubscribe=One-Click");

    expect(res.status).toBe(200);
    expect(mockOutreach.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("an unknown token still returns 200 with the same confirmation page (no token-guessing oracle)", async () => {
    mockOutreach.getMessageByUnsubscribeToken.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).get("/u/does-not-exist");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Olet peruuttanut tilauksen");
    expect(mockOutreach.recordEvent).not.toHaveBeenCalled();
  });

  it("never surfaces a 500 to the prospect even if recordEvent throws", async () => {
    mockOutreach.getMessageByUnsubscribeToken.mockResolvedValue({
      id: "msg-3",
      companyId: "company-1",
      prospectId: "prospect-3",
    });
    mockOutreach.recordEvent.mockRejectedValue(new Error("db exploded"));

    const app = await createApp();
    const res = await request(app).get("/u/tok-ghi");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Olet peruuttanut tilauksen");
  });
});
