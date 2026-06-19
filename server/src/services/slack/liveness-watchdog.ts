import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { isHumanProxyAgent } from "../human-proxy.js";
import { logger } from "../../middleware/logger.js";
import { createSlackClientService } from "./client.js";
import { createChannelResolver, type ChannelTarget } from "./channel-resolver.js";
import { formatAgentLivenessStale, type FormattedMessage } from "./formatters.js";

// Pull-based agent liveness watchdog (RK9-43). Complements — does NOT replace — the
// event-driven slack forwarder (event-forwarder.ts). The forwarder only sees events an
// agent actively emits; if a fleet "dies" so that agents stop being *scheduled* at all
// (the heartbeat scheduler enqueues a `skipped` wakeup with no run and no event), the
// event path is structurally blind. This watchdog periodically pulls the agents table and
// flags any agent that *should* be ticking on a timer but whose last_heartbeat_at is older
// than thresholdMultiplier × its heartbeat interval.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD_MULTIPLIER = 3;

// Statuses that mean the agent is intentionally not scheduled — silence is expected, so we
// never alert. Mirrors the heartbeat scheduler's own filter (heartbeat.ts tickTimers ~7623,
// enqueueWakeup ~6511). `error`/`idle`/`running` are deliberately NOT excluded: an agent
// that errored and stopped running is exactly what we want surfaced.
const NON_WATCHED_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

export interface HeartbeatPolicy {
  enabled: boolean;
  intervalSec: number;
}

// Local re-implementation of the heartbeat service's private `parseHeartbeatPolicy` closure
// (heartbeat.ts ~3724). Re-implemented rather than exported to avoid importing the
// ~7700-line heartbeat module into the slack layer. Keep the two in sync: the policy lives in
// `agents.runtime_config.heartbeat` as { enabled: boolean (default false), intervalSec:
// number (default 0, clamped >= 0) }.
export function parseHeartbeatPolicy(runtimeConfig: unknown): HeartbeatPolicy {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
  };
}

// Should this agent be watched for liveness at all? Excludes human-proxy agents,
// intentionally-stopped statuses, heartbeat-disabled agents, and event-driven agents
// (no timer heartbeat, i.e. intervalSec <= 0 — e.g. Asiakaspalvelu). Company-pause is
// checked separately in the tick (it needs an async/cross-table lookup).
export function isWatchedAgent(agent: {
  status: string;
  adapterType: string;
  heartbeatEnabled: boolean;
  intervalSec: number;
}): boolean {
  if (isHumanProxyAgent(agent)) return false;
  if (NON_WATCHED_STATUSES.has(agent.status)) return false;
  // heartbeat-disabled or event-driven (no timer cadence) → not expected to tick.
  if (!agent.heartbeatEnabled || agent.intervalSec <= 0) return false;
  return true;
}

// Pure staleness check. Baseline is last_heartbeat_at, falling back to created_at for an
// agent that has never run — identical to the scheduler's baseline (heartbeat.ts ~7629) so a
// brand-new agent isn't flagged before its first interval elapses.
export function isOverdue(
  args: { lastHeartbeatAt: Date | null; createdAt: Date; intervalSec: number },
  now: Date,
  multiplier: number,
): boolean {
  if (args.intervalSec <= 0) return false;
  const baseline = (args.lastHeartbeatAt ?? args.createdAt).getTime();
  const ageMs = now.getTime() - baseline;
  const thresholdMs = args.intervalSec * 1000 * multiplier;
  return ageMs > thresholdMs;
}

export interface StaleState {
  notifiedAt: number | null;
}

// Once-per-episode debounce, mirroring the event-forwarder's notify-once mechanism
// (event-forwarder.ts:121-131). The first tick on which an agent is stale records
// `notifiedAt` and returns true; every later tick while still stale returns false (no
// repeat each tick). Operates on a caller-supplied map so it is trivially unit-testable.
export function shouldAlertStale(state: Map<string, StaleState>, key: string, now: number): boolean {
  const existing = state.get(key);
  if (existing && existing.notifiedAt) return false;
  state.set(key, { notifiedAt: now });
  return true;
}

// Re-arm: an agent that has run again (no longer overdue) — or is no longer watched —
// gets its debounce state cleared so the *next* genuine outage alerts again. This is the
// pull-equivalent of the forwarder's resetHeartbeatCounter on a "succeeded" run
// (event-forwarder.ts:133-135); here recovery is derived from last_heartbeat_at freshness.
export function clearStale(state: Map<string, StaleState>, key: string): void {
  state.delete(key);
}

