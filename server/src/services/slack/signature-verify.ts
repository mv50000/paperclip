import { createHmac, timingSafeEqual } from "node:crypto";

const SLACK_VERSION = "v0";
const MAX_TIMESTAMP_AGE_S = 5 * 60;

export interface SlackSignatureHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
}

export type SlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "missing_headers" | "stale_timestamp" | "invalid_signature" };

export function readSlackSignatureHeaders(
  headers: Record<string, string | string[] | undefined>,
): SlackSignatureHeaders {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  const lookup = (name: string): string | undefined => {
    const value = normalized[name];
    if (Array.isArray(value)) return value[0];
    return value;
  };
  return {
    signature: lookup("x-slack-signature"),
    timestamp: lookup("x-slack-request-timestamp"),
  };
}

export function verifySlackSignature(
  rawBody: string,
  headers: SlackSignatureHeaders,
  signingSecret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SlackSignatureResult {
  if (!signingSecret) return { ok: false, reason: "missing_secret" };
  const { signature, timestamp } = headers;
  if (!signature || !timestamp) return { ok: false, reason: "missing_headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_AGE_S) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const base = `${SLACK_VERSION}:${timestamp}:${rawBody}`;
  const computed = `${SLACK_VERSION}=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  if (computed.length !== signature.length) return { ok: false, reason: "invalid_signature" };
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}
