import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

const execFile = promisify(execFileCallback);

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
export type QmdRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<QmdRunResult>;

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
  return [slug, `${slug}-docs`, SHARED_COLLECTION];
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
 * Build the exact `qmd vsearch` argv. Scoping lives here: only the given collections are passed.
 * We use vsearch (vector/semantic) rather than `search` (BM25) so cross-host callers get the same
 * semantic recall as the local /recall — qmd `query` (hybrid) is far too slow on CPU (~3.5 min).
 */
export function buildQmdArgs(query: string, collections: string[], limit: number): string[] {
  const args = ["vsearch", query];
  for (const c of collections) args.push("-c", c);
  args.push("-n", String(limit), "--json");
  return args;
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

const defaultRunQmd: QmdRunner = async (args, opts) => {
  try {
    const { stdout } = await execFile(qmdBin(), args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: QMD_MAX_BUFFER,
      killSignal: "SIGKILL",
      // qmd resolves its model cache from HOME; set it explicitly so vsearch finds the embed model
      // regardless of how the server process inherited its environment.
      env: { ...process.env, HOME: qmdHome() },
    });
    return { stdout, timedOut: false };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL" || e.code === "ETIMEDOUT") {
      return { stdout: "", timedOut: true };
    }
    // ENOENT (qmd missing), non-zero exit, etc. -> graceful empty, logged by caller
    throw error;
  }
};

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
      existing = await listCollections(resolvedVaultRoot);
    } catch (error) {
      logger.warn({ err: error }, "knowledge-recall: collection list failed; falling back to shared only");
      existing = [SHARED_COLLECTION];
    }

    if (input.allCollections) {
      // Operator mode (instance-admin only, enforced at the route): every existing collection.
      collections = existing;
    } else if (slug) {
      // Company scope: candidate collections ∩ existing. NEVER widens beyond the caller's company.
      collections = candidateCollections(slug).filter((c) => existing.includes(c));
    } else {
      logger.warn({ companyId: input.companyId }, "knowledge-recall: company has no vault slug");
    }

    if (collections.length > 0) {
      // Concurrency guard: shed load instead of piling another model-loading qmd onto a busy box.
      if (activeQmdRecalls >= cap) {
        busy = true;
        logger.warn({ activeQmdRecalls, cap, companyId: input.companyId }, "knowledge-recall: at concurrency cap; shedding (busy)");
      } else {
        const allowed = new Set(collections);
        const args = buildQmdArgs(input.query, collections, limit);
        activeQmdRecalls++;
        try {
          const result = await runQmd(args, { cwd: resolvedVaultRoot, timeoutMs: QMD_TIMEOUT_MS });
          timedOut = result.timedOut;
          snippets = parseQmdJson(result.stdout, allowed).slice(0, limit);
        } finally {
          activeQmdRecalls--;
        }
      }
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
