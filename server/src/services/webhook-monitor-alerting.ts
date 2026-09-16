// Alert gating for scripts/check-github-webhook-health.ts.
//
// Lives here rather than inside the script so it can be unit tested: the script
// runs main() on import and exits the process, and this is the logic that
// decides whether a human gets pinged. RK9-226 — an unreadable hook bypassed the
// throttle entirely and posted 72 Slack alerts over three days.

export interface RepoHealthLike {
  repo: string;
  recentFailures: number;
  error: string | null;
}

/**
 * A repo the monitor could not query is *blind*, not *failing*. Conflating the
 * two made a 403 from the hooks API read as "webhook deliveries are failing",
 * which points every diagnosis at the wrong system.
 */
export function splitHealth<T extends RepoHealthLike>(unhealthy: T[]) {
  return {
    failing: unhealthy.filter((r) => !r.error && r.recentFailures > 0),
    blind: unhealthy.filter((r) => r.error !== null),
  };
}

export interface AlertState {
  repoAlertedAt: Record<string, string>;
  repoLastFailureCount: Record<string, number>;
  repoLastError: Record<string, string>;
}

export interface ThrottleOptions {
  throttleHours: number;
  failureGrowthThreshold: number;
}

/**
 * Split still-unhealthy repos into the ones worth alerting about now and the
 * ones the throttle silences.
 *
 * A repo alerts when any of these hold:
 *   - its state class changed (healthy → blind, blind → failing, or a different
 *     error message than the one last alerted);
 *   - it has never been alerted, or the last alert is older than throttleHours;
 *   - its failure count grew by failureGrowthThreshold× since the last alert.
 *
 * An unchanged error inside the window says nothing new, so it stays silent.
 */
export function selectAlertableRepos<T extends RepoHealthLike>(
  unhealthy: T[],
  state: AlertState,
  nowMs: number,
  opts: ThrottleOptions,
): { alertable: T[]; throttled: string[] } {
  const throttleCutoffMs = nowMs - opts.throttleHours * 3600 * 1000;
  const throttled: string[] = [];
  const alertable = unhealthy.filter((r) => {
    const lastError = state.repoLastError[r.repo] ?? "";
    if ((r.error ?? "") !== lastError) return true;
    const lastAtIso = state.repoAlertedAt[r.repo];
    if (!lastAtIso) return true;
    const lastAtMs = new Date(lastAtIso).getTime();
    if (Number.isNaN(lastAtMs) || lastAtMs < throttleCutoffMs) return true;
    if (r.error) {
      throttled.push(r.repo);
      return false;
    }
    const lastCount = state.repoLastFailureCount[r.repo] ?? 0;
    if (r.recentFailures >= lastCount * opts.failureGrowthThreshold) return true;
    throttled.push(r.repo);
    return false;
  });
  return { alertable, throttled };
}
