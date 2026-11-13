// --- RK9 Custom (RK9-626): coord inbox routes (epic RK9-620) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/inbox.
//   POST /     send; `to` = actor id | issue identifier | name
//   GET  /me   claim and mark delivered (204 when empty)
//   GET  /me?peek=1, GET /me/count   count only, no claim (RK9-676)
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { sendRk9CoordInboxSchema, type SendRk9CoordInbox } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import {
  RK9_COORD_INBOX_CLAIM_LIMIT,
  rk9CoordInboxService,
  type Rk9CoordInboxCaller,
} from "../services/rk9-coord-inbox.js";
import {
  companyIdOf,
  rk9CoordActivityActor,
  rk9CoordCallerAgentId,
  requireRk9CoordActor,
} from "./rk9-coord-events.js";

/** `?peek=1` (also `true`, `yes`); anything else, or no value, claims. */
function isPeek(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && /^(1|true|yes)$/i.test(raw.trim());
}

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
      const caller = inboxCaller(req, actor);
      // RK9 Custom (RK9-701): only a board user comments on an issue; apply its privacy predicate.
      if (caller.paperclip.type === "user") caller.issueReadCondition = await issueReadSqlCondition(db, req.actor);
      const result = await inbox.send(companyIdOf(req), caller, req.body as SendRk9CoordInbox);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // RK9-676: a count-only read. `/me/count` is the form the CLI uses: a
  // server without it answers 404, while an older server would ignore
  // `?peek=1` on `/me` and claim (consume) the messages.
  async function sendCount(req: Request, res: Response) {
    const actor = requireRk9CoordActor(req);
    const count = await inbox.count(companyIdOf(req), actor);
    res.setHeader("Cache-Control", "no-store");
    res.json({ actor: actor.actorId, peek: true, count, capped: count >= RK9_COORD_INBOX_CLAIM_LIMIT });
  }

  router.get("/me/count", async (req, res, next) => {
    try {
      await sendCount(req, res);
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      if (isPeek(req.query.peek)) {
        await sendCount(req, res);
        return;
      }
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
