import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { recallKnowledge, type RecallResult, type RecallSnippet } from "./knowledge-recall.js";

/**
 * Heartbeat knowledge-recall injection (RK9-18 / C6).
 *
 * Builds a small "Knowledge Context" markdown section from the RK9 vault (via the C5
 * recall service) and returns it for injection into the agent's heartbeat prompt.
 *
 * Two gates, both default-off, must BOTH be true for anything to be injected:
 *   1. Global kill-switch: instanceSettings.experimental.knowledgeRecallInjectionEnabled
 *   2. Per-agent opt-in:    agent.runtimeConfig.knowledgeRecall.enabled
 *
 * Safety: never throws and never blocks the heartbeat — any failure (recall error,
 * timeout, unmapped company, no hits) returns null and the heartbeat proceeds with no
 * knowledge section. The injected text is hard-capped (top-N facts + character budget)
 * so the per-heartbeat token cost cannot run away. Company scoping is enforced inside the
 * recall service (queries only the agent's company collection + shared); this layer never
 * widens it.
 */

/** Top-N facts to inject (AC: top 3–5). */
export const MAX_FACTS = 5;
const DEFAULT_FACTS = 5;
/** ~500-token budget at ~4 chars/token. Hard cap on the rendered section body. */
export const KNOWLEDGE_CHAR_CAP = 2000;

const ESTIMATED_CHARS_PER_TOKEN = 4;

/** Per-agent opt-in config, read from agents.runtimeConfig.knowledgeRecall. */
export interface KnowledgeRecallAgentConfig {
  enabled: boolean;
  /** Optional explicit recall query; when absent, derived from the agent's role. */
  query?: string;
  /** Optional fact count override (clamped to 1..MAX_FACTS). */
  limit?: number;
}

/** Minimal agent shape this service needs (keeps it unit-testable without a full agent row). */
export interface KnowledgeAgent {
  id: string;
  companyId: string;
  role?: string | null;
  name?: string | null;
  runtimeConfig?: unknown;
}

export interface KnowledgeContextResult {
  /** Rendered "## Knowledge Context" markdown section, ready to inject into the prompt. */
  markdown: string;
  factCount: number;
  /** Estimated tokens added to the heartbeat by this section (chars / 4). */
  injectedTokenEstimate: number;
  latencyMs: number;
  topScore: number | null;
}

/** Injectable recall fn so the service is unit-testable without qmd/DB. */
export type RecallFn = typeof recallKnowledge;

export interface KnowledgeInjectionDeps {
  recall?: RecallFn;
  /** Wall-clock now in ms; injectable for deterministic latency in tests. */
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parse the per-agent opt-in block from runtimeConfig. Missing/invalid → disabled. */
export function parseKnowledgeRecallConfig(runtimeConfig: unknown): KnowledgeRecallAgentConfig {
  const block = asRecord(asRecord(runtimeConfig).knowledgeRecall);
  const enabled = block.enabled === true;
  const query = typeof block.query === "string" && block.query.trim() ? block.query.trim() : undefined;
  const limit =
    typeof block.limit === "number" && Number.isFinite(block.limit) && block.limit > 0
      ? Math.min(Math.floor(block.limit), MAX_FACTS)
      : undefined;
  return { enabled, query, limit };
}

/**
 * Role → recall-query map. Matched by case-insensitive substring against the agent's role
 * (covers the English + Finnish RK9 role names). Falls back to role+name, then a generic query.
 */
const ROLE_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ["ceo", "strategy goals priorities decisions risks escalations roadmap"],
  ["cfo", "budget spend invoicing VAT bookkeeping financial close cashflow"],
  ["kirjanpit", "budget spend invoicing VAT bookkeeping financial close cashflow"],
  ["cto", "architecture technical decisions code review tech debt incidents deploys"],
  ["legal", "contracts GDPR compliance legal obligations corporate registry"],
  ["laki", "contracts GDPR compliance legal obligations corporate registry"],
  ["hallinto", "contracts GDPR compliance legal obligations corporate registry"],
  ["analy", "KPIs metrics monthly report financial analysis forecasts"],
  ["talous", "KPIs metrics monthly report financial analysis forecasts"],
  ["support", "customer support policies SLA tickets common issues"],
  ["asiakas", "customer support policies SLA tickets common issues"],
  ["customer", "customer support policies SLA tickets common issues"],
];

