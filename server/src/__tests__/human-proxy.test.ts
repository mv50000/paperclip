import { describe, expect, it } from "vitest";
import { HUMAN_PROXY_ADAPTER_TYPE, isHumanProxyAgent } from "../services/human-proxy.js";
import { humanProxyAdapter } from "../adapters/human-proxy/index.js";
import { findActiveServerAdapter, findServerAdapter } from "../adapters/registry.js";

describe("isHumanProxyAgent", () => {
  it("returns true when adapterType matches", () => {
    expect(isHumanProxyAgent({ adapterType: HUMAN_PROXY_ADAPTER_TYPE })).toBe(true);
  });

  it("returns false for other adapter types", () => {
    expect(isHumanProxyAgent({ adapterType: "process" })).toBe(false);
    expect(isHumanProxyAgent({ adapterType: "claude_local" })).toBe(false);
    expect(isHumanProxyAgent({ adapterType: "" })).toBe(false);
  });

  it("returns false for nullish input", () => {
    expect(isHumanProxyAgent(null)).toBe(false);
    expect(isHumanProxyAgent(undefined)).toBe(false);
    expect(isHumanProxyAgent({})).toBe(false);
    expect(isHumanProxyAgent({ adapterType: null })).toBe(false);
  });
});

describe("humanProxyAdapter", () => {
  it("is registered as the human_proxy built-in adapter", () => {
    expect(humanProxyAdapter.type).toBe("human_proxy");
    expect(findServerAdapter("human_proxy")).toBe(humanProxyAdapter);
    expect(findActiveServerAdapter("human_proxy")).toBe(humanProxyAdapter);
  });

  it("throws when execute is called — work is picked up manually via /implement", async () => {
    await expect(
      humanProxyAdapter.execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "AI",
          role: "engineer",
          adapterType: "human_proxy",
          adapterConfig: {},
        },
        runtime: {},
        config: {},
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
        onSpawn: async () => {},
      }),
    ).rejects.toThrow(/picked up manually/i);
  });

  it("reports pass from testEnvironment with an informational note", async () => {
    const result = await humanProxyAdapter.testEnvironment!({
      adapterType: "human_proxy",
      config: {},
      runtime: {},
    } as never);
    expect(result.status).toBe("pass");
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks[0]?.level).toBe("info");
  });

  it("ships no models and disables JWT/instructions bundling", () => {
    expect(humanProxyAdapter.models).toEqual([]);
    expect(humanProxyAdapter.supportsLocalAgentJwt).toBe(false);
    expect(humanProxyAdapter.supportsInstructionsBundle).toBe(false);
    expect(humanProxyAdapter.requiresMaterializedRuntimeSkills).toBe(false);
  });
});
