import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { Command } from "commander";
import { OUTREACH_TEMPLATE_COMPANIES, type CreateOutreachProspect, type OutreachTemplateCompany } from "@paperclipai/shared";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

// RK9-196: personalization + approval gate. Import PRH-prospector output,
// enrich via Firecrawl, draft with Claude, and review (approve/edit/reject)
// — one company at a time, mirroring the company-scoped outreach API.

interface OutreachProspect {
  id: string;
  orgName: string;
  email: string | null;
  status: string;
  sourceUrl: string | null;
}

interface OutreachMessage {
  id: string;
  prospectId: string;
  subject: string;
  bodyText: string;
  status: string;
  sequenceName?: string | null;
}

// --- import ------------------------------------------------------------

/** Known AI-enrichment keys the prh-prospector skill may attach at the top level of a record. */
const AI_ENRICHMENT_KEYS = [
  "techStack",
  "socialMedia",
  "recruitmentSignals",
  "eaaRelevance",
  "eaaReasoning",
  "industryTag",
  "confidence",
] as const;

/**
 * Maps one record from the PRH-prospector skill's output (either
 * `prh-lookup.ts`'s `NormalizedCompany` shape or `enrich-fetch.ts`'s
 * `{prh, website, ...}` shape — both external to this repo) to the
 * `CreateOutreachProspect` payload this API accepts. Unknown/extra fields on
 * the record are ignored rather than rejected, since the skill's output
 * format is not this repo's to version.
 */
export function mapPrhRecordToProspect(record: Record<string, unknown>): CreateOutreachProspect {
  const names = record.names as { primary?: string } | undefined;
  const prh = record.prh as { name?: string; businessId?: string } | undefined;
  const website = record.website as { finalUrl?: string; url?: string } | undefined;

  const orgName = (record.orgName as string | undefined) ?? names?.primary ?? prh?.name;
  if (!orgName) throw new Error("record has no org name (expected orgName, names.primary, or prh.name)");

  const businessId = (record.businessId as string | undefined) ?? prh?.businessId ?? null;
  const sourceUrl = (record.sourceUrl as string | undefined) ?? website?.finalUrl ?? website?.url ?? null;
  const email = (record.email as string | undefined) ?? null;

  const enrichment: Record<string, unknown> =
    (record.enrichment as Record<string, unknown> | undefined) ??
    Object.fromEntries(AI_ENRICHMENT_KEYS.filter((key) => key in record).map((key) => [key, record[key]]));

  return {
    orgName,
    businessId: businessId ?? undefined,
    email,
    source: (record.source as CreateOutreachProspect["source"]) ?? "prh",
    sourceUrl: sourceUrl ?? undefined,
    legalBasis: "b2b_legitimate_interest",
    enrichment,
  };
}

/** Accepts either a bare array or `{companies: [...]}` (prh-lookup.ts's own envelope). */
export function parsePrhImportFile(raw: string): Record<string, unknown>[] {
  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed) ? parsed : (parsed as { companies?: unknown[] }).companies;
  if (!Array.isArray(records)) throw new Error("expected a JSON array or an object with a `companies` array");
  return records as Record<string, unknown>[];
}

// --- review formatting (pure, unit-testable) ----------------------------

export function formatProspectLine(prospect: OutreachProspect): string {
  return `${pc.bold(prospect.orgName)} <${prospect.email ?? pc.dim("(ei osoitetta)")}> [${prospect.status}]`;
}

export function formatMessageForReview(message: OutreachMessage, prospect: OutreachProspect | undefined): string {
  const lines = [
    formatProspectLine(prospect ?? { id: message.prospectId, orgName: "(tuntematon)", email: null, status: "?", sourceUrl: null }),
    `${pc.dim("Sequence:")} ${message.sequenceName ?? pc.yellow("(none)")}`,
    `${pc.dim("Subject:")} ${message.subject}`,
    "",
    message.bodyText,
  ];
  return lines.join("\n");
}

export type ReviewChoice = { action: "approve" } | { action: "edit" } | { action: "reject"; reason: string } | { action: "skip" } | { action: "quit" };

/** Parses one line of review-tool input. `null` means "ask again" (unrecognized). */
export function parseReviewChoice(input: string): ReviewChoice | null {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "a") return { action: "approve" };
  if (lower === "e") return { action: "edit" };
  if (lower === "s") return { action: "skip" };
  if (lower === "q") return { action: "quit" };
  if (lower === "r" || lower.startsWith("r ")) {
    const reason = trimmed.slice(1).trim();
    return { action: "reject", reason: reason || "ei syytä annettu" };
  }
  return null;
}

// --- registration --------------------------------------------------------

interface CompanyOption extends BaseClientOptions {
  status?: string;
  limit?: string;
  company?: string;
  maxCost?: string;
  sequence?: string;
}

