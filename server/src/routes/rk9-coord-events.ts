// --- RK9 Custom (RK9-626): coord journal routes (epic RK9-620) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/events,
// behind the coord actor middleware (company scope, RK9-616, actor claim).
//   POST /        append one typed event (zod discriminated union)
//   GET  /delta   events after the caller's cursor; ?peek=1, ?fmt=line
//   GET  /vault-pending  decisions whose vault note is not written yet (RK9-631)
// The journal is append-only: there is deliberately no PATCH, PUT or DELETE
// route; those methods fall through to the coord 404 handler.
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  appendRk9CoordEventSchema,
  rk9CoordDeltaQuerySchema,
  rk9CoordVaultPendingQuerySchema,
  type AppendRk9CoordEvent,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import {
  assertRk9CoordEventKindAllowed,
  formatRk9CoordDeltaLine,
  rk9CoordJournalService,
} from "../services/rk9-coord-journal.js";

function coordError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

export function companyIdOf(req: Request): string {
  return (req.params as Record<string, string>).companyId!;
}

/** The resolved caller; a board-key read without X-RK9-Actor has none. */
export function requireRk9CoordActor(req: Request): Rk9CoordResolvedActor {
  const actor = req.rk9CoordActor;
  if (!actor) {
    throw coordError(400, "rk9_coord_actor_required", "This coord route requires an X-RK9-Actor header");
  }
  return actor;
}

export function rk9CoordCallerAgentId(req: Request): string | null {
  return req.actor.type === "agent" ? req.actor.agentId ?? null : null;
}

/** activity_log author for a coord mutation. */
export function rk9CoordActivityActor(req: Request, actor: Rk9CoordResolvedActor) {
  if (req.actor.type === "agent" && req.actor.agentId) {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId,
      agentId: req.actor.agentId,
      runId: req.actor.runId ?? null,
      agentApiKeyId: req.actor.keyId ?? null,
    };
  }
  if (req.actor.type === "board" && req.actor.userId) {
    return { actorType: "user" as const, actorId: req.actor.userId, agentId: null, runId: null };
  }
  return { actorType: "system" as const, actorId: actor.actorId, agentId: null, runId: null };
}

export function rk9CoordEventRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const journal = rk9CoordJournalService(db);

  // RK9-647: the kind allow-list runs before validation, so a Grok post of
  // a server-only type is 403, not 400.
  const eventKindGate = (req: Request, _res: unknown, next: (err?: unknown) => void) => {
    try {
      if (req.rk9CoordActor) assertRk9CoordEventKindAllowed(req.rk9CoordActor, (req.body as { type?: unknown } | undefined)?.type);
      next();
    } catch (err) {
      next(err);
    }
  };

  router.post("/", eventKindGate, validate(appendRk9CoordEventSchema), async (req, res, next) => {
    try {
      const companyId = companyIdOf(req);
      const actor = requireRk9CoordActor(req);
      const input = req.body as AppendRk9CoordEvent;
      // The activity row is written in the insert's transaction (RK9-641).
      const { event, duplicate } = await journal.append(companyId, actor, input, {
        activityActor: rk9CoordActivityActor(req, actor),
        agentId: rk9CoordCallerAgentId(req),
      });
      res.status(duplicate ? 200 : 201).json({ event, duplicate });
    } catch (err) {
      next(err);
    }
  });

  router.get("/delta", async (req, res, next) => {
    try {
      const companyId = companyIdOf(req);
      const query = rk9CoordDeltaQuerySchema.parse(req.query);
      const actor = requireRk9CoordActor(req);
      // ?actorId names the caller, it never selects someone else's cursor.
      if (query.actorId !== undefined && query.actorId !== actor.actorId) {
        throw coordError(403, "rk9_coord_actor_spoof", "actorId must equal the resolved coord actor");
      }
      const delta = await journal.delta(companyId, actor, {
        peek: query.peek ?? false,
        limit: query.limit,
        repo: query.repo ?? null,
        issue: query.issue ?? null,
        agentId: rk9CoordCallerAgentId(req),
        activityActor: rk9CoordActivityActor(req, actor),
      });
      res.setHeader("Cache-Control", "no-store");
      if (!delta) {
        res.status(204).end();
        return;
      }
      if (query.fmt === "line") {
        res.type("text/plain; charset=utf-8").send(formatRk9CoordDeltaLine([...delta.events].reverse(), delta.total));
        return;
      }
      res.json(delta);
    } catch (err) {
      next(err);
    }
  });

  // RK9-631: `rk9 decision --retry` lists the decisions it still has to vault.
  router.get("/vault-pending", async (req, res, next) => {
    try {
      const companyId = companyIdOf(req);
      const query = rk9CoordVaultPendingQuerySchema.parse(req.query);
      const actor = requireRk9CoordActor(req);
      const events = await journal.vaultPending(companyId, actor, { id: query.id, limit: query.limit });
      res.setHeader("Cache-Control", "no-store");
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
// --- /RK9 Custom ---
