// --- RK9 Custom (RK9-621): coordination bus actor resolution ---
//
// Resolves WHO is calling a coord route (`/api/companies/:companyId/rk9/coord/*`)
// and as which actor. The contract is frozen in
// docs/implementation-notes/coord-identity.md; read it before changing a rule.
//
// Rules, in order:
// 1. Company scope comes only from an authenticated principal: a board key,
//    a signed-in session, an agent key/JWT, or (RK9-623) a coord token. The
//    implicit local-board actor of `local_trusted` mode and an anonymous
//    request are rejected with 401, so a loopback / 127.0.0.1 caller never
//    gets company scope by being local (RK9-616).
// 2. Agent callers are always `agent_run:<runId>`, derived server-side from
//    req.actor. Only standard-scope credentials qualify, and the run must be
//    `running` and belong to the same agent and company. A supplied
//    X-RK9-Actor header must equal the derived id, else 403.
// 3. Board-key callers must be instance admins, and when RK9_COORD_BOARD_KEY_IDS
//    is set the key id must be on that list (the operator key the paperclip-01
//    sessions use). They may claim cc / worktree / headless / orch / operator.
//    A cc claim must name the board host. The claim is attributed, not
//    authenticated: every local session shares the key.
// 4. A signed-in instance admin is `operator` (verified).
// 5. A coord-token principal (set by RK9-623's auth hook on
//    `req.rk9CoordPrincipal`) is bound to one company and one host or service;
//    the claim's host must be that host. A read without a claim defaults to
//    the token's own actor (remote:<host> or the service name).
// 6. A mutation (any method other than GET/HEAD/OPTIONS) needs an actor id. A
//    present but malformed X-RK9-Actor header is 400 on every method.

