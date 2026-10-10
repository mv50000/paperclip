// RK9-475: a fingerprint of exactly what the operator approved. Pure (no DB)
// so the canonical form is unit-testable on its own.
//
// `approveMessage` stores the fingerprint. `listSendQueue` recomputes it from
// the row it is about to hand to the sender daemon and refuses to send when
// the two differ. The API already keeps an approved message read-only (status
// guard, RK9-453); this gate also covers a direct DB change or a future route.

import { createHash } from "node:crypto";
import { normalizeEmail } from "./logic.js";

/** Bump the version when the canonical form changes. Old hashes keep their prefix. */
export const APPROVED_CONTENT_HASH_VERSION = "sha256-v1";

/**
 * The fields that decide what leaves the building and to whom.
 *
 * Left out on purpose: the sender identity (operator configuration on the
 * sequence, not message content) and the compliance footer (added at compose
 * time from the unsubscribe token and the privacy URL).
 */
export interface ApprovedContent {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  inReplyTo: string | null;
  /** The prospect's address at approval time. */
  recipientEmail: string | null;
}

/**
 * Canonical form: a JSON array with a fixed field order, hashed with SHA-256.
 * A JSON array is unambiguous where a plain `subject + "\n" + bodyText`
 * concatenation is not: a subject that contains a newline would collide with
 * a body that starts with the same text. A null HTML body and an empty HTML
 * body are different values. The recipient is compared lower-cased and trimmed.
 *
 * Stored value: `sha256-v1:<64 hex chars>`.
 */
export function computeApprovedContentHash(content: ApprovedContent): string {
  const canonical = JSON.stringify([
    APPROVED_CONTENT_HASH_VERSION,
    content.subject,
    content.bodyText,
    content.bodyHtml ?? null,
    content.inReplyTo ?? null,
    content.recipientEmail ? normalizeEmail(content.recipientEmail) : null,
  ]);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${APPROVED_CONTENT_HASH_VERSION}:${digest}`;
}

export type ApprovedContentVerdict =
  /** Approved before RK9-475: there is no hash, so the message sends as before. */
  | { ok: true; legacy: true }
  | { ok: true; legacy: false }
  | { ok: false; expected: string; actual: string };

export function verifyApprovedContent(
  storedHash: string | null | undefined,
  content: ApprovedContent,
): ApprovedContentVerdict {
  if (!storedHash) return { ok: true, legacy: true };
  const actual = computeApprovedContentHash(content);
  return actual === storedHash ? { ok: true, legacy: false } : { ok: false, expected: storedHash, actual };
}
