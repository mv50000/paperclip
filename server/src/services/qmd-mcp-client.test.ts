import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import {
  _resetQmdMcpSessionForTests,
  closeQmdMcpSession,
  getQmdDaemonStatus,
  probeQmdDaemon,
  keepwarmPing,
  queryQmdDaemon,
  startQmdHealthProbe,
  startQmdKeepwarm,
} from "./qmd-mcp-client.js";

interface RecordedCall {
  method: string;
  name?: string;
  args?: Record<string, unknown>;
  sid: string | null;
}

/** In-memory fake qmd-mcp daemon: same JSON-RPC/MCP shape as the real one (initialize ->
 *  mcp-session-id header, notifications/initialized, tools/call). `onQuery` decides what a
 *  `query` tools/call returns; return an array for a normal result or throw to simulate the
 *  daemon reporting an error (triggers the client's stale-session retry). */
function fakeQmdServer(opts: {
  sessionId?: string;
  onQuery?: (args: Record<string, unknown>, attempt: number) => unknown[];
  sse?: boolean;
} = {}) {
  const calls: RecordedCall[] = [];
  let initCount = 0;
  let queryAttempt = 0;
  const sessionId = opts.sessionId ?? "sid-1";

  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const headers = init.headers as Record<string, string>;
    calls.push({ method: body.method, name: body.params?.name, args: body.params?.arguments, sid: headers["mcp-session-id"] ?? null });

    if (body.method === "initialize") {
      initCount++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "mcp-session-id": `${sessionId}-${initCount}` },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    if (body.method === "tools/call" && body.params?.name === "query") {
      queryAttempt++;
      const rows = opts.onQuery?.(body.params.arguments ?? {}, queryAttempt) ?? [];
      const rpcResponse = { jsonrpc: "2.0", id: 2, result: { structuredContent: { results: rows } } };
      if (opts.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(rpcResponse), { status: 200 });
    }
    throw new Error(`fakeQmdServer: unexpected call ${body.method}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, initCount: () => initCount };
}

/** Fetch stub whose `initialize` response always fails the first N times, then succeeds —
 *  used to test that a query error triggers exactly one re-init-and-retry, not an infinite loop. */
function erroringThenOkServer() {
  const calls: RecordedCall[] = [];
  let initCount = 0;
  let queryCount = 0;
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params?: { name?: string } };
    const headers = init.headers as Record<string, string>;
    calls.push({ method: body.method, sid: headers["mcp-session-id"] ?? null });
    if (body.method === "initialize") {
      initCount++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "mcp-session-id": `sid-${initCount}` },
      });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/call") {
      queryCount++;
      if (queryCount === 1) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "session expired" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: { results: [{ file: "qmd://rk9/a.md" }] } } }),
        { status: 200 },
      );
    }
    throw new Error("unexpected");
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, initCount: () => initCount, queryCount: () => queryCount };
}

beforeEach(() => {
  _resetQmdMcpSessionForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetQmdMcpSessionForTests();
  vi.useRealTimers();
});

describe("queryQmdDaemon", () => {
  it("passes through the daemon's real production row shape unmodified — including a `file` WITHOUT the qmd:// prefix the CLI uses (RK9-186 follow-up: this shape mismatch made every daemon recall silently return 0 results)", async () => {
    // Verified against the real qmd-mcp daemon in production (2026-09-12): fields are
    // context/docid/file/line/score/snippet/title, and `file` is a bare `<collection>/<path>`,
    // NOT a `qmd://<collection>/<path>` URI. This client must NOT try to "fix" that shape itself —
    // reconstructing the qmd:// form is knowledge-recall.ts's job (rowsToSnippets), so this test
    // only pins that the client is a transparent passthrough of whatever the daemon returns.
    const prodRow = {
      context: "…surrounding text…",
      docid: "#2feeaf",
      file: "rk9/resources/sunspot-hetzner-frontend-hang.md",
      line: 12,
      score: 0.91,
      snippet: "hang detail",
      title: "Sunspot Hetzner frontend hang",
    };
    const server = fakeQmdServer({ onQuery: () => [prodRow] });
    const rows = await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(rows).toEqual([prodRow]);
    expect((rows as unknown as Array<{ file: string }>)[0].file.startsWith("qmd://")).toBe(false);
  });

  it("never omits `collections`, always sends rerank:false, and returns the daemon's rows", async () => {
    const server = fakeQmdServer({ onQuery: () => [{ file: "qmd://rk9/a.md", score: 0.9, title: "A", snippet: "hi" }] });
    const rows = await queryQmdDaemon("query text", ["rk9", "shared"], 5, { deps: { fetchImpl: server.fetchImpl } });

    expect(rows).toEqual([{ file: "qmd://rk9/a.md", score: 0.9, title: "A", snippet: "hi" }]);
    const queryCall = server.calls.find((c) => c.name === "query");
    expect(queryCall?.args).toMatchObject({ rerank: false, collections: ["rk9", "shared"], limit: 5 });
    expect(queryCall?.args?.searches).toEqual([
      { type: "lex", query: "query text" },
      { type: "vec", query: "query text" },
    ]);
  });

  it("short-circuits to [] without calling the daemon when collections is empty", async () => {
    const server = fakeQmdServer();
    const rows = await queryQmdDaemon("q", [], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(rows).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("reuses one cached session across calls (no re-initialize per call)", async () => {
    const server = fakeQmdServer({ onQuery: () => [] });
    await queryQmdDaemon("q1", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } });
    await queryQmdDaemon("q2", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(server.initCount()).toBe(1);
  });

  it("parses an SSE-wrapped response (last data: line)", async () => {
    const server = fakeQmdServer({ sse: true, onQuery: () => [{ file: "qmd://shared/b.md" }] });
    const rows = await queryQmdDaemon("q", ["shared"], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(rows).toEqual([{ file: "qmd://shared/b.md" }]);
  });

  it("re-initializes exactly once and retries after a daemon error (stale session)", async () => {
    const server = erroringThenOkServer();
    const rows = await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(rows).toEqual([{ file: "qmd://rk9/a.md" }]);
    expect(server.initCount()).toBe(2); // first session + one re-init after the error
    expect(server.queryCount()).toBe(2); // failed attempt + retry
  });

  it("returns null (never throws) when the daemon is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const rows = await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl } });
    expect(rows).toBeNull();
  });

  it("aborts and returns null (not hang) when the caller's signal fires mid-call — client disconnect (RK9-181 lesson)", async () => {
    const fetchImpl = ((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        // Otherwise never resolves — simulates a daemon call that hangs until the client goes away.
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = queryQmdDaemon("q", ["rk9"], 5, { signal: controller.signal, deps: { fetchImpl } });
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it("does not log a WARN when the CALLER's signal aborts the call — expected client disconnect, not a daemon failure (RK9-199)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined as never);
    try {
      const fetchImpl = ((_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        })) as unknown as typeof fetch;

      const controller = new AbortController();
      const pending = queryQmdDaemon("q", ["rk9"], 5, { signal: controller.signal, deps: { fetchImpl } });
      controller.abort();
      await expect(pending).resolves.toBeNull();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(String) }),
        "knowledge-recall: qmd-mcp daemon query aborted by caller; falling back to CLI",
      );
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("logs exactly one WARN WITHOUT a stack trace when the daemon's own deadline fires (no caller signal involved)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      const fetchImpl = ((_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          const onAbort = () => reject(new DOMException("Aborted", "TimeoutError"));
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        })) as unknown as typeof fetch;

      const rows = await queryQmdDaemon("q", ["rk9"], 5, { timeoutMs: 1, deps: { fetchImpl } });
      expect(rows).toBeNull();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [payload, message] = warnSpy.mock.calls[0];
      expect(message).toBe("knowledge-recall: qmd-mcp daemon query timed out; falling back to CLI");
      expect(payload).toEqual({ err: expect.any(String) }); // message-only — no stack-carrying Error object
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns null when initialize never yields a session id", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 })) as unknown as typeof fetch;
    const rows = await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl } });
    expect(rows).toBeNull();
  });

  it("returns null (not []) on a tool-level error (result.isError, no structuredContent) — treating it as 0 hits would silently swallow the failure", async () => {
    // MCP distinguishes a protocol-level failure (top-level json-rpc `error`, handled elsewhere)
    // from a TOOL-level failure: a normal json-rpc *result* whose payload has isError:true and no
    // structuredContent (verified against the real daemon: an invalid `collections` type answers
    // this way with a -32602-style tool error). If this were read as "[]" the caller (queryDaemon
    // returning non-null) would skip the CLI fallback and recall would go silently empty.
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "mcp-session-id": "sid-1" } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "Input validation error" }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const rows = await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl } });
    expect(rows).toBeNull();
  });
});

