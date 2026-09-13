// RK9-196: automatic quality gate that runs on every AI-drafted message
// before it reaches the human approval queue. Pure/DB-free so it is
// unit-testable without a live Claude or Firecrawl call — see
// docs/implementation-notes/outreach-enrichment.md.

import { OUTREACH_DRAFT_MAX_WORDS, OUTREACH_PRIVATE_EMAIL_DOMAINS } from "@paperclipai/shared";
import { normalizeEmail } from "./logic.js";

export type QualityGateReason =
  | "missing_email"
  | "placeholder_text"
  | "private_email_domain"
  | "suppressed"
  | "too_long";

export type QualityGateVerdict = { ok: true } | { ok: false; reason: QualityGateReason };

// Bracketed/braced template leftovers a careless prompt can leak into the
// body, e.g. "[yritys]", "[COMPANY_NAME]", "[client-name]", "{company}",
// "{{orgName}}". Local part may contain letters, digits, spaces, "_" or "-".
const PLACEHOLDER_RE = /\[[a-zäöå0-9_ -]{1,40}\]|\{\{[a-zäöå0-9_ -]{1,60}\}\}|\{[a-zäöå0-9_ -]{1,60}\}/i;

export function containsPlaceholderText(text: string): boolean {
  return PLACEHOLDER_RE.test(text);
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export function isPrivateEmailDomain(email: string): boolean {
  return (OUTREACH_PRIVATE_EMAIL_DOMAINS as readonly string[]).includes(emailDomain(normalizeEmail(email)));
}

/** Whitespace word count — matches how a human would count words in the draft. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export interface QualityGateInput {
  /** The prospect's e-mail, or null if none is known yet (draft cannot be gated/sent). */
  email: string | null;
  bodyText: string;
  /** Result of an `outreach/suppressions/check` lookup for `email`. */
  suppressed: boolean;
}

/**
 * Runs the AC-mandated checks in order: missing address, placeholder text,
 * private/free e-mail domain, global suppression, word count. The first
 * failure wins — callers store it verbatim as the message's `reject_reason`
 * so prompt iteration has a concrete signal (RK9-196 AC).
 */
export function runQualityGate(input: QualityGateInput): QualityGateVerdict {
  if (!input.email) return { ok: false, reason: "missing_email" };
  if (containsPlaceholderText(input.bodyText)) return { ok: false, reason: "placeholder_text" };
  if (isPrivateEmailDomain(input.email)) return { ok: false, reason: "private_email_domain" };
  if (input.suppressed) return { ok: false, reason: "suppressed" };
  if (countWords(input.bodyText) > OUTREACH_DRAFT_MAX_WORDS) return { ok: false, reason: "too_long" };
  return { ok: true };
}
