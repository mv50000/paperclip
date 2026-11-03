// --- RK9 Custom (RK9-626, RK9-625, RK9-641): coord bus free-text hygiene ---
//
// The one redaction module of the coord bus (RK9-641 merged the RK9-625 copy,
// rk9-coord-redact.ts, into this file). Every free-text field the coord bus
// stores (event summaries, payload text, message bodies, presence phase and
// name) goes through toRk9CoordLine() before the insert: secrets are
// redacted, the text is collapsed to one line and capped. Verbatim fields
// (identifiers, metadata) are checked with rk9CoordIdentifierHasSecret() or
// rk9CoordTextHasSecret() and rejected instead. No model calls: this runs in
// the hook path (< 0.3 s budget).
//
// The default pattern is the RK9_SESSIONS_SECRET_RX default of
// ~/.claude/bin/rk9-sessions.sh (RK9-549), so the client filter and the server
// filter agree. The bash default is a Python `re` pattern used with re.I; it
// is copied verbatim with the shell quoting removed (`["'"'"']` in the script
// is the class `["']`). An override that is not a valid JS RegExp falls back
// to the default (fail closed). Contract: docs/implementation-notes/coord-bus.md.
import { logger } from "../middleware/logger.js";

/** Port of the RK9_SESSIONS_SECRET_RX default (Python `re.I` -> JS `gi`). */
export const RK9_COORD_SECRET_RX_DEFAULT =
  "(gh[opusr]_|github_pat_|pcp_[a-z]+_|vck_|qmk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|xox[abpors]-|glpat-)[A-Za-z0-9_-]{6,}" +
  "|AKIA[0-9A-Z]{12,}" +
  "|AIza[0-9A-Za-z_-]{20,}" +
  "|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9._-]+" +
  "|-----BEGIN [A-Z ]*PRIVATE KEY-----" +
  "|://[^ /:@]+:[^ /@]+@" +
  "|(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{8,}" +
  "|((token|secret|password|passwd|api[_-]?key|apikey)[\"']?\\s*[=:]\\s*)[\"']?[^\\s\"',;]{6,}";

export const RK9_COORD_REDACTED = "[redacted]";

/** Coord tokens are always redacted, whatever the env pattern says. */
const COORD_TOKEN_RX = /rk9_coord_[A-Za-z0-9_-]{6,}/gi;
/**
 * The keyword rule, always applied on top of the env pattern, in a wider
 * form (RK9-641): singular and plural keywords (`token`, `secrets`,
 * `api_keys`, ...); `=`, `:`, `->`, `=>` and URL-encoded `%3D` / `%3A` as
 * the separator; and a bracketed value (`"tokens": ["..."]`, `"secrets":
 * {"db": "..."}`, `secrets=(...)`), whose content up to the first closing
 * bracket goes (to the end of the text when it has none). Full-width forms
 * are caught by the NFKC matching reading, not here.
 */
const KEYWORD_RX =
  /((?:token|secret|password|passwd|api[_-]?key|apikey)s?["']?\s*(?:[=:]|->|=>|%3[ad])\s*)(?:([[{(]\s*[^\]})]{6,}[\]})]?)|["']?[^\s"',;]{6,})/gi;
/** Patterns applied whatever RK9_SESSIONS_SECRET_RX says. */
const ALWAYS_RX = [COORD_TOKEN_RX, KEYWORD_RX];
/**
 * The one bracketed value that stays: a JSON object of counters after
 * `token` or `tokens` (`"tokens": {"input": 1234, "output": 56}`, nested
 * `{"cache": {"read": 1}}` too; the RK9-642 numbers rule). It holds only
 * braces, commas, colons, keys that are words without digits, and JSON
 * numbers, booleans or null; a string value, an array, parentheses or a
 * digit in a key is redacted. Under `password`, `secret` or `api_key` no
 * bracketed value stays. A number may not be followed by another digit, so
 * the pattern cannot split one number into many (no catastrophic
 * backtracking).
 */
