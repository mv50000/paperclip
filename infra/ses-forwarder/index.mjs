// SES inbound -> forward to a real mailbox (Proton @ rk9.fi)
// Triggered as a Lambda *action* on the SES receipt rule (runs after the S3 action,
// so the raw .eml already exists in S3). Reads it, rewrites the envelope so it passes
// DMARC from a verified domain, and re-sends via SES SendRawEmail.
//
// 2026-08-08 (hei@sunspot.fi spam investigation): two changes, both aimed at ONE
// failure mode — every forwarded message carries the SAME From (forwarder@<domain>)
// regardless of who actually sent it, so the recipient's filter learns a verdict for
// the CHANNEL, not the sender. hei@sunspot.fi is public, it collects real phishing
// (two Meta impersonations 2-3.8.2026), and marking that as spam trained Proton to
// junk *everything* forwarded — genuine customer mail included.
//
//   1. SPAM/VIRUS GATE. Messages SES flags are not forwarded, so junk can never
//      re-poison the channel. They are NOT lost: the S3 action runs first, so the
//      raw .eml is always in the bucket and can be inspected or replayed.
//      Only an explicit FAIL drops a message — DISABLED / GRAY / PROCESSING_FAILED
//      all forward as before, which is what makes this safe to deploy before
//      ScanEnabled is turned on (verdicts read DISABLED until then).
//   2. HEADER HYGIENE. The forwarded copy used to carry the inbound hop's own
//      Authentication-Results, Received-SPF and X-SES-* headers. A message must not
//      arrive bearing another server's authentication verdict — that is a spoofing
//      signal, and those headers are the receiver's to write, not ours to replay.
//      (Measured NOT to be the cause of the spam filing, but wrong to send anyway.)
//
// 2026-09-17 (RK9-236): PASS-verdict bounces (DSNs) were being dropped with SES
// SendRawEmail throwing "InvalidParameterValue: Missing start boundary" — silent
// because the exception is only visible in CloudWatch, never in the mailbox. Measured
// root cause (not the two hypotheses the ticket started from — plain CRLF handling and
// the UTF-8 round-trip both checked out clean against the failing message): when SES's
// virus scanner quarantines an attachment, the DSN it generates embeds the blocked
// message as a `message/rfc822` part but truncates it down to bare headers — including
// a `Content-Type: multipart/mixed; boundary="X"` header whose boundary `X` never
// actually appears anywhere in the message. That dangling boundary declaration is
// already present in the raw bytes SES delivers to S3; forwarding it verbatim makes
// SES's own outbound raw-message validator (and any standards-compliant MIME parser)
// fail to parse the WHOLE message. See sanitizeDanglingBoundaries() below.
//
// 2026-11-15 (RK9-874): per-address routing replaces the single FORWARD_TO. Nothing is
// forwarded to the operator's personal mailbox any more: routes.json maps each address
// to a target (Aava by default) or to "s3-only". See routing.mjs. The forwarded From is
// now `"<original name or address> via <domain>" <forwarder@domain>`, Reply-To is the
// original sender, and X-Original-To lists the address(es) the message arrived at.
//
// 2026-11-17 (RK9-930): SES gives the forwarded copy a new Message-ID, so a reply to it
// could not thread to the customer's original message. The original Message-ID now
// travels as X-Original-Message-ID (validated, see originalMessageId()). In-Reply-To and
// References pass through unchanged, so they need no X-Original-* copy. Every inbound
// X-Original-* header is dropped: only the forwarder writes that family.
//
// 2026-11-17 (RK9-936): Proton writes its own X-Original-To on delivery, and the
// forwarder's header of that name disappears, so the Aava gate could not learn the
// arrival address. The arrival address now also travels in X-Rk9-Forwarded-To, a
// header no mail system writes: the routed envelope recipients as bare addresses
// separated by ", " on one line. Every inbound X-Rk9-* header is dropped. The header
// is always written: a list that cannot be written safely gets the value `invalid`,
// so a sender's hidden copy can never be the only one (the gate rejects two). A kept
// header's name must be printable ASCII (RFC 5322 ftext), and control characters are
// removed from kept header values. Every inbound X-Pm-* header (Proton's family) is
// dropped as well, because the gate reads Proton's receive time from X-Pm-Date.
//
// 2026-11-18 (RK9-940): kept header values also lose C1 control characters (U+0080 to
// U+009F, NEL included) and U+2028/U+2029, which a lenient reader (a JS regex with the
// `m` flag, Python's str.splitlines()) treats as line ends. A continuation line that
// holds only whitespace is dropped, because a parser can end the header block there.
// The boundary parameter of Content-Type is never changed: it must match the delimiter
// lines in the body, so a message whose boundary would change in cleaning is not
// forwarded (it stays in S3). The rest of Content-Type is cleaned like any header.
// An X-Rk9-Forwarded-To recipient that holds `=?` (an RFC 2047 encoded-word) is invalid.
//
// 2026-11-19 (RK9-945): the boundary check reads Content-Type twice, once with RFC 822
// comments skipped and once without. `(")multipart/mixed; boundary="ab\x01cd"` hid
// the boundary from the old scan, so the boundary was cleaned and split from the body.
import fs from "node:fs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { parseRoutes, planDeliveries, domainIsRouted, ADDRESS_RE } from "./routing.mjs";

