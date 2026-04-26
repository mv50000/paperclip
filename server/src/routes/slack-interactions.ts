import express, { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  createSlackInteractionsService,
  readSlackSignatureHeaders,
  verifySlackSignature,
} from "../services/slack/index.js";

interface SlackInteractionsOptions {
  signingSecret: string | undefined;
}

interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}

export function slackInteractionsRoutes(db: Db, opts: SlackInteractionsOptions) {
  const router = Router();
  const svc = createSlackInteractionsService(db);

  router.post(
    "/slack/interactions",
    express.urlencoded({
      extended: false,
      type: "*/*",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
    async (req, res) => {
      if (!opts.signingSecret) {
        res.status(503).json({ error: "Slack interactivity disabled" });
        return;
      }
      const rawBuffer = (req as RawBodyRequest).rawBody;
      const rawBody = rawBuffer ? rawBuffer.toString("utf8") : "";
      const signatureCheck = verifySlackSignature(
        rawBody,
        readSlackSignatureHeaders(req.headers),
        opts.signingSecret,
      );
      if (!signatureCheck.ok) {
        res.status(401).json({ error: "Invalid signature", reason: signatureCheck.reason });
        return;
      }
      const retryNum = Number(req.header("x-slack-retry-num") ?? "0");
      if (Number.isFinite(retryNum) && retryNum > 0) {
        res.status(200).end();
        return;
      }
      const payloadStr =
        typeof (req.body as { payload?: unknown } | undefined)?.payload === "string"
          ? ((req.body as { payload: string }).payload)
          : null;
      if (!payloadStr) {
        res.status(400).json({ error: "Missing payload" });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadStr);
      } catch (err) {
        logger.warn({ err }, "slack interactions invalid payload");
        res.status(400).json({ error: "Invalid payload" });
        return;
      }
      try {
        const handled = await svc.handle(payload);
        if (handled.body && typeof handled.body === "object") {
          res.status(handled.status).json(handled.body);
        } else if (typeof handled.body === "string" && handled.body.length > 0) {
          res.status(handled.status).type("text/plain").send(handled.body);
        } else {
          res.status(handled.status).end();
        }
      } catch (err) {
        logger.error({ err }, "slack interactions handler crashed");
        res.status(200).end();
      }
    },
  );

  return router;
}
