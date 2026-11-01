// --- RK9 Custom (RK9-626): coord bus free-text hygiene ---
//
// Every free-text field the coord journal and inbox store (event summaries,
// payload text, message bodies) goes through toRk9CoordLine() before the
// insert: secrets are redacted, the text is collapsed to one line and capped.
// No model calls: this runs in the hook path (< 0.3 s budget).
//
// The default pattern is the RK9_SESSIONS_SECRET_RX default of
// ~/.claude/bin/rk9-sessions.sh (RK9-549), so the client filter and the server
// filter agree. RK9-625 ships the same export names in rk9-coord-redact.ts;
// whichever of the two merges second switches its import and drops its copy.
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

/** Coord tokens are always redacted, whatever the env pattern says. */
const COORD_TOKEN_RX = /rk9_coord_[A-Za-z0-9_-]{6,}/gi;
const REDACTED = "[redacted]";
/** Whitespace (tab, newline, Unicode spaces, line/paragraph separators). */
const WHITESPACE_RX = /\s+/g;
/**
 * Controls and invisible characters: C0 (except tab/newline/CR, which are
 * whitespace), C1, zero-width, bidi controls, word joiners, BOM. They can
 * split a secret so the pattern misses it (JS \s misses most of them).
 */
const INVISIBLE_RX = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "g");

let cachedSource: string | undefined;
let cachedRx: RegExp | null = null;

function secretRx(env: NodeJS.ProcessEnv = process.env): RegExp {
  const source = env.RK9_SESSIONS_SECRET_RX?.trim() || RK9_COORD_SECRET_RX_DEFAULT;
  if (cachedRx && cachedSource === source) return cachedRx;
  try {
    cachedRx = new RegExp(source, "gi");
  } catch (err) {
    logger.warn({ err, event: "rk9_coord_secret_rx_invalid" }, "RK9_SESSIONS_SECRET_RX is invalid; using the default");
    cachedRx = new RegExp(RK9_COORD_SECRET_RX_DEFAULT, "gi");
  }
  cachedSource = source;
  return cachedRx;
}

/** Replace every secret-looking match with `[redacted]`. */
export function redactRk9CoordText(text: string): string {
  const rx = secretRx();
  rx.lastIndex = 0;
  return text.replace(rx, REDACTED).replace(COORD_TOKEN_RX, REDACTED);
}

/** True when the text contains something the secret pattern matches. */
export function rk9CoordTextHasSecret(text: string): boolean {
  return redactRk9CoordText(text) !== text;
}

/**
 * Redact, collapse whitespace to single spaces, trim and cap at `max` code
 * points (an ellipsis marks a cut). Empty -> null.
 *
 * Control and invisible characters are rare in real text but can hide a
 * secret from the pattern (`ghp_\u200bABC...`, `Bearer\u0001xyz...`). When a
 * text has any, both readings are checked: with them removed and with them
 * as spaces. If either reading shows a secret, the whole field becomes
 * `[redacted]` (fail closed).
 */
export function toRk9CoordLine(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  INVISIBLE_RX.lastIndex = 0;
  const hasInvisible = INVISIBLE_RX.test(text);
  INVISIBLE_RX.lastIndex = 0;
  const asSpaces = text.replace(INVISIBLE_RX, " ").replace(WHITESPACE_RX, " ").trim();
  if (hasInvisible) {
    const removed = text.replace(INVISIBLE_RX, "").replace(WHITESPACE_RX, " ").trim();
    if (rk9CoordTextHasSecret(removed) || rk9CoordTextHasSecret(asSpaces)) return REDACTED;
  }
  const line = redactRk9CoordText(asSpaces);
  if (!line) return null;
  const points = Array.from(line);
  if (points.length <= max) return line;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}
// --- /RK9 Custom ---
