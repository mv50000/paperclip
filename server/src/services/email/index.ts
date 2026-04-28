// Outbound orchestration. Single entrypoint `sendEmail` runs:
//   1. Look up company_email_config and route (must be 'verified' + known route_key)
//   2. Validate outbound headers (no CRLF, valid addresses)
//   3. Check suppression list — any hit blocks the send
//   4. Atomic rate-limit check (per-agent + per-company)
//   5. Render markdown → html+text, build From: address
//   6. Resolve resend.api_key from company secrets
//   7. Call Resend
//   8. Persist to email_messages + email_outbound_audit
// Each blocking step also writes a row to email_outbound_audit so we have a
// complete audit trail (rate limits, suppression, header injection attempts).

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyEmailConfig,
  emailMessages,
  emailOutboundAudit,
  emailRoutes,
} from "@paperclipai/db";
import { secretService } from "../secrets.js";
import { logger } from "../../middleware/logger.js";
import { sendViaResend } from "./resend-client.js";
import { checkAndConsumeRateLimit } from "./rate-limiter.js";
import { findSuppressed } from "./suppression.js";
import { buildFromAddress, renderMarkdown, validateOutboundHeaders } from "./render.js";

const RESEND_API_KEY_SECRET = "resend.api_key";

export interface SendEmailInput {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  routeKey: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyMarkdown: string;
  replyTo?: string | null;
  // Threading: when replying, the orchestrator pulls headers/subject prefix
  // from the parent message.
  inReplyToMessageId?: string | null;
  templateKey?: string | null;
}

export type SendEmailResult =
  | { ok: true; messageId: string; providerMessageId: string }
  | { ok: false; reason: "domain_not_verified" | "suppressed"; addresses?: string[] }
  | { ok: false; reason: "rate_limit"; scope: "agent" | "company" }
  | { ok: false; reason: "header_injection" | "invalid_address"; field: string }
  | { ok: false; reason: "unknown_route_key" }
  | { ok: false; reason: "missing_api_key" }
  | { ok: false; reason: "provider_error"; status: number; errorCode: string | null };

export interface ReplyEmailInput {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  inReplyToMessageId: string;
  bodyMarkdown: string;
}

export type ReplyEmailResult =
  | SendEmailResult
  | { ok: false; reason: "parent_not_found" }
  | { ok: false; reason: "parent_not_inbound" };

export interface EmailService {
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  replyToMessage(input: ReplyEmailInput): Promise<ReplyEmailResult>;
}

