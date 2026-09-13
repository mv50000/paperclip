// RK9-193: pure outreach logic (no DB) — import classification and the
// prospect/message state machines. Kept DB-free so it is unit-testable.

import type {
  OutreachEventType,
  OutreachMessageStatus,
  OutreachProspectStatus,
  OutreachSuppressionReason,
} from "@paperclipai/shared";

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type ImportRejectReason = "duplicate_in_batch" | "duplicate_existing" | "suppressed";

export interface ImportRejection {
  index: number;
  email: string;
  reason: ImportRejectReason;
}

export interface ImportClassification<T> {
  accepted: Array<{ index: number; row: T }>;
  rejected: ImportRejection[];
}

/**
 * Decide which rows of a bulk import may be inserted. Rows are already zod-
 * validated (so emails are lower-cased and well-formed). Order of checks per
 * row: suppressed → already exists for this company → duplicate within batch.
 * The first occurrence of an e-mail in the batch wins.
 */
export function classifyImport<T extends { email: string }>(
  rows: T[],
  existingEmails: Iterable<string>,
  suppressedEmails: Iterable<string>,
): ImportClassification<T> {
  const existing = new Set(Array.from(existingEmails, normalizeEmail));
  const suppressed = new Set(Array.from(suppressedEmails, normalizeEmail));
  const seen = new Set<string>();
  const accepted: Array<{ index: number; row: T }> = [];
  const rejected: ImportRejection[] = [];

  rows.forEach((row, index) => {
    const email = normalizeEmail(row.email);
    if (suppressed.has(email)) {
      rejected.push({ index, email, reason: "suppressed" });
      return;
    }
    if (existing.has(email)) {
      rejected.push({ index, email, reason: "duplicate_existing" });
      return;
    }
    if (seen.has(email)) {
      rejected.push({ index, email, reason: "duplicate_in_batch" });
      return;
    }
    seen.add(email);
    accepted.push({ index, row });
  });

  return { accepted, rejected };
}

// --- Prospect state machine -------------------------------------------------

/** Terminal states: no outreach may ever be sent again from these. */
export const PROSPECT_TERMINAL_STATUSES: ReadonlySet<OutreachProspectStatus> = new Set([
  "bounced",
  "unsubscribed",
  "suppressed",
]);

export function isProspectContactable(status: OutreachProspectStatus): boolean {
  return status === "approved" || status === "in_sequence";
}

export interface EventEffect {
  /** New prospect status, or null if the event leaves it unchanged. */
  prospectStatus: OutreachProspectStatus | null;
  /** When set, the prospect's e-mail goes on the GLOBAL suppression list. */
  suppress: OutreachSuppressionReason | null;
}

/**
 * What an inbound event does to the prospect. Terminal states are sticky:
 * a reply after an unsubscribe does not resurrect the prospect.
 */
export function applyEventToProspect(
  current: OutreachProspectStatus,
  type: OutreachEventType,
): EventEffect {
  if (PROSPECT_TERMINAL_STATUSES.has(current)) {
    // Still honour opt-outs so the suppression list stays complete.
    if (type === "unsubscribe") return { prospectStatus: null, suppress: "unsubscribe" };
    if (type === "complaint") return { prospectStatus: null, suppress: "complaint" };
    if (type === "bounce_hard") return { prospectStatus: null, suppress: "bounce_hard" };
    return { prospectStatus: null, suppress: null };
  }
  switch (type) {
    case "unsubscribe":
      return { prospectStatus: "unsubscribed", suppress: "unsubscribe" };
    case "complaint":
      return { prospectStatus: "unsubscribed", suppress: "complaint" };
    case "bounce_hard":
      return { prospectStatus: "bounced", suppress: "bounce_hard" };
    case "reply":
      return { prospectStatus: "replied", suppress: null };
    case "bounce_soft":
    case "dsn":
      return { prospectStatus: null, suppress: null };
  }
}

// --- Message state machine --------------------------------------------------

const MESSAGE_TRANSITIONS: Record<OutreachMessageStatus, ReadonlyArray<OutreachMessageStatus>> = {
  draft: ["approved", "rejected"],
  approved: ["queued", "rejected"],
  rejected: [],
  queued: ["sent", "failed"],
  sent: [],
  failed: ["queued"],
};

export function canTransitionMessage(
  from: OutreachMessageStatus,
  to: OutreachMessageStatus,
): boolean {
  return MESSAGE_TRANSITIONS[from].includes(to);
}

/** A message may only be approved when its prospect is still contactable. */
export function canApproveMessage(
  messageStatus: OutreachMessageStatus,
  prospectStatus: OutreachProspectStatus,
): { ok: true } | { ok: false; reason: "invalid_transition" | "prospect_not_contactable" } {
  if (!canTransitionMessage(messageStatus, "approved")) {
    return { ok: false, reason: "invalid_transition" };
  }
  if (!isProspectContactable(prospectStatus)) {
    return { ok: false, reason: "prospect_not_contactable" };
  }
  return { ok: true };
}
