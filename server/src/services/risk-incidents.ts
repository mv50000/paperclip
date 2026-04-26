import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issues, riskEntries, riskIncidents } from "@paperclipai/db";
import type { RiskIncidentSeverity, RiskIncidentStatus } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";
import { PLAYBOOKS, type Playbook } from "./risk-playbooks.js";
import { riskRegistryService } from "./risk-registry.js";

type IncidentRow = typeof riskIncidents.$inferSelect;

interface TimelineEntry {
  timestamp: string;
  actor: string;
  action: string;
  detail: string;
}

export function riskIncidentService(db: Db) {
  const registry = riskRegistryService(db);

  async function createIncident(
    companyId: string,
    input: {
      riskEntryId?: string;
      title: string;
      severity: RiskIncidentSeverity;
      playbookCode?: string;
    },
  ): Promise<IncidentRow> {
    const playbook = input.playbookCode
      ? PLAYBOOKS[input.playbookCode as keyof typeof PLAYBOOKS]
      : undefined;

    const timeline: TimelineEntry[] = [
      {
        timestamp: new Date().toISOString(),
        actor: "system",
        action: "detected",
        detail: `Risk incident created: ${input.title}`,
      },
    ];

    const [incident] = await db
      .insert(riskIncidents)
      .values({
        companyId,
        riskEntryId: input.riskEntryId ?? null,
        title: input.title,
        severity: input.severity,
        playbookCode: input.playbookCode ?? null,
        timelineJson: timeline as unknown as Record<string, unknown>[],
      })
      .returning();

    if (input.riskEntryId) {
      await registry.updateEntryStatus(companyId, input.riskEntryId, "escalated");
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "risk-engine",
      action: "risk.incident.created",
      entityType: "risk_incident",
      entityId: incident.id,
      details: { severity: input.severity, playbookCode: input.playbookCode, riskEntryId: input.riskEntryId },
    });

    publishLiveEvent({
      companyId,
      type: "risk.incident.created",
      payload: { incidentId: incident.id, severity: input.severity, title: input.title },
    });

    if (playbook) {
      await executeAutoActions(companyId, incident, playbook);
    }

    return incident;
  }

  async function executeAutoActions(
    companyId: string,
    incident: IncidentRow,
    playbook: Playbook,
  ): Promise<void> {
    const executedActions: Record<string, unknown>[] = [];

    for (const action of playbook.autoActions) {
      try {
        if (action.type === "pause_agent" && incident.riskEntryId) {
          const entry = await registry.getEntry(companyId, incident.riskEntryId);
          if (entry.scopeType === "agent") {
            await db
              .update(agents)
              .set({ status: "paused", pauseReason: "system", updatedAt: new Date() })
              .where(and(eq(agents.id, entry.scopeId), eq(agents.companyId, companyId)));
            executedActions.push({ type: "pause_agent", agentId: entry.scopeId, success: true });
          }
        }

        if (action.type === "reassign_tasks" && incident.riskEntryId) {
          const entry = await registry.getEntry(companyId, incident.riskEntryId);
          if (entry.scopeType === "agent") {
            await db
              .update(issues)
              .set({ status: "backlog", assigneeAgentId: null, updatedAt: new Date() })
              .where(
                and(
                  eq(issues.companyId, companyId),
                  eq(issues.assigneeAgentId, entry.scopeId),
                  inArray(issues.status, ["in_progress"]),
                ),
              );
            executedActions.push({ type: "reassign_tasks", agentId: entry.scopeId, success: true });
          }
        }

        if (action.type === "create_approval") {
          const [approval] = await db
            .insert(approvals)
            .values({
              companyId,
              type: "risk_incident_acknowledgment",
              status: "pending",
              payload: {
                incidentId: incident.id,
                incidentTitle: incident.title,
                severity: incident.severity,
                playbookCode: incident.playbookCode,
              },
            })
            .returning();
          await db
            .update(riskIncidents)
            .set({ approvalId: approval.id, updatedAt: new Date() })
            .where(eq(riskIncidents.id, incident.id));
          executedActions.push({ type: "create_approval", approvalId: approval.id, success: true });
        }
      } catch {
        executedActions.push({ type: action.type, success: false });
      }
    }

    if (executedActions.length > 0) {
      await db
        .update(riskIncidents)
        .set({ autoActions: executedActions, updatedAt: new Date() })
        .where(eq(riskIncidents.id, incident.id));
    }
  }

  async function acknowledgeIncident(
    companyId: string,
    incidentId: string,
    userId: string,
  ): Promise<IncidentRow> {
    const incident = await getIncident(companyId, incidentId);
    const timeline = (incident.timelineJson as unknown as TimelineEntry[]) ?? [];
    timeline.push({
      timestamp: new Date().toISOString(),
      actor: userId,
      action: "acknowledged",
      detail: "Incident acknowledged by operator",
    });

    const [updated] = await db
      .update(riskIncidents)
      .set({
        status: "acknowledged" as RiskIncidentStatus,
        acknowledgedAt: new Date(),
        timelineJson: timeline as unknown as Record<string, unknown>[],
        updatedAt: new Date(),
      })
      .where(eq(riskIncidents.id, incident.id))
      .returning();

    publishLiveEvent({
      companyId,
      type: "risk.incident.updated",
      payload: { incidentId: updated.id, status: "acknowledged" },
    });

    return updated;
  }

  async function resolveIncident(
    companyId: string,
    incidentId: string,
    userId: string,
    resolutionNote: string,
  ): Promise<IncidentRow> {
    const incident = await getIncident(companyId, incidentId);
    const timeline = (incident.timelineJson as unknown as TimelineEntry[]) ?? [];
    timeline.push({
      timestamp: new Date().toISOString(),
      actor: userId,
      action: "resolved",
      detail: resolutionNote,
    });

    const [updated] = await db
      .update(riskIncidents)
      .set({
        status: "resolved" as RiskIncidentStatus,
        resolvedAt: new Date(),
        resolutionNote,
        timelineJson: timeline as unknown as Record<string, unknown>[],
        updatedAt: new Date(),
      })
      .where(eq(riskIncidents.id, incident.id))
      .returning();

    if (incident.riskEntryId) {
      await registry.updateEntryStatus(companyId, incident.riskEntryId, "mitigated", {
        mitigationJson: { resolvedVia: "incident", incidentId, resolutionNote },
      });
    }

    publishLiveEvent({
      companyId,
      type: "risk.incident.updated",
      payload: { incidentId: updated.id, status: "resolved" },
    });

    return updated;
  }

  async function getIncident(companyId: string, incidentId: string): Promise<IncidentRow> {
    const [row] = await db
      .select()
      .from(riskIncidents)
      .where(and(eq(riskIncidents.companyId, companyId), eq(riskIncidents.id, incidentId)))
      .limit(1);
    if (!row) throw notFound("Risk incident not found");
    return row;
  }

  async function listIncidents(companyId: string, filters?: { status?: RiskIncidentStatus; severity?: RiskIncidentSeverity }) {
    const conditions = [eq(riskIncidents.companyId, companyId)];
    if (filters?.status) conditions.push(eq(riskIncidents.status, filters.status));
    if (filters?.severity) conditions.push(eq(riskIncidents.severity, filters.severity));
    return db
      .select()
      .from(riskIncidents)
      .where(and(...conditions))
      .orderBy(desc(riskIncidents.detectedAt));
  }

  async function listOpenIncidents(companyId: string) {
    return db
      .select()
      .from(riskIncidents)
      .where(
        and(
          eq(riskIncidents.companyId, companyId),
          inArray(riskIncidents.status, ["detected", "acknowledged", "investigating", "mitigating"]),
        ),
      )
      .orderBy(desc(riskIncidents.detectedAt));
  }

  async function addTimelineEntry(
    companyId: string,
    incidentId: string,
    actor: string,
    action: string,
    detail: string,
  ): Promise<IncidentRow> {
    const incident = await getIncident(companyId, incidentId);
    const timeline = (incident.timelineJson as unknown as TimelineEntry[]) ?? [];
    timeline.push({ timestamp: new Date().toISOString(), actor, action, detail });

    const [updated] = await db
      .update(riskIncidents)
      .set({
        timelineJson: timeline as unknown as Record<string, unknown>[],
        updatedAt: new Date(),
      })
      .where(eq(riskIncidents.id, incident.id))
      .returning();
    return updated;
  }

  return {
    createIncident,
    acknowledgeIncident,
    resolveIncident,
    getIncident,
    listIncidents,
    listOpenIncidents,
    addTimelineEntry,
  };
}
