// Minimal RFC 5322 / MIME builder for SES raw sends.
//
// SES's "Simple" content does not let us set arbitrary headers (List-Unsubscribe,
// threading), so we send Raw content and build the MIME ourselves. The message
// is a multipart/alternative with a text/plain and a text/html part (both UTF-8,
// base64). Header values that contain non-ASCII (e.g. Finnish names/subjects) are
// RFC 2047 encoded-word encoded; address headers keep the addr-spec intact and
// encode only the display phrase.
//
// This module is pure (no AWS, no I/O) so the encoding can be unit-tested in
// isolation — the value the SES integration is most likely to get subtly wrong.

import { randomBytes } from "node:crypto";
import type { MailSendInput } from "./provider.js";

const CRLF = "\r\n";

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * RFC 2047 encoded-word for a header value with non-ASCII content. ASCII values
 * pass through unchanged. The UTF-8 bytes are split into chunks that never break
 * a multibyte sequence; each chunk becomes its own `=?UTF-8?B?...?=` word kept
 * under the 75-char limit, folded with CRLF + space.
 */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  // 45 raw bytes → 60 base64 chars; +12 for `=?UTF-8?B??=` = 72 ≤ 75.
  const MAX = 45;
  const words: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    let end = Math.min(i + MAX, bytes.length);
    // Back up off a UTF-8 continuation byte (10xxxxxx) so we cut on a char boundary.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${bytes.subarray(i, end).toString("base64")}?=`);
    i = end;
  }
  return words.join(CRLF + " ");
}

/**
 * Encode an address header value. `"Phrase <addr>"` encodes only the phrase;
 * a bare address is returned unchanged (addresses are expected to be ASCII).
 */
export function encodeAddressHeader(value: string): string {
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return value.trim();
  const addr = m[2].trim();
  const phrase = m[1].replace(/^"(.*)"$/, "$1").trim();
  if (!phrase) return `<${addr}>`;
  if (!isAscii(phrase)) return `${encodeHeaderWord(phrase)} <${addr}>`;
  // Quote phrases containing RFC 5322 specials.
  return /[",:;<>@[\]\\]/.test(phrase) ? `"${phrase}" <${addr}>` : `${phrase} <${addr}>`;
}

function rfc5322Date(d: Date): string {
  // toUTCString → "Tue, 26 May 2026 18:30:00 GMT"; RFC 5322 wants a numeric zone.
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/** Wrap a base64 string to 76-char lines (RFC 2045). */
function wrap76(b64: string): string {
  return b64.length === 0 ? "" : (b64.match(/.{1,76}/g)?.join(CRLF) ?? b64);
}

/** Build a raw MIME message (UTF-8 bytes) ready for SES `Content.Raw.Data`. */
export function buildRawMime(input: MailSendInput): Uint8Array {
  const boundary = `=_pcp_${randomBytes(12).toString("hex")}`;

  const headers: string[] = [
    `From: ${encodeAddressHeader(input.from)}`,
    `To: ${input.to.map(encodeAddressHeader).join(", ")}`,
  ];
  if (input.cc && input.cc.length > 0) {
    headers.push(`Cc: ${input.cc.map(encodeAddressHeader).join(", ")}`);
  }
  if (input.replyTo) headers.push(`Reply-To: ${encodeAddressHeader(input.replyTo)}`);
  headers.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  headers.push(`Date: ${rfc5322Date(new Date())}`);
  headers.push("MIME-Version: 1.0");
  // Caller-supplied headers (List-Unsubscribe, threading). Values are ASCII;
  // defensively drop any with CR/LF to avoid header injection.
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) continue;
    headers.push(`${k}: ${v}`);
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.text ?? "", "utf8").toString("base64")),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.html ?? "", "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  ];

  return Buffer.from(headers.join(CRLF) + CRLF + CRLF + body.join(CRLF), "utf8");
}
