import { describe, expect, it } from "vitest";
import { classifyInbound } from "../services/email/junk-guard.js";

describe("classifyInbound — sender local part", () => {
  it.each([
    "noreply@example.com",
    "no-reply@example.com",
    "No-Reply@Example.com",
    "notifications@github.com",
    "notification@service.io",
    "bounce@mailer.example.com",
    "bounces+123@mailer.example.com",
    "mailer-daemon@example.com",
    "postmaster@example.com",
    "do-not-reply@bank.fi",
    "donotreply@bank.fi",
    "auto-reply@vendor.com",
    "newsletter@shop.fi",
    "updates@service.com",
    "alerts-system@monitoring.io",
    '"Instagram" <no-reply@mail.instagram.com>',
  ])("flags %s as automated", (from) => {
    expect(classifyInbound({ from }).automated).toBe(true);
  });

  it.each([
    "customer@example.com",
    "matti.meikalainen@gmail.com",
    "info@asiakasyritys.fi",
    // 'reply' alone is not a robot marker
    "reply@example.com",
    // local-part must MATCH the pattern, not merely contain it
    "arnold.newsletter.fan@example.com",
  ])("keeps %s as human", (from) => {
    expect(classifyInbound({ from }).automated).toBe(false);
  });
});

describe("classifyInbound — headers", () => {
  const from = "customer@example.com";

  it("flags Auto-Submitted other than 'no'", () => {
    expect(classifyInbound({ from, headers: { "auto-submitted": "auto-replied" } }).automated).toBe(true);
    expect(classifyInbound({ from, headers: { "Auto-Submitted": "auto-generated" } }).automated).toBe(true);
    expect(classifyInbound({ from, headers: { "auto-submitted": "no" } }).automated).toBe(false);
  });

  it("flags Precedence bulk/list/junk but not first-class", () => {
    expect(classifyInbound({ from, headers: { precedence: "bulk" } }).automated).toBe(true);
    expect(classifyInbound({ from, headers: { Precedence: "List" } }).automated).toBe(true);
    expect(classifyInbound({ from, headers: { precedence: "junk" } }).automated).toBe(true);
    expect(classifyInbound({ from, headers: { precedence: "first-class" } }).automated).toBe(false);
  });

  it("flags List-Unsubscribe / List-Id presence", () => {
    expect(
      classifyInbound({ from, headers: { "list-unsubscribe": "<mailto:u@x.com>" } }).automated,
    ).toBe(true);
    expect(classifyInbound({ from, headers: { "list-id": "<news.example.com>" } }).automated).toBe(true);
  });

  it("flags X-Auto-Response-Suppress (Exchange OOO etc.)", () => {
    expect(
      classifyInbound({ from, headers: { "x-auto-response-suppress": "All" } }).automated,
    ).toBe(true);
  });

  it("keeps plain human mail with threading headers", () => {
    expect(
      classifyInbound({
        from,
        headers: { "message-id": "<a@x>", "in-reply-to": "<b@y>" },
      }).automated,
    ).toBe(false);
  });

  it("classifies a real Instagram notification fixture as automated", () => {
    const result = classifyInbound({
      from: '"Instagram" <no-reply@mail.instagram.com>',
      headers: {
        "auto-submitted": "auto-generated",
        precedence: "bulk",
        "list-unsubscribe": "<https://instagram.com/unsub>, <mailto:unsub@mail.instagram.com>",
      },
    });
    expect(result.automated).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("catches marketing local-parts it cannot pattern-match via list headers", () => {
    // follow-suggestions@ / posts-recaps@ are not local-part-detectable by
    // design — bulk senders always carry List-Unsubscribe/Precedence.
    expect(
      classifyInbound({
        from: "follow-suggestions@mail.instagram.com",
        headers: { "list-unsubscribe": "unsub@mail.instagram.com" },
      }).automated,
    ).toBe(true);
    expect(classifyInbound({ from: "follow-suggestions@mail.instagram.com" }).automated).toBe(false);
  });
});