export function createEmailService(db: Db): EmailService {
  const secrets = secretService(db);

  async function audit(args: {
    companyId: string;
    agentId: string | null;
    runId: string | null;
    fromAddress: string;
    toAddresses: string[];
    subject: string;
    templateKey: string | null;
    suppressionHit?: boolean;
    rateLimitHit?: boolean;
    providerMessageId?: string | null;
    status: string;
    errorCode?: string | null;
  }) {
    await db.insert(emailOutboundAudit).values({
      companyId: args.companyId,
      agentId: args.agentId,
      runId: args.runId,
      fromAddress: args.fromAddress,
      toAddresses: args.toAddresses,
      subject: args.subject,
      templateKey: args.templateKey,
      suppressionHit: args.suppressionHit ?? false,
      rateLimitHit: args.rateLimitHit ?? false,
      providerMessageId: args.providerMessageId ?? null,
      status: args.status,
      errorCode: args.errorCode ?? null,
    });
  }

  async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    // 1. Config + route
    const [config] = await db
      .select()
      .from(companyEmailConfig)
      .where(eq(companyEmailConfig.companyId, input.companyId));
    if (!config) {
      return { ok: false, reason: "domain_not_verified" };
    }
    if (config.status !== "verified") {
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress: `${input.routeKey}@${config.sendingDomain ?? "?"}`,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        status: "blocked_domain_not_verified",
      });
      return { ok: false, reason: "domain_not_verified" };
    }

    const [route] = await db
      .select()
      .from(emailRoutes)
      .where(
        and(
          eq(emailRoutes.companyId, input.companyId),
          eq(emailRoutes.domain, config.sendingDomain),
          eq(emailRoutes.routeKey, input.routeKey),
        ),
      );
    if (!route) {
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress: `${input.routeKey}@${config.sendingDomain}`,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        status: "blocked_unknown_route",
      });
      return { ok: false, reason: "unknown_route_key" };
    }

    const fromAddress = buildFromAddress(input.routeKey, config.sendingDomain, config.defaultFromName);

    // 2. Header validation
    const headerCheck = validateOutboundHeaders({
      subject: input.subject,
      to: input.to,
      cc: input.cc,
      replyTo: input.replyTo,
    });
    if (!headerCheck.ok) {
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        status: `blocked_${headerCheck.reason}`,
        errorCode: headerCheck.field,
      });
      return { ok: false, reason: headerCheck.reason, field: headerCheck.field };
    }

    // 3. Suppression
    const suppressed = await findSuppressed(db, input.companyId, [...input.to, ...(input.cc ?? [])]);
    if (suppressed.length > 0) {
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        suppressionHit: true,
        status: "blocked_suppression",
      });
      return { ok: false, reason: "suppressed", addresses: suppressed };
    }

    // 4. Rate limit
    const rl = await checkAndConsumeRateLimit(db, {
      companyId: input.companyId,
      agentId: input.agentId,
      perAgentPerDay: config.maxPerAgentPerDay,
      perCompanyPerDay: config.maxPerCompanyPerDay,
    });
    if (!rl.ok) {
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        rateLimitHit: true,
        status: "blocked_rate_limit",
        errorCode: rl.scope,
      });
      return { ok: false, reason: "rate_limit", scope: rl.scope };
    }

    // 5. Render
    const { html, text } = renderMarkdown(input.bodyMarkdown);

    // 6. API key
    const secret = await secrets.getByName(input.companyId, RESEND_API_KEY_SECRET);
    if (!secret) {
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        status: "failed_missing_api_key",
      });
      return { ok: false, reason: "missing_api_key" };
    }
    const apiKey = await secrets.resolveSecretValue(input.companyId, secret.id, "latest");

    // 7. Resend
    const sendResult = await sendViaResend(apiKey, {
      from: fromAddress,
      to: input.to,
      cc: input.cc,
      replyTo: input.replyTo ?? undefined,
      subject: input.subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": `<mailto:${input.routeKey}+unsubscribe@${config.sendingDomain}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (!sendResult.ok) {
      logger.warn(
        {
          companyId: input.companyId,
          agentId: input.agentId,
          status: sendResult.status,
          errorCode: sendResult.errorCode,
        },
        "resend send failed",
      );
      await audit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        fromAddress,
        toAddresses: input.to,
        subject: input.subject,
        templateKey: input.templateKey ?? null,
        status: "failed_provider_error",
        errorCode: sendResult.errorCode,
      });
      return {
        ok: false,
        reason: "provider_error",
        status: sendResult.status,
        errorCode: sendResult.errorCode,
      };
    }

    // 8. Persist
    const [persisted] = await db
      .insert(emailMessages)
      .values({
        companyId: input.companyId,
        direction: "outbound",
        providerMessageId: sendResult.providerMessageId,
        inReplyToId: input.inReplyToMessageId ?? null,
        fromAddress,
        toAddresses: input.to,
        ccAddresses: input.cc ?? [],
        subject: input.subject,
        bodyText: text,
        bodyHtmlSanitized: html,
        attachments: [],
        headers: {},
        routeKey: input.routeKey,
        assignedAgentId: input.agentId,
        status: "sent",
        sentAt: new Date(),
      })
      .onConflictDoNothing({
        target: [emailMessages.companyId, emailMessages.providerMessageId],
      })
      .returning({ id: emailMessages.id });

    const messageId = persisted?.id;
    await audit({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      fromAddress,
      toAddresses: input.to,
      subject: input.subject,
      templateKey: input.templateKey ?? null,
      providerMessageId: sendResult.providerMessageId,
      status: "sent",
    });

    return {
      ok: true,
      messageId: messageId ?? "",
      providerMessageId: sendResult.providerMessageId,
    };
  }

  async function replyToMessage(input: ReplyEmailInput): Promise<ReplyEmailResult> {
    const [parent] = await db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.companyId, input.companyId),
          eq(emailMessages.id, input.inReplyToMessageId),
        ),
      );
    if (!parent) return { ok: false, reason: "parent_not_found" };
    if (parent.direction !== "inbound") {
      // We only reply to inbound. Replying to a sent outbound makes little
      // sense and is a likely sign of confused agent state.
      return { ok: false, reason: "parent_not_inbound" };
    }

    const subject = parent.subject ?? "(ei aihetta)";
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    const routeKey = parent.routeKey ?? "support";

    return sendEmail({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      routeKey,
      to: [parent.fromAddress],
      subject: replySubject,
      bodyMarkdown: input.bodyMarkdown,
      inReplyToMessageId: parent.id,
    });
  }

  return { sendEmail, replyToMessage };
}
