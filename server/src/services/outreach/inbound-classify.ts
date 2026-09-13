// RK9-195: pure classification of an inbound outreach-domain message (no DB,
// no network — mirrors the "logic.ts is DB-free and unit-testable" pattern
// used everywhere else in this module).

import { classifyInbound } from "../email/junk-guard.js";

export interface ClassifyInboundInput {
  from: string;
  to: string[];
  /** RK9-195 verifier M2: loop/unsub guards below must also see `Cc`, not just `To`. */
  cc: string[];
  headers: Record<string, string>;
  contentType: { value: string; params: Record<string, string> };
  /**
   * Lower-cased domains this deployment actually sends outreach from.
   * `hasUnsubscribeRecipient` is fail-closed on this: an empty list means the
   * `unsub@` mailto fallback never fires (see `config.ts#outreachInboundOwnDomains`).
   */
  ownDomains: string[];
}

export type OutreachInboundKind =
  | "self_loop"
  | "unsubscribe"
  | "auto_reply"
  | "dsn"
  | "reply";

function addressDomain(addr: string): string {
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : "";
}

function addressLocalPart(addr: string): string {
  const at = addr.indexOf("@");
  return at >= 0 ? addr.slice(0, at).toLowerCase() : addr.toLowerCase();
}

/**
 * Mail-loop guard (Ololla incident, 2026-05-12 — see
 * docs/implementation-notes/outreach-inbound.md): a message whose sender
 * domain matches ANY recipient domain on this message originated from our
 * own outreach domain (e.g. a bounce-of-a-bounce, or a misconfigured
 * challenge-response reply) and must never be treated as a genuine signal.
 * Checked against `to`+`cc` (RK9-195 verifier M2: a `Cc`-only match used to
 * slip past this) — the domain Postfix routed this message to us on is one
 * of them — `inbound-router.ts`'s existing guard is the same shape, just
 * computed from a config row instead of the message itself.
 */
export function isSelfLoop(from: string, recipients: string[]): boolean {
  const fromDomain = addressDomain(from);
  if (!fromDomain) return false;
  return recipients.some((addr) => addressDomain(addr) === fromDomain);
}

/**
 * Matches the `mailto:unsub@${domain}` convention from
 * `message-format.ts#buildUnsubscribeHeaders` — restricted to `ownDomains`
 * (RK9-195 verifier H1: `To`/`Cc` are attacker-controlled header content, not
 * a verified envelope recipient, so matching `unsub@` on ANY domain let a
 * forged header trigger a permanent, global, cross-tenant suppression for an
 * arbitrary address). Fails closed: an unconfigured/empty `ownDomains` never matches.
 */
export function hasUnsubscribeRecipient(recipients: string[], ownDomains: string[]): boolean {
  if (ownDomains.length === 0) return false;
  return recipients.some(
    (addr) => addressLocalPart(addr) === "unsub" && ownDomains.includes(addressDomain(addr)),
  );
}

export function isDeliveryStatusNotification(contentType: ClassifyInboundInput["contentType"]): boolean {
  if (contentType.value !== "multipart/report") return false;
  const reportType = (contentType.params["report-type"] ?? contentType.params["report_type"] ?? "").toLowerCase();
  return reportType === "delivery-status";
}

/**
 * Classification order matters. DSN is checked FIRST, ahead of the self-loop
 * guard: a legitimate bounce is `From: mailer-daemon@<our domain>` `To: <our
 * own sender identity>@<our domain>` by construction (Postfix bounces to the
 * envelope sender, which IS an address on our own domain) — same-domain-both-
 * sides there is normal, not a loop. Only once DSN is ruled out does
 * same-domain-both-sides become suspicious (a prospect's address is never on
 * our own domain, so anything else from our own domain is either a
 * misconfiguration or a genuine loop) — checked next, ahead of
 * unsubscribe/OOO, so a would-be loop is never misread as either.
 */
export function classifyInboundOutreachMail(input: ClassifyInboundInput): OutreachInboundKind {
  const recipients = [...input.to, ...input.cc];
  if (isDeliveryStatusNotification(input.contentType)) return "dsn";
  if (isSelfLoop(input.from, recipients)) return "self_loop";
  if (hasUnsubscribeRecipient(recipients, input.ownDomains)) return "unsubscribe";
  if (classifyInbound({ from: input.from, headers: input.headers }).automated) return "auto_reply";
  return "reply";
}

export interface DeliveryStatusFields {
  action: string | null;
  status: string | null;
  diagnosticCode: string | null;
}

/**
 * RFC 3464 `message/delivery-status` fields. `mailparser` doesn't recognize
 * this content-type as an attachment (verified empirically — see
 * `__tests__/outreach-inbound-classify.test.ts`), so it folds straight into
 * the parsed `text` alongside the human-readable explanation; this just
 * regexes the fields back out. Per-recipient fields (`Action`/`Status`) can
 * repeat once per recipient block — the LAST occurrence wins, matching the
 * single-recipient case this system actually sends to.
 */
export function parseDeliveryStatusFields(text: string): DeliveryStatusFields {
  const findLast = (re: RegExp): string | null => {
    let match: string | null = null;
    for (const m of text.matchAll(re)) match = m[1].trim();
    return match;
  };
  return {
    action: findLast(/^Action:\s*(.+)$/gim),
    status: findLast(/^Status:\s*(\S+)/gim),
    diagnosticCode: findLast(/^Diagnostic-Code:\s*(.+)$/gim),
  };
}

/**
 * `failed` with a `5.x.x` status (or no status at all — Postfix's own
 * `failed` DSNs are always terminal) is a hard bounce; `delayed`, or a
 * `failed` carrying a `4.x.x` status, is soft. `delivered`/`relayed`/
 * `expanded` are not bounces.
 */
export function classifyDsnSeverity(fields: DeliveryStatusFields): "bounce_hard" | "bounce_soft" | null {
  const statusClass = fields.status?.trim()?.[0];
  if (statusClass === "5") return "bounce_hard";
  if (statusClass === "4") return "bounce_soft";
  const action = fields.action?.trim().toLowerCase();
  if (action === "failed") return "bounce_hard";
  if (action === "delayed") return "bounce_soft";
  return null;
}

/**
 * The Message-ID of the message a DSN bounced, so it can be matched against
 * `outreach_messages.message_id`. Prefers the embedded original message
 * (the `message/rfc822` attachment) over the DSN's own `References`, since
 * MTAs generally don't thread the bounce notification itself.
 */
export function extractOriginalMessageId(rfc822AttachmentText: string | null, references: string | null): string | null {
  const fromAttachment = rfc822AttachmentText?.match(/^Message-ID:\s*(<[^>]+>)/im)?.[1];
  if (fromAttachment) return fromAttachment;
  const refs = references?.match(/<[^\s<>]+>/g);
  return refs && refs.length > 0 ? refs[refs.length - 1] : null;
}
