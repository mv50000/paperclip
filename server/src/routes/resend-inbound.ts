// Global Resend inbound webhook endpoint. Resend sends `email.received`,
// `email.bounced`, `email.complained` (and others) here. We resolve the
// tenant via the Svix signature (each company has its own secret) and route
// the event to the inbound-router service.
//
// We always respond 200 to Resend (even on internal failures) so it does not
// retry-loop us; failures are logged and surfaced via metrics. The exception
// is signature verification failure, which returns 401 — Resend will retry
// briefly with the same body, which is fine if the secret was just rotated.

import express, { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { createInboundRouter, readSvixHeaders } from "../services/email/inbound-router.js";

interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}

export function resendInboundRoutes(db: Db) {
  const router = Router();
  const inbound = createInboundRouter(db);

  router.post(
    "/webhooks/resend-inbound",
    express.json({
      type: "*/*",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
    async (req, res) => {
      const rawBuffer = (req as RawBodyRequest).rawBody;
      const rawBody = rawBuffer ? rawBuffer.toString("utf8") : "";
      const svixHeaders = readSvixHeaders(req.headers);

      const tenant = await inbound.resolveTenant(rawBody, svixHeaders);
      if (!tenant.ok) {
        logger.warn(
          { reason: tenant.reason, svixId: svixHeaders.id },
          "resend webhook tenant resolution failed",
        );
        res.status(401).json({ error: "signature_verification_failed", reason: tenant.reason });
        return;
      }

      const event = req.body as { type?: string; data?: unknown };
      if (!event || typeof event.type !== "string") {
        logger.warn({ companyId: tenant.companyId }, "resend webhook missing event type");
        res.status(200).json({ ok: false, reason: "invalid_payload" });
        return;
      }

      try {
        const result = await inbound.handleEvent(tenant.companyId, event as Parameters<typeof inbound.handleEvent>[1]);
        if (!result.ok) {
          logger.warn(
            { companyId: tenant.companyId, type: event.type, reason: result.reason },
            "resend inbound event not routed",
          );
        }
        res.status(200).json(result);
      } catch (err) {
        logger.error({ err, companyId: tenant.companyId }, "resend inbound handler threw");
        res.status(200).json({ ok: false, reason: "internal_error" });
      }
    },
  );

  return router;
}
