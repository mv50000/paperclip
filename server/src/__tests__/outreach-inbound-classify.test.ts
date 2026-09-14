import { describe, expect, it } from "vitest";
import { parseInboundMime } from "../services/outreach/inbound-mime.js";
import {
  classifyDsnSeverity,
  classifyInboundOutreachMail,
  extractOriginalMessageId,
  hasUnsubscribeRecipient,
  hasVerifiedAuthentication,
  isDeliveryStatusNotification,
  isSelfLoop,
  parseDeliveryStatusFields,
} from "../services/outreach/inbound-classify.js";

function raw(lines: string[]): Buffer {
  return Buffer.from(lines.join("\r\n"), "utf8");
}

const OWN_DOMAINS = ["outreach.rk9.fi"];

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
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("reply");
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
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("auto_reply");
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
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("unsubscribe");
  });

  it("classifies a multipart/report delivery-status message as dsn", async () => {
    const parsed = await parseInboundMime(dsnFixture("failed", "5.1.1"));
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("dsn");
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
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("self_loop");
    // Sanity: a naive implementation might see this same message as a "reply" —
    // assert directly that isSelfLoop fires so the guard can't silently regress.
    expect(isSelfLoop(parsed.from, parsed.to, OWN_DOMAINS)).toBe(true);
  });

  it("a real DSN is same-domain-both-sides by construction and must still classify as dsn, not self_loop", async () => {
    // Postfix bounces to the envelope sender, an address on our OWN domain —
    // From: mailer-daemon@outreach.rk9.fi, To: outreach-saatavilla@outreach.rk9.fi.
    // This is the exact shape that first exposed the self-loop-before-dsn bug.
    const parsed = await parseInboundMime(dsnFixture("failed", "5.1.1"));
    expect(parsed.from.endsWith("@outreach.rk9.fi")).toBe(true);
    expect(parsed.to.every((addr) => addr.endsWith("@outreach.rk9.fi"))).toBe(true);
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("dsn");
  });

  it("does not classify unsub@ on a foreign domain as unsubscribe, even with a matching local-part (RK9-195 verifier H1)", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: victim@example.com",
        "To: unsub@evil-attacker-domain.example",
        "Subject: unsubscribe",
        "Message-ID: <forged-unsub-1@example.com>",
        "",
        "stop",
      ]),
    );
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("reply");
  });

  it("classifies unsub@ appearing only in Cc as unsubscribe (RK9-195 verifier M2)", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Cc: unsub@outreach.rk9.fi",
        "Subject: unsubscribe please",
        "Message-ID: <unsub-cc-1@example.com>",
        "",
        "stop",
      ]),
    );
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("unsubscribe");
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
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("self_loop");
  });

  it("does NOT flag a genuine reply as self_loop just because the prospect CC'd a colleague at their own company (RK9-195 verifier H3)", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Cc: colleague@example.com",
        "Subject: Re: Hei",
        "In-Reply-To: <orig-1@outreach.rk9.fi>",
        "Message-ID: <reply-cc-1@example.com>",
        "",
        "Kiinnostaa.",
      ]),
    );
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("reply");
  });

  it("does NOT drop a genuine unsub@ opt-out as self_loop just because the sender CC'd a colleague at their own company (RK9-195 verifier H3)", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: unsub@outreach.rk9.fi",
        "Cc: legal@example.com",
        "Subject: unsubscribe",
        "Message-ID: <unsub-h3-1@example.com>",
        "",
        "stop",
      ]),
    );
    expect(classifyInboundOutreachMail({ ...parsed, ownDomains: OWN_DOMAINS })).toBe("unsubscribe");
  });
});

describe("isSelfLoop / hasUnsubscribeRecipient", () => {
  it("is not a self-loop when the sender's domain isn't one of ownDomains", () => {
    expect(isSelfLoop("prospect@example.com", ["outreach@outreach.rk9.fi"], OWN_DOMAINS)).toBe(false);
  });

  it("is a self-loop when the sender's domain IS one of ownDomains, regardless of recipients", () => {
    expect(isSelfLoop("outreach-saatavilla@outreach.rk9.fi", ["someone@example.com"], OWN_DOMAINS)).toBe(true);
  });

  it("is NOT a self-loop just because a recipient (e.g. a Cc) happens to share the sender's domain (RK9-195 verifier H3)", () => {
    // prospect@example.com CCs a colleague also @example.com — that domain has
    // nothing to do with `ownDomains`, so this must not be flagged as a loop.
    expect(isSelfLoop("prospect@example.com", ["outreach@outreach.rk9.fi", "colleague@example.com"], OWN_DOMAINS)).toBe(
      false,
    );
  });

  it("falls back to the to-only domain-matching proxy when ownDomains is unconfigured", () => {
    expect(isSelfLoop("outreach-saatavilla@outreach.rk9.fi", ["outreach-saatavilla@outreach.rk9.fi"], [])).toBe(true);
    expect(isSelfLoop("prospect@example.com", ["outreach@outreach.rk9.fi"], [])).toBe(false);
  });

  it("matches unsub@ case-insensitively, scoped to ownDomains", () => {
    expect(hasUnsubscribeRecipient(["UNSUB@outreach.rk9.fi"], OWN_DOMAINS)).toBe(true);
    expect(hasUnsubscribeRecipient(["outreach@outreach.rk9.fi"], OWN_DOMAINS)).toBe(false);
  });

  it("does NOT match unsub@ on a domain outside ownDomains (RK9-195 verifier H1)", () => {
    expect(hasUnsubscribeRecipient(["unsub@evil-attacker-domain.example"], OWN_DOMAINS)).toBe(false);
  });

  it("fails closed: never matches when ownDomains is empty", () => {
    expect(hasUnsubscribeRecipient(["unsub@outreach.rk9.fi"], [])).toBe(false);
  });

  it("matches unsub@ appearing only in Cc, not To (RK9-195 verifier M2)", () => {
    expect(hasUnsubscribeRecipient(["outreach@outreach.rk9.fi", "unsub@outreach.rk9.fi"], OWN_DOMAINS)).toBe(true);
  });
});

