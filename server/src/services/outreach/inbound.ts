// RK9-195: inbound outreach-domain mail (replies, DSN bounces, `unsub@`) →
// prospect state machine, via the existing `recordEvent` orchestration
// (events.ts) — no new tables, no new state machine. See
// docs/implementation-notes/outreach-inbound.md for the full design.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailRoutes } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { createInboundRouter, extractReferencedMessageIds, type InboundEmailEvent } from "../email/inbound-router.js";
import {
  classifyInboundOutreachMail,
  classifyDsnSeverity,
  extractOriginalMessageId,
  hasVerifiedAuthentication,
  parseDeliveryStatusFields,
} from "./inbound-classify.js";
import { parseInboundMime, type ParsedInboundMail } from "./inbound-mime.js";
import { normalizeEmail } from "./logic.js";
import { getMessageByRfc822Id, getMessagesByRfc822Ids } from "./messages.js";
import { recordEvent } from "./events.js";
import { addOutreachSuppression } from "./suppressions.js";

// RK9-195 verifier H2: hard cap on how many `References`/`In-Reply-To`
// candidates we'll ever look up per inbound message, independent of the
// (also capped, see inbound-mime.ts) header length — bounds the batched
// query below to a single small `IN (...)`.
const MAX_THREADING_CANDIDATES = 20;

export type OutreachInboundOutcome =
  | "self_loop_dropped"
  | "auto_reply_ignored"
  | "unsubscribed_by_thread"
  | "unsubscribed_by_email"
  | "unsubscribe_skipped_no_sender"
  | "unsubscribe_skipped_unauthenticated"
  | "bounce_recorded"
  | "dsn_ignored_not_a_bounce"
  | "dsn_unmatched"
  | "reply_recorded"
  | "reply_unmatched";

export interface ProcessInboundResult {
  outcome: OutreachInboundOutcome;
  detail?: Record<string, unknown>;
}

interface ThreadMatch {
  companyId: string;
  prospectId: string;
  messageId: string;
}

/** Tries each referenced Message-ID (most recent first) against `outreach_messages`, in one batched query. */
async function resolveByThreading(db: Db, parsed: ParsedInboundMail): Promise<ThreadMatch | null> {
  const candidates = extractReferencedMessageIds(parsed.headers).slice(0, MAX_THREADING_CANDIDATES);
  if (candidates.length === 0) return null;
  const rows = await getMessagesByRfc822Ids(db, candidates);
  if (rows.length === 0) return null;
  const byMessageId = new Map(rows.map((r) => [r.messageId, r]));
  for (const candidate of candidates) {
    const message = byMessageId.get(candidate);
    if (message) return { companyId: message.companyId, prospectId: message.prospectId, messageId: message.id };
  }
  return null;
}

/**
 * RK9-235: which company a reply was addressed TO, even when we cannot tell
 * which prospect it came FROM.
 *
 * Threading answers "which prospect"; the recipient answers "which company".
 * Losing the first does not cost us the second: every company has its own local
 * part on the shared outreach domain (`saatavilla@outreach.rk9.fi` is SAA's and
 * nobody else's), so this is the same recipient-based lookup all normal inbound
 * mail uses. The cross-company misrouting `outreach-inbound.md` warns about
 * comes from guessing a PROSPECT from the SENDER address — a different question
 * with a different answer, and this does not do it.
 */
async function resolveCompanyByRecipient(db: Db, to: string[]): Promise<string | null> {
  for (const addr of to) {
    const at = addr.lastIndexOf("@");
    if (at <= 0) continue;
    const localPart = addr.slice(0, at).replace(/^.*</, "").toLowerCase();
    const domain = addr.slice(at + 1).replace(/>.*$/, "").toLowerCase();
    const [route] = await db
      .select({ companyId: emailRoutes.companyId })
      .from(emailRoutes)
      .where(
        and(
          eq(emailRoutes.domain, domain),
          eq(emailRoutes.localPart, localPart),
        ),
      );
    if (route) return route.companyId;
  }
  return null;
}

