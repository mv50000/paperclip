// RK9-194: pure RFC 5322 message construction (no DB, no network). Builds the
// raw SMTP DATA payload the sender dials to Postfix, plus the standalone
// header helpers the scheduler/route layer needs (unsubscribe token, links).

import { randomBytes, randomUUID } from "node:crypto";

/** URL-safe, unguessable — used as the `/u/:token` path segment. */
export function generateUnsubscribeToken(): string {
  return randomBytes(24).toString("base64url");
}

/** RFC 5322 `Message-ID`, scoped to the sending domain. */
export function generateMessageId(domain: string): string {
  return `<${randomUUID()}@${domain}>`;
}

export interface UnsubscribeHeaders {
  listUnsubscribe: string;
  listUnsubscribePost: string;
}

/**
 * RFC 8058 one-click unsubscribe headers. `unsubscribeBaseUrl` is the public
 * origin serving `GET/POST /u/:token` (Caddy in front of Paperclip or
 * rk9-prod); `domain` is the sender identity's own domain, used for the
 * `mailto:` fallback most clients show alongside the link.
 */
export function buildUnsubscribeUrl(unsubscribeBaseUrl: string, token: string): string {
  return `${unsubscribeBaseUrl.replace(/\/+$/, "")}/u/${token}`;
}

export function buildUnsubscribeHeaders(
  domain: string,
  unsubscribeBaseUrl: string,
  token: string,
): UnsubscribeHeaders {
  const url = buildUnsubscribeUrl(unsubscribeBaseUrl, token);
  return {
    listUnsubscribe: `<mailto:unsub@${domain}>, <${url}>`,
    listUnsubscribePost: "List-Unsubscribe=One-Click",
  };
}

/**
 * RK9-198 compliance footer, appended at compose time (not by the drafting
 * model — the template forbids links, and the per-message `/u/<token>` URL
 * only exists once the message is queued). Gives every outgoing message the
 * SVPL 200 § opt-out in the *body* as well as in the `List-Unsubscribe`
 * headers (many clients hide those), plus a pointer to the privacy notice.
 * The signature block (sender name, company, business id, address) is the
 * template's job — it is prose the operator reviews, not per-message data.
 */
export const DEFAULT_OUTREACH_PRIVACY_URL = "https://rk9.fi/tietosuoja#outreach";

export interface ComplianceFooterInput {
  unsubscribeUrl: string;
  privacyUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildComplianceFooter(input: ComplianceFooterInput): { text: string; html: string } {
  const text = [
    "",
    "--",
    `Jos et halua enempää viestejä, lopeta yhdellä klikkauksella: ${input.unsubscribeUrl}`,
    `tai vastaa tähän "ei kiitos". Tietosuoja: ${input.privacyUrl}`,
  ].join("\n");
  const html =
    `<p style="margin-top:1.5em;font-size:0.9em;color:#555">Jos et halua enempää viestejä, ` +
    `<a href="${escapeHtml(input.unsubscribeUrl)}">lopeta yhdellä klikkauksella</a> tai vastaa tähän &quot;ei kiitos&quot;. ` +
    `<a href="${escapeHtml(input.privacyUrl)}">Tietosuoja</a></p>`;
  return { text, html };
}

/** Appends the footer to both body variants; the HTML footer goes before `</body>` when there is one. */
export function appendComplianceFooter(
  bodyText: string,
  bodyHtml: string | null | undefined,
  input: ComplianceFooterInput,
): { bodyText: string; bodyHtml: string | null | undefined } {
  const footer = buildComplianceFooter(input);
  const text = bodyText.replace(/\s+$/, "") + "\n" + footer.text + "\n";
  if (!bodyHtml) return { bodyText: text, bodyHtml };
  const closing = bodyHtml.search(/<\/body>/i);
  const html = closing >= 0 ? bodyHtml.slice(0, closing) + footer.html + bodyHtml.slice(closing) : bodyHtml + footer.html;
  return { bodyText: text, bodyHtml: html };
}

/** Threads a follow-up into the same conversation (RFC 5322 §3.6.4). */
export function buildReferences(inReplyTo: string | null | undefined, priorReferences: string | null | undefined): string | undefined {
  const parts = [priorReferences, inReplyTo].filter((v): v is string => !!v && v.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function foldHeaderValue(value: string): string {
  // Headers here are short (addresses, ids, URLs) — no folding needed, but
  // header/CRLF injection via a stray control character in stored data must
  // never reach the wire verbatim. Strip CR and LF individually (not just
  // the \r\n pair) — a bare \r survives `\r?\n`.
  return value.replace(/[\r\n]/g, " ");
}

// 39 bytes → 52 base64 chars → a 64-char encoded-word, so even the first
// line ("Subject: " + word) stays under the RFC 5322 78-char soft limit.
const ENCODED_WORD_MAX_BYTES = 39;

/**
 * RK9-427: RFC 5322 headers are ASCII-only. A raw UTF-8 subject (ä, –, €)
 * is accepted by most MXs but strict ones reject it with `550 Subject
 * contains invalid characters`, which counted as a hard bounce and
 * auto-paused the RK9-198 pilot. Non-ASCII values become RFC 2047
 * `=?UTF-8?B?…?=` words, split on code-point boundaries (a word must hold
 * whole characters) and folded with CRLF + space. Plain ASCII passes through.
 */
export function encodeHeaderText(value: string): string {
  const clean = foldHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    if (chunk && Buffer.byteLength(chunk + char, "utf8") > ENCODED_WORD_MAX_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export interface OutreachEnvelope {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  unsubscribe: UnsubscribeHeaders;
  date?: Date;
}

/** Builds the full raw RFC 5322 message (headers + body) for the SMTP DATA command. */
export function buildRawEmail(env: OutreachEnvelope): string {
  const headers: string[] = [
    `From: ${foldHeaderValue(env.from)}`,
    `To: ${foldHeaderValue(env.to)}`,
    `Subject: ${encodeHeaderText(env.subject)}`,
    `Date: ${(env.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${foldHeaderValue(env.messageId)}`,
    "MIME-Version: 1.0",
    `List-Unsubscribe: ${foldHeaderValue(env.unsubscribe.listUnsubscribe)}`,
    `List-Unsubscribe-Post: ${foldHeaderValue(env.unsubscribe.listUnsubscribePost)}`,
    // No tracking pixels / open-tracking by design (reputation + GDPR).
    "X-Auto-Response-Suppress: All",
  ];
  if (env.inReplyTo) headers.push(`In-Reply-To: ${foldHeaderValue(env.inReplyTo)}`);
  if (env.references) headers.push(`References: ${foldHeaderValue(env.references)}`);

  if (!env.bodyHtml) {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    return [...headers, "", env.bodyText].join("\r\n");
  }

  const boundary = `outreach-${randomUUID()}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    env.bodyText,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "",
    env.bodyHtml,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return [...headers, "", body].join("\r\n");
}
