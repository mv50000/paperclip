// --- RK9 Custom (RK9-626): coord board view (epic RK9-620) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/board.
// The full view (presence, leases with queues, recent events, pending inbox)
// for an explicit `rk9 board`. Hooks never call it: they use events/delta.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rk9CoordBoardQuerySchema } from "@paperclipai/shared";
import { rk9CoordJournalService, rk9CoordJournalTrust } from "../services/rk9-coord-journal.js";
import { companyIdOf } from "./rk9-coord-events.js";
import { logger } from "../middleware/logger.js";
// RK9 Custom (RK9-629): failed and unacked escalations on the board
import { resolveRk9CoordEscalatorConfig, rk9CoordEscalationService } from "../services/rk9-coord-stall-escalator.js";

export function rk9CoordBoardRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const journal = rk9CoordJournalService(db);
  const escalations = rk9CoordEscalationService(db);

  router.get("/", async (req, res, next) => {
    try {
      const query = rk9CoordBoardQuerySchema.parse(req.query);
      // A board-key read without a claim is the operator's own key: full view.
      // Remote hosts and Grok read as unverified (no message bodies).
      const viewerTrust = req.rk9CoordActor ? rk9CoordJournalTrust(req.rk9CoordActor) : "attributed";
      const board = await journal.board(companyIdOf(req), { viewerTrust, eventLimit: query.events });
      // RK9-629: a failed or unacked escalation never vanishes silently.
      // Fail-open: the board still answers when the escalation query fails.
      const escalationsAttention = await escalations
        .attention(companyIdOf(req), new Date(), resolveRk9CoordEscalatorConfig().recheckS)
        .catch((err: unknown) => {
          logger.warn({ err }, "rk9 coord board: escalation list failed");
          return null;
        });
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...board, escalations_attention: escalationsAttention });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
// --- /RK9 Custom ---
