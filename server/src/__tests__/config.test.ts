import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const ENV_KEYS = [
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_IN_WORKTREE",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "PAPERCLIP_TAILNET_BIND_HOST",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "HOST",
] as const;

let savedEnv: Record<string, string | undefined> = {};

async function importConfigModule() {
  vi.resetModules();
  return import("../config.js");
}

describe("loadConfig tailnet bind detection", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Point at a config path that can't exist so readConfigFile() resolves to null and the
    // test never touches the operator's real ~/.paperclip config.
    process.env.PAPERCLIP_CONFIG = "/nonexistent/paperclip-config-test/config.json";
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("never spawns tailscale when bind is explicitly lan, across repeated loadConfig() calls", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_BIND = "lan";
    const { loadConfig } = await importConfigModule();

    for (let i = 0; i < 3; i += 1) {
      const config = loadConfig();
      expect(config.bind).toBe("lan");
      expect(config.host).toBe("0.0.0.0");
    }

    expect(execFileSyncMock).not.toHaveBeenCalled();
  }, 15000);

  it("never spawns tailscale when bind is inferred as loopback from an unset host", async () => {
    const { loadConfig } = await importConfigModule();

    for (let i = 0; i < 3; i += 1) {
      const config = loadConfig();
      expect(config.bind).toBe("loopback");
      expect(config.host).toBe("127.0.0.1");
    }

    expect(execFileSyncMock).not.toHaveBeenCalled();
  }, 15000);

  it("spawns tailscale at most once across repeated loadConfig() calls when bind is tailnet", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_BIND = "tailnet";
    execFileSyncMock.mockReturnValue("100.64.0.5\n");
    const { loadConfig } = await importConfigModule();

    for (let i = 0; i < 3; i += 1) {
      const config = loadConfig();
      expect(config.bind).toBe("tailnet");
      expect(config.host).toBe("100.64.0.5");
    }

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  }, 15000);

  it("keeps the PAPERCLIP_TAILNET_BIND_HOST override without spawning a process", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_BIND = "tailnet";
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.9";
    const { loadConfig } = await importConfigModule();

    const config = loadConfig();

    expect(config.bind).toBe("tailnet");
    expect(config.host).toBe("100.64.0.9");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  }, 15000);
});
