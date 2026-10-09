import { logger } from "../middleware/logger.js";

/**
 * Client for the warm `qmd-mcp` daemon (RK9-186).
 *
 * `knowledge-recall.ts` used to cold-start a `qmd vsearch` CLI process per request, which loads
 * the ~300MB embedding model from scratch every time — fine when idle, but under load (or during
 * a `qmd embed` reindex) that cold start alone can blow past the caller's HTTP timeout before any
 * search even starts (RK9-186 measurements: 23s timeouts at load 4-14, 0 hits). `qmd-mcp.service`
 * (Streamable-HTTP MCP, `[::1]:8181/mcp`) already runs as a long-lived daemon and keeps the model
 * resident, so a warm query against it is ~0.5-1s instead. This module talks to that daemon; the
 * CLI path in knowledge-recall.ts remains the fallback when the daemon is down or errors.
 *
 * Protocol/safety model ported from `/home/rk9admin/vault-mcp/server.js` (the existing, running
 * client for this same daemon) — same SSE-or-JSON response handling, same single-cached-session
 * with re-init-once-on-failure, and the same rule that `collections` must NEVER be omitted from
 * a `query` call: an omitted `collections` field makes the daemon search its ENTIRE index,
 * including the operator's personal vault (`personal`, `personal-sensitive` collections). Callers
 * of `queryQmdDaemon` must always pass the same already-filtered, non-personal collection list
 * knowledge-recall.ts computes for the CLI path — this module does not compute or widen it.
 */

export interface QmdMcpQueryRow {
  file?: unknown;
  title?: unknown;
  score?: unknown;
  snippet?: unknown;
  line?: unknown;
}

export interface QmdMcpDeps {
  fetchImpl?: typeof fetch;
}

/** Daemon endpoint. Same env var name as vault-mcp's client for the same daemon. */
function qmdMcpUrl(): string {
  return process.env.QMD_MCP_URL ?? "http://[::1]:8181/mcp";
}

/** Deadline for one daemon call. Must leave headroom under the caller's own HTTP timeout
 *  (rk9claude's recall client budget is 30s). 15s (PR #83 review): under heavy load a cold daemon
 *  call can exceed 8s, and the CLI fallback is slower still in that same situation (measured 23s
 *  timeouts) — so it's worth waiting longer on the daemon before giving up on it. */