import type { Request, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import {
  isUuidLike,
  parseRk9CoordActorId,
  rk9CoordTrustCanHoldHardGate,
  RK9_COORD_ACTOR_HEADER,
  RK9_COORD_BOARD_HOST_DEFAULT,
  type Rk9CoordActorKind,
  type Rk9CoordParsedActorId,
  type Rk9CoordTrust,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { assertCompanyAccess } from "../routes/authz.js";

/** Credential behind a coord call. */
export type Rk9CoordPrincipalSource = "board_key" | "session" | "agent_key" | "agent_jwt" | "coord_token";

/**
 * A resolved coord token (RK9-623 sets this on the request before the actor
 * middleware runs, and leaves `req.actor` as `{ type: "none" }` so every
 * non-coord route still sees an anonymous caller).
 */
export interface Rk9CoordTokenPrincipal {
  tokenId: string;
  companyId: string;
  /** `host` tokens are for CLIs on one tailnet host; `service` tokens for one service. */
  principalKind: "host" | "service";
  /** Host label (`mv-laptop`) or service name (`rk9claude`, `grok`). */
  principalName: string;
}

export interface Rk9CoordResolvedActor {
  kind: Rk9CoordActorKind;
  actorId: string;
  /** Host the server attributes the actor to, or null when it has none. */
  host: string | null;
  trust: Rk9CoordTrust;
  principal: Rk9CoordPrincipalSource;
}

export interface Rk9CoordAgentRun {
  companyId: string;
  agentId: string;
  status: string;
}

export interface Rk9CoordActorOptions {
  /** Canonical name of the host that holds the board key. */
  boardHost?: string;
  /**
   * Board-key ids allowed on coord routes. Null or empty = any instance-admin
   * board key. Defaults to RK9_COORD_BOARD_KEY_IDS.
   */
  boardKeyIds?: readonly string[] | null;
  /** Run lookup; defaults to heartbeat_runs. Injected in tests. */
  findAgentRun?: (runId: string) => Promise<Rk9CoordAgentRun | null>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BOARD_KEY_KINDS = new Set<Rk9CoordActorKind>(["cc", "worktree", "headless", "orch", "operator"]);

function coordError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

export function isRk9CoordMutation(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function resolveRk9CoordBoardHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RK9_COORD_BOARD_HOST?.trim().toLowerCase();
  return configured || RK9_COORD_BOARD_HOST_DEFAULT;
}

export function resolveRk9CoordBoardKeyIds(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const ids = (env.RK9_COORD_BOARD_KEY_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

function parseClaim(raw: string | undefined): Rk9CoordParsedActorId | null {
  if (raw === undefined) return null;
  const parsed = parseRk9CoordActorId(raw);
  if (!parsed) {
    throw coordError(400, "rk9_coord_actor_malformed", "X-RK9-Actor does not match the coord actor_id grammar");
  }
  return parsed;
}

function requireClaimOnMutation(claim: Rk9CoordParsedActorId | null, method: string) {
  if (!claim && isRk9CoordMutation(method)) {
    throw coordError(400, "rk9_coord_actor_required", "A coord mutation requires an X-RK9-Actor header");
  }
}

export interface ResolveRk9CoordActorInput {
  actor: Request["actor"];
  principal?: Rk9CoordTokenPrincipal;
  companyId: string;
  method: string;
  /** Raw X-RK9-Actor header value, undefined when absent. */
  actorHeader: string | undefined;
  boardHost: string;
  /** Allowed board-key ids; null = any instance-admin board key. */
  boardKeyIds?: readonly string[] | null;
  findAgentRun: (runId: string) => Promise<Rk9CoordAgentRun | null>;
}

/**
 * Resolve the coord actor. Throws an HttpError on any rejection. Returns null
 * only for a board-key read without an actor claim (attribution missing).
 * The caller must already have checked company access.
 */
export async function resolveRk9CoordActor(input: ResolveRk9CoordActorInput): Promise<Rk9CoordResolvedActor | null> {
  const { actor, principal, method, boardHost } = input;

  if (principal) {
    if (actor.type !== "none") {
      throw coordError(403, "rk9_coord_mixed_credentials", "A coord token cannot be combined with another credential");
    }
    if (principal.companyId !== input.companyId) {
      throw coordError(403, "rk9_coord_wrong_company", "This coord token is bound to another company");
    }
    const claim = parseClaim(input.actorHeader);
    requireClaimOnMutation(claim, method);
    return resolveTokenActor(principal, claim);
  }

  const claim = parseClaim(input.actorHeader);

  if (actor.type === "agent") {
    if (actor.source !== "agent_key" && actor.source !== "agent_jwt") {
      throw coordError(403, "rk9_coord_untrusted_principal", "This agent credential cannot call coord routes");
    }
    // Task-bridge and skill-test keys are limited to some issues or one
    // issue; they must not get a verified, hard-gate-capable identity.
    if (actor.keyScope && actor.keyScope.kind !== "standard") {
      throw coordError(403, "rk9_coord_scoped_key", "Scoped agent keys cannot call coord routes");
    }
    const runId = actor.runId?.trim();
    if (!runId || !isUuidLike(runId)) {
      throw coordError(403, "rk9_coord_agent_run_required", "Agent coord calls must run inside a heartbeat run");
    }
    const run = await input.findAgentRun(runId);
    if (!run || run.companyId !== actor.companyId || run.agentId !== actor.agentId) {
      throw coordError(403, "rk9_coord_agent_run_unbound", "The run does not belong to this agent and company");
    }
    // An agent key's run id is a client-chosen header: without this check one
    // key could act as a finished or sibling run of the same agent.
    if (run.status !== "running") {
      throw coordError(403, "rk9_coord_agent_run_not_live", "The run is not running");
    }
    const actorId = `agent_run:${runId.toLowerCase()}`;
    if (claim && claim.actorId !== actorId) {
      throw coordError(403, "rk9_coord_actor_spoof", "Agent callers are always their own agent_run actor");
    }
    return { kind: "agent_run", actorId, host: null, trust: "verified", principal: actor.source };
  }

  if (actor.type === "board") {
    if (actor.source === "session") {
      if (!actor.isInstanceAdmin) {
        throw coordError(403, "rk9_coord_untrusted_principal", "Only the instance operator may call coord routes from a session");
      }
      if (claim && claim.kind !== "operator") {
        throw coordError(403, "rk9_coord_actor_spoof", "A signed-in session is always the operator actor");
      }
      return { kind: "operator", actorId: "operator", host: null, trust: "verified", principal: "session" };
    }
    if (actor.source === "board_key") {
      // Board keys are per user and any signed-in user can mint one, so the
      // key alone proves nothing about paperclip-01. Only the operator's
      // instance-admin key qualifies, optionally pinned by key id.
      if (!actor.isInstanceAdmin) {
        throw coordError(403, "rk9_coord_untrusted_principal", "Only an instance-admin board key may call coord routes");
      }
      const allowed = input.boardKeyIds;
      if (allowed && allowed.length > 0 && (!actor.keyId || !allowed.includes(actor.keyId))) {
        throw coordError(403, "rk9_coord_board_key_not_allowed", "This board key is not allowed on coord routes");
      }
      requireClaimOnMutation(claim, method);
      if (!claim) return null;
      if (!BOARD_KEY_KINDS.has(claim.kind)) {
        throw coordError(
          403,
          "rk9_coord_kind_not_allowed",
          `The board key cannot act as a ${claim.kind} actor`,
        );
      }
      if (claim.kind === "cc" && claim.host !== boardHost) {
        throw coordError(403, "rk9_coord_host_mismatch", "The board key only serves sessions on its own host");
      }
      return { kind: claim.kind, actorId: claim.actorId, host: boardHost, trust: "attributed", principal: "board_key" };
    }
    // local_implicit (local_trusted mode), cloud tenants, anything else: no
    // company scope from being local or from an unknown source (RK9-616).
  }

  throw coordError(401, "rk9_coord_untrusted_principal", "Coord routes require an authenticated principal");
}

function resolveTokenActor(
  principal: Rk9CoordTokenPrincipal,
  claim: Rk9CoordParsedActorId | null,
): Rk9CoordResolvedActor {
  const name = principal.principalName;
  if (principal.principalKind === "host") {
    if (!claim) {
      return { kind: "remote", actorId: `remote:${name}`, host: name, trust: "unverified", principal: "coord_token" };
    }
    if (claim.kind !== "cc" && claim.kind !== "remote") {
      throw coordError(403, "rk9_coord_kind_not_allowed", `A host token cannot act as a ${claim.kind} actor`);
    }
    if (claim.host !== name) {
      throw coordError(403, "rk9_coord_host_mismatch", "The actor claim names another host than this token");
    }
    return {
      kind: claim.kind,
      actorId: claim.actorId,
      host: name,
      trust: claim.kind === "cc" ? "attributed" : "unverified",
      principal: "coord_token",
    };
  }
  // Service tokens are bound to exactly one service actor.
  if (name !== "rk9claude" && name !== "grok") {
    throw coordError(403, "rk9_coord_kind_not_allowed", "Unknown coord service");
  }
  if (claim && claim.actorId !== name) {
    throw coordError(403, "rk9_coord_host_mismatch", "A service token only acts as its own service");
  }
  return {
    kind: name,
    actorId: name,
    host: name,
    trust: name === "rk9claude" ? "verified" : "unverified",
    principal: "coord_token",
  };
}

function defaultFindAgentRun(db: Db) {
  return async (runId: string): Promise<Rk9CoordAgentRun | null> => {
    const [run] = await db
      .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    return run ?? null;
  };
}

/**
 * Router-level middleware for the coord router. Mount it on a router created
 * with `mergeParams: true` under `/companies/:companyId/rk9/coord`.
 */
export function rk9CoordActorMiddleware(db: Db, opts: Rk9CoordActorOptions = {}): RequestHandler {
  const boardHost = opts.boardHost ?? resolveRk9CoordBoardHost();
  const boardKeyIds = opts.boardKeyIds === undefined ? resolveRk9CoordBoardKeyIds() : opts.boardKeyIds;
  const findAgentRun = opts.findAgentRun ?? defaultFindAgentRun(db);
  return async (req, _res, next) => {
    try {
      const companyId = req.params.companyId;
      if (typeof companyId !== "string" || !isUuidLike(companyId)) {
        throw coordError(400, "rk9_coord_company_invalid", "companyId must be a UUID");
      }
      const principal = req.rk9CoordPrincipal;
      // RK9-616: reject implicit/anonymous callers BEFORE the company check,
      // because assertCompanyAccess lets the local_implicit board through.
      if (!principal && (req.actor.type === "none" || req.actor.source === "local_implicit")) {
        throw coordError(401, "rk9_coord_untrusted_principal", "Coord routes require an authenticated principal");
      }
      if (!principal) assertCompanyAccess(req, companyId);
      req.rk9CoordActor = await resolveRk9CoordActor({
        actor: req.actor,
        principal,
        companyId,
        method: req.method,
        actorHeader: req.header(RK9_COORD_ACTOR_HEADER) ?? undefined,
        boardHost,
        boardKeyIds,
        findAgentRun,
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function rk9CoordActorView(actor: Rk9CoordResolvedActor | null | undefined) {
  if (!actor) return null;
  return {
    kind: actor.kind,
    actorId: actor.actorId,
    host: actor.host,
    trust: actor.trust,
    canHoldHardGate: rk9CoordTrustCanHoldHardGate(actor.trust),
  };
}
// --- /RK9 Custom ---
