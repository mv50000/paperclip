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
  everyRk9CoordString,
  RK9_COORD_METADATA_MAX_DEPTH,
  listRk9CoordActorsQuerySchema,
  updateRk9CoordActorPhaseSchema,
  upsertRk9CoordActorSchema,
  type ListRk9CoordActorsQuery,
  type UpdateRk9CoordActorPhase,
  type UpsertRk9CoordActor,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { rk9CoordTextHasSecret } from "../services/rk9-coord-redact.js";
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
    throw coordError(
      403,
      "rk9_coord_host_mismatch",
      "Body host differs from the host the server attributes the actor to",
    );
  }
  return body.external_id ?? body.externalId ?? null;
}

/**
 * Fields the server stores verbatim (no redaction) must not carry a secret:
 * answer 422 instead of storing it. Phase and name are redacted instead.
 */
function rejectSecrets(fields: {
  branch?: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const bad: string[] = [];
  if (fields.branch && rk9CoordTextHasSecret(fields.branch)) bad.push("branch");
  if (fields.external_id && rk9CoordTextHasSecret(fields.external_id)) bad.push("external_id");
  // String by string: JSON.stringify would escape a tab or newline into `\t`,
  // which the pattern's `\s` no longer sees (verifier round 2).
  if (fields.metadata && metadataHasSecret(fields.metadata)) bad.push("metadata");
  if (bad.length > 0) {
    throw new HttpError(422, "Field looks like it contains a secret", {
      code: "rk9_coord_secret_in_field",
      fields: bad,
    });
  }
}

/**
 * A metadata key that names a credential (singular, plural or compound:
 * `password`, `secrets`, `github_token`, `db_passwd`, `apiKeys`, ...).
 */
const SECRET_KEY_RX = /(token|secret|password|passwd|api[_-]?key|apikey)/i;
/** The value part of the key=value branch of RK9_SESSIONS_SECRET_RX. */
const SECRET_VALUE_RX = /[^\s"',;]{6,}/;

/**
 * Metadata is flagged when any view matches (verifier rounds 2-4):
 * - the JSON text catches key/value pairs such as {"password": "..."};
 * - each key and string value alone, raw and collapsed, catches whitespace
 *   that JSON escapes into `\t` or `\n`;
 * - every leaf under a credential-named key at ANY depth, so arrays and
 *   nested objects ({"password": ["..."]}, {"secrets": {"db": "..."}}) do not
 *   hide the value from the key;
 * - `key: value` per leaf, with the full ancestor key path.
 */
function metadataHasSecret(metadata: Record<string, unknown>): boolean {
  if (rk9CoordTextHasSecret(JSON.stringify(metadata))) return true;
  if (!everyRk9CoordString(metadata, (text) => !rk9CoordTextHasSecret(text))) return true;
  let found = false;
  const walk = (value: unknown, path: string[], underSecretKey: boolean, depth: number) => {
    if (found) return;
    if (value === null || typeof value !== "object") {
      const leaf = String(value);
      if (underSecretKey && (typeof value === "string" || typeof value === "number") && SECRET_VALUE_RX.test(leaf)) {
        found = true;
        return;
      }
      if (path.some((key) => rk9CoordTextHasSecret(`${key}: ${leaf}`))) found = true;
      return;
    }
    // The schema caps depth; a deeper value here is treated as suspect.
    if (depth <= 0) {
      found = true;
      return;
    }
    const entries: [string | null, unknown][] = Array.isArray(value)
      ? value.map((item) => [null, item])
      : Object.entries(value);
    for (const [key, item] of entries) {
      const nextPath = key === null ? path : [...path, key];
      walk(item, nextPath, underSecretKey || (key !== null && SECRET_KEY_RX.test(key)), depth - 1);
    }
  };
  walk(metadata, [], false, RK9_COORD_METADATA_MAX_DEPTH + 1);
  return found;
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
      rejectSecrets({
        branch: body.branch,
        external_id: clientExternalId,
        metadata: body.metadata,
      });
      const identity = identityOf(req, actor);
      const publications: ActivityPublication[] = [];
      const result = await presence.upsert(
        identity,
        {
          name: body.name,
          issue: body.issue,
          repo: body.repo,
          branch: body.branch,
          phase: body.phase,
          pid: body.pid,
          livenessSource: body.liveness_source ?? body.livenessSource,
          metadata: body.metadata,
          clientExternalId,
        },
        (tx, rowId) => logRegistration(tx, req, actor, identity, rowId, publications),
      );
      for (const publication of publications) publishActivity(publication);
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
      await presence.end({
        companyId: req.params.companyId as string,
        actorId: actor.actorId,
        trust: actor.trust,
      });
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

  /** Runs inside the upsert transaction; publications go out after the commit. */
  async function logRegistration(
    tx: Db,
    req: Request,
    actor: Rk9CoordResolvedActor,
    identity: Rk9CoordPresenceIdentity,
    rowId: string,
    publications: ActivityPublication[],
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
    await logActivity(
      tx,
      {
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
      },
      publications,
    );
  }

  return router;
}
// --- /RK9 Custom ---
