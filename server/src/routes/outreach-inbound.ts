import express, { Router, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  processOutreachInboundMail,
  readOutreachInboundHeaders,
  verifyOutreachInboundSignature,
} from "../services/outreach/index.js";

// RK9-195: raw inbound mail for the outreach domain, relayed by a small
// process on rk9-prod (Postfix pipe transport → HTTP POST — see
// docs/implementation-notes/outreach-inbound.md), HMAC-signed with a single
// shared secret (`OUTREACH_INBOUND_HMAC_SECRET`; no per-tenant secret model
// here, unlike resend-inbound.ts — this relay speaks for the whole outreach
// domain, not one company). Fails closed when unconfigured, same as
// outreach-sender.ts's bearer-key middleware.

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Wraps `express.raw` so a body-parser size/parse error becomes a proper `HttpError` instead of falling through to a generic 500. */
const captureRawBody: RequestHandler = (req, res, next) => {
  const parser = express.raw({ type: () => true, limit: MAX_BODY_BYTES });
  parser(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const info = err as { status?: number; statusCode?: number; type?: string };
    if (info.type === "entity.too.large" || info.status === 413 || info.statusCode === 413) {
      next(new HttpError(413, "Payload too large"));
      return;
    }
    next(new HttpError(400, "Malformed request body"));
  });
};

export function outreachInboundRoutes(db: Db, opts: { hmacSecret: string | undefined; ownDomains: string[] }) {
  const router = Router();

  router.post("/outreach/inbound", captureRawBody, async (req, res, next) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      next(new HttpError(400, "Malformed request body"));
      return;
    }

    const verify = verifyOutreachInboundSignature(rawBody, readOutreachInboundHeaders(req.headers), opts.hmacSecret);
    if (!verify.ok) {
      // RK9-195 verifier L2: don't hand an unauthenticated caller the exact
      // rejection reason (missing_secret vs. stale_timestamp vs. bad
      // signature) — log it server-side for triage instead.
      logger.warn({ reason: verify.reason }, "outreach inbound: rejected signature");
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const result = await processOutreachInboundMail(db, rawBody, { ownDomains: opts.ownDomains });
      res.status(200).json({ ok: true, outcome: result.outcome });
    } catch (err) {
      // Never let a parse/processing failure retry-loop the relay (same rule
      // as ses-inbound.ts/resend-inbound.ts: 200 on everything except a
      // signature failure) — log for triage instead.
      logger.error({ err }, "outreach inbound: processing failed");
      res.status(200).json({ ok: false });
    }
  });

  return router;
}
