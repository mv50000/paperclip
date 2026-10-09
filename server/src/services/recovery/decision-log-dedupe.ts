// RK9-89 / RK9-367: per-issue dedupe for the stranded-issue decision log.
// Only `skipped_*` decisions are deduped: they repeat every sweep without changing anything.
// Every other decision is an action that happened (requeue, dispatch, escalation) and is
// always logged.

export const STRANDED_DECISION_LOG_INTERVAL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

type Entry = {
  fingerprint: string;
  decision: string;
  lastLoggedAt: number;
  lastSeenAt: number;
  suppressed: number;
};

export type DecisionLogVerdict = {
  log: boolean;
  /** Hits suppressed since the previous log line for the same issue, decision and fingerprint. */
  suppressedSinceLastLog: number;
  /** Suppressed hits of the previous decision, reported when the decision changes. */
  previousDecisionSuppressed?: { decision: string; count: number };
};

export function isDedupedDecision(decision: string) {
  return decision.startsWith("skipped_");
}

export function createDecisionLogDedupe(intervalMs = STRANDED_DECISION_LOG_INTERVAL_MS) {
  const state = new Map<string, Entry>();

  return {
    /**
     * `fingerprint` carries what must break the dedupe window besides the decision
     * (issue status, latest run id and status).
     */
    check(issueId: string, decision: string, fingerprint: string, nowMs = Date.now()): DecisionLogVerdict {
      if (!isDedupedDecision(decision)) {
        // An action ends the skip streak; drop the entry so the next skip logs immediately.
        const prevAction = state.get(issueId);
        state.delete(issueId);
        return {
          log: true,
          suppressedSinceLastLog: 0,
          ...(prevAction && prevAction.suppressed > 0
            ? { previousDecisionSuppressed: { decision: prevAction.decision, count: prevAction.suppressed } }
            : {}),
        };
      }

      const prev = state.get(issueId);
      const sameStreak = prev?.decision === decision && prev.fingerprint === fingerprint;
      if (prev && sameStreak && nowMs - prev.lastLoggedAt < intervalMs) {
        prev.suppressed += 1;
        prev.lastSeenAt = nowMs;
        return { log: false, suppressedSinceLastLog: 0 };
      }

      const verdict: DecisionLogVerdict = {
        log: true,
        suppressedSinceLastLog: prev && sameStreak ? prev.suppressed : 0,
        ...(prev && !sameStreak && prev.suppressed > 0
          ? { previousDecisionSuppressed: { decision: prev.decision, count: prev.suppressed } }
          : {}),
      };
      state.set(issueId, { fingerprint, decision, lastLoggedAt: nowMs, lastSeenAt: nowMs, suppressed: 0 });

      if (state.size > MAX_ENTRIES) {
        for (const [key, value] of state) {
          if (nowMs - value.lastSeenAt > 2 * intervalMs) state.delete(key);
        }
      }
      return verdict;
    },
    size: () => state.size,
  };
}
