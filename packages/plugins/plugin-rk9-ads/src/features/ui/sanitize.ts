/**
 * The last pass over a DTO that leaves the worker for the UI (A12, RK9-518).
 * A stored error text was redacted when it was written; this pass runs again
 * when it is read (RK9-563), so a row written before a redaction fix, or by a
 * path that missed it, still shows no token.
 */

import { REDACTED, redactValue } from "../../meta/redact.js";

/**
 * Telegram bot token shape (`<bot id>:<secret>`); redactText covers Meta
 * tokens. No word boundary: in a Bot API URL the id follows `/bot` directly
 * (`/bot123456:SECRET/sendMessage`, RK9-563), and the pattern runs over JSON
 * text, where a newline before a token is the letter pair `\n`. A boundary
 * let such tokens through (RK9-581 verifier), so a non-secret string of the
 * same shape is masked too: a masked string costs less than a leaked token.
 */
export const BOT_TOKEN_RE = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

/** Token shapes are redacted even in free text (errors, Meta details). */
export function sanitize<T>(dto: T): T {
  const redacted = redactValue(dto);
  return JSON.parse(JSON.stringify(redacted).replace(BOT_TOKEN_RE, REDACTED)) as T;
}
