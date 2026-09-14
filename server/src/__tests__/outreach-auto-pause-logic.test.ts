import { describe, expect, it } from "vitest";
import {
  OUTREACH_AUTO_PAUSE_MIN_SAMPLE,
  OUTREACH_DELIVERY_ERROR_RATE_THRESHOLD,
  OUTREACH_HARD_BOUNCE_RATE_THRESHOLD,
  evaluateAutoPause,
  type OutreachAutoPauseWindowCounts,
} from "../services/outreach/auto-pause-logic.js";

const CLEAN: OutreachAutoPauseWindowCounts = {
  sentCount: 0,
  hardBounceCount: 0,
  complaintCount: 0,
  deliveryErrorCount: 0,
  deliveryAttemptCount: 0,
};

describe("evaluateAutoPause", () => {
  it("does not pause with no volume at all", () => {
    expect(evaluateAutoPause(CLEAN).shouldPause).toBe(false);
  });

  it("pauses on the AC's own scenario: 3 hard bounces out of 100 sent", () => {
    const decision = evaluateAutoPause({ ...CLEAN, sentCount: 100, hardBounceCount: 3 });
    expect(decision.shouldPause).toBe(true);
    expect(decision.reason).toBe("hard_bounce_rate");
    expect(decision.detail.hardBounceRate).toBeCloseTo(0.03);
  });

  it("does not pause at exactly the hard-bounce threshold (>2%, not >=2%)", () => {
    const decision = evaluateAutoPause({ ...CLEAN, sentCount: 100, hardBounceCount: 2 });
    expect(decision.shouldPause).toBe(false);
  });

  it("does not pause on a high hard-bounce rate below the minimum sample size", () => {
    const decision = evaluateAutoPause({ ...CLEAN, sentCount: OUTREACH_AUTO_PAUSE_MIN_SAMPLE - 1, hardBounceCount: 5 });
    expect(decision.shouldPause).toBe(false);
  });

  it("pauses on a single spam complaint regardless of volume", () => {
    const decision = evaluateAutoPause({ ...CLEAN, complaintCount: 1 });
    expect(decision.shouldPause).toBe(true);
    expect(decision.reason).toBe("spam_complaint");
  });

  it("checks spam complaint before the hard-bounce rate", () => {
    const decision = evaluateAutoPause({ ...CLEAN, sentCount: 100, hardBounceCount: 3, complaintCount: 1 });
    expect(decision.reason).toBe("spam_complaint");
  });

  it("pauses on a delivery-error rate above the threshold", () => {
    const decision = evaluateAutoPause({ ...CLEAN, deliveryAttemptCount: 100, deliveryErrorCount: 21 });
    expect(decision.shouldPause).toBe(true);
    expect(decision.reason).toBe("delivery_error_rate");
    expect(decision.detail.deliveryErrorRate).toBeCloseTo(0.21);
  });

  it("does not pause at exactly the delivery-error threshold (>20%, not >=20%)", () => {
    const decision = evaluateAutoPause({ ...CLEAN, deliveryAttemptCount: 100, deliveryErrorCount: 20 });
    expect(decision.shouldPause).toBe(false);
  });

  it("does not pause on a high delivery-error rate below the minimum sample size", () => {
    const decision = evaluateAutoPause({
      ...CLEAN,
      deliveryAttemptCount: OUTREACH_AUTO_PAUSE_MIN_SAMPLE - 1,
      deliveryErrorCount: OUTREACH_AUTO_PAUSE_MIN_SAMPLE - 1,
    });
    expect(decision.shouldPause).toBe(false);
  });

  it("checks the hard-bounce rate before the delivery-error rate", () => {
    const decision = evaluateAutoPause({
      ...CLEAN,
      sentCount: 100,
      hardBounceCount: 5,
      deliveryAttemptCount: 100,
      deliveryErrorCount: 50,
    });
    expect(decision.reason).toBe("hard_bounce_rate");
  });

  it("exposes its thresholds as named constants matching the AC", () => {
    expect(OUTREACH_HARD_BOUNCE_RATE_THRESHOLD).toBe(0.02);
    expect(OUTREACH_DELIVERY_ERROR_RATE_THRESHOLD).toBe(0.2);
  });
});
