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
export function buildUnsubscribeHeaders(
  domain: string,
  unsubscribeBaseUrl: string,
  token: string,
): UnsubscribeHeaders {
  const url = `${unsubscribeBaseUrl.replace(/\/+$/, "")}/u/${token}`;
  return {
    listUnsubscribe: `<mailto:unsub@${domain}>, <${url}>`,
    listUnsubscribePost: "List-Unsubscribe=One-Click",
  };
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
    `Subject: ${foldHeaderValue(env.subject)}`,
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
