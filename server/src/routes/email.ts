import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailMessages, emailOutboundAudit } from "@paperclipai/db";
import { createEmailService } from "../services/email/index.js";
import { DEFAULT_CEO_EMAIL } from "../services/email/escalation.js";
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from "../services/email/suppression.js";
import { wrapUntrusted } from "../services/email/sanitize.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unprocessable } from "../errors.js";

function sendFailureStatus(reason: string): number {
  return reason === "header_injection" || reason === "invalid_address"
    ? 400
    : reason === "domain_not_verified" ||
        reason === "suppressed" ||
        reason === "rate_limit"
      ? 403
      : reason === "unknown_route_key"
        ? 404
        : reason === "missing_api_key"
          ? 503
          : 502;
}

export function emailRoutes(db: Db) {
  const router = Router();
  const service = createEmailService(db);

  router.post("/companies/:companyId/email/send", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const body = req.body ?? {};
    if (typeof body.routeKey !== "string") throw unprocessable("routeKey required");
    if (!Array.isArray(body.to) || body.to.length === 0) throw unprocessable("to required");
    if (typeof body.subject !== "string") throw unprocessable("subject required");
    if (typeof body.bodyMarkdown !== "string") throw unprocessable("bodyMarkdown required");

    const result = await service.sendEmail({
      companyId,
      agentId: actor.agentId,
      runId: actor.runId,
      routeKey: body.routeKey,
      to: body.to,
      cc: Array.isArray(body.cc) ? body.cc : undefined,
      subject: body.subject,
      bodyMarkdown: body.bodyMarkdown,
      replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
      inReplyToMessageId:
        typeof body.inReplyToMessageId === "string" ? body.inReplyToMessageId : null,
      templateKey: typeof body.templateKey === "string" ? body.templateKey : null,
    });

    if (result.ok) {
      res.status(202).json({
        messageId: result.messageId,
        providerMessageId: result.providerMessageId,
      });
      return;
    }

    const status =
      result.reason === "header_injection" || result.reason === "invalid_address"
        ? 400
        : result.reason === "domain_not_verified" ||
            result.reason === "suppressed" ||
            result.reason === "rate_limit"
          ? 403
          : result.reason === "unknown_route_key"
            ? 404
            : result.reason === "missing_api_key"
              ? 503
              : 502;
    res.status(status).json(result);
  });

  router.post("/companies/:companyId/email/escalate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body ?? {};
    if (typeof body.messageId !== "string") throw unprocessable("messageId required");
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      throw unprocessable("reason required");
    }

    const [row] = await db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.companyId, companyId), eq(emailMessages.id, body.messageId)));
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.direction !== "inbound") {
      res.status(409).json({ error: "parent_not_inbound" });
      return;
    }
    if (actor.actorType === "agent" && row.assignedAgentId !== actor.agentId) {
      throw forbidden("Email escalation restricted to the assigned agent");
    }
    if (body.ccCustomer === true) {
      throw unprocessable("ccCustomer is not supported for CEO escalations");
    }

    const routeKey = typeof body.routeKey === "string" ? body.routeKey : row.routeKey ?? "noreply";
    const subject = `[Eskalaatio] ${row.subject ?? "Saapunut sähköposti"}`;
    const messageReceived = row.receivedAt?.toISOString() ?? "?";
    const escalationBody = [
      "Agentti eskaloi saapuneen sähköpostin ihmiselle.",
      "",
      `**Perustelu:** ${body.reason.trim()}`,
      "",
      `**Lähettäjä:** ${row.fromAddress}`,
      `**Aihe:** ${row.subject ?? "(ei aihetta)"}`,
      `**Saapunut:** ${messageReceived}`,
      `**Email message ID:** ${row.id}`,
      row.issueId ? `**Issue ID:** ${row.issueId}` : null,
      "",
      "Katso alkuperäinen viesti Paperclipin email-näkymästä ennen asiakkaalle vastaamista.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const result = await service.sendEmail({
      companyId,
      agentId: actor.agentId,
      runId: actor.runId,
      routeKey,
      to: [DEFAULT_CEO_EMAIL],
      subject,
      bodyMarkdown: escalationBody,
      inReplyToMessageId: row.id,
      templateKey: "system.escalation.manual",
    });

    if (!result.ok) {
      res.status(sendFailureStatus(result.reason)).json(result);
      return;
    }

    await db
      .update(emailMessages)
      .set({ escalatedAt: new Date() })
      .where(and(eq(emailMessages.companyId, companyId), eq(emailMessages.id, row.id)));

    res.status(202).json({
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
      escalatedMessageId: row.id,
    });
  });

  router.post("/companies/:companyId/email/reply", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body ?? {};
    if (typeof body.inReplyToMessageId !== "string") {
      throw unprocessable("inReplyToMessageId required");
    }
    if (typeof body.bodyMarkdown !== "string") throw unprocessable("bodyMarkdown required");

    const result = await service.replyToMessage({
      companyId,
      agentId: actor.agentId,
      runId: actor.runId,
      inReplyToMessageId: body.inReplyToMessageId,
      bodyMarkdown: body.bodyMarkdown,
    });

    if (result.ok) {
      res.status(202).json({
        messageId: result.messageId,
        providerMessageId: result.providerMessageId,
      });
      return;
    }
    const status =
      result.reason === "parent_not_found"
        ? 404
        : result.reason === "parent_not_inbound"
          ? 409
          : result.reason === "header_injection" || result.reason === "invalid_address"
            ? 400
            : result.reason === "domain_not_verified" ||
                result.reason === "suppressed" ||
                result.reason === "rate_limit"
              ? 403
              : result.reason === "unknown_route_key"
                ? 404
                : result.reason === "missing_api_key"
                  ? 503
                  : 502;
    res.status(status).json(result);
  });

  router.get("/companies/:companyId/email/messages/:messageId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const [row] = await db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.companyId, companyId),
          eq(emailMessages.id, req.params.messageId as string),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    res.json({
      id: row.id,
      direction: row.direction,
      providerMessageId: row.providerMessageId,
      fromAddress: row.fromAddress,
      toAddresses: row.toAddresses,
      subject: row.subject,
      status: row.status,
      receivedAt: row.receivedAt,
      sentAt: row.sentAt,
      attachmentCount: attachments.length,
      bodyLength: row.bodyText?.length ?? 0,
      issueId: row.issueId,
      assignedAgentId: row.assignedAgentId,
    });
  });

  router.get("/companies/:companyId/email/messages/:messageId/body", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const [row] = await db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.companyId, companyId),
          eq(emailMessages.id, req.params.messageId as string),
        ),
      );
    if (!row || row.direction !== "inbound") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // ACL: assigned agent only — board/CEO actors bypass.
    if (actor.actorType === "agent") {
      if (row.assignedAgentId !== actor.agentId) {
        throw forbidden("Email body access restricted to the assigned agent");
      }
    }

    const wrapped = wrapUntrusted(row.bodyText ?? "", {
      sender: row.fromAddress,
      subject: row.subject ?? "(ei aihetta)",
      messageId: row.providerMessageId,
    });
    const attachments = Array.isArray(row.attachments)
      ? (row.attachments as Array<{ filename?: string; contentType?: string; sizeBytes?: number }>)
      : [];
    res.json({
      messageId: row.id,
      providerMessageId: row.providerMessageId,
      wrapped: wrapped.wrapped,
      format: "text",
      truncated: wrapped.truncated,
      originalLength: wrapped.originalLength,
      attachments: attachments.map((a, idx) => ({
        index: idx,
        filename: a.filename ?? "attachment",
        contentType: a.contentType ?? "application/octet-stream",
        sizeBytes: a.sizeBytes ?? 0,
      })),
    });
  });

  router.get("/companies/:companyId/email/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await db
      .select()
      .from(emailOutboundAudit)
      .where(eq(emailOutboundAudit.companyId, companyId))
      .orderBy(desc(emailOutboundAudit.createdAt))
      .limit(200);
    res.json(rows);
  });

  router.get("/companies/:companyId/email/suppression", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const entries = await listSuppressions(db, companyId);
    res.json(entries);
  });

  router.post("/companies/:companyId/email/suppression", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body ?? {};
    if (typeof body.address !== "string") throw unprocessable("address required");
    const reason: "manual" | "bounce_hard" | "bounce_soft_repeated" | "complaint" =
      body.reason === "bounce_hard" ||
      body.reason === "bounce_soft_repeated" ||
      body.reason === "complaint"
        ? body.reason
        : "manual";
    const entry = await addSuppression(db, {
      companyId,
      address: body.address,
      reason,
    });
    res.status(201).json(entry);
  });

  router.delete("/companies/:companyId/email/suppression/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const removed = await removeSuppression(db, companyId, req.params.id as string);
    if (!removed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
