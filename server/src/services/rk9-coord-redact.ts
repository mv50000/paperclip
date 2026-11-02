// --- RK9 Custom (RK9-625): secret redaction for coord free text ---
//
// Port of RK9_SESSIONS_SECRET_RX from ~/.claude/bin/rk9-sessions.sh (line 27,
// RK9-549). The bash default is a Python `re` pattern used with re.I; every
// construct in it (\s, character classes, alternation) means the same in a JS
// RegExp except `\s`, which in Python also matches \x1c-\x1f. The string is
// copied verbatim with the shell quoting removed (`["'"'"']` in the script is
// the class `["']`); toRk9CoordLine() turns every control character into a
// space before matching, which covers the `\s` difference.
//
// The same env var may override the pattern on a host. An override that is
// not a valid JS RegExp falls back to the default (fail closed: redaction
// never turns off because of a bad env value).
//
// rk9_coord_ tokens are always redacted on top of the configurable pattern:
// the bus must never store its own credential (the rk9 CLI filters it too).
//
// Export names are shared with the journal/inbox child (RK9-626), so the two
// copies can be merged by swapping an import path.
import { logger } from "../middleware/logger.js";

export const RK9_COORD_SECRET_RX_DEFAULT =
  "(gh[opusr]_|github_pat_|pcp_[a-z]+_|vck_|qmk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|xox[abpors]-|glpat-)[A-Za-z0-9_-]{6,}" +
  "|AKIA[0-9A-Z]{12,}" +
  "|AIza[0-9A-Za-z_-]{20,}" +
  "|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9._-]+" +
  "|-----BEGIN [A-Z ]*PRIVATE KEY-----" +
  "|://[^ /:@]+:[^ /@]+@" +
  "|(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{8,}" +
  "|((token|secret|password|passwd|api[_-]?key|apikey)[\"']?\\s*[=:]\\s*)[\"']?[^\\s\"',;]{6,}";

const COORD_TOKEN_RX = /rk9_coord_[A-Za-z0-9_-]{6,}/gi;
/**
 * Plural keyword forms (`tokens=`, `secrets:`, `passwords=`, `api_keys=`) that
 * the copied default misses; always applied on top, like the coord token.
 */
const PLURAL_KEYWORD_RX =
  /((tokens|secrets|passwords|passwds|api[_-]?keys|apikeys)["']?\s*[=:]\s*)["']?[^\s"',;]{6,}/gi;
export const RK9_COORD_REDACTED = "[redacted]";

let cached: { source: string | undefined; rx: RegExp } | null = null;

function compile(source: string | undefined): RegExp {
  const pattern = source && source.length > 0 ? source : RK9_COORD_SECRET_RX_DEFAULT;
  try {
    return new RegExp(pattern, "gi");
  } catch (err) {
    logger.warn(
      { event: "rk9_coord_secret_rx_invalid", err: err instanceof Error ? err.message : String(err) },
      "RK9_SESSIONS_SECRET_RX is not a valid JS RegExp; using the built-in default",
    );
    return new RegExp(RK9_COORD_SECRET_RX_DEFAULT, "gi");
  }
}

/** The active secret pattern (RK9_SESSIONS_SECRET_RX or the default), case-insensitive. */
export function rk9CoordSecretRx(env: NodeJS.ProcessEnv = process.env): RegExp {
  const source = env.RK9_SESSIONS_SECRET_RX;
  if (!cached || cached.source !== source) cached = { source, rx: compile(source) };
  return cached.rx;
}

/** Replace every secret-looking match with [redacted]; the rest of the text stays. */
export function redactRk9CoordText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const rx = rk9CoordSecretRx(env);
  rx.lastIndex = 0;
  return text
    .replace(rx, RK9_COORD_REDACTED)
    .replace(COORD_TOKEN_RX, RK9_COORD_REDACTED)
    .replace(PLURAL_KEYWORD_RX, RK9_COORD_REDACTED);
}

/**
 * Invisible characters removed from display text: soft hyphen (U+00AD), the
 * combining grapheme joiner (U+034F), the Mongolian vowel separator (U+180E),
 * zero-width space and non-joiner (U+200B, U+200C), the word joiner and the
 * invisible operators (U+2060-U+2064) and the BOM (U+FEFF). The zero-width
 * joiner (U+200D) stays: it builds emoji sequences such as 👩\u200d💻.
 */
const DISPLAY_INVISIBLE_RX = /[\u00ad\u034f\u180e\u200b\u200c\u2060-\u2064\ufeff]/g;
/**
 * Invisible characters removed before matching only: every format character
 * (\p{Cf}: the display list above plus ZWJ, bidi controls, tag characters),
 * the combining grapheme joiner and variation selectors. None of them may
 * split a keyword or a token so that the pattern misses it.
 */
const MATCH_INVISIBLE_RX = /[\p{Cf}\u034f\ufe00-\ufe0f]/gu;
// eslint-disable-next-line no-control-regex
const WHITESPACE_CONTROL_RX = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Display form: the invisible characters of DISPLAY_INVISIBLE_RX are removed
 * (ZWJ stays), then every run of whitespace and control characters (C0, DEL,
 * C1, line separators) becomes one space.
 */
export function collapseRk9CoordText(text: string): string {
  return text.replace(DISPLAY_INVISIBLE_RX, "").replace(WHITESPACE_CONTROL_RX, " ").trim();
}

/**
 * Matching form: like collapseRk9CoordText, but every format character goes,
 * ZWJ included (RK9-642). Use it to test text, never to store it.
 */
export function rk9CoordMatchText(text: string): string {
  return text.replace(MATCH_INVISIBLE_RX, "").replace(WHITESPACE_CONTROL_RX, " ").trim();
}

/**
 * True when the raw, the display or the matching form of the text contains
 * anything the redaction would replace.
 */
export function rk9CoordTextHasSecret(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // All forms: the raw text is what gets stored (a tab inside a URL
  // credential only matches raw), the collapsed ones defeat control-char and
  // zero-width obfuscation.
  for (const form of [text, collapseRk9CoordText(text), rk9CoordMatchText(text)]) {
    if (redactRk9CoordText(form, env) !== form) return true;
  }
  return false;
}

/**
 * Collapse to one line, redact, trim and cap at `max` code points. Returns
 * null for text that is empty after cleaning. Redaction runs before the cap,
 * so a cap can never cut a secret in half and leave its prefix visible.
 */
export function toRk9CoordLine(
  text: string | null | undefined,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (text === null || text === undefined) return null;
  // Collapse BEFORE redacting: JS \s misses most C0 controls (Python's \s
  // matches \x1c-\x1f), so "Bearer\x01<token>" must become "Bearer <token>"
  // before the pattern sees it, or the collapse would rebuild a secret the
  // pattern skipped.
  const collapsed = collapseRk9CoordText(text);
  let line = redactRk9CoordText(collapsed, env);
  // The display form keeps ZWJ and bidi controls, so `pass\u200dword=...`
  // survives the redaction above. When the matching form still shows a
  // secret, redact the matching form instead (those characters go too).
  if (rk9CoordTextHasSecret(line, env)) line = redactRk9CoordText(rk9CoordMatchText(collapsed), env);
  if (line.length === 0) return null;
  const points = Array.from(line);
  return points.length > max ? points.slice(0, max).join("").trimEnd() : line;
}
// --- /RK9 Custom ---
