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
  // RK9-684 (RK9-690): the prefix value stops before a keyword, with the
  // lookahead of the client's long `sk-` rule, so `QMK_API_KEY=<value>` and
  // `sk-...-password=<value>` leave the value to the keyword rule.
  "(gh[opusr]_|github_pat_|pcp_[a-z]+_|vck_|qmk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|xox[abpors]-|glpat-)" +
  "(?:(?!token|secret|passw|passphrase|private[_-]?key|credential|api[_-]?key|apikey|(?<![A-Za-z])pw[\"']?\\s*[=:]|(?<![A-Za-z])pass[\"']?\\s*=)[A-Za-z0-9_-]){6,}" +
  "|AKIA[0-9A-Z]{12,}" +
  "|AIza[0-9A-Za-z_-]{20,}" +
  // RK9-676: not compiled as a regex on the server; see RK9_COORD_JWT_BRANCH.
  "|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9._-]+" +
  "|-----BEGIN [A-Z ]*PRIVATE KEY-----" +
  "|://[^ /:@]+:[^ /@]+@" +
  "|(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{8,}" +
  // RK9-678 (operator decision): `passphrase`, `private_key`, `credentials`
  // and `pw` (not after a letter: `pwd` and `compass` stay), and `pass` with
  // `=` only (`user=bob pass=<value>`; `pass:` is prose: `second pass: ...`).
  "|((token|secret|password|passwd|passphrase|private[_-]?key|credentials?|api[_-]?key|apikey|(?<![A-Za-z])pw)[\"']?\\s*[=:]\\s*" +
  // RK9-684 item 1: `token: Bearer <value>` hides the value, not only the word.
  "|(?<![A-Za-z])pass[\"']?\\s*=\\s*)[\"']?(?:(?:bearer|basic)\\s+)?[^\\s\"',;]{6,}";

export const RK9_COORD_REDACTED = "[redacted]";

/**
 * The JWT branch of the default pattern (RK9_SESSIONS_SECRET_RX). The server
 * does not run it as a regex (RK9-676, parent decision): on `eyJeyJ...`
 * without a dot every `eyJ` rescanned the rest of the text (quadratic). The
 * pattern string keeps it, so it stays identical to the bash default, and
 * rk9CoordSecretRx() drops exactly this alternative before compiling.
 * rk9CoordJwtSpans() finds the same matches in linear time, glued prefixes
 * included (`id-<JWE>`, `aeyJ...`).
 */
export const RK9_COORD_JWT_BRANCH = "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9._-]+";
const JWT_RUN_RX = /[A-Za-z0-9_.-]+/g;
const ALNUM_RX = /[A-Za-z0-9]/;

/**
 * The spans the JWT branch (`gi`) would match: in each maximal run of
 * `[A-Za-z0-9_.-]` that has a dot, the first `eyJ` (any case) with 8 or more
 * characters before the next dot, and at least one character after that
 * dot, starts a match that runs to the end of the run. One pass over the
 * run: `eyJ` occurrences and the next-dot pointer only move forward.
 * `wordStart`: only an `eyJ` that does not follow a letter or digit counts
 * (the identifier check's word-start rule).
 */
export function rk9CoordJwtSpans(text: string, wordStart = false): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const run of text.matchAll(JWT_RUN_RX)) {
    const value = run[0];
    if (!value.includes(".")) continue;
    const lower = value.toLowerCase();
    let dot = -1;
    for (let at = lower.indexOf("eyj"); at >= 0; at = lower.indexOf("eyj", at + 1)) {
      if (dot < at) dot = value.indexOf(".", at);
      if (dot < 0) break;
      if (dot - (at + 3) < 8 || dot === value.length - 1) continue;
      if (wordStart && run.index + at > 0 && ALNUM_RX.test(text[run.index + at - 1]!)) continue;
      spans.push([run.index + at, run.index + value.length]);
      break;
    }
  }
  return spans;
}

/**
 * Every position where the JWT branch (`gi`) matches, with the end of its
 * match, in order. Unlike rk9CoordJwtSpans() this lists each `eyJ` of a run
 * (RK9-684 item 8): a match of another alternative may end inside a run, and
 * the regex then goes on from there.
 */
