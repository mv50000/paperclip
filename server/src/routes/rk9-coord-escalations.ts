// --- RK9 Custom (RK9-629): coord stall escalation routes (epic RK9-620, key stall-escalator) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/escalations,
// behind the coord actor middleware (company scope, RK9-616 loopback rule,
// actor claim):
//   GET  /                   ?status=&limit=&nudges=  -> { mode, config, escalations }: the shadow report
//   POST /:escalationId/ack  { status, channel_message_id?, error? } -> rk9claude's delivery result
// Only kinds rk9claude (the sender, RK9-634) and operator may ack. Unverified
// readers (remote hosts, Grok) see no message text and no error.
// Contract: docs/implementation-notes/coord-stall-escalator.md.
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  ackRk9CoordEscalationSchema,
  rk9CoordEscalationListQuerySchema,
  type AckRk9CoordEscalation,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { rk9CoordJournalTrust } from "../services/rk9-coord-journal.js";
import { resolveRk9CoordEscalatorConfig, rk9CoordEscalationService } from "../services/rk9-coord-stall-escalator.js";
import { companyIdOf, requireRk9CoordActor, rk9CoordActivityActor } from "./rk9-coord-events.js";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Actor kinds that may report a delivery result. */
export const RK9_COORD_ESCALATION_ACK_KINDS: readonly string[] = ["rk9claude", "operator"];

function escalationIdOf(req: Request): string {
  const id = (req.params as Record<string, string>).escalationId ?? "";
  if (!UUID_RX.test(id)) {
    throw new HttpError(404, "No such escalation", { code: "rk9_coord_escalation_not_found" });
  }
  return id.toLowerCase();
}

export function rk9CoordEscalationRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const router = Router({ mergeParams: true });
  const escalations = rk9CoordEscalationService(db);

  router.get("/", async (req, res, next) => {
    try {
      const query = rk9CoordEscalationListQuerySchema.parse(req.query);
      // A board-key read without a claim is the operator's own key.
      const viewerTrust = req.rk9CoordActor ? rk9CoordJournalTrust(req.rk9CoordActor) : "attributed";
      const config = resolveRk9CoordEscalatorConfig(env);
      const rows = await escalations.list(companyIdOf(req), {
        status: query.status,
        limit: query.limit,
        nudges: query.nudges === "true",
        withText: viewerTrust !== "unverified",
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        mode: config.mode,
        config: {
          stuck_s: config.stuckS,
          recheck_s: config.recheckS,
          dedupe_s: config.dedupeS,
          day_max: config.dayMax,
        },
        escalations: rows,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:escalationId/ack", validate(ackRk9CoordEscalationSchema), async (req, res, next) => {
    try {
      const actor = requireRk9CoordActor(req);
      if (!RK9_COORD_ESCALATION_ACK_KINDS.includes(actor.kind)) {
        throw new HttpError(403, "Only rk9claude or the operator may ack an escalation", {
          code: "rk9_coord_escalation_ack_forbidden",
        });
      }
      const input = req.body as AckRk9CoordEscalation;
      const row = await escalations.ack(
        companyIdOf(req),
        escalationIdOf(req),
        input,
        rk9CoordActivityActor(req, actor),
        actor.actorId,
      );
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
// --- /RK9 Custom ---
