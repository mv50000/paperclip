import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { riskRegistryService } from "../services/risk-registry.js";
import { riskIncidentService } from "../services/risk-incidents.js";
import { riskMonitorService } from "../services/risk-monitors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { RiskEntryStatus, RiskIncidentSeverity, RiskIncidentStatus, RiskSeverity, RiskScopeType } from "@paperclipai/shared";

export function riskRoutes(db: Db) {
  const router = Router();
  const registry = riskRegistryService(db);
  const incidents = riskIncidentService(db);
  const monitors = riskMonitorService(db);

  // --- Risk Entries ---

  router.get("/companies/:companyId/risks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const filters = {
      status: req.query.status as RiskEntryStatus | undefined,
      severity: req.query.severity as RiskSeverity | undefined,
      scopeType: req.query.scopeType as RiskScopeType | undefined,
      scopeId: req.query.scopeId as string | undefined,
    };
    const entries = await registry.listEntries(companyId, filters);
    res.json(entries);
  });

  router.get("/companies/:companyId/risks/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await registry.getSummary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/risks/categories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const categories = await registry.listCategories(companyId);
    res.json(categories);
  });

  router.get("/companies/:companyId/risks/:riskId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const entry = await registry.getEntry(companyId, req.params.riskId as string);
    res.json(entry);
  });

  router.patch("/companies/:companyId/risks/:riskId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const { status, mitigationJson } = req.body;
    const actor = getActorInfo(req);
    const updated = await registry.updateEntryStatus(companyId, req.params.riskId as string, status, {
      acceptedBy: actor.actorId,
      mitigationJson,
    });
    res.json(updated);
  });

  // --- Risk Policies ---

  router.get("/companies/:companyId/risk-policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policies = await registry.listPolicies(companyId);
    res.json(policies);
  });

  router.put("/companies/:companyId/risk-policies/:code", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const code = req.params.code as string;
    const policy = await registry.upsertPolicy(companyId, code, req.body);
    res.json(policy);
  });

  // --- Incidents ---

  router.get("/companies/:companyId/incidents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const filters = {
      status: req.query.status as RiskIncidentStatus | undefined,
      severity: req.query.severity as RiskIncidentSeverity | undefined,
    };
    const result = await incidents.listIncidents(companyId, filters);
    res.json(result);
  });

  router.get("/companies/:companyId/incidents/:incidentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const incident = await incidents.getIncident(companyId, req.params.incidentId as string);
    res.json(incident);
  });

  router.patch("/companies/:companyId/incidents/:incidentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const { action, resolutionNote } = req.body;
    const actor = getActorInfo(req);
    const incidentId = req.params.incidentId as string;

    if (action === "acknowledge") {
      const updated = await incidents.acknowledgeIncident(companyId, incidentId, actor.actorId);
      res.json(updated);
    } else if (action === "resolve") {
      const updated = await incidents.resolveIncident(companyId, incidentId, actor.actorId, resolutionNote ?? "");
      res.json(updated);
    } else {
      res.status(400).json({ error: "Invalid action. Use 'acknowledge' or 'resolve'" });
    }
  });

  router.post("/companies/:companyId/incidents/:incidentId/timeline", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const { action, detail } = req.body;
    const updated = await incidents.addTimelineEntry(
      companyId, req.params.incidentId as string, actor.actorId, action, detail,
    );
    res.json(updated);
  });

  // --- Monitor trigger (manual / system) ---

  router.post("/companies/:companyId/risks/monitor", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const results = await monitors.runAllMonitors(companyId);
    res.json({ results });
  });

  router.post("/companies/:companyId/risks/snapshot", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const snapshot = await registry.takeSnapshot(companyId);
    res.json(snapshot);
  });

  // --- Board-level cross-company ---

  router.get("/board/risks", async (req, res) => {
    assertBoard(req);
    const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
    const summaries = await Promise.all(
      allCompanies.map(async (c) => {
        const summary = await registry.getSummary(c.id);
        return { companyId: c.id, companyName: c.name, ...summary };
      }),
    );
    res.json(summaries);
  });

  router.post("/board/risks/monitor-all", async (req, res) => {
    assertBoard(req);
    const allCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
    const allResults = [];
    for (const c of allCompanies) {
      const results = await monitors.runAllMonitors(c.id);
      await registry.takeSnapshot(c.id);
      allResults.push({ companyId: c.id, results });
    }
    const crossCompany = await monitors.runCrossCompanyCorrelator();
    allResults.push({ companyId: "cross-company", results: [crossCompany] });
    res.json(allResults);
  });

  return router;
}
