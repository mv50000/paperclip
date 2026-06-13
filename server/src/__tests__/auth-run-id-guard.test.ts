import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

// `db` is only touched on the authenticated paths. Every assertion here either
// hits the guard (which runs before any db access) or the unauthenticated
// local_trusted path (which also never queries), so a bare stub is enough.
const stubDb = {} as never;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(stubDb, { deploymentMode: "local_trusted" }));
  app.get("/probe", (req, res) => {
    res.json({ runId: req.actor.runId ?? null });
  });
  return app;
}

const VALID_RUN_ID = "979bfca0-d71d-46c4-ae95-0b7772b1ab33";

describe("actorMiddleware X-Paperclip-Run-Id guard", () => {
  it("rejects a non-UUID run-id header with 400 instead of 500", async () => {
    const res = await request(makeApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "interactive");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/X-Paperclip-Run-Id/);
  });

  it("rejects a numeric/garbage run-id header with 400", async () => {
    const res = await request(makeApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "12345");

    expect(res.status).toBe(400);
  });

  it("accepts a valid UUID run-id header and records it on the actor", async () => {
    const res = await request(makeApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", VALID_RUN_ID);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(VALID_RUN_ID);
  });

  it("trims surrounding whitespace before binding the run-id", async () => {
    const res = await request(makeApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", `  ${VALID_RUN_ID}  `);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(VALID_RUN_ID);
  });

  it("passes through when the run-id header is absent", async () => {
    const res = await request(makeApp()).get("/probe");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("treats an empty/whitespace-only run-id header as absent (no 400)", async () => {
    const res = await request(makeApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "   ");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });
});
