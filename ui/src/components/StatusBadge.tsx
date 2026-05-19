import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

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
