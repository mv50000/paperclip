// --- RK9 Custom (RK9-625): coord presence API (epic RK9-620, key presence-api) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/actors,
// behind rk9CoordActorMiddleware: company scope, the RK9-616 loopback rule and
// the actor claim are already resolved in req.rk9CoordActor. This router never
// parses X-RK9-Actor itself (ADR docs/implementation-notes/coord-identity.md).
//
//   PUT    /actors/me        upsert by (company_id, actor_ref); first registration logs activity
//   POST   /actors/me/phase  phase + liveness refresh; no activity_log row (log spam)
//   DELETE /actors/me        end; idempotent 204
//   GET    /actors           compact rows; ?active=1&repo=&issue=&limit=
//
// Contract and env vars: docs/implementation-notes/coord-bus.md ("Presence API").
import { Router, type Request, type RequestHandler } from "express";
import { ZodError, type ZodSchema } from "zod";
import type { Db } from "@paperclipai/db";
import {
  endRk9CoordActorSchema,
  listRk9CoordActorsQuerySchema,
  updateRk9CoordActorPhaseSchema,
  upsertRk9CoordActorSchema,
  type ListRk9CoordActorsQuery,
  type UpdateRk9CoordActorPhase,
  type UpsertRk9CoordActor,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logActivity } from "../services/activity-log.js";
import {
  rk9CoordPresenceService,
  type Rk9CoordPresenceIdentity,
  type Rk9CoordPresenceOptions,
} from "../services/rk9-coord-presence.js";

export type Rk9CoordActorRouteOptions = Rk9CoordPresenceOptions;

function coordError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

/** zod validation with the presence contract's 422 (the shared validate() answers 400). */
function validate422(schema: ZodSchema, part: "body" | "query"): RequestHandler {
  return (req, _res, next) => {
    try {
      const value = part === "body" ? (req.body ?? {}) : req.query;
      const parsed = schema.parse(value);
      if (part === "body") req.body = parsed;
      else (req as Request & { rk9CoordQuery?: unknown }).rk9CoordQuery = parsed;
      next();
    } catch (err) {
      next(err instanceof ZodError ? unprocessable("Validation error", err.issues) : err);
    }
  };
}

interface AdvisoryIdentity {
  kind?: string;
  host?: string;
  external_id?: string;
  externalId?: string;
}

function requireActor(req: Request): Rk9CoordResolvedActor {
  const actor = req.rk9CoordActor;
  // The middleware already rejects a mutation without an actor id; this is a
  // second line of defence for a router mounted elsewhere by mistake.
  if (!actor) throw coordError(400, "rk9_coord_actor_required", "A coord mutation requires an X-RK9-Actor header");
  return actor;
}

/**
 * The body's kind/host are advisory. A value that contradicts the resolved
 * actor is a spoof attempt or a client bug: reject it instead of storing it.
 */
function checkAdvisory(actor: Rk9CoordResolvedActor, body: AdvisoryIdentity) {
  if (body.kind !== undefined && body.kind !== actor.kind) {
    throw coordError(403, "rk9_coord_actor_spoof", "Body kind differs from the resolved actor");
  }
  if (body.host !== undefined && body.host !== actor.host) {
    throw coordError(403, "rk9_coord_host_mismatch", "Body host differs from the host the server attributes the actor to");
  }
  return body.external_id ?? body.externalId ?? null;
}

function identityOf(req: Request, actor: Rk9CoordResolvedActor): Rk9CoordPresenceIdentity {
  const isAgent = actor.kind === "agent_run" && req.actor.type === "agent";
  return {
    companyId: req.params.companyId as string,
    kind: actor.kind,
    actorId: actor.actorId,
    host: actor.host,
    trust: actor.trust,
    agentId: isAgent ? (req.actor.agentId ?? null) : null,
    runId: isAgent ? (req.actor.runId ?? null) : null,
  };
}

export function rk9CoordActorRoutes(db: Db, opts: Rk9CoordActorRouteOptions = {}) {
  const router = Router({ mergeParams: true });
  const presence = rk9CoordPresenceService(db, opts);

  router.put("/me", validate422(upsertRk9CoordActorSchema, "body"), async (req, res, next) => {
    try {
      const actor = requireActor(req);
      const body = req.body as UpsertRk9CoordActor;
      const clientExternalId = checkAdvisory(actor, body);
      const identity = identityOf(req, actor);
      const result = await presence.upsert(identity, {
        name: body.name,
        issue: body.issue,
        repo: body.repo,
        branch: body.branch,
        phase: body.phase,
        pid: body.pid,
        livenessSource: body.liveness_source ?? body.livenessSource,
        metadata: body.metadata,
        clientExternalId,
      });
      if (result.firstRegistration) {
        await logRegistration(req, actor, identity, result.id);
      }
      res.status(result.inserted ? 201 : 200).json({
        id: result.id,
        actorId: actor.actorId,
        kind: actor.kind,
        host: actor.host,
        trust: actor.trust,
        created: result.inserted,
        ttlS: presence.ttlS(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/phase", validate422(updateRk9CoordActorPhaseSchema, "body"), async (req, res, next) => {
    try {
      const actor = requireActor(req);
      const body = req.body as UpdateRk9CoordActorPhase;
      checkAdvisory(actor, body);
      const row = await presence.setPhase(identityOf(req, actor), body.phase);
      if (!row) {
        throw coordError(404, "rk9_coord_actor_not_found", "Register with PUT actors/me before setting a phase");
      }
      res.json({ id: row.id, actorId: actor.actorId, phase: row.phase });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me", validate422(endRk9CoordActorSchema, "body"), async (req, res, next) => {
    try {
      const actor = requireActor(req);
      checkAdvisory(actor, req.body as AdvisoryIdentity);
      await presence.end({ companyId: req.params.companyId as string, actorId: actor.actorId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/", validate422(listRk9CoordActorsQuerySchema, "query"), async (req, res, next) => {
    try {
      const query = (req as Request & { rk9CoordQuery?: ListRk9CoordActorsQuery }).rk9CoordQuery ?? {};
      const actors = await presence.list(req.params.companyId as string, query);
      res.json({ actors, ttlS: presence.ttlS() });
    } catch (err) {
      next(err);
    }
  });

  async function logRegistration(
    req: Request,
    actor: Rk9CoordResolvedActor,
    identity: Rk9CoordPresenceIdentity,
    rowId: string,
  ) {
    const reqActor = req.actor;
    const who =
      reqActor.type === "agent"
        ? {
            actorType: "agent" as const,
            actorId: reqActor.agentId ?? actor.actorId,
            agentId: reqActor.agentId ?? null,
            runId: reqActor.runId ?? null,
            agentApiKeyId: reqActor.source === "agent_key" ? (reqActor.keyId ?? null) : null,
          }
        : reqActor.type === "board" && reqActor.userId
          ? { actorType: "user" as const, actorId: reqActor.userId }
          : // Coord tokens leave req.actor anonymous; the coord actor is the author.
            { actorType: "system" as const, actorId: actor.actorId };
    await logActivity(db, {
      companyId: identity.companyId,
      ...who,
      action: "rk9.coord.actor_registered",
      entityType: "rk9_coord_actor",
      entityId: rowId,
      details: {
        actorRef: actor.actorId,
        kind: actor.kind,
        host: actor.host,
        trust: actor.trust,
        principal: actor.principal,
      },
    });
  }

  return router;
}
// --- /RK9 Custom ---
