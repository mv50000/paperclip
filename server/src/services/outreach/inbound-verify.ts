// RK9-195: HMAC verification for the `/api/outreach/inbound` relay.
//
// Same signed-content shape as `svix-verify.ts` (`${timestamp}.${body}`,
// HMAC-SHA256, timing-safe compare, 5-minute replay window) but with our own
// headers and a single shared secret — there is no per-tenant secret model
// here (the relay speaks for the whole outreach domain, not one company).

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_AGE_S = 5 * 60;

export type OutreachInboundVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_secret" | "missing_headers" | "invalid_timestamp" | "stale_timestamp" | "invalid_signature";
    };

export interface OutreachInboundHeaders {
  timestamp: string | undefined;
  signature: string | undefined;
}

export function readOutreachInboundHeaders(
  headers: Record<string, string | string[] | undefined>,
): OutreachInboundHeaders {
  const lookup = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    timestamp: lookup("x-outreach-timestamp"),
    signature: lookup("x-outreach-signature"),
  };
}

export function verifyOutreachInboundSignature(
  rawBody: Buffer,
  headers: OutreachInboundHeaders,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): OutreachInboundVerifyResult {
  if (!secret) return { ok: false, reason: "missing_secret" };
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_AGE_S) return { ok: false, reason: "stale_timestamp" };

  const signedContent = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
  const expected = "sha256=" + createHmac("sha256", secret).update(signedContent).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return { ok: false, reason: "invalid_signature" };
  if (!timingSafeEqual(expectedBuf, providedBuf)) return { ok: false, reason: "invalid_signature" };
  return { ok: true };
}
