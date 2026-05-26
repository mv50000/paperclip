import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  canonicalString,
  isValidSigningCertUrl,
  verifySnsSignature,
  type SnsMessage,
} from "../services/email/sns-verify.js";

// A self-signed-ish keypair: we sign with the private key and hand the verifier
// the public key as the "cert" (createVerify accepts a public key PEM).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function sign(canonical: string, algorithm: "RSA-SHA1" | "RSA-SHA256"): string {
  const s = createSign(algorithm);
  s.update(canonical, "utf8");
  s.end();
  return s.sign(privateKey, "base64");
}

function notification(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: "Notification",
    MessageId: "msg-1",
    TopicArn: "arn:aws:sns:eu-west-1:123:ses-events",
    Message: "{}",
    Timestamp: "2026-05-26T20:00:00.000Z",
    Signature: "",
    SignatureVersion: "1",
    SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
    ...overrides,
  };
}

describe("isValidSigningCertUrl", () => {
  it("accepts an https SNS amazonaws.com host", () => {
    expect(isValidSigningCertUrl("https://sns.eu-west-1.amazonaws.com/Simple-x.pem")).toBe(true);
  });
  it("rejects non-amazonaws hosts, http, and look-alikes", () => {
    expect(isValidSigningCertUrl("https://sns.eu-west-1.amazonaws.com.evil.com/x.pem")).toBe(false);
    expect(isValidSigningCertUrl("http://sns.eu-west-1.amazonaws.com/x.pem")).toBe(false);
    expect(isValidSigningCertUrl("https://evil.com/x.pem")).toBe(false);
    expect(isValidSigningCertUrl("not a url")).toBe(false);
  });
});

describe("canonicalString", () => {
  it("includes Subject only when present (Notification)", () => {
    expect(canonicalString(notification())).toBe(
      "Message\n{}\nMessageId\nmsg-1\nTimestamp\n2026-05-26T20:00:00.000Z\nTopicArn\narn:aws:sns:eu-west-1:123:ses-events\nType\nNotification\n",
    );
    expect(canonicalString(notification({ Subject: "hi" }))).toContain("Subject\nhi\n");
  });
  it("uses SubscribeURL+Token order for SubscriptionConfirmation", () => {
    const c = canonicalString(
      notification({ Type: "SubscriptionConfirmation", SubscribeURL: "https://x", Token: "tok" }),
    );
    expect(c).toContain("SubscribeURL\nhttps://x\n");
    expect(c).toContain("Token\ntok\n");
  });
  it("returns null for an unsupported type", () => {
    expect(canonicalString(notification({ Type: "Bogus" }))).toBeNull();
  });
});

describe("verifySnsSignature", () => {
  const fetchCert = async () => publicPem;

  it("accepts a valid v1 (SHA1) signature", async () => {
    const msg = notification();
    msg.Signature = sign(canonicalString(msg)!, "RSA-SHA1");
    expect(await verifySnsSignature(msg, { fetchCert })).toEqual({ ok: true });
  });

  it("accepts a valid v2 (SHA256) signature", async () => {
    const msg = notification({ SignatureVersion: "2" });
    msg.Signature = sign(canonicalString(msg)!, "RSA-SHA256");
    expect(await verifySnsSignature(msg, { fetchCert })).toEqual({ ok: true });
  });

  it("rejects a tampered message", async () => {
    const msg = notification();
    msg.Signature = sign(canonicalString(msg)!, "RSA-SHA1");
    msg.Message = '{"tampered":true}';
    expect(await verifySnsSignature(msg, { fetchCert })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects before fetching the cert when the URL is untrusted", async () => {
    let fetched = false;
    const res = await verifySnsSignature(
      notification({ SigningCertURL: "https://evil.com/x.pem", Signature: "x" }),
      { fetchCert: async () => { fetched = true; return publicPem; } },
    );
    expect(res).toEqual({ ok: false, reason: "invalid_cert_url" });
    expect(fetched).toBe(false);
  });

  it("rejects an unsupported signature version", async () => {
    const res = await verifySnsSignature(notification({ SignatureVersion: "9", Signature: "x" }), { fetchCert });
    expect(res).toEqual({ ok: false, reason: "unsupported_signature_version" });
  });

  it("reports cert_fetch_failed when the fetcher throws", async () => {
    const msg = notification();
    msg.Signature = sign(canonicalString(msg)!, "RSA-SHA1");
    const res = await verifySnsSignature(msg, { fetchCert: async () => { throw new Error("boom"); } });
    expect(res).toEqual({ ok: false, reason: "cert_fetch_failed" });
  });
});
