import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readSvixHeaders,
  verifySvixSignature,
} from "../services/email/svix-verify.js";

const SECRET_RAW = "raw_test_secret_do_not_use_in_prod";
const SECRET_BYTES_WHSEC = randomBytes(32);
const SECRET_WHSEC = `whsec_${SECRET_BYTES_WHSEC.toString("base64")}`;

function sign(id: string, ts: string, body: string, secret: string): string {
  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${expected}`;
}

describe("verifySvixSignature", () => {
  it("accepts a correctly signed request (raw secret)", () => {
    const id = "msg_test_1";
    const ts = "1700000000";
    const body = '{"type":"email.received"}';
    const sig = sign(id, ts, body, SECRET_RAW);
    const r = verifySvixSignature(
      body,
      { id, timestamp: ts, signature: sig },
      SECRET_RAW,
      Number(ts) + 30,
    );
    expect(r).toEqual({ ok: true });
  });

  it("accepts a correctly signed request (whsec_ prefixed secret)", () => {
    const id = "msg_test_2";
    const ts = "1700000000";
    const body = '{"type":"email.bounced"}';
    const sig = sign(id, ts, body, SECRET_WHSEC);
    const r = verifySvixSignature(
      body,
      { id, timestamp: ts, signature: sig },
      SECRET_WHSEC,
      Number(ts),
    );
    expect(r).toEqual({ ok: true });
  });

  it("accepts a request when one of multiple space-separated signatures matches", () => {
    const id = "msg_test_3";
    const ts = "1700000000";
    const body = "abc";
    const correct = sign(id, ts, body, SECRET_RAW);
    const r = verifySvixSignature(
      body,
      {
        id,
        timestamp: ts,
        signature: `v1,WrongSig== v1,AnotherWrong== ${correct}`,
      },
      SECRET_RAW,
      Number(ts),
    );
    expect(r).toEqual({ ok: true });
  });

  it("rejects when secret is missing", () => {
    const r = verifySvixSignature("x", { id: "m", timestamp: "0", signature: "v1,x" }, undefined);
    expect(r).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects when any required header is missing", () => {
    const r = verifySvixSignature(
      "x",
      { id: undefined, timestamp: "0", signature: "v1,x" },
      SECRET_RAW,
    );
    expect(r).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects stale timestamps (>5 minutes)", () => {
    const id = "m";
    const ts = "1700000000";
    const body = "x";
    const sig = sign(id, ts, body, SECRET_RAW);
    const r = verifySvixSignature(
      body,
      { id, timestamp: ts, signature: sig },
      SECRET_RAW,
      Number(ts) + 6 * 60,
    );
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects future timestamps (>5 minutes ahead)", () => {
    const id = "m";
    const ts = "1700000000";
    const body = "x";
    const sig = sign(id, ts, body, SECRET_RAW);
    const r = verifySvixSignature(
      body,
      { id, timestamp: ts, signature: sig },
      SECRET_RAW,
      Number(ts) - 6 * 60,
    );
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects modified body (signature still valid for original body)", () => {
    const id = "m";
    const ts = "1700000000";
    const body = "original";
    const sig = sign(id, ts, body, SECRET_RAW);
    const r = verifySvixSignature(
      "tampered",
      { id, timestamp: ts, signature: sig },
      SECRET_RAW,
      Number(ts),
    );
    expect(r).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects signature scheme other than v1", () => {
    const id = "m";
    const ts = "1700000000";
    const body = "x";
    // build a valid v1 then mangle scheme
    const validSig = sign(id, ts, body, SECRET_RAW);
    const mangled = `v2${validSig.slice(2)}`;
    const r = verifySvixSignature(
      body,
      { id, timestamp: ts, signature: mangled },
      SECRET_RAW,
      Number(ts),
    );
    expect(r).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects malformed whsec secret", () => {
    const r = verifySvixSignature(
      "x",
      { id: "m", timestamp: "1700000000", signature: "v1,abc" },
      "whsec_!!!notvalidbase64!!!",
      1700000000,
    );
    // base64 decode is permissive; with a bad payload the signature simply won't match
    expect(r.ok).toBe(false);
  });

  it("readSvixHeaders is case-insensitive and handles array values", () => {
    const headers = {
      "Svix-Id": "msg_X",
      "Svix-Timestamp": "1700000000",
      "svix-signature": ["v1,abc"],
    } as const;
    const out = readSvixHeaders(headers as Record<string, string | string[] | undefined>);
    expect(out).toEqual({ id: "msg_X", timestamp: "1700000000", signature: "v1,abc" });
  });
});
