/**
 * Luo per-yritys e2e-smoke-bot-agentin ja generoi sille API-keyn.
 * Idempotentti: tunnistaa olemassa olevan agentin metadata.kind="e2e-smoke-bot" -arvolla.
 *
 * Käyttö:
 *   PAPERCLIP_BOARD_API_KEY=<board-key> pnpm tsx scripts/setup-e2e-smoke-bot.ts [--company=<slug>] [--dry-run]
 */

import { writeFile } from "node:fs/promises";
import { COMPANIES } from "../tests/e2e-companies/fixtures/companies.js";

const API_URL = process.env.PAPERCLIP_API_URL ?? "https://paperclip.rk9.fi";
const BOARD_KEY = process.env.PAPERCLIP_BOARD_API_KEY ?? "";

interface ParsedArgs {
  company?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--company=")) out.company = arg.slice("--company=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Käyttö: pnpm tsx scripts/setup-e2e-smoke-bot.ts [--company=<slug>] [--dry-run]");
      process.exit(0);
    } else {
      console.error(`Tuntematon argumentti: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!BOARD_KEY) {
  console.error("PAPERCLIP_BOARD_API_KEY env-muuttuja puuttuu.");
  process.exit(1);
}

interface Company {
  id: string;
  name: string;
  requireBoardApprovalForNewAgents?: boolean;
}

interface Agent {
  id: string;
  name: string;
  status: string;
  metadata?: Record<string, unknown> | null;
}

interface AgentApiKey {
  id: string;
  name: string;
  lastUsedAt: string | null;
}

interface CreatedKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

async function api<T>(pathPart: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${pathPart}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOARD_KEY}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${pathPart} → ${res.status}: ${body.slice(0, 600)}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

function envKeyFor(slug: string) {
  return `PAPERCLIP_API_KEY_${slug.toUpperCase().replace(/-/g, "_")}`;
}

async function findOrCreateAgent(company: Company, dryRun: boolean): Promise<Agent | null> {
  const existingAgents = await api<Agent[]>(`/api/companies/${company.id}/agents`);
  const existing = existingAgents.find((a) => {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    return meta.kind === "e2e-smoke-bot";
  });
  if (existing) {
    console.log(`  ✓ olemassa oleva agentti: ${existing.name} (${existing.id}, status=${existing.status})`);
    return existing;
  }
  if (dryRun) {
    console.log(`  [DRY-RUN] luotaisiin agentti "E2E Smoke Tarkkailija"`);
    return null;
  }

  const response = await api<{ agent: Agent; approval: unknown | null }>(
    `/api/companies/${company.id}/agent-hires`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "E2E Smoke Tarkkailija",
        role: "qa",
        title: "End-to-end smoke -tarkkailija",
        icon: "bug",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false }, maxConcurrentRuns: 1 },
        capabilities:
          "Ajaa Playwright-smoket viikoittain ja avaa tiketit failureista. " +
          "Ulkoinen systemd-timer hoitaa ajastuksen.",
        budgetMonthlyCents: 0,
        permissions: { canCreateAgents: false },
        metadata: {
          kind: "e2e-smoke-bot",
          version: 1,
          managedBy: "scripts/setup-e2e-smoke-bot.ts",
        },
      }),
    },
  );
  const created = response.agent;
  console.log(`  ✓ luotu agentti: ${created.name} (${created.id}, status=${created.status})`);
  return created;
}

async function findOrCreateKey(
  agent: Agent,
  dryRun: boolean,
): Promise<{ token: string | null; existingKey: AgentApiKey | null }> {
  const keys = await api<AgentApiKey[]>(`/api/agents/${agent.id}/keys`);
  const existing = keys.find((k) => k.name === "systemd-timer");
  if (existing) {
    console.log(
      `  ✓ olemassa oleva API-key 'systemd-timer' (id=${existing.id}, lastUsed=${existing.lastUsedAt ?? "ei koskaan"})`,
    );
    return { token: null, existingKey: existing };
  }
  if (dryRun) {
    console.log(`  [DRY-RUN] luotaisiin API-key 'systemd-timer'`);
    return { token: null, existingKey: null };
  }
  const created = await api<CreatedKey>(`/api/agents/${agent.id}/keys`, {
    method: "POST",
    body: JSON.stringify({ name: "systemd-timer" }),
  });
  console.log(`  ✓ luotu API-key '${created.name}' (id=${created.id})`);
  return { token: created.token, existingKey: null };
}

async function main() {
  const targets = COMPANIES.filter(
    (c) => !args.company || c.paperclipCompany.toLowerCase() === args.company.toLowerCase(),
  );
  if (targets.length === 0) {
    console.error(`Ei kohteita: --company=${args.company ?? ""} ei vastaa yhtäkään fixturen yritystä.`);
    process.exit(2);
  }

  const allCompanies = await api<Company[]>("/api/companies");
  const byName = new Map<string, Company>();
  for (const c of allCompanies) byName.set(c.name.toLowerCase(), c);

  const tokens: { slug: string; envKey: string; token: string }[] = [];
  const skipped: { slug: string; reason: string }[] = [];

  for (const target of targets) {
    const slug = target.paperclipCompany;
    const company = byName.get(slug.toLowerCase());
    console.log(`\n=== ${target.displayName} (slug=${slug}) ===`);
    if (!company) {
      const reason = `Ei löydy /api/companies-listalta nimellä '${slug}'`;
      console.warn(`  ⚠️  ${reason}`);
      skipped.push({ slug, reason });
      continue;
    }
    if (company.requireBoardApprovalForNewAgents) {
      console.warn(
        `  ⚠️  yritys vaatii board-hyväksynnän uusille agenteille — uusi agentti syntyy pending_approval-tilaan, eikä API-keytä voi luoda ennen hyväksyntää.`,
      );
    }
    try {
      const agent = await findOrCreateAgent(company, args.dryRun);
      if (!agent) continue;
      if (agent.status === "pending_approval") {
        const reason = `agentti pending_approval-tilassa — hyväksy UI:sta ja aja skripti uudelleen`;
        console.warn(`  ⚠️  ${reason}`);
        skipped.push({ slug, reason });
        continue;
      }
      if (agent.status === "terminated") {
        const reason = `agentti terminated-tilassa — palauta tai luo uusi käsipelillä`;
        console.warn(`  ⚠️  ${reason}`);
        skipped.push({ slug, reason });
        continue;
      }
      const { token } = await findOrCreateKey(agent, args.dryRun);
      if (token) {
        tokens.push({ slug, envKey: envKeyFor(slug), token });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ virhe: ${message}`);
      skipped.push({ slug, reason: message });
    }
  }

  console.log("\n========================================");
  if (tokens.length > 0) {
    const path = `/tmp/.e2e-smoke-tokens-${process.pid}.env`;
    const lines = tokens.map((t) => `${t.envKey}=${t.token}`).join("\n") + "\n";
    await writeFile(path, lines, { mode: 0o600 });
    console.log(`Tallennettu ${tokens.length} tokenia tiedostoon ${path} (mode 0600).`);
    console.log(`Siirrä ne /etc/default/paperclip-e2e-companies-tiedostoon esim:`);
    console.log(`  sudo bash -c "cat ${path} >> /etc/default/paperclip-e2e-companies"`);
    console.log(`  sudo chmod 0600 /etc/default/paperclip-e2e-companies`);
    console.log(`  shred -u ${path}`);
    console.log(`\nToken-esikatselu:`);
    for (const t of tokens) {
      console.log(`  ${t.envKey}=${t.token.slice(0, 12)}...${t.token.slice(-6)}`);
    }
  } else if (args.dryRun) {
    console.log(`Dry-run valmis. Aja ilman --dry-run-flagia luodaksesi resurssit.`);
  } else {
    console.log(`Ei uusia tokeneita generoituna (kaikilla agenteilla on jo systemd-timer-key, tai ohitettiin).`);
  }
  if (skipped.length > 0) {
    console.log(`\nOhitetut yritykset:`);
    for (const s of skipped) console.log(`  - ${s.slug}: ${s.reason}`);
  }
  console.log("========================================");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