// Module-level debounce state, lifetime = process (same as the event-forwarder's in-memory
// maps). A restart can re-emit at most one alert for an agent that is stale at boot, which
// matches the forwarder's identical in-memory behaviour.
const staleState = new Map<string, StaleState>();

export const __testing__ = {
  resetState() {
    staleState.clear();
  },
  staleState,
};

export interface AgentLivenessWatchdogHandle {
  stop(): void;
  /** Run one tick now (used by tests and on startup). */
  runNow(now?: Date): Promise<void>;
}

export function startAgentLivenessWatchdog(
  db: Db,
  opts: { intervalMs?: number; thresholdMultiplier?: number } = {},
): AgentLivenessWatchdogHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const multiplier = opts.thresholdMultiplier ?? DEFAULT_THRESHOLD_MULTIPLIER;
  const client = createSlackClientService(db);
  const resolver = createChannelResolver(db);
  let inFlight = false;

  async function dispatch(companyId: string, message: FormattedMessage): Promise<void> {
    // A silent agent is a company-wide reliability signal → company channel + #rk9-board,
    // reusing the dual-target pattern from budget.exceeded (event-forwarder.ts:153-156).
    const targets: ChannelTarget[] = ["company", "board"];
    for (const target of targets) {
      const channel = await resolver.resolve(companyId, target);
      if (!channel) continue;
      const result = await client.postMessage(companyId, {
        channel,
        blocks: message.blocks,
        text: message.text,
      });
      if (!result.ok && result.reason !== "integration_disabled") {
        logger.info({ companyId, target, channel, reason: result.reason }, "slack liveness alert post skipped");
      }
    }
  }

  async function tick(now = new Date()): Promise<void> {
    const allAgents = await db.select().from(agents);
    const companyRows = await db
      .select({
        id: companies.id,
        status: companies.status,
        name: companies.name,
        prefix: companies.issuePrefix,
      })
      .from(companies);
    const companyById = new Map(companyRows.map((row) => [row.id, row]));

    for (const agent of allAgents) {
      const key = `${agent.companyId}:${agent.id}`;
      const company = companyById.get(agent.companyId);
      const policy = parseHeartbeatPolicy(agent.runtimeConfig);
      const watched =
        // Fail safe: an agent whose company row is missing (shouldn't happen — FK-enforced)
        // is not watched, rather than alerting against an "Unknown company".
        company !== undefined &&
        company.status !== "paused" &&
        isWatchedAgent({
          status: agent.status,
          adapterType: agent.adapterType,
          heartbeatEnabled: policy.enabled,
          intervalSec: policy.intervalSec,
        });

      if (!watched) {
        clearStale(staleState, key);
        continue;
      }

      const overdue = isOverdue(
        { lastHeartbeatAt: agent.lastHeartbeatAt, createdAt: agent.createdAt, intervalSec: policy.intervalSec },
        now,
        multiplier,
      );
      if (!overdue) {
        // Ran recently / recovered → re-arm so a future outage alerts again.
        clearStale(staleState, key);
        continue;
      }

      if (!shouldAlertStale(staleState, key, now.getTime())) continue;

      const baseline = (agent.lastHeartbeatAt ?? agent.createdAt).getTime();
      const message = formatAgentLivenessStale({
        companyId: agent.companyId,
        companyName: company?.name ?? "Unknown company",
        companyPrefix: company?.prefix ?? null,
        agentName: agent.name,
        ageMs: now.getTime() - baseline,
        intervalSec: policy.intervalSec,
        thresholdMultiplier: multiplier,
      });
      logger.warn(
        { companyId: agent.companyId, agentId: agent.id, agentName: agent.name, intervalSec: policy.intervalSec },
        "agent liveness watchdog: stale heartbeat",
      );
      await dispatch(agent.companyId, message);
    }
  }

  async function safeTick(): Promise<void> {
    if (inFlight) return; // guard against overlapping ticks (mirrors riskMonitorInFlight)
    inFlight = true;
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, "agent liveness watchdog tick failed");
    } finally {
      inFlight = false;
    }
  }

  const interval = setInterval(() => {
    void safeTick();
  }, intervalMs);
  // Don't keep the process alive just for this timer.
  if (typeof interval.unref === "function") interval.unref();

  logger.info({ intervalMs, thresholdMultiplier: multiplier }, "agent liveness watchdog started");

  return {
    stop: () => clearInterval(interval),
    runNow: tick,
  };
}
