import type { AddressInfo } from "node:net";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Real-HTTP-server regression test for RK9-181: an earlier draft of the client-disconnect
// abort wiring listened on `req.on("close")`, which (on this repo's Node/Express versions)
// fires once the request body has been fully read — including on a perfectly normal, still
// -connected request — not only when the client actually goes away. That would have aborted
// (and killed the qmd process for) EVERY recall. A service-level test can't catch this: it
// needs a real socket so `res`'s "close" event reflects genuine connection state.

const mockRecallKnowledge = vi.hoisted(() => vi.fn());

vi.mock("../services/knowledge-recall.js", () => ({
  recallKnowledge: mockRecallKnowledge,
}));

const { knowledgeRoutes } = await import("../routes/knowledge.js");
const { errorHandler } = await import("../middleware/index.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", runId: null };
    next();
  });
  app.use("/api", knowledgeRoutes({} as never));
  app.use(errorHandler);
  return app;
}

async function postRecall(port: number, opts: { signal?: AbortSignal } = {}) {
  return fetch(`http://127.0.0.1:${port}/api/companies/company-1/knowledge/recall`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "hello" }),
    signal: opts.signal,
  });
}

describe("POST /companies/:companyId/knowledge/recall — client-disconnect abort (RK9-181)", () => {
  beforeEach(() => {
    mockRecallKnowledge.mockReset();
  });

  it("does NOT abort a normal, still-connected request even though qmd is slow", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockRecallKnowledge.mockImplementation(async (_db, input) => {
      capturedSignal = input.signal;
      await new Promise((r) => setTimeout(r, 100));
      return { snippets: [], collections: ["rk9"], timedOut: false };
    });

    const app = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await postRecall(port);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.collections).toEqual(["rk9"]);
      // The regression: a naive req.on("close") would have flipped this to true almost
      // immediately after express.json() read the body, well before the 100ms mock delay
      // elapsed — long before the client ever disconnected.
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      server.close();
    }
  });

  it("aborts the recall's signal when the client disconnects before the response is sent", async () => {
    let capturedSignal: AbortSignal | undefined;
    let releaseRecall: (() => void) | undefined;
    mockRecallKnowledge.mockImplementation(
      (_db, input) =>
        new Promise((resolve) => {
          capturedSignal = input.signal;
          releaseRecall = () => resolve({ snippets: [], collections: [], timedOut: true });
        }),
    );

    const app = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const controller = new AbortController();
      const fetchPromise = postRecall(port, { signal: controller.signal }).catch(() => {
        // Client-side abort rejects the fetch promise itself — expected, not the assertion.
      });

      await vi.waitFor(() => expect(capturedSignal).toBeDefined(), { timeout: 1000 });
      controller.abort(); // simulate the client giving up mid-request
      await fetchPromise;

      await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true), { timeout: 1000 });
    } finally {
      releaseRecall?.();
      server.close();
    }
  });
});