describe("qmd-mcp session lifecycle (concurrency + abort safety)", () => {
  it("does not clear the cached session on an aborted/timed-out call — a later call does not re-initialize", async () => {
    const server = fakeQmdServer({ onQuery: () => [] });
    await queryQmdDaemon("warm", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(server.initCount()).toBe(1);

    const hangingFetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method !== "tools/call") throw new Error("session should already be cached; no init expected");
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }) as unknown as typeof fetch;

    const rows = await queryQmdDaemon("q", ["rk9"], 5, { timeoutMs: 1, deps: { fetchImpl: hangingFetch } });
    expect(rows).toBeNull();

    await queryQmdDaemon("after abort", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } });
    expect(server.initCount()).toBe(1); // the aborted call did NOT force a re-initialize
  });

  it("shares one in-flight session initialization across concurrent first calls (no duplicate sessions)", async () => {
    const server = fakeQmdServer({ onQuery: () => [] });
    await Promise.all([
      queryQmdDaemon("a", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } }),
      queryQmdDaemon("b", ["rk9"], 5, { deps: { fetchImpl: server.fetchImpl } }),
    ]);
    expect(server.initCount()).toBe(1);
  });
});

describe("keepwarmPing", () => {
  it("only ever queries a fixed non-personal collection, with rerank:false", async () => {
    const server = fakeQmdServer({ onQuery: () => [] });
    await keepwarmPing({ fetchImpl: server.fetchImpl });
    const queryCall = server.calls.find((c) => c.name === "query");
    expect(queryCall?.args).toMatchObject({ rerank: false, limit: 1 });
    const collections = queryCall?.args?.collections as string[];
    expect(collections.some((c) => /^personal(-|$)/.test(c))).toBe(false);
  });

  it("swallows a daemon failure without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(keepwarmPing({ fetchImpl })).resolves.toBeUndefined();
  });
});

