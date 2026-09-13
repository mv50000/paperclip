import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOutreach = vi.hoisted(() => ({
  processOutreachInboundMail: vi.fn(),
  readOutreachInboundHeaders: vi.fn(),
  verifyOutreachInboundSignature: vi.fn(),
}));

vi.mock("../services/outreach/index.js", () => mockOutreach);

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { outreachInboundRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/outreach-inbound.js") as Promise<typeof import("../routes/outreach-inbound.js")>,
  ]);
  const app = express();
  app.use("/api", outreachInboundRoutes({} as any, { hmacSecret: "test-secret" }));
  app.use(errorHandler);
  return app;
}

describe("outreach inbound relay (HMAC-signed, no board auth)", () => {
  beforeEach(() => {
    mockOutreach.processOutreachInboundMail.mockReset();
    mockOutreach.readOutreachInboundHeaders.mockReset();
    mockOutreach.verifyOutreachInboundSignature.mockReset();
  });

  it("401s a request with an invalid HMAC signature without ever parsing the mail", async () => {
    mockOutreach.readOutreachInboundHeaders.mockReturnValue({ timestamp: "123", signature: "sha256=bad" });
    mockOutreach.verifyOutreachInboundSignature.mockReturnValue({ ok: false, reason: "invalid_signature" });

    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/inbound")
      .set("Content-Type", "message/rfc822")
      .send(Buffer.from("From: a@b.com\r\n\r\nbody"));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_signature" });
    expect(mockOutreach.processOutreachInboundMail).not.toHaveBeenCalled();
  });

  it("processes and 200s a validly signed message, echoing the classifier outcome", async () => {
    mockOutreach.readOutreachInboundHeaders.mockReturnValue({ timestamp: "123", signature: "sha256=good" });
    mockOutreach.verifyOutreachInboundSignature.mockReturnValue({ ok: true });
    mockOutreach.processOutreachInboundMail.mockResolvedValue({ outcome: "reply_recorded" });

    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/inbound")
      .set("Content-Type", "message/rfc822")
      .send(Buffer.from("From: a@b.com\r\n\r\nbody"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: "reply_recorded" });
    expect(mockOutreach.processOutreachInboundMail).toHaveBeenCalledWith({}, expect.any(Buffer));
  });

  it("rejects a body over 5 MB with 413, before any signature check", async () => {
    const app = await createApp();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, "a");
    const res = await request(app)
      .post("/api/outreach/inbound")
      .set("Content-Type", "message/rfc822")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(mockOutreach.verifyOutreachInboundSignature).not.toHaveBeenCalled();
    expect(mockOutreach.processOutreachInboundMail).not.toHaveBeenCalled();
  });

  it("still 200s (never retry-loops the relay) when processing throws", async () => {
    mockOutreach.readOutreachInboundHeaders.mockReturnValue({ timestamp: "123", signature: "sha256=good" });
    mockOutreach.verifyOutreachInboundSignature.mockReturnValue({ ok: true });
    mockOutreach.processOutreachInboundMail.mockRejectedValue(new Error("mailparser exploded"));

    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/inbound")
      .set("Content-Type", "message/rfc822")
      .send(Buffer.from("garbage"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });
});