function rk9CoordJwtStarts(text: string): Rk9Range[] {
  const starts: Rk9Range[] = [];
  for (const run of text.matchAll(JWT_RUN_RX)) {
    const value = run[0];
    if (!value.includes(".")) continue;
    const lower = value.toLowerCase();
    let dot = -1;
    for (let at = lower.indexOf("eyj"); at >= 0; at = lower.indexOf("eyj", at + 1)) {
      if (dot < at) dot = value.indexOf(".", at);
      if (dot < 0) break;
      if (dot - (at + 3) < 8 || dot === value.length - 1) continue;
      starts.push([run.index + at, run.index + value.length]);
    }
  }
  return starts;
}

/**
 * The matches of `rx` plus the JWT branch, picked as one leftmost-first regex
 * with the branch picks them (RK9-684 item 8: the old union of two scans
 * could let a match that the full regex never starts swallow a PEM header).
 * Exact for the default pattern: no other alternative can start at an `eyJ`.
 * Linear: a regex match is reused until the scan passes its start.
 */
function rk9CoordPatternMatches(rx: RegExp, text: string): Rk9Range[] {
  const jwts = rk9CoordJwtStarts(text);
  const out: Rk9Range[] = [];
  let pos = 0;
  let next = 0;
  let match: RegExpExecArray | null | false = null;
  while (pos <= text.length) {
    if (match !== false && (match === null || match.index < pos)) {
      rx.lastIndex = pos;
      match = rx.exec(text) ?? false;
    }
    while (next < jwts.length && jwts[next]![0] < pos) next += 1;
    const jwt = jwts[next];
    if (jwt && (match === false || jwt[0] <= match.index)) {
      out.push([jwt[0], jwt[1]]);
      pos = jwt[1];
      continue;
    }
    if (match === false) break;
    const end = match.index + match[0].length;
    out.push([match.index, end]);
    pos = end > match.index ? end : end + 1;
  }
  return out;
}

/** Coord tokens are always redacted, whatever the env pattern says. */
const COORD_TOKEN_RX = /rk9_coord_[A-Za-z0-9_-]{6,}/gi;
/**
 * The keyword rule, always applied on top of the env pattern, in a wider
 * form (RK9-641): singular and plural keywords (`token`, `secrets`,
 * `api_keys`, ...); `=`, `:`, `->`, `=>` and URL-encoded `%3D` / `%3A` as
 * the separator; and a bracketed value (`"tokens": ["..."]`, `"secrets":
 * {"db": "..."}`, `secrets=(...)`), whose content up to the first closing
 * bracket goes (to the end of the text when it has none: RK9-676 kept this
 * fail-closed rule, because a cap left the tail of a long secret). Full-width
 * forms are caught by the NFKC matching reading, not here. RK9-678 added the
 * keywords of the default pattern (`passphrase`, `private_key`, `credential`,
 * `pw`, and `pass` with an `=` separator only). RK9-684 item 1: the value
 * may start with `Bearer`/`Basic` and whitespace (`token: Bearer <value>`).
 */
const KEYWORD_NAME =
  String.raw`(?:(?:token|secret|password|passwd|passphrase|private[_-]?key|credential|api[_-]?key|apikey)s?|(?<![A-Za-z])pw)["']?\s*(?:[=:]|->|=>|%3[ad])\s*` +
  String.raw`|(?<![A-Za-z])pass["']?\s*(?:=|%3d)\s*`;
const KEYWORD_VALUE_START = String.raw`["']?(?:(?:bearer|basic)\s+)?`;
/**
 * RK9-684: an unbracketed value stops before the next keyword that has a
 * value of its own (`secret=1&secrets: <value>`). Before, the first match
 * ate `secrets:` and the second value stayed visible; RK9-690's prefix stop
 * made that shape reachable from `ghp_..._secret=1&secrets: <value>`.
 */
const KEYWORD_RX = new RegExp(
  `(${KEYWORD_NAME})(?:([[{(]\\s*[^\\]})]{6,}[\\]})]?)|${KEYWORD_VALUE_START}` +
    `(?:(?!(?:${KEYWORD_NAME})(?:[[{(]|${KEYWORD_VALUE_START}[^\\s"',;]{6}))[^\\s"',;]){6,})`,
  "gi",
);
/**
 * RK9-684: the prefix rule as it was before the RK9-690 keyword stop. A
 * keyword inside a random token (`ghp_tokenabc...`) now ends the prefix
 * value early; this full form runs on the original text (redaction union and
 * the identifier check), so no token that the old rule hid shows again.
 */