export function qmdMcpTimeoutMs(): number {
  const n = Number(process.env.PAPERCLIP_QMD_MCP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/** Keepwarm ping interval; 0 (the default) disables it. RK9-186 measurement (2026-09-12): with
 *  `rerank:false` on every call (mandatory — see queryQmdDaemon/keepwarmPing below), a cold query
 *  after a 5+ minute idle gap took 3.0s and the next warm one 0.5s — both comfortably inside the
 *  AC's 5s/10s budgets, so keepwarm buys nothing and would just be unattended background load.
 *  Left available (env-tunable) as an escape hatch, default OFF. */
export function qmdKeepwarmIntervalMs(): number {
  const n = Number(process.env.PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One collection that always exists in the index, safe for an unattended keepwarm ping
 *  (never personal). */
const KEEPWARM_COLLECTION = "rk9";
/** Lex terms the health probe tries, in order, to find an active document to seed its vec query. */
const PROBE_SEED_TERMS = ["health", "operator", "todo"];
const PROBE_SEED_MAX_CHARS = 300;

// Single cached MCP session for the process's lifetime — re-initialized only after a genuine
// protocol failure (stale/expired session), never per-call and never on a mere abort/timeout.
// Re-initializing per call caused the daemon's observed session leak (387 active sessions) this
// feature must not repeat.
let session: string | null = null;
// Shared in-flight initialize() so concurrent first calls (no cached session yet) don't each
// start their own session — without this, two callers racing while session is still null would
// both call qmdInit and open two sessions, only one of which anything ever remembers.
let initPromise: Promise<string> | null = null;

/** Consecutive daemon failures before the outage is escalated to an ERROR log line (RK9-369). */
export function qmdAlertThreshold(): number {
  const n = Number(process.env.PAPERCLIP_QMD_ALERT_THRESHOLD);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

/** Health probe interval; 0 disables it. The probe is a vec-only query that must
 *  return a hit, so a daemon outage is noticed even when nobody is calling recall. */
export function qmdHealthProbeIntervalMs(): number {
  const n = Number(process.env.PAPERCLIP_QMD_HEALTH_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export interface QmdDaemonStatus {
  healthy: boolean;
  consecutiveFailures: number;
  /** Recalls (or probes) that failed on the daemon since process start. */
  totalFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

// Daemon health, updated by every real query and by the health probe. Before RK9-369 a daemon
// outage only produced one WARN per recall and recall silently kept working through the slower CLI
// path, so nobody noticed the daemon was down (CT 364 :8181). Caller aborts are not counted: they
// say nothing about the daemon.
const daemonHealth = { consecutiveFailures: 0, totalFailures: 0, lastSuccessAt: null as number | null, lastFailureAt: null as number | null, lastError: null as string | null };

function recordDaemonSuccess(): void {
  if (daemonHealth.consecutiveFailures >= qmdAlertThreshold()) {
    logger.warn(
      { downForFailures: daemonHealth.consecutiveFailures },
      "qmd-mcp daemon RECOVERED: recall is using the daemon again",
    );
  }
  daemonHealth.consecutiveFailures = 0;
  daemonHealth.lastSuccessAt = Date.now();
}

function recordDaemonFailure(error: unknown): void {
  daemonHealth.consecutiveFailures++;
  daemonHealth.totalFailures++;
  daemonHealth.lastFailureAt = Date.now();
  daemonHealth.lastError = errorMessage(error);
  // Log on the threshold crossing and every 10th failure after it, not on every one, so a
  // sustained outage stays visible without flooding the log.
  const over = daemonHealth.consecutiveFailures - qmdAlertThreshold();
  if (over >= 0 && over % 10 === 0) {
    logger.error(
      { consecutiveFailures: daemonHealth.consecutiveFailures, lastError: daemonHealth.lastError, url: qmdMcpUrl() },
      "qmd-mcp daemon DOWN: knowledge recall is falling back to the slow qmd CLI path",
    );
  }
}

export function getQmdDaemonStatus(): QmdDaemonStatus {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  return {
    healthy: daemonHealth.consecutiveFailures < qmdAlertThreshold(),
    consecutiveFailures: daemonHealth.consecutiveFailures,
    totalFailures: daemonHealth.totalFailures,
    lastSuccessAt: iso(daemonHealth.lastSuccessAt),
    lastFailureAt: iso(daemonHealth.lastFailureAt),
    lastError: daemonHealth.lastError,
  };
}

/** Message-only view of a caught value, for the WARN-without-stack cases below. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Response body may be plain JSON or an SSE stream of `data: ` lines; the last `data:` line
 *  wins (final event). */
function parseMaybeSse(text: string): any {
  const t = text.trimStart();
  if (t.startsWith("{")) return JSON.parse(t);
  const datas = t
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  if (!datas.length) throw new Error("qmd-mcp: unparseable response");
  return JSON.parse(datas[datas.length - 1]);
}

async function qmdFetch(
  body: unknown,
  sid: string | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sid) headers["mcp-session-id"] = sid;
  return fetchImpl(qmdMcpUrl(), { method: "POST", headers, body: JSON.stringify(body), signal });
}

async function qmdInit(signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const r = await qmdFetch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "paperclip-knowledge-recall", version: "1.0" },
      },
    },
    null,
    signal,
    fetchImpl,
  );
  const sid = r.headers.get("mcp-session-id");
  if (!sid) throw new Error(`qmd-mcp daemon initialize failed (HTTP ${r.status})`);
  await qmdFetch({ jsonrpc: "2.0", method: "notifications/initialized" }, sid, signal, fetchImpl);
  return sid;
}

/** Returns the cached session, initializing it if needed. Concurrent callers with no cached
 *  session share the same in-flight `initPromise` instead of each opening their own. */
async function getSession(signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  if (session) return session;
  if (!initPromise) {
    initPromise = qmdInit(signal, fetchImpl)
      .then((sid) => {
        session = sid;
        return sid;
      })
      .finally(() => {
        initPromise = null;
      });
  }
  return initPromise;
}

/** Best-effort DELETE of a session we no longer use. Never throws. */
async function releaseSession(sid: string, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(qmdMcpUrl(), {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // harmless — the daemon expires idle sessions
  }
}

/** `tools/call` wrapper. Retries once, re-initializing the session, on a genuine protocol
 *  failure (stale/expired session, a non-2xx/malformed response, a JSON-RPC `error`) — matches
 *  vault-mcp's handling of a stale/expired session, since the daemon doesn't distinguish that
 *  from other errors in its response shape. Does NOT clear the session or retry on an abort —
 *  the caller disconnecting or our own timeout firing says nothing about the session's validity,
 *  and clearing it there would force a needless re-init (and, at volume, reproduce the daemon's
 *  observed session-leak symptom) on every disconnected/slow request. */
async function qmdCall(name: string, args: unknown, signal: AbortSignal, fetchImpl: typeof fetch): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let sid: string | null = null;
    try {
      sid = await getSession(signal, fetchImpl);
      const r = await qmdFetch(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
        sid,
        signal,
        fetchImpl,
      );
      const json = parseMaybeSse(await r.text());
      if (json.error) throw new Error(`qmd-mcp daemon: ${json.error.message}`);
      return json.result;
    } catch (error) {
      lastErr = error;
      if (signal.aborted) throw error; // caller went away / our deadline fired — not a session problem
      // Protocol-level failure; the (possibly stale) session may be the cause — retry fresh. Only
      // touch the cache when it still holds OUR session: a concurrent caller may already have
      // replaced it, and discarding that one would re-open the leak. Release the discarded
      // session on the daemon too (RK9-371); otherwise each failing call leaves sessions open.
      if (sid && session === sid) {
        session = null;
        void releaseSession(sid, fetchImpl);
      }
    }
  }
  throw lastErr;
}

/**
 * Query the daemon for vsearch+BM25 results over exactly `collections` (never omitted — see the
 * module doc). Returns the raw result rows, or `null` (never throws) on any failure so the caller
 * falls back to the CLI path. An empty `collections` array short-circuits to `[]` without calling
 * the daemon, since an empty array would otherwise still reach the daemon as "no scope" rather
 * than "search nothing".
 */
export async function queryQmdDaemon(
  query: string,
  collections: readonly string[],
  limit: number,
  opts: { signal?: AbortSignal; timeoutMs?: number; deps?: QmdMcpDeps } = {},
): Promise<QmdMcpQueryRow[] | null> {
  if (collections.length === 0) return [];
  const fetchImpl = opts.deps?.fetchImpl ?? fetch;
  const callerSignal = opts.signal;
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? qmdMcpTimeoutMs());
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  try {
    const result = await qmdCall(
      "query",
      {
        searches: [
          { type: "lex", query },
          { type: "vec", query },
        ],
        rerank: false,
        collections: [...collections],
        limit,
      },
      signal,
      fetchImpl,
    );
    // A tool-level failure (e.g. bad input) comes back as a normal JSON-RPC *result* with
    // isError:true and no structuredContent — NOT as a top-level json.error (that's a
    // protocol-level failure, already handled in qmdCall). Treating this as "0 results" instead
    // of "the call failed" would silently return an empty recall — exactly the symptom RK9-186
    // exists to fix, just moved one layer up. Throw so the caller falls back to the CLI.
    if (result?.isError) {
      throw new Error(`qmd-mcp daemon: tool error: ${JSON.stringify(result?.content ?? result)}`);
    }
    const rows = result?.structuredContent?.results;
    recordDaemonSuccess();
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    // The caller (HTTP client) disconnected — expected/abandoned, not a daemon problem. Logging
    // this at WARN with a full stack (RK9-186 production check, 12.9.2026: `AbortError: This
    // operation was aborted`) drowns out genuine daemon failures at the same level. `debug` keeps
    // it visible on demand without polluting the WARN stream.
    if (callerSignal?.aborted) {
      logger.debug(
        { err: errorMessage(error) },
        "knowledge-recall: qmd-mcp daemon query aborted by caller; falling back to CLI",
      );
    } else if (timeoutSignal.aborted) {
      recordDaemonFailure(error);
      // Our own deadline fired — the daemon being slow IS worth a WARN, but the stack trace of an
      // AbortError points at this module, not at the daemon, so it adds nothing; keep just the
      // message.
      logger.warn(
        { err: errorMessage(error) },
        "knowledge-recall: qmd-mcp daemon query timed out; falling back to CLI",
      );
    } else {
      recordDaemonFailure(error);
      logger.warn({ err: error }, "knowledge-recall: qmd-mcp daemon query failed; falling back to CLI");
    }
    return null;
  }
}

/** One cheap ping so the daemon's embedding model doesn't unload between recalls. Best-effort:
 *  logs and swallows any failure, same as the rest of this recall feature never blocking on qmd. */
export async function keepwarmPing(deps: QmdMcpDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(qmdMcpTimeoutMs());
  try {
    await qmdCall(
      "query",
      { searches: [{ type: "vec", query: "keepwarm" }], rerank: false, collections: [KEEPWARM_COLLECTION], limit: 1 },
      signal,
      fetchImpl,
    );
  } catch (error) {
    logger.warn({ err: error }, "knowledge-recall: qmd-mcp keepwarm ping failed");
  }
}

/** Runs one `query` tool call for the probe and returns its result rows. Throws on a tool-level
 *  `isError` result; qmdCall throws on protocol failures and timeouts. */
async function probeQuery(
  searches: Array<{ type: "lex" | "vec"; query: string }>,
  fetchImpl: typeof fetch,
): Promise<QmdMcpQueryRow[]> {
  const result = await qmdCall(
    "query",
    { searches, rerank: false, collections: [KEEPWARM_COLLECTION], limit: 1 },
    AbortSignal.timeout(qmdMcpTimeoutMs()),
    fetchImpl,
  );
  if (result?.isError) {
    throw new Error(`qmd-mcp daemon: tool error: ${JSON.stringify(result?.content ?? result)}`);
  }
  const rows = result?.structuredContent?.results;
  return Array.isArray(rows) ? rows : [];
}

/** Picks the text of one ACTIVE document with a lex-only query (lex needs no embedding model).
 *  Returns null when no seed query matches. */
async function probeSeedText(fetchImpl: typeof fetch): Promise<string | null> {
  for (const term of PROBE_SEED_TERMS) {
    const [row] = await probeQuery([{ type: "lex", query: term }], fetchImpl);
    const text = [row?.title, row?.snippet]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PROBE_SEED_MAX_CHARS);
    if (text) return text;
  }
  return null;
}

