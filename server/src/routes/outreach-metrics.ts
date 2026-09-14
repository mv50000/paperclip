import { Router, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { unauthorized } from "../errors.js";
import { collectOutreachPrometheusMetrics, renderOutreachPrometheusText, buildOutreachDigest } from "../services/outreach/metrics.js";

// RK9-197: observability endpoints for the outreach pipeline. Neither route
// is a Paperclip board/agent actor — same bearer-key convention as
// outreach-sender.ts's `requireSenderKey` (fails closed when unconfigured) —
// because these are scraped/polled by external infra (Prometheus, a host
// cron script), not called from the UI.

function requireKey(apiKey: string | undefined): RequestHandler {
  return (req, _res, next) => {
    const provided = req.header("authorization");
    if (!apiKey || provided !== `Bearer ${apiKey}`) {
      next(unauthorized());
      return;
    }
    next();
  };
}

/**
 * `GET /metrics` — Prometheus scrape target. Mounted directly on `app`
 * (outside `/api`), same convention as `unsubscribeRoutes` — Prometheus
 * expects the metrics path at the root, not nested under a versioned API.
 */
export function outreachPrometheusMetricsRoutes(db: Db, opts: { apiKey: string | undefined }) {
  const router = Router();
  router.get("/metrics", requireKey(opts.apiKey), async (_req, res) => {
    const metrics = await collectOutreachPrometheusMetrics(db);
    res.type("text/plain; version=0.0.4; charset=utf-8").send(renderOutreachPrometheusText(metrics));
  });
  return router;
}

/**
 * `GET /outreach/digest` — mounted under `/api`, same bearer key as
 * `/metrics`. The host-side daily cron (see
 * docs/implementation-notes/outreach-metrics.md) fetches this once at 08:00
 * Europe/Helsinki and passes the `text` field straight to `rk9_telegram_send`.
 */
export function outreachDigestRoutes(db: Db, opts: { apiKey: string | undefined }) {
  const router = Router();
  router.get("/outreach/digest", requireKey(opts.apiKey), async (_req, res) => {
    res.json(await buildOutreachDigest(db));
  });
  return router;
}
