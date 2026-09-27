import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import { defaultCreateValues } from "../components/agent-config-defaults";

export function buildNewAgentRuntimeConfig(input?: {
  heartbeatEnabled?: boolean;
  intervalSec?: number;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    heartbeat: {
      enabled: input?.heartbeatEnabled ?? defaultCreateValues.heartbeatEnabled,
      intervalSec: input?.intervalSec ?? defaultCreateValues.intervalSec,
      wakeOnDemand: true,
      // --- RK9 Custom (RK9-231, RK9-314): the fork idle gate covers upstream's
      // skipTimerWhenNoActionableWork and has a UI toggle; setting both would keep
      // skipping timer wakes after an operator turns skipWhenIdle off. ---
      skipWhenIdle: true,
      cooldownSec: 10,
      maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
    },
  };

  return config;
}