/** One token of a counter object; sticky, so the scan below never backtracks. */
const COUNTER_TOKEN_RX = /\s+|[{},:]|(["']?)([A-Za-z_][A-Za-z_-]{0,39})\1|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const COUNTER_KEY_FOLLOW_RX = /\s*:/y;
const COUNTER_LITERALS = new Set(["true", "false", "null"]);

/**
 * Linear scan (RK9-641 round 3: a regex with a key-or-literal alternation
 * backtracked exponentially on `true:true:...`). Each word must be a key
 * (followed by `:`) or an unquoted true/false/null; a number must not run
 * into a digit, dot or letter.
 */
function isRk9CoordCounterMap(content: string): boolean {
  if (content.length > 4096 || !content.startsWith("{") || !content.endsWith("}")) return false;
  let index = 0;
  while (index < content.length) {
    COUNTER_TOKEN_RX.lastIndex = index;
    const token = COUNTER_TOKEN_RX.exec(content);
    if (!token || token[0].length === 0) return false;
    const end = index + token[0].length;
    if (token[2] !== undefined) {
      COUNTER_KEY_FOLLOW_RX.lastIndex = end;
      const isKey = COUNTER_KEY_FOLLOW_RX.test(content);
      if (!isKey && !(token[1] === "" && COUNTER_LITERALS.has(token[2]))) return false;
    } else if (/^-?\d/.test(token[0]) && end < content.length && /[\d.eEA-Za-z_]/.test(content[end]!)) {
      return false;
    }
    index = end;
  }
  return true;
}
const COUNTER_KEYWORD_RX = /^tokens?(?![a-z])/i;

/**
 * Removed from display (stored) text: soft hyphen, combining grapheme joiner,
 * Mongolian vowel separator, zero-width space, word joiner and invisible
 * operators, bidi marks, embeddings, overrides and isolates, the BOM, the stand-alone
 * Hangul fillers and the tag characters (ASCII smuggling).
 */
const DISPLAY_INVISIBLE_RX =
  /[\u00ad\u034f\u061c\u200e\u200f\u180e\u200b\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\uffa0\ufeff\u{E0000}-\u{E007F}]/gu;
/**
 * Joiners and selectors stay in display text when they stand alone or in
 * pairs (RK9-641): ZWJ builds emoji sequences (\u{1F469}\u200d\u{1F4BB}, \u2764\ufe0f\u200d\u{1F525} = U+FE0F U+200D),
 * ZWNJ is part of Persian spelling, VS16 picks the emoji form. A run of three
 * or more is steganography (emoji smuggling), not text, and is removed.
 */
const JOINER_RUN_RX = /[\u200c\u200d\ufe00-\ufe0f\u{E0100}-\u{E01EF}]{3,}/gu;
/** C0 controls other than whitespace, DEL and C1 controls: removed. */
// eslint-disable-next-line no-control-regex
const CONTROL_RX = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
 * Removed (or turned into a space) before matching only: every format
 * character (\p{Cf}: the display list plus ZWJ, ZWNJ, bidi marks), every
 * combining mark (\p{Mn}, \p{Me}: CGJ, accents, variation selectors), the
 * Hangul fillers and the C0/DEL/C1 controls. None of them may split a
 * keyword or a token so that the pattern misses it.
 */
// eslint-disable-next-line no-control-regex
const MATCH_INVISIBLE_RX = /[\p{Cf}\p{Mn}\p{Me}\u115f\u1160\u3164\uffa0\u2800\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;
/** Whitespace (tab, newline, Unicode spaces, line/paragraph separators). */
const WHITESPACE_RX = /\s+/g;

let cachedSource: string | undefined;
let cachedRx: RegExp | null = null;

/** The active secret pattern (RK9_SESSIONS_SECRET_RX or the default), case-insensitive. */
export function rk9CoordSecretRx(env: NodeJS.ProcessEnv = process.env): RegExp {
  const source = env.RK9_SESSIONS_SECRET_RX?.trim() || RK9_COORD_SECRET_RX_DEFAULT;
  if (cachedRx && cachedSource === source) return cachedRx;
  try {
    cachedRx = new RegExp(source, "gi");
  } catch (err) {
    logger.warn(
      { event: "rk9_coord_secret_rx_invalid", err: err instanceof Error ? err.message : String(err) },
      "RK9_SESSIONS_SECRET_RX is not a valid JS RegExp; using the built-in default",
    );
    cachedRx = new RegExp(RK9_COORD_SECRET_RX_DEFAULT, "gi");
  }
  cachedSource = source;
  return cachedRx;
}

/** Replace every secret-looking match with `[redacted]`; the rest of the text stays. */
export function redactRk9CoordText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const rx = rk9CoordSecretRx(env);
  rx.lastIndex = 0;
  return text
    .replace(rx, RK9_COORD_REDACTED)
    .replace(COORD_TOKEN_RX, RK9_COORD_REDACTED)
    .replace(KEYWORD_RX, (match: string, prefix: string, bracket: string | undefined) =>
      bracket !== undefined && COUNTER_KEYWORD_RX.test(prefix) && isRk9CoordCounterMap(bracket)
        ? match
        : RK9_COORD_REDACTED,
    );
}

/**
 * Display form: controls and the invisible characters of
 * DISPLAY_INVISIBLE_RX are removed, joiner runs of three or more go, and
 * every run of whitespace becomes one space.
 */
export function collapseRk9CoordText(text: string): string {
  return text
    .replace(CONTROL_RX, "")
    .replace(DISPLAY_INVISIBLE_RX, "")
    .replace(JOINER_RUN_RX, "")
    .replace(WHITESPACE_RX, " ")
    .trim();
}

/**
 * Matching form: every invisible character goes (ZWJ, ZWNJ, selectors and
 * combining marks included), then NFKC folds full-width and compatibility
 * forms (`\uff54\uff4f\uff4b\uff45\uff4e` -> `token`). Use it to test text, not to store it.
 */
export function rk9CoordMatchText(text: string): string {
  const stripped = text.replace(MATCH_INVISIBLE_RX, "");
  return stripped.normalize("NFKC").replace(MATCH_INVISIBLE_RX, "").replace(WHITESPACE_RX, " ").trim();
}

/**
 * The other matching reading: every invisible character becomes a space, so
 * `Bearer\u200b<token>` reads `Bearer <token>` (removing it would glue the
 * keyword to the token and `\s+` would miss it).
 */
function rk9CoordSpacedText(text: string): string {
  const spaced = text.replace(MATCH_INVISIBLE_RX, " ");
  return spaced.normalize("NFKC").replace(MATCH_INVISIBLE_RX, " ").replace(WHITESPACE_RX, " ").trim();
}

/** Every reading a secret check looks at. */
function rk9CoordReadings(text: string): string[] {
  return [
    text,
    collapseRk9CoordText(text),
    rk9CoordMatchText(text),
    rk9CoordSpacedText(text),
    // RK9-641: the two mixed readings. Controls as spaces and the other
    // invisible characters removed (`Bearer<SOH>abcd<ZWSP>efgh...`), and the
    // reverse.
    rk9CoordMatchText(text.replace(CONTROL_RX, " ")),
    rk9CoordSpacedText(text.replace(CONTROL_RX, "")),
  ];
}

/** Any control, format, combining or filler character (the matching set). */
const HAS_INVISIBLE_RX = new RegExp(MATCH_INVISIBLE_RX.source, "u");
/**
 * Bearer or Basic at a word start, then one or more invisible characters as
 * the only separator, then 8+ token characters with invisible characters
 * between them (RK9-641 round 2: `Bearer<ZWSP>abcd<ZWSP>efgh...`; no single
 * reading of the whole text has both a space and the joined token). Matched
 * on the raw text, so `basic-auth` next to an emoji is not a secret. The
 * token-character class and the invisible class are disjoint, so the
 * repetition cannot backtrack.
 */
const GLUED_AUTH_RX = new RegExp(
  `(?<![A-Za-z0-9])(?:bearer|basic)${MATCH_INVISIBLE_RX.source}+(?:[A-Za-z0-9._~+/=-]${MATCH_INVISIBLE_RX.source}*){8,}`,
  "iu",
);

/**
 * True when any reading of the text (raw, display, matching) contains
 * anything the redaction would replace.
 */
export function rk9CoordTextHasSecret(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // The raw text is what a verbatim field stores (a tab inside a URL
  // credential only matches raw); the other forms defeat control-character,
  // zero-width and full-width obfuscation.
  for (const form of rk9CoordReadings(text)) {
    if (redactRk9CoordText(form, env) !== form) return true;
  }
  return GLUED_AUTH_RX.test(text);
}

/**
 * A match counts at a word start (not after a letter or digit), or anywhere
 * when it starts with a non-alphanumeric character. A lookbehind in the
 * pattern instead of a filter after matching (RK9-641): a mid-word candidate
 * such as `sk-runner_...` in `task-runner_ghp_...` is never matched, so it
 * cannot eat the real token after it. A URL credential (`://user:pw@`)
 * starts with `:`, which always follows the scheme letter, so it counts too.
 */
const WORD_START = "(?:(?<![A-Za-z0-9])|(?=[^A-Za-z0-9]))";
const identifierRxCache = new Map<string, RegExp>();

function identifierRx(pattern: RegExp): RegExp {
  const key = `${pattern.flags}/${pattern.source}`;
  let rx = identifierRxCache.get(key);
  if (!rx) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    rx = new RegExp(`${WORD_START}(?:${pattern.source})`, flags);
    if (identifierRxCache.size > 16) identifierRxCache.clear();
    identifierRxCache.set(key, rx);
  }
  rx.lastIndex = 0;
  return rx;
}

/**
 * Secret check for grammar-restricted identifiers (repo, app, names, ids).
 * `task-runner` or `kiosk-frontend` contain `sk-...` mid-word and are
 * ordinary names, while `sk-abc...`, `pcp_board_...` at the start of a part
 * or `https://user:pw@host` are not. The raw text and both matching
 * readings (invisible characters removed, and as spaces) are checked.
 */
export function rk9CoordIdentifierHasSecret(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // The matching readings too (RK9-641): a combining mark, selector, blank
  // filler or full-width form must not hide a token in a verbatim field.
  for (const form of new Set([text, rk9CoordMatchText(text), rk9CoordSpacedText(text)])) {
    for (const pattern of [rk9CoordSecretRx(env), ...ALWAYS_RX]) {
      if (identifierRx(pattern).test(form)) return true;
    }
  }
  return GLUED_AUTH_RX.test(text);
}

/**
 * Redact, collapse to one line, trim and cap at `max` code points (an
 * ellipsis marks a cut). Empty -> null. Redaction runs before the cap, so a
 * cap can never cut a secret in half and leave its prefix visible.
 */
export function toRk9CoordLine(
  text: string | null | undefined,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (text === null || text === undefined) return null;
  // Redact the raw text first: a pattern may span a tab or newline
  // (`[^ /@]+` matches a tab but not the space it collapses to). Then
  // collapse and redact again: JS \s misses most C0 controls, so
  // `token\x01=\x01<value>` only matches once the controls are gone.
  let line = redactRk9CoordText(collapseRk9CoordText(redactRk9CoordText(text, env)), env);
  // Fail closed (RK9-641, after the verifier showed that counting
  // `[redacted]` markers can be fooled by a literal marker in the text):
  // - a text with any control, format, combining or filler character becomes
  //   `[redacted]` as a whole when any reading of it shows a secret. Such
  //   characters can split a secret past the pattern or be the only separator
  //   (`Bearer<ZWSP><token>`), and the display form keeps single joiners;
  // - any text whose stored line still shows a secret in some reading
  //   (full-width forms) becomes `[redacted]` too.
  // A plain text with an ordinary secret keeps the rest of the line.
  if ((HAS_INVISIBLE_RX.test(text) && rk9CoordTextHasSecret(text, env)) || rk9CoordTextHasSecret(line, env)) {
    line = RK9_COORD_REDACTED;
  }
  // A text of only invisible characters (`\u200d`) is empty.
  if (line.length === 0 || rk9CoordMatchText(line).length === 0) return null;
  const points = Array.from(line);
  if (points.length <= max) return line;
  return `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}\u2026`;
}
// --- /RK9 Custom ---
