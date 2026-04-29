import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRuns,
  issues,
  issueRelations,
  riskEntries,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type { RiskCategoryCode, RiskIncidentSeverity, RiskLikelihood, RiskSeverity } from "@paperclipai/shared";
import { riskRegistryService, computeRiskScore } from "./risk-registry.js";
import { riskIncidentService } from "./risk-incidents.js";
import { PLAYBOOKS } from "./risk-playbooks.js";
import { logger } from "../middleware/logger.js";

export interface MonitorResult {
  monitor: string;
  risksCreated: number;
  risksResolved: number;
  incidentsCreated: number;
  errors: string[];
}

interface PolicyThresholds {
  silence_multiplier?: number;
  critical_multiplier?: number;
  crash_loop_threshold?: number;
  degraded_threshold?: number;
  min_sample?: number;
  lookback_hours?: number;
  anomaly_multiplier?: number;
  forecast_warn_percent?: number;
  runaway_multiplier?: number;
  absolute_floor_cents?: number;
  min_data_days?: number;
  orphan_grace_hours?: number;
  stale_days?: number;
  critical_stale_days?: number;
  approval_stale_days?: number;
  allowed_models?: string[];
  required_effort?: string;
}

function getThresholds(policy: { thresholdJson: Record<string, unknown> } | null): PolicyThresholds {
  return (policy?.thresholdJson ?? {}) as PolicyThresholds;
}

