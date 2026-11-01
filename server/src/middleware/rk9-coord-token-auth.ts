// --- RK9 Custom (RK9-623): coord token bearer resolution and global guard ---
//
// Contract: docs/implementation-notes/coord-identity.md ("Token lifecycle").
//
// 1. resolveRk9CoordBearer runs inside actorMiddleware (auth.ts) for every
//    bearer that starts with `rk9_coord_`, before the board-key and agent-key
//    lookups. On a match it sets `req.actor = { type: "none" }` and
//    `req.rk9CoordPrincipal`, so every upstream route sees an anonymous
//    caller and fails closed. On a miss the request is 401: a coord-shaped
//    bearer never falls through to the board, agent or anonymous paths (and
//    never keeps the implicit local-board actor of local_trusted mode).
// 2. rk9CoordTokenGuard is mounted right after actorMiddleware, before every
//    API router. A request that carries a coord principal and is not under
//    /api/companies/:companyId/rk9/coord/ gets 403 (deny by default).
import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { unauthorized } from "../errors.js";
import { isRk9CoordBearer, rk9CoordTokenService } from "../services/rk9-coord-tokens.js";
import type { Rk9CoordTokenPrincipal } from "./rk9-coord-actor.js";

export type Rk9CoordTokenResolver = (token: string) => Promise<Rk9CoordTokenPrincipal | null>;

export function defaultRk9CoordTokenResolver(db: Db): Rk9CoordTokenResolver {
  const service = rk9CoordTokenService(db);
  return (token) => service.resolve(token);
}

/**
 * Handle a coord bearer. Returns false when the token is not a coord token
 * (the caller continues with its normal paths). Returns true when it handled
 * the request: either the principal is set, or an Error is returned for
 * next(). Never throws for an unknown token.
 */
export async function resolveRk9CoordBearer(
  req: Request,
  token: string,
  resolver: Rk9CoordTokenResolver,
): Promise<{ handled: false } | { handled: true; error?: Error }> {
  if (!isRk9CoordBearer(token)) return { handled: false };
  const principal = await resolver(token);
  req.actor = { type: "none", source: "none" };
  if (!principal) {
    return { handled: true, error: unauthorized("Invalid, revoked or expired coord token") };
  }
  req.rk9CoordPrincipal = principal;
  return { handled: true };
}

/** Paths a coord token may reach: the coord router of some company. */
const COORD_ROUTE_PATH = /^\/api\/companies\/[^/]+\/rk9\/coord(?:\/|$)/;

export function isRk9CoordRoutePath(path: string): boolean {
  return COORD_ROUTE_PATH.test(path);
}

/** Deny-by-default guard for coord-token callers on non-coord routes. */
export function rk9CoordTokenGuard(): RequestHandler {
  return (req, res, next) => {
    if (!req.rk9CoordPrincipal) {
      next();
      return;
    }
    // originalUrl keeps the full path even under a mounted sub-app; strip the
    // query. Express matches routes case-insensitively, this check does not,
    // so a case variant is denied rather than let through.
    const path = (req.originalUrl ?? req.url).split("?", 1)[0] ?? "";
    if (isRk9CoordRoutePath(path)) {
      next();
      return;
    }
    res.status(403).json({
      error: "A coord token may only call /api/companies/:companyId/rk9/coord/* routes",
      code: "rk9_coord_token_route_forbidden",
    });
  };
}
// --- /RK9 Custom ---
