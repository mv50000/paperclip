import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { companies } from "@paperclipai/db";
import { subscribeAllLiveEvents } from "../live-events.js";
import { logger } from "../../middleware/logger.js";
import { createSlackClientService, type SlackClientService } from "./client.js";
import { createChannelResolver, type ChannelResolver, type ChannelTarget } from "./channel-resolver.js";
import {
  formatBudgetExceeded,
  formatAgentStatus,
  formatHeartbeatFailureBurst,
  type FormattedMessage,
} from "./formatters.js";

const HEARTBEAT_FAILURE_THRESHOLD = 3;
const HEARTBEAT_FAILURE_WINDOW_MS = 30 * 60 * 1000;
const DEBOUNCE_MS = 30 * 1000;

interface ConsecutiveFailureState {
  agentId: string;
  count: number;
  lastFailureAt: number;
  notifiedAt: number | null;
}

interface DispatchTarget {
  target: ChannelTarget;
  message: FormattedMessage;
}

export interface SlackEventForwarder {
  stop(): void;
}

export const __testing__ = {
  resetState() {
    failureCounters.clear();
    debounceCache.clear();
    companyNameCache.clear();
  },
};

const failureCounters = new Map<string, ConsecutiveFailureState>();
const debounceCache = new Map<string, number>();
const companyNameCache = new Map<string, { name: string; fetchedAt: number }>();
const COMPANY_NAME_CACHE_MS = 5 * 60 * 1000;

async function getCompanyName(db: Db, companyId: string): Promise<string> {
  const cached = companyNameCache.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < COMPANY_NAME_CACHE_MS) {
    return cached.name;
  }
  const row = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const name = row?.name ?? "Unknown company";
  companyNameCache.set(companyId, { name, fetchedAt: Date.now() });
  return name;
}

function debounceKey(companyId: string, kind: string, suffix = ""): string {
  return `${companyId}:${kind}:${suffix}`;
}

function shouldDebounce(key: string): boolean {
  const now = Date.now();
  const last = debounceCache.get(key);
  if (last && now - last < DEBOUNCE_MS) return true;
  debounceCache.set(key, now);
  return false;
}

function recordHeartbeatFailure(companyId: string, agentId: string): number {
  const key = `${companyId}:${agentId}`;
  const now = Date.now();
  const state = failureCounters.get(key);
  if (!state || now - state.lastFailureAt > HEARTBEAT_FAILURE_WINDOW_MS) {
    failureCounters.set(key, { agentId, count: 1, lastFailureAt: now, notifiedAt: null });
    return 1;
  }
  state.count += 1;
  state.lastFailureAt = now;
  return state.count;
}

function shouldNotifyHeartbeat(companyId: string, agentId: string, count: number): boolean {
  if (count < HEARTBEAT_FAILURE_THRESHOLD) return false;
  const key = `${companyId}:${agentId}`;
  const state = failureCounters.get(key);
  if (!state) return false;
  if (state.notifiedAt && Date.now() - state.notifiedAt < HEARTBEAT_FAILURE_WINDOW_MS) return false;
  state.notifiedAt = Date.now();
  return true;
}

function resetHeartbeatCounter(companyId: string, agentId: string) {
  failureCounters.delete(`${companyId}:${agentId}`);
}

export function classifyEvent(event: LiveEvent, companyName: string): DispatchTarget[] {
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "activity.logged": {
      const activityType = typeof payload.type === "string" ? payload.type : null;
      if (activityType === "budget.exceeded") {
        if (shouldDebounce(debounceKey(event.companyId, "budget.exceeded", String(payload.scopeId ?? "")))) {
          return [];
        }
        const message = formatBudgetExceeded(event, companyName);
        return [
          { target: "company", message },
          { target: "board", message },
        ];
      }
      return [];
    }

    case "agent.status": {
      const status = typeof payload.status === "string" ? payload.status : null;
      if (status === "terminated" || status === "error") {
        if (shouldDebounce(debounceKey(event.companyId, "agent.status", String(payload.agentId ?? "")))) {
          return [];
        }
        return [{ target: "company", message: formatAgentStatus(event, companyName) }];
      }
      return [];
    }

    case "heartbeat.run.status": {
      const status = typeof payload.status === "string" ? payload.status : null;
      const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
      if (!agentId) return [];
      if (status === "completed") {
        resetHeartbeatCounter(event.companyId, agentId);
        return [];
      }
      if (status === "failed" || status === "error" || status === "timed_out") {
        const count = recordHeartbeatFailure(event.companyId, agentId);
        if (!shouldNotifyHeartbeat(event.companyId, agentId, count)) return [];
        return [{ target: "company", message: formatHeartbeatFailureBurst(event, companyName, count) }];
      }
      return [];
    }

    default:
      return [];
  }
}

async function dispatch(
  client: SlackClientService,
  resolver: ChannelResolver,
  companyId: string,
  targets: DispatchTarget[],
) {
  for (const { target, message } of targets) {
    const channel = await resolver.resolve(companyId, target);
    if (!channel) continue;
    const result = await client.postMessage(companyId, {
      channel,
      blocks: message.blocks,
      text: message.text,
    });
    if (!result.ok && result.reason !== "integration_disabled") {
      logger.info({ companyId, target, channel, reason: result.reason }, "slack post skipped");
    }
  }
}

export function startSlackEventForwarder(db: Db): SlackEventForwarder {
  const client = createSlackClientService(db);
  const resolver = createChannelResolver(db);

  const unsubscribe = subscribeAllLiveEvents((event: LiveEvent) => {
    if (event.companyId === "*") return;
    void (async () => {
      try {
        const companyName = await getCompanyName(db, event.companyId);
        const targets = classifyEvent(event, companyName);
        if (targets.length === 0) return;
        await dispatch(client, resolver, event.companyId, targets);
      } catch (err) {
        logger.warn({ err, eventType: event.type, companyId: event.companyId }, "slack event forwarder failed");
      }
    })();
  });

  logger.info("slack event forwarder started");

  return {
    stop() {
      unsubscribe();
    },
  };
}
