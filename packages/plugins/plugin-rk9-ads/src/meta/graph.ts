/**
 * The one Meta Graph API client of the plugin (G12, RK9-508).
 *
 * - `GRAPH_VERSION` is the only Graph version in `src/`, and `graphUrl()` is the
 *   only base-URL builder (ADR 2). A test fails on any other literal.
 * - Every request goes through an injected `http.fetch` (`ctx.http.fetch` in the
 *   worker). Bodies are strings: the worker RPC turns any other body into
 *   `String(body)`, so FormData and Blob cannot cross it (G4).
 * - The token is resolved through `ctx.secrets.resolve` on every call and sent
 *   as an `Authorization: Bearer` header, never as a query parameter. Nothing
 *   keeps it after the call returns.
 * - Modes: `live`, `readOnly` (a write throws before any fetch) and `dryRun`
 *   (a write is logged and returns a plan, nothing is sent).
 * - Every write first passes the `guardedWrite` hook. The spend guard and the
 *   kill switch (RK9-511) plug in there.
 */

import type { PluginActivityLogEntry, PluginLogger, PluginSecretsClient } from "@paperclipai/plugin-sdk";
import type { SecretRef } from "../config.js";
import {
  INVALID_PARAM_CODE,
  InvalidParamError,
  MetaGraphError,
  MetaResponseError,
  POLICY_ACCEPTANCE_SUBCODE,
  PolicyAcceptanceRequiredError,
  RATE_LIMIT_CODES,
  RateLimitError,
  ReadOnlyViolationError,
  TOKEN_INVALID_CODE,
  TokenInvalidError,
  WriteRefusedError,
  type MetaGraphErrorDetails,
} from "./errors.js";
import { redactText, redactValue, stripAccessToken } from "./redact.js";
import type { DryRunResult, WriteResult } from "./types.js";

/** The Graph API version of every call. Bump it here and nowhere else. */
export const GRAPH_VERSION = "v23.0";

const GRAPH_HOST = "graph.facebook.com";
const GRAPH_BASE_URL = `https://${GRAPH_HOST}/${GRAPH_VERSION}`;

/** A version path segment, e.g. the first segment of a paging URL. */
const VERSION_SEGMENT_RE = /^v\d+\.\d+$/;
/** Graph node and edge paths: ids, `act_<id>`, edge names. No dots, no schemes. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_]+$/;

/** The host aborts one plugin fetch after 30 s, so the client's own waits stay well below it. */
const HOST_CALL_BUDGET_MS = 30_000;
const MAX_ATTEMPTS_CEILING = 5;

export interface RetryPolicy {
  /** Requests per call, the first one included. */
  maxAttempts: number;
  /** First backoff; it doubles per attempt. */
  baseDelayMs: number;
  /** Total sleep per call. Clamped below the host's 30 s budget. */
  maxTotalWaitMs: number;
}

export const DEFAULT_RETRY: Readonly<RetryPolicy> = { maxAttempts: 3, baseDelayMs: 1_000, maxTotalWaitMs: 20_000 };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type MetaClientMode = "live" | "readOnly" | "dryRun";
export type GraphParams = Record<string, string | number | boolean | object | null | undefined>;

