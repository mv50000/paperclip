// Outbound email rendering: markdown → { html, text } and header-injection guards.
//
// Outbound is the easy direction: we control the bytes. The only thing the
// server must guarantee is that user-provided strings (subject, replyTo, agent
// markdown) cannot inject SMTP headers (CRLF) or break out of the From: address
// we built server-side.

const CRLF_RE = /[\r\n]/;
// RFC 5322 simplified; intentionally strict (rejects display names with
// quotes/parens). Agents pass plain addresses.
const ADDRESS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export type HeaderValidationError =
  | { ok: false; field: string; reason: "header_injection" }
  | { ok: false; field: string; reason: "invalid_address" };

export function validateOutboundHeaders(input: {
  subject?: string | null;
  to: string[];
  cc?: string[];
  replyTo?: string | null;
}): { ok: true } | HeaderValidationError {
  if (input.subject && CRLF_RE.test(input.subject)) {
    return { ok: false, field: "subject", reason: "header_injection" };
  }
  for (const addr of input.to) {
    if (CRLF_RE.test(addr)) return { ok: false, field: "to", reason: "header_injection" };
    if (!ADDRESS_RE.test(addr)) return { ok: false, field: "to", reason: "invalid_address" };
  }
  for (const addr of input.cc ?? []) {
    if (CRLF_RE.test(addr)) return { ok: false, field: "cc", reason: "header_injection" };
    if (!ADDRESS_RE.test(addr)) return { ok: false, field: "cc", reason: "invalid_address" };
  }
  if (input.replyTo) {
    if (CRLF_RE.test(input.replyTo)) {
      return { ok: false, field: "replyTo", reason: "header_injection" };
    }
    if (!ADDRESS_RE.test(input.replyTo)) {
      return { ok: false, field: "replyTo", reason: "invalid_address" };
    }
  }
  return { ok: true };
}

export function buildFromAddress(routeKey: string, sendingDomain: string, displayName?: string | null) {
  if (!/^[A-Za-z0-9._-]+$/.test(routeKey)) {
    throw new Error(`invalid routeKey: ${routeKey}`);
  }
  const addr = `${routeKey}@${sendingDomain}`;
  if (!displayName) return addr;
  // Quote display name and escape any backslash/quote that snuck in.
  const safe = displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
  return `"${safe}" <${addr}>`;
}

// Minimal markdown → HTML: paragraphs, line breaks, links. Deliberately tiny —
// agents writing transactional emails do not need code blocks or tables. If we
// need richer formatting we'll add it later behind a flag.
export function renderMarkdown(md: string): { html: string; text: string } {
  const text = md;
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const linked = escaped.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    (url) => `<a href="${url}">${url}</a>`,
  );
  const paragraphs = linked
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const html = `<!doctype html><html><body>${paragraphs}</body></html>`;
  return { html, text };
}