export function registerOutreachCommands(program: Command): void {
  const outreach = program.command("outreach").description("PRH import, enrichment, AI drafting and review gate (RK9-196)");

  addCommonClientOptions(
    outreach
      .command("import <file>")
      .description("Import PRH-prospector output (JSON) as outreach prospects")
      .action(async (file: string, opts: CompanyOption) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const raw = await readFile(file, "utf8");
          const records = parsePrhImportFile(raw);
          const prospects = records.map(mapPrhRecordToProspect);
          const result = await ctx.api.post(`/api/companies/${ctx.companyId}/outreach/prospects/import`, { prospects });
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    outreach
      .command("enrich")
      .description("Scrape each prospect's website via Firecrawl and fill in `enrichment` (+ e-mail if missing)")
      .option("--status <status>", "Prospect status to target", "new")
      .option("--limit <n>", "Max prospects to enrich in this run", "50")
      .action(async (opts: CompanyOption) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const prospects = await ctx.api.get<OutreachProspect[]>(
            `/api/companies/${ctx.companyId}/outreach/prospects?status=${encodeURIComponent(opts.status ?? "new")}&limit=${encodeURIComponent(opts.limit ?? "50")}`,
          );
          const candidateIds = (prospects ?? []).filter((p) => p.sourceUrl).map((p) => p.id);
          if (candidateIds.length === 0) {
            printOutput({ results: [] }, { json: ctx.json, label: "No prospects with a source URL to enrich" });
            return;
          }
          const result = await ctx.api.post(`/api/companies/${ctx.companyId}/outreach/prospects/enrich`, {
            prospectIds: candidateIds,
          });
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    outreach
      .command("draft")
      .description("Draft first-touch messages with Claude for prospects that have an address")
      .requiredOption("--company <slug>", `Template to use (${OUTREACH_TEMPLATE_COMPANIES.join("|")})`)
      .option("--status <status>", "Prospect status to target", "new")
      .option("--limit <n>", "Max prospects to draft in this run", "50")
      .option("--max-cost <usd>", "Stop once estimated Claude spend reaches this many dollars", "1")
      // RK9-224: without this, the server resolves the company's one active
      // sequence for --company's template, or 422s `sequence_required` if
      // that isn't unique — it never guesses.
      .option("--sequence <id>", "Sequence to attach the drafts to (defaults to the company's one active sequence for --company)")
      .action(async (opts: CompanyOption) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const company = opts.company as OutreachTemplateCompany;
          if (!(OUTREACH_TEMPLATE_COMPANIES as readonly string[]).includes(company)) {
            throw new Error(`--company must be one of: ${OUTREACH_TEMPLATE_COMPANIES.join(", ")}`);
          }
          const prospects = await ctx.api.get<OutreachProspect[]>(
            `/api/companies/${ctx.companyId}/outreach/prospects?status=${encodeURIComponent(opts.status ?? "new")}&limit=${encodeURIComponent(opts.limit ?? "50")}`,
          );
          const candidateIds = (prospects ?? []).filter((p) => p.email).map((p) => p.id);
          if (candidateIds.length === 0) {
            printOutput({ drafted: 0 }, { json: ctx.json, label: "No prospects with an e-mail address to draft for" });
            return;
          }
          const result = await ctx.api.post(`/api/companies/${ctx.companyId}/outreach/messages/draft`, {
            prospectIds: candidateIds,
            company,
            sequenceId: opts.sequence,
            maxCostUsd: Number(opts.maxCost ?? 1),
          });
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    outreach
      .command("review")
      .description("Interactively approve (a) / edit (e) / reject (r <reason>) / skip (s) drafted messages")
      .action(async (opts: CompanyOption) => {
        try {
          await runReview(opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function runReview(opts: CompanyOption): Promise<void> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const messages = (await ctx.api.get<OutreachMessage[]>(
    `/api/companies/${ctx.companyId}/outreach/messages?status=draft&limit=1000`,
  )) ?? [];
  if (messages.length === 0) {
    console.log(pc.dim("No draft messages to review."));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let reviewed = 0;
    for (const message of messages) {
      const prospect = (await ctx.api.get<OutreachProspect>(
        `/api/companies/${ctx.companyId}/outreach/prospects/${message.prospectId}`,
      )) ?? undefined;
      console.log("");
      console.log(formatMessageForReview(message, prospect));
      console.log(pc.dim("[a]pprove  [e]dit  [r <reason>]eject  [s]kip  [q]uit"));

      const answer = await rl.question("> ");
      const choice = parseReviewChoice(answer);
      if (!choice) {
        console.log(pc.yellow("Not understood, skipping."));
        continue;
      }
      if (choice.action === "quit") break;
      if (choice.action === "skip") continue;

      if (choice.action === "edit") {
        const subject = (await rl.question(`Subject [${message.subject}]: `)).trim() || message.subject;
        console.log(pc.dim("New body (single line; leave empty to keep current):"));
        const bodyText = (await rl.question("> ")).trim() || message.bodyText;
        await ctx.api.patch(`/api/companies/${ctx.companyId}/outreach/messages/${message.id}`, { subject, bodyText });
        console.log(pc.green("Saved. Re-run review to approve/reject the edited draft."));
        reviewed += 1;
        continue;
      }

      if (choice.action === "reject") {
        await ctx.api.post(`/api/companies/${ctx.companyId}/outreach/messages/${message.id}/reject`, {
          reason: choice.reason,
        });
        console.log(pc.red("Rejected."));
        reviewed += 1;
        continue;
      }

      // approve — a prospect still `new` cannot receive an approved message
      // (see docs/implementation-notes/outreach-data-model.md's state
      // machine); approving a specific draft is the human decision that
      // this prospect is worth contacting, so promote it first.
      try {
        await ctx.api.post(`/api/companies/${ctx.companyId}/outreach/messages/${message.id}/approve`, {});
        console.log(pc.green("Approved."));
      } catch (err) {
        if (err instanceof ApiRequestError && err.message === "prospect_not_contactable") {
          await ctx.api.patch(`/api/companies/${ctx.companyId}/outreach/prospects/${message.prospectId}`, { status: "approved" });
          await ctx.api.post(`/api/companies/${ctx.companyId}/outreach/messages/${message.id}/approve`, {});
          console.log(pc.green("Approved (prospect promoted to approved)."));
        } else {
          throw err;
        }
      }
      reviewed += 1;
    }
    console.log("");
    console.log(pc.dim(`Reviewed ${reviewed}/${messages.length} draft(s).`));
  } finally {
    rl.close();
  }
}
