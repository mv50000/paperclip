import type { PaperclipPluginManifestV1, PluginCapability } from "@paperclipai/plugin-sdk";
import { BRAND_CONFIG_JSON_SCHEMA } from "./config.js";
import { FEATURE_DECLARATIONS } from "./features/declarations.js";

/**
 * Plugin key. The database namespace hash is derived from it, so renaming it
 * orphans every applied migration. tests/manifest.spec.ts pins it.
 */
export const PLUGIN_ID = "rk9-ads";
export const PLUGIN_VERSION = "0.1.0";
export const DATABASE_NAMESPACE_SLUG = "rk9_ads";

/**
 * The full capability set, frozen at install (G11). Adding a capability later
 * moves the installed plugin to upgrade_pending until the operator approves it
 * again, so every later child's needs are declared here. No approvals.* and no
 * budget capability: the spend gate is plugin-owned (G1).
 */
export const CAPABILITIES = [
  "http.outbound",
  "secrets.read-ref",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "database.namespace.migrate",
  "database.namespace.read",
  "database.namespace.write",
  "plugin.state.read",
  "plugin.state.write",
  "activity.log.write",
  "companies.read",
  "issues.create",
  "agent.tools.register",
  "ui.page.register",
  "ui.sidebar.register",
  "ui.dashboardWidget.register",
  "instance.settings.register",
] as const satisfies readonly PluginCapability[];

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "RK9 Ads",
  description:
    "Brand-agnostic Meta ads engine: per-company brand config, creative publishing, plugin-owned Telegram spend gate, spend guard, insights and pause rules.",
  author: "RK9",
  categories: ["automation", "connector", "ui"],
  capabilities: [...CAPABILITIES],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: BRAND_CONFIG_JSON_SCHEMA as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  database: {
    namespaceSlug: DATABASE_NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  jobs: FEATURE_DECLARATIONS.flatMap((feature) => feature.jobs ?? []),
  webhooks: FEATURE_DECLARATIONS.flatMap((feature) => feature.webhooks ?? []),
  apiRoutes: FEATURE_DECLARATIONS.flatMap((feature) => feature.apiRoutes ?? []),
  tools: FEATURE_DECLARATIONS.flatMap((feature) => feature.tools ?? []),
  ui: {
    slots: FEATURE_DECLARATIONS.flatMap((feature) => feature.uiSlots ?? []),
  },
};

export default manifest;
