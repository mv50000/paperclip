// RK9-83: first-class tool containment — config.disallowedTools /
// config.allowedTools must reach the claude CLI invocation. Note that only
// --disallowedTools is enforceable under --dangerously-skip-permissions.

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
      JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
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
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

describe("claude tool containment args", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runWithConfig(config: Record<string, unknown>) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-tools-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Asiakaspalvelu",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { command: "claude", ...config },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], Record<string, unknown>]
      | undefined;
    return call?.[2] ?? [];
  }

  it("passes disallowedTools and allowedTools as CLI flags", async () => {
    const args = await runWithConfig({
      disallowedTools: ["Write", "Edit", "NotebookEdit", "WebSearch", "WebFetch"],
      allowedTools: ["Read", "Grep"],
    });
    const disallowedIdx = args.indexOf("--disallowedTools");
    expect(disallowedIdx).toBeGreaterThan(-1);
    expect(args[disallowedIdx + 1]).toBe("Write,Edit,NotebookEdit,WebSearch,WebFetch");
    const allowedIdx = args.indexOf("--allowedTools");
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(args[allowedIdx + 1]).toBe("Read,Grep");
  });

  it("omits the flags when not configured", async () => {
    const args = await runWithConfig({});
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--allowedTools");
  });
});
