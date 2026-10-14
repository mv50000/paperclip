import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";
import { GRAPH_VERSION, graphHealth } from "../../src/meta/graph.js";
import { COMPANY } from "./fake-graph.js";

describe("onHealth and Graph version drift", () => {
  afterEach(() => graphHealth.reset());

  it("is ok without drift and degraded after a client saw drift", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const healthy = await plugin.definition.onHealth!();
    expect(healthy.status).toBe("ok");
    expect(healthy.details).toMatchObject({ graphVersion: GRAPH_VERSION });

    graphHealth.recordDrift({
      companyId: COMPANY,
      expectedVersion: GRAPH_VERSION,
      observedVersion: "v99.0",
      source: "paging",
      path: "act_1/ads",
      at: new Date(0).toISOString(),
    });
    const degraded = await plugin.definition.onHealth!();
    expect(degraded.status).toBe("degraded");
    expect(degraded.message).toContain("v99.0");
    expect(degraded.details).toMatchObject({ graphDrift: { observedVersion: "v99.0" } });
  });
});
