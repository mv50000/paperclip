import { cn } from "../lib/utils";
import {
  statusBadge,
  statusBadgeDefault,
  agentStatusColor,
  agentStatusColorDefault,
  agentStatusBadge,
  agentStatusCapsule,
  agentStatusMotion,
} from "../lib/status-colors";

export function StatusBadge({
  status,
  adapterType,
}: {
  status: string;
  adapterType?: string | null;
}) {
  // Human-proxy agents are assignment targets only; show the adapter identity
  // rather than the underlying status so operators see "Human proxy" instead of
  // a misleading idle/paused/error tag.
  if (adapterType === "human_proxy") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
          statusBadge.human_proxy,
        )}
      >
        Human proxy
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Agent status chip — brand `.task-chip` (1px border, light/dark variants).
 * Distinct from the shared {@link StatusBadge} so the agents section can carry
 * the brand state colours without affecting run/issue/goal badges. `active`
 * renders as "idle" (alias for dead code).
 */
export function AgentStatusBadge({
  status,
  adapterType,
}: {
  status: string;
  // --- RK9 Custom: human-proxy agents ---
  adapterType?: string | null;
}) {
  // --- RK9 Custom: human-proxy agents ---
  // Human-proxy agents are assignment targets only; show the adapter identity
  // rather than the underlying status so operators see "Human proxy" instead of
  // a misleading idle/paused/error tag.
  if (adapterType === "human_proxy") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0",
          statusBadge.human_proxy,
        )}
      >
        Human proxy
      </span>
    );
  }
  const color = agentStatusColor[status] ?? agentStatusColorDefault;
  const label = status === "active" ? "idle" : status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0",
        agentStatusBadge[color]
      )}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Agent status indicator — brand heartbeat capsule (vertical 8×16, r4). Running
 * agents pulse, broken (error) agents blink; both honor `prefers-reduced-motion`.
 */
export function AgentStatusCapsule({ status }: { status: string }) {
  const color = agentStatusColor[status] ?? agentStatusColorDefault;
  const motion = agentStatusMotion[status] ?? "";
  return (
    <span
      aria-hidden
      className={cn("inline-block h-4 w-2 rounded-[4px] shrink-0", agentStatusCapsule[color], motion)}
    />
  );
}
