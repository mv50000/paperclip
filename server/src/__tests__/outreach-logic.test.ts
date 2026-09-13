import { describe, expect, it } from "vitest";
import {
  applyEventToProspect,
  canApproveMessage,
  canTransitionMessage,
  classifyImport,
  isProspectContactable,
  normalizeEmail,
} from "../services/outreach/logic.js";

describe("outreach import classification", () => {
  it("accepts a 100-row batch and reports duplicates + suppressed rows by index", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      email: `contact${i}@example${i % 50}.fi`,
      orgName: `Org ${i}`,
    }));
    // Make row 7 a duplicate of row 3 and row 99 a duplicate of row 0.
    rows[7].email = rows[3].email;
    rows[99].email = rows[0].email;
    const existing = ["contact10@example10.fi", "CONTACT11@EXAMPLE11.FI"];
    const suppressed = ["contact20@example20.fi"];

    const result = classifyImport(rows, existing, suppressed);

    expect(result.accepted).toHaveLength(95);
    expect(result.rejected).toEqual([
      { index: 7, email: rows[3].email, reason: "duplicate_in_batch" },
      { index: 10, email: "contact10@example10.fi", reason: "duplicate_existing" },
      { index: 11, email: "contact11@example11.fi", reason: "duplicate_existing" },
      { index: 20, email: "contact20@example20.fi", reason: "suppressed" },
      { index: 99, email: rows[0].email, reason: "duplicate_in_batch" },
    ]);
    // First occurrence of a batch duplicate wins.
    expect(result.accepted.map((a) => a.index)).toContain(3);
    expect(result.accepted.map((a) => a.index)).toContain(0);
  });

  it("suppression beats every other rejection reason and is case-insensitive", () => {
    const rows = [{ email: "Opt.Out@Example.fi" }, { email: "opt.out@example.fi" }];
    const result = classifyImport(rows, ["opt.out@example.fi"], ["OPT.OUT@EXAMPLE.FI"]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["suppressed", "suppressed"]);
  });

  it("normalizes e-mails by trimming and lower-casing", () => {
    expect(normalizeEmail("  Foo@Bar.FI ")).toBe("foo@bar.fi");
  });
});

describe("outreach prospect state machine", () => {
  it("only approved and in_sequence prospects are contactable", () => {
    expect(isProspectContactable("new")).toBe(false);
    expect(isProspectContactable("approved")).toBe(true);
    expect(isProspectContactable("in_sequence")).toBe(true);
    for (const s of ["replied", "bounced", "unsubscribed", "suppressed"] as const) {
      expect(isProspectContactable(s)).toBe(false);
    }
  });

  it("opt-out and hard-bounce events move the prospect to a terminal state and suppress globally", () => {
    expect(applyEventToProspect("in_sequence", "unsubscribe")).toEqual({
      prospectStatus: "unsubscribed",
      suppress: "unsubscribe",
    });
    expect(applyEventToProspect("approved", "complaint")).toEqual({
      prospectStatus: "unsubscribed",
      suppress: "complaint",
    });
    expect(applyEventToProspect("in_sequence", "bounce_hard")).toEqual({
      prospectStatus: "bounced",
      suppress: "bounce_hard",
    });
  });

  it("reply marks replied without suppression; soft bounce and dsn are informational", () => {
    expect(applyEventToProspect("in_sequence", "reply")).toEqual({ prospectStatus: "replied", suppress: null });
    expect(applyEventToProspect("in_sequence", "bounce_soft")).toEqual({ prospectStatus: null, suppress: null });
    expect(applyEventToProspect("in_sequence", "dsn")).toEqual({ prospectStatus: null, suppress: null });
  });

  it("terminal states are sticky: a reply after unsubscribe does not resurrect the prospect", () => {
    expect(applyEventToProspect("unsubscribed", "reply")).toEqual({ prospectStatus: null, suppress: null });
    // …but an opt-out on a bounced prospect still lands on the suppression list.
    expect(applyEventToProspect("bounced", "unsubscribe")).toEqual({ prospectStatus: null, suppress: "unsubscribe" });
  });
});

describe("outreach message state machine", () => {
  it("allows only the documented transitions", () => {
    expect(canTransitionMessage("draft", "approved")).toBe(true);
    expect(canTransitionMessage("draft", "rejected")).toBe(true);
    expect(canTransitionMessage("approved", "queued")).toBe(true);
    expect(canTransitionMessage("approved", "rejected")).toBe(true);
    expect(canTransitionMessage("queued", "sent")).toBe(true);
    expect(canTransitionMessage("queued", "failed")).toBe(true);
    expect(canTransitionMessage("failed", "queued")).toBe(true);
    expect(canTransitionMessage("draft", "sent")).toBe(false);
    expect(canTransitionMessage("sent", "draft")).toBe(false);
    expect(canTransitionMessage("rejected", "approved")).toBe(false);
    expect(canTransitionMessage("approved", "approved")).toBe(false);
  });

  it("refuses approval when the prospect is no longer contactable", () => {
    expect(canApproveMessage("draft", "approved")).toEqual({ ok: true });
    expect(canApproveMessage("draft", "unsubscribed")).toEqual({ ok: false, reason: "prospect_not_contactable" });
    expect(canApproveMessage("draft", "new")).toEqual({ ok: false, reason: "prospect_not_contactable" });
    expect(canApproveMessage("sent", "approved")).toEqual({ ok: false, reason: "invalid_transition" });
  });
});
