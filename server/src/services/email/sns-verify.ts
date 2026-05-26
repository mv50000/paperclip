// Amazon SNS message signature verification (SEC-106/L4).
//
// SES inbound + bounce/complaint events arrive as Amazon SNS HTTP(S) POSTs.
// Unlike Resend/Svix (per-tenant HMAC secret), SNS signs every message with an
// AWS-managed RSA key and publishes the signing certificate at `SigningCertURL`.
// We verify by:
//
//   1. Validating `SigningCertURL` is an HTTPS amazonaws.com SNS host — this is
//      the critical check; without it an attacker could point us at a cert they
//      control. (Also guards against SSRF via the cert fetch.)
//   2. Rebuilding the canonical "string to sign" from the documented fields in
//      the documented order for the message Type.
//   3. Verifying the base64 `Signature` against the cert's public key
//      (SignatureVersion "1" → RSA-SHA1, "2" → RSA-SHA256).
//
// Certs are cached in-memory (keyed by URL) since SNS reuses them. This module
// is provider-of-tenant agnostic: tenant resolution for SES happens by recipient
// domain in the inbound router (SEC-108/L5), not from the signature.

import { createVerify } from "node:crypto";

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

export type SnsVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_cert_url"
        | "unsupported_type"
        | "missing_field"
        | "unsupported_signature_version"
        | "cert_fetch_failed"
        | "signature_mismatch";
    };

/** Fetch a PEM cert for a (pre-validated) URL. */
export type CertFetcher = (url: string) => Promise<string>;

/**
 * Only accept signing certs served over HTTPS from an SNS amazonaws.com host
 * (e.g. `sns.eu-west-1.amazonaws.com`). Rejecting anything else is what makes
 * the whole scheme safe.
 */
export function isValidSigningCertUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
}

/**
 * The canonical string to sign: each required field as `Field\nvalue\n`, in the
 * exact order AWS documents per message Type. Returns null on an unsupported
 * type or a missing required field.
 */
export function canonicalString(msg: SnsMessage): string | null {
  let fields: string[];
  switch (msg.Type) {
    case "Notification":
      fields =
        msg.Subject !== undefined
          ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
          : ["Message", "MessageId", "Timestamp", "TopicArn", "Type"];
      break;
    case "SubscriptionConfirmation":
    case "UnsubscribeConfirmation":
      fields = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
      break;
    default:
      return null;
  }
  let out = "";
  for (const f of fields) {
    const v = (msg as unknown as Record<string, unknown>)[f];
    if (v === undefined || v === null) return null;
    out += `${f}\n${String(v)}\n`;
  }
  return out;
}

const certCache = new Map<string, string>();

const defaultFetchCert: CertFetcher = async (url) => {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
};

/**
 * Verify an SNS message signature. `fetchCert` is injectable for tests; it is
 * only invoked after the cert URL has passed `isValidSigningCertUrl`.
 */
export async function verifySnsSignature(
  msg: SnsMessage,
  opts: { fetchCert?: CertFetcher } = {},
): Promise<SnsVerifyResult> {
  if (!isValidSigningCertUrl(msg.SigningCertURL)) return { ok: false, reason: "invalid_cert_url" };

  const algorithm =
    msg.SignatureVersion === "1" ? "RSA-SHA1" : msg.SignatureVersion === "2" ? "RSA-SHA256" : null;
  if (!algorithm) return { ok: false, reason: "unsupported_signature_version" };

  const canonical = canonicalString(msg);
  if (canonical === null) {
    // Distinguish an unknown type from a known type missing a field.
    const known = ["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(msg.Type);
    return { ok: false, reason: known ? "missing_field" : "unsupported_type" };
  }

  let pem: string;
  try {
    pem = await (opts.fetchCert ?? defaultFetchCert)(msg.SigningCertURL);
  } catch {
    return { ok: false, reason: "cert_fetch_failed" };
  }

  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonical, "utf8");
    verifier.end();
    const valid = verifier.verify(pem, msg.Signature, "base64");
    return valid ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "signature_mismatch" };
  }
}

/** Test-only: clear the in-memory cert cache. */
export function __clearCertCache(): void {
  certCache.clear();
}
