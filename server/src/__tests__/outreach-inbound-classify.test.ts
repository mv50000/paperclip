import { describe, expect, it } from "vitest";
import { parseInboundMime } from "../services/outreach/inbound-mime.js";
import {
  classifyDsnSeverity,
  classifyInboundOutreachMail,
  extractOriginalMessageId,
  hasUnsubscribeRecipient,
  isDeliveryStatusNotification,
  isSelfLoop,
  parseDeliveryStatusFields,
} from "../services/outreach/inbound-classify.js";

function raw(lines: string[]): Buffer {
  return Buffer.from(lines.join("\r\n"), "utf8");
}

const dsnFixture = (action: string, status: string) =>
  raw([
    "From: MAILER-DAEMON@outreach.rk9.fi",
    "To: outreach-saatavilla@outreach.rk9.fi",
    "Subject: Undelivered Mail Returned to Sender",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="AAA"',
    "MIME-Version: 1.0",
    "",
    "--AAA",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "This is the mail system. Delivery failed.",
    "",
    "--AAA",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mail.outreach.rk9.fi",
    "Arrival-Date: Mon, 1 Sep 2026 10:00:00 +0300",
    "",
    "Final-Recipient: rfc822; nosuch@example.com",
    `Action: ${action}`,
    `Status: ${status}`,
    "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
    "",
    "--AAA",
    "Content-Type: message/rfc822",
    "",
    "From: outreach-saatavilla@outreach.rk9.fi",
    "To: nosuch@example.com",
    "Subject: Hei",
    "Message-ID: <orig-test-1@outreach.rk9.fi>",
    "Date: Mon, 1 Sep 2026 09:59:00 +0300",
    "",
    "Original body",
    "",
    "--AAA--",
  ]);

describe("classifyInboundOutreachMail", () => {
  it("classifies a genuine reply", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Subject: Re: Hei",
        "In-Reply-To: <orig-1@outreach.rk9.fi>",
        "References: <orig-1@outreach.rk9.fi>",
        "Message-ID: <reply-1@example.com>",
        "",
        "Kiinnostaa, kertokaa lisaa.",
      ]),
    );
    expect(classifyInboundOutreachMail(parsed)).toBe("reply");
  });

  it("classifies an RFC 3834 auto-reply/OOO as auto_reply, never reply", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Subject: Automatic reply: Out of office",
        "Auto-Submitted: auto-replied",
        "Message-ID: <ooo-1@example.com>",
        "",
        "I am out of office.",
      ]),
    );
    expect(classifyInboundOutreachMail(parsed)).toBe("auto_reply");
  });

  it("classifies a message to unsub@ as unsubscribe even without threading headers", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: unsub@outreach.rk9.fi",
        "Subject: unsubscribe",
        "Message-ID: <unsub-1@example.com>",
        "",
        "stop",
      ]),
    );
    expect(classifyInboundOutreachMail(parsed)).toBe("unsubscribe");
  });

  it("classifies a multipart/report delivery-status message as dsn", async () => {
    const parsed = await parseInboundMime(dsnFixture("failed", "5.1.1"));
    expect(classifyInboundOutreachMail(parsed)).toBe("dsn");
  });

  it("drops a same-domain message as self_loop before any other check (mail-loop guard)", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: outreach-saatavilla@outreach.rk9.fi",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Subject: loop",
        "Message-ID: <loop-1@outreach.rk9.fi>",
        "",
        "loop body",
      ]),
    );
    expect(classifyInboundOutreachMail(parsed)).toBe("self_loop");
    // Sanity: a naive implementation might see this same message as a "reply" —
    // assert directly that isSelfLoop fires so the guard can't silently regress.
    expect(isSelfLoop(parsed.from, parsed.to)).toBe(true);
  });

  it("a real DSN is same-domain-both-sides by construction and must still classify as dsn, not self_loop", async () => {
    // Postfix bounces to the envelope sender, an address on our OWN domain —
    // From: mailer-daemon@outreach.rk9.fi, To: outreach-saatavilla@outreach.rk9.fi.
    // This is the exact shape that first exposed the self-loop-before-dsn bug.
    const parsed = await parseInboundMime(dsnFixture("failed", "5.1.1"));
    expect(parsed.from.endsWith("@outreach.rk9.fi")).toBe(true);
    expect(parsed.to.every((addr) => addr.endsWith("@outreach.rk9.fi"))).toBe(true);
    expect(classifyInboundOutreachMail(parsed)).toBe("dsn");
  });

  it("self-loop guard still catches a same-domain message that is not a DSN", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: outreach-saatavilla@outreach.rk9.fi",
        "To: unsub@outreach.rk9.fi",
        "Subject: loop-of-loop",
        "Message-ID: <loop-2@outreach.rk9.fi>",
        "",
        "body",
      ]),
    );
    expect(classifyInboundOutreachMail(parsed)).toBe("self_loop");
  });
});

