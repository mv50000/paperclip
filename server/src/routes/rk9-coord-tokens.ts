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
// A session must also be on RK9_COORD_OPERATOR_USER_IDS when that is set
// (RK9-638), the same pin that decides who is the coord `operator`.
// The local_trusted implicit board is refused (RK9-616: being local never
// grants authority on the coord bus).
//
// RK9-653: issue takes `scope` (coord | recall, default coord) and, for a
// recall token only, `recallAll` (operator opt-in for scope:"all" recall).
// Because only the operator reaches these routes, only an instance admin can
// set the flag. Rotate keeps both.
//
// The plaintext token appears exactly once, in the 201 body of issue and
// rotate, with Cache-Control: no-store. Activity rows carry ids and names only.
// The activity row is written in the same transaction as the token write
// (RK9-639): a failed audit rolls the token back, so a 500 never hides a
// token that exists, and a rotate never revokes the old token on its own.
// The live event is published after the commit, best effort.
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
import {
  resolveRk9CoordBoardKeyIds,
  resolveRk9CoordOperatorUserIds,
  rk9CoordOperatorUserAllowed,
} from "../middleware/rk9-coord-actor.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import {
  RK9_COORD_TOKEN_MIN_LIFETIME_MS,
  rk9CoordTokenService,
  type Rk9CoordTokenView,
} from "../services/rk9-coord-tokens.js";
import { assertCompanyAccess } from "./authz.js";

export interface Rk9CoordTokenRouteOptions {
  /** Board-key ids allowed to manage tokens; null = any instance-admin key. */
  boardKeyIds?: readonly string[] | null;
  /** Session user ids allowed to manage tokens; null = any instance admin. RK9-638. */
  operatorUserIds?: readonly string[] | null;
}

function tokenError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

function parseExpiresAt(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const date = new Date(value);
  const remainingMs = date.getTime() - Date.now();
  if (remainingMs <= 0) {
    throw tokenError(422, "rk9_coord_token_expiry_past", "expiresAt must be in the future");
  }
  if (remainingMs < RK9_COORD_TOKEN_MIN_LIFETIME_MS) {
    throw tokenError(422, "rk9_coord_token_expiry_too_soon", "expiresAt must be at least 60 s in the future");
  }
  return date;
}

export function rk9CoordTokenRoutes(db: Db, opts: Rk9CoordTokenRouteOptions = {}) {
  const router = Router();
  const tokens = rk9CoordTokenService(db);
  const boardKeyIds = opts.boardKeyIds === undefined ? resolveRk9CoordBoardKeyIds() : opts.boardKeyIds;
  const operatorUserIds =
    opts.operatorUserIds === undefined ? resolveRk9CoordOperatorUserIds() : opts.operatorUserIds;

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
    if (actor.source === "session" && !rk9CoordOperatorUserAllowed(actor.userId, operatorUserIds)) {
      throw tokenError(403, "rk9_coord_operator_not_allowed", "This user is not a configured coord operator");
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

  type AuditAction = "rk9_coord.token_issued" | "rk9_coord.token_rotated" | "rk9_coord.token_revoked";

  /** Writes the activity row on the token write's transaction; publishes after commit. */
  async function audit(
    tx: Db,
    publications: ActivityPublication[],
    companyId: string,
    userId: string,
    action: AuditAction,
    record: Rk9CoordTokenView,
  ) {
    await logActivity(
      tx,
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action,
        entityType: "rk9_coord_token",
        entityId: record.id,
        details: {
          principalKind: record.principalKind,
          principalName: record.principalName,
          scope: record.scope,
          recallAll: record.recallAll,
          rotatedFromTokenId: record.rotatedFromTokenId,
          expiresAt: record.expiresAt,
        },
      },
      publications,
    );
  }

  /**
   * The audit row has committed with the token. A failed live-event publish
   * must not turn into a 500, or the caller would lose the plaintext of a
   * token that exists.
   */
  function publishBestEffort(publications: ActivityPublication[]) {
    for (const publication of publications) {
      try {
        publishActivity(publication);
      } catch (err) {
        logger.error({ err, companyId: publication.companyId }, "failed to publish coord token activity event");
      }
    }
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
    const publications: ActivityPublication[] = [];
    const issued = await tokens.issue(
      {
        companyId,
        principalKind: body.principalKind,
        principalName: body.principalName,
        scope: body.scope ?? "coord",
        recallAll: body.recallAll === true,
        label: body.label ?? null,
        expiresAt: parseExpiresAt(body.expiresAt) ?? null,
        createdByUserId: userId,
      },
      (tx, result) => audit(tx, publications, companyId, userId, "rk9_coord.token_issued", result.record),
    );
    publishBestEffort(publications);
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
      const publications: ActivityPublication[] = [];
      const rotated = await tokens.rotate(
        {
          companyId,
          tokenId,
          label: body.label,
          expiresAt: parseExpiresAt(body.expiresAt),
          createdByUserId: userId,
        },
        async (tx, result) => {
          await audit(tx, publications, companyId, userId, "rk9_coord.token_revoked", result.revoked);
          await audit(tx, publications, companyId, userId, "rk9_coord.token_rotated", result.record);
        },
      );
      publishBestEffort(publications);
      sendSecret(res, { token: rotated.token, record: rotated.record });
    },
  );

  router.post("/companies/:companyId/rk9/coord-tokens/:tokenId/revoke", requireOperator, async (req, res) => {
    const { companyId, userId } = auth(res);
    const tokenId = tokenIdParam(req);
    const publications: ActivityPublication[] = [];
    const record = await tokens.revoke({ companyId, tokenId }, (tx, revoked) =>
      audit(tx, publications, companyId, userId, "rk9_coord.token_revoked", revoked),
    );
    publishBestEffort(publications);
    res.json({ record });
  });

  return router;
}
// --- /RK9 Custom ---
