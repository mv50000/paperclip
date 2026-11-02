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
import { rk9CoordMatchText, rk9CoordTextHasSecret } from "../services/rk9-coord-redact.js";
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
  if (fields.metadata && rk9CoordMetadataHasSecret(fields.metadata)) bad.push("metadata");
  if (bad.length > 0) {
    throw new HttpError(422, "Field looks like it contains a secret", {
      code: "rk9_coord_secret_in_field",
      fields: bad,
    });
  }
}

/**
 * Credential words, matched as whole name segments (RK9-642). A name is
 * split into segments at every non-alphanumeric character, at camelCase and
 * acronym boundaries (`githubToken`, `DBPassword`) and between letters and
 * digits (`password1`); it is also read with only the non-alphanumeric
 * splits, so `PassWords` and `apiKeys` stay one segment.
 */
const CREDENTIAL_WORDS = new Set([
  "token", "tokens", "secret", "secrets", "password", "passwords", "passwd", "passwds", "apikey", "apikeys",
]);
/**
 * A credential word followed by one of these segments names metadata about
 * a credential, not the credential: `secret_scan`, `token_count`,
 * `tokens_used`, `password_policy`, `token_type`, `secret_name`. `id` is not
 * on the list: a Vault AppRole `secret_id` is the credential itself.
 */
const HARMLESS_SUFFIXES = new Set([
  "scan", "scanner", "scanning", "policy", "policies", "rule", "rules", "count", "counts", "used", "usage",
  "limit", "limits", "budget", "max", "min", "total", "totals", "type", "kind", "name", "names",
  "ref", "refs", "arn", "path", "file", "expiry", "expires", "expiration", "ttl", "length", "len",
  "rotation", "rotated", "status", "present", "required", "enabled", "provider", "source", "estimate",
]);

function nameSegmentations(name: string): string[][] {
  const text = rk9CoordMatchText(name);
  const plain = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])|([0-9])([A-Za-z])/g, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [plain, split];
}

/**
 * True when the name, without invisible characters, names a credential: a
 * credential word segment (`api` + `key` counts as one) that is not followed
 * by a harmless suffix. `password`, `SECRET_KEY`, `aws_secret_access_key`,
 * `DB_PASSWORD`, `password1`, `apiKeyProd` and `Password:` are credential
 * names; `tokens_used`, `secret_scan`, `tokenizer` and `secretary` are not.
 */
export function isRk9CoordCredentialName(name: string): boolean {
  for (const segments of nameSegmentations(name)) {
    for (let i = 0; i < segments.length; i += 1) {
      let next = i + 1;
      if (segments[i] === "api" && (segments[next] === "key" || segments[next] === "keys")) next += 1;
      else if (!CREDENTIAL_WORDS.has(segments[i]!)) continue;
      const suffix = segments[next];
      if (suffix === undefined || !HARMLESS_SUFFIXES.has(suffix)) return true;
    }
  }
  return false;
}

/**
 * Keys whose string value names the entry in a name/value pair object
 * (`{"name": "PASSWORD", "value": "..."}`, `{"Key": "db_password", "Value":
 * "..."}`, CloudFormation `ParameterKey`).
 */
const PAIR_NAME_KEY_RX = /^(k|id|var|variable|env|field|label|header|param|option|setting|flag|arg)$|(name|key)$/i;
/** Keys that hold the value in such a pair object. */
const PAIR_VALUE_KEY_RX = /^(v|val|data|content|default)$|value$/i;
/** The value part of the key=value branch of RK9_SESSIONS_SECRET_RX. */
const SECRET_VALUE_RX = /[^\s"',;]{6,}/;
/** Separator items in an argv-style list (`["DB_PASSWORD", "=", "..."]`). */
const ARG_SEPARATOR_RX = /^[=:]$/;

/**
 * A string VALUE that names a credential (`"PASSWORD"`, `"DB_PASSWORD"`,
 * `"--db-password"`, `"Password:"`, `"SECRET_KEY"`). Stricter than the key
 * rule, because values are often free text: the value must be one word
 * without whitespace or `/`, and the credential word must end it (trailing
 * punctuation allowed), or be `secret`/`access`/`private` + `key`. So
 * `"rk9-642-secret-check"`, `"src/token-refresh.ts"` and `"Fix password
 * reset flow"` are not credential names.
 */
function isCredentialValueName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = rk9CoordMatchText(value);
  if (text.length === 0 || text.length > 100 || /[\s/]/.test(text)) return false;
  return nameSegmentations(text).some((segments) => {
    const last = segments.at(-1);
    const prev = segments.at(-2);
    if (last === undefined) return false;
    if (CREDENTIAL_WORDS.has(last)) return true;
    return (last === "key" || last === "keys") && (prev === "api" || prev === "secret" || prev === "access" || prev === "private");
  });
}

