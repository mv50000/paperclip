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

export function rk9CoordBoardRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const journal = rk9CoordJournalService(db);

  router.get("/", async (req, res, next) => {
    try {
      const query = rk9CoordBoardQuerySchema.parse(req.query);
      // A board-key read without a claim is the operator's own key: full view.
      // Remote hosts and Grok read as unverified (no message bodies).
      const viewerTrust = req.rk9CoordActor ? rk9CoordJournalTrust(req.rk9CoordActor) : "attributed";
      const board = await journal.board(companyIdOf(req), { viewerTrust, eventLimit: query.events });
      res.setHeader("Cache-Control", "no-store");
      res.json(board);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
// --- /RK9 Custom ---
