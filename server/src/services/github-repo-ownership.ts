import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companySecrets, projectWorkspaces } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";

// RK9-486: which companies own a GitHub repo. The auto-close webhook uses this so
// a merged PR in one company's repo cannot close another company's issue.
// Sources (all additive, the union is the owner set):
//   1. company secret `github.repo_full_name` (the mapping the Slack github router
//      already uses; ONE `owner/repo` value, because the router matches it exactly)
//   2. project workspace `repo_url` of the company (covers repos the secret lacks)
//   3. built-in fork mapping below, so the legit flows keep closing issues on a
//      fresh install without any operator step (prod RK9, LIV and MAJ have neither a
//      secret nor a workspace repo_url)
export const REPO_OWNERSHIP_SECRET_NAME = "github.repo_full_name";
const REPO_OWNERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;

// Repo (lowercase `owner/repo`) -> issue prefixes of the companies that own it.
// Resolved to company ids through `companies.issue_prefix`. Mirrors the company table
// in the operator docs; add a row when a company gets a new repo.
export const BUILTIN_REPO_ISSUE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "mv50000/paperclip": ["RK9", "SEC"],
  "rk9-ai/saatavilla": ["SAA"],
  "rk9-ai/alli-audit": ["ALL", "RK"],
  "rk9-ai/quantimodo-rust": ["QUA"],
  "rk9-ai/bk": ["OLL"],
  "mv50000/bk": ["OLL"],
  "rk9-ai/sunspot": ["AUR"],
  "rk9-ai/uutisvertailu": ["UUT"],
  "rk9-ai/liigaveikkaus": ["LIV"],
  "rk9-ai/last-shadow": ["TLN"],
  "rk9-ai/onni-ja-alma": ["ONA"],
  "rk9-ai/kotimajava": ["MAJ"],
};

/** Lowercased `owner/repo` from a GitHub URL, scp-style remote or bare `owner/repo`; null if none. */
export function normalizeGithubRepo(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const urlMatch = raw.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2]}`.toLowerCase();
  const bare = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (bare) return `${bare[1]}/${bare[2]}`.toLowerCase();
  return null;
}

export interface GithubRepoOwnership {
  /** Ids of the companies that own `repoFullName` (case-insensitive); empty when the repo is unmapped. */
  companiesOwningRepo(repoFullName: string): Promise<Set<string>>;
  invalidate(): void;
}

export function createGithubRepoOwnership(db: Db): GithubRepoOwnership {
  const secrets = secretService(db);
  let cache: { map: Map<string, Set<string>>; fetchedAt: number } | null = null;

  async function load(): Promise<Map<string, Set<string>>> {
    if (cache && Date.now() - cache.fetchedAt < REPO_OWNERSHIP_CACHE_TTL_MS) return cache.map;

    const map = new Map<string, Set<string>>();
    const add = (repo: string | null, companyId: string) => {
      if (!repo) return;
      const owners = map.get(repo) ?? new Set<string>();
      owners.add(companyId);
      map.set(repo, owners);
    };

    // A map built from a failed secret read is incomplete: serve it for this request but
    // do not cache it, so a transient decrypt error does not skip closes for 5 minutes.
    let complete = true;

    const secretRows = await db
      .select({ id: companySecrets.id, companyId: companySecrets.companyId })
      .from(companySecrets)
      .where(and(eq(companySecrets.name, REPO_OWNERSHIP_SECRET_NAME), ne(companySecrets.status, "deleted")));
    for (const row of secretRows) {
      try {
        const value = await secrets.resolveSecretValue(row.companyId, row.id, "latest");
        add(normalizeGithubRepo(value), row.companyId);
      } catch (err) {
        complete = false;
        logger.warn({ err, companyId: row.companyId }, "failed to resolve github.repo_full_name for repo ownership");
      }
    }

    const workspaceRows = await db
      .select({ companyId: projectWorkspaces.companyId, repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(isNotNull(projectWorkspaces.repoUrl));
    for (const row of workspaceRows) add(normalizeGithubRepo(row.repoUrl), row.companyId);

    const prefixes = [...new Set(Object.values(BUILTIN_REPO_ISSUE_PREFIXES).flat())];
    const companyRows = await db
      .select({ id: companies.id, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(inArray(companies.issuePrefix, prefixes));
    const companyIdByPrefix = new Map(companyRows.map((row) => [row.issuePrefix.toUpperCase(), row.id]));
    for (const [repo, repoPrefixes] of Object.entries(BUILTIN_REPO_ISSUE_PREFIXES)) {
      for (const prefix of repoPrefixes) {
        const companyId = companyIdByPrefix.get(prefix);
        if (companyId) add(repo, companyId);
      }
    }

    if (complete) cache = { map, fetchedAt: Date.now() };
    return map;
  }

  return {
    async companiesOwningRepo(repoFullName) {
      const repo = normalizeGithubRepo(repoFullName);
      if (!repo) return new Set();
      return new Set((await load()).get(repo) ?? []);
    },
    invalidate() {
      cache = null;
    },
  };
}
