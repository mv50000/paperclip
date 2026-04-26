import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  riskCategories,
  riskEntries,
  riskIncidents,
  riskPolicies,
  riskSnapshots,
} from "@paperclipai/db";
import type {
  RiskCategoryCode,
  RiskDomain,
  RiskEntryStatus,
  RiskLikelihood,
  RiskScopeType,
  RiskSeverity,
  RiskSource,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";

type RiskEntryRow = typeof riskEntries.$inferSelect;
type RiskCategoryRow = typeof riskCategories.$inferSelect;

const SEVERITY_VALUES: Record<RiskSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const LIKELIHOOD_VALUES: Record<RiskLikelihood, number> = {
  rare: 1,
  unlikely: 2,
  possible: 3,
  likely: 4,
  certain: 5,
};

const DOMAIN_WEIGHTS: Record<RiskDomain, number> = {
  operational: 1.0,
  financial: 1.2,
  governance: 1.3,
  compliance: 1.5,
};

export interface RiskEntryFilters {
  status?: RiskEntryStatus;
  severity?: RiskSeverity;
  categoryCode?: string;
  scopeType?: RiskScopeType;
  scopeId?: string;
}

export function computeRiskScore(severity: RiskSeverity, likelihood: RiskLikelihood): number {
  return SEVERITY_VALUES[severity] * LIKELIHOOD_VALUES[likelihood];
}

export function riskRegistryService(db: Db) {

  async function ensureBuiltinCategories(companyId: string): Promise<void> {
    const existing = await db
      .select({ code: riskCategories.code })
      .from(riskCategories)
      .where(eq(riskCategories.companyId, companyId));
    const existingCodes = new Set(existing.map((r) => r.code));

    const missing = BUILTIN_CATEGORIES.filter((c) => !existingCodes.has(c.code));
    if (missing.length === 0) return;

    await db.insert(riskCategories).values(
      missing.map((c) => ({
        companyId,
        code: c.code,
        name: c.name,
        description: c.description,
        domain: c.domain,
        defaultSeverity: c.defaultSeverity,
        isBuiltin: true,
      })),
    );
  }

  async function getCategoryByCode(companyId: string, code: string): Promise<RiskCategoryRow | null> {
    const [row] = await db
      .select()
      .from(riskCategories)
      .where(and(eq(riskCategories.companyId, companyId), eq(riskCategories.code, code)))
      .limit(1);
    return row ?? null;
  }

  async function listEntries(companyId: string, filters?: RiskEntryFilters): Promise<RiskEntryRow[]> {
    const conditions = [eq(riskEntries.companyId, companyId)];
    if (filters?.status) conditions.push(eq(riskEntries.status, filters.status));
    if (filters?.severity) conditions.push(eq(riskEntries.severity, filters.severity));
    if (filters?.scopeType) conditions.push(eq(riskEntries.scopeType, filters.scopeType));
    if (filters?.scopeId) conditions.push(eq(riskEntries.scopeId, filters.scopeId));
    return db
      .select()
      .from(riskEntries)
      .where(and(...conditions))
      .orderBy(desc(riskEntries.riskScore), desc(riskEntries.detectedAt));
  }

  async function getEntry(companyId: string, riskId: string): Promise<RiskEntryRow> {
    const [row] = await db
      .select()
      .from(riskEntries)
      .where(and(eq(riskEntries.companyId, companyId), eq(riskEntries.id, riskId)))
      .limit(1);
    if (!row) throw notFound("Risk entry not found");
    return row;
  }

  async function upsertMonitorRisk(
    companyId: string,
    categoryCode: RiskCategoryCode,
    scopeType: RiskScopeType,
    scopeId: string,
    evidence: Record<string, unknown>,
    opts?: { severity?: RiskSeverity; likelihood?: RiskLikelihood; title?: string },
  ): Promise<RiskEntryRow> {
    await ensureBuiltinCategories(companyId);
    const category = await getCategoryByCode(companyId, categoryCode);
    if (!category) throw notFound(`Risk category ${categoryCode} not found`);

    const severity = opts?.severity ?? (category.defaultSeverity as RiskSeverity);
    const likelihood = opts?.likelihood ?? "possible";
    const score = computeRiskScore(severity, likelihood);
    const title = opts?.title ?? category.name;

    const [existing] = await db
      .select()
      .from(riskEntries)
      .where(
        and(
          eq(riskEntries.companyId, companyId),
          eq(riskEntries.categoryId, category.id),
          eq(riskEntries.scopeType, scopeType),
          eq(riskEntries.scopeId, scopeId),
          inArray(riskEntries.status, ["open", "escalated"]),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(riskEntries)
        .set({
          severity,
          likelihood,
          riskScore: score,
          evidenceJson: evidence,
          lastEvaluated: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(riskEntries.id, existing.id))
        .returning();
      publishLiveEvent({
        companyId,
        type: "risk.entry.updated",
        payload: { riskEntryId: updated.id, categoryCode, severity, score },
      });
      return updated;
    }

    const [created] = await db
      .insert(riskEntries)
      .values({
        companyId,
        categoryId: category.id,
        scopeType,
        scopeId,
        title,
        severity,
        likelihood,
        riskScore: score,
        source: "monitor" as RiskSource,
        sourceMonitor: categoryCode,
        evidenceJson: evidence,
      })
      .returning();

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "risk-monitor",
      action: "risk.entry.created",
      entityType: "risk_entry",
      entityId: created.id,
      details: { categoryCode, severity, likelihood, score, scopeType, scopeId },
    });

    publishLiveEvent({
      companyId,
      type: "risk.entry.created",
      payload: { riskEntryId: created.id, categoryCode, severity, score },
    });

    return created;
  }

  async function resolveMonitorRisk(
    companyId: string,
    categoryCode: RiskCategoryCode,
    scopeType: RiskScopeType,
    scopeId: string,
  ): Promise<void> {
    const category = await getCategoryByCode(companyId, categoryCode);
    if (!category) return;

    await db
      .update(riskEntries)
      .set({
        status: "closed" as RiskEntryStatus,
        mitigatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(riskEntries.companyId, companyId),
          eq(riskEntries.categoryId, category.id),
          eq(riskEntries.scopeType, scopeType),
          eq(riskEntries.scopeId, scopeId),
          inArray(riskEntries.status, ["open", "escalated"]),
        ),
      );
  }

  async function updateEntryStatus(
    companyId: string,
    riskId: string,
    status: RiskEntryStatus,
    opts?: { acceptedBy?: string; mitigationJson?: Record<string, unknown> },
  ): Promise<RiskEntryRow> {
    const entry = await getEntry(companyId, riskId);
    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === "accepted" && opts?.acceptedBy) {
      updates.acceptedBy = opts.acceptedBy;
      updates.acceptedAt = new Date();
    }
    if (status === "mitigated") {
      updates.mitigatedAt = new Date();
      if (opts?.mitigationJson) updates.mitigationJson = opts.mitigationJson;
    }

    const [updated] = await db
      .update(riskEntries)
      .set(updates)
      .where(eq(riskEntries.id, entry.id))
      .returning();

    publishLiveEvent({
      companyId,
      type: "risk.entry.updated",
      payload: { riskEntryId: updated.id, status },
    });

    return updated;
  }

  async function computeCompanyRiskScore(companyId: string): Promise<{
    overallScore: number;
    domainScores: Record<string, number>;
    openRisks: number;
  }> {
    const openEntries = await db
      .select({
        riskScore: riskEntries.riskScore,
        domain: riskCategories.domain,
      })
      .from(riskEntries)
      .innerJoin(riskCategories, eq(riskEntries.categoryId, riskCategories.id))
      .where(
        and(
          eq(riskEntries.companyId, companyId),
          inArray(riskEntries.status, ["open", "escalated"]),
        ),
      );

    const domainScores: Record<string, number> = {
      operational: 0,
      financial: 0,
      governance: 0,
      compliance: 0,
    };

    for (const entry of openEntries) {
      const domain = entry.domain as RiskDomain;
      domainScores[domain] = (domainScores[domain] ?? 0) + entry.riskScore;
    }

    let overallScore = 0;
    for (const [domain, score] of Object.entries(domainScores)) {
      overallScore += score * (DOMAIN_WEIGHTS[domain as RiskDomain] ?? 1.0);
    }
    overallScore = Math.min(Math.round(overallScore), 100);

    return { overallScore, domainScores, openRisks: openEntries.length };
  }

  async function takeSnapshot(companyId: string): Promise<typeof riskSnapshots.$inferSelect> {
    const { overallScore, domainScores, openRisks } = await computeCompanyRiskScore(companyId);

    const [openIncidentCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(riskIncidents)
      .where(
        and(
          eq(riskIncidents.companyId, companyId),
          inArray(riskIncidents.status, ["detected", "acknowledged", "investigating", "mitigating"]),
        ),
      );

    const [snapshot] = await db
      .insert(riskSnapshots)
      .values({
        companyId,
        snapshotAt: new Date(),
        overallScore,
        domainScores,
        openRisks,
        openIncidents: openIncidentCount?.count ?? 0,
      })
      .returning();

    return snapshot;
  }

  async function getPolicy(companyId: string, categoryCode: string) {
    const [row] = await db
      .select()
      .from(riskPolicies)
      .where(
        and(eq(riskPolicies.companyId, companyId), eq(riskPolicies.categoryCode, categoryCode)),
      )
      .limit(1);
    return row ?? null;
  }

  async function upsertPolicy(
    companyId: string,
    categoryCode: string,
    input: { enabled?: boolean; thresholdJson?: Record<string, unknown>; autoActions?: string[]; escalationSev?: string },
  ) {
    const existing = await getPolicy(companyId, categoryCode);
    if (existing) {
      const [updated] = await db
        .update(riskPolicies)
        .set({
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.thresholdJson && { thresholdJson: input.thresholdJson }),
          ...(input.autoActions && { autoActions: input.autoActions }),
          ...(input.escalationSev && { escalationSev: input.escalationSev }),
          updatedAt: new Date(),
        })
        .where(eq(riskPolicies.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(riskPolicies)
      .values({
        companyId,
        categoryCode,
        enabled: input.enabled ?? true,
        thresholdJson: input.thresholdJson ?? {},
        autoActions: input.autoActions,
        escalationSev: input.escalationSev,
      })
      .returning();
    return created;
  }

  async function listPolicies(companyId: string) {
    return db
      .select()
      .from(riskPolicies)
      .where(eq(riskPolicies.companyId, companyId));
  }

  async function listCategories(companyId: string) {
    return db
      .select()
      .from(riskCategories)
      .where(eq(riskCategories.companyId, companyId));
  }

  async function getSummary(companyId: string) {
    const { overallScore, domainScores, openRisks } = await computeCompanyRiskScore(companyId);

    const [openIncidentCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(riskIncidents)
      .where(
        and(
          eq(riskIncidents.companyId, companyId),
          inArray(riskIncidents.status, ["detected", "acknowledged", "investigating", "mitigating"]),
        ),
      );

    const recentSnapshots = await db
      .select()
      .from(riskSnapshots)
      .where(eq(riskSnapshots.companyId, companyId))
      .orderBy(desc(riskSnapshots.snapshotAt))
      .limit(30);

    const topRisks = await db
      .select()
      .from(riskEntries)
      .where(
        and(
          eq(riskEntries.companyId, companyId),
          inArray(riskEntries.status, ["open", "escalated"]),
        ),
      )
      .orderBy(desc(riskEntries.riskScore))
      .limit(5);

    return {
      overallScore,
      domainScores,
      openRisks,
      openIncidents: openIncidentCount?.count ?? 0,
      topRisks,
      trend: recentSnapshots.reverse(),
    };
  }

  return {
    ensureBuiltinCategories,
    getCategoryByCode,
    listCategories,
    listEntries,
    getEntry,
    upsertMonitorRisk,
    resolveMonitorRisk,
    updateEntryStatus,
    computeCompanyRiskScore,
    takeSnapshot,
    getPolicy,
    upsertPolicy,
    listPolicies,
    getSummary,
  };
}

const BUILTIN_CATEGORIES: Array<{
  code: RiskCategoryCode;
  name: string;
  description: string;
  domain: RiskDomain;
  defaultSeverity: RiskSeverity;
}> = [
  { code: "AGENT_SILENT", name: "Silent Agent", description: "Agent has not run within expected interval", domain: "operational", defaultSeverity: "high" },
  { code: "AGENT_CRASH_LOOP", name: "Agent Crash Loop", description: "Agent is failing repeatedly in consecutive runs", domain: "operational", defaultSeverity: "critical" },
  { code: "AGENT_DEGRADED", name: "Agent Degraded", description: "Agent has a high failure rate", domain: "operational", defaultSeverity: "medium" },
  { code: "COST_ANOMALY", name: "Cost Anomaly", description: "Agent spending rate is significantly above average", domain: "financial", defaultSeverity: "high" },
  { code: "COST_RUNAWAY", name: "Runaway Spending", description: "Company-level spending rate is dangerously high", domain: "financial", defaultSeverity: "critical" },
  { code: "BUDGET_FORECAST_BREACH", name: "Budget Forecast Breach", description: "Projected monthly spend will exceed budget", domain: "financial", defaultSeverity: "medium" },
  { code: "TASK_ORPHANED", name: "Orphaned Task", description: "Active task has no assignee", domain: "operational", defaultSeverity: "medium" },
  { code: "TASK_UNASSIGNED", name: "Unassigned Active Task", description: "Task assigned to terminated or paused agent", domain: "operational", defaultSeverity: "low" },
  { code: "BLOCKER_STALE", name: "Stale Blocker", description: "Blocked issue has not been updated recently", domain: "operational", defaultSeverity: "medium" },
  { code: "BLOCKER_CHAIN", name: "Blocker Chain", description: "Multiple issues are blocking each other", domain: "operational", defaultSeverity: "high" },
  { code: "APPROVAL_STALE", name: "Stale Approval", description: "Pending approval has not been acted on", domain: "governance", defaultSeverity: "medium" },
  { code: "COMPLIANCE_DRIFT", name: "Compliance Drift", description: "Company configuration has drifted from compliance requirements", domain: "compliance", defaultSeverity: "high" },
  { code: "MODEL_NONCOMPLIANT", name: "Model Non-Compliance", description: "Agent is running a non-approved model", domain: "governance", defaultSeverity: "medium" },
  { code: "SKILL_MISSING", name: "Missing Required Skill", description: "Company is missing a required skill", domain: "governance", defaultSeverity: "medium" },
  { code: "ORG_ORPHAN", name: "Orphaned Agent", description: "Agent has no reporting chain", domain: "governance", defaultSeverity: "low" },
  { code: "CROSS_COMPANY_PATTERN", name: "Cross-Company Pattern", description: "Same risk detected across multiple companies", domain: "operational", defaultSeverity: "high" },
];
