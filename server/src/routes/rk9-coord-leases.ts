// --- RK9 Custom (RK9-627): coord lease routes (epic RK9-620, key lease-engine) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/leases,
// behind the coord actor middleware (company scope via assertCompanyAccess,
// RK9-616 loopback rule, actor claim). Shapes follow the rk9 CLI (RK9-624):
//   POST /acquire            { resource, ttl_s, reason, wait } -> granted | queued; 409 when held and wait=false
//   POST /:leaseId/renew     { fencing_token, ttl_s }          -> { expires_at }; 409 = lost
//   POST /:leaseId/release   { resource, fencing_token }       -> 200, idempotent; 409 = lost
//   POST /break              { resource, reason, lease_id? }   -> operator/rk9claude for a live holder;
//                                                                 409 rk9_coord_lease_changed (RK9-629)
//   POST /leave              { resource }                      -> { left }: leave the wait queue (RK9-648)
//   POST /validate           { resource, fencing_token }       -> 200 valid; 409 stale
//   GET  /                   ?prefix=&holder=&resource=        -> { leases: [...] }
//   GET  /status             ?resource=                        -> one resource
// A missing lease is 404 `rk9_coord_lease_not_found` (the CLI dead-letters a
// spooled release only on that code). A denied actor kind (grok) gets 403
// `rk9_coord_lease_kind_not_allowed` on every mutation before any body or
// lease check (RK9-648), so it learns nothing about bodies or lease ids.
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  acquireRk9CoordLeaseSchema,
  breakRk9CoordLeaseSchema,
  leaveRk9CoordLeaseQueueSchema,
  releaseRk9CoordLeaseSchema,
  renewRk9CoordLeaseSchema,
  rk9CoordLeaseListQuerySchema,
  rk9CoordLeaseStatusQuerySchema,
  validateRk9CoordLeaseSchema,
  type AcquireRk9CoordLease,
  type BreakRk9CoordLease,
  type LeaveRk9CoordLeaseQueue,
  type ReleaseRk9CoordLease,
  type RenewRk9CoordLease,
  type ValidateRk9CoordLease,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  assertRk9CoordLeaseKind,
  rk9CoordLeaseService,
  type Rk9CoordLeaseCaller,
  type Rk9CoordLeaseMutationResult,
  type Rk9CoordLeaseServiceOptions,
} from "../services/rk9-coord-leases.js";
import { companyIdOf, requireRk9CoordActor, rk9CoordActivityActor, rk9CoordCallerAgentId } from "./rk9-coord-events.js";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function callerOf(req: Request): Rk9CoordLeaseCaller {
  const actor = requireRk9CoordActor(req);
  return { actor, activity: rk9CoordActivityActor(req, actor), agentId: rk9CoordCallerAgentId(req) };
}

function leaseIdOf(req: Request): string {
  const leaseId = (req.params as Record<string, string>).leaseId ?? "";
  if (!UUID_RX.test(leaseId)) {
    throw new HttpError(404, "No such lease", { code: "rk9_coord_lease_not_found" });
  }
  return leaseId.toLowerCase();
}

function sendMutation(res: Response, result: Rk9CoordLeaseMutationResult, extra: Record<string, unknown> = {}) {
  if (!result.ok) {
    res.status(409).json({
      error: "The lease is lost: expired, taken over, broken or the fencing token is stale",
      code: result.code,
      lease_id: result.lease_id,
      resource: result.resource,
      release_reason: result.release_reason,
    });
    return;
  }
  res.json({ ...result, ...extra });
}

/** RK9-648: a denied actor kind gets 403 before the body is validated (400) or a lease is looked up (404). */
function leaseKindGate(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.rk9CoordActor) assertRk9CoordLeaseKind(req.rk9CoordActor);
    next();
  } catch (err) {
    next(err);
  }
}

export function rk9CoordLeaseRoutes(db: Db, opts: Rk9CoordLeaseServiceOptions = {}) {
  const router = Router({ mergeParams: true });
  const leases = rk9CoordLeaseService(db, opts);

  router.post("/acquire", leaseKindGate, validate(acquireRk9CoordLeaseSchema), async (req, res, next) => {
    try {
      const input = req.body as AcquireRk9CoordLease;
      const result = await leases.acquire(companyIdOf(req), callerOf(req), {
        resource: input.resource,
        ttlS: input.ttl_s,
        reason: input.reason ?? null,
        wait: input.wait,
        mode: input.mode,
      });
      if (!result.granted && !result.queued) {
        res.status(409).json({ error: `${result.resource} is held by ${result.holder}`, code: "rk9_coord_lease_held", ...result });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/break", leaseKindGate, validate(breakRk9CoordLeaseSchema), async (req, res, next) => {
    try {
      const input = req.body as BreakRk9CoordLease;
      res.json(
        await leases.breakLease(companyIdOf(req), callerOf(req), {
          resource: input.resource,
          reason: input.reason,
          leaseId: input.lease_id ?? null, // RK9 Custom (RK9-629)
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/leave", leaseKindGate, validate(leaveRk9CoordLeaseQueueSchema), async (req, res, next) => {
    try {
      const input = req.body as LeaveRk9CoordLeaseQueue;
      res.json(await leases.leaveQueue(companyIdOf(req), callerOf(req), { resource: input.resource }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/validate", validate(validateRk9CoordLeaseSchema), async (req, res, next) => {
    try {
      const input = req.body as ValidateRk9CoordLease;
      const result = await leases.validateToken(companyIdOf(req), {
        resource: input.resource,
        fencingToken: input.fencing_token,
      });
      if (!result.valid) {
        res.status(409).json({ error: "The fencing token is not current", code: "rk9_coord_lease_stale", ...result });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const query = rk9CoordLeaseListQuerySchema.parse(req.query);
      const rows = await leases.list(companyIdOf(req), query, req.rk9CoordActor?.actorId ?? null);
      res.setHeader("Cache-Control", "no-store");
      res.json({ leases: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get("/status", async (req, res, next) => {
    try {
      const query = rk9CoordLeaseStatusQuerySchema.parse(req.query);
      res.setHeader("Cache-Control", "no-store");
      res.json(await leases.status(companyIdOf(req), query.resource, req.rk9CoordActor?.actorId ?? null));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:leaseId/renew", leaseKindGate, validate(renewRk9CoordLeaseSchema), async (req, res, next) => {
    try {
      const input = req.body as RenewRk9CoordLease;
      const result = await leases.renew(companyIdOf(req), callerOf(req), leaseIdOf(req), {
        fencingToken: input.fencing_token,
        ttlS: input.ttl_s,
      });
      sendMutation(res, result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:leaseId/release", leaseKindGate, validate(releaseRk9CoordLeaseSchema), async (req, res, next) => {
    try {
      const input = req.body as ReleaseRk9CoordLease;
      const result = await leases.release(companyIdOf(req), callerOf(req), leaseIdOf(req), {
        fencingToken: input.fencing_token ?? null,
      });
      sendMutation(res, result, result.ok ? { released: !result.noop } : {});
    } catch (err) {
      next(err);
    }
  });

  return router;
}
// --- /RK9 Custom ---
