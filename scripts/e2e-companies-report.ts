#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMPANIES, type CompanyTarget } from "../tests/e2e-companies/fixtures/companies";

interface PlaywrightTestResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  errors?: { message?: string }[];
  attachments?: { name: string; contentType: string; path?: string }[];
}

interface PlaywrightTest {
  projectName: string;
  results: PlaywrightTestResult[];
}

interface PlaywrightSpec {
  title: string;
  file: string;
  tests: PlaywrightTest[];
}

interface PlaywrightSuite {
  title?: string;
  file?: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface FlatSpec {
  describePath: string;
  spec: PlaywrightSpec;
}

interface PlaywrightReport {
  suites: PlaywrightSuite[];
  stats?: { startTime: string; duration: number };
}

interface FailureRecord {
  company: CompanyTarget;
  testTitle: string;
  specFile: string;
  errorMessage: string;
  attachmentPaths: string[];
}

interface CompanySummary {
  company: CompanyTarget;
  passed: number;
  failed: number;
  skipped: number;
  failures: FailureRecord[];
}

interface PreviousRun {
  timestamp: string;
  failures: { company: string; testTitle: string }[];
}

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const RESULTS_DIR = process.env.E2E_COMPANIES_RESULTS_DIR ?? path.join(ROOT, "tests/e2e-companies/test-results");
const RESULTS_JSON = path.join(RESULTS_DIR, "results.json");
const STATE_PATH = process.env.E2E_COMPANIES_STATE_PATH ?? path.join(ROOT, "tests/e2e-companies/.last-run.json");
const REPORT_URL_BASE = process.env.E2E_COMPANIES_REPORT_URL ?? "";

const API_URL = process.env.PAPERCLIP_API_URL ?? "https://paperclip.rk9.fi";

function envKeyForSlug(slug: string) {
  return `PAPERCLIP_API_KEY_${slug.toUpperCase().replace(/-/g, "_")}`;
}

function buildTokenMap(): { tokens: Map<string, string>; missing: string[] } {
  const tokens = new Map<string, string>();
  const missing: string[] = [];
  for (const co of COMPANIES) {
    const slug = co.paperclipCompany.toLowerCase();
    const value = process.env[envKeyForSlug(slug)]?.trim();
    if (value) tokens.set(slug, value);
    else missing.push(slug);
  }
  return { tokens, missing };
}

const TOKENS = buildTokenMap();
const DRY_RUN_FLAG = process.argv.includes("--dry-run");
const DRY_RUN = DRY_RUN_FLAG || TOKENS.tokens.size === 0;

function flattenSpecs(suite: PlaywrightSuite, parents: string[] = []): FlatSpec[] {
  const out: FlatSpec[] = [];
  const path = suite.title && !suite.file ? [...parents, suite.title] : parents;
  if (suite.specs) {
    for (const spec of suite.specs) out.push({ describePath: path.join(" › "), spec });
  }
  if (suite.suites) {
    for (const inner of suite.suites) out.push(...flattenSpecs(inner, path));
  }
  return out;
}

function readReport(): PlaywrightReport {
  if (!fs.existsSync(RESULTS_JSON)) {
    throw new Error(`Playwright results not found at ${RESULTS_JSON}. Did you run pnpm test:e2e:companies first?`);
  }
  return JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8"));
}

function readPreviousRun(): PreviousRun | null {
  if (!fs.existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeCurrentRun(summaries: CompanySummary[]): void {
  const failures = summaries.flatMap((s) =>
    s.failures.map((f) => ({ company: f.company.name, testTitle: f.testTitle })),
  );
  const payload: PreviousRun = { timestamp: new Date().toISOString(), failures };
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2));
}

function summariseReport(report: PlaywrightReport): CompanySummary[] {
  const byProject = new Map<string, CompanySummary>();
  for (const co of COMPANIES) {
    byProject.set(co.name, { company: co, passed: 0, failed: 0, skipped: 0, failures: [] });
  }

  const allSpecs = report.suites.flatMap((s) => flattenSpecs(s));
  for (const { describePath, spec } of allSpecs) {
    for (const test of spec.tests) {
      const summary = byProject.get(test.projectName);
      if (!summary) continue;
      const lastResult = test.results[test.results.length - 1];
      if (!lastResult) continue;
      if (lastResult.status === "passed") summary.passed++;
      else if (lastResult.status === "skipped") summary.skipped++;
      else {
        summary.failed++;
        const errorMessage = (lastResult.errors ?? [])
          .map((e) => e.message ?? "")
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 4000);
        const attachmentPaths = (lastResult.attachments ?? [])
          .filter((a) => a.path)
          .map((a) => a.path!);
        const fullTitle = describePath ? `${describePath} › ${spec.title}` : spec.title;
        summary.failures.push({
          company: summary.company,
          testTitle: fullTitle,
          specFile: spec.file,
          errorMessage: errorMessage || "(no error message captured)",
          attachmentPaths,
        });
      }
    }
  }

