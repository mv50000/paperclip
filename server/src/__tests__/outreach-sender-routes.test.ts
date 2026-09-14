import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockScheduler = vi.hoisted(() => ({
  listSendQueue: vi.fn(),
  markMessageSent: vi.fn(),
  markMessageFailed: vi.fn(),
}));
const mockMessages = vi.hoisted(() => ({
  getMessageById: vi.fn(),
}));

vi.mock("../services/outreach/scheduler.js", () => mockScheduler);
vi.mock("../services/outreach/messages.js", () => mockMessages);

const API_KEY = "test-secret";

async function createApp(apiKey: string | undefined = API_KEY) {
  vi.resetModules();
  const [{ errorHandler }, { outreachSenderRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/outreach-sender.js") as Promise<typeof import("../routes/outreach-sender.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    outreachSenderRoutes({} as any, { apiKey, unsubscribeBaseUrl: "https://paperclip.rk9.fi" }),
  );
  app.use(errorHandler);
  return app;
}

describe("outreach sender machine API", () => {
  beforeEach(() => {
    mockScheduler.listSendQueue.mockReset();
    mockScheduler.markMessageSent.mockReset();
    mockScheduler.markMessageFailed.mockReset();
    mockMessages.getMessageById.mockReset();
  });

  it("401s GET /outreach/send-queue without the bearer secret", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/outreach/send-queue");
    expect(res.status).toBe(401);
    expect(mockScheduler.listSendQueue).not.toHaveBeenCalled();
  });

  it("401s every route when the server has no key configured (fail closed)", async () => {
    const app = await createApp(undefined);
    const res = await request(app)
      .get("/api/outreach/send-queue")
      .set("authorization", "Bearer anything");
    expect(res.status).toBe(401);
  });

  it("401s a same-length wrong key (RK9-205: timingSafeEqual path, not just length check)", async () => {
    // Same length as `Bearer ${API_KEY}` ("Bearer test-secret") but wrong content.
    const wrongSameLength = "Bearer test-decoyx";
    expect(wrongSameLength.length).toBe(`Bearer ${API_KEY}`.length);
    const app = await createApp();
    const res = await request(app)
      .get("/api/outreach/send-queue")
      .set("authorization", wrongSameLength);
    expect(res.status).toBe(401);
    expect(mockScheduler.listSendQueue).not.toHaveBeenCalled();
  });

  it("401s a shorter key without throwing (timingSafeEqual length guard)", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/outreach/send-queue")
      .set("authorization", "Bearer short");
    expect(res.status).toBe(401);
  });

  it("401s a longer key without throwing (timingSafeEqual length guard)", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/outreach/send-queue")
      .set("authorization", `Bearer ${API_KEY}-and-then-some-extra-characters`);
    expect(res.status).toBe(401);
  });

  it("returns the queue with a valid bearer secret", async () => {
    mockScheduler.listSendQueue.mockResolvedValue([{ id: "m1", envelopeFrom: "a@x.fi", envelopeTo: "b@y.fi", raw: "..." }]);
    const app = await createApp();
    const res = await request(app)
      .get("/api/outreach/send-queue?limit=3")
      .set("authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(mockScheduler.listSendQueue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ limit: 3, unsubscribeBaseUrl: "https://paperclip.rk9.fi" }),
    );
  });

  it("401s POST report without the bearer secret", async () => {
    const app = await createApp();
    const res = await request(app).post("/api/outreach/messages/m1/report").send({ outcome: "sent" });
    expect(res.status).toBe(401);
    expect(mockMessages.getMessageById).not.toHaveBeenCalled();
  });

  it("404s report for an unknown message id", async () => {
    mockMessages.getMessageById.mockResolvedValue(null);
    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/messages/does-not-exist/report")
      .set("authorization", `Bearer ${API_KEY}`)
      .send({ outcome: "sent" });
    expect(res.status).toBe(404);
  });

  it("records a sent outcome", async () => {
    mockMessages.getMessageById.mockResolvedValue({ id: "m1" });
    mockScheduler.markMessageSent.mockResolvedValue({ ok: true, message: { id: "m1", status: "sent" } });
    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/messages/m1/report")
      .set("authorization", `Bearer ${API_KEY}`)
      .send({ outcome: "sent" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
  });

  it("records a failed outcome with the SMTP code and response", async () => {
    mockMessages.getMessageById.mockResolvedValue({ id: "m1" });
    mockScheduler.markMessageFailed.mockResolvedValue({ ok: true, message: { id: "m1", status: "failed" } });
    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/messages/m1/report")
      .set("authorization", `Bearer ${API_KEY}`)
      .send({ outcome: "failed", smtpCode: 550, response: "5.1.1 no such user" });
    expect(res.status).toBe(200);
    expect(mockScheduler.markMessageFailed).toHaveBeenCalledWith({}, "m1", 550, "5.1.1 no such user");
  });

  it("rejects a failed report missing smtpCode/response (validation)", async () => {
    mockMessages.getMessageById.mockResolvedValue({ id: "m1" });
    const app = await createApp();
    const res = await request(app)
      .post("/api/outreach/messages/m1/report")
      .set("authorization", `Bearer ${API_KEY}`)
      .send({ outcome: "failed" });
    expect(res.status).toBe(400);
    expect(mockScheduler.markMessageFailed).not.toHaveBeenCalled();
  });
});
