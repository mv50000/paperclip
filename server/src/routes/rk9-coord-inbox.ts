// --- RK9 Custom (RK9-626): coord inbox routes (epic RK9-620) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/inbox.
//   POST /     send; `to` = actor id | issue identifier | name
//   GET  /me   claim and mark delivered (204 when empty)
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { sendRk9CoordInboxSchema, type SendRk9CoordInbox } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { rk9CoordInboxService, type Rk9CoordInboxCaller } from "../services/rk9-coord-inbox.js";
import {
  companyIdOf,
  rk9CoordActivityActor,
  rk9CoordCallerAgentId,
  requireRk9CoordActor,
} from "./rk9-coord-events.js";

function inboxCaller(req: Request, actor: Rk9CoordResolvedActor): Rk9CoordInboxCaller {
  if (req.rk9CoordPrincipal) return { actor, paperclip: { type: "coord_token" } };
  if (req.actor.type === "agent" && req.actor.agentId) {
    return {
      actor,
      paperclip: {
        type: "agent",
        agentId: req.actor.agentId,
        runId: req.actor.runId ?? null,
        agentApiKeyId: req.actor.keyId ?? null,
      },
    };
  }
  if (req.actor.type === "board" && req.actor.userId) {
    return { actor, paperclip: { type: "user", userId: req.actor.userId } };
  }
  return { actor, paperclip: { type: "coord_token" } };
}

export function rk9CoordInboxRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const inbox = rk9CoordInboxService(db);

  router.post("/", validate(sendRk9CoordInboxSchema), async (req, res, next) => {
    try {
      const actor = requireRk9CoordActor(req);
      const result = await inbox.send(companyIdOf(req), inboxCaller(req, actor), req.body as SendRk9CoordInbox);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const actor = requireRk9CoordActor(req);
      const messages = await inbox.claim(companyIdOf(req), actor, {
        agentId: rk9CoordCallerAgentId(req),
        activityActor: rk9CoordActivityActor(req, actor),
      });
      res.setHeader("Cache-Control", "no-store");
      if (messages.length === 0) {
        res.status(204).end();
        return;
      }
      res.json({ actor: actor.actorId, messages });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
// --- /RK9 Custom ---
