import { Router, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { reportOutreachSendResultSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound, unauthorized } from "../errors.js";
import { listSendQueue, markMessageFailed, markMessageSent } from "../services/outreach/scheduler.js";
import { getMessageById } from "../services/outreach/messages.js";

// RK9-194: machine-to-machine API for the small `outreach-sender` daemon that
// runs on rk9-prod (Postfix there is loopback-only — see
// docs/implementation-notes/outreach-sender.md). Not a Paperclip agent/board
// actor: authenticated with one shared bearer secret, `OUTREACH_SENDER_API_KEY`,
// checked here rather than via `req.actor`. Fails closed when unconfigured.

export function outreachSenderRoutes(db: Db, opts: { apiKey: string | undefined; unsubscribeBaseUrl: string }) {
  const router = Router();

  const requireSenderKey: RequestHandler = (req, _res, next) => {
    const provided = req.header("authorization");
    if (!opts.apiKey || provided !== `Bearer ${opts.apiKey}`) {
      next(unauthorized());
      return;
    }
    next();
  };

  router.get("/outreach/send-queue", requireSenderKey, async (req, res) => {
    const limit = Number(req.query.limit);
    const items = await listSendQueue(db, {
      limit: Number.isFinite(limit) ? limit : undefined,
      unsubscribeBaseUrl: opts.unsubscribeBaseUrl,
    });
    res.json({ items });
  });

  router.post(
    "/outreach/messages/:messageId/report",
    requireSenderKey,
    validate(reportOutreachSendResultSchema),
    async (req, res) => {
      const messageId = req.params.messageId as string;
      const existing = await getMessageById(db, messageId);
      if (!existing) throw notFound();

      const result =
        req.body.outcome === "sent"
          ? await markMessageSent(db, messageId, req.body.sentAt)
          : await markMessageFailed(db, messageId, req.body.smtpCode, req.body.response);

      if (!result.ok) {
        res.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason });
        return;
      }
      res.json(result.message);
    },
  );

  return router;
}