const REGION = process.env.AWS_REGION || "eu-north-1";
const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });

const BUCKET = process.env.BUCKET || "rk9-ses-inbound";
const ROUTES_URL = new URL("./routes.json", import.meta.url);

/** Loaded once per container. A load or validation error is cached too: the file
 *  cannot change without a redeploy, and every routed message must then fail loudly
 *  (logged, rethrown, kept in S3) rather than be forwarded anywhere by guesswork. */
let routesCache;
function loadRoutes() {
  if (!routesCache) {
    try {
      routesCache = { config: parseRoutes(JSON.parse(fs.readFileSync(ROUTES_URL, "utf8"))) };
    } catch (err) {
      routesCache = { error: err };
    }
  }
  return routesCache;
}

// domain -> S3 key prefix (MUST match the receipt rule's ObjectKeyPrefix)
const PREFIX = { "sunspot.fi": "", "ololla.fi": "ololla/", "saatavilla.fi": "saatavilla/" };
// domain -> verified From address used for the forwarded envelope (domain identity is DKIM-verified)
const fromFor = (domain) => `forwarder@${domain}`;

/** Headers we refuse to replay outward. The first group is the original identity
 *  (rewritten below); the second is the INBOUND hop's own authentication verdict and
 *  SES bookkeeping, which belongs to that hop and must not travel with the message. */
const DROP_HEADERS = new Set([
  // original identity — replaced by the rewrite
  "from", "return-path", "sender", "message-id", "dkim-signature", "reply-to", "x-original-from",
  "x-original-reply-to",
  // ours to write: an inbound X-Original-To would let any sender fake which address
  // the message arrived at (e.g. tietosuoja@), and Aava acts on that header. Every
  // other X-Original-* header is dropped too (isForgeableOriginal() below).
  "x-original-to",
  // inbound-hop artifacts — never forward someone else's verdict
  "authentication-results", "received-spf",
  "arc-seal", "arc-message-signature", "arc-authentication-results",
  "x-ses-receipt", "x-ses-dkim-signature", "x-ses-outgoing", "x-ses-spam-verdict",
  "x-ses-virus-verdict", "x-ses-spf-verdict", "x-ses-dmarc-verdict", "feedback-id",
]);

/** Every MIME delimiter line actually present in the message: RFC 2046 requires a
 *  boundary delimiter to start at the beginning of a line as `--token` (optionally
 *  followed by a closing `--`). One O(n) pass, independent of how many candidate
 *  `boundary=` declarations exist — see sanitizeDanglingBoundaries() for why that
 *  matters. */
function collectBoundaryDelimiters(text) {
  const tokens = new Set();
  const re = /^--(\S+?)(--)?$/gm;
  let m;
  while ((m = re.exec(text))) tokens.add(m[1]);
  return tokens;
}