/**
 * RK9-235: record THAT an unthreadable reply arrived, never what it said.
 *
 * Phase 1 is measurement only: we do not yet know whether this happens at all,
 * because `reply_unmatched` was returned in the HTTP response and logged
 * nowhere — Postfix saw a successful delivery, the receiver exited 0 and
 * Paperclip answered 200, so a dropped reply was invisible at every layer.
 *
 * The count lives in `activity_log`, not in a module-level variable: an
 * in-memory counter resets on every restart, which is exactly how the LLM
 * portfolio-manager watchdog spent days reporting a confident zero. Metadata
 * only (sender, recipient, subject, message-id) — deciding whether to keep the
 * BODY is phase 2, and it carries its own spam-ingestion and retention
 * questions that this ticket deliberately does not answer.
 */
async function recordUnmatchedReply(db: Db, parsed: ParsedInboundMail): Promise<void> {
  logger.warn(
    { from: parsed.from, to: parsed.to, subject: parsed.subject, messageId: parsed.messageId },
    "outreach inbound: reply could not be threaded to a sent message — dropped (RK9-235)",
  );
  // Everything below is measurement, and measurement must never decide whether
  // a mail was accepted. The warn line above is already on disk; if the lookup
  // or the insert fails, we log that and return normally rather than letting an
  // observability error propagate into the delivery outcome.
  try {
    const companyId = await resolveCompanyByRecipient(db, parsed.to);
    if (!companyId) {
      // Addressed to something we do not own a route for — nothing to
      // attribute it to, so the warn line above is the whole record.
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "outreach-inbound",
      action: "outreach.reply_unmatched",
      entityType: "outreach_reply",
      entityId: parsed.messageId ?? "(no message-id)",
      details: {
        from: parsed.from,
        to: parsed.to,
        subject: parsed.subject || "(ei aihetta)",
      },
    });
  } catch (err) {
    logger.warn({ err }, "outreach inbound: could not record unmatched reply");
  }
}

/**
 * Hands the reply to the existing CS-desk inbound pipeline
 * (`inbound-router.ts`), which is what durably stores the body — the
 * `outreach_events` row records only that a reply happened, never what it said.
 *
 * RK9-234: this was documented as "purely additive" and safe to no-op, on the
 * assumption that `recordEvent` had already recorded the reply. It had not. The
 * router rejected every outreach reply on the recipient-domain check and then
 * refused to store anything without a route, so the RK9-198 pilot's first reply
 * (17.9.2026) was counted and discarded. Both halves are fixed: the tenant is
 * proven by threading (`tenantResolvedBy: "thread"`), and the router persists
 * before it routes.
 */
async function attemptCsAgentHandoff(db: Db, companyId: string, parsed: ParsedInboundMail): Promise<void> {
  const event: InboundEmailEvent = {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: parsed.messageId ?? undefined,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject || "(ei aihetta)",
      text: parsed.text,
      html: parsed.html,
      headers: parsed.headers,
    },
  };
  // `thread`: companyId came from threading this reply back to the outreach
  // message we sent, which carries its own company_id. Without this the router
  // re-checked the recipient domain against the company's OWN domain and
  // rejected every outreach reply, because they all arrive at the shared
  // `outreach.rk9.fi` — that is how the pilot's first reply was lost
  // (17.9.2026, see docs/implementation-notes/outreach-inbound.md).
  const result = await createInboundRouter(db).handleEvent(companyId, event, {
    tenantResolvedBy: "thread",
  });
  if (!result.ok) {
    logger.warn({ companyId, reason: result.reason }, "outreach inbound: CS-desk handoff rejected the reply");
    return;
  }
  if (result.status === "stored_unrouted") {
    // The body is safe (email_messages), but nobody owns it. Surfaced as
    // `outreach_inbound_unrouted` in /metrics and as a line in the daily
    // digest — this repo does not call Telegram itself (see
    // docs/implementation-notes/outreach-metrics.md).
    logger.warn(
      { companyId, from: parsed.from },
      "outreach inbound: reply stored but no route — add an email_routes row for the outreach domain",
    );
  }
}

/** Logs (never throws) when `recordEvent`'s side effects didn't apply — RK9-195 verifier L1: this used to be discarded silently at every call site. */
function logIfEventNotRecorded(result: { ok: boolean; reason?: string }, context: Record<string, unknown>): void {
  if (!result.ok) {
    logger.warn({ ...context, reason: result.reason }, "outreach inbound: recordEvent did not apply");
  }
}

