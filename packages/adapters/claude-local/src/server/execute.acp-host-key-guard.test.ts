// --- RK9 Custom (RK9-228, RK9-312): the ACP engine refuses to run while a server-wide ANTHROPIC_API_KEY is present ---
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false })),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  // v2026.916.1 has no CLI fallback; the fork resolver maps an unset engine to the CLI (RK9-305).
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "cli", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import { acpHostKeyBlockReason } from "./host-env.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

const KEY = "ANTHROPIC_API_KEY";
const OPT_IN = "PAPERCLIP_CLAUDE_INHERIT_ANTHROPIC_API_KEY";

describe("claude_local ACP host key guard (RK9-228)", () => {
  const saved = { key: process.env[KEY], optIn: process.env[OPT_IN] };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[KEY];
    delete process.env[OPT_IN];
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env[KEY];
    else process.env[KEY] = saved.key;
    if (saved.optIn === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = saved.optIn;
  });

  it("blocks only when a key is present and the deployment has not opted in", () => {
    expect(acpHostKeyBlockReason({})).toBeNull();
    expect(acpHostKeyBlockReason({ [KEY]: "  " })).toBeNull();
    expect(acpHostKeyBlockReason({ [KEY]: "sk-test", [OPT_IN]: "1" })).toBeNull();
    expect(acpHostKeyBlockReason({ [KEY]: "sk-test" })).toContain("ANTHROPIC_API_KEY");
  });

  it("refuses an explicit ACP run without starting ACP or the CLI", async () => {
    process.env[KEY] = "sk-test";
    const ctx = buildContext({ engine: "acp" });

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claude_acp_host_key_blocked");
    expect(executeClaudeAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("ANTHROPIC_API_KEY"));
  });

  it("runs an unset engine on the CLI while a host key is present", async () => {
    process.env[KEY] = "sk-test";
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(executeClaudeAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  });

  it("allows ACP when no key is present or the deployment opted in", async () => {
    await execute(buildContext({ engine: "acp" }) as never);
    process.env[KEY] = "sk-test";
    process.env[OPT_IN] = "1";
    await execute(buildContext({ engine: "acp" }) as never);

    expect(executeClaudeAcp).toHaveBeenCalledTimes(2);
  });
});
