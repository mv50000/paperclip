import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
export const MIGRATION_001_FILE = "001_rk9_ads_ledger.sql";
export const MIGRATION_001 = fileURLToPath(new URL(`../migrations/${MIGRATION_001_FILE}`, import.meta.url));

export const COMPANY_A = "11111111-1111-4111-8111-111111111111";
export const COMPANY_B = "22222222-2222-4222-8222-222222222222";
export const COMPANY_UNCONFIGURED = "33333333-3333-4333-8333-333333333333";

export const SECRET_A_META = "aaaaaaaa-0000-4000-8000-00000000000a";
export const SECRET_A_BOT = "aaaaaaaa-0000-4000-8000-00000000000b";
export const SECRET_B_META = "bbbbbbbb-0000-4000-8000-00000000000a";

/** Loads a repo source module the plugin does not depend on (test-only). */
export async function importRepoModule<T>(relativePath: string): Promise<T> {
  return (await import(/* @vite-ignore */ new URL(`../../../../${relativePath}`, import.meta.url).href)) as T;
}

export function secretRef(secretId: string) {
  return { type: "secret_ref", secretId, version: "latest" };
}

/** A minimal valid brand config. */
export function brandConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brandCode: "OLL",
    monthlyCapEur: 100,
    meta: {
      adAccountId: "act_29231592883113369",
      pageId: "1284777064729996",
      accessTokenRef: secretRef(SECRET_A_META),
    },
    landing: {
      allowedDomains: ["ololla.fi"],
      urls: { home: "https://www.ololla.fi/" },
    },
    ...overrides,
  };
}
