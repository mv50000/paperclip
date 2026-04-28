// Auto-reply: when an inbound email arrives and the matching email_routes
// row has an auto_reply_template_id, send a templated acknowledgement
// immediately. The reply uses the same routeKey as the inbound message
// (so From: matches), and is sent in the orchestrator's outbound flow
// (which means it goes through rate limiting + suppression + audit).

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailMessages, emailTemplates } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { EmailService } from "./index.js";

export interface AutoReplyArgs {
  companyId: string;
  inboundMessageId: string;
  routeKey: string;
  fromAddress: string;
  subject: string;
  templateId: string;
}

// Tiny handlebars-ish renderer: only `{{var}}` substitution. No conditionals,
// no loops. If a template needs richer logic we'll switch to handlebars later.
//
// Exported for testability.
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

export async function maybeSendAutoReply(
  db: Db,
  emailService: EmailService,
  args: AutoReplyArgs,
): Promise<{ sent: boolean; reason?: string }> {
  const [tpl] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.id, args.templateId));
  if (!tpl) {
    logger.warn(
      { companyId: args.companyId, templateId: args.templateId },
      "auto-reply template not found",
    );
    return { sent: false, reason: "template_not_found" };
  }
  if (tpl.companyId !== args.companyId) {
    logger.warn(
      { companyId: args.companyId, templateId: args.templateId },
      "auto-reply template belongs to different company",
    );
    return { sent: false, reason: "template_cross_tenant" };
  }

  const vars = {
    sender: args.fromAddress,
    subject: args.subject,
    message_id: args.inboundMessageId,
  };
  const subject = tpl.subjectTpl
    ? renderTemplate(tpl.subjectTpl, vars)
    : `Re: ${args.subject}`;
  const bodyMarkdown = renderTemplate(tpl.bodyMdTpl, vars);

  const result = await emailService.sendEmail({
    companyId: args.companyId,
    agentId: null, // system-issued auto-reply
    runId: null,
    routeKey: args.routeKey,
    to: [args.fromAddress],
    subject,
    bodyMarkdown,
    inReplyToMessageId: args.inboundMessageId,
    templateKey: `auto_reply.${tpl.key}`,
  });

  if (!result.ok) {
    logger.warn(
      { companyId: args.companyId, reason: result.reason },
      "auto-reply send failed",
    );
    return { sent: false, reason: result.reason };
  }

  await db
    .update(emailMessages)
    .set({ autoRepliedAt: new Date() })
    .where(eq(emailMessages.id, args.inboundMessageId));

  return { sent: true };
}
