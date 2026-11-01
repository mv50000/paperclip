// --- RK9 Custom (RK9-623): coord token management (epic RK9-620) ---
//
// Issue, rotate, revoke and list the per-host and per-service coord tokens.
// Contract: docs/implementation-notes/coord-identity.md ("Token lifecycle").
//
// The routes live at /api/companies/:companyId/rk9/coord-tokens, OUTSIDE the
// coord route prefix, so the global coord-token guard answers 403 to every
// coord token here: a coord token can never mint, rotate or revoke tokens.
// Only the operator may manage tokens: a signed-in instance-admin session or
// an instance-admin board key (on RK9_COORD_BOARD_KEY_IDS when that is set).
// The local_trusted implicit board is refused (RK9-616: being local never
// grants authority on the coord bus).
//
// The plaintext token appears exactly once, in the 201 body of issue and
// rotate, with Cache-Control: no-store. Activity rows carry ids and names only.
import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  isUuidLike,
  issueRk9CoordTokenSchema,
  rotateRk9CoordTokenSchema,
  type IssueRk9CoordToken,
  type RotateRk9CoordToken,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { resolveRk9CoordBoardKeyIds } from "../middleware/rk9-coord-actor.js";
import { logActivity } from "../services/activity-log.js";
import { rk9CoordTokenService, type Rk9CoordTokenView } from "../services/rk9-coord-tokens.js";
import { assertCompanyAccess } from "./authz.js";

export interface Rk9CoordTokenRouteOptions {
  /** Board-key ids allowed to manage tokens; null = any instance-admin key. */
  boardKeyIds?: readonly string[] | null;
}

function tokenError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

function parseExpiresAt(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const date = new Date(value);
  if (date.getTime() <= Date.now()) {
    throw tokenError(422, "rk9_coord_token_expiry_past", "expiresAt must be in the future");
  }
  return date;
}

export function rk9CoordTokenRoutes(db: Db, opts: Rk9CoordTokenRouteOptions = {}) {
  const router = Router();
  const tokens = rk9CoordTokenService(db);
  const boardKeyIds = opts.boardKeyIds === undefined ? resolveRk9CoordBoardKeyIds() : opts.boardKeyIds;

  /** Operator-only gate; returns the company id and the acting user id. */
  function authorize(req: Request): { companyId: string; userId: string } {
    const companyId = req.params.companyId;
    if (typeof companyId !== "string" || !isUuidLike(companyId)) {
      throw tokenError(400, "rk9_coord_company_invalid", "companyId must be a UUID");
    }
    const actor = req.actor;
    if (req.rk9CoordPrincipal || actor.type !== "board" || (actor.source !== "session" && actor.source !== "board_key")) {
      throw tokenError(401, "rk9_coord_untrusted_principal", "Coord token management requires the operator");
    }
    if (!actor.isInstanceAdmin || !actor.userId) {
      throw tokenError(403, "rk9_coord_untrusted_principal", "Only an instance admin may manage coord tokens");
    }
    if (
      actor.source === "board_key" &&
      boardKeyIds &&
      boardKeyIds.length > 0 &&
      (!actor.keyId || !boardKeyIds.includes(actor.keyId))
    ) {
      throw tokenError(403, "rk9_coord_board_key_not_allowed", "This board key may not manage coord tokens");
    }
    assertCompanyAccess(req, companyId);
    return { companyId, userId: actor.userId };
  }

  // Runs before validate() so an unauthorized caller learns nothing from body errors.
  const requireOperator: RequestHandler = (req, res, next) => {
    try {
      res.locals.rk9CoordTokenAuth = authorize(req);
      next();
    } catch (err) {
      next(err);
    }
  };

  function auth(res: Response): { companyId: string; userId: string } {
    return res.locals.rk9CoordTokenAuth as { companyId: string; userId: string };
  }

  function tokenIdParam(req: Request): string {
    const tokenId = req.params.tokenId;
    if (typeof tokenId !== "string" || !isUuidLike(tokenId)) {
      throw tokenError(400, "rk9_coord_token_id_invalid", "tokenId must be a UUID");
    }
    return tokenId;
  }

  async function audit(
    companyId: string,
    userId: string,
    action: "rk9_coord.token_issued" | "rk9_coord.token_rotated" | "rk9_coord.token_revoked",
    record: Rk9CoordTokenView,
  ) {
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action,
      entityType: "rk9_coord_token",
      entityId: record.id,
      details: {
        principalKind: record.principalKind,
        principalName: record.principalName,
        rotatedFromTokenId: record.rotatedFromTokenId,
        expiresAt: record.expiresAt,
      },
    });
  }

  function sendSecret(res: Response, body: unknown) {
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(body);
  }

  router.get("/companies/:companyId/rk9/coord-tokens", requireOperator, async (_req, res) => {
    const { companyId } = auth(res);
    res.json({ tokens: await tokens.list(companyId) });
  });

  router.post(
    "/companies/:companyId/rk9/coord-tokens",
    requireOperator,
    validate(issueRk9CoordTokenSchema),
    async (req, res) => {
    const { companyId, userId } = auth(res);
    const body = req.body as IssueRk9CoordToken;
    const issued = await tokens.issue({
      companyId,
      principalKind: body.principalKind,
      principalName: body.principalName,
      label: body.label ?? null,
      expiresAt: parseExpiresAt(body.expiresAt) ?? null,
      createdByUserId: userId,
    });
    await audit(companyId, userId, "rk9_coord.token_issued", issued.record);
    sendSecret(res, issued);
    },
  );

  router.post(
    "/companies/:companyId/rk9/coord-tokens/:tokenId/rotate",
    requireOperator,
    validate(rotateRk9CoordTokenSchema),
    async (req, res) => {
      const { companyId, userId } = auth(res);
      const tokenId = tokenIdParam(req);
      const body = req.body as RotateRk9CoordToken;
      const rotated = await tokens.rotate({
        companyId,
        tokenId,
        label: body.label,
        expiresAt: parseExpiresAt(body.expiresAt),
        createdByUserId: userId,
      });
      await audit(companyId, userId, "rk9_coord.token_revoked", rotated.revoked);
      await audit(companyId, userId, "rk9_coord.token_rotated", rotated.record);
      sendSecret(res, { token: rotated.token, record: rotated.record });
    },
  );

  router.post("/companies/:companyId/rk9/coord-tokens/:tokenId/revoke", requireOperator, async (req, res) => {
    const { companyId, userId } = auth(res);
    const tokenId = tokenIdParam(req);
    const record = await tokens.revoke({ companyId, tokenId });
    await audit(companyId, userId, "rk9_coord.token_revoked", record);
    res.json({ record });
  });

  return router;
}
// --- /RK9 Custom ---