export interface WritePlan {
  companyId: string;
  mode: MetaClientMode;
  method: "POST" | "DELETE";
  path: string;
  fields: Record<string, unknown>;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

/**
 * Called before every write, in live and dry-run mode. A refusal throws
 * `WriteRefusedError` and nothing is sent. RK9-511 (spend guard, kill switch)
 * and the activation gate (RK9-505 A9) supply the real hooks.
 */
export type GuardedWriteHook = (plan: WritePlan) => GuardDecision | Promise<GuardDecision>;

/** Edges whose POST creates an object that can spend money. */
const SPENDING_CREATE_EDGE_RE = /^act_\d+\/(campaigns|adsets|ads)$/;

/**
 * The default hook fails closed on spend: it refuses a write that sets any
 * status field to ACTIVE, and a create on the campaigns, adsets or ads edge
 * that is not explicitly PAUSED. Activation happens only through the gate's
 * own hook (G1). Every other write is allowed.
 */
export const pausedOnlyWrites: GuardedWriteHook = (plan) => {
  const statusFields = ["status", "configured_status"] as const;
  if (statusFields.some((key) => String(plan.fields[key] ?? "").toUpperCase() === "ACTIVE")) {
    return { allow: false, reason: "activation needs the gate's write hook" };
  }
  if (plan.method === "POST" && SPENDING_CREATE_EDGE_RE.test(plan.path) && plan.fields.status !== "PAUSED") {
    return { allow: false, reason: "a campaign, ad set or ad must be created PAUSED" };
  }
  return { allow: true };
};

export interface GraphDriftEvent {
  /** The company whose client saw it first. Not shown in worker health. */
  companyId: string;
  expectedVersion: string;
  observedVersion: string;
  /** Where the client saw it: a paging URL or the facebook-api-version response header. */
  source: "paging" | "header";
  path: string;
  at: string;
}

/**
 * Worker-wide Graph health. Clients record the version drift they see, and
 * `onHealth()` reports the plugin as degraded until the worker restarts with
 * a reviewed `GRAPH_VERSION`. The latest drift wins, so a second upgrade
 * (for example v25 to v26) is visible too.
 */
export class GraphHealth {
  private latest: GraphDriftEvent | null = null;
  private readonly seen = new Set<string>();

  /** Records a drift. True when this worker had not seen that observed version yet. */
  recordDrift(event: GraphDriftEvent): boolean {
    this.latest = event;
    if (this.seen.has(event.observedVersion)) return false;
    this.seen.add(event.observedVersion);
    return true;
  }

  snapshot(): { status: "ok" | "degraded"; drift: GraphDriftEvent | null } {
    return { status: this.latest ? "degraded" : "ok", drift: this.latest };
  }

