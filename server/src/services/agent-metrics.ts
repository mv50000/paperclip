import { and, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { companyService } from "./companies.js";

const SUPPORTED_WINDOWS_DAYS = [7, 30] as const;
const DEFAULT_STALE_THRESHOLD_DAYS = 7;

export type AgentSuccessRateWindow = (typeof SUPPORTED_WINDOWS_DAYS)[number];

export interface AgentSuccessRateRow {
  agentId: string;
  agentName: string;
  role: string;
  status: string;
  done: number;
  cancelled: number;
  completed: number;
  successRate: number | null;
  stuckInProgress: number;
}

export interface AgentSuccessRateReport {
  companyId: string;
  windowDays: number;
  since: string;
  until: string;
  staleThresholdDays: number;
  agents: AgentSuccessRateRow[];
  totals: {
    done: number;
    cancelled: number;
    completed: number;
    successRate: number | null;
    stuckInProgress: number;
  };
}

function clampWindowDays(value: unknown): AgentSuccessRateWindow {
  const numeric = Number(value);
  if (SUPPORTED_WINDOWS_DAYS.includes(numeric as AgentSuccessRateWindow)) {
    return numeric as AgentSuccessRateWindow;
  }
  return 7;
}

function divideRate(success: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((success / total) * 10_000) / 10_000;
}

export function agentMetricsService(db: Db) {
  const companies = companyService(db);

  return {
    clampWindowDays,
    agentSuccessRate: async (
      companyId: string,
      options: { windowDays?: number; staleThresholdDays?: number; now?: Date } = {},
    ): Promise<AgentSuccessRateReport> => {
      const company = await companies.getById(companyId);
      if (!company) throw notFound("Company not found");

      const windowDays = clampWindowDays(options.windowDays ?? 7);
      const staleThresholdDays = options.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
      const now = options.now ?? new Date();
      const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const staleCutoff = new Date(now.getTime() - staleThresholdDays * 24 * 60 * 60 * 1000);

      const completedRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          done: sql<number>`count(*) filter (where ${issues.status} = 'done' and ${issues.completedAt} >= ${since})::int`,
          cancelled: sql<number>`count(*) filter (where ${issues.status} = 'cancelled' and ${issues.cancelledAt} >= ${since})::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            isNotNull(issues.assigneeAgentId),
            or(
              and(eq(issues.status, "done"), gte(issues.completedAt, since)),
              and(eq(issues.status, "cancelled"), gte(issues.cancelledAt, since)),
            ),
          ),
        )
        .groupBy(issues.assigneeAgentId);

      const stuckRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          stuckInProgress: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            isNotNull(issues.assigneeAgentId),
            eq(issues.status, "in_progress"),
            lt(issues.updatedAt, staleCutoff),
          ),
        )
        .groupBy(issues.assigneeAgentId);

      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const agentIndex = new Map(agentRows.map((row) => [row.id, row]));
      const stuckByAgent = new Map<string, number>();
      for (const row of stuckRows) {
        if (!row.agentId) continue;
        stuckByAgent.set(row.agentId, Number(row.stuckInProgress) || 0);
      }

      const rowByAgent = new Map<string, AgentSuccessRateRow>();
      for (const row of completedRows) {
        if (!row.agentId) continue;
        const meta = agentIndex.get(row.agentId);
        const done = Number(row.done) || 0;
        const cancelled = Number(row.cancelled) || 0;
        const completed = done + cancelled;
        rowByAgent.set(row.agentId, {
          agentId: row.agentId,
          agentName: meta?.name ?? "(deleted agent)",
          role: meta?.role ?? "unknown",
          status: meta?.status ?? "unknown",
          done,
          cancelled,
          completed,
          successRate: divideRate(done, completed),
          stuckInProgress: stuckByAgent.get(row.agentId) ?? 0,
        });
      }

      for (const [agentId, count] of stuckByAgent) {
        if (rowByAgent.has(agentId)) continue;
        const meta = agentIndex.get(agentId);
        rowByAgent.set(agentId, {
          agentId,
          agentName: meta?.name ?? "(deleted agent)",
          role: meta?.role ?? "unknown",
          status: meta?.status ?? "unknown",
          done: 0,
          cancelled: 0,
          completed: 0,
          successRate: null,
          stuckInProgress: count,
        });
      }

      const rows = Array.from(rowByAgent.values()).sort((a, b) => {
        if (b.completed !== a.completed) return b.completed - a.completed;
        return a.agentName.localeCompare(b.agentName);
      });

      const totalsDone = rows.reduce((sum, row) => sum + row.done, 0);
      const totalsCancelled = rows.reduce((sum, row) => sum + row.cancelled, 0);
      const totalsCompleted = totalsDone + totalsCancelled;
      const totalsStuck = rows.reduce((sum, row) => sum + row.stuckInProgress, 0);

      return {
        companyId,
        windowDays,
        since: since.toISOString(),
        until: now.toISOString(),
        staleThresholdDays,
        agents: rows,
        totals: {
          done: totalsDone,
          cancelled: totalsCancelled,
          completed: totalsCompleted,
          successRate: divideRate(totalsDone, totalsCompleted),
          stuckInProgress: totalsStuck,
        },
      };
    },
  };
}

export type AgentMetricsService = ReturnType<typeof agentMetricsService>;
