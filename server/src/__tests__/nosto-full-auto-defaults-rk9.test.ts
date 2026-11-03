// RK9-693 (nosto prep), RK9-707: upstream v2026.1005 changes the full-auto defaults. The fork keeps
// tool containment (RK9-83) and the CLI engine pin (RK9-305). These are behaviour tests: upstream
// 1023 returns `{ engine: "acp" }` for an unset engine in claude-local acp.ts normalizeEngine, and the
// ACP path does not pass --disallowedTools. After such a lift the engine assertion fails, and the
// unset-engine run never reaches the CLI argv with --disallowedTools.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "@paperclipai/adapter-claude-local/server";
import {
  resolveClaudeExecutionEngine,
  resolveClaudeExecutionEngineForRun,
} from "../../../packages/adapters/claude-local/src/server/acp.ts";

describe("full-auto defaults keep the fork pins (RK9-693, RK9-707)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runArgv(config: Record<string, unknown>): Promise<string[]> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-nosto-full-auto-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Nosto",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", ...config },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });
    expect(runChildProcess, "an unset engine must start the claude CLI process").toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[], Record<string, unknown>];
    return call[2];
  }

  it("selects the CLI for a config without an engine (RK9-305)", async () => {
    expect(resolveClaudeExecutionEngine({})).toEqual({ engine: "cli", explicit: false });
    await expect(resolveClaudeExecutionEngineForRun({ config: {} })).resolves.toMatchObject({ engine: "cli" });
  });

  it("passes --disallowedTools to the CLI argv for an unset engine (RK9-83)", async () => {
    const argv = await runArgv({ disallowedTools: ["Write", "Edit", "WebFetch"] });
    const index = argv.indexOf("--disallowedTools");
    expect(index, "argv must contain --disallowedTools").toBeGreaterThan(-1);
    expect(argv[index + 1]).toBe("Write,Edit,WebFetch");
  });
});
