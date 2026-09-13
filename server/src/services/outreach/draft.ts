// RK9-196: AI-drafted outreach messages. Loads the versioned per-company
// prompt/voice from docs/outreach/templates/<company>.md, asks Claude Sonnet 5
// (effort low — this is light copywriting, not engineering work) for a first-
// touch message, runs the quality gate, and stores the result as a draft
// (gate pass) or a pre-rejected message (gate fail, so the reason feeds
// prompt iteration — see docs/implementation-notes/outreach-enrichment.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { OutreachTemplateCompany } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { findOutreachSuppressed } from "./suppressions.js";
import { getProspect } from "./prospects.js";
import { createDraftMessage, rejectMessage } from "./messages.js";
import { runQualityGate } from "./quality-gate.js";

const CLAUDE_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 600;
// $/1M tokens (Claude Sonnet 5, cached 2026-09-13 — reverify via the
// `claude-api` skill if actual spend drifts noticeably from this estimate).
const INPUT_USD_PER_MTOK = 2;
const OUTPUT_USD_PER_MTOK = 10;

function resolveTemplatesDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../../../docs/outreach/templates"), // dev: server/src/services/outreach -> repo root/docs/...
    path.resolve(process.cwd(), "docs/outreach/templates"), // cwd (monorepo root)
    path.resolve(moduleDir, "../../../../docs/outreach/templates"), // published: dist/services/outreach -> <pkg>/docs/...
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

/** Reads the per-company voice/prompt template. Throws — a missing template is a deploy defect, not a per-prospect failure. */
export function loadTemplate(company: OutreachTemplateCompany): string {
  const dir = resolveTemplatesDir();
  if (!dir) throw new Error("outreach template directory not found (docs/outreach/templates)");
  return fs.readFileSync(path.join(dir, `${company}.md`), "utf8");
}

export interface DraftProspectFacts {
  orgName: string;
  /** A short factual snippet from enrichment (e.g. `enrichment.website.snippet`) to ground "one concrete observation". */
  observation: string | null;
}

/**
 * Builds the user turn. The template file (loaded by the caller) is the
 * system prompt in full — it carries the company voice, the value
 * proposition and the format instructions, so it stays the single source of
 * truth for both the human reviewer and the model.
 */
export function buildDraftUserMessage(facts: DraftProspectFacts): string {
  const observationLine = facts.observation
    ? `Yksi havainto heidän verkkosivultaan, jota voit käyttää: "${facts.observation}"`
    : "Ei tietoa verkkosivusta — älä keksi havaintoa, pidäydy yleisessä arvolupauksessa.";
  return [
    `Yrityksen nimi: ${facts.orgName}`,
    observationLine,
    "",
    "Vastaa TÄSMÄLLEEN tässä muodossa, ei muuta tekstiä ennen tai jälkeen:",
    "SUBJECT: <otsikko>",
    "BODY:",
    "<viestin runko>",
  ].join("\n");
}

export interface ParsedDraft {
  subject: string;
  bodyText: string;
}

/** Parses the `SUBJECT: ...\nBODY:\n...` format the templates instruct the model to use. */
export function parseDraftResponse(text: string): ParsedDraft | null {
  const match = text.match(/SUBJECT:\s*(.+?)\r?\n(?:.*\r?\n)*?BODY:\s*\r?\n?([\s\S]+)/i);
  if (!match) return null;
  const subject = match[1].trim();
  const bodyText = match[2].trim();
  if (!subject || !bodyText) return null;
  return { subject, bodyText };
}

export function estimateCostUsd(usage: { input_tokens: number; output_tokens: number }): number {
  return (usage.input_tokens / 1_000_000) * INPUT_USD_PER_MTOK + (usage.output_tokens / 1_000_000) * OUTPUT_USD_PER_MTOK;
}