describe("startQmdKeepwarm", () => {
  it("is a no-op by default (interval 0) — RK9-186 measurement showed keepwarm unnecessary", async () => {
    const originalEnv = process.env.PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS;
    delete process.env.PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS;
    try {
      vi.useFakeTimers();
      const pingSpy = vi.fn();
      const server = fakeQmdServer({ onQuery: () => (pingSpy(), []) });
      const handle = startQmdKeepwarm({ deps: { fetchImpl: server.fetchImpl } });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(pingSpy).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      if (originalEnv === undefined) delete process.env.PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS;
      else process.env.PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS = originalEnv;
    }
  });

  it("pings on the configured interval when explicitly enabled", async () => {
    vi.useFakeTimers();
    const server = fakeQmdServer({ onQuery: () => [] });
    const handle = startQmdKeepwarm({ intervalMs: 1_000, deps: { fetchImpl: server.fetchImpl } });
    await vi.advanceTimersByTimeAsync(3_500);
    handle.stop();
    expect(server.calls.filter((c) => c.name === "query").length).toBe(3);
  });
});

describe("closeQmdMcpSession", () => {
  it("DELETEs the daemon session with the mcp-session-id header when one was established", async () => {
    const deleteCalls: Array<{ url: string; method: string; sid: string | null }> = [];
    const server = fakeQmdServer({ onQuery: () => [] });
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      if (init.method === "DELETE") {
        deleteCalls.push({ url: String(url), method: "DELETE", sid: (init.headers as Record<string, string>)["mcp-session-id"] ?? null });
        return new Response("", { status: 200 });
      }
      return server.fetchImpl(url as never, init);
    }) as unknown as typeof fetch;

    await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl } }); // establishes a session
    await closeQmdMcpSession({ fetchImpl });

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].sid).toBe("sid-1-1");
  });

  it("does nothing when no session was ever established", async () => {
    const fetchImpl = vi.fn();
    await closeQmdMcpSession({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-initializes on the next call after closing (session cache actually cleared)", async () => {
    const server = fakeQmdServer({ onQuery: () => [] });
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      if (init.method === "DELETE") return new Response("", { status: 200 });
      return server.fetchImpl(url as never, init);
    }) as unknown as typeof fetch;

    await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl } });
    await closeQmdMcpSession({ fetchImpl });
    await queryQmdDaemon("q2", ["rk9"], 5, { deps: { fetchImpl } });
    expect(server.initCount()).toBe(2);
  });
});

