// --- RK9 Custom (RK9-319) ---
import { ShieldAlert } from "lucide-react";
import type { HeartbeatRunTaint, HeartbeatRunTaintSourceKind } from "@paperclipai/shared";
import { cn } from "../lib/utils";

const SOURCE_LABELS: Record<HeartbeatRunTaintSourceKind, string> = {
  email_inbound_wake: "Woken by an inbound email",
  email_issue_context: "Works on an issue with inbound email",
  email_body_read: "Read an inbound email body",
  propagated_wake: "Woken by a tainted run",
  resumed_session: "Resumed a tainted session",
};

/**
 * Shows that the server marked this run as having received untrusted external
 * content. While the mark stands, the run's outward actions (email send/reply,
 * GitHub credentials, write-level tools) wait for board approval.
 */
export function RunTaintNotice({ taint, className }: { taint: HeartbeatRunTaint; className?: string }) {
  return (
    <div
      role="status"
      data-testid="run-taint-notice"
      className={cn(
        "rounded-md border px-3 py-2.5 text-sm shadow-sm",
        "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium leading-5">Untrusted content</p>
          <p className="leading-5">
            This run received untrusted external content. Its outward actions wait for board approval.
          </p>
          <ul className="space-y-0.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
            {taint.sources.map((source, index) => (
              <li key={`${source.kind}-${index}`} data-taint-kind={source.kind}>
                <span>{SOURCE_LABELS[source.kind] ?? source.kind}</span>
                <span className="text-muted-foreground"> · {new Date(source.at).toLocaleString()}</span>
                {source.issueId ? (
                  <span className="font-mono"> · issue {source.issueId.slice(0, 8)}</span>
                ) : null}
                {source.messageId ? (
                  <span className="font-mono"> · email {source.messageId.slice(0, 8)}</span>
                ) : null}
                {source.sourceRunId ? (
                  <span className="font-mono"> · run {source.sourceRunId.slice(0, 8)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
// --- /RK9 Custom ---
