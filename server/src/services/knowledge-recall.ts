import { spawn } from "node:child_process";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

/** Vault checkout the qmd index lives under. Read directly from env (config.ts has no vault fields). */
function vaultRoot(): string {
  return process.env.PAPERCLIP_VAULT_ROOT ?? "/opt/repos/rk9-knowledge";
}

/** The `qmd` binary to invoke. */
function qmdBin(): string {
  return process.env.PAPERCLIP_QMD_BIN ?? "qmd";
}

/** HOME for the qmd process — qmd loads its GGUF models from <HOME>/.cache/qmd (needed by vsearch). */
function qmdHome(): string {
  return process.env.PAPERCLIP_QMD_HOME ?? "/var/lib/paperclip";
}

/** Grace period between SIGTERM and SIGKILL when escalating a qmd kill. Test-tunable so kill-path
 *  tests don't have to wait out the production default (RK9-181). */
function qmdKillGraceMs(): number {
  const n = Number(process.env.PAPERCLIP_QMD_KILL_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2_000;
}

/**
 * RK9 Knowledge Vault recall (RK9-17 / C5).
 *
 * Wraps the local `qmd` CLI over the git-backed vault at PAPERCLIP_VAULT_ROOT
 * (/opt/repos/rk9-knowledge). Each company has its own qmd collection named by
 * its vault slug; cross-cutting knowledge lives in the `shared` collection. The
 * service only ever queries the *authenticated* company's own collection + shared,
 * so a caller can never reach another company's knowledge (defense-in-depth layer 2;
 * filesystem ACLs are layer 1).
 */

/** issue_prefix -> vault folder/collection slug. Mirrors the vault layout + CLAUDE.md table. */
export const PREFIX_TO_VAULT_SLUG: Readonly<Record<string, string>> = {
  RK9: "rk9",
  SAA: "saatavilla",
  ALL: "alli-audit",
  QUA: "quantimodo",
  OLL: "ololla",
  AUR: "sunspot",
  SEC: "paperclip",
};

export const SHARED_COLLECTION = "shared";

/**
 * The operator's PERSONAL vault (/opt/repos/mv-knowledge → collections `personal` and
 * `personal-sensitive`) shares the one qmd index with the business collections, so nothing but
 * code keeps it out of this API. It must never be recallable here — not in company scope, and
 * not in operator mode (`scope: "all"`), because this service also feeds the knowledge preamble
 * injected into AI agents' heartbeats. The same regex gates vault-mcp, vault-mcp-public and
 * ~/bin/qmd-recall.sh on the vault host.
 */
const PERSONAL_COLLECTION_RE = /^personal(-|$)/;

export function isPersonalCollection(name: string): boolean {
  return PERSONAL_COLLECTION_RE.test(name);
}
// vsearch (semantic) loads the embedding model; on a warm box it's ~2s, but allow headroom.
const QMD_TIMEOUT_MS = 20_000;
const QMD_LIST_TIMEOUT_MS = 5_000;
const QMD_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// Concurrency guard: each vsearch spawns a qmd that loads the ~300MB embed model. Unbounded
// concurrent recalls (operator + agents + multiple hosts) contend, melt the box (observed load
// 34), and cascade into a timeout→empty→retry storm. Cap simultaneous vsearch spawns; excess
// recalls fast-fail to an empty `busy` result (graceful — the caller just proceeds without recall)
// rather than piling on. Module-level: the server is a single process. Env-tunable.
function maxConcurrentQmd(): number {
  const n = Number(process.env.PAPERCLIP_RECALL_MAX_CONCURRENT);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}
let activeQmdRecalls = 0;

export interface RecallInput {
  query: string;
  companyId: string;
  limit?: number;
  /**
   * Operator mode: search EVERY existing collection (rk9 + shared + all <company>-docs) instead
   * of the caller's company scope. The route only sets this for instance-admins — agents and
   * non-admin board users never get it, preserving cross-company isolation.
   */
  allCollections?: boolean;
  /** Optional audit context (route fills these from the auth context). */
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string;
  agentId?: string | null;
  runId?: string | null;
  /**
   * Aborts the in-flight qmd process(es) if the HTTP client disconnects before we respond
   * (route wires this to `req.on("close")`). Without it, a client that gives up early (e.g. a
   * short `--max-time`) leaves its qmd worker running to completion as an untracked orphan
   * (RK9-181) — same failure mode the timeout path fixes, triggered by the caller instead of
   * the clock.
   */
  signal?: AbortSignal;
}

export interface RecallSnippet {
  sourcePath: string;
  title: string | null;
  score: number | null;
  collection: string;
  snippet: string;
}

export interface RecallResult {
  snippets: RecallSnippet[];
  collections: string[];
  timedOut: boolean;
  /** True when the recall was skipped because the concurrency cap was hit (load shedding). */
  busy?: boolean;
}

/** Result of one qmd invocation. `timedOut` true when the process was killed at the deadline. */
export interface QmdRunResult {
  stdout: string;
  timedOut: boolean;
}

/** Injectable qmd runner so the service is unit-testable without the binary present. */
export type QmdRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<QmdRunResult>;

export interface RecallDeps {
  runQmd?: QmdRunner;
  /** Lists collection names present in the vault index; used to drop non-existent scopes. */
  listCollections?: (cwd: string) => Promise<string[]>;
  resolveSlug?: (db: Db, companyId: string) => Promise<string | null>;
  vaultRoot?: string;
  qmdBin?: string;
  /** Override the concurrency cap (default 2, or PAPERCLIP_RECALL_MAX_CONCURRENT). For tests. */
  maxConcurrent?: number;
}

/**
 * Collections an agent in `slug` MAY recall from: its own curated-facts collection (`<slug>`),
 * its repo-docs collection (`<slug>-docs`), and the cross-cutting `shared`. The `shared` slug
 * queries only `shared`. These are *candidates* — they're then intersected with the collections
 * that actually exist (see recallKnowledge), because qmd errors if passed a non-existent `-c`.
 */
export function candidateCollections(slug: string): string[] {
  if (slug === SHARED_COLLECTION) return [SHARED_COLLECTION];
  // Second layer of the personal-vault gate: a company slug can never name a personal collection
  // (the first layer strips them from `existing` in recallKnowledge).
  return [slug, `${slug}-docs`, SHARED_COLLECTION].filter((c) => !isPersonalCollection(c));
}

/** Parse `qmd collection list` output ("name (qmd://name/)" lines) into collection names. */
export function parseCollectionList(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^([a-z0-9_-]+)\s+\(qmd:\/\//i.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * Build the exact qmd argv for one retrieval mode. Scoping lives here: only the given collections
 * are passed. `vsearch` = vector/semantic (loads the embed model); `search` = BM25 keyword (no
 * model, instant). We run BOTH and fuse (see fuseRRF) — semantic alone misses exact terms/IDs/
 * Finnish (e.g. CT357, SAA-1307); BM25 alone misses paraphrase. qmd's own `query` hybrid is the
 * 3.5-min LLM path and is intentionally NOT used.
 */
export function buildQmdArgs(
  query: string,
  collections: string[],
  limit: number,
  mode: "vsearch" | "search" = "vsearch",
): string[] {
  const args = [mode, query];
  for (const c of collections) args.push("-c", c);
  args.push("-n", String(limit), "--json");
  return args;
}

/** Reciprocal Rank Fusion of ranked result lists, deduped by source path. Scale-independent, so
 *  it merges vsearch (cosine) and BM25 (tf-idf) ranks soundly; a doc found by both is boosted. */
const RRF_K = 60;
export function fuseRRF(lists: RecallSnippet[][], limit: number, k: number = RRF_K): RecallSnippet[] {
  const keyOf = (s: RecallSnippet) => s.sourcePath || s.title || JSON.stringify(s);
  const score = new Map<string, number>();
  const first = new Map<string, RecallSnippet>();
  for (const list of lists) {
    list.forEach((s, i) => {
      const key = keyOf(s);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1));
      if (!first.has(key)) first.set(key, s);
    });
  }
  return [...first.values()].sort((a, b) => (score.get(keyOf(b)) ?? 0) - (score.get(keyOf(a)) ?? 0)).slice(0, limit);
}

/**
 * Derive the collection from a qmd `file` URI of the form `qmd://<collection>/<path...>`.
 * Returns "" when the URI doesn't match (which fails the allowed-collections check).
 */
export function collectionFromUri(file: string): string {
  const m = /^qmd:\/\/([^/]+)\//.exec(file);
  return m ? m[1] : "";
}

/**
 * Parse `qmd vsearch --json` output: an array of
 * {docid, score, file, line, title, snippet}. There is no `path` or `collection`
 * field — the collection is the `qmd://<collection>/` prefix of `file`.
 * Filters to `allowed` collections as a belt-and-suspenders check on top of the -c flags.
 */
export function parseQmdJson(stdout: string, allowed: ReadonlySet<string>): RecallSnippet[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(trimmed);
  } catch {
    logger.warn("knowledge-recall: qmd JSON parse failed");
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: RecallSnippet[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const file = typeof row.file === "string" ? row.file : "";
    const collection = collectionFromUri(file);
    if (!allowed.has(collection)) continue; // never surface a doc outside the agent's scope
    out.push({
      sourcePath: file,
      title: typeof row.title === "string" ? row.title : null,
      score: typeof row.score === "number" ? row.score : null,
      collection,
      snippet: typeof row.snippet === "string" ? row.snippet : "",
    });
  }
  return out;
}

/**
 * Signal qmd's ENTIRE process group, not just the pid we spawned.
 *
 * `@tobilu/qmd`'s `bin/qmd` launcher is itself a `spawn()`-based wrapper: it starts the real
 * `dist/cli/qmd.js vsearch` worker as ITS OWN child rather than `exec`ing into it (see the
 * launcher source — it relays exit via a `child.on("exit", ...)` handler). Killing only the
 * immediate child (the launcher) therefore orphans the grandchild worker, which keeps running
 * to completion — observed on pc01 as multi-minute `node .../qmd.js vsearch` processes at
 * ~45% CPU / ~1.3GB RSS each, piling up until the box was overloaded and every recall timed
 * out (RK9-181). Spawning with `detached: true` makes our child the leader of a fresh process
 * group that the grandchild inherits, so `process.kill(-pid, …)` reaches both.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== "ESRCH") {
      logger.warn({ err: error, pid, signal }, "knowledge-recall: failed to signal qmd process group");
    }
  }
}

/** True if ANY process still belongs to process group `pgid` (`kill(-pgid, 0)` semantics: no
 *  error means at least one member is alive; ESRCH means the whole group is gone). */
function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const GROUP_EXIT_POLL_MS = 20;
const GROUP_EXIT_MAX_WAIT_MS = 5_000;

/**
 * Poll until every process in `pgid` has exited, then call `onDone`. Used ONLY after SIGKILL —
 * unlike SIGTERM, a process can't linger past it (short of being stuck in an uninterruptible
 * syscall), so this is confirming actual death, not waiting one out. Gives up after
 * GROUP_EXIT_MAX_WAIT_MS (logged) since at that point more signaling from us can't help.
 */
function waitForGroupExit(pgid: number, onDone: () => void): void {
  const deadline = Date.now() + GROUP_EXIT_MAX_WAIT_MS;
  const check = () => {
    if (!isGroupAlive(pgid)) {
      onDone();
      return;
    }
    if (Date.now() >= deadline) {
      logger.warn({ pgid }, "knowledge-recall: qmd process group still alive after SIGKILL + wait; giving up");
      onDone();
      return;
    }
    setTimeout(check, GROUP_EXIT_POLL_MS);
  };
  check();
}

/** Exported for the process-group-kill test in knowledge-recall.test.ts, which needs to invoke
 *  the real spawn/kill path (not the injectable stub) against a fixture qmd launcher. */
export const defaultRunQmd: QmdRunner = (args, opts) =>
  new Promise<QmdRunResult>((resolve, reject) => {
    // Caller (HTTP client) already gone before we even started — don't spawn just to kill it.
    if (opts.signal?.aborted) {
      resolve({ stdout: "", timedOut: true });
      return;
    }

    const child = spawn(qmdBin(), args, {
      cwd: opts.cwd,
      // qmd resolves its model cache from HOME; set it explicitly so vsearch finds the embed
      // model regardless of how the server process inherited its environment.
      env: { ...process.env, HOME: qmdHome() },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group — see killProcessGroup doc above
    });

    let stdout = "";
    let settled = false;
    let killing = false; // true once the timeout/abort kill escalation has started

    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      run();
    };

    // SIGTERM the group, then after a grace period SIGKILL it, and resolve only once EVERY
    // process in the group is confirmed gone. The immediate child (the qmd launcher) can die
    // from SIGTERM well before a grandchild worker that's ignoring SIGTERM mid-inference does —
    // resolving on our own child's "close" event alone (as an earlier version of this fix did)
    // frees the caller's concurrency slot while that worker is still running: the exact orphan
    // this exists to prevent (RK9-181, confirmed against a real qmd worker that outlived a 3s
    // SIGTERM wait and needed SIGKILL).
    const escalate = () => {
      if (killing || !child.pid) return;
      killing = true;
      const pgid = child.pid;
      killProcessGroup(pgid, "SIGTERM");
      setTimeout(() => {
        killProcessGroup(pgid, "SIGKILL");
        waitForGroupExit(pgid, () => settle(() => resolve({ stdout: "", timedOut: true })));
      }, qmdKillGraceMs());
    };

    const onAbort = () => escalate(); // client disconnected mid-request: not an error, just abandoned
    const deadline = setTimeout(escalate, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < QMD_MAX_BUFFER) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {}); // drained (not surfaced) so a chatty stderr can't stall the pipe

    child.on("error", (err) => {
      settle(() => reject(err));
    });

    child.on("close", (code, signal) => {
      // A kill escalation is in flight: waitForGroupExit above (not this event) decides when
      // the promise settles, since the group may still have live members after this event.
      if (killing) return;
      settle(() => {
        if (signal) {
          resolve({ stdout: "", timedOut: true });
        } else if (code !== 0) {
          reject(new Error(`qmd exited with code ${code}`));
        } else {
          resolve({ stdout, timedOut: false });
        }
      });
    });
  });