describe("daemon health (RK9-369)", () => {
  const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

  it("escalates to an ERROR log after the failure threshold and recovers on success", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    for (let i = 0; i < 2; i++) await queryQmdDaemon("q", ["rk9"], 5, { deps: { fetchImpl: down } });
    expect(getQmdDaemonStatus().healthy).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    await probeQmdDaemon({ fetchImpl: down });
    const status = getQmdDaemonStatus();
    expect(status).toMatchObject({ healthy: false, consecutiveFailures: 3, lastError: "ECONNREFUSED" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const server = fakeQmdServer({ onQuery: () => [{ file: "rk9/x.md" }] });
    await probeQmdDaemon({ fetchImpl: server.fetchImpl });
    expect(getQmdDaemonStatus()).toMatchObject({ healthy: true, consecutiveFailures: 0, totalFailures: 3 });
  });

  it("does not count a caller abort as a daemon failure", async () => {
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    const ac = new AbortController();
    ac.abort();
    await queryQmdDaemon("q", ["rk9"], 5, { signal: ac.signal, deps: { fetchImpl: down } });
    expect(getQmdDaemonStatus().totalFailures).toBe(0);
  });

  it("counts a tool-level isError result as a probe failure (vec broken, lex fine)", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      if (init.method === "DELETE") return new Response("", { status: 200 });
      const body = JSON.parse(String(init.body)) as { method: string; params?: { arguments?: Record<string, unknown> } };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "mcp-session-id": "s" } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      calls.push(body.params?.arguments ?? {});
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "embedding model failed" }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await probeQmdDaemon({ fetchImpl });
    expect(getQmdDaemonStatus()).toMatchObject({ healthy: true, consecutiveFailures: 1 });
    expect(getQmdDaemonStatus().lastError).toContain("embedding model failed");
    expect((calls[0].searches as Array<{ type: string }>).map((x) => x.type)).toEqual(["lex"]);
  });

  it("counts a vec-only probe with zero hits as a failure (qmd swallowed a model load error, RK9-463)", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const server = fakeQmdServer({ onQuery: () => [] });
    await probeQmdDaemon({ fetchImpl: server.fetchImpl });
    expect(getQmdDaemonStatus()).toMatchObject({ consecutiveFailures: 1, totalFailures: 1 });
    expect(getQmdDaemonStatus().lastError).toContain("no hits");
    const query = server.calls.filter((c) => c.name === "query").at(-1);
    expect((query?.args?.searches as Array<{ type: string }>).map((x) => x.type)).toEqual(["vec"]);
  });

  it("stays healthy when the index is full of orphan vectors: a generic vec query finds nothing but the seeded one does (RK9-465)", async () => {
    const server = fakeQmdServer({
      onQuery: (args) => {
        const search = (args.searches as Array<{ type: string; query: string }>)[0];
        if (search.type === "lex") return [{ file: "rk9/a.md", title: "Operator todo", snippet: "Pay the invoice" }];
        // Orphan vectors crowd out "health"; the active document's own text still matches.
        return search.query === "Operator todo Pay the invoice" ? [{ file: "rk9/a.md" }] : [];
      },
    });
    await probeQmdDaemon({ fetchImpl: server.fetchImpl });
    expect(getQmdDaemonStatus()).toMatchObject({ healthy: true, consecutiveFailures: 0 });
  });

  it("tries the next seed term when the first has no lex hit, and reuses the seed on the next probe", async () => {
    const server = fakeQmdServer({
      onQuery: (args) => {
        const search = (args.searches as Array<{ type: string; query: string }>)[0];
        if (search.type === "lex") return search.query === "operator" ? [{ file: "rk9/a.md", title: "Operator todo" }] : [];
        return search.query === "Operator todo" ? [{ file: "rk9/a.md" }] : [];
      },
    });
    await probeQmdDaemon({ fetchImpl: server.fetchImpl });
    const lexCalls = () => server.calls.filter((c) => c.name === "query" && (c.args?.searches as Array<{ type: string }>)[0].type === "lex").length;
    expect(lexCalls()).toBe(2);
    await probeQmdDaemon({ fetchImpl: server.fetchImpl });
    expect(lexCalls()).toBe(2);
    expect(getQmdDaemonStatus()).toMatchObject({ healthy: true, consecutiveFailures: 0 });
  });

  it("still fails when a seeded vec query returns nothing (model load failure with orphans present)", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const server = fakeQmdServer({
      onQuery: (args) =>
        (args.searches as Array<{ type: string }>)[0].type === "lex" ? [{ file: "rk9/a.md", title: "Operator todo" }] : [],
    });
    await probeQmdDaemon({ fetchImpl: server.fetchImpl });
    expect(getQmdDaemonStatus()).toMatchObject({ consecutiveFailures: 1 });
    expect(getQmdDaemonStatus().lastError).toContain("active document");
  });

  it("logs the DOWN error at the threshold and then only every 10th failure", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    for (let i = 0; i < 12; i++) await probeQmdDaemon({ fetchImpl: down });
    expect(errorSpy).toHaveBeenCalledTimes(1); // failures 3..12: only #3 (over=0); #13 would be next
    await probeQmdDaemon({ fetchImpl: down });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("closes the sessions it discards when tools/call returns a JSON-RPC error", async () => {
    const deleted: string[] = [];
    let n = 0;
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      if (init.method === "DELETE") {
        deleted.push((init.headers as Record<string, string>)["mcp-session-id"]);
        return new Response("", { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method === "initialize") {
        n++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "mcp-session-id": `s${n}` } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { message: "boom" } }), { status: 200 });
    }) as unknown as typeof fetch;
    await probeQmdDaemon({ fetchImpl });
    expect(deleted).toEqual(["s1", "s2"]);
  });
});

describe("startQmdHealthProbe", () => {
  it("does not start without QMD_MCP_URL", () => {
    vi.stubEnv("QMD_MCP_URL", "");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    startQmdHealthProbe({ intervalMs: 1000 }).stop();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("starts when QMD_MCP_URL is set", () => {
    vi.stubEnv("QMD_MCP_URL", "http://127.0.0.1:1/mcp");
    vi.spyOn(logger, "info").mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    startQmdHealthProbe({ intervalMs: 1000 }).stop();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
