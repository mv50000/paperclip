import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const KIT_DIR = fileURLToPath(new URL("../src/kit", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("src/kit boundary (G16)", () => {
  it("imports nothing from the ads code outside src/kit", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(KIT_DIR)) {
      const source = readFileSync(file, "utf8");
      // Any relative path literal counts: import specifiers, dynamic imports and new URL(...).
      for (const match of source.matchAll(/["'`](\.{1,2}\/[^"'`]*)["'`]/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.startsWith(`${KIT_DIR}${path.sep}`)) offenders.push(`${path.relative(KIT_DIR, file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