/** A `Content-Type: multipart/*; boundary="X"` header only makes a message valid if
 *  the delimiter `--X` actually occurs as a real MIME boundary line. SES's virus
 *  quarantine can strip a nested `message/rfc822` part down to bare headers and leave
 *  exactly this kind of dangling declaration (RK9-236). Rather than trying to fully
 *  parse and repair the nested part, downgrade any such orphaned declaration to a
 *  boundary-less type — the sub-part becomes an inert, valid stub instead of a parse
 *  error for the whole message. Runs on the raw text before anything else, so it
 *  applies at any nesting depth.
 *
 *  Checking each declaration against a pre-collected Set (O(1) each) instead of
 *  re-scanning the remaining text per declaration matters here specifically because
 *  the input is fully attacker-controlled (anyone can email hei@sunspot.fi): a message
 *  with many `boundary=` look-alikes used to make the old substring-rescan approach
 *  O(n²) — a few thousand fake headers in an otherwise ordinary-sized message was
 *  enough to burn seconds of Lambda CPU per message (measured in review). */
export function sanitizeDanglingBoundaries(text) {
  const delimiters = collectBoundaryDelimiters(text);
  const re = /Content-Type:\s*multipart\/[a-zA-Z0-9.+-]+\s*;[^\r\n]*boundary=(?:"([^"]+)"|([^;\r\n]+))(?:\r?\n[ \t][^\r\n]*)*/gi;
  return text.replace(re, (block, quoted, bare) => {
    const boundary = (quoted || bare || "").trim();
    if (!boundary) return block;
    return delimiters.has(boundary) ? block : "Content-Type: text/plain";
  });
}

/** The X-Original-* and X-Rk9-* families are ours to write, and the Aava gate trusts
 *  them only in a forwarded message (RK9-930, RK9-936). An inbound copy
 *  (X-Original-Message-ID, X-Rk9-Forwarded-To, …) is the sender's forgery, so it is
 *  dropped whatever its exact name. X-Pm-* is Proton's to write on delivery, after
 *  this forwarder; the gate reads Proton's receive time from X-Pm-Date, so a
 *  sender's own X-Pm-* header is dropped too (RK9-936). */
const isForgeableOriginal = (name) =>
  name.startsWith("x-original-") || name.startsWith("x-rk9-") || name.startsWith("x-pm-");

const X_RK9_FORWARDED_TO = "X-Rk9-Forwarded-To";
/** The X-Rk9-Forwarded-To value when the recipient list cannot be written safely.
 *  It is not an address, so the Aava gate rejects a brand reply to the message. */
export const FORWARDED_TO_INVALID = "invalid";

/** The X-Rk9-Forwarded-To value: the envelope recipients routed to this delivery as
 *  bare lowercase addresses joined by ", " on one line (no folding). The header is
 *  always written. It gets FORWARDED_TO_INVALID when the list is empty, when one
 *  address is malformed (a partial list could make a message for two addresses look
 *  like a message for one) or when the line would be longer than 998 octets. A
 *  sender's hidden copy of the header can then never be the only one, and the Aava
 *  gate rejects two headers or a non-address value, so every doubt fails closed
 *  (RK9-936). */
export function forwardedToValue(recipients) {
  const list = (Array.isArray(recipients) ? recipients : [recipients]).map((r) => String(r ?? "").trim().toLowerCase());
  // `=?` starts an RFC 2047 encoded-word: a reader that decodes it would see another
  // address than the one we checked (RK9-940).
  const isPlainAddress = (a) => ADDRESS_RE.test(a) && !a.includes("=?");
  if (list.length === 0 || !list.every(isPlainAddress)) return FORWARDED_TO_INVALID;
  const value = [...new Set(list)].join(", ");
  return Buffer.byteLength(`${X_RK9_FORWARDED_TO}: ${value}`, "utf8") <= 998 ? value : FORWARDED_TO_INVALID;
}

/** A header name we replay: RFC 5322 ftext (printable ASCII except the colon),
 *  optionally followed by obsolete whitespace before the colon. A name with a
 *  non-ASCII character (a zero-width space, a fullwidth letter) or a line with no
 *  colon is dropped, so no later hop can turn it into one of our headers (RK9-936). */
const REPLAYABLE_NAME = /^[\x21-\x39\x3b-\x7e]+[ \t]*$/;

