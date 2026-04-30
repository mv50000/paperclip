/**
 * esbuild configuration for building the paperclipai CLI for npm.
 *
 * Bundles all workspace packages (@paperclipai/*) into a single file.
 * Direct CLI npm dependencies remain external regular dependencies; transitive
 * dependencies used only by bundled workspace packages are bundled too.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the CLI.
// Note: "server" is excluded — it's published separately and resolved at runtime.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/openclaw-gateway",
];

// Workspace packages that should NOT be bundled — they'll be published
// to npm and resolved at runtime (e.g. @paperclipai/server uses dynamic import).
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// Collect CLI-owned external npm package names. Dependencies that only come from
// bundled workspace packages must stay bundled or the published CLI can miss
// runtime modules that are not listed in cli/package.json.
const externals = new Set();
const cliPackage = JSON.parse(readFileSync(resolve(repoRoot, "cli", "package.json"), "utf8"));
for (const name of Object.keys(cliPackage.dependencies || {})) {
  if (externalWorkspacePackages.has(name) || !name.startsWith("@paperclipai/")) {
    externals.add(name);
  }
}
for (const name of Object.keys(cliPackage.optionalDependencies || {})) {
  externals.add(name);
}

// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
};
