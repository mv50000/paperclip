// RK9-195: inbound outreach-domain mail (replies, DSN bounces, `unsub@`) →
// prospect state machine, via the existing `recordEvent` orchestration
// (events.ts) — no new tables, no new state machine. See
// docs/implementation-notes/outreach-inbound.md for the full design.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { createInboundRouter, extractReferencedMessageIds, type InboundEmailEvent } from "../email/inbound-router.js";
import {
  classifyInboundOutreachMail,
  classifyDsnSeverity,
  extractOriginalMessageId,
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
 * Best-effort handoff into the existing CS-desk inbound pipeline
 * (`inbound-router.ts`) so a genuine reply also surfaces to the company's
 * customer-service agent, exactly like a transactional support email would.
 * Purely additive: `handleEvent` no-ops (`no_matching_route`) until a company
 * has an `email_routes` row for the outreach domain — configuring that is an
 * ops/data step out of scope for this ticket (DB seeding was blocked), not a
 * code path this function needs to create.
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
  const result = await createInboundRouter(db).handleEvent(companyId, event);
  if (!result.ok) {
    logger.info({ companyId, reason: result.reason }, "outreach inbound: no CS-desk route configured yet");
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
      // Residual risk (RK9-195 verifier H1, documented in
      // docs/implementation-notes/outreach-inbound.md): this `From` is
      // unauthenticated mail-header content — full mitigation needs SPF/DKIM
      // verification on the rk9-prod MTA side, out of this ticket's scope
      // ("Blokattu: MTA"). `hasUnsubscribeRecipient`'s own-domain restriction
      // (inbound-classify.ts) bounds the blast radius in the meantime.
      if (!parsed.from) return { outcome: "unsubscribe_skipped_no_sender" };
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
      if (!thread) return { outcome: "reply_unmatched" };
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
