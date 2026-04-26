import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readSlackSignatureHeaders,
  verifySlackSignature,
} from "../services/slack/signature-verify.js";

const SECRET = "test_signing_secret";

function sign(timestamp: string, body: string, secret: string = SECRET): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", () => {
    const ts = "1700000000";
    const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const signature = sign(ts, body);
    const result = verifySlackSignature(
      body,
      { signature, timestamp: ts },
      SECRET,
      Number(ts) + 30,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when secret is missing", () => {
    const result = verifySlackSignature("foo", { signature: "v0=abc", timestamp: "0" }, undefined);
    expect(result).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects when headers are missing", () => {
    const result = verifySlackSignature("foo", { signature: undefined, timestamp: "0" }, SECRET);
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects stale timestamps (>5 minutes old)", () => {
    const ts = "1700000000";
    const body = "payload=x";
    const signature = sign(ts, body);
    const result = verifySlackSignature(
      body,
      { signature, timestamp: ts },
      SECRET,
      Number(ts) + 6 * 60,
    );
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects an invalid signature", () => {
    const ts = "1700000000";
    const body = "payload=x";
    const result = verifySlackSignature(
      body,
      { signature: "v0=" + "0".repeat(64), timestamp: ts },
      SECRET,
      Number(ts),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects signature signed with a different secret", () => {
    const ts = "1700000000";
    const body = "payload=x";
    const signature = sign(ts, body, "other_secret");
    const result = verifySlackSignature(
      body,
      { signature, timestamp: ts },
      SECRET,
      Number(ts),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("readSlackSignatureHeaders normalizes header names case-insensitively", () => {
    const headers = {
      "x-slack-signature": "v0=abc",
      "X-Slack-Request-Timestamp": "1700000000",
    };
    const parsed = readSlackSignatureHeaders(headers as Record<string, string>);
    expect(parsed.signature).toBe("v0=abc");
    expect(parsed.timestamp).toBe("1700000000");
  });

  it("readSlackSignatureHeaders returns first value when array passed", () => {
    const headers = {
      "x-slack-signature": ["v0=primary", "v0=secondary"],
      "x-slack-request-timestamp": "1700000000",
    };
    const parsed = readSlackSignatureHeaders(headers as Record<string, string | string[]>);
    expect(parsed.signature).toBe("v0=primary");
  });
});
