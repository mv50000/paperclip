import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentMetricsService } from "../services/agent-metrics.js";
import { assertCompanyAccess } from "./authz.js";

export function agentMetricsRoutes(db: Db) {
  const router = Router();
  const svc = agentMetricsService(db);

  router.get("/companies/:companyId/metrics/agent-success-rate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const windowDays = svc.clampWindowDays(req.query.days);
    const report = await svc.agentSuccessRate(companyId, { windowDays });
    res.json(report);
  });

  return router;
}
