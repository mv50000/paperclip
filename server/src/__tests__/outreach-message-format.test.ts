import { describe, expect, it } from "vitest";
import {
  buildRawEmail,
  buildReferences,
  buildUnsubscribeHeaders,
  generateMessageId,
  generateUnsubscribeToken,
} from "../services/outreach/message-format.js";

describe("generateUnsubscribeToken", () => {
  it("is URL-safe and unique per call", () => {
    const a = generateUnsubscribeToken();
    const b = generateUnsubscribeToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("generateMessageId", () => {
  it("is angle-bracketed and scoped to the sending domain", () => {
    const id = generateMessageId("saatavilla.fi");
    expect(id).toMatch(/^<[0-9a-f-]+@saatavilla\.fi>$/);
  });
});

describe("buildUnsubscribeHeaders", () => {
  it("builds a mailto + https List-Unsubscribe pair per RFC 8058", () => {
    const headers = buildUnsubscribeHeaders("saatavilla.fi", "https://paperclip.rk9.fi/", "tok123");
    expect(headers.listUnsubscribe).toBe("<mailto:unsub@saatavilla.fi>, <https://paperclip.rk9.fi/u/tok123>");
    expect(headers.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
  });

  it("strips a trailing slash from the base URL", () => {
    const headers = buildUnsubscribeHeaders("example.fi", "https://paperclip.rk9.fi///", "tok");
    expect(headers.listUnsubscribe).toContain("<https://paperclip.rk9.fi/u/tok>");
  });
});

describe("buildReferences", () => {
  it("threads a follow-up into the same conversation", () => {
    expect(buildReferences("<msg-1@x>", null)).toBe("<msg-1@x>");
    expect(buildReferences("<msg-2@x>", "<msg-1@x>")).toBe("<msg-1@x> <msg-2@x>");
    expect(buildReferences(null, null)).toBeUndefined();
    expect(buildReferences(undefined, undefined)).toBeUndefined();
  });
});

const UNSUB = { listUnsubscribe: "<mailto:unsub@x.fi>, <https://x.fi/u/tok>", listUnsubscribePost: "List-Unsubscribe=One-Click" };

describe("buildRawEmail", () => {
  it("builds a plain-text message with the required headers", () => {
    const raw = buildRawEmail({
      from: "outreach@x.fi",
      to: "prospect@example.fi",
      subject: "Hei",
      bodyText: "Terve!\nToinen rivi.",
      messageId: "<abc@x.fi>",
      unsubscribe: UNSUB,
      date: new Date("2026-01-13T08:00:00Z"),
    });
    expect(raw).toContain("From: outreach@x.fi");
    expect(raw).toContain("To: prospect@example.fi");
    expect(raw).toContain("Subject: Hei");
    expect(raw).toContain("Message-ID: <abc@x.fi>");
    expect(raw).toContain("List-Unsubscribe: <mailto:unsub@x.fi>, <https://x.fi/u/tok>");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(raw).not.toContain("multipart/alternative");
    expect(raw.endsWith("Terve!\nToinen rivi.")).toBe(true);
  });

  it("builds multipart/alternative when bodyHtml is present", () => {
    const raw = buildRawEmail({
      from: "outreach@x.fi",
      to: "prospect@example.fi",
      subject: "Hei",
      bodyText: "plain",
      bodyHtml: "<p>html</p>",
      messageId: "<abc@x.fi>",
      unsubscribe: UNSUB,
    });
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("plain");
    expect(raw).toContain("<p>html</p>");
  });

  it("threads a reply with In-Reply-To/References when given", () => {
    const raw = buildRawEmail({
      from: "outreach@x.fi",
      to: "prospect@example.fi",
      subject: "Re: Hei",
      bodyText: "seuranta",
      messageId: "<def@x.fi>",
      inReplyTo: "<abc@x.fi>",
      references: "<abc@x.fi>",
      unsubscribe: UNSUB,
    });
    expect(raw).toContain("In-Reply-To: <abc@x.fi>");
    expect(raw).toContain("References: <abc@x.fi>");
  });

  it("strips CRLF injection attempts from header values", () => {
    const raw = buildRawEmail({
      from: "outreach@x.fi",
      to: "prospect@example.fi",
      subject: "Hei\r\nBcc: attacker@evil.example",
      bodyText: "plain",
      messageId: "<abc@x.fi>",
      unsubscribe: UNSUB,
    });
    expect(raw).not.toMatch(/Subject: Hei\r\nBcc:/);
    expect(raw).toContain("Subject: Hei Bcc: attacker@evil.example");
  });

  it("never includes tracking pixels or image tags by construction", () => {
    const raw = buildRawEmail({
      from: "outreach@x.fi",
      to: "prospect@example.fi",
      subject: "Hei",
      bodyText: "plain",
      bodyHtml: "<p>hello</p>",
      messageId: "<abc@x.fi>",
      unsubscribe: UNSUB,
    });
    expect(raw).not.toContain("<img");
  });
});
