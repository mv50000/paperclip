// --- RK9 Custom (RK9-228, RK9-312): acpx_local refuses to run while a server-wide ANTHROPIC_API_KEY is present ---
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acpxExecuteMock = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false })),
);
const acpxTestEnvironmentMock = vi.hoisted(() =>
  vi.fn(async () => ({
    adapterType: "acpx_local",
    status: "pass" as const,
    checks: [],
    testedAt: new Date(0).toISOString(),
  })),
);

vi.mock("@paperclipai/adapter-acpx-local/server", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-acpx-local/server")>(
    "@paperclipai/adapter-acpx-local/server",
  );
  return { ...actual, execute: acpxExecuteMock, testEnvironment: acpxTestEnvironmentMock };
});

import { acpxHostKeyBlockReason, requireServerAdapter } from "../adapters/registry.js";

const KEY = "ANTHROPIC_API_KEY";
const OPT_IN = "PAPERCLIP_CLAUDE_INHERIT_ANTHROPIC_API_KEY";

describe("acpx_local host key guard (RK9-228)", () => {
  const saved = { key: process.env[KEY], optIn: process.env[OPT_IN] };

  beforeEach(() => {
    delete process.env[KEY];
    delete process.env[OPT_IN];
    acpxExecuteMock.mockClear();
    acpxTestEnvironmentMock.mockClear();
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env[KEY];
    else process.env[KEY] = saved.key;
    if (saved.optIn === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = saved.optIn;
  });

  it("blocks only when a key is present and the deployment has not opted in", () => {
    expect(acpxHostKeyBlockReason({})).toBeNull();
    expect(acpxHostKeyBlockReason({ [KEY]: "  " })).toBeNull();
    expect(acpxHostKeyBlockReason({ [KEY]: "sk-test", [OPT_IN]: "1" })).toBeNull();
    expect(acpxHostKeyBlockReason({ [KEY]: "sk-test" })).toContain("ANTHROPIC_API_KEY");
  });

  it("refuses the run without spawning the ACP runtime", async () => {
    process.env[KEY] = "sk-test";
    const logs: string[] = [];
    const result = await requireServerAdapter("acpx_local").execute({
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);

    expect(result).toMatchObject({ exitCode: 1, errorCode: "acpx_host_key_blocked" });
    expect(acpxExecuteMock).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("RK9-228");
  });

  it("fails the environment test without probing", async () => {
    process.env[KEY] = "sk-test";
    const result = await requireServerAdapter("acpx_local").testEnvironment({} as never);

    expect(result.status).toBe("fail");
    expect(result.checks[0]?.code).toBe("acpx_host_key_blocked");
    expect(acpxTestEnvironmentMock).not.toHaveBeenCalled();
  });

  it("delegates to the ACP adapter when no host key is present", async () => {
    await requireServerAdapter("acpx_local").execute({ onLog: async () => {} } as never);
    await requireServerAdapter("acpx_local").testEnvironment({} as never);

    expect(acpxExecuteMock).toHaveBeenCalledTimes(1);
    expect(acpxTestEnvironmentMock).toHaveBeenCalledTimes(1);
  });
});
