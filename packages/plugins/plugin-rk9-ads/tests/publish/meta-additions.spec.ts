/**
 * Meta client additions for publishing (A8, RK9-514): the swap, delete and
 * ad set ad list methods, and operator-readable error messages.
 */

import { describe, expect, it } from "vitest";
import {
  MediaProcessingError,
  MediaTimeoutError,
  MetaGraphError,
  operatorMessage,
  PolicyAcceptanceRequiredError,
  RateLimitError,
  TokenInvalidError,
  WriteRefusedError,
} from "../../src/meta/errors.js";
import { deleteObject, listAdSetAds, swapAdCreative } from "../../src/meta/methods.js";
import { FakeRoutes, graphError, metaClient } from "../brand/fake-routes.js";
import { formOf } from "./rig.js";

describe("publishing methods", () => {
  it("swapAdCreative sends only the creative, deleteObject a bare DELETE, listAdSetAds reads the ad set edge", async () => {
    const routes = new FakeRoutes()
      .on("POST 5001", { body: { success: true } })
      .on("DELETE 7001", { body: { success: true } })
      .on("GET 200/ads", { body: { data: [{ id: "5001", name: "n", status: "PAUSED", effective_status: "PAUSED", creative: { id: "7001" } }] } });
    const client = metaClient(routes, { mode: "live" });
    expect(await swapAdCreative(client, "5001", "7001")).toEqual({ success: true });
    expect(formOf(routes.calls[0]!)).toEqual({ creative: { creative_id: "7001" } });
    expect(await deleteObject(client, "7001")).toEqual({ success: true });
    expect(routes.calls[1]).toMatchObject({ method: "DELETE", key: "DELETE 7001" });
    expect(await listAdSetAds(client, "200")).toEqual([
      { id: "5001", name: "n", status: "PAUSED", effectiveStatus: "PAUSED", adsetId: null, campaignId: null, creativeId: "7001" },
    ]);
    await expect(swapAdCreative(client, "act_1", "7001")).rejects.toThrow(/numeric Graph id/);
  });

  it("a read-only client refuses the swap before any request", async () => {
    const routes = new FakeRoutes();
    await expect(swapAdCreative(metaClient(routes), "5001", "7001")).rejects.toThrow(/Read-only/);
    expect(routes.calls).toEqual([]);
  });
});

describe("operatorMessage", () => {
  it("maps 2859024 to one line with the fix and no stack", async () => {
    const routes = new FakeRoutes().on("POST 5001", graphError(100, "Invalid parameter", 2859024));
    const error = await swapAdCreative(metaClient(routes, { mode: "live" }), "5001", "7001").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PolicyAcceptanceRequiredError);
    const message = operatorMessage(error);
    expect(message).toMatch(/^Meta refused the request: the ad account has not accepted Meta's policy terms \(code 100, subcode 2859024\)\. Fix: Open Ads Manager/);
    expect(message).not.toMatch(/\n|    at /);
  });

  it("gives each known class its fix", () => {
    expect(operatorMessage(new TokenInvalidError("Meta GET x: expired", { code: 190 }))).toMatch(/token is expired or revoked.*Fix: Generate a new system user token/);
    expect(operatorMessage(new MetaGraphError("Meta POST x: dev", { code: 100, subcode: 1885183 }))).toMatch(/development mode.*Fix: Switch the Meta app/);
    expect(operatorMessage(new MetaGraphError("Meta POST x: perm", { code: 200 }))).toMatch(/lacks a permission/);
    expect(operatorMessage(new RateLimitError("Meta GET x: slow down", { code: 17 }))).toMatch(/rate limit hit \(code 17\)\. Fix: wait/);
    expect(operatorMessage(new MediaProcessingError("9", "Video 9 failed processing: bad codec"))).toMatch(/bad codec\. Fix: re-encode/);
    expect(operatorMessage(new MediaTimeoutError("9", 600000, "processing"))).toMatch(/not ready after 600000 ms.*Fix: run the publish again later/);
    expect(operatorMessage(new WriteRefusedError("POST", "act_1/ads", "no"))).toMatch(/Nothing was sent to Meta\.$/);
    expect(operatorMessage(new MetaGraphError("Meta POST x: odd", { code: 1, userMessage: "Try later" }))).toBe("Meta POST x: odd. Meta says: Try later");
  });

  it("keeps any other error to its first line and redacts tokens", () => {
    const error = new Error("boom access_token=EAAGsecretvalue123456789\n    at file.ts:1:1");
    const message = operatorMessage(error);
    expect(message).not.toContain("EAAGsecretvalue123456789");
    expect(message).not.toContain("file.ts");
  });
});
