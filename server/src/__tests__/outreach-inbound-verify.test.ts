import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOutreachInboundSignature } from "../services/outreach/inbound-verify.js";

const SECRET = "test-shared-secret";

function sign(body: Buffer, timestamp: string, secret = SECRET): string {
  const signedContent = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]);
  return "sha256=" + createHmac("sha256", secret).update(signedContent).digest("hex");
}

describe("verifyOutreachInboundSignature", () => {
  it("accepts a correctly signed body within the replay window", () => {
    const body = Buffer.from("raw mime bytes");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = verifyOutreachInboundSignature(body, { timestamp, signature: sign(body, timestamp) }, SECRET);
    expect(result).toEqual({ ok: true });
  });

  it("fails closed when the secret is unconfigured", () => {
    const body = Buffer.from("x");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = verifyOutreachInboundSignature(body, { timestamp, signature: sign(body, timestamp) }, undefined);
    expect(result).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects a missing timestamp or signature header", () => {
    const body = Buffer.from("x");
    expect(verifyOutreachInboundSignature(body, { timestamp: undefined, signature: "sha256=abc" }, SECRET)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    expect(verifyOutreachInboundSignature(body, { timestamp: "123", signature: undefined }, SECRET)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects a non-numeric timestamp", () => {
    const body = Buffer.from("x");
    const result = verifyOutreachInboundSignature(body, { timestamp: "not-a-number", signature: "sha256=abc" }, SECRET);
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects a stale timestamp outside the 5-minute replay window", () => {
    const body = Buffer.from("raw mime bytes");
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const result = verifyOutreachInboundSignature(body, { timestamp: staleTimestamp, signature: sign(body, staleTimestamp) }, SECRET);
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a wrong signature (tampered body)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(Buffer.from("original body"), timestamp);
    const result = verifyOutreachInboundSignature(Buffer.from("tampered body"), { timestamp, signature }, SECRET);
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a signature produced with a different secret", () => {
    const body = Buffer.from("raw mime bytes");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, timestamp, "wrong-secret");
    const result = verifyOutreachInboundSignature(body, { timestamp, signature }, SECRET);
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });
});