  reset(): void {
    this.latest = null;
    this.seen.clear();
  }
}

/** The worker's shared instance. */
export const graphHealth = new GraphHealth();

export interface MetaClientOptions {
  companyId: string;
  /** The brand's `meta.accessTokenRef`. */
  tokenRef: SecretRef;
  /** Config path reported to the host when the ref is resolved. */
  tokenConfigPath?: string;
  http: { fetch: FetchLike };
  secrets: Pick<PluginSecretsClient, "resolve">;
  logger?: Pick<PluginLogger, "info" | "warn">;
  activity?: { log(entry: PluginActivityLogEntry): Promise<void> };
  mode?: MetaClientMode;
  guardedWrite?: GuardedWriteHook;
  retry?: Partial<RetryPolicy>;
  health?: GraphHealth;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PageResult<T> {
  data: T[];
  pages: number;
  /** True when the page cap stopped the walk before the last page. */
  truncated: boolean;
}

interface GraphErrorBody {
  message?: unknown;
  type?: unknown;
  code?: unknown;
  error_subcode?: unknown;
  fbtrace_id?: unknown;
  error_user_title?: unknown;
  error_user_msg?: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Builds a Graph URL for a node or edge path such as `act_123/campaigns`. The
 * only place that knows the host and the version.
 */
export function graphUrl(path: string, params: GraphParams = {}): URL {
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.length === 0 || segments.some((segment) => !PATH_SEGMENT_RE.test(segment))) {
    throw new InvalidParamError(`Invalid Graph path "${redactText(path)}"`);
  }
  const url = new URL(`${GRAPH_BASE_URL}/${segments.join("/")}`);
  url.search = encodeParams(params).toString();
  return url;
}

/**
 * Parameters the client never sends. `access_token` travels as a header only.
 * `method` and `batch` would let a GET act as a write on Graph and slip past
 * read-only mode and the write guard.
 */
const FORBIDDEN_PARAM_RE = /^(access_token|appsecret_proof|method|_method|batch)$/i;

/** Form-encodes Graph params: objects and arrays as JSON, undefined and null skipped. */
export function encodeParams(params: GraphParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (FORBIDDEN_PARAM_RE.test(key)) {
      throw new InvalidParamError(`Parameter ${key} is not allowed: the client sends the token as a header and writes only through post/delete`);
    }
    out.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return out;
}

function retryValue(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Meta's own estimate of when a throttled caller may retry, in ms. Read from
 * `estimated_time_to_regain_access` (minutes) in the business use case and app
 * usage headers; the largest value wins.
 */
export function regainAccessMs(headers: Headers): number | null {
  let minutes: number | null = null;
  const consider = (value: unknown) => {
    const n = asNumber(value);
    if (n !== null && n >= 0) minutes = Math.max(minutes ?? 0, n);
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    consider(record.estimated_time_to_regain_access);
    for (const item of Object.values(record)) walk(item, depth + 1);
  };
  for (const name of ["x-business-use-case-usage", "x-app-usage"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      walk(JSON.parse(raw), 0);
    } catch {
      // A malformed usage header is not worth failing the call over.
    }
  }
  return minutes === null ? null : minutes * 60_000;
}

/** Maps a Graph error body to a typed error. `knownSecrets` are redacted from every text. */
export function mapGraphError(
  httpStatus: number,
  body: GraphErrorBody | null,
  context: string,
  knownSecrets: readonly string[],
): MetaGraphError {
  const details: MetaGraphErrorDetails = {
    httpStatus,
    code: asNumber(body?.code),
    subcode: asNumber(body?.error_subcode),
    type: asString(body?.type),
    fbtraceId: asString(body?.fbtrace_id),
    userTitle: body?.error_user_title ? redactText(String(body.error_user_title), knownSecrets) : null,
    userMessage: body?.error_user_msg ? redactText(String(body.error_user_msg), knownSecrets) : null,
  };
  const graphMessage = asString(body?.message) ?? `HTTP ${httpStatus}`;
  const suffix = [
    details.code !== null ? `code ${details.code}` : null,
    details.subcode !== null ? `subcode ${details.subcode}` : null,
    details.fbtraceId ? `fbtrace_id ${details.fbtraceId}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const message = redactText(`${context}: ${graphMessage}${suffix ? ` (${suffix})` : ""}`, knownSecrets);

  if (details.subcode === POLICY_ACCEPTANCE_SUBCODE) return new PolicyAcceptanceRequiredError(message, details);
  if (details.code === TOKEN_INVALID_CODE) return new TokenInvalidError(message, details);
  if (details.code !== null && RATE_LIMIT_CODES.has(details.code)) return new RateLimitError(message, details);
  if (details.code === INVALID_PARAM_CODE) return new InvalidParamError(message, details);
  return new MetaGraphError(message, details);
}

/** Shortens long strings (base64 image bytes) for log output. */
function summariseForLog(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" && value.length > 200 ? `<${value.length} chars>` : value;
  }
  return out;
}

export class MetaGraphClient {
  readonly companyId: string;
  readonly mode: MetaClientMode;
  private readonly options: MetaClientOptions;
  private readonly retry: RetryPolicy;
  private readonly health: GraphHealth;
  private readonly guard: GuardedWriteHook;
  private drift: GraphDriftEvent | null = null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;

  constructor(options: MetaClientOptions) {
    this.options = options;
    this.companyId = options.companyId;
    this.mode = options.mode ?? "live";
    const retry = options.retry ?? {};
    // A missing, NaN or infinite value falls back to the default; every value has a hard ceiling.
    this.retry = {
      maxAttempts: Math.floor(retryValue(retry.maxAttempts, DEFAULT_RETRY.maxAttempts, 1, MAX_ATTEMPTS_CEILING)),
      baseDelayMs: retryValue(retry.baseDelayMs, DEFAULT_RETRY.baseDelayMs, 0, 10_000),
      // Never plan a wait the host would cut off.
      maxTotalWaitMs: retryValue(retry.maxTotalWaitMs, DEFAULT_RETRY.maxTotalWaitMs, 0, HOST_CALL_BUDGET_MS - 5_000),
    };
    this.health = options.health ?? graphHealth;
    this.guard = options.guardedWrite ?? pausedOnlyWrites;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  /** The client's own view: mode and the first version drift it saw. */
  status(): { mode: MetaClientMode; drift: GraphDriftEvent | null } {
    return { mode: this.mode, drift: this.drift };
  }

  async get<T>(path: string, params: GraphParams = {}): Promise<T> {
    return this.send<T>("GET", graphUrl(path, params), undefined, path);
  }

  /** Follows `paging.next` up to `maxPages` pages. */
  async paginate<T>(path: string, params: GraphParams = {}, options: { maxPages?: number } = {}): Promise<PageResult<T>> {
    const maxPages = Math.max(1, Math.floor(options.maxPages ?? 10));
    const data: T[] = [];
    let pages = 0;
    let url: URL | null = graphUrl(path, params);
    while (url && pages < maxPages) {
      const page: { data?: unknown; paging?: { next?: unknown } } = await this.send("GET", url, undefined, path);
      pages += 1;
      if (!Array.isArray(page?.data)) {
        throw new MetaResponseError(`Meta GET ${path}: page ${pages} has no data array`);
      }
      data.push(...(page.data as T[]));
      const next = page.paging?.next;
      url = typeof next === "string" && next.length > 0 ? await this.followNext(next, path) : null;
    }
    return { data, pages, truncated: url !== null };
  }

  async post<T>(path: string, fields: Record<string, unknown> = {}): Promise<WriteResult<T>> {
    return this.write<T>("POST", path, fields);
  }

  async delete<T>(path: string, fields: Record<string, unknown> = {}): Promise<WriteResult<T>> {
    return this.write<T>("DELETE", path, fields);
  }

  private async write<T>(method: "POST" | "DELETE", path: string, fields: Record<string, unknown>): Promise<WriteResult<T>> {
    // Validates the path and refuses an access_token field before anything else.
    const url = graphUrl(path);
    const body = encodeParams(fields as GraphParams).toString();
    if (this.mode === "readOnly") throw new ReadOnlyViolationError(method, path);

    const plan: WritePlan = { companyId: this.companyId, mode: this.mode, method, path, fields };
    const decision = await this.guard(plan);
    if (!decision.allow) {
      this.options.logger?.warn("rk9-ads meta write refused", redactValue({ companyId: this.companyId, method, path, reason: decision.reason }));
      throw new WriteRefusedError(method, path, redactText(decision.reason));
    }

    if (this.mode === "dryRun") {
      this.options.logger?.info(
        "rk9-ads meta dry-run write",
        redactValue({ companyId: this.companyId, method, path, fields: summariseForLog(fields) }),
      );
      const result: DryRunResult = { dryRun: true, planned: { method, path, fields: redactValue(fields) } };
      return result;
    }

    return this.send<T>(method, url, body, path);
  }

  private async resolveToken(): Promise<string> {
    let token: string;
    try {
      token = await this.options.secrets.resolve(this.options.tokenRef, {
        companyId: this.companyId,
        configPath: this.options.tokenConfigPath ?? "meta.accessTokenRef",
      });
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${redactText(error.message)}` : "unknown error";
      throw new MetaGraphError(`Could not resolve the Meta access token (${reason})`);
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new TokenInvalidError("The Meta access token resolved to an empty value");
    }
    return token.trim();
  }

  private async send<T>(method: "GET" | "POST" | "DELETE", url: URL, body: string | undefined, path: string): Promise<T> {
    const token = await this.resolveToken();
    const known = [token];
    const context = `Meta ${method} ${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";

    // Wall-clock time, fetches included, counts against the wait budget.
    const started = this.now();
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        response = await this.options.http.fetch(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}) });
        text = await response.text();
      } catch (error) {
        // No cause: a fetch error can carry the request, headers included.
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
        throw new MetaGraphError(redactText(`${context}: request failed (${reason})`, known));
      }

      this.checkVersionHeader(response.headers, path);

      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      const errorBody =
        parsed && typeof parsed === "object" && "error" in parsed ? ((parsed as { error: GraphErrorBody }).error ?? {}) : null;

      if (response.ok && !errorBody) {
        if (parsed === undefined) {
          throw new MetaResponseError(redactText(`${context}: response is not JSON`, known), { httpStatus: response.status });
        }
        return parsed as T;
      }

      const error = mapGraphError(response.status, errorBody, context, known);
      if (!(error instanceof RateLimitError)) throw error;

      const regainMs = regainAccessMs(response.headers);
      const backoffMs = this.retry.baseDelayMs * 2 ** (attempt - 1);
      const delayMs = Math.max(backoffMs, regainMs ?? 0);
      if (attempt >= this.retry.maxAttempts || this.now() - started + delayMs > this.retry.maxTotalWaitMs) {
        throw new RateLimitError(error.message, {
          httpStatus: error.httpStatus,
          code: error.code,
          subcode: error.subcode,
          type: error.graphType,
          fbtraceId: error.fbtraceId,
          retryAfterMs: regainMs,
          attempts: attempt,
        });
      }
      this.options.logger?.warn("rk9-ads meta rate limited, retrying", {
        companyId: this.companyId,
        method,
        path,
        code: error.code,
        attempt,
        delayMs,
      });
      await this.sleep(delayMs);
    }
  }

  /**
   * Turns a paging `next` URL into a URL on the pinned version. It refuses any
   * host but Graph (the client would send its Bearer token there), any path
   * but the edge being walked, and a `method` or `batch` override. It drops
   * any `access_token` Meta put in the query.
   */
  private async followNext(next: string, path: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = stripAccessToken(next);
    } catch {
      throw new MetaResponseError(`Meta GET ${path}: paging.next is not a URL`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== GRAPH_HOST) {
      throw new MetaResponseError(`Meta GET ${path}: paging.next points to ${parsed.protocol}//${parsed.hostname}; refused`);
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] && VERSION_SEGMENT_RE.test(segments[0])) {
      const observed = segments.shift()!;
      if (observed !== GRAPH_VERSION) await this.noteDrift(observed, "paging", path);
    }
    const walked = path.replace(/^\/+/, "");
    if (segments.join("/") !== walked) {
      throw new MetaResponseError(`Meta GET ${path}: paging.next leaves the edge being walked; refused`);
    }
    for (const key of parsed.searchParams.keys()) {
      if (FORBIDDEN_PARAM_RE.test(key)) {
        throw new MetaResponseError(`Meta GET ${path}: paging.next carries parameter ${key}; refused`);
      }
    }
    const url = graphUrl(walked);
    url.search = parsed.search;
    return url;
  }

