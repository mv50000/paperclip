/**
 * Webhook-mode helpers (A5, RK9-509): verify X-Telegram-Bot-Api-Secret-Token.
 *
 * The webhook route is public and unauthenticated, so a delivery is accepted
 * only when this header matches the configured secret of a webhook-mode bot.
 * Secrets are kept as sha256 digests. The comparison hashes the header and
 * compares equal-length digests with `timingSafeEqual`, against every
 * candidate (no early exit), so timing does not reveal a prefix or the match.
 * A missing, empty or repeated header is refused.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { TelegramUpdate } from "./bot-api.js";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** Telegram's own rule for `secret_token`: 1-256 chars of A-Z, a-z, 0-9, _ and -. */
export function isValidWebhookSecret(secret: unknown): secret is string {
  return typeof secret === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(secret);
}

export function webhookSecretDigest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export interface WebhookSecretCandidate<T> {
  digest: Buffer;
  value: T;
}

export type WebhookVerification<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "missing_header" | "repeated_header" | "mismatch" };

function headerValues(headers: Record<string, string | string[] | undefined>, name: string): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) out.push(...value);
    else if (typeof value === "string") out.push(value);
  }
  return out;
}

export function verifyWebhookSecret<T>(
  headers: Record<string, string | string[] | undefined>,
  candidates: readonly WebhookSecretCandidate<T>[],
): WebhookVerification<T> {
  const values = headerValues(headers, TELEGRAM_SECRET_HEADER);
  if (values.length === 0 || values[0] === "") return { ok: false, reason: "missing_header" };
  // Node joins a repeated header with ", "; neither form is something Telegram sends.
  if (values.length > 1 || values[0]!.includes(",")) return { ok: false, reason: "repeated_header" };
  const provided = webhookSecretDigest(values[0]!);
  let match: T | undefined;
  let matched = false;
  for (const candidate of candidates) {
    if (candidate.digest.length !== provided.length) continue;
    if (timingSafeEqual(candidate.digest, provided) && !matched) {
      matched = true;
      match = candidate.value;
    }
  }
  return matched ? { ok: true, value: match as T } : { ok: false, reason: "mismatch" };
}

/** Reads a Telegram update from a webhook body. Returns null when it is not one. */
export function parseWebhookUpdate(parsedBody: unknown, rawBody: string): TelegramUpdate | null {
  let body = parsedBody;
  if (body === undefined || body === null || typeof body !== "object") {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
  }
  const update = body as Partial<TelegramUpdate> | null;
  if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id)) return null;
  return update as TelegramUpdate;
}
