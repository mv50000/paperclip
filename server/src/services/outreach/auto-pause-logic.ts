// RK9-197: pure auto-pause rule evaluation — no DB, no network. The DB
// orchestration (counting events/messages per sender identity, writing the
// pause row) lives in `auto-pause.ts`; this module only decides, given
// already-counted numbers, whether a sender identity should be paused.
//
// The three rules from the issue text, in the order they're checked:
//   1. >=1 spam complaint (rolling 7d)              -> pause, reason "spam_complaint"
//   2. hard bounce rate >2% (rolling 7d)             -> pause, reason "hard_bounce_rate"
//   3. SMTP 4xx delivery-error rate >20% (last 24h)  -> pause, reason "delivery_error_rate"
// A single spam complaint is checked first and unconditionally — one
// complaint is a compliance signal regardless of volume, unlike the two
// rate-based rules which need a minimum sample so a single early bounce out
// of one send doesn't read as a 100% rate.
import type { OutreachPauseReason } from "@paperclipai/shared";

/** >2% hard bounce rate over the rolling window pauses the identity. */
export const OUTREACH_HARD_BOUNCE_RATE_THRESHOLD = 0.02;
/** >20% SMTP 4xx rate over the delivery-error window pauses the identity. */
export const OUTREACH_DELIVERY_ERROR_RATE_THRESHOLD = 0.2;
/** Rolling window for the hard-bounce and spam-complaint rules. */
export const OUTREACH_AUTO_PAUSE_ROLLING_DAYS = 7;
/** Window for the 4xx delivery-error rule — shorter than the other two so a burst of transient rejects doesn't wait a week to matter (and doesn't get diluted by a week of otherwise-clean sends). */
export const OUTREACH_DELIVERY_ERROR_WINDOW_HOURS = 24;
/**
 * Neither rate rule fires below this many samples — otherwise 1 bounce out
 * of 1 send (100%) or 1 out of 3 (33%) would pause an identity that has
 * barely started sending. The AC's own test scenario (3 hard bounces / 100
 * sent = 3%) clears this floor comfortably.
 */
export const OUTREACH_AUTO_PAUSE_MIN_SAMPLE = 10;

export interface OutreachAutoPauseWindowCounts {
  /** Messages with status='sent' in the rolling window. */
  sentCount: number;
  /** `bounce_hard` events in the rolling window. */
  hardBounceCount: number;
  /** `complaint` events in the rolling window. */
  complaintCount: number;
  /** Messages that took at least one SMTP 4xx (retryable) rejection in the delivery-error window. */
  deliveryErrorCount: number;
  /** sentCount + deliveryErrorCount within the delivery-error window — the denominator for the 4xx rate (see auto-pause.ts for why this is an approximation). */
  deliveryAttemptCount: number;
}

export interface OutreachAutoPauseDecision {
  shouldPause: boolean;
  reason: OutreachPauseReason | null;
  /** Rule snapshot for operator triage — stored verbatim in `outreach_sender_pauses.detail`. */
  detail: Record<string, unknown>;
}

const NO_PAUSE: OutreachAutoPauseDecision = { shouldPause: false, reason: null, detail: {} };

export function evaluateAutoPause(counts: OutreachAutoPauseWindowCounts): OutreachAutoPauseDecision {
  if (counts.complaintCount >= 1) {
    return {
      shouldPause: true,
      reason: "spam_complaint",
      detail: { complaintCount: counts.complaintCount, windowDays: OUTREACH_AUTO_PAUSE_ROLLING_DAYS },
    };
  }

  if (counts.sentCount >= OUTREACH_AUTO_PAUSE_MIN_SAMPLE) {
    const hardBounceRate = counts.hardBounceCount / counts.sentCount;
    if (hardBounceRate > OUTREACH_HARD_BOUNCE_RATE_THRESHOLD) {
      return {
        shouldPause: true,
        reason: "hard_bounce_rate",
        detail: {
          hardBounceRate,
          hardBounceCount: counts.hardBounceCount,
          sentCount: counts.sentCount,
          thresholdRate: OUTREACH_HARD_BOUNCE_RATE_THRESHOLD,
          windowDays: OUTREACH_AUTO_PAUSE_ROLLING_DAYS,
        },
      };
    }
  }

  if (counts.deliveryAttemptCount >= OUTREACH_AUTO_PAUSE_MIN_SAMPLE) {
    const deliveryErrorRate = counts.deliveryErrorCount / counts.deliveryAttemptCount;
    if (deliveryErrorRate > OUTREACH_DELIVERY_ERROR_RATE_THRESHOLD) {
      return {
        shouldPause: true,
        reason: "delivery_error_rate",
        detail: {
          deliveryErrorRate,
          deliveryErrorCount: counts.deliveryErrorCount,
          deliveryAttemptCount: counts.deliveryAttemptCount,
          thresholdRate: OUTREACH_DELIVERY_ERROR_RATE_THRESHOLD,
          windowHours: OUTREACH_DELIVERY_ERROR_WINDOW_HOURS,
        },
      };
    }
  }

  return NO_PAUSE;
}
