// --- RK9 Custom (RK9-454): whole file is fork-only ---
// adapterConfig.additionalMcpConfigPaths merges listed MCP config files into
// the strict runtime MCP config. It is opt-in: without the field the agent's
// cwd .mcp.json stays ignored, as upstream does.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
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

const runtimeServer: AdapterRuntimeMcpServer = {
  name: "paperclip",
  url: "https://paperclip.example/api/tool-gateway/gateways/paperclip/mcp",
  token: "runtime-token",
  connectionId: "connection-paperclip",
};
const runtimeEntry = {
  type: "http",
  url: runtimeServer.url,
  headers: { Authorization: "Bearer runtime-token" },
};
const projectEntry = { type: "stdio", command: "quantimodo-mcp", args: ["--read-only"] };

describe("claude additionalMcpConfigPaths (RK9-454)", () => {
  const cleanupDirs: string[] = [];
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;

  afterEach(async () => {
    vi.clearAllMocks();
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function run(input: {
    config?: Record<string, unknown>;
    servers: AdapterRuntimeMcpServer[];
    projectMcpConfig?: string;
  }) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-additional-mcp-"));
    cleanupDirs.push(rootDir);
    process.env.PAPERCLIP_HOME = path.join(rootDir, "paperclip-home");
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    if (input.projectMcpConfig !== undefined) {
      await writeFile(path.join(workspaceDir, ".mcp.json"), input.projectMcpConfig, "utf8");
    }
    const logs: string[] = [];

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Salkunhoitaja",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { command: "claude", engine: "cli", ...input.config },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      runtimeMcp: { getServers: () => input.servers },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    const calls = runChildProcess.mock.calls as unknown as Array<[string, string, string[], Record<string, unknown>]>;
    const args = calls.at(-1)?.[2] ?? [];
    const mcpConfigIndex = args.indexOf("--mcp-config");
    const mcpConfig = mcpConfigIndex >= 0
      ? JSON.parse(await readFile(args[mcpConfigIndex + 1]!, "utf8"))
      : null;
    return { result, args, mcpConfig, logs: logs.join("") };
  }

  it("ignores the cwd .mcp.json when the field is not set", async () => {
    const { args, mcpConfig } = await run({
      servers: [runtimeServer],
      projectMcpConfig: JSON.stringify({ mcpServers: { quantimodo: projectEntry } }),
    });
    expect(args).toEqual(expect.arrayContaining(["--mcp-config", "--strict-mcp-config"]));
    expect(mcpConfig).toEqual({ mcpServers: { paperclip: runtimeEntry } });
  });

  it("merges the listed config into the strict runtime config", async () => {
    const { args, mcpConfig } = await run({
      config: { additionalMcpConfigPaths: [".mcp.json"] },
      servers: [runtimeServer],
      projectMcpConfig: JSON.stringify({ mcpServers: { quantimodo: projectEntry } }),
    });
    expect(args).toEqual(expect.arrayContaining(["--mcp-config", "--strict-mcp-config"]));
    expect(args.filter((arg) => arg === "--mcp-config")).toHaveLength(1);
    expect(mcpConfig).toEqual({ mcpServers: { quantimodo: projectEntry, paperclip: runtimeEntry } });
  });

  it("keeps the runtime server on a name collision", async () => {
    const { mcpConfig } = await run({
      config: { additionalMcpConfigPaths: [".mcp.json"] },
      servers: [runtimeServer],
      projectMcpConfig: JSON.stringify({
        mcpServers: {
          paperclip: { type: "http", url: "https://other.example/mcp" },
          quantimodo: projectEntry,
        },
      }),
    });
    expect(mcpConfig).toEqual({ mcpServers: { quantimodo: projectEntry, paperclip: runtimeEntry } });
  });

  it("logs a warning for an invalid or missing file and still runs with the runtime servers", async () => {
    const { result, mcpConfig, logs } = await run({
      config: { additionalMcpConfigPaths: [".mcp.json", "missing.json"] },
      servers: [runtimeServer],
      projectMcpConfig: "{ not json",
    });
    expect(result.exitCode).toBe(0);
    expect(logs).toContain("is not valid JSON; its servers were not loaded");
    expect(logs).toContain("could not be read (ENOENT)");
    expect(logs).not.toContain("{ not json");
    expect(mcpConfig).toEqual({ mcpServers: { paperclip: runtimeEntry } });
  });

  it("passes --mcp-config without strict mode when no runtime servers exist", async () => {
    const { args, mcpConfig } = await run({
      config: { additionalMcpConfigPaths: [".mcp.json"] },
      servers: [],
      projectMcpConfig: JSON.stringify({ mcpServers: { quantimodo: projectEntry } }),
    });
    expect(args).toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    expect(mcpConfig).toEqual({ mcpServers: { quantimodo: projectEntry } });
  });

  it("passes no MCP flags without runtime servers or the field", async () => {
    const { args } = await run({
      servers: [],
      projectMcpConfig: JSON.stringify({ mcpServers: { quantimodo: projectEntry } }),
    });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });
});
// --- /RK9 Custom ---
