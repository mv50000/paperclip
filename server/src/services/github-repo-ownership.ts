import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, projectWorkspaces } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { logger } from "../middleware/logger.js";

// RK9-486: which companies own a GitHub repo. The auto-close webhook uses this so
// a merged PR in one company's repo cannot close another company's issue.
// Sources, in order of authority:
//   1. company secret `github.repo_full_name` (the mapping the Slack github router
//      already uses; one or more `owner/repo` values separated by comma or space)
//   2. project workspace `repo_url` of the company (covers repos the secret lacks)
export const REPO_OWNERSHIP_SECRET_NAME = "github.repo_full_name";
const REPO_OWNERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;

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

    const secretRows = await db
      .select({ id: companySecrets.id, companyId: companySecrets.companyId })
      .from(companySecrets)
      .where(and(eq(companySecrets.name, REPO_OWNERSHIP_SECRET_NAME), ne(companySecrets.status, "deleted")));
    for (const row of secretRows) {
      try {
        const value = await secrets.resolveSecretValue(row.companyId, row.id, "latest");
        for (const part of value.split(/[\s,]+/)) add(normalizeGithubRepo(part), row.companyId);
      } catch (err) {
        logger.warn({ err, companyId: row.companyId }, "failed to resolve github.repo_full_name for repo ownership");
      }
    }

    const workspaceRows = await db
      .select({ companyId: projectWorkspaces.companyId, repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(isNotNull(projectWorkspaces.repoUrl));
    for (const row of workspaceRows) add(normalizeGithubRepo(row.repoUrl), row.companyId);

    cache = { map, fetchedAt: Date.now() };
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
