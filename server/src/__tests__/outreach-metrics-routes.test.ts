import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMetrics = vi.hoisted(() => ({
  collectOutreachPrometheusMetrics: vi.fn(),
  renderOutreachPrometheusText: vi.fn(),
  buildOutreachDigest: vi.fn(),
}));

vi.mock("../services/outreach/metrics.js", () => mockMetrics);

const API_KEY = "test-secret";

async function createApp(apiKey: string | undefined = API_KEY) {
  vi.resetModules();
  const [{ errorHandler }, { outreachPrometheusMetricsRoutes, outreachDigestRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/outreach-metrics.js") as Promise<typeof import("../routes/outreach-metrics.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use(outreachPrometheusMetricsRoutes({} as any, { apiKey }));
  app.use("/api", outreachDigestRoutes({} as any, { apiKey }));
  app.use(errorHandler);
  return app;
}

describe("outreach metrics/digest observability API", () => {
  beforeEach(() => {
    mockMetrics.collectOutreachPrometheusMetrics.mockReset();
    mockMetrics.renderOutreachPrometheusText.mockReset();
    mockMetrics.buildOutreachDigest.mockReset();
  });

  it("401s GET /metrics without the bearer secret", async () => {
    const app = await createApp();
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(401);
    expect(mockMetrics.collectOutreachPrometheusMetrics).not.toHaveBeenCalled();
  });

  it("401s /metrics for every request when the server has no key configured (fail closed)", async () => {
    const app = await createApp(undefined);
    const res = await request(app).get("/metrics").set("authorization", "Bearer anything");
    expect(res.status).toBe(401);
  });

  it("returns the rendered Prometheus text with a valid bearer secret", async () => {
    mockMetrics.collectOutreachPrometheusMetrics.mockResolvedValue({ sent: [] });
    mockMetrics.renderOutreachPrometheusText.mockReturnValue("outreach_queue_depth 0\n");
    const app = await createApp();
    const res = await request(app).get("/metrics").set("authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toBe("outreach_queue_depth 0\n");
  });

  it("401s GET /api/outreach/digest without the bearer secret", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/outreach/digest");
    expect(res.status).toBe(401);
    expect(mockMetrics.buildOutreachDigest).not.toHaveBeenCalled();
  });

  it("returns the digest JSON with a valid bearer secret", async () => {
    mockMetrics.buildOutreachDigest.mockResolvedValue({ date: "2026-09-14", senders: [], text: "no senders" });
    const app = await createApp();
    const res = await request(app).get("/api/outreach/digest").set("authorization", `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: "2026-09-14", senders: [], text: "no senders" });
  });
});
