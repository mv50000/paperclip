import { describe, expect, it } from "vitest";
import {
  computeDeliverabilityRates,
  shouldAlert,
} from "../services/email/deliverability-monitor.js";
import { renderTemplate } from "../services/email/auto-reply.js";
import { DEFAULT_AUTO_REPLY_TEMPLATES } from "../services/email/default-templates.js";

describe("computeDeliverabilityRates", () => {
  it("returns zeros when no emails sent", () => {
    expect(computeDeliverabilityRates({ total: 0, bounced: 0, complained: 0 })).toEqual({
      bounceRate: 0,
      complaintRate: 0,
    });
  });

  it("computes rates correctly", () => {
    expect(computeDeliverabilityRates({ total: 100, bounced: 5, complained: 1 })).toEqual({
      bounceRate: 0.05,
      complaintRate: 0.01,
    });
  });

  it("handles all-bounce edge case", () => {
    expect(computeDeliverabilityRates({ total: 10, bounced: 10, complained: 0 })).toEqual({
      bounceRate: 1,
      complaintRate: 0,
    });
  });
});

describe("shouldAlert", () => {
  const thresholds = { minSample: 20, bounceThreshold: 0.05 };

  it("does NOT alert below the minimum sample size", () => {
    // 2 of 5 bounced = 40% but sample too small
    const r = shouldAlert(
      { total: 5, bounceRate: 0.4, complaintRate: 0 },
      thresholds,
    );
    expect(r).toEqual({ alert: false });
  });

  it("alerts when bounce rate exceeds threshold and sample is large enough", () => {
    const r = shouldAlert(
      { total: 100, bounceRate: 0.06, complaintRate: 0 },
      thresholds,
    );
    expect(r).toEqual({ alert: true, reason: "bounce" });
  });

  it("does NOT alert when bounce rate equals threshold (strict greater-than)", () => {
    const r = shouldAlert(
      { total: 100, bounceRate: 0.05, complaintRate: 0 },
      thresholds,
    );
    expect(r).toEqual({ alert: false });
  });

  it("alerts on complaint rate above the implicit threshold (1/5 of bounce)", () => {
    // Default complaintThreshold = 0.05 / 5 = 0.01
    const r = shouldAlert(
      { total: 100, bounceRate: 0, complaintRate: 0.02 },
      thresholds,
    );
    expect(r).toEqual({ alert: true, reason: "complaint" });
  });

  it("respects an explicit complaintThreshold override", () => {
    const r = shouldAlert(
      { total: 100, bounceRate: 0, complaintRate: 0.005 },
      { ...thresholds, complaintThreshold: 0.001 },
    );
    expect(r).toEqual({ alert: true, reason: "complaint" });
  });
});

describe("renderTemplate", () => {
  it("substitutes simple {{var}} placeholders", () => {
    expect(renderTemplate("Hei {{name}}!", { name: "Aski" })).toBe("Hei Aski!");
  });

  it("substitutes multiple occurrences and tolerates whitespace inside braces", () => {
    expect(
      renderTemplate("{{a}} and {{ a }} and {{ b }}.", { a: "X", b: "Y" }),
    ).toBe("X and X and Y.");
  });

  it("replaces missing variables with the empty string", () => {
    expect(renderTemplate("Hei {{name}}", {})).toBe("Hei ");
  });

  it("ignores expressions that don't match the variable pattern", () => {
    // Only [a-zA-Z0-9_] are valid; spaces inside the var name are not.
    expect(renderTemplate("{{first name}}", { "first name": "X" })).toBe("{{first name}}");
  });
});

describe("DEFAULT_AUTO_REPLY_TEMPLATES", () => {
  it("ships fi/sv/en for support, accounting, and generic", () => {
    const expected = new Set<string>();
    for (const key of ["auto_reply.support", "auto_reply.accounting", "auto_reply.generic"]) {
      for (const locale of ["fi", "sv", "en"]) {
        expected.add(`${key}:${locale}`);
      }
    }
    const got = new Set(DEFAULT_AUTO_REPLY_TEMPLATES.map((t) => `${t.key}:${t.locale}`));
    expect(got).toEqual(expected);
  });

  it("each template body has a body, and uses {{message_id}} for traceability", () => {
    for (const tpl of DEFAULT_AUTO_REPLY_TEMPLATES) {
      expect(tpl.bodyMdTpl.length).toBeGreaterThan(20);
      expect(tpl.bodyMdTpl).toContain("{{message_id}}");
    }
  });

  it("subjects are short and safe (no CRLF — outbound validator would reject)", () => {
    for (const tpl of DEFAULT_AUTO_REPLY_TEMPLATES) {
      expect(tpl.subjectTpl).not.toMatch(/[\r\n]/);
      expect(tpl.subjectTpl.length).toBeLessThan(120);
    }
  });
});
