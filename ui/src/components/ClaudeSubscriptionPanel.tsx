import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuotaWindow } from "@paperclipai/shared";
import { cn, quotaSourceDisplayName } from "@/lib/utils";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";

interface ClaudeSubscriptionPanelProps {
  windows: QuotaWindow[];
  source?: string | null;
  error?: string | null;
}

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

const WINDOW_ORDER = [
  "currentsession",
  "currentweekallmodels",
  "currentweeksonnetonly",
  "currentweeksonnet",
  "currentweekopusonly",
  "currentweekopus",
  "extrausage",
] as const;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function detailText(window: QuotaWindow): string | null {
  if (typeof window.detail === "string" && window.detail.trim().length > 0) return window.detail.trim();
  if (window.resetsAt) {
    const formatted = new Date(window.resetsAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `Resets ${formatted}`;
  }
  return null;
}

function orderedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const aIndex = WINDOW_ORDER.indexOf(normalizeLabel(a.label) as (typeof WINDOW_ORDER)[number]);
    const bIndex = WINDOW_ORDER.indexOf(normalizeLabel(b.label) as (typeof WINDOW_ORDER)[number]);
    return (aIndex === -1 ? WINDOW_ORDER.length : aIndex) - (bIndex === -1 ? WINDOW_ORDER.length : bIndex);
  });
}

function fillClass(usedPercent: number | null): string {
  if (usedPercent == null) return "bg-zinc-700";
  if (usedPercent >= 90) return "bg-red-400";
  if (usedPercent >= 70) return "bg-amber-400";
  return "bg-primary/70";
}

export function ClaudeSubscriptionPanel({
  windows,
  source = null,
  error = null,
}: ClaudeSubscriptionPanelProps) {
  const ordered = orderedWindows(windows);
  const queryClient = useQueryClient();
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);

  const pauseStateQuery = useQuery({
    queryKey: queryKeys.instance.systemPause,
    queryFn: () => instanceSettingsApi.getSystemPauseState(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const pauseState = pauseStateQuery.data?.state ?? null;

  const pauseMutation = useMutation({
    mutationFn: (reason?: string) => instanceSettingsApi.pauseSystem(reason ? { reason } : {}),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.instance.systemPause, data);
    },
  });
  const resumeMutation = useMutation({
    mutationFn: () => instanceSettingsApi.resumeSystem(),
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.instance.systemPause, { state: null });
    },
  });

  const isPaused = pauseState != null;
  const isMutating = pauseMutation.isPending || resumeMutation.isPending;

  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Anthropic subscription
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Live Claude quota windows.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {source ? (
            <span className="border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {quotaSourceDisplayName(source)}
            </span>
          ) : null}
          {isPaused ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={isMutating}
              onClick={() => resumeMutation.mutate()}
            >
              {resumeMutation.isPending ? "Resuming…" : "Resume"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isMutating}
              onClick={() => setShowPauseConfirm(true)}
            >
              Pause
            </Button>
          )}
        </div>
      </div>

      {isPaused ? (
        <div className="mt-4 border border-red-500/40 bg-red-500/10 px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-red-700 dark:text-red-300">
                Paperclip is paused
              </div>
              <div className="mt-1 text-sm text-red-700/90 dark:text-red-200/90">
                {pauseState!.reason}
              </div>
              <div className="mt-1 text-xs text-red-700/80 dark:text-red-200/80">
                {pauseState!.source === "auto" ? "Automatic pause" : "Manual pause"}
                {pauseState!.pausedUntil
                  ? ` • Auto-resumes ${formatLocalTime(pauseState!.pausedUntil)}`
                  : " • Resumes manually"}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showPauseConfirm && !isPaused ? (
        <div className="mt-4 border border-border bg-muted/30 px-3 py-3">
          <div className="text-sm font-medium text-foreground">Pause all new agent runs?</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Active runs continue. New routine, scheduled, and manual runs are blocked until you Resume.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={pauseMutation.isPending}
              onClick={() => {
                pauseMutation.mutate(undefined, {
                  onSuccess: () => setShowPauseConfirm(false),
                });
              }}
            >
              {pauseMutation.isPending ? "Pausing…" : "Confirm pause"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pauseMutation.isPending}
              onClick={() => setShowPauseConfirm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        {ordered.map((window) => {
          const normalized = normalizeLabel(window.label);
          const detail = detailText(window);
          if (normalized === "extrausage") {
            return (
              <div
                key={window.label}
                className="border border-border px-3.5 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">{window.label}</div>
                  {window.valueLabel ? (
                    <div className="text-sm font-medium text-foreground">{window.valueLabel}</div>
                  ) : null}
                </div>
                {detail ? (
                  <div className="mt-2 text-sm text-muted-foreground">{detail}</div>
                ) : null}
              </div>
            );
          }

          const width = Math.min(100, Math.max(0, window.usedPercent ?? 0));
          return (
            <div
              key={window.label}
              className="border border-border px-3.5 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{window.label}</div>
                  {detail ? (
                    <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
                  ) : null}
                </div>
                {window.usedPercent != null ? (
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {window.usedPercent}% used
                  </div>
                ) : null}
              </div>

              <div className="mt-3 h-2 overflow-hidden bg-muted">
                <div
                  className={cn("h-full transition-[width] duration-200", fillClass(window.usedPercent))}
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
