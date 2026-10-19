import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import manifest, { CAPABILITIES, DATABASE_NAMESPACE_SLUG, PLUGIN_ID } from "../src/manifest.js";
import { FEATURE_DECLARATIONS } from "../src/features/declarations.js";
import { brandConfig, importRepoModule, MIGRATION_001, SECRET_A_BOT, secretRef } from "./fixtures.js";

/** Frozen at install (G11). Changing it forces an operator re-approval. */
const EXPECTED_CAPABILITIES = [
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
];

const EXPECTED_NAMESPACE = `plugin_rk9_ads_${createHash("sha256").update("rk9-ads").digest("hex").slice(0, 10)}`;

describe("manifest", () => {
  it("declares exactly the frozen capability set", () => {
    expect(new Set(manifest.capabilities)).toEqual(new Set(EXPECTED_CAPABILITIES));
    expect(manifest.capabilities).toHaveLength(EXPECTED_CAPABILITIES.length);
    expect([...CAPABILITIES]).toEqual(manifest.capabilities);
  });

  it("declares no approval or budget capability (the spend gate is plugin-owned)", () => {
    expect(manifest.capabilities.filter((capability) => /approv|budget/i.test(capability))).toEqual([]);
  });

  it("pins the plugin id and the derived database namespace", () => {
    expect(PLUGIN_ID).toBe("rk9-ads");
    expect(manifest.database).toEqual({
      namespaceSlug: DATABASE_NAMESPACE_SLUG,
      migrationsDir: "migrations",
      coreReadTables: ["companies"],
    });
    // Recomputed here so a PLUGIN_ID rename fails loudly.
    const recomputed = `plugin_${DATABASE_NAMESPACE_SLUG}_${createHash("sha256").update(PLUGIN_ID).digest("hex").slice(0, 10)}`;
    expect(recomputed).toBe(EXPECTED_NAMESPACE);
  });

  it("hardcodes the derived namespace in migration 001", async () => {
    const sql = readFileSync(MIGRATION_001, "utf8").replace(/--.*$/gm, "");
    const schemas = new Set(Array.from(sql.matchAll(/\b([a-z_][a-z0-9_]*)\.[a-z_][a-z0-9_]*\s*[(\s]/g), (m) => m[1]));
    schemas.delete("public");
    expect([...schemas]).toEqual([EXPECTED_NAMESPACE]);

    const server = await importRepoModule<{
      derivePluginDatabaseNamespace(pluginKey: string, namespaceSlug?: string): string;
    }>("server/src/services/plugin-database.ts");
    expect(server.derivePluginDatabaseNamespace(PLUGIN_ID, DATABASE_NAMESPACE_SLUG)).toBe(EXPECTED_NAMESPACE);
  });

  it("passes the host manifest schema and install-time capability check", async () => {
    const shared = await importRepoModule<{
      pluginManifestV1Schema: { safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } } };
    }>("packages/shared/src/index.ts");
    const parsed = shared.pluginManifestV1Schema.safeParse(manifest);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);

    const validator = await importRepoModule<{
      pluginCapabilityValidator(): {
        validateManifestCapabilities(m: PaperclipPluginManifestV1): { allowed: boolean; missing: string[] };
      };
    }>("server/src/services/plugin-capability-validator.ts");
    const result = validator.pluginCapabilityValidator().validateManifestCapabilities(manifest);
    expect(result.missing).toEqual([]);
  });

  it("passes the host config check only with secret_ref objects (a raw token is refused on save)", async () => {
    const validator = await importRepoModule<{
      validateInstanceConfig(config: Record<string, unknown>, schema: unknown): { valid: boolean; errors?: unknown[] };
    }>("server/src/services/plugin-config-validator.ts");
    const schema = manifest.instanceConfigSchema;
    expect(validator.validateInstanceConfig({}, schema).valid).toBe(true);
    expect(validator.validateInstanceConfig(brandConfig({
      telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-1", allowedUserIds: ["1"], mode: "poll" },
    }), schema).valid).toBe(true);
    const rawToken = brandConfig({
      meta: { adAccountId: "1", pageId: "2", accessTokenRef: "EAAG-raw-token-pasted-into-the-form" },
    });
    expect(validator.validateInstanceConfig(rawToken, schema).valid).toBe(false);
    expect(validator.validateInstanceConfig(brandConfig({
      telegram: { botTokenRef: "123:raw-bot-token", chatId: "-1", allowedUserIds: ["1"] },
    }), schema).valid).toBe(false);
    expect(validator.validateInstanceConfig(brandConfig({ enabled: true }), schema).valid).toBe(false);
  });

  it("uses route paths the host does not reserve", async () => {
    const shared = await importRepoModule<{
      PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS: readonly string[];
      PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS: readonly string[];
    }>("packages/shared/src/constants.ts");
    for (const slot of manifest.ui?.slots ?? []) {
      if (!slot.routePath) continue;
      expect(shared.PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS).not.toContain(slot.routePath);
      if (slot.type === "companySettingsPage") {
        expect(shared.PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS).not.toContain(slot.routePath);
      }
    }
  });

  it("resolves every UI slot to a named export of the UI entry", () => {
    const source = readFileSync(new URL("../src/ui/index.tsx", import.meta.url), "utf8");
    const exported = new Set([
      ...Array.from(source.matchAll(/export function (\w+)/g), (m) => m[1]),
      // Re-exports of the page modules: export { AdsPage } from "./AdsPage.js".
      ...Array.from(source.matchAll(/export \{([^}]+)\} from/g)).flatMap((m) => m[1]!.split(",").map((name) => name.trim())),
    ]);
    for (const slot of manifest.ui?.slots ?? []) {
      expect(exported, slot.exportName).toContain(slot.exportName);
    }
  });

  it("builds every section from the feature list", () => {
    const keys = FEATURE_DECLARATIONS.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(manifest.jobs?.map((job) => job.jobKey).sort()).toEqual([
      "digest-tick",
      "gate-expiry",
      "insights-daily-close",
      "insights-hourly",
      "rules-evaluate",
      "scheduled-pause",
      "smoke",
    ]);
    expect(manifest.jobs?.find((job) => job.jobKey === "smoke")?.schedule).toBeUndefined();
    expect(manifest.webhooks?.map((webhook) => webhook.endpointKey)).toEqual(["telegram"]);
    expect(manifest.apiRoutes?.map((route) => route.routeKey)).toEqual(["stage-creative"]);
    expect(manifest.tools?.map((tool) => tool.name).sort()).toEqual([
      "rk9ads_get_insights",
      "rk9ads_get_pacing",
      "rk9ads_list_ads",
      "rk9ads_pause_all",
      "rk9ads_stage_creative",
    ]);
    // No agent tool can activate an ad (G1): activation happens only from a Telegram tap.
    expect(manifest.tools?.map((tool) => tool.name).filter((name) => /activ|resume|unpause|scale/.test(name))).toEqual([]);
  });
});