  private checkVersionHeader(headers: Headers, path: string): void {
    const observed = headers.get("facebook-api-version");
    if (observed && VERSION_SEGMENT_RE.test(observed) && observed !== GRAPH_VERSION) {
      void this.noteDrift(observed, "header", path);
    }
  }

  /**
   * Warns once per client (logger line, client status) and records the drift
   * in the shared health. The activity entry is written once per worker and
   * observed version, so a client per job does not flood the activity log.
   */
  private async noteDrift(observedVersion: string, source: GraphDriftEvent["source"], path: string): Promise<void> {
    if (this.drift) return;
    const event: GraphDriftEvent = {
      companyId: this.companyId,
      expectedVersion: GRAPH_VERSION,
      observedVersion,
      source,
      path,
      at: new Date(this.now()).toISOString(),
    };
    this.drift = event;
    const firstInWorker = this.health.recordDrift(event);
    this.options.logger?.warn("rk9-ads meta Graph API version drift", { ...event });
    if (!firstInWorker) return;
    try {
      await this.options.activity?.log({
        companyId: this.companyId,
        message: "rk9-ads: Meta Graph API version drift",
        metadata: { expectedVersion: GRAPH_VERSION, observedVersion, source, path },
      });
    } catch (error) {
      this.options.logger?.warn("rk9-ads: could not log the Graph version drift", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

/** What `createMetaClient` needs from the plugin context. */
export interface MetaClientContext {
  http: { fetch: FetchLike };
  secrets: Pick<PluginSecretsClient, "resolve">;
  logger: Pick<PluginLogger, "info" | "warn">;
  activity: { log(entry: PluginActivityLogEntry): Promise<void> };
}

/** The worker's way to get a client: wires ctx.http, ctx.secrets, the logger, the activity log and shared health. */
export function createMetaClient(
  ctx: MetaClientContext,
  options: Omit<MetaClientOptions, "http" | "secrets" | "logger" | "activity">,
): MetaGraphClient {
  return new MetaGraphClient({
    health: graphHealth,
    ...options,
    http: { fetch: (url, init) => ctx.http.fetch(url, init) },
    secrets: ctx.secrets,
    logger: ctx.logger,
    activity: ctx.activity,
  });
}
