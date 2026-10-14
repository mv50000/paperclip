import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GRAPH_FILE = path.join(PACKAGE_ROOT, "src", "meta", "graph.ts");
// Broader than the spec's /\bv\d{2}\.\d\b/: also v9.0 and v23.10.
const VERSION_LITERAL = /\bv\d+\.\d+\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

describe("one GRAPH_VERSION (ADR 2)", () => {
  it("no file but src/meta/graph.ts names the Graph host or a Graph version", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(PACKAGE_ROOT, "src")), ...sourceFiles(path.join(PACKAGE_ROOT, "scripts"))]) {
      if (file === GRAPH_FILE) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (line.includes("graph.facebook.com") || VERSION_LITERAL.test(line)) {
          offenders.push(`${path.relative(PACKAGE_ROOT, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("graph.ts exports exactly one GRAPH_VERSION and names the version once", () => {
    const source = readFileSync(GRAPH_FILE, "utf8");
    expect(source.match(/export const GRAPH_VERSION\b/g)).toHaveLength(1);
    expect(source).toContain('export const GRAPH_VERSION = "v23.0";');
    expect(source.match(/\bv\d+\.\d+\b/g)).toEqual(["v23.0"]);
  });
});