interface ClaudeDraftCall {
  text: string;
  costUsd: number;
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Raw HTTP against the Messages API rather than `@anthropic-ai/sdk` —
 * this repo's pre-commit hook unconditionally blocks any `pnpm-lock.yaml`
 * change outside `chore/refresh-lockfile*` branches, so a feature branch
 * cannot add a new dependency. See docs/implementation-notes/outreach-enrichment.md.
 */
async function callClaudeForDraft(system: string, user: string): Promise<ClaudeDraftCall> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as AnthropicMessagesResponse;
  const textBlock = data.content.find((block) => block.type === "text");
  return { text: textBlock?.text ?? "", costUsd: estimateCostUsd(data.usage) };
}

export type DraftOutcome =
  | { ok: true; messageId: string; gate: "passed" | "rejected"; costUsd: number }
  | { ok: false; reason: "prospect_not_found" | "missing_email" | "generation_failed"; costUsd: number };

/**
 * Drafts one prospect's first-step message. Gate failures still create the
 * message row (immediately rejected with the gate reason recorded) rather
 * than being silently dropped, per the AC: rejection reasons feed prompt
 * iteration.
 */
export async function draftMessageForProspect(
  db: Db,
  companyId: string,
  company: OutreachTemplateCompany,
  prospectId: string,
): Promise<DraftOutcome> {
  const prospect = await getProspect(db, companyId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found", costUsd: 0 };
  if (!prospect.email) return { ok: false, reason: "missing_email", costUsd: 0 };

  const enrichment = prospect.enrichment as { website?: { snippet?: string } } | null;
  const system = loadTemplate(company);
  const user = buildDraftUserMessage({
    orgName: prospect.orgName,
    observation: enrichment?.website?.snippet ?? null,
  });

  let call: ClaudeDraftCall;
  try {
    call = await callClaudeForDraft(system, user);
  } catch (error) {
    logger.error({ err: error, prospectId }, "outreach draft: Claude call failed");
    return { ok: false, reason: "generation_failed", costUsd: 0 };
  }

  const parsed = parseDraftResponse(call.text);
  if (!parsed) return { ok: false, reason: "generation_failed", costUsd: call.costUsd };

  const created = await createDraftMessage(db, companyId, {
    prospectId,
    step: 0,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
  });
  if (!created.ok) return { ok: false, reason: "generation_failed", costUsd: call.costUsd };

  const suppressed = (await findOutreachSuppressed(db, [prospect.email])).size > 0;
  const verdict = runQualityGate({ email: prospect.email, bodyText: parsed.bodyText, suppressed });
  if (!verdict.ok) {
    await rejectMessage(db, companyId, created.message.id, "system", verdict.reason);
    return { ok: true, messageId: created.message.id, gate: "rejected", costUsd: call.costUsd };
  }
  return { ok: true, messageId: created.message.id, gate: "passed", costUsd: call.costUsd };
}

export interface DraftBatchOutcome {
  drafted: number;
  gateRejected: number;
  failed: Array<{ prospectId: string; reason: string }>;
  totalCostUsd: number;
  stoppedForBudget: boolean;
}

/**
 * Drafts each prospect in turn, stopping once the running cost would exceed
 * `maxCostUsd` (AC: cost cap per run, default $1). Sequential, not
 * parallel — a budget cap on concurrent requests would race past the limit
 * before any response comes back to check it against.
 */
export async function draftMessages(
  db: Db,
  companyId: string,
  company: OutreachTemplateCompany,
  prospectIds: string[],
  maxCostUsd: number,
): Promise<DraftBatchOutcome> {
  const outcome: DraftBatchOutcome = {
    drafted: 0,
    gateRejected: 0,
    failed: [],
    totalCostUsd: 0,
    stoppedForBudget: false,
  };
  for (const prospectId of prospectIds) {
    if (outcome.totalCostUsd >= maxCostUsd) {
      outcome.stoppedForBudget = true;
      break;
    }
    const result = await draftMessageForProspect(db, companyId, company, prospectId);
    outcome.totalCostUsd += result.costUsd;
    if (!result.ok) {
      outcome.failed.push({ prospectId, reason: result.reason });
      continue;
    }
    if (result.gate === "passed") outcome.drafted += 1;
    else outcome.gateRejected += 1;
  }
  return outcome;
}
