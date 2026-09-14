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
 * domain is one of OUR OWN outreach domains must never be treated as a
 * genuine signal (e.g. a bounce-of-a-bounce, or a misconfigured
 * challenge-response reply).
 *
 * When `ownDomains` is configured, checked directly against it — no
 * recipient header involved at all. RK9-195 verifier H3 (a regression from
 * the M2 fix below): an earlier version proxied "from our own domain" as
 * "sender domain matches ANY `to`+`cc` recipient domain", which broke on a
 * prospect who reply-alls and CCs a colleague AT THEIR OWN COMPANY — the
 * sender and that Cc share a domain that has nothing to do with us, but the
 * proxy matched anyway and silently dropped a genuine reply/opt-out.
 *
 * Fallback when `ownDomains` is unconfigured: the original `to`-only proxy
 * (Postfix only routes a message to us because `to` names our domain, so
 * same-domain-both-sides on `to` alone is still a reasonable loop signal) —
 * deliberately NOT extended to `cc` for the same reason above.
 */
export function isSelfLoop(from: string, to: string[], ownDomains: string[]): boolean {
  const fromDomain = addressDomain(from);
  if (!fromDomain) return false;
  if (ownDomains.length > 0) return ownDomains.includes(fromDomain);
  return to.some((addr) => addressDomain(addr) === fromDomain);
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

const SPF_PASS_RE = /\bspf=pass\b/i;
const DKIM_PASS_RE = /\bdkim=pass\b/i;

/**
 * RK9-206: gates the address-based `unsub@` fallback (no threading header —
 * see `processOutreachInboundMail`'s "unsubscribe" case), which is the one
 * place an unauthenticated `From:` value drives a permanent, global,
 * cross-tenant suppression for whatever address it claims (documented as
 * residual risk H1 in docs/implementation-notes/outreach-inbound.md — closed
 * here now that rk9-prod's Postfix runs SPF + DKIM verification, RK9-206).
 * The threaded path isn't gated: it never derives its target from `From`, it
 * requires guessing a real Message-ID already sent to that prospect.
 *
 * Fails closed: no `Authentication-Results` header at all (SPF/DKIM not
 * deployed, or a filter outage) means "not authenticated", same fail-closed
 * posture as `hasUnsubscribeRecipient`'s `ownDomains` check. Matches literal
 * `spf=pass`/`dkim=pass` per RFC 8601 — both filters are our own trusted
 * rk9-prod Postfix add-ons, not attacker-supplied (any pre-existing
 * `Authentication-Results` header from the wire is stripped by
 * `smtpd_header_checks` before either filter runs — see
 * `~/.claude/hosts/rk9-prod/outreach-mta/README.md`).
 */
export function hasVerifiedAuthentication(headers: Record<string, string>): boolean {
  const authResults = headers["authentication-results"];
  if (!authResults) return false;
  return SPF_PASS_RE.test(authResults) && DKIM_PASS_RE.test(authResults);
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
  if (isDeliveryStatusNotification(input.contentType)) return "dsn";
  if (isSelfLoop(input.from, input.to, input.ownDomains)) return "self_loop";
  if (hasUnsubscribeRecipient([...input.to, ...input.cc], input.ownDomains)) return "unsubscribe";
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
