// RK9-195: raw MIME normalization for the outreach inbound relay.
//
// Same tool as `ses-inbound-adapter.ts` (`mailparser`'s `simpleParser` — a
// hand-rolled MIME parser is a footgun) but a different output shape: this
// feeds `inbound-classify.ts`'s pure classifier, not the CS-desk
// `InboundEmailEvent` pipeline.

import { simpleParser, type AddressObject } from "mailparser";

export interface ParsedInboundMail {
  from: string;
  to: string[];
  /** RK9-195 verifier M2: the loop/unsub guards must also see `Cc` recipients, not just `To`. */
  cc: string[];
  subject: string;
  /** Plain-text body (mailparser also folds a `message/delivery-status` MIME part in here — see inbound-classify.ts). */
  text: string | null;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  /** Allowlisted, lower-cased headers only — never the full header set (size + PII), same rule as `ses-inbound-adapter.ts`. */
  headers: Record<string, string>;
  /** Raw content of the first `message/rfc822` (or `text/rfc822-headers`) attachment, if any — the original message a DSN bounced. */
  rfc822AttachmentText: string | null;
  contentType: { value: string; params: Record<string, string> };
}

function allAddresses(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.flatMap((a) => a.value.map((v) => v.address).filter((x): x is string => !!x));
}

function firstAddress(addr: AddressObject | AddressObject[] | undefined): string | undefined {
  return allAddresses(addr)[0];
}

// RK9-195 verifier H2: an attacker-controlled `References` header with tens of
// thousands of message-ids drove `extractReferencedMessageIds`'s O(n^2)
// dedup (and, downstream, one sequential DB query per id) to 14.6s of
// event-loop blocking on a 769KB body. Truncating the raw header here (before
// it ever reaches that function) caps the cost regardless of what calls it.
// `In-Reply-To` feeds the same function and is capped for the same reason,
// even though it's conventionally a single id.
const MAX_REFERENCES_HEADER_CHARS = 2000;
const MAX_IN_REPLY_TO_HEADER_CHARS = 2000;
// RK9-206: rk9-prod's Postfix now runs an SPF policy service and OpenDKIM in
// verify mode, each prepending its own `Authentication-Results:` header
// before the message is piped to us — same defensive-cap rationale as
// References/In-Reply-To above, sized generously since a real result is a
// couple hundred chars.
const MAX_AUTH_RESULTS_HEADER_CHARS = 2000;

const ALLOWLISTED_HEADERS = [
  "auto-submitted",
  "precedence",
  "x-auto-response-suppress",
  "x-autoreply",
];

export async function parseInboundMime(rawMime: Buffer): Promise<ParsedInboundMail> {
  const parsed = await simpleParser(rawMime);
  // Defensive: an extreme/malformed header section (e.g. a multi-megabyte
  // `References`) has been observed to make mailparser return without a
  // populated `headers` Map — fall back to an empty one rather than throw.
  const rawHeaders: { get(name: string): unknown } = parsed.headers ?? new Map();

  const headers: Record<string, string> = {};
  if (parsed.messageId) headers["message-id"] = parsed.messageId;
  if (parsed.inReplyTo) {
    const inReplyTo = Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo.join(" ") : parsed.inReplyTo;
    headers["in-reply-to"] = inReplyTo.slice(0, MAX_IN_REPLY_TO_HEADER_CHARS);
  }
  if (parsed.references) {
    const joined = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references;
    headers["references"] = joined.slice(0, MAX_REFERENCES_HEADER_CHARS);
  }
  for (const name of ALLOWLISTED_HEADERS) {
    const value = rawHeaders.get(name);
    if (typeof value === "string") headers[name] = value;
  }
  // `Authentication-Results` legitimately repeats (one per verifying filter —
  // OpenDKIM and the SPF policy service each add their own), unlike the
  // single-occurrence headers above — mailparser returns an array once a
  // header key repeats. Join every occurrence so the fail-closed pass check
  // in inbound-classify.ts sees results from all filters, not just the last.
  const authResults = rawHeaders.get("authentication-results");
  const authResultsValues = Array.isArray(authResults)
    ? authResults.filter((v): v is string => typeof v === "string")
    : typeof authResults === "string"
      ? [authResults]
      : [];
  if (authResultsValues.length > 0) {
    headers["authentication-results"] = authResultsValues.join(" | ").slice(0, MAX_AUTH_RESULTS_HEADER_CHARS);
  }
  const list = rawHeaders.get("list") as Record<string, unknown> | undefined;
  if (list && typeof list === "object") {
    for (const sub of ["unsubscribe", "id"] as const) {
      const raw = (list as Record<string, unknown>)[sub];
      if (typeof raw === "string") headers[`list-${sub}`] = raw;
      else if (raw && typeof raw === "object" && typeof (raw as { text?: unknown }).text === "string") {
        headers[`list-${sub}`] = (raw as { text: string }).text;
      }
    }
  }

  const contentTypeHeader = rawHeaders.get("content-type") as
    | { value?: string; params?: Record<string, string> }
    | string
    | undefined;
  const contentType =
    typeof contentTypeHeader === "object" && contentTypeHeader
      ? { value: (contentTypeHeader.value ?? "").toLowerCase(), params: contentTypeHeader.params ?? {} }
      : { value: typeof contentTypeHeader === "string" ? contentTypeHeader.toLowerCase() : "", params: {} };

  const rfc822Attachment = (parsed.attachments ?? []).find(
    (a) => a.contentType === "message/rfc822" || a.contentType === "text/rfc822-headers",
  );

  return {
    from: firstAddress(parsed.from) ?? "",
    to: allAddresses(parsed.to),
    cc: allAddresses(parsed.cc),
    subject: parsed.subject ?? "",
    text: typeof parsed.text === "string" ? parsed.text : null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    messageId: parsed.messageId ?? null,
    inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null,
    references: headers["references"] ?? null,
    headers,
    rfc822AttachmentText: rfc822Attachment ? rfc822Attachment.content.toString("utf8") : null,
    contentType,
  };
}