describe("hasVerifiedAuthentication (RK9-206)", () => {
  it("passes when the Authentication-Results header shows both spf=pass and dkim=pass", () => {
    expect(
      hasVerifiedAuthentication({
        "authentication-results": "mail.outreach.rk9.fi; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com",
      }),
    ).toBe(true);
  });

  it("is order-independent and case-insensitive", () => {
    expect(
      hasVerifiedAuthentication({
        "authentication-results": "mail.outreach.rk9.fi; SPF=Pass smtp.mailfrom=example.com; DKIM=PASS header.i=@example.com",
      }),
    ).toBe(true);
  });

  it("fails closed when the header is missing entirely", () => {
    expect(hasVerifiedAuthentication({})).toBe(false);
  });

  it("fails when only SPF passes", () => {
    expect(
      hasVerifiedAuthentication({
        "authentication-results": "mail.outreach.rk9.fi; spf=pass smtp.mailfrom=example.com; dkim=fail",
      }),
    ).toBe(false);
  });

  it("fails when only DKIM passes", () => {
    expect(
      hasVerifiedAuthentication({
        "authentication-results": "mail.outreach.rk9.fi; spf=fail; dkim=pass header.i=@example.com",
      }),
    ).toBe(false);
  });

  it("handles two separate Authentication-Results headers (one per filter, joined by parseInboundMime)", () => {
    expect(
      hasVerifiedAuthentication({
        "authentication-results": "mail.outreach.rk9.fi; dkim=pass header.i=@example.com | mail.outreach.rk9.fi; spf=pass smtp.mailfrom=example.com",
      }),
    ).toBe(true);
  });

  it("does not match a substring like dkim=passed or spf=passthrough", () => {
    expect(hasVerifiedAuthentication({ "authentication-results": "dkim=passed; spf=passthrough" })).toBe(false);
  });
});

describe("parseInboundMime References-header capping (RK9-195 verifier H2)", () => {
  it("truncates an oversized References header instead of retaining it in full", async () => {
    const hostileReferences = Array.from({ length: 5000 }, (_, i) => `<c${i}@outreach.rk9.fi>`).join(" ");
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Subject: Re: Hei",
        `References: ${hostileReferences}`,
        "Message-ID: <reply-huge-refs@example.com>",
        "",
        "body",
      ]),
    );
    expect(parsed.references).not.toBeNull();
    expect(parsed.references!.length).toBeLessThanOrEqual(2000);
  });

  it("also truncates an oversized In-Reply-To header (same O(n^2) sink via extractReferencedMessageIds)", async () => {
    const hostileInReplyTo = Array.from({ length: 5000 }, (_, i) => `<c${i}@outreach.rk9.fi>`).join(" ");
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: outreach-saatavilla@outreach.rk9.fi",
        "Subject: Re: Hei",
        `In-Reply-To: ${hostileInReplyTo}`,
        "Message-ID: <reply-huge-irt@example.com>",
        "",
        "body",
      ]),
    );
    expect(parsed.headers["in-reply-to"]?.length ?? 0).toBeLessThanOrEqual(2000);
  });
});

describe("parseInboundMime Authentication-Results extraction (RK9-206)", () => {
  it("captures a single Authentication-Results header", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: unsub@outreach.rk9.fi",
        "Subject: unsubscribe",
        "Authentication-Results: mail.outreach.rk9.fi; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com",
        "Message-ID: <x@example.com>",
        "",
        "stop",
      ]),
    );
    expect(parsed.headers["authentication-results"]).toContain("dkim=pass");
    expect(parsed.headers["authentication-results"]).toContain("spf=pass");
  });

  it("joins two separate Authentication-Results headers (one per verifying filter) instead of keeping only the last", async () => {
    const parsed = await parseInboundMime(
      raw([
        "From: prospect@example.com",
        "To: unsub@outreach.rk9.fi",
        "Subject: unsubscribe",
        "Authentication-Results: mail.outreach.rk9.fi; dkim=pass header.i=@example.com",
        "Authentication-Results: mail.outreach.rk9.fi; spf=pass smtp.mailfrom=example.com",
        "Message-ID: <x2@example.com>",
        "",
        "stop",
      ]),
    );
    expect(parsed.headers["authentication-results"]).toContain("dkim=pass");
    expect(parsed.headers["authentication-results"]).toContain("spf=pass");
  });

  it("omits the header entirely when absent", async () => {
    const parsed = await parseInboundMime(
      raw(["From: prospect@example.com", "To: unsub@outreach.rk9.fi", "Subject: unsubscribe", "Message-ID: <x3@example.com>", "", "stop"]),
    );
    expect(parsed.headers["authentication-results"]).toBeUndefined();
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
