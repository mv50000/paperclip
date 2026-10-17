/**
 * Real-Postgres test support for DB-backed acceptance criteria.
 *
 * The SDK harness stubs `ctx.db` (query returns [], execute returns rowCount 0),
 * so migrations and tenant isolation need a real database. This helper starts
 * the repo's embedded Postgres (core migrations applied), registers a plugin
 * row, applies the plugin's migrations through the host's own
 * `pluginDatabaseService`, and returns a `ctx.db`-compatible client that runs
 * every statement through the host's runtime SQL validators.
 *
 * Monorepo-only and test-only: it loads `@paperclipai/db` and the server
 * source at runtime, so the worker bundle and typecheck never depend on them.
 * It lives in tests/ (not src/kit/) because it is bound to this repo layout.
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import type { PaperclipPluginManifestV1, PluginDatabaseClient } from "@paperclipai/plugin-sdk";

const DB_MODULE_ID = "@paperclipai/db";
const DRIZZLE_MODULE_ID = "drizzle-orm";
const SERVER_PLUGIN_DATABASE_URL = new URL(
  "../../../../../server/src/services/plugin-database.ts",
  import.meta.url,
).href;

export const EMBEDDED_PG_TIMEOUT_MS = 120_000;

interface SqlChunk {
  readonly __sql: unique symbol;
}

interface DrizzleModule {
  sql: { raw(text: string): SqlChunk; join(chunks: SqlChunk[], separator: SqlChunk): SqlChunk } & ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => SqlChunk);
}

interface DrizzleDb {
  execute(query: SqlChunk): Promise<Iterable<Record<string, unknown>>>;
}

interface DbModule {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean; reason?: string }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
  createDb(url: string): DrizzleDb;
}

interface PluginDatabaseService {
  applyMigrations(pluginId: string, manifest: PaperclipPluginManifestV1, packageRoot: string): Promise<unknown>;
  query<T>(pluginId: string, statement: string, params?: unknown[]): Promise<T[]>;
  execute(pluginId: string, statement: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

interface ServerPluginDatabaseModule {
  derivePluginDatabaseNamespace(pluginKey: string, namespaceSlug?: string): string;
  pluginDatabaseService(db: DrizzleDb): PluginDatabaseService;
}

export interface AppliedMigration {
  migration_key: string;
  checksum: string;
  status: string;
}

export interface PluginTestDatabase {
  pluginId: string;
  namespace: string;
  /** `ctx.db`-compatible client backed by the host's validated runtime path. */
  client: PluginDatabaseClient;
  /** Applies the package migrations with the host service (idempotent). */
  applyMigrations(): Promise<void>;
  appliedMigrations(): Promise<AppliedMigration[]>;
  /** Inserts a core company row and returns its id. */
  createCompany(name: string): Promise<string>;
  /** Unvalidated admin SQL for assertions (catalog queries, fixtures). */
  adminQuery<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  cleanup(): Promise<void>;
}

async function loadDbModule(): Promise<DbModule> {
  return (await import(/* @vite-ignore */ DB_MODULE_ID)) as DbModule;
}

/** `{ supported: false, reason }` when embedded Postgres cannot start here. */
export async function embeddedPostgresSupport(): Promise<{ supported: boolean; reason?: string }> {
  try {
    return await (await loadDbModule()).getEmbeddedPostgresTestSupport();
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `describe` when embedded Postgres can start here. Otherwise a local run
 * skips the suite with a warning, and a CI run (process.env.CI set) throws:
 * the money-protection tests on real Postgres must not skip silently in CI
 * (RK9-562).
 */
export async function describeEmbeddedPostgres(suite: string): Promise<typeof describe | typeof describe.skip> {
  const support = await embeddedPostgresSupport();
  if (support.supported) return describe;
  const reason = support.reason ?? "unsupported environment";
  if (process.env.CI) throw new Error(`Embedded Postgres is required in CI for the ${suite} tests: ${reason}`);
  console.warn(`Skipping embedded Postgres ${suite} tests: ${reason}`);
  return describe.skip;
}

export async function startPluginTestDatabase(input: {
  manifest: PaperclipPluginManifestV1;
  /** Absolute path of the plugin package (the directory holding migrationsDir). */
  packageRoot: string;
  prefix?: string;
}): Promise<PluginTestDatabase> {
  const dbModule = await loadDbModule();
  const { sql } = (await import(/* @vite-ignore */ DRIZZLE_MODULE_ID)) as DrizzleModule;
  const server = (await import(/* @vite-ignore */ SERVER_PLUGIN_DATABASE_URL)) as ServerPluginDatabaseModule;

  const tempDb = await dbModule.startEmbeddedPostgresTestDatabase(input.prefix ?? "plugin-test-");
  const db = dbModule.createDb(tempDb.connectionString);
  const service = server.pluginDatabaseService(db);
  const { manifest } = input;
  const namespace = server.derivePluginDatabaseNamespace(manifest.id, manifest.database?.namespaceSlug);

  function bind(text: string, params: readonly unknown[] = []): SqlChunk {
    if (params.length === 0) return sql.raw(text);
    const chunks: SqlChunk[] = [];
    let cursor = 0;
    for (const match of text.matchAll(/\$(\d+)/g)) {
      chunks.push(sql.raw(text.slice(cursor, match.index)));
      chunks.push(sql`${params[Number(match[1]) - 1]}`);
      cursor = match.index! + match[0].length;
    }
    chunks.push(sql.raw(text.slice(cursor)));
    return sql.join(chunks, sql.raw(""));
  }

  async function adminQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return Array.from(await db.execute(bind(text, params))) as T[];
  }

  const pluginId = randomUUID();
  await adminQuery(
    `INSERT INTO plugins (id, plugin_key, package_name, version, api_version, categories, manifest_json, status, install_order)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'installed', 1)`,
    [
      pluginId,
      manifest.id,
      manifest.id,
      manifest.version,
      manifest.apiVersion,
      JSON.stringify(manifest.categories),
      JSON.stringify(manifest),
    ],
  );

  const client: PluginDatabaseClient = {
    namespace,
    query: (statement, params) => service.query(pluginId, statement, params),
    execute: (statement, params) => service.execute(pluginId, statement, params),
  };

  let companyCounter = 0;

  return {
    pluginId,
    namespace,
    client,
    async applyMigrations() {
      await service.applyMigrations(pluginId, manifest, input.packageRoot);
    },
    appliedMigrations: () =>
      adminQuery<AppliedMigration>(
        "SELECT migration_key, checksum, status FROM plugin_migrations WHERE plugin_id = $1 ORDER BY migration_key",
        [pluginId],
      ),
    async createCompany(name) {
      companyCounter += 1;
      const id = randomUUID();
      const prefix = `T${companyCounter}${id.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
      await adminQuery("INSERT INTO companies (id, name, issue_prefix) VALUES ($1, $2, $3)", [id, name, prefix]);
      return id;
    },
    adminQuery,
    cleanup: () => tempDb.cleanup(),
  };
}
