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
/** Whitespace, C0/C1 controls, zero-width and bidi controls, line/paragraph separators. */
const LINE_BREAKING_RX = new RegExp("[\\s\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]+", "g");

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

/**
 * Redact, collapse whitespace and control characters to single spaces, trim
 * and cap at `max` code points (an ellipsis marks a cut). Empty -> null.
 * Redaction runs before and after the collapse, so a secret split over two
 * lines (`Bearer\nxyz…`) is caught either way.
 */
export function toRk9CoordLine(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const collapsed = redactRk9CoordText(text)
    .replace(LINE_BREAKING_RX, " ")
    .trim();
  const line = redactRk9CoordText(collapsed);
  if (!line) return null;
  const points = Array.from(line);
  if (points.length <= max) return line;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}
// --- /RK9 Custom ---
