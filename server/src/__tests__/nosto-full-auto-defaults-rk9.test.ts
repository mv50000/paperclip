// RK9-693 (nosto prep): upstream v2026.1005 changes the full-auto defaults. The fork keeps
// tool containment (RK9-83) and the CLI engine pin (RK9-305). The behaviour tests live in
// packages/adapters/claude-local (execute.tools.test.ts, acp.test.ts, engine-availability.test.ts);
// this guard fails when the lift drops the fork code those tests rely on.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const adapterSrc = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/adapters/claude-local/src/server",
);
const read = (name: string) => readFileSync(path.join(adapterSrc, name), "utf8");

describe("full-auto defaults keep the fork pins (RK9-693)", () => {
  it("passes --disallowedTools from config.disallowedTools (RK9-83)", () => {
    const src = read("execute.ts");
    expect(src).toContain("--disallowedTools");
    expect(src).toContain("RK9-83");
  });

  it("maps an unset engine to the CLI, not ACP (RK9-305)", () => {
    const src = read("execute.ts");
    expect(src).toContain("An unset engine runs the CLI (RK9-305)");
  });
});