export function riskMonitorService(db: Db) {
  const registry = riskRegistryService(db);
  const incidents = riskIncidentService(db);

  async function shouldCheckIncident(
    companyId: string,
    categoryCode: RiskCategoryCode,
    severity: RiskSeverity,
    likelihood: RiskLikelihood,
  ): Promise<RiskIncidentSeverity | null> {
    const score = computeRiskScore(severity, likelihood);
    const policy = await registry.getPolicy(companyId, categoryCode);
    const escalationSev = policy?.escalationSev as RiskIncidentSeverity | undefined;

    if (score >= 15) return escalationSev ?? "sev1";
    if (score >= 9) return escalationSev ?? "sev2";
    if (score >= 5) return escalationSev ?? "sev3";
    return null;
  }

  async function maybeCreateIncident(
    companyId: string,
    categoryCode: RiskCategoryCode,
    riskEntryId: string,
    title: string,
    severity: RiskSeverity,
    likelihood: RiskLikelihood,
  ): Promise<boolean> {
    const incidentSev = await shouldCheckIncident(companyId, categoryCode, severity, likelihood);
    if (!incidentSev) return false;

    const [existing] = await incidents.findOpenByRiskEntryId(companyId, riskEntryId);
    if (existing) return false;

    await incidents.createIncident(companyId, {
      riskEntryId,
      title,
      severity: incidentSev,
      playbookCode: PLAYBOOKS[categoryCode] ? categoryCode : undefined,
    });
    return true;
  }

  async function resolveAndCleanup(
    companyId: string,
    categoryCode: RiskCategoryCode,
    scopeType: "agent" | "issue" | "company",
    scopeId: string,
  ): Promise<void> {
    const closedIds = await registry.resolveMonitorRisk(companyId, categoryCode, scopeType, scopeId);
    if (closedIds.length > 0) {
      await incidents.autoResolveByRiskEntryIds(companyId, closedIds);
    }
  }

  async function runAgentHealthMonitor(companyId: string): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "agent_health", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };
    const policy = await registry.getPolicy(companyId, "AGENT_SILENT");
    const t = getThresholds(policy);
    const silenceMultiplier = t.silence_multiplier ?? 3;
    const criticalMultiplier = t.critical_multiplier ?? 6;

    try {
      const activeAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
          lastHeartbeatAt: agents.lastHeartbeatAt,
          runtimeConfig: agents.runtimeConfig,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

      const agentsWithRoutines = await db
        .select({ agentId: routines.assigneeAgentId })
        .from(routines)
        .innerJoin(routineTriggers, eq(routineTriggers.routineId, routines.id))
        .where(and(
          eq(routines.companyId, companyId),
          eq(routines.status, "active"),
          eq(routineTriggers.enabled, true),
        ))
        .then((rows) => new Set(rows.map((r) => r.agentId)));

      for (const agent of activeAgents) {
        if (agent.status === "paused") continue;

        if (!agentsWithRoutines.has(agent.id)) {
          await resolveAndCleanup(companyId, "AGENT_SILENT", "agent", agent.id);
          continue;
        }

        const intervalSec = (agent.runtimeConfig as Record<string, unknown>)?.heartbeatIntervalSec as number ?? 3600;
        const lastRun = agent.lastHeartbeatAt;
        if (!lastRun) continue;

        const silenceMs = Date.now() - new Date(lastRun).getTime();
        const silenceHours = silenceMs / (1000 * 60 * 60);
        const expectedMs = intervalSec * 1000;

        if (silenceMs > expectedMs * silenceMultiplier) {
          const severity: RiskSeverity = silenceMs > expectedMs * criticalMultiplier ? "critical" : "high";
          const likelihood: RiskLikelihood = "certain";
          const entry = await registry.upsertMonitorRisk(
            companyId, "AGENT_SILENT", "agent", agent.id,
            { agentName: agent.name, lastRun: lastRun.toISOString(), silenceHours: Math.round(silenceHours), expectedIntervalSec: intervalSec },
            { severity, likelihood, title: `Silent agent: ${agent.name}` },
          );
          result.risksCreated++;

          if (await maybeCreateIncident(companyId, "AGENT_SILENT", entry.id, entry.title, severity, likelihood)) {
            result.incidentsCreated++;
          }
        } else {
          await resolveAndCleanup(companyId, "AGENT_SILENT", "agent", agent.id);
          result.risksResolved++;
        }
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runExecutionPatternAnalyzer(companyId: string): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "execution_pattern", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };
    const policy = await registry.getPolicy(companyId, "AGENT_CRASH_LOOP");
    const t = getThresholds(policy);
    const crashThreshold = t.crash_loop_threshold ?? 5;
    const lookbackHours = t.lookback_hours ?? 24;
    const degradedThreshold = t.degraded_threshold ?? 0.5;
    const minSample = t.min_sample ?? 4;

    try {
      const activeAgents = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

      const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

      for (const agent of activeAgents) {
        const recentRuns = await db
          .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agent.id),
            gte(heartbeatRuns.createdAt, cutoff),
          ))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(20);

        if (recentRuns.length < minSample) continue;

        let consecutiveFailures = 0;
        for (const run of recentRuns) {
          if (run.status === "failed" || run.status === "timed_out") consecutiveFailures++;
          else break;
        }

        if (consecutiveFailures >= crashThreshold) {
          const severity: RiskSeverity = "critical";
          const likelihood: RiskLikelihood = "certain";
          const entry = await registry.upsertMonitorRisk(
            companyId, "AGENT_CRASH_LOOP", "agent", agent.id,
            { agentName: agent.name, consecutiveFailures, lastErrors: recentRuns.slice(0, 3).map((r) => r.errorCode) },
            { severity, likelihood, title: `Crash loop: ${agent.name} (${consecutiveFailures} failures)` },
          );
          result.risksCreated++;

          if (await maybeCreateIncident(companyId, "AGENT_CRASH_LOOP", entry.id, entry.title, severity, likelihood)) {
            result.incidentsCreated++;
          }
        } else {
          await resolveAndCleanup(companyId, "AGENT_CRASH_LOOP", "agent", agent.id);

          const failureCount = recentRuns.filter((r) => r.status === "failed" || r.status === "timed_out").length;
          const failureRate = failureCount / recentRuns.length;

          if (failureRate > degradedThreshold) {
            await registry.upsertMonitorRisk(
              companyId, "AGENT_DEGRADED", "agent", agent.id,
              { agentName: agent.name, failureRate: Math.round(failureRate * 100), sampleSize: recentRuns.length },
              { severity: "medium", likelihood: "likely", title: `Degraded: ${agent.name} (${Math.round(failureRate * 100)}% failure rate)` },
            );
            result.risksCreated++;
          } else {
            await resolveAndCleanup(companyId, "AGENT_DEGRADED", "agent", agent.id);
            result.risksResolved++;
          }
        }
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runCostAnomalyDetector(companyId: string): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "cost_anomaly", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };
    const policy = await registry.getPolicy(companyId, "COST_ANOMALY");
    const t = getThresholds(policy);
    const anomalyMultiplier = t.anomaly_multiplier ?? 3.0;
    const minDataDays = t.min_data_days ?? 3;

    try {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

      const agentCosts = await db
        .select({
          agentId: costEvents.agentId,
          totalCents: sql<number>`sum(${costEvents.costCents})::int`,
        })
        .from(costEvents)
        .where(and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, sevenDaysAgo),
        ))
        .groupBy(costEvents.agentId);

      const todayCosts = await db
        .select({
          agentId: costEvents.agentId,
          totalCents: sql<number>`sum(${costEvents.costCents})::int`,
        })
        .from(costEvents)
        .where(and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, today),
        ))
        .groupBy(costEvents.agentId);

      const todayMap = new Map(todayCosts.map((c) => [c.agentId, c.totalCents]));
      const daysElapsed = Math.max(1, Math.ceil((now.getTime() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000)));

      if (daysElapsed < minDataDays) return result;

      for (const agentCost of agentCosts) {
        const dailyAvg = agentCost.totalCents / daysElapsed;
        const todaySpend = todayMap.get(agentCost.agentId) ?? 0;

        if (dailyAvg > 0 && todaySpend > dailyAvg * anomalyMultiplier) {
          const entry = await registry.upsertMonitorRisk(
            companyId, "COST_ANOMALY", "agent", agentCost.agentId,
            { dailyAvg7d: Math.round(dailyAvg), dailyActual: todaySpend, multiplier: Math.round((todaySpend / dailyAvg) * 10) / 10 },
            { severity: "high", likelihood: "certain", title: `Cost spike: agent spending ${Math.round(todaySpend / dailyAvg)}x average` },
          );
          result.risksCreated++;

          if (await maybeCreateIncident(companyId, "COST_ANOMALY", entry.id, entry.title, "high", "certain")) {
            result.incidentsCreated++;
          }
        } else {
          await resolveAndCleanup(companyId, "COST_ANOMALY", "agent", agentCost.agentId);
          result.risksResolved++;
        }
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runTaskRoutingValidator(companyId: string): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "task_routing", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };
    const policy = await registry.getPolicy(companyId, "TASK_ORPHANED");
    const t = getThresholds(policy);
    const graceHours = t.orphan_grace_hours ?? 4;

    try {
      const graceCutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000);

      const orphanedIssues = await db
        .select({ id: issues.id, title: issues.title, status: issues.status, createdAt: issues.createdAt })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.status, ["todo", "in_progress", "in_review"]),
          sql`${issues.assigneeAgentId} IS NULL`,
          sql`${issues.assigneeUserId} IS NULL`,
          lt(issues.createdAt, graceCutoff),
        ));

      for (const issue of orphanedIssues) {
        await registry.upsertMonitorRisk(
          companyId, "TASK_ORPHANED", "issue", issue.id,
          { title: issue.title, status: issue.status, ageHours: Math.round((Date.now() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60)) },
          { severity: "medium", likelihood: "certain", title: `Orphaned task: ${issue.title}` },
        );
        result.risksCreated++;
      }

      const deadAgentTasks = await db
        .select({ id: issues.id, title: issues.title, agentName: agents.name, agentStatus: agents.status })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.status, ["todo", "in_progress"]),
          inArray(agents.status, ["terminated", "paused"]),
        ));

      for (const task of deadAgentTasks) {
        await registry.upsertMonitorRisk(
          companyId, "TASK_UNASSIGNED", "issue", task.id,
          { title: task.title, agentName: task.agentName, agentStatus: task.agentStatus },
          { severity: "low", likelihood: "certain", title: `Task assigned to ${task.agentStatus} agent: ${task.title}` },
        );
        result.risksCreated++;
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runBlockerAgingDetector(companyId: string): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "blocker_aging", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };
    const policy = await registry.getPolicy(companyId, "BLOCKER_STALE");
    const t = getThresholds(policy);
    const staleDays = t.stale_days ?? 3;
    const approvalStaleDays = t.approval_stale_days ?? 2;

    try {
      const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

      const staleBlocked = await db
        .select({ id: issues.id, title: issues.title, updatedAt: issues.updatedAt })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.status, "blocked"),
          lt(issues.updatedAt, staleCutoff),
        ));

      for (const issue of staleBlocked) {
        const ageDays = Math.round((Date.now() - new Date(issue.updatedAt).getTime()) / (1000 * 60 * 60 * 24));
        await registry.upsertMonitorRisk(
          companyId, "BLOCKER_STALE", "issue", issue.id,
          { title: issue.title, staleDays: ageDays },
          { severity: ageDays > staleDays * 2 ? "high" : "medium", likelihood: "certain", title: `Stale blocker (${ageDays}d): ${issue.title}` },
        );
        result.risksCreated++;
      }

      const approvalCutoff = new Date(Date.now() - approvalStaleDays * 24 * 60 * 60 * 1000);
      const staleApprovals = await db
        .select({ id: approvals.id, type: approvals.type, createdAt: approvals.createdAt })
        .from(approvals)
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "pending"),
          lt(approvals.createdAt, approvalCutoff),
        ));

      for (const approval of staleApprovals) {
        const ageDays = Math.round((Date.now() - new Date(approval.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        await registry.upsertMonitorRisk(
          companyId, "APPROVAL_STALE", "approval", approval.id,
          { type: approval.type, ageDays },
          { severity: "medium", likelihood: "certain", title: `Stale approval (${ageDays}d): ${approval.type}` },
        );
        result.risksCreated++;
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runGovernanceDriftDetector(companyId: string): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "governance_drift", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };
    const policy = await registry.getPolicy(companyId, "MODEL_NONCOMPLIANT");
    const t = getThresholds(policy);
    const allowedModels = t.allowed_models ?? ["claude-opus-4-6", "claude-opus-4-7"];

    try {
      const activeAgents = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          reportsTo: agents.reportsTo,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

      for (const agent of activeAgents) {
        const config = agent.adapterConfig as Record<string, unknown>;
        const model = config?.model as string;

        if (model && !allowedModels.includes(model)) {
          await registry.upsertMonitorRisk(
            companyId, "MODEL_NONCOMPLIANT", "agent", agent.id,
            { agentName: agent.name, currentModel: model, allowedModels },
            { severity: "medium", likelihood: "certain", title: `Non-compliant model: ${agent.name} uses ${model}` },
          );
          result.risksCreated++;
        } else {
          await resolveAndCleanup(companyId, "MODEL_NONCOMPLIANT", "agent", agent.id);
          result.risksResolved++;
        }

        if (agent.role !== "ceo" && !agent.reportsTo) {
          await registry.upsertMonitorRisk(
            companyId, "ORG_ORPHAN", "agent", agent.id,
            { agentName: agent.name, role: agent.role },
            { severity: "low", likelihood: "certain", title: `Orphaned agent: ${agent.name} has no manager` },
          );
          result.risksCreated++;
        } else {
          await resolveAndCleanup(companyId, "ORG_ORPHAN", "agent", agent.id);
          result.risksResolved++;
        }
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runCrossCompanyCorrelator(): Promise<MonitorResult> {
    const result: MonitorResult = { monitor: "cross_company", risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [] };

    try {
      const recentWindow = new Date(Date.now() - 60 * 60 * 1000);

      const openRisksByCategory = await db
        .select({
          companyId: riskEntries.companyId,
          sourceMonitor: riskEntries.sourceMonitor,
          count: sql<number>`count(*)::int`,
        })
        .from(riskEntries)
        .where(and(
          inArray(riskEntries.status, ["open", "escalated"]),
          gte(riskEntries.lastEvaluated, recentWindow),
        ))
        .groupBy(riskEntries.companyId, riskEntries.sourceMonitor);

      const categoryCounts = new Map<string, string[]>();
      for (const row of openRisksByCategory) {
        if (!row.sourceMonitor) continue;
        const list = categoryCounts.get(row.sourceMonitor) ?? [];
        list.push(row.companyId);
        categoryCounts.set(row.sourceMonitor, list);
      }

      for (const [categoryCode, companyIds] of categoryCounts) {
        if (companyIds.length < 2) continue;

        for (const companyId of companyIds) {
          await registry.upsertMonitorRisk(
            companyId, "CROSS_COMPANY_PATTERN", "company", companyId,
            { pattern: categoryCode, affectedCompanies: companyIds.length },
            { severity: "high", likelihood: "likely", title: `Cross-company pattern: ${categoryCode} in ${companyIds.length} companies` },
          );
          result.risksCreated++;
        }
      }
    } catch (err) {
      result.errors.push(String(err));
    }
    return result;
  }

  async function runAllMonitors(companyId: string): Promise<MonitorResult[]> {
    await registry.ensureBuiltinCategories(companyId);

    const results = await Promise.allSettled([
      runAgentHealthMonitor(companyId),
      runExecutionPatternAnalyzer(companyId),
      runCostAnomalyDetector(companyId),
      runTaskRoutingValidator(companyId),
      runBlockerAgingDetector(companyId),
      runGovernanceDriftDetector(companyId),
    ]);

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const monitorNames = ["agent_health", "execution_pattern", "cost_anomaly", "task_routing", "blocker_aging", "governance_drift"];
      logger.error(`Risk monitor ${monitorNames[i]} failed:`, r.reason);
      return { monitor: monitorNames[i], risksCreated: 0, risksResolved: 0, incidentsCreated: 0, errors: [String(r.reason)] };
    });
  }

  return {
    runAgentHealthMonitor,
    runExecutionPatternAnalyzer,
    runCostAnomalyDetector,
    runTaskRoutingValidator,
    runBlockerAgingDetector,
    runGovernanceDriftDetector,
    runCrossCompanyCorrelator,
    runAllMonitors,
  };
}