export function deriveRecallQuery(agent: KnowledgeAgent, override?: string): string {
  if (override) return override;
  const role = (agent.role ?? "").toLowerCase();
  for (const [keyword, query] of ROLE_QUERIES) {
    if (role.includes(keyword)) return query;
  }
  const fallback = [agent.role, agent.name].filter((s) => typeof s === "string" && s.trim()).join(" ").trim();
  return fallback || "company goals priorities recent decisions risks";
}

/**
 * Render the snippets into a capped markdown section. Stops adding facts once either the
 * fact count or the character budget is reached, so the result never exceeds the budget.
 */
export function renderKnowledgeSection(snippets: RecallSnippet[], maxFacts: number, charCap: number): string {
  const header = "## Knowledge Context (RK9 vault — recalled, not re-read)";
  const intro =
    "Relevant facts from your company's knowledge vault. Treat as background context; verify against the repo before acting.";
  const lines: string[] = [];
  let used = 0;
  for (const s of snippets) {
    if (lines.length >= maxFacts) break;
    const title = (s.title ?? "").trim() || "(untitled)";
    const body = collapseSnippet(s.snippet);
    const source = s.sourcePath ? ` _(${s.sourcePath})_` : "";
    const entry = `- **${title}**${source}: ${body}`;
    if (used + entry.length > charCap && lines.length > 0) break;
    lines.push(entry);
    used += entry.length;
  }
  if (lines.length === 0) return "";
  return [header, "", intro, "", ...lines].join("\n");
}

/** Collapse a qmd snippet (which carries diff-style @@ markers + newlines) to a compact one-liner. */
function collapseSnippet(snippet: string): string {
  return snippet
    .replace(/@@[^\n]*@@/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
}

/**
 * Build the knowledge-context section for one heartbeat run, or null when it should not be
 * injected. Never throws.
 */
export async function buildKnowledgeContext(
  db: Db,
  params: { agent: KnowledgeAgent; globalEnabled: boolean; runId: string },
  deps: KnowledgeInjectionDeps = {},
): Promise<KnowledgeContextResult | null> {
  const { agent, globalEnabled, runId } = params;
  if (!globalEnabled) return null;

  const config = parseKnowledgeRecallConfig(agent.runtimeConfig);
  if (!config.enabled) return null;

  const recall = deps.recall ?? recallKnowledge;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const query = deriveRecallQuery(agent, config.query);
  const limit = config.limit ?? DEFAULT_FACTS;

  let result: RecallResult;
  try {
    result = await recall(db, {
      query,
      companyId: agent.companyId,
      limit,
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      runId,
    });
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, "knowledge-injection: recall failed; skipping injection");
    return null;
  }

  const markdown = renderKnowledgeSection(result.snippets, limit, KNOWLEDGE_CHAR_CAP);
  if (!markdown) return null;

  const injectedTokenEstimate = estimateTokens(markdown.length);
  const latencyMs = now() - startedAt;
  const topScore = result.snippets[0]?.score ?? null;
  // Count facts actually rendered (render may stop early on the char cap).
  const factCount = markdown.split("\n").filter((l) => l.startsWith("- ")).length;

  // Measurement signal (joined to heartbeat_runs by run_id). Best-effort; never block the heartbeat.
  try {
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "knowledge-injection",
      action: "knowledge_recall_injection",
      entityType: "heartbeat_run",
      entityId: runId,
      agentId: agent.id,
      runId,
      details: {
        query,
        factCount,
        injectedTokenEstimate,
        injectedChars: markdown.length,
        charCap: KNOWLEDGE_CHAR_CAP,
        topScore,
        latencyMs,
        timedOut: result.timedOut,
        collections: result.collections,
      },
    });
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, "knowledge-injection: activity log failed");
  }

  return { markdown, factCount, injectedTokenEstimate, latencyMs, topScore };
}