  return Array.from(byProject.values());
}

interface PaperclipCompany {
  id: string;
  slug?: string;
  name?: string;
}

async function apiFetch<T>(pathPart: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${pathPart}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Paperclip API ${pathPart} -> ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

interface AgentSelf {
  agentId: string;
  companyId: string;
}

async function resolveAgentSelfPerToken(): Promise<Map<string, AgentSelf>> {
  // Per-company agent token authenticates only to its own company. GET /api/agents/me
  // returns { id, companyId, ... }. Side effect: agent_api_keys.last_used_at päivittyy.
  const result = new Map<string, AgentSelf>();
  for (const [slug, token] of TOKENS.tokens) {
    try {
      const me = await apiFetch<{ id: string; companyId: string }>("/api/agents/me", token);
      result.set(slug, { agentId: me.id, companyId: me.companyId });
    } catch (err) {
      console.warn(`⚠️  Token-validointi epäonnistui slugille "${slug}":`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

async function recordExternalRun(
  token: string,
  agentId: string,
  body: {
    status: "succeeded" | "failed";
    summary: string;
    durationMs: number;
    contextSnapshot: Record<string, unknown>;
    externalRunId: string;
  },
): Promise<void> {
  try {
    await apiFetch(`/api/agents/${agentId}/external-runs`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`⚠️  external-run rekisteröinti epäonnistui (${agentId}):`, err instanceof Error ? err.message : err);
  }
}

function buildIssueDescription(failure: FailureRecord, isRecurring: boolean): string {
  const lines: string[] = [];
  lines.push(`**E2E-smoke failasi yrityksessä ${failure.company.displayName}.**`);
  lines.push("");
  lines.push(`- **Testi:** ${failure.testTitle}`);
  lines.push(`- **Spec:** \`${failure.specFile}\``);
  lines.push(`- **Dev-URL:** ${failure.company.baseUrl}`);
  if (isRecurring) {
    lines.push(`- **Toistuva:** Sama testi failasi myös edellisessä viikoittaisessa ajossa.`);
  }
  if (REPORT_URL_BASE) {
    lines.push(`- **HTML-raportti:** ${REPORT_URL_BASE}/${failure.company.name}/`);
  }
  lines.push("");
  lines.push("## Virheviesti");
  lines.push("```");
  lines.push(failure.errorMessage);
  lines.push("```");
  if (failure.attachmentPaths.length > 0) {
    lines.push("");
    lines.push("## Liitetiedostot (palvelimella)");
    for (const p of failure.attachmentPaths) {
      lines.push(`- \`${p}\``);
    }
  }
  lines.push("");
  lines.push("## Korjauspolku");
  lines.push("1. Avaa HTML-raportti tai screenshot, varmista mitä rikki.");
  lines.push("2. Reprodusoi paikallisesti: `pnpm test:e2e:companies --project=" + failure.company.name + " --headed`.");
  lines.push("3. Korjaa juurisyy yrityksen koodikannassa, deployaa dev:iin, sulje tämä tiketti kun smoke vihreä.");
  lines.push("");
  lines.push("_Auto-generated: scripts/e2e-companies-report.ts_");
  return lines.join("\n");
}

async function createIssue(
  companyId: string,
  token: string,
  failure: FailureRecord,
  isRecurring: boolean,
): Promise<{ id: string; identifier?: string }> {
  const priority = isRecurring ? "critical" : "high";
  const title = `[E2E] ${failure.company.displayName}: ${failure.testTitle.slice(0, 80)}`;
  const description = buildIssueDescription(failure, isRecurring);

  if (DRY_RUN) {
    console.log(`[DRY-RUN] would create issue for ${failure.company.name}: "${title}" (priority=${priority})`);
    return { id: "dry-run", identifier: "DRY-0" };
  }

  return apiFetch(`/api/companies/${companyId}/issues`, token, {
    method: "POST",
    body: JSON.stringify({
      title,
      description,
      status: "todo",
      priority,
    }),
  });
}

function previousFailureKeys(prev: PreviousRun | null): Set<string> {
  if (!prev) return new Set();
  return new Set(prev.failures.map((f) => `${f.company}::${f.testTitle}`));
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    if (DRY_RUN_FLAG) {
      console.log("DRY-RUN mode (--dry-run flag): API ei kutsuta.");
    } else {
      console.log(
        "DRY-RUN mode: per-yritys-tokenit puuttuvat. Aja scripts/setup-e2e-smoke-bot.ts " +
          `ja lisää PAPERCLIP_API_KEY_<SLUG>-rivit ympäristöön. Puuttuvat: ${TOKENS.missing.join(", ")}`,
      );
    }
  } else if (TOKENS.missing.length > 0) {
    console.warn(
      `⚠️  Osa yrityksistä ei tee tikettejä — token puuttuu: ${TOKENS.missing.join(", ")}. ` +
        "Aja scripts/setup-e2e-smoke-bot.ts ja lisää puuttuvat avaimet.",
    );
  }

  const report = readReport();
  const summaries = summariseReport(report);
  const prev = readPreviousRun();
  const recurringKeys = previousFailureKeys(prev);

  const totalFailures = summaries.reduce((s, c) => s + c.failed, 0);
  const totalPassed = summaries.reduce((s, c) => s + c.passed, 0);

  console.log(`E2E-companies smoke yhteenveto:`);
  for (const s of summaries) {
    const tag = s.failed > 0 ? `❌ FAIL ${s.failed}` : "✅ PASS";
    console.log(`  ${s.company.name.padEnd(12)} ${tag} (passed=${s.passed}, skipped=${s.skipped})`);
  }
  console.log(`Total: ${totalPassed} passed, ${totalFailures} failed.`);

  // Resolve agent self per token. Side effect: agent_api_keys.last_used_at päivittyy.
  let agentSelfMap: Map<string, AgentSelf>;
  try {
    agentSelfMap = DRY_RUN ? new Map() : await resolveAgentSelfPerToken();
  } catch (err) {
    console.error("Agent-itsen haku epäonnistui:", err);
    writeCurrentRun(summaries);
    process.exitCode = 1;
    return;
  }

  // Per-yritys: luo failuretiketit + rekisteröi external-run heartbeat_runs:iin.
  const runStartedAt = report.stats?.startTime ? new Date(report.stats.startTime).getTime() : Date.now();
  const totalDurationMs = report.stats?.duration ?? Math.max(0, Date.now() - runStartedAt);
  const externalRunId = `e2e-smoke-${new Date(runStartedAt).toISOString()}`;

  for (const summary of summaries) {
    const slug = summary.company.paperclipCompany.toLowerCase();
    const token = TOKENS.tokens.get(slug);
    const self = agentSelfMap.get(slug);

    // Tickets for failures
    if (summary.failures.length > 0 && !DRY_RUN) {
      if (!token || !self) {
        console.warn(
          `⚠️  Slugille "${summary.company.paperclipCompany}" puuttuu ${!token ? "token" : "agentId/companyId"} — skipataan tikettien luonti.`,
        );
      } else {
        for (const failure of summary.failures) {
          const key = `${failure.company.name}::${failure.testTitle}`;
          const isRecurring = recurringKeys.has(key);
          try {
            const issue = await createIssue(self.companyId, token, failure, isRecurring);
            console.log(
              `→ ${summary.company.name}: ${isRecurring ? "RECURRING" : "new"} failure → issue ${issue.identifier ?? issue.id}`,
            );
          } catch (err) {
            console.error(`Issue luonti epäonnistui (${summary.company.name} / ${failure.testTitle}):`, err);
            process.exitCode = 1;
          }
        }
      }
    }

    // External-run heartbeat (vihreille ja failureille)
    if (!DRY_RUN && token && self) {
      const status: "succeeded" | "failed" = summary.failed > 0 ? "failed" : "succeeded";
      const summaryText = `passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped}`;
      await recordExternalRun(token, self.agentId, {
        status,
        summary: summaryText,
        durationMs: Math.round(totalDurationMs),
        externalRunId,
        contextSnapshot: {
          source: "scripts/e2e-companies-report.ts",
          baseUrl: summary.company.baseUrl,
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          recurringFailures: summary.failures.filter((f) =>
            recurringKeys.has(`${f.company.name}::${f.testTitle}`),
          ).length,
        },
      });
      console.log(`→ ${summary.company.name}: external-run ${status} rekisteröity`);
    }
  }

  writeCurrentRun(summaries);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
