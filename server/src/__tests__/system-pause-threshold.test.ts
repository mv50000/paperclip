import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RK9-308: locks the SYSTEM_PAUSE_THRESHOLD_PCT parsing that `evaluateAutoPause` in
// server/src/index.ts reads via `config.systemPauseThresholdPct`. The operator sets 75 in the
// prod env, so the configured path is the one that matters; the default (90) is the fallback.
const ENV_KEYS = [
  "PAPERCLIP_CONFIG",
  "SYSTEM_PAUSE_THRESHOLD_PCT",
  "SYSTEM_PAUSE_AUTO_ENABLED",
  "SYSTEM_PAUSE_CHECK_INTERVAL_MS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

async function loadThreshold(value?: string) {
  if (value === undefined) delete process.env.SYSTEM_PAUSE_THRESHOLD_PCT;
  else process.env.SYSTEM_PAUSE_THRESHOLD_PCT = value;
  vi.resetModules();
  const { loadConfig } = await import("../config.js");
  return loadConfig().systemPauseThresholdPct;
}

describe("SYSTEM_PAUSE_THRESHOLD_PCT", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PAPERCLIP_CONFIG = "/nonexistent/paperclip-config-test/config.json";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("uses the operator-configured 75 from the env", async () => {
    expect(await loadThreshold("75")).toBe(75);
  });

  it("falls back to 90 when unset", async () => {
    expect(await loadThreshold()).toBe(90);
  });

  it("falls back to 90 on unparseable or zero values", async () => {
    expect(await loadThreshold("abc")).toBe(90);
    expect(await loadThreshold("0")).toBe(90);
    expect(await loadThreshold("")).toBe(90);
  });

  it("clamps to the 50..100 range", async () => {
    expect(await loadThreshold("10")).toBe(50);
    expect(await loadThreshold("250")).toBe(100);
  });

  it("keeps auto-pause enabled unless explicitly set to false", async () => {
    vi.resetModules();
    const { loadConfig } = await import("../config.js");
    expect(loadConfig().systemPauseAutoEnabled).toBe(true);
    process.env.SYSTEM_PAUSE_AUTO_ENABLED = "false";
    expect(loadConfig().systemPauseAutoEnabled).toBe(false);
  });
});