describe("the manifest bundle (RK9-579)", () => {
  it("carries no zod, and its manifest equals the source's", async () => {
    const esbuild = await import("esbuild");
    const { createPluginBundlerPresets } = await import("@paperclipai/plugin-sdk/bundlers");
    // A runtime path: the build script is plain JS without types.
    const pluginPath = new URL("../scripts/manifest-without-zod.mjs", import.meta.url).href;
    const { manifestWithoutZod } = (await import(pluginPath)) as { manifestWithoutZod: import("esbuild").Plugin };
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
    const root = new URL("..", import.meta.url).pathname;
    const result = await esbuild.build({ ...presets.esbuild.manifest, absWorkingDir: root, plugins: [manifestWithoutZod], write: false, metafile: true, sourcemap: false });
    // esbuild parses zod (config.ts imports schema.ts) but must put none of it in the bundle.
    const [output] = Object.entries(result.metafile.outputs).filter(([path]) => path.endsWith("manifest.js"));
    const bundledInputs = Object.entries(output![1].inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path);
    expect(bundledInputs).toContain("src/config.ts");
    expect(bundledInputs.filter((input) => input.includes("node_modules/zod") || input.endsWith("features/rules/schema.ts"))).toEqual([]);
    const code = result.outputFiles.find((file) => file.path.endsWith("manifest.js"))!.text;
    const bundled = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as { default: PaperclipPluginManifestV1 };
    expect(JSON.parse(JSON.stringify(bundled.default))).toEqual(JSON.parse(JSON.stringify(manifest)));
  });
});
