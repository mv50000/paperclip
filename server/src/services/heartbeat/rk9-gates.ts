// --- RK9 Custom: fork heartbeat gates (RK9-701, doc/plans/2026-11-03-heartbeat-port-map.md) ---
// Upstream v2026.1023.0 split heartbeat.ts into modules. The fork's system pause, company
// pause, global run concurrency cap and idle timer skip used to live inside the one
// heartbeatService closure. They now live here, and heartbeatService passes one gate object
// to the queue and scheduling modules as a REQUIRED dependency. A required field keeps the
// type checker from letting a module silently run without the gates.
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { INSTANCE_DEFAULT_MAX_GLOBAL_CONCURRENT_RUNS } from "@paperclipai/shared";
import type { instanceSettingsService } from "../instance-settings.js";
import type { issueService } from "../issues.js";
import type { SystemPauseService } from "../system-pause.js";

const READ_ONLY_SYSTEM_PAUSE_CACHE_TTL_MS = 10_000;
const COMPANY_PAUSE_CACHE_TTL_MS = 10_000;
const GLOBAL_LIMIT_CACHE_TTL_MS = 10_000;

export type Rk9SystemPauseGate = Pick<SystemPauseService, "isPaused" | "getState">;

export function createReadOnlySystemPause(
  instanceSvc: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral">,
  cacheTtlMs: number = READ_ONLY_SYSTEM_PAUSE_CACHE_TTL_MS,
): Rk9SystemPauseGate {
  // Same 10 s cache as the owning service so every wake does not read instance_settings.
  let cache: { value: Awaited<ReturnType<SystemPauseService["getState"]>>; expiresAt: number } | null = null;
  const getState = async () => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.value;
    const value = (await instanceSvc.getGeneral()).systemPause ?? null;
    cache = { value, expiresAt: now + cacheTtlMs };
    return value;
  };
  return {
    getState,
    // Expired auto pauses count as resumed; clearing stays with the owning service.
    isPaused: async (now: Date = new Date()) => {
      const state = await getState();
      if (!state) return false;
      if (state.pausedUntil !== null && state.source === "auto") {
        const until = Date.parse(state.pausedUntil);
        if (!Number.isNaN(until) && now.getTime() > until) return false;
      }
      return true;
    },
  };
}

export interface Rk9HeartbeatGates {
  /** Instance-wide pause (RK9 system pause). Routes without the option get the read-only view. */
  systemPause: Rk9SystemPauseGate;
  /** `companies.status === "paused"`, cached 10 s. */
  isCompanyPaused(companyId: string): Promise<boolean>;
  /** Instance setting `maxGlobalConcurrentRuns`, cached 10 s. */
  getGlobalMaxConcurrentRuns(): Promise<number>;
  /** Rotates the agent order of resumeQueuedRuns so a low global cap is shared fairly. */
  orderAgentsForResume(agentIds: string[]): string[];
  /** RK9-231 idle check for timer wakes: true when the agent has actionable assigned work. */
  agentHasPendingTimerWork(companyId: string, agentId: string): Promise<boolean>;
}

export function createRk9HeartbeatGates(
  db: Db,
  input: {
    systemPause?: SystemPauseService;
    maxGlobalConcurrentRunsDefault?: number;
    instanceSettings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral">;
    issuesSvc: Pick<ReturnType<typeof issueService>, "list" | "listDependencyReadiness">;
  },
): Rk9HeartbeatGates {
  // Routes build their own heartbeat instances without the option; fall back to a
  // read-only view of instance_settings so system pause still gates them (RK9-356).
  const systemPause: Rk9SystemPauseGate = input.systemPause ?? createReadOnlySystemPause(input.instanceSettings);

  const companyPauseCache = new Map<string, { paused: boolean; expiresAt: number }>();
  async function isCompanyPaused(companyId: string): Promise<boolean> {
    const now = Date.now();
    const cached = companyPauseCache.get(companyId);
    if (cached && cached.expiresAt > now) return cached.paused;
    const row = await db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const paused = row?.status === "paused";
    companyPauseCache.set(companyId, { paused, expiresAt: now + COMPANY_PAUSE_CACHE_TTL_MS });
    return paused;
  }

  const maxGlobalDefault = input.maxGlobalConcurrentRunsDefault ?? INSTANCE_DEFAULT_MAX_GLOBAL_CONCURRENT_RUNS;
  let globalLimitCache: { value: number; expiresAt: number } | null = null;
  async function getGlobalMaxConcurrentRuns(): Promise<number> {
    const now = Date.now();
    if (globalLimitCache && globalLimitCache.expiresAt > now) return globalLimitCache.value;
    const general = await input.instanceSettings.getGeneral();
    const effective = general.maxGlobalConcurrentRuns ?? maxGlobalDefault;
    globalLimitCache = { value: effective, expiresAt: now + GLOBAL_LIMIT_CACHE_TTL_MS };
    return effective;
  }

  let resumeRoundRobinOffset = 0;
  function orderAgentsForResume(agentIds: string[]): string[] {
    if (agentIds.length === 0) return agentIds;
    const offset = resumeRoundRobinOffset % agentIds.length;
    resumeRoundRobinOffset = (resumeRoundRobinOffset + 1) % agentIds.length;
    return [...agentIds.slice(offset), ...agentIds.slice(0, offset)];
  }

  /**
   * Mirrors what `GET /api/agents/me/inbox-lite` would show a timer-woken agent:
   * assigned issues in todo/in_progress (plus routine executions), and blocked issues only
   * when their recorded blockers have resolved. A hand-blocked issue without a `blocks`
   * relation is not pending work: a human move wakes the agent through the ungated
   * status-change path (RK9-231).
   */
  async function agentHasPendingTimerWork(companyId: string, agentId: string): Promise<boolean> {
    const rows = await input.issuesSvc.list(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
      limit: 50,
    });
    if (rows.length === 0) return false;
    const actionable = rows.filter((issue) => issue.status !== "blocked");
    if (actionable.length > 0) return true;
    const readiness = await input.issuesSvc.listDependencyReadiness(
      companyId,
      rows.map((issue) => issue.id),
    );
    return rows.some((issue) => {
      const entry = readiness.get(issue.id);
      if (!entry || entry.blockerIssueIds.length === 0) return false;
      return entry.isDependencyReady;
    });
  }

  return {
    systemPause,
    isCompanyPaused,
    getGlobalMaxConcurrentRuns,
    orderAgentsForResume,
    agentHasPendingTimerWork,
  };
}
// --- /RK9 Custom ---