/** Default: list existing collections via the injectable runner so it shares timeout/env handling. */
async function defaultListCollections(cwd: string): Promise<string[]> {
  const { stdout } = await defaultRunQmd(["collection", "list"], { cwd, timeoutMs: QMD_LIST_TIMEOUT_MS });
  return parseCollectionList(stdout);
}

/** Resolve a company's vault slug from its issue prefix. Returns null if unmapped. */
export async function resolveCompanyVaultSlug(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const prefix = rows[0]?.issuePrefix;
  if (!prefix) return null;
  return PREFIX_TO_VAULT_SLUG[prefix.toUpperCase()] ?? null;
}

/**
 * Recall company-scoped knowledge. Never throws — on any failure (unmapped company,
 * qmd missing, timeout, parse error) it returns an empty result so callers/agents
 * never block. The chosen collections are always [company-slug, shared] and are
 * derived server-side from the authenticated companyId, not from caller input.
 */
export async function recallKnowledge(
  db: Db,
  input: RecallInput,
  deps: RecallDeps = {},
): Promise<RecallResult> {
  const runQmd = deps.runQmd ?? defaultRunQmd;
  const listCollections = deps.listCollections ?? defaultListCollections;
  const resolveSlug = deps.resolveSlug ?? resolveCompanyVaultSlug;
  const resolvedVaultRoot = deps.vaultRoot ?? vaultRoot();
  const limit = clampLimit(input.limit);
  const startedAt = Date.now();

  let slug: string | null = null;
  let timedOut = false;
  let busy = false;
  let snippets: RecallSnippet[] = [];
  let collections: string[] = [];
  const cap = deps.maxConcurrent ?? maxConcurrentQmd();
  try {
    slug = await resolveSlug(db, input.companyId); // for audit logging; not required in operator mode
    // List collections that actually exist — qmd errors if passed a `-c` that doesn't exist.
    let existing: string[];
    try {
      // Personal-vault gate, first and load-bearing layer: strip the operator's personal
      // collections at the single point where the collection list enters this function, so
      // BOTH branches below (operator mode and company scope) are personal-free by
      // construction. Do not move this filter into one of the branches.
      existing = (await listCollections(resolvedVaultRoot)).filter((c) => !isPersonalCollection(c));
    } catch (error) {
      logger.warn({ err: error }, "knowledge-recall: collection list failed; falling back to shared only");
      existing = [SHARED_COLLECTION];
    }

    if (input.allCollections) {
      // Operator mode (instance-admin only, enforced at the route): every existing BUSINESS
      // collection — `existing` has already had the personal ones stripped above.
      collections = existing;
    } else if (slug) {
      // Company scope: candidate collections ∩ existing. NEVER widens beyond the caller's company.
      collections = candidateCollections(slug).filter((c) => existing.includes(c));
    } else {
      logger.warn({ companyId: input.companyId }, "knowledge-recall: company has no vault slug");
    }

    if (collections.length > 0) {
      const allowed = new Set(collections);

      // BM25 keyword pass — no model, ~instant, not concurrency-guarded. Catches exact
      // terms/IDs/Finnish that semantic search misses. Best-effort.
      let bm25: RecallSnippet[] = [];
      try {
        const r = await runQmd(buildQmdArgs(input.query, collections, limit, "search"), {
          cwd: resolvedVaultRoot,
          timeoutMs: QMD_LIST_TIMEOUT_MS,
          signal: input.signal,
        });
        bm25 = parseQmdJson(r.stdout, allowed);
      } catch (error) {
        logger.warn({ err: error }, "knowledge-recall: bm25 pass failed (continuing with vsearch)");
      }

      // Semantic vsearch pass — loads the model; concurrency-guarded. Under the cap we shed it and
      // degrade gracefully to BM25-only (still useful + instant) rather than piling on / returning empty.
      let vec: RecallSnippet[] = [];
      if (activeQmdRecalls >= cap) {
        busy = true;
        logger.warn({ activeQmdRecalls, cap, companyId: input.companyId }, "knowledge-recall: at concurrency cap; vsearch shed, bm25-only");
      } else {
        activeQmdRecalls++;
        try {
          const r = await runQmd(buildQmdArgs(input.query, collections, limit, "vsearch"), {
            cwd: resolvedVaultRoot,
            timeoutMs: QMD_TIMEOUT_MS,
            signal: input.signal,
          });
          timedOut = r.timedOut;
          vec = parseQmdJson(r.stdout, allowed);
        } catch (error) {
          logger.warn({ err: error }, "knowledge-recall: vsearch pass failed (continuing with bm25)");
        } finally {
          activeQmdRecalls--;
        }
      }

      // Fuse the two ranked lists (RRF) so both semantic and keyword hits surface.
      snippets = fuseRRF([vec, bm25], limit);
    } else {
      logger.warn({ companyId: input.companyId, slug }, "knowledge-recall: no collections in scope");
    }
  } catch (error) {
    logger.error({ err: error, companyId: input.companyId }, "knowledge-recall failed; returning empty");
    snippets = [];
  }

  // Usage tracking via the standard activity-log pattern. Best-effort; never block recall on it.
  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "knowledge-recall",
      action: "knowledge_recall",
      entityType: "knowledge_recall",
      entityId: slug ?? "unmapped",
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: {
        queryLength: input.query.length,
        collections,
        resultCount: snippets.length,
        topScore: snippets[0]?.score ?? null,
        timedOut,
        busy,
        latencyMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    logger.warn({ err: error }, "knowledge-recall: activity log failed");
  }

  return { snippets, collections, timedOut, busy };
}