/** Characters removed from every kept header line: C0 controls other than HTAB, DEL,
 *  C1 controls (U+0080 to U+009F, NEL included) and the Unicode line and paragraph
 *  separators U+2028/U+2029. A lenient reader (a JS regex with the `m` flag, Python's
 *  str.splitlines()) treats some of these as line ends (RK9-940). CR and LF cannot
 *  occur inside a line here (a lone CR is already a space, LF splits). */
const VALUE_CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/g;

/** The same set for a value copied onto one of our own header lines, where CR and
 *  LF are already gone. */
const COPY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/g;

/** The bounds of s[from, to) without the spaces, tabs and CRs at either end. A loop,
 *  not a regex: no backtracking on attacker input. */
const isPad = (c) => c === 32 || c === 9 || c === 13;
function trimmed(s, from, to) {
  while (from < to && isPad(s.charCodeAt(from))) from++;
  while (to > from && isPad(s.charCodeAt(to - 1))) to--;
  return [from, to];
}

/** The value of every `boundary` parameter (name in any case) in one unfolded
 *  Content-Type header line, in order: a quoted value without its quotes and
 *  backslash escapes, a bare value trimmed. The type before the first `;` is not a
 *  parameter, and a `;` inside quotes does not end one. A character that cleaning
 *  removes does not count in a parameter name, so only a change of the value counts.
 *  One linear pass, no backtracking regex (RK9-940). The values before and after
 *  cleaning are compared; the type does not matter, because only the boundary must
 *  match the body (RFC 2046 5.1.1).
 *  The RFC 2231 names `boundary*0`, `boundary*1`, … and `boundary*` count too, each
 *  value as it is written (RK9-945).
 *  By default an RFC 822 comment outside quotes, before the type or anywhere else, is
 *  read as a space, as an RFC 2045 parser that knows comments reads it. Otherwise a
 *  `"` or `;` inside `(…)` would hide a real boundary from the scan (RK9-945).
 *  `{ comments: false }` reads the line as text, the way a parser that knows no
 *  comments does; rewrite() compares both readings. */
export function boundaryValues(line, { comments = true } = {}) {
  if (comments && line.includes("(")) line = withoutComments(line);
  const out = [];
  const param = (from, to) => {
    let eq = from;
    while (eq < to && line.charCodeAt(eq) !== 61) eq++; // bounded: no rescan to the line end
    if (eq === to) return;
    const name = line.slice(from, eq).replace(VALUE_CONTROL, "");
    const [ns, ne] = trimmed(name, 0, name.length);
    // `boundary*0`, `boundary*1` and `boundary*` are RFC 2231 forms of the same
    // parameter; Python's email package joins them into the boundary (RK9-945).
    // Python also skips whitespace (NBSP and folds included) and comments around the
    // `*`, so all whitespace is removed from the name first. A name that matches
    // too much only refuses more.
    if (!/^boundary(?:\*|$)/.test(name.slice(ns, ne).replace(/\s/g, "").toLowerCase())) return;
    const [vs, ve] = trimmed(line, eq + 1, to);
    if (line.charCodeAt(vs) !== 34) return void out.push(line.slice(vs, ve));
    let v = "";
    for (let i = vs + 1; i < ve; i++) {
      const c = line[i];
      if (c === '"') break;
      v += c === "\\" && i + 1 < ve ? line[++i] : c;
    }
    out.push(v);
  };
  let start = -1; // the start of the current parameter; -1 while in the type
  let quoted = false;
  for (let i = line.indexOf(":") + 1; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (c === ";" && !quoted) {
      if (start >= 0) param(start, i);
      start = i + 1;
    }
  }
  if (start >= 0) param(start, line.length);
  return out;
}

/** The line with each RFC 822 comment outside a quoted string replaced by one space.
 *  A comment nests, and `\` escapes the next character in a comment and in a quoted
 *  string. A comment that is never closed runs to the end of the line. One linear
 *  pass (RK9-945). */
