// RK9-196: website enrichment. Fetches a prospect's own site via Firecrawl's
// keyless CLI (no Playwright — see docs/implementation-notes/outreach-enrichment.md
// and the `/webscrape` skill) and extracts a short services snippet plus, when
// missing, a generic/role e-mail address. `runFirecrawlScrape` is the only
// network/exec boundary, so tests mock this module rather than child_process.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachProspects } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { findOutreachSuppressed } from "./suppressions.js";
import { getProspect, updateProspect } from "./prospects.js";
import { isPrivateEmailDomain } from "./quality-gate.js";

const execFile = promisify(execFileCallback);

const FIRECRAWL_TIMEOUT_MS = 25_000;
const SNIPPET_MAX_CHARS = 600;

/** Local-parts treated as a generic/role address rather than a named person's. */
const ROLE_LOCAL_PARTS = [
  "info",
  "myynti",
  "sales",
  "toimisto",
  "asiakaspalvelu",
  "yhteystiedot",
  "contact",
  "office",
  "hello",
  "kontakti",
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Shells out to the keyless Firecrawl CLI for one page. Returns `null` (never
 * throws) on any failure — a scrape miss is a normal, expected outcome, not
 * an exceptional one.
 */
export async function runFirecrawlScrape(url: string): Promise<{ markdown: string } | null> {
  try {
    const { stdout } = await execFile(
      "firecrawl",
      ["scrape", url, "-f", "markdown", "--only-main-content"],
      { timeout: FIRECRAWL_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
    );
    const markdown = stdout.trim();
    return markdown.length > 0 ? { markdown } : null;
  } catch (error) {
    logger.warn({ err: error, url }, "outreach enrichment: firecrawl scrape failed");
    return null;
  }
}

/**
 * Best-effort extraction of a *generic/role* address from scraped markdown —
 * never a named person's inbox found by chance (GDPR: no personal-contact
 * enrichment, see `~/.claude/skills/prh-prospector/references/gdpr-rules.md`).
 * Private/free domains (gmail etc.) are rejected here too, ahead of the
 * quality gate, so they never get written to `prospect.email` in the first
 * place.
 */
export function extractGenericEmail(markdown: string): string | null {
  const seen = new Set<string>();
  for (const match of markdown.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (isPrivateEmailDomain(email)) continue;
    const localPart = email.slice(0, email.indexOf("@"));
    if (ROLE_LOCAL_PARTS.includes(localPart)) {
      return email;
    }
  }
  return null;
}

/** Strip markdown noise (links/images/headings markers) into a short plain-text excerpt. */
export function buildEnrichmentSnippet(markdown: string, maxLen = SNIPPET_MAX_CHARS): string {
  const plain = markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/[#*_>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? `${plain.slice(0, maxLen).trimEnd()}…` : plain;
}

export type EnrichResult =
  | { ok: true; prospect: typeof outreachProspects.$inferSelect }
  | { ok: false; reason: "not_found" | "no_source_url" | "scrape_failed" | "duplicate_email" };

/**
 * Scrapes `prospect.sourceUrl`, writes a services snippet into
 * `enrichment.website` and, if the prospect has no address yet, fills one in
 * with a discovered generic/role e-mail (never overwriting a human-entered
 * one). Idempotent: re-running just refreshes the snippet.
 */
export async function enrichProspectFromWebsite(
  db: Db,
  companyId: string,
  prospectId: string,
): Promise<EnrichResult> {
  const prospect = await getProspect(db, companyId, prospectId);
  if (!prospect) return { ok: false, reason: "not_found" };
  if (!prospect.sourceUrl) return { ok: false, reason: "no_source_url" };

  const scraped = await runFirecrawlScrape(prospect.sourceUrl);
  if (!scraped) return { ok: false, reason: "scrape_failed" };

  const snippet = buildEnrichmentSnippet(scraped.markdown);
  const enrichment = {
    ...(prospect.enrichment as Record<string, unknown>),
    website: { snippet, url: prospect.sourceUrl, scrapedAt: new Date().toISOString() },
  };

  let discoveredEmail: string | null = null;
  if (!prospect.email) {
    const candidate = extractGenericEmail(scraped.markdown);
    if (candidate && (await findOutreachSuppressed(db, [candidate])).size === 0) {
      discoveredEmail = candidate;
    }
  }

  const result = await updateProspect(db, companyId, prospectId, {
    enrichment,
    ...(discoveredEmail ? { email: discoveredEmail } : {}),
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason === "duplicate_email" ? "duplicate_email" : "not_found" };
  }
  return { ok: true, prospect: result.prospect };
}

export interface EnrichBatchOutcome {
  prospectId: string;
  ok: boolean;
  reason?: "not_found" | "no_source_url" | "scrape_failed" | "duplicate_email";
}

/** Runs enrichment for each id in turn (Firecrawl has no documented concurrency budget — see the `/webscrape` skill). */
export async function enrichProspects(
  db: Db,
  companyId: string,
  prospectIds: string[],
): Promise<EnrichBatchOutcome[]> {
  const outcomes: EnrichBatchOutcome[] = [];
  for (const prospectId of prospectIds) {
    const result = await enrichProspectFromWebsite(db, companyId, prospectId);
    outcomes.push(
      result.ok
        ? { prospectId, ok: true }
        : { prospectId, ok: false, reason: result.reason },
    );
  }
  return outcomes;
}