/** Vec-only query against the daemon that must return at least one hit. qmd swallows embedding-model
 *  load and embed errors (`embedBatch` returns null embeddings) and `structuredSearch` then skips the
 *  vec search without an error, so a lex+vec query still succeeds as lex-only (RK9-463). A vec-only
 *  query has no lex fallback: with a broken model it returns zero rows.
 *
 *  Zero rows alone is ambiguous (RK9-465): qmd's `searchVec` takes the 60 nearest vectors of the WHOLE
 *  index and only then drops inactive documents, so an index full of orphan vectors can return zero
 *  rows for a healthy model. The probe therefore seeds the vec query with the text of an active
 *  document found by a lex-only query. That document's own vector is a near-exact match, so it lands
 *  in the top 60 however many orphans exist, and zero rows still means the embedding path is broken.
 *  A tool-level `isError` result and a vec timeout count as failures too.
 *  Feeds the health state; never throws. */
export async function probeQmdDaemon(deps: QmdMcpDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const seed = await probeSeedText(fetchImpl);
    const rows = await probeQuery([{ type: "vec", query: seed ?? "health" }], fetchImpl);
    if (rows.length === 0) {
      throw new Error(
        seed
          ? `qmd-mcp daemon: vec-only probe returned no hits in collection "${KEEPWARM_COLLECTION}" for the text of an active document (embedding model not loaded)`
          : `qmd-mcp daemon: vec-only probe returned no hits in collection "${KEEPWARM_COLLECTION}" and no active document was found to seed it (embedding model not loaded, index empty, or orphan vectors crowding out the nearest neighbours)`,
      );
    }
    recordDaemonSuccess();
  } catch (error) {
    recordDaemonFailure(error);
  }
}

