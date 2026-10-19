/**
 * The last pass over a DTO that leaves the worker for the UI (A12, RK9-518).
 * A stored error text was redacted when it was written; this pass runs again
 * when it is read (RK9-563), so a row written before a redaction fix, or by a
 * path that missed it, still shows no token.
 */

import { REDACTED, redactValue } from "../../meta/redact.js";

/**
 * Telegram bot token shape (`<bot id>:<secret>`); redactText covers Meta
 * tokens. The id starts after a character that cannot be part of a token,
 * or right after `bot`: in a Bot API URL the id follows `/bot` directly
 * (`/bot123456:SECRET/sendMessage`, RK9-563). So the digits inside a longer
 * id or hash are not taken for one (RK9-581).
 */
export const BOT_TOKEN_RE = /(?:(?<=bot)|(?<![A-Za-z0-9_-]))\d{6,}:[A-Za-z0-9_-]{30,}/g;

/** Token shapes are redacted even in free text (errors, Meta details). */
export function sanitize<T>(dto: T): T {
  const redacted = redactValue(dto);
  return JSON.parse(JSON.stringify(redacted).replace(BOT_TOKEN_RE, REDACTED)) as T;
}
