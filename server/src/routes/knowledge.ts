import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { recallKnowledge } from "../services/knowledge-recall.js";
import { assertCompanyAccess, getActorInfo, isInstanceAdmin } from "./authz.js";

const recallSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().positive().max(50).optional(),
  // "all" = operator mode: search every collection (rk9 + shared + all <company>-docs). Only
  // honored for instance-admins; everyone else (agents, non-admin board) stays company-scoped.
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

      const result = await recallKnowledge(db, {
        query: req.body.query,
        companyId,
        limit: req.body.limit,
        allCollections,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      });

      res.json(result);
    },
  );

  return router;
}