function isPairName(key: string, value: unknown): boolean {
  return PAIR_NAME_KEY_RX.test(rk9CoordMatchText(key)) && isCredentialValueName(value);
}

/**
 * Indexes of the array items that hold a credential value: the second item
 * of a two-item `[name, value]` pair, and the item after a credential flag
 * (`--password`, `-p` is not covered) or after a `=`/`:` separator item that
 * follows a credential name.
 */
function credentialValueIndexes(items: unknown[]): Set<number> {
  const out = new Set<number>();
  const isName = isCredentialValueName;
  if (items.length === 2 && isName(items[0])) out.add(1);
  items.forEach((item, index) => {
    if (!isName(item)) return;
    const separator = typeof items[index + 1] === "string" && ARG_SEPARATOR_RX.test(items[index + 1] as string);
    if (separator) out.add(index + 2);
    else if (item.startsWith("-")) out.add(index + 1);
  });
  return out;
}

/**
 * Metadata is flagged when any view matches (verifier rounds 2-5):
 * - the JSON text catches key/value pairs such as {"password": "..."};
 * - each key and string value alone, raw and collapsed, catches whitespace
 *   that JSON escapes into `\t` or `\n`;
 * - every string leaf under a credential-named key at ANY depth, so arrays
 *   and nested objects ({"password": ["..."]}, {"secrets": {"db": "..."}})
 *   do not hide the value from the key;
 * - a credential name given as a value: the value entry of a name/value
 *   pair object ({"name": "PASSWORD", "value": "..."}), the second item of a
 *   two-item array (["DB_PASSWORD", "..."]) and the item after a credential
 *   flag or `=` item (["--password", "..."]) count as under a credential key;
 * - under a credential key, a key whose value is a scalar or empty is a leaf
 *   too ({"password": {"<secret>": true}});
 * - `key: value` per string leaf, with the full ancestor key path.
 *
 * Numbers are never secrets (RK9-642): `{"max_tokens": 200000}` and
 * `{"tokens": {"input": 1234}}` are token counts, not credentials. A numeric
 * password sent as a JSON number is therefore accepted; send it as a string
 * and it is rejected.
 */
export function rk9CoordMetadataHasSecret(metadata: Record<string, unknown>): boolean {
  const json = JSON.stringify(metadata, (_key, value: unknown) => (typeof value === "number" ? 0 : value));
  if (rk9CoordTextHasSecret(json)) return true;
  if (!everyRk9CoordString(metadata, (text) => !rk9CoordTextHasSecret(text))) return true;
  let found = false;
  const walk = (value: unknown, path: string[], underSecretKey: boolean, depth: number) => {
    if (found) return;
    if (value === null || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (underSecretKey && SECRET_VALUE_RX.test(value)) {
        found = true;
        return;
      }
      if (path.some((key) => rk9CoordTextHasSecret(`${key}: ${value}`))) found = true;
      return;
    }
    // The schema caps depth; a deeper value here is treated as suspect.
    if (depth <= 0) {
      found = true;
      return;
    }
    if (Array.isArray(value)) {
      // ["DB_PASSWORD", "<secret>"], [..., "--password", "<secret>"]: a credential name, then its value.
      const valueIndexes = credentialValueIndexes(value);
      value.forEach((item, index) => walk(item, path, underSecretKey || valueIndexes.has(index), depth - 1));
      return;
    }
    const entries = Object.entries(value);
    const namedPair = entries.some(([key, item]) => isPairName(key, item));
    for (const [key, item] of entries) {
      // A key under a credential key may itself be the secret, unless it
      // labels a number (a counter map) or a non-empty branch.
      const branch = item !== null && typeof item === "object" && Object.keys(item).length > 0;
      if (underSecretKey && typeof item !== "number" && !branch && SECRET_VALUE_RX.test(key)) {
        found = true;
        return;
      }
      const secretChild =
        underSecretKey ||
        isRk9CoordCredentialName(key) ||
        (namedPair && PAIR_VALUE_KEY_RX.test(rk9CoordMatchText(key)));
      walk(item, [...path, key], secretChild, depth - 1);
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
