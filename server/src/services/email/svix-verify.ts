// Svix webhook signature verification (Resend uses Svix).
//
// Algorithm — ported from Ollolla's Rust implementation
// (bk-pilot/backend/src/services/resend_inbound.rs):
//
//   signed_content = `${svix-id}.${svix-timestamp}.${body}`
//   expected       = base64( HMAC-SHA256(secret_bytes, signed_content) )
//
// `secret_bytes` is the base64-decoded portion of the secret if it starts with
// the `whsec_` prefix; otherwise the raw UTF-8 bytes of the secret.
//
// The `svix-signature` header may carry multiple space-separated signatures,
// each prefixed with `v1,`. We accept the request if ANY of them matches.
// Timestamps older or newer than 5 minutes are rejected (replay protection).
//
// For multi-tenant routing, the inbound router calls `verifySvixSignature`
// once per company secret until it finds a match — the matching secret
// determines the tenant.

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_AGE_S = 5 * 60;

export type SvixVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_secret"
        | "missing_headers"
        | "invalid_timestamp"
        | "stale_timestamp"
        | "invalid_secret_encoding"
        | "invalid_signature";
    };

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export function readSvixHeaders(
  headers: Record<string, string | string[] | undefined>,
): SvixHeaders {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  const lookup = (name: string) => {
    const v = normalized[name];
    if (Array.isArray(v)) return v[0];
    return v;
  };
  return {
    id: lookup("svix-id"),
    timestamp: lookup("svix-timestamp"),
    signature: lookup("svix-signature"),
  };
}

function decodeSecret(secret: string): Buffer | null {
  if (secret.startsWith("whsec_")) {
    try {
      return Buffer.from(secret.slice("whsec_".length), "base64");
    } catch {
      return null;
    }
  }
  return Buffer.from(secret, "utf8");
}

export function verifySvixSignature(
  rawBody: string | Buffer,
  headers: SvixHeaders,
  signingSecret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SvixVerifyResult {
  if (!signingSecret) return { ok: false, reason: "missing_secret" };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_AGE_S) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const secretBytes = decodeSecret(signingSecret);
  if (!secretBytes) return { ok: false, reason: "invalid_secret_encoding" };

  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${id}.${timestamp}.${bodyStr}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Svix-signature header: space-separated signatures, each "v1,<base64>".
  // The library treats prefixes like "v1a," or others as unknown -> ignore.
  const candidates = signature.split(/\s+/);
  for (const candidate of candidates) {
    const idx = candidate.indexOf(",");
    if (idx < 0) continue;
    const scheme = candidate.slice(0, idx);
    if (scheme !== "v1") continue;
    const sigBuf = Buffer.from(candidate.slice(idx + 1));
    if (sigBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "invalid_signature" };
}