function withoutComments(line) {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) out += " ";
      continue;
    }
    if (quoted && c === "\\") {
      out += c + (line[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (c === "(" && !quoted) {
      depth = 1;
      continue;
    }
    out += c;
  }
  return depth > 0 ? out + " " : out;
}

/** Thrown by rewrite() when the message cannot be forwarded without changing what it
 *  means. The handler logs it and leaves the message in S3; it is not retried. */
export class UnforwardableMessageError extends Error {
  constructor(reason) {
    super(`unforwardable: ${reason}`);
    this.name = "UnforwardableMessageError";
    this.reason = reason;
  }
}

const X_ORIGINAL_MESSAGE_ID = "X-Original-Message-ID";
/** A msg-id (RFC 5322 3.6.4) in its common form: `<left@right>`, printable ASCII,
 *  no whitespace and no angle brackets inside. */
const MSG_ID = /^<[!-;=?-~]+@[!-;=?-~]+>$/;

/** The original Message-ID value exactly as the sender wrote it (angle brackets
 *  included), or "" when it cannot be copied safely. The value must fit one line
 *  (no folding inside it) and have the `<…@…>` form. It is at most 998 characters,
 *  and short enough that our whole header line stays within the RFC 5322 limit of
 *  998 octets (975 characters for the value). A message
 *  with no Message-ID, or with more than one, gets none: an ambiguous id is worse
 *  than a missing one. The message is forwarded either way. */
export function originalMessageId(messageIdBlocks) {
  if (messageIdBlocks.length !== 1) return "";
  const b = messageIdBlocks[0];
  const value = b.join("\r\n").slice(b[0].indexOf(":") + 1).trim();
  if (/[\r\n]/.test(value)) return "";
  if (value.length > 998 - `${X_ORIGINAL_MESSAGE_ID}: `.length) return "";
  return MSG_ID.test(value) ? value : "";
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/** A verdict blocks forwarding only when SES explicitly says FAIL. Anything else —
 *  PASS, GRAY, PROCESSING_FAILED, or DISABLED (scanning off) — forwards, so this
 *  can never silently start swallowing mail because of a config change elsewhere. */
function blockedBy(receipt) {
  const spam = receipt?.spamVerdict?.status;
  const virus = receipt?.virusVerdict?.status;
  if (virus === "FAIL") return "virus";
  if (spam === "FAIL") return "spam";
  return null;
}

/** One header value made safe to place on a single header line: folding and any
 *  stray CR/LF collapse to a space, other control characters are removed. Every
 *  value we copy out of the inbound message passes through here, because the
 *  message is attacker-controlled and a bare CR/LF would inject a header. */
export function sanitizeHeaderValue(v, max = 900) {
  const clean = String(v ?? "")
    .slice(0, max * 4) // bound the work on a huge header before the code-point split
    .replace(/\r?\n[ \t]*/g, " ")
    .replace(/[\r\n]/g, " ")
    .replace(COPY_CONTROL, "")
    .trim();
  return [...clean].slice(0, max).join("");
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/** Decode RFC 2047 encoded-words (`=?UTF-8?B?...?=`) in a display name. A word in an
 *  unknown charset or with bad encoding is left as is; never throws. */
export function decodeEncodedWords(s) {
  return String(s)
    .replace(/(\?=)\s+(?==\?)/g, "$1") // whitespace between adjacent encoded-words is not content
    .replace(ENCODED_WORD, (word, charset, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
        return new TextDecoder(charset.split("*")[0]).decode(bytes);
      } catch {
        return word;
      }
    });
}

/** The human-readable part of the original sender: the display name if there is
 *  one, otherwise the bare address. Quotes, backslashes and angle brackets are
 *  removed so the result can sit inside our own quoted-string or encoded-word. */
export function senderLabel(fromValue) {
  const v = decodeEncodedWords(sanitizeHeaderValue(fromValue));
  const m = v.match(/^(.*)<([^<>]*)>\s*$/);
  const name = (m ? m[1] : "").replace(/["\\<>]/g, "").replace(/\s+/g, " ").trim();
  const addr = (m ? m[2] : v).replace(/["\\<>]/g, "").replace(/\s+/g, " ").trim();
  const label = sanitizeHeaderValue(name || addr, 64);
  return label || "unknown sender";
}

/** A display-name phrase for the From header. Printable ASCII becomes a quoted
 *  string; anything else becomes RFC 2047 UTF-8 encoded-words of at most 75
 *  characters each, split on code-point boundaries and folded onto new lines. */
export function encodePhrase(phrase) {
  if (/^[\x20-\x7e]*$/.test(phrase)) return `"${phrase.replace(/["\\]/g, "")}"`;
  const words = [];
  let chunk = [];
  let len = 0;
  for (const ch of phrase) {
    const b = Buffer.from(ch, "utf8");
    if (len + b.length > 45 && chunk.length) {
      words.push(Buffer.concat(chunk));
      chunk = [];
      len = 0;
    }
    chunk.push(b);
    len += b.length;
  }
  if (chunk.length) words.push(Buffer.concat(chunk));
  return words.map((w) => `=?UTF-8?B?${w.toString("base64")}?=`).join("\r\n ");
}

/** `\r\r\n` (or more CRs) at a line end becomes `\r\n`. In a doubly converted
 *  message a multipart delimiter line reads `--B\r\r\n`, which a strict RFC 2046
 *  parser (SES SendRawEmail included) does not accept as a delimiter (RK9-888).
 *  Split and join instead of a regex: `\r+\n` backtracks on a long CR run. DKIM is
 *  already dropped, so nothing depends on the exact body bytes. */
function collapseStrayCRs(body) {
  if (!body.includes("\r\r")) return body;
  return body
    .split("\n")
    .map((line, i, all) => {
      if (i === all.length - 1) return line; // no LF after the last piece
      let end = line.length;
      while (end > 1 && line.charCodeAt(end - 1) === 13 && line.charCodeAt(end - 2) === 13) end--;
      return end === line.length ? line : line.slice(0, end);
    })
    .join("\n");
}

/** Rewrite the raw inbound message for forwarding.
 *  - From: `"<original name or address> via <domain>" <fromAddr>` (DKIM-aligned)
 *  - Reply-To and X-Original-From: the original From header
 *  - X-Original-To: the address(es) the message arrived at (string or array)
 *  - X-Rk9-Forwarded-To: the same arrival address(es) as bare addresses, always
 *    written, see forwardedToValue(); the Aava gate reads only this header (RK9-936)
 *  - X-Original-Message-ID: the original Message-ID, when it is a valid one-line id
 *  - the original identity and the inbound hop's verdict headers are dropped */
export function rewrite(raw, fromAddr, mail, originalTo) {
  const text = sanitizeDanglingBoundaries(raw.toString("utf8"));
  // The header block ends at the first empty line. Stray CRs before either LF still
  // count as an empty line (RK9-888): a message converted to CRLF twice has `\r\r\n`
  // on every line, and `\r?\n\r?\n` found no end, so the whole body was parsed as
  // headers and the forwarded body was empty. The pattern can only start at an LF,
  // so a long run of CRs costs one pass, not a backtrack per position.
  const m = /\n\r*\n/.exec(text);
  let headerEnd = m ? m.index : text.length;
  while (headerEnd > 0 && text.charCodeAt(headerEnd - 1) === 13) headerEnd--; // CRs before the LF
  const headerPart = text.slice(0, headerEnd);
  const body = m ? collapseStrayCRs(text.slice(m.index + m[0].length)) : "";

  // Group header lines into logical blocks (header + its folded continuation lines).
  // rawBlocks holds the same lines as received, so a change to a Content-Type boundary
  // can be detected below.
  const blocks = [];
  const rawBlocks = [];
  // A lone CR becomes a space: a receiver that treats it as a line end would
  // otherwise see `Subject: x\rX-Original-To: …` as a second header. Not a line end
  // here either, so `\r\r\n` from a double line-ending conversion cannot end the
  // header block early and push Content-Type into the body. Every CR left inside a
  // line after the split is a lone CR, so replacing them all is the same thing.
  for (const rawLine of headerPart.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, " ");
    if (/^[ \t]/.test(line) && blocks.length) {
      blocks[blocks.length - 1].push(line);
      rawBlocks[rawBlocks.length - 1].push(rawLine);
    } else {
      blocks.push([line]);
      rawBlocks.push([rawLine]);
    }
  }
  const nameOf = (b) => (b[0].split(":")[0] || "").toLowerCase().trim();
  // A header whose name holds control characters (`X-Original-To\0:`) is dropped too.
  // Tab is allowed before a colon: obsolete syntax permits whitespace there (nameOf
  // trims it). A line with no colon is no header at all, so any control character,
  // tab included, drops it (RK9-888). An empty line (a message that starts with an
  // LF) is dropped too: replayed, it would end our header block early. So is a first
  // line that starts with whitespace: it continues no header, and replayed after our
  // X-Original-To it would fold into that header as an extra arrival address.
  // Since RK9-936 the name must be printable ASCII (REPLAYABLE_NAME), and a line
  // with no colon is dropped whatever it holds.
  const hasBadName = (line) => !line.includes(":") || !REPLAYABLE_NAME.test(line.split(":")[0]);
  const isHeader = (b) => b[0] !== "" && !/^[ \t]/.test(b[0]) && !hasBadName(b[0]);
  // A form feed or other control character in a kept value is removed: a lenient
  // parser could read `X-A: a\fX-Rk9-Forwarded-To: …` as two headers (RK9-936).
  // A continuation line left with only whitespace (Unicode whitespace such as NBSP
  // included) is dropped: a parser can take it for the empty line that ends the
  // header block and move the rest into the body.
  // The first line keeps its name and colon, which no removal touches (RK9-940).
  const cleanLines = (b) =>
    b.map((line) => line.replace(VALUE_CONTROL, "")).filter((line, i) => i === 0 || /\S/.test(line));
  const keptIdx = blocks
    .map((b, i) => i)
    .filter((i) => isHeader(blocks[i]) && !DROP_HEADERS.has(nameOf(blocks[i])) && !isForgeableOriginal(nameOf(blocks[i])));
  // The boundary of a Content-Type must match the delimiter lines in the body, and a
  // cleaned `boundary="ab\x01cd"` would not. So when cleaning changes the value of any
  // boundary parameter (or adds or removes one), the message is not forwarded and
  // stays in S3 (RK9-940). The values are compared on the unfolded lines as received.
  // A CR there is padding like a space (boundaryValues trims it), so the `\r\r\n` of a
  // double line-ending conversion (RK9-888) does not count as a change.
  // Every Content-Type is checked, whatever its type; the rest of the header (a dirty
  // name=, charset or micalg, a blank continuation line) is cleaned and forwarded.
  const kept = keptIdx.map((i) => {
    const cleaned = cleanLines(blocks[i]);
    if (nameOf(blocks[i]) === "content-type") {
      // Read with and without RFC 822 comments (RK9-945): a receiver may parse either way.
      for (const comments of [true, false]) {
        const before = boundaryValues(rawBlocks[i].join(""), { comments });
        const after = boundaryValues(cleaned.join(""), { comments });
        if (before.length !== after.length || before.some((v, j) => v !== after[j])) {
          throw new UnforwardableMessageError("Content-Type boundary would change in cleaning");
        }
      }
    }
    return cleaned.join("\r\n");
  });
  const rawValueOf = (name) => {
    const b = blocks.find((x) => nameOf(x) === name);
    return b ? b.join("\r\n").slice(b[0].indexOf(":") + 1) : "";
  };
  // Only a value that fits one header line is copied; a cut address is worse than none.
  // The raw value is bounded first, so sanitizeHeaderValue() never truncates it.
  const copyable = (rawValue) => {
    if (!rawValue || rawValue.length > 8192) return "";
    const v = sanitizeHeaderValue(rawValue, 8192);
    return Buffer.byteLength(v, "utf8") <= 900 ? v : "";
  };

  // The original From exactly as the sender wrote it (encoded-words intact), so
  // replying reaches them; SES's decoded commonHeaders value is the fallback.
  const rawFrom = rawValueOf("from");
  const commonFrom = mail?.commonHeaders?.from?.[0] || "";
  const origFrom = copyable(rawFrom) || copyable(commonFrom);
  // The sender's own Reply-To (e.g. a contact form's customer address) would be lost
  // with Reply-To rewritten to the sender, so it travels as X-Original-Reply-To.
  const origReplyTo = copyable(rawValueOf("reply-to"));
  // SES gives the forwarded copy a new Message-ID; the original one lets a reply
  // thread to the customer's message (RK9-930).
  const origMessageId = originalMessageId(blocks.filter((b) => isHeader(b) && nameOf(b) === "message-id"));

  const domain = String(fromAddr).split("@")[1] || "";
  const label = senderLabel(commonFrom || rawFrom);
  const phrase = encodePhrase(`${label} via ${domain}`);

  const toList = (Array.isArray(originalTo) ? originalTo : [originalTo])
    .map((a) => sanitizeHeaderValue(a, 320))
    .filter(Boolean);
  // Proton overwrites X-Original-To on delivery; this header survives (RK9-936).
  // Always written, `invalid` when the list cannot be written safely.
  const forwardedTo = forwardedToValue(originalTo);

  const newHeaders = [
    `From: ${phrase} <${fromAddr}>`,
    ...(origFrom ? [`Reply-To: ${origFrom}`, `X-Original-From: ${origFrom}`] : []),
    // Which address this actually arrived at — the To: header alone can be anything
    // (bcc, alias, list), and on a domain catch-all that is the useful fact.
    ...(origReplyTo ? [`X-Original-Reply-To: ${origReplyTo}`] : []),
    ...(toList.length ? [`X-Original-To: ${toList.join(",\r\n ")}`] : []),
    `${X_RK9_FORWARDED_TO}: ${forwardedTo}`,
    ...(origMessageId ? [`${X_ORIGINAL_MESSAGE_ID}: ${origMessageId}`] : []),
    ...kept,
  ].join("\r\n");
  return Buffer.from(newHeaders + "\r\n\r\n" + body, "utf8");
}

export const handler = async (event) => {
  for (const record of event.Records || []) {
    const mail = record.ses.mail;
    const receipt = record.ses.receipt;
    const messageId = mail.messageId;
    const recipients = receipt.recipients || [];
    const domain = (recipients[0]?.split("@")[1] || "").toLowerCase();
    const prefix = PREFIX[domain] ?? "";
    const fromAddr = fromFor(domain);
    const key = prefix + messageId;

    const verdicts = `spam=${receipt?.spamVerdict?.status} virus=${receipt?.virusVerdict?.status}`;
    const blocked = blockedBy(receipt);
    if (blocked) {
      // Not an error and not a loss — the raw message is in S3 under `key`.
      console.log(`SKIP ${messageId} (${domain}) blocked=${blocked} ${verdicts} key=${key}`);
      continue;
    }

    let plan;
    try {
      const routes = loadRoutes();
      if (routes.error && domainIsRouted(domain, process.env)) throw routes.error;
      plan = planDeliveries({ config: routes.config ?? null, domain, recipients, env: process.env });
    } catch (err) {
      // Never guess a destination: the message stays in S3 under `key` for replay.
      console.error(`FAIL ${messageId} (${domain}) key=${key} routing: ${err?.message || err}`);
      throw err;
    }

    if (recipients.length === 0) console.error(`WARN ${messageId} (${domain}) no recipients in receipt, key=${key}`);
    for (const r of plan.s3Only) {
      console.log(`S3-ONLY ${messageId} (${domain}) rcpt=${r} ${verdicts} key=${key}`);
    }
    if (plan.deliveries.length === 0) continue;

    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const raw = await streamToBuffer(obj.Body);
      // rewrite() depends on the recipients only for the arrival-address headers, so a
      // message it refuses is refused before the first send, never halfway.
      let forwardedCopies;
      try {
        forwardedCopies = plan.deliveries.map((d) => ({ d, forwarded: rewrite(raw, fromAddr, mail, d.recipients) }));
      } catch (err) {
        if (!(err instanceof UnforwardableMessageError)) throw err;
        // Not retried: the same bytes fail the same way. The raw message is in S3.
        console.error(`SKIP ${messageId} (${domain}) ${err.message} ${verdicts} key=${key}`);
        continue;
      }
      for (const { d, forwarded } of forwardedCopies) {
        await ses.send(new SendRawEmailCommand({
          Destinations: d.destinations,
          Source: fromAddr,
          RawMessage: { Data: forwarded },
        }));
        console.log(`OK forwarded ${messageId} (${domain}) ${verdicts} rcpt=${d.recipients.join(",")} target=${d.target} -> ${d.destinations.join(",")}`);
      }
    } catch (err) {
      console.error(`FAIL ${messageId} (${domain}) key=${key}: ${err}`);
      throw err; // surface in CloudWatch; SES action is async so no bounce
    }
  }
  return { disposition: "CONTINUE" };
};
