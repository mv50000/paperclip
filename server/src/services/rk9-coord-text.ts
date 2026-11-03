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
 * the separator; and a JSON array or object as the value (`"tokens":
 * ["..."]`, `"secrets": {"db": "..."}`), whose content up to the closing
 * bracket goes. Full-width forms (`ｔｏｋｅｎ＝...`) are caught by the NFKC
 * matching reading, not here.
 */
const KEYWORD_RX =
  /((?:token|secret|password|passwd|api[_-]?key|apikey)s?["']?\s*(?:[=:]|->|=>|%3[ad])\s*)(?:([[{(]\s*[^\]})]{6,200}[\]})]?)|["']?[^\s"',;]{6,})/gi;
/** Patterns applied whatever RK9_SESSIONS_SECRET_RX says. */
const ALWAYS_RX = [COORD_TOKEN_RX, KEYWORD_RX];
/** One item of a bracketed value: a quoted or bare string, and whether a `:` makes it a key. */
const BRACKET_ITEM_RX = /"((?:[^"\\]|\\.)*)"(\s*:)?|'([^']*)'(\s*:)?|([^\s"',:[\]{}()]+)(\s*:)?/g;
const NOT_SECRET_SCALAR_RX = /^(?:[-+]?[\d.eE+-]+|true|false|null)$/;

/**
 * A bracketed value counts as a secret only when it holds a value (not a
 * key) of 6+ characters that is not a number, boolean or null: token counts
 * such as `"tokens": {"input": 1234}` stay (the RK9-642 numbers rule).
 */
function bracketHasSecretValue(content: string): boolean {
  for (const item of content.matchAll(BRACKET_ITEM_RX)) {
    if (item[2] ?? item[4] ?? item[6]) continue;
    const value = item[1] ?? item[3] ?? item[5] ?? "";
    if (value.length >= 6 && !NOT_SECRET_SCALAR_RX.test(value)) return true;
  }
  return false;
}

/**
 * Removed from display (stored) text: soft hyphen, combining grapheme joiner,
 * Mongolian vowel separator, zero-width space, word joiner and invisible
 * operators, bidi embeddings, overrides and isolates, the BOM, the stand-alone
 * Hangul fillers and the tag characters (ASCII smuggling).
 */
const DISPLAY_INVISIBLE_RX =
  /[­͏᠎​‪-‮⁠-⁤⁦-⁩ㅤﾠ﻿\u{E0000}-\u{E007F}]/gu;
/**
 * Joiners and selectors stay in display text when they stand alone or in
 * pairs (RK9-641): ZWJ builds emoji sequences (👩‍💻, ❤️‍🔥 = U+FE0F U+200D),
 * ZWNJ is part of Persian spelling, VS16 picks the emoji form. A run of three
 * or more is steganography (emoji smuggling), not text, and is removed.
 */
const JOINER_RUN_RX = /[‌‍︀-️\u{E0100}-\u{E01EF}]{3,}/gu;
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
const MATCH_INVISIBLE_RX = /[\p{Cf}\p{Mn}\p{Me}ᅟᅠㅤﾠ\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;
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
    .replace(KEYWORD_RX, (match: string, _prefix: string, bracket: string | undefined) =>
      bracket !== undefined && !bracketHasSecretValue(bracket) ? match : RK9_COORD_REDACTED,
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
 * forms (`ｔｏｋｅｎ` -> `token`). Use it to test text, not to store it.
 */
export function rk9CoordMatchText(text: string): string {
  const stripped = text.replace(MATCH_INVISIBLE_RX, "");
  return stripped.normalize("NFKC").replace(MATCH_INVISIBLE_RX, "").replace(WHITESPACE_RX, " ").trim();
}

/**
 * The other matching reading: every invisible character becomes a space, so
 * `Bearer​<token>` reads `Bearer <token>` (removing it would glue the
 * keyword to the token and `\s+` would miss it).
 */
function rk9CoordSpacedText(text: string): string {
  const spaced = text.replace(MATCH_INVISIBLE_RX, " ");
  return spaced.normalize("NFKC").replace(MATCH_INVISIBLE_RX, " ").replace(WHITESPACE_RX, " ").trim();
}

/**
 * True when the raw, the display or a matching form of the text contains
 * anything the redaction would replace.
 */
export function rk9CoordTextHasSecret(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // The raw text is what a verbatim field stores (a tab inside a URL
  // credential only matches raw); the other forms defeat control-character,
  // zero-width and full-width obfuscation.
  for (const form of [text, collapseRk9CoordText(text), rk9CoordMatchText(text), rk9CoordSpacedText(text)]) {
    if (redactRk9CoordText(form, env) !== form) return true;
  }
  return false;
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
 * or `https://user:pw@host` are not.
 */
export function rk9CoordIdentifierHasSecret(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const pattern of [rk9CoordSecretRx(env), ...ALWAYS_RX]) {
    if (identifierRx(pattern).test(text)) return true;
  }
  return false;
}

function countRedactions(text: string): number {
  return text.split(RK9_COORD_REDACTED).length - 1;
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
  const raw = redactRk9CoordText(text, env);
  let line = redactRk9CoordText(collapseRk9CoordText(raw), env);
  // The display form keeps single joiners and selectors (`pass‍word=...`)
  // and removes a control or ZWSP that is the only separator
  // (`Bearer​<token>`), so a secret can survive the redaction above.
  // When a matching reading finds more secrets, keep the stripped reading
  // only if both redacted readings are the same text apart from whitespace
  // and come out clean; otherwise redact the whole field (fail closed: each
  // reading may find a different secret). The readings start from the
  // raw-redacted text, so a raw-only match (a tab inside a URL credential)
  // is counted on both sides and cannot mask a second secret; the readings
  // of the original text are counted as well.
  const readings = [rk9CoordMatchText(raw), rk9CoordSpacedText(raw)].map((form) => redactRk9CoordText(form, env));
  const original = [rk9CoordMatchText(text), rk9CoordSpacedText(text)].map((form) => redactRk9CoordText(form, env));
  const found = Math.max(...[...readings, ...original].map(countRedactions));
  if (rk9CoordTextHasSecret(line, env) || found > countRedactions(line)) {
    const [stripped, spaced] = readings as [string, string];
    const agree =
      stripped.replace(/\s+/g, "") === spaced.replace(/\s+/g, "") &&
      !rk9CoordTextHasSecret(stripped, env) &&
      !rk9CoordTextHasSecret(spaced, env);
    line = agree ? stripped : RK9_COORD_REDACTED;
  }
  // A text of only invisible characters (`‍`) is empty.
  if (line.length === 0 || rk9CoordMatchText(line).length === 0) return null;
  const points = Array.from(line);
  if (points.length <= max) return line;
  return `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}
// --- /RK9 Custom ---
