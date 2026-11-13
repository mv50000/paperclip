// --- RK9 Custom (RK9-701): open fork heartbeat gates for upstream module tests ---
// The queue and scheduling modules take the fork gates as a required dependency.
// Upstream module tests do not exercise pause or the global cap, so they get gates
// that never block. Fork behaviour has its own tests (heartbeat-rk9-gates*.test.ts).
import { vi } from "vitest";
import type { Rk9HeartbeatGates } from "../../services/heartbeat/rk9-gates.js";

export function openRk9HeartbeatGates(overrides: Partial<Rk9HeartbeatGates> = {}): Rk9HeartbeatGates {
  return {
    systemPause: {
      isPaused: vi.fn(async () => false),
      getState: vi.fn(async () => null),
    },
    isCompanyPaused: vi.fn(async () => false),
    getGlobalMaxConcurrentRuns: vi.fn(async () => Number.MAX_SAFE_INTEGER),
    orderAgentsForResume: (agentIds: string[]) => agentIds,
    agentHasPendingTimerWork: vi.fn(async () => true),
    ...overrides,
  };
}
// --- /RK9 Custom ---