const PREFIX_FULL_RX =
  /(?:gh[opusr]_|github_pat_|pcp_[a-z]+_|vck_|qmk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|xox[abpors]-|glpat-)[A-Za-z0-9_-]{6,}/gi;
/** Patterns applied whatever RK9_SESSIONS_SECRET_RX says. */
const ALWAYS_RX = [COORD_TOKEN_RX, KEYWORD_RX, PREFIX_FULL_RX];
/**
 * The one bracketed value that stays: a JSON object of counters after
 * `token` or `tokens` (`"tokens": {"input": 1234, "output": 56}`, nested
 * `{"cache": {"read": 1}}` too; the RK9-642 numbers rule). It holds only
 * braces, commas, colons, counter keys (isRk9CoordCounterKey) and JSON
 * numbers, booleans or null; a string value, an array, parentheses, a
 * digit in a key or any other key is redacted. Under `password`, `secret`,
 * `api_key` and the other keywords only a map of counter flags stays (true,
 * false or null values, no numbers; RK9-684 item 5). A number may not be followed by another digit, so
 * the pattern cannot split one number into many (no catastrophic
 * backtracking).
 */
/** One token of a counter object; sticky, so the scan below never backtracks. */
const COUNTER_TOKEN_RX = /\s+|[{},:]|(["']?)([A-Za-z_][A-Za-z_-]{0,39})\1|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const COUNTER_KEY_FOLLOW_RX = /\s*:/y;
/**
 * Words of a counter key (RK9-676). `tokens={abcdef: 1}` kept a letters-only
 * secret as a key; a key now passes only when it is short (at most 5
 * characters, below the 6-character value rule of the keyword pattern) or
 * every word of it is on this list (`cache_read_input_tokens`,
 * `completionTokensDetails`, `reasoning_tokens`).
 */
const COUNTER_WORDS = new Set([
  "input", "inputs", "output", "outputs", "total", "totals", "cache", "cached", "read", "reads", "write", "writes",
  "creation", "create", "created", "prompt", "prompts", "completion", "completions", "reasoning", "thinking",
  "audio", "text", "image", "images", "video", "tool", "tools", "use", "used", "usage", "count", "counts",
  "max", "min", "limit", "limits", "remaining", "reset", "token", "tokens", "sum", "avg", "mean", "per", "call",
  "calls", "request", "requests", "response", "responses", "ephemeral", "hit", "hits", "miss", "misses",
  "accepted", "rejected", "prediction", "predictions", "details", "server", "web", "search", "budget",
  "context", "window", "last", "turn", "turns", "session", "sessions", "day", "hour", "week", "month",
  "today", "model", "cost", "rate", "ratio", "estimate", "estimated", "new", "old", "before", "after", "delta",
  "peak", "current", "previous", "average", "system", "user", "assistant", "message", "messages",
]);

/** May this word be a key in a counter object? See COUNTER_WORDS. */
export function isRk9CoordCounterKey(key: string): boolean {
  if (!/^[A-Za-z_][A-Za-z_-]{0,39}$/.test(key)) return false;
  if (key.length <= 5) return true;
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.length > 0 && words.every((word) => COUNTER_WORDS.has(word));
}
const COUNTER_LITERALS = new Set(["true", "false", "null"]);

/**
 * Linear scan (RK9-641 round 3: a regex with a key-or-literal alternation
 * backtracked exponentially on `true:true:...`). Each word must be a key
 * (followed by `:`) or an unquoted true/false/null; a number must not run
 * into a digit, dot or letter. `flagsOnly`: no number at all.
 */
function isRk9CoordCounterMap(content: string, flagsOnly = false): boolean {
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
      if (isKey ? !isRk9CoordCounterKey(token[2]) : !(token[1] === "" && COUNTER_LITERALS.has(token[2]))) return false;
    } else if (/^-?\d/.test(token[0]) && (flagsOnly || (end < content.length && /[\d.eEA-Za-z_]/.test(content[end]!)))) {
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

/** Drop the JWT alternative (matched by rk9CoordJwtSpans instead). */
function withoutJwtBranch(source: string): string {
  const parts = source.split("|");
  // Only a top-level alternative that is exactly the branch; a pattern with
  // the branch inside a group keeps it (an operator override, rare).
  const kept: string[] = [];
  let depth = 0;
  // RK9-684 item 10: a `(`, `)` or `|` inside a character class does not count.
  let inClass = false;
  let piece: string[] = [];
  for (const part of parts) {
    piece.push(part);
    for (let i = 0; i < part.length; i += 1) {
      const ch = part[i];
      if (ch === "\\") i += 1;
      else if (inClass) inClass = ch !== "]";
      else if (ch === "[") {
        inClass = true;
        if (part[i + 1] === "^") i += 1;
      } else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    if (depth === 0 && !inClass) {
      const alternative = piece.join("|");
      if (alternative !== RK9_COORD_JWT_BRANCH) kept.push(alternative);
      piece = [];
    }
  }
  if (piece.length > 0) kept.push(piece.join("|"));
  return kept.length > 0 ? kept.join("|") : "(?!)";
}

/** The active secret pattern (RK9_SESSIONS_SECRET_RX or the default), case-insensitive, without the JWT branch. */
export function rk9CoordSecretRx(env: NodeJS.ProcessEnv = process.env): RegExp {
  const source = env.RK9_SESSIONS_SECRET_RX?.trim() || RK9_COORD_SECRET_RX_DEFAULT;
  if (cachedRx && cachedSource === source) return cachedRx;
  try {
    cachedRx = new RegExp(withoutJwtBranch(source), "gi");
  } catch (err) {
    logger.warn(
      { event: "rk9_coord_secret_rx_invalid", err: err instanceof Error ? err.message : String(err) },
      "RK9_SESSIONS_SECRET_RX is not a valid JS RegExp; using the built-in default",
    );
    cachedRx = new RegExp(withoutJwtBranch(RK9_COORD_SECRET_RX_DEFAULT), "gi");
  }
  cachedSource = source;
  return cachedRx;
}

/** Replace every secret-looking match with `[redacted]`; the rest of the text stays. */
export function redactRk9CoordText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  // RK9-676. Redaction works on ranges of the original text, so no step can
  // un-redact what another step found:
  // 1. the sequential replace of RK9-641 (pattern, coord tokens, keyword
  //    rule, each over the previous output). RK9-684 item 8: the pattern
  //    step picks its matches exactly as the full regex with the JWT branch
  //    did (rk9CoordPatternMatches), so `eyJ<8>.x bearer abcdefgh-----BEGIN
  //    RSA PRIVATE KEY-----` hides the whole PEM header again;
  // 2. plus every pattern on the original text: one match can no longer eat
  //    the start of the next secret (`AKIA...xrk9_coord_<token>`), plus each
  //    JWT run's first span and the prefix rule without its keyword stop
  //    (PREFIX_FULL_RX);
  // 3. plus up to 3 more rounds over the combined output, which add only new
  //    coverage (`token: [redacted]<tail>` goes whole).
  let sequential: Rk9Range[] = [];
  for (const kind of REDACT_KINDS) sequential = sequential.concat(redactPass(text, sequential, kind, env, true));
  const original = REDACT_KINDS.flatMap((kind) => redactMatches(kind, text, env, false));
  let ranges = mergeRk9Ranges([...sequential, ...original]);
  for (let round = 0; round < 3; round += 1) {
    let grew = false;
    for (const kind of REDACT_KINDS) {
      const added = redactPass(text, ranges, kind, env, false).filter((range) => !isCovered(ranges, range));
      if (added.length > 0) {
        ranges = mergeRk9Ranges([...ranges, ...added]);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return redactedView(text, ranges).view;
}

type Rk9Range = [number, number];
type RedactKind = "pattern" | "coord" | "keyword";
const REDACT_KINDS: RedactKind[] = ["pattern", "coord", "keyword"];

/**
 * Matches of one step on `view`, as view ranges. `sequential`: the exact
 * matches of the old sequential replace, zero-length ones included; otherwise
 * the extra union matches of the pattern step too (every JWT run, the prefix
 * rule without its keyword stop), non-empty only.
 */
function redactMatches(kind: RedactKind, view: string, env: NodeJS.ProcessEnv, sequential: boolean): Rk9Range[] {
  const out: Rk9Range[] = [];
  const add = (start: number, end: number) => {
    if (end > start || sequential) out.push([start, end]);
  };
  if (kind === "keyword") {
    KEYWORD_RX.lastIndex = 0;
    for (const match of view.matchAll(KEYWORD_RX)) {
      const bracket = match[2];
      // RK9-684 item 5: counter flags (true/false/null only) stay under every
      // keyword name (`passphrase: {"cached": true}`); counts only under token(s).
      if (bracket !== undefined && isRk9CoordCounterMap(bracket, !COUNTER_KEYWORD_RX.test(match[1]!))) continue;
      add(match.index, match.index + match[0].length);
    }
    return out;
  }
  if (kind === "pattern") {
    for (const [start, end] of rk9CoordPatternMatches(rk9CoordSecretRx(env), view)) add(start, end);
    if (sequential) return out;
    for (const [start, end] of rk9CoordJwtSpans(view)) add(start, end);
    PREFIX_FULL_RX.lastIndex = 0;
    for (const match of view.matchAll(PREFIX_FULL_RX)) add(match.index, match.index + match[0].length);
    return out;
  }
  // matchAll copies lastIndex from the shared RegExp: start at 0.
  COORD_TOKEN_RX.lastIndex = 0;
  for (const match of view.matchAll(COORD_TOKEN_RX)) add(match.index, match.index + match[0].length);
  return out;
}

/** Overlapping ranges merge; touching ones stay apart (two markers, as the replace wrote them). */
function mergeRk9Ranges(ranges: Rk9Range[]): Rk9Range[] {
  const sorted = ranges.map(([start, end]): Rk9Range => [start, end]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: Rk9Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && (range[0] < last[1] || range[0] === last[0])) {
      last[1] = Math.max(last[1], range[1]);
      continue;
    }
    out.push(range);
  }
  return out;
}

function isCovered(ranges: Rk9Range[], [start, end]: Rk9Range): boolean {
  return ranges.some(([from, to]) => from <= start && end <= to && to > from);
}

interface Rk9ViewSegment {
  viewStart: number;
  viewEnd: number;
  origStart: number;
  origEnd: number;
  marker: boolean;
}

/** The text with each merged range replaced by `[redacted]`, and where each view part comes from. */
function redactedView(text: string, ranges: Rk9Range[]) {
  const segments: Rk9ViewSegment[] = [];
  let view = "";
  let cursor = 0;
  const push = (piece: string, origStart: number, origEnd: number, marker: boolean) => {
    if (piece.length === 0) return;
    segments.push({ viewStart: view.length, viewEnd: view.length + piece.length, origStart, origEnd, marker });
    view += piece;
  };
  for (const [start, end] of mergeRk9Ranges(ranges)) {
    push(text.slice(cursor, start), cursor, start, false);
    push(RK9_COORD_REDACTED, start, end, true);
    cursor = end;
  }
  push(text.slice(cursor), cursor, text.length, false);
  return { view, segments };
}

/** One redaction step over the current output, mapped back to original ranges. */
function redactPass(text: string, ranges: Rk9Range[], kind: RedactKind, env: NodeJS.ProcessEnv, keepEmpty: boolean): Rk9Range[] {
  const { view, segments } = redactedView(text, ranges);
  const segmentAt = (index: number): Rk9ViewSegment | undefined => {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const segment = segments[mid]!;
      if (index < segment.viewStart) high = mid - 1;
      else if (index >= segment.viewEnd) low = mid + 1;
      else return segment;
    }
    return undefined;
  };
  const toOriginal = (index: number, side: "start" | "end"): number => {
    if (side === "end") {
      if (index === 0) return 0;
      const segment = segmentAt(index - 1);
      if (!segment) return text.length;
      return segment.marker ? segment.origEnd : segment.origStart + (index - segment.viewStart);
    }
    const segment = segmentAt(index);
    if (!segment) return text.length;
    return segment.marker ? segment.origStart : segment.origStart + (index - segment.viewStart);
  };
  return redactMatches(kind, view, env, keepEmpty).map(([start, end]): Rk9Range =>
    end === start ? [toOriginal(start, "start"), toOriginal(start, "start")] : [toOriginal(start, "start"), toOriginal(end, "end")],
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
 * Bearer or Basic not after a letter, then one or more invisible characters as
 * the only separator, then 8+ token characters with invisible characters
 * between them (RK9-641 round 2: `Bearer<ZWSP>abcd<ZWSP>efgh...`; no single
 * reading of the whole text has both a space and the joined token). Matched
 * on the raw text, so `basic-auth` next to an emoji is not a secret. The
 * token-character class and the invisible class are disjoint, so the
 * repetition cannot backtrack.
 */
const GLUED_AUTH_RX = new RegExp(
  // RK9-676: a digit before the keyword no longer hides it (`1Bearer<ZWSP>...`).
  `(?<![A-Za-z])(?:bearer|basic)${MATCH_INVISIBLE_RX.source}+(?:[A-Za-z0-9._~+/=-]${MATCH_INVISIBLE_RX.source}*){8,}`,
  "iu",
);

/** A run of characters that can be part of a secret. */
const SECRET_RUN_RX = /[A-Za-z0-9._~+/=-]+/g;
/** The normalizing readings: each one applies to the stored line as well. */
const LEAK_READINGS: Array<(text: string) => string> = [
  collapseRk9CoordText,
  rk9CoordMatchText,
  rk9CoordSpacedText,
  (text) => rk9CoordMatchText(text.replace(CONTROL_RX, " ")),
  (text) => rk9CoordSpacedText(text.replace(CONTROL_RX, "")),
];

/**
 * RK9-676: does the partly redacted line still show part of a secret that a
 * reading of the original text shows? For every reading in which the text
 * holds a secret, each run of secret characters of the same reading of the
 * stored line must also appear in that reading redacted. A token tail left
 * after an invisible character (`ghp_abcdef<U+0301>ghijkl` stores
 * `[redacted]<U+0301>ghijkl`) is a leak; an emoji selector or an NFD accent
 * next to a redacted keyword value is not, so the rest of that line stays.
 */
function rk9CoordReadingLeaks(text: string, line: string, env: NodeJS.ProcessEnv): boolean {
  for (const read of LEAK_READINGS) {
    const seen = read(text);
    const redacted = redactRk9CoordText(seen, env);
    if (redacted === seen) continue;
    // RK9-684 item 6: a stored run must equal a whole run of the redacted
    // reading. A substring test let a secret tail pass when it was part of a
    // longer visible run (`abc` inside `xabcx`).
    const allowed = new Set(redacted.split(RK9_COORD_REDACTED).join(" ").match(SECRET_RUN_RX) ?? []);
    const stored = read(line).split(RK9_COORD_REDACTED).join(" ");
    for (const run of stored.match(SECRET_RUN_RX) ?? []) {
      if (!allowed.has(run)) return true;
    }
  }
  return false;
}

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
    if (rk9CoordJwtSpans(form, true).length > 0) return true;
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
  //   `[redacted]` as a whole when invisible characters are the only
  //   separator of Bearer/Basic and its token (`Bearer<ZWSP><token>`), or
  //   when the stored line still shows part of a secret that some reading of
  //   the text shows (RK9-676: before, any secret anywhere in such a text
  //   took the whole line, so an emoji selector or an NFD accent next to a
  //   redacted keyword value lost a harmless line);
  // - any text whose stored line still shows a secret in some reading
  //   (full-width forms) becomes `[redacted]` too.
  // A plain text with an ordinary secret keeps the rest of the line.
  if (
    (HAS_INVISIBLE_RX.test(text) && (GLUED_AUTH_RX.test(text) || rk9CoordReadingLeaks(text, line, env))) ||
    rk9CoordTextHasSecret(line, env)
  ) {
    line = RK9_COORD_REDACTED;
  }
  // A text of only invisible characters (`\u200d`) is empty.
  if (line.length === 0 || rk9CoordMatchText(line).length === 0) return null;
  const points = Array.from(line);
  if (points.length <= max) return line;
  // RK9-678: a cut inside a `[redacted]` marker moves to the marker start,
  // so the line never ends in `[redac…`.
  let cut = Math.max(0, max - 1);
  for (let at = line.indexOf(RK9_COORD_REDACTED); at >= 0; at = line.indexOf(RK9_COORD_REDACTED, at + 1)) {
    const start = Array.from(line.slice(0, at)).length;
    if (start >= cut) break;
    if (start + RK9_COORD_REDACTED.length > cut) {
      cut = start;
      break;
    }
  }
  return `${points.slice(0, cut).join("").trimEnd()}\u2026`;
}
// --- /RK9 Custom ---
