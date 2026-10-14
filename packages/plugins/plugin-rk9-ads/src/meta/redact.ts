/**
 * Token redaction for everything the Meta client writes or throws (RK9-508).
 *
 * Two layers:
 * 1. Known values: the client passes the token it resolved for the call, and
 *    every occurrence is replaced, wherever it sits.
 * 2. Shapes: `access_token=...` in a URL or query string, `Bearer ...` and a
 *    Meta user/system user token shape (`EAA...`). This catches a token the
 *    client did not resolve itself, for example one echoed in a paging URL.
 */

export const REDACTED = "[REDACTED]";

const MIN_KNOWN_SECRET_LENGTH = 8;

const SHAPE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // access_token=... in a URL, a query string or a form body.
  [/(access_token=)[^&\s"'#]+/gi, `$1${REDACTED}`],
  // "access_token": "..." in JSON text.
  [/("access_token"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
  // Authorization header values.
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${REDACTED}`],
  // Meta access tokens start with EAA and are long base62 strings.
  [/\bEAA[A-Za-z0-9]{20,}/g, REDACTED],
];

/** Object keys whose values are dropped whole, whatever they hold. */
const SECRET_KEY_RE = /^(access_token|authorization|appsecret_proof|token|client_secret)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts known secret values and token shapes in a string. */
export function redactText(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (typeof secret !== "string" || secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    // A token can also appear URL-encoded (in a logged URL or a form body).
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.replace(new RegExp(escapeRegExp(encoded), "g"), REDACTED);
  }
  for (const [pattern, replacement] of SHAPE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Returns a redacted deep copy of a JSON-like value. Secret-named keys are
 * replaced whole, strings go through `redactText`, and cycles, functions and
 * class instances other than Error, Date and URL are flattened to safe text.
 */
export function redactValue<T>(value: T, knownSecrets: readonly string[] = []): T {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") return redactText(input, knownSecrets);
    if (input === null || typeof input !== "object") {
      return typeof input === "function" || typeof input === "symbol" ? undefined : input;
    }
    if (depth > 20) return "[Truncated]";
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (input instanceof URL) return redactText(input.toString(), knownSecrets);
    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      // Name and message only: never the stack or the cause chain.
      return { name: input.name, message: redactText(input.message, knownSecrets) };
    }
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : visit(item, depth + 1);
    }
    return out;
  };

  return visit(value, 0) as T;
}

/**
 * Removes `access_token` and `appsecret_proof` (any letter case) from a URL's query. Used on
 * paging `next` URLs before the client fetches them with its own header.
 */
export function stripAccessToken(url: string | URL): URL {
  const parsed = new URL(url.toString());
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(access_token|appsecret_proof)$/i.test(key)) parsed.searchParams.delete(key);
  }
  return parsed;
}