export async function processOutreachInboundMail(
  db: Db,
  rawMime: Buffer,
  opts: { ownDomains: string[] },
): Promise<ProcessInboundResult> {
  const parsed = await parseInboundMime(rawMime);
  const kind = classifyInboundOutreachMail({
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    headers: parsed.headers,
    contentType: parsed.contentType,
    ownDomains: opts.ownDomains,
  });

  switch (kind) {
    case "self_loop": {
      logger.warn({ from: parsed.from, to: parsed.to, cc: parsed.cc }, "outreach inbound: dropped same-domain loop");
      return { outcome: "self_loop_dropped" };
    }

    case "auto_reply": {
      return { outcome: "auto_reply_ignored" };
    }

    case "unsubscribe": {
      const thread = await resolveByThreading(db, parsed);
      if (thread) {
        const result = await recordEvent(db, thread.companyId, {
          prospectId: thread.prospectId,
          messageId: thread.messageId,
          type: "unsubscribe",
          payload: { via: "inbound_unsub_mailto" },
        });
        logIfEventNotRecorded(result, { companyId: thread.companyId, messageId: thread.messageId, type: "unsubscribe" });
        return { outcome: "unsubscribed_by_thread" };
      }
      // No threading header (typical for a bare `mailto:unsub@` send) — the
      // suppression list is GLOBAL and keyed on the e-mail alone, so a
      // specific prospect/company match isn't required to honour the opt-out.
      // This `From` is unauthenticated mail-header content — anyone who can
      // mail `unsub@<our domain>` (a public address, published in every
      // outgoing message's `List-Unsubscribe` header) could otherwise suppress
      // an arbitrary address by forging `From` (RK9-195 verifier H1).
      // `hasUnsubscribeRecipient`'s own-domain restriction only closed the
      // "unsub@ on ANY domain" amplification (H1's other half) — RK9-206
      // closes the rest by requiring SPF+DKIM pass from rk9-prod's Postfix
      // (`hasVerifiedAuthentication`, fail closed on a missing/failed result).
      if (!parsed.from) return { outcome: "unsubscribe_skipped_no_sender" };
      if (!hasVerifiedAuthentication(parsed.headers)) {
        logger.warn(
          { from: parsed.from, to: parsed.to, cc: parsed.cc },
          "outreach inbound: skipped unsub@ suppression-by-email, SPF/DKIM did not both pass",
        );
        return { outcome: "unsubscribe_skipped_unauthenticated" };
      }
      await addOutreachSuppression(db, {
        email: normalizeEmail(parsed.from),
        reason: "unsubscribe",
        note: "inbound unsub@ mailto (no message threading)",
      });
      return { outcome: "unsubscribed_by_email" };
    }

    case "dsn": {
      const fields = parseDeliveryStatusFields(parsed.text ?? "");
      const severity = classifyDsnSeverity(fields);
      if (!severity) return { outcome: "dsn_ignored_not_a_bounce", detail: { action: fields.action } };
      const originalMessageId = extractOriginalMessageId(parsed.rfc822AttachmentText, parsed.references);
      if (!originalMessageId) return { outcome: "dsn_unmatched", detail: { reason: "no_original_message_id" } };
      const message = await getMessageByRfc822Id(db, originalMessageId);
      if (!message) return { outcome: "dsn_unmatched", detail: { reason: "message_not_found", originalMessageId } };
      const result = await recordEvent(db, message.companyId, {
        prospectId: message.prospectId,
        messageId: message.id,
        type: severity,
        payload: { action: fields.action, status: fields.status, diagnosticCode: fields.diagnosticCode },
      });
      logIfEventNotRecorded(result, { companyId: message.companyId, messageId: message.id, type: severity });
      return { outcome: "bounce_recorded", detail: { severity } };
    }

    case "reply": {
      const thread = await resolveByThreading(db, parsed);
      if (!thread) {
        await recordUnmatchedReply(db, parsed);
        return { outcome: "reply_unmatched" };
      }
      const result = await recordEvent(db, thread.companyId, {
        prospectId: thread.prospectId,
        messageId: thread.messageId,
        type: "reply",
        payload: {},
      });
      logIfEventNotRecorded(result, { companyId: thread.companyId, messageId: thread.messageId, type: "reply" });
      try {
        await attemptCsAgentHandoff(db, thread.companyId, parsed);
      } catch (err) {
        logger.warn({ err, companyId: thread.companyId }, "outreach inbound: CS-desk handoff failed");
      }
      return { outcome: "reply_recorded" };
    }
  }
}