/** Starts the periodic health probe (default 60s; PAPERCLIP_QMD_HEALTH_INTERVAL_MS=0 disables).
 *  Does nothing unless QMD_MCP_URL is set: instances without a daemon (dev, CI) would otherwise
 *  log a DOWN error forever. */
export function startQmdHealthProbe(opts: { intervalMs?: number; deps?: QmdMcpDeps } = {}): QmdKeepwarmHandle {
  const intervalMs = opts.intervalMs ?? qmdHealthProbeIntervalMs();
  if (intervalMs <= 0 || !process.env.QMD_MCP_URL) return { stop: () => {} };
  let running = false; // a slow probe (timeouts + retry) must not overlap the next tick
  const interval = setInterval(() => {
    if (running) return;
    running = true;
    void probeQmdDaemon(opts.deps).finally(() => {
      running = false;
    });
  }, intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  logger.info({ intervalMs }, "qmd-mcp health probe started");
  return { stop: () => clearInterval(interval) };
}

export interface QmdKeepwarmHandle {
  stop(): void;
}

/** Starts the keepwarm interval; `intervalMs <= 0` (via PAPERCLIP_QMD_KEEPWARM_INTERVAL_MS=0)
 *  disables it and returns a no-op handle. Mirrors startQmdOrphanWatchdog's interval shape. */
export function startQmdKeepwarm(opts: { intervalMs?: number; deps?: QmdMcpDeps } = {}): QmdKeepwarmHandle {
  const intervalMs = opts.intervalMs ?? qmdKeepwarmIntervalMs();
  if (intervalMs <= 0) return { stop: () => {} };
  const interval = setInterval(() => void keepwarmPing(opts.deps), intervalMs);
  if (typeof interval.unref === "function") interval.unref(); // don't keep the process alive for this timer
  logger.info({ intervalMs }, "qmd-mcp keepwarm started");
  return { stop: () => clearInterval(interval) };
}

/** Releases the cached MCP session on the daemon, if one was ever initialized. Called from the
 *  server's shutdown handler (mirrors the telemetry-flush / embedded-postgres-stop shape there)
 *  so we don't leave a session dangling server-side on every restart. */
export async function closeQmdMcpSession(deps: QmdMcpDeps = {}): Promise<void> {
  if (!session) return;
  const sid = session;
  session = null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    await fetchImpl(qmdMcpUrl(), {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
      signal: AbortSignal.timeout(qmdMcpTimeoutMs()),
    });
  } catch (error) {
    logger.warn({ err: error }, "knowledge-recall: qmd-mcp session close failed (harmless — daemon will expire it)");
  }
}

/** Test-only: reset the module-level session cache so tests don't leak state into each other. */
export function _resetQmdMcpSessionForTests(): void {
  session = null;
  initPromise = null;
  daemonHealth.consecutiveFailures = 0;
  daemonHealth.totalFailures = 0;
  daemonHealth.lastSuccessAt = null;
  daemonHealth.lastFailureAt = null;
  daemonHealth.lastError = null;
}
