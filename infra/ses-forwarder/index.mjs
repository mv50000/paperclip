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
import fs from "node:fs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { parseRoutes, planDeliveries, domainIsRouted } from "./routing.mjs";

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
  // the message arrived at (e.g. tietosuoja@), and Aava acts on that header
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
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
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

/** Rewrite the raw inbound message for forwarding.
 *  - From: `"<original name or address> via <domain>" <fromAddr>` (DKIM-aligned)
 *  - Reply-To and X-Original-From: the original From header
 *  - X-Original-To: the address(es) the message arrived at (string or array)
 *  - the original identity and the inbound hop's verdict headers are dropped */
export function rewrite(raw, fromAddr, mail, originalTo) {
  const text = sanitizeDanglingBoundaries(raw.toString("utf8"));
  const m = text.match(/\r?\n\r?\n/);
  const sepIdx = m ? m.index : -1;
  const headerPart = sepIdx >= 0 ? text.slice(0, sepIdx) : text;
  const body = sepIdx >= 0 ? text.slice(sepIdx + m[0].length) : "";

  // Group header lines into logical blocks (header + its folded continuation lines)
  const blocks = [];
  // A lone CR or LF also ends a line here: otherwise `Subject: x\rX-Original-To: …`
  // would carry a second header through inside a kept one.
  for (const line of headerPart.split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(line) && blocks.length) blocks[blocks.length - 1].push(line);
    else blocks.push([line]);
  }
  const nameOf = (b) => (b[0].split(":")[0] || "").toLowerCase().trim();
  // A header whose name holds control characters (`X-Original-To\0:`) is dropped too.
  const kept = blocks
    .filter((b) => !DROP_HEADERS.has(nameOf(b)) && !/[\x00-\x1f\x7f]/.test(b[0].split(":")[0]))
    .map((b) => b.join("\r\n"));
  const rawValueOf = (name) => {
    const b = blocks.find((x) => nameOf(x) === name);
    return b ? b.join("\r\n").slice(b[0].indexOf(":") + 1) : "";
  };
  // Only a value that fits one header line is copied; a cut address is worse than none.
  const fitting = (v) => (v && Buffer.byteLength(v, "utf8") <= 900 ? v : "");

  // The original From exactly as the sender wrote it (encoded-words intact), so
  // replying reaches them; SES's decoded commonHeaders value is the fallback.
  const rawFrom = rawValueOf("from");
  const commonFrom = mail?.commonHeaders?.from?.[0] || "";
  const origFrom = fitting(sanitizeHeaderValue(rawFrom, 2000)) || fitting(sanitizeHeaderValue(commonFrom, 2000));
  // The sender's own Reply-To (e.g. a contact form's customer address) would be lost
  // with Reply-To rewritten to the sender, so it travels as X-Original-Reply-To.
  const origReplyTo = fitting(sanitizeHeaderValue(rawValueOf("reply-to"), 2000));

  const domain = String(fromAddr).split("@")[1] || "";
  const label = senderLabel(commonFrom || rawFrom);
  const phrase = encodePhrase(`${label} via ${domain}`);

  const toList = (Array.isArray(originalTo) ? originalTo : [originalTo])
    .map((a) => sanitizeHeaderValue(a, 320))
    .filter(Boolean);

  const newHeaders = [
    `From: ${phrase} <${fromAddr}>`,
    ...(origFrom ? [`Reply-To: ${origFrom}`, `X-Original-From: ${origFrom}`] : []),
    // Which address this actually arrived at — the To: header alone can be anything
    // (bcc, alias, list), and on a domain catch-all that is the useful fact.
    ...(origReplyTo ? [`X-Original-Reply-To: ${origReplyTo}`] : []),
    ...(toList.length ? [`X-Original-To: ${toList.join(",\r\n ")}`] : []),
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
      for (const d of plan.deliveries) {
        const forwarded = rewrite(raw, fromAddr, mail, d.recipients);
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
