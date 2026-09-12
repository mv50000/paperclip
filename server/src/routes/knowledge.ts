import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { recallKnowledge } from "../services/knowledge-recall.js";
import { assertCompanyAccess, getActorInfo, isInstanceAdmin } from "./authz.js";

const recallSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().positive().max(50).optional(),
  // "all" = operator mode: search every BUSINESS collection (rk9 + shared + all <company>-docs).
  // Only honored for instance-admins; everyone else (agents, non-admin board) stays
  // company-scoped. The operator's personal vault is excluded from both scopes by the service
  // (isPersonalCollection) — do NOT add a "personal" enum value here.
  scope: z.enum(["company", "all"]).optional(),
});

/**
 * Knowledge recall route (RK9-17 / C5).
 *
 * POST /api/companies/:companyId/knowledge/recall
 * Company-scoped semantic/keyword recall over the RK9 vault. The company is taken
 * from the path + enforced against the auth context; the recall service derives the
 * vault collection server-side, so a caller can never query another company — UNLESS
 * the caller is an instance-admin and asks for scope:"all" (operator cross-company recall).
 */
export function knowledgeRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/knowledge/recall",
    validate(recallSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      // Operator mode is gated to instance-admins; non-admins requesting "all" are silently
      // downgraded to company scope (never an error, never a cross-company leak for agents).
      const allCollections = req.body.scope === "all" && isInstanceAdmin(req);

      // A client that disconnects early (short --max-time, a caller-side timeout) must not
      // leave its qmd process running to completion as an untracked orphan (RK9-181) — cancel
      // the in-flight recall the same way a server-side timeout does.
      //
      // This MUST listen on `res`, not `req`: `req`'s "close" fires once the request stream
      // has been fully read (e.g. right after express.json() consumes the body) even on a
      // perfectly normal, still-connected request — it does not mean the client went away.
      // `res`'s "close" fires when the underlying connection closes, whether that's normal
      // completion (after we've already written the response, so the `!res.writableEnded`
      // guard below correctly skips aborting) or the client actually disconnecting early
      // (before we've written anything, so the guard lets the abort through). Verified against
      // this repo's Node/Express versions: a naive `req.on("close")` here aborted (and thus
      // killed the qmd process for) every single recall, including normal ones.
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);

      try {
        const result = await recallKnowledge(db, {
          query: req.body.query,
          companyId,
          limit: req.body.limit,
          allCollections,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          signal: controller.signal,
        });

        if (!res.writableEnded) res.json(result);
      } finally {
        res.off("close", onClose);
      }
    },
  );

  return router;
}