describe("isSelfLoop / hasUnsubscribeRecipient", () => {
  it("is not a self-loop when sender and recipient domains differ", () => {
    expect(isSelfLoop("prospect@example.com", ["outreach@outreach.rk9.fi"])).toBe(false);
  });

  it("matches unsub@ case-insensitively", () => {
    expect(hasUnsubscribeRecipient(["UNSUB@outreach.rk9.fi"])).toBe(true);
    expect(hasUnsubscribeRecipient(["outreach@outreach.rk9.fi"])).toBe(false);
  });
});

describe("isDeliveryStatusNotification", () => {
  it("requires both multipart/report and report-type=delivery-status", () => {
    expect(isDeliveryStatusNotification({ value: "multipart/report", params: { "report-type": "delivery-status" } })).toBe(
      true,
    );
    expect(isDeliveryStatusNotification({ value: "multipart/mixed", params: { "report-type": "delivery-status" } })).toBe(
      false,
    );
    expect(isDeliveryStatusNotification({ value: "multipart/report", params: {} })).toBe(false);
  });
});

describe("parseDeliveryStatusFields / classifyDsnSeverity", () => {
  it("parses a hard bounce (5.1.1) from a real DSN fixture", async () => {
    const parsed = await parseInboundMime(dsnFixture("failed", "5.1.1"));
    const fields = parseDeliveryStatusFields(parsed.text ?? "");
    expect(fields).toMatchObject({ action: "failed", status: "5.1.1", diagnosticCode: "smtp; 550 5.1.1 User unknown" });
    expect(classifyDsnSeverity(fields)).toBe("bounce_hard");
  });

  it("classifies a 4.x.x status as a soft bounce", async () => {
    const parsed = await parseInboundMime(dsnFixture("failed", "4.4.7"));
    const fields = parseDeliveryStatusFields(parsed.text ?? "");
    expect(classifyDsnSeverity(fields)).toBe("bounce_soft");
  });

  it("classifies action=delayed with no status as a soft bounce", () => {
    expect(classifyDsnSeverity({ action: "delayed", status: null, diagnosticCode: null })).toBe("bounce_soft");
  });

  it("does not classify delivered/relayed as a bounce", () => {
    expect(classifyDsnSeverity({ action: "delivered", status: null, diagnosticCode: null })).toBeNull();
    expect(classifyDsnSeverity({ action: "relayed", status: "2.0.0", diagnosticCode: null })).toBeNull();
  });

  it("falls back to action=failed when no status code is present", () => {
    expect(classifyDsnSeverity({ action: "failed", status: null, diagnosticCode: null })).toBe("bounce_hard");
  });
});

describe("extractOriginalMessageId", () => {
  it("prefers the embedded message/rfc822 Message-ID over References", () => {
    const id = extractOriginalMessageId(
      "From: a@b.com\r\nMessage-ID: <embedded@outreach.rk9.fi>\r\n\r\nbody",
      "<from-references@outreach.rk9.fi>",
    );
    expect(id).toBe("<embedded@outreach.rk9.fi>");
  });

  it("falls back to the last References token when there is no embedded original", () => {
    const id = extractOriginalMessageId(null, "<older@x> <newer@x>");
    expect(id).toBe("<newer@x>");
  });

  it("returns null when neither source has an id", () => {
    expect(extractOriginalMessageId(null, null)).toBeNull();
  });

  it("resolves the original Message-ID out of a real DSN fixture end-to-end", async () => {
    const parsed = await parseInboundMime(dsnFixture("failed", "5.1.1"));
    const id = extractOriginalMessageId(parsed.rfc822AttachmentText, parsed.references);
    expect(id).toBe("<orig-test-1@outreach.rk9.fi>");
  });
});
