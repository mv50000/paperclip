/**
 * PRH-Prospector — baseline-vertailuajojen runner.
 *
 * Käyttö:
 *   tsx skills/prh-prospector/scripts/baseline-run.ts <yritys> <Y-tunnus>...
 *
 * Esim:
 *   tsx skills/prh-prospector/scripts/baseline-run.ts alli-audit 0114162-2 1755797-9
 *
 * Output: aggregaatti-JSON stdoutiin (datapiste-kattavuus per yritys + sample
 * yritys-tasolla), yksittäiset jsonl-haut polkuun
 * /var/lib/paperclip/prh-prospector/baseline/{yritys}/{Y-tunnus}.jsonl.
 *
 * Tarkoitus: 4-6 viikon Vainu-vertailussa baseline-luvut, joista voidaan
 * mitata PRH+AI -kattavuus % Vainun datapisteistä.
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = "/home/rk9admin/paperclip";
const BASELINE_DIR = "/var/lib/paperclip/prh-prospector/baseline";

interface PrhLookupOutput {
  query: string;
  totalResults: number;
  returned: number;
  companies: Array<{
    businessId: string;
    names: { primary: string; aliases: string[]; previous: string[] };
    mainBusinessLine: { code: string; description: string } | null;
    companyForm: string | null;
    status: "active" | "inactive";
    founded: string;
    addresses: Array<{
      type: "visiting" | "postal";
      street: string | null;
      postCode: string;
      city: string;
      municipalityCode: string;
    }>;
    registers: Array<{ register: string; description: string; registrationDate: string }>;
  }>;
}

interface EnrichOutput {
  businessId: string;
  prh: {
    name: string;
    mainBusinessLine: string | null;
    city: string | null;
  };
  website: {
    url: string;
    status: number | null;
    title: string | null;
    metaDescription: string | null;
    htmlBytes: number;
    links: Array<{ type: string; url: string }>;
    error?: string;
  } | null;
  triedUrls: string[];
}

function runScript<T>(args: string[]): T | null {
  const r = spawnSync("pnpm", ["exec", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0 || !r.stdout) {
    return null;
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

interface CompanyMetrics {
  businessId: string;
  prhFound: boolean;
  name: string | null;
  hasMainBusinessLine: boolean;
  hasVisitingAddress: boolean;
  hasPostalAddress: boolean;
  registerCount: number;
  isVatRegistered: boolean;
  isEmployerRegistered: boolean;
  hasCompanyForm: boolean;
  hasFoundedDate: boolean;
  // Enrichment
  websiteFound: boolean;
  websiteUrl: string | null;
  websiteHttpStatus: number | null;
  websiteHasTitle: boolean;
  websiteHasMetaDescription: boolean;
  socialMediaCount: number;
  socialMediaPlatforms: string[];
}

function computeMetrics(prh: PrhLookupOutput | null, enrich: EnrichOutput | null): CompanyMetrics {
  const c = prh?.companies?.[0];
  const w = enrich?.website;
  return {
    businessId: prh?.query ?? enrich?.businessId ?? "?",
    prhFound: !!c,
    name: c?.names.primary ?? null,
    hasMainBusinessLine: !!c?.mainBusinessLine,
    hasVisitingAddress: !!c?.addresses?.find((a) => a.type === "visiting"),
    hasPostalAddress: !!c?.addresses?.find((a) => a.type === "postal"),
    registerCount: c?.registers?.length ?? 0,
    isVatRegistered: !!c?.registers?.some((r) => r.register === "ALV-rekisteri"),
    isEmployerRegistered: !!c?.registers?.some((r) => r.register === "Työnantajarekisteri"),
    hasCompanyForm: !!c?.companyForm,
    hasFoundedDate: !!c?.founded,
    websiteFound: !!w && w.status === 200 && w.htmlBytes > 1000,
    websiteUrl: w?.url ?? null,
    websiteHttpStatus: w?.status ?? null,
    websiteHasTitle: !!w?.title,
    websiteHasMetaDescription: !!w?.metaDescription,
    socialMediaCount: w?.links?.length ?? 0,
    socialMediaPlatforms: w?.links?.map((l) => l.type) ?? [],
  };
}

function aggregate(metrics: CompanyMetrics[]) {
  const n = metrics.length;
  const found = metrics.filter((m) => m.prhFound);
  const enriched = metrics.filter((m) => m.websiteFound);
  return {
    sampleSize: n,
    prhFoundPct: Math.round((found.length / n) * 100),
    avgRegisterCount: found.length > 0
      ? +(found.reduce((s, m) => s + m.registerCount, 0) / found.length).toFixed(1)
      : 0,
    pctWithMainBusinessLine: Math.round((found.filter((m) => m.hasMainBusinessLine).length / Math.max(found.length, 1)) * 100),
    pctWithVisitingAddress: Math.round((found.filter((m) => m.hasVisitingAddress).length / Math.max(found.length, 1)) * 100),
    pctVatRegistered: Math.round((found.filter((m) => m.isVatRegistered).length / Math.max(found.length, 1)) * 100),
    pctEmployerRegistered: Math.round((found.filter((m) => m.isEmployerRegistered).length / Math.max(found.length, 1)) * 100),
    websiteFoundPct: Math.round((enriched.length / n) * 100),
    avgSocialMediaPerEnriched: enriched.length > 0
      ? +(enriched.reduce((s, m) => s + m.socialMediaCount, 0) / enriched.length).toFixed(1)
      : 0,
    socialPlatformDistribution: (() => {
      const dist: Record<string, number> = {};
      enriched.forEach((m) => m.socialMediaPlatforms.forEach((p) => { dist[p] = (dist[p] ?? 0) + 1; }));
      return dist;
    })(),
  };
}

function logToBaseline(target: string, businessId: string, payload: object) {
  const dir = `${BASELINE_DIR}/${target}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = `${dir}/${businessId}.jsonl`;
  appendFileSync(path, JSON.stringify({ ...payload, loggedAt: new Date().toISOString() }) + "\n");
}

async function main() {
  const target = process.argv[2];
  const ids = process.argv.slice(3);
  if (!target || ids.length === 0) {
    console.error("Käyttö: tsx baseline-run.ts <alli-audit|saatavilla|ololla> <Y-tunnus>...");
    process.exit(1);
  }

  const results: CompanyMetrics[] = [];

  for (const id of ids) {
    process.stderr.write(`[${target}] ${id} ... `);
    const prh = runScript<PrhLookupOutput>(["skills/prh-prospector/scripts/prh-lookup.ts", id]);
    const enrich = runScript<EnrichOutput>(["skills/prh-prospector/scripts/enrich-fetch.ts", id]);
    const m = computeMetrics(prh, enrich);
    results.push(m);
    logToBaseline(target, id, { prh, enrich, metrics: m });
    process.stderr.write(`prh=${m.prhFound ? "✓" : "✗"} site=${m.websiteFound ? "✓" : "✗"} social=${m.socialMediaCount}\n`);
  }

  const summary = {
    target,
    runAt: new Date().toISOString(),
    aggregate: aggregate(results),
    perCompany: results,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: "baseline_failed", message: String(err) }));
  process.exit(3);
});
