import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMessages = vi.hoisted(() => ({ getMessageByRfc822Id: vi.fn(), getMessagesByRfc822Ids: vi.fn() }));
const mockEvents = vi.hoisted(() => ({ recordEvent: vi.fn() }));
const mockSuppressions = vi.hoisted(() => ({ addOutreachSuppression: vi.fn() }));
const mockInboundRouter = vi.hoisted(() => ({
  createInboundRouter: vi.fn(),
  extractReferencedMessageIds: vi.fn(),
}));
const mockLogger = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const mockActivityLog = vi.hoisted(() => ({ logActivity: vi.fn() }));

vi.mock("../services/outreach/messages.js", () => mockMessages);
vi.mock("../services/outreach/events.js", () => mockEvents);
vi.mock("../services/outreach/suppressions.js", () => mockSuppressions);
vi.mock("../services/email/inbound-router.js", () => mockInboundRouter);
vi.mock("../middleware/logger.js", () => mockLogger);
vi.mock("../services/activity-log.js", () => mockActivityLog);

const OWN_DOMAINS = { ownDomains: ["outreach.rk9.fi"] };

// RK9-235: an unthreadable reply is now counted, and the count is attributed to
// a company by looking the recipient up in `email_routes`. That makes the db a
// real collaborator of this code path, so the double answers a
// `select().from().where()` chain instead of being `{}`. Handing in an empty
// object again would make these tests green through a swallowed TypeError.
let routeRows: Array<{ companyId: string }> = [];
function fakeDb(): any {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(routeRows) }) }),
  };
}

function rawMime(lines: string[]): Buffer {
  return Buffer.from(lines.join("\r\n"), "utf8");
}

const REPLY_RAW = rawMime([
  "From: prospect@example.com",
  "To: outreach-saatavilla@outreach.rk9.fi",
  "Subject: Re: Hei",
  "In-Reply-To: <orig-1@outreach.rk9.fi>",
  "Message-ID: <reply-1@example.com>",
  "",
  "Kiinnostaa.",
]);

const OOO_RAW = rawMime([
  "From: prospect@example.com",
  "To: outreach-saatavilla@outreach.rk9.fi",
  "Subject: Automatic reply",
  "Auto-Submitted: auto-replied",
  "Message-ID: <ooo-1@example.com>",
  "",
  "Out of office.",
]);

const SELF_LOOP_RAW = rawMime([
  "From: outreach-saatavilla@outreach.rk9.fi",
  "To: outreach-saatavilla@outreach.rk9.fi",
  "Subject: loop",
  "Message-ID: <loop-1@outreach.rk9.fi>",
  "",
  "loop body",
]);

const UNSUB_RAW = rawMime([
  "From: prospect@example.com",
  "To: unsub@outreach.rk9.fi",
  "Subject: unsubscribe",
  "Message-ID: <unsub-1@example.com>",
  "",
  "stop",
]);

// RK9-206: the address-based (no-threading) unsub@ fallback requires a
// passing Authentication-Results header — this fixture carries one so the
// "falls back to a global suppression" test below still exercises that path.
const UNSUB_AUTHENTICATED_RAW = rawMime([
  "From: prospect@example.com",
  "To: unsub@outreach.rk9.fi",
  "Subject: unsubscribe",
  "Message-ID: <unsub-2@example.com>",
  "Authentication-Results: mail.outreach.rk9.fi; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com",
  "",
  "stop",
]);

const UNSUB_FAILED_AUTH_RAW = rawMime([
  "From: prospect@example.com",
  "To: unsub@outreach.rk9.fi",
  "Subject: unsubscribe",
  "Message-ID: <unsub-3@example.com>",
  "Authentication-Results: mail.outreach.rk9.fi; dkim=fail; spf=pass smtp.mailfrom=example.com",
  "",
  "stop",
]);

const dsnRaw = (action: string, status: string) =>
  rawMime([
    "From: MAILER-DAEMON@outreach.rk9.fi",
    "To: outreach-saatavilla@outreach.rk9.fi",
    "Subject: Undelivered Mail Returned to Sender",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="AAA"',
    "MIME-Version: 1.0",
    "",
    "--AAA",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Delivery failed.",
    "",
    "--AAA",
    "Content-Type: message/delivery-status",
    "",
    "Final-Recipient: rfc822; nosuch@example.com",
    `Action: ${action}`,
    `Status: ${status}`,
    "",
    "--AAA",
    "Content-Type: message/rfc822",
    "",
    "Message-ID: <orig-test-1@outreach.rk9.fi>",
    "",
    "Original body",
    "",
    "--AAA--",
  ]);

describe("processOutreachInboundMail", () => {
  let processOutreachInboundMail: typeof import("../services/outreach/inbound.js").processOutreachInboundMail;

  beforeEach(async () => {
    vi.resetAllMocks();
    // One route owns `outreach-saatavilla@outreach.rk9.fi`, which is what every
    // fixture above is addressed to.
    routeRows = [{ companyId: "company-1" }];
    mockInboundRouter.createInboundRouter.mockReturnValue({
      handleEvent: vi.fn().mockResolvedValue({ ok: false, reason: "no_matching_route" }),
      resolveTenant: vi.fn(),
      invalidateSecretCache: vi.fn(),
    });
    vi.resetModules();
    ({ processOutreachInboundMail } = await import("../services/outreach/inbound.js"));
  });

  it("drops a self-loop message without touching the DB (mail-loop guard)", async () => {
    const result = await processOutreachInboundMail(fakeDb(), SELF_LOOP_RAW, OWN_DOMAINS);
    expect(result.outcome).toBe("self_loop_dropped");
    expect(mockMessages.getMessagesByRfc822Ids).not.toHaveBeenCalled();
    expect(mockEvents.recordEvent).not.toHaveBeenCalled();
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
  });

  it("ignores an OOO/auto-reply without recording a reply", async () => {
    const result = await processOutreachInboundMail(fakeDb(), OOO_RAW, OWN_DOMAINS);
    expect(result.outcome).toBe("auto_reply_ignored");
    expect(mockEvents.recordEvent).not.toHaveBeenCalled();
  });

  it("records a genuine reply for the threaded prospect and stops the sequence via recordEvent", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(["<orig-1@outreach.rk9.fi>"]);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([
      { id: "msg-1", companyId: "company-1", prospectId: "prospect-1", messageId: "<orig-1@outreach.rk9.fi>" },
    ]);
    mockEvents.recordEvent.mockResolvedValue({ ok: true, prospectStatus: "replied", suppressed: false });

    const result = await processOutreachInboundMail(fakeDb(), REPLY_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("reply_recorded");
    expect(mockEvents.recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      expect.objectContaining({ prospectId: "prospect-1", messageId: "msg-1", type: "reply" }),
    );
  });

  it("does not error the request when a matched reply also attempts a CS-desk handoff that fails", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(["<orig-1@outreach.rk9.fi>"]);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([
      { id: "msg-1", companyId: "company-1", prospectId: "prospect-1", messageId: "<orig-1@outreach.rk9.fi>" },
    ]);
    mockEvents.recordEvent.mockResolvedValue({ ok: true, prospectStatus: "replied", suppressed: false });
    mockInboundRouter.createInboundRouter.mockReturnValue({
      handleEvent: vi.fn().mockRejectedValue(new Error("no route configured")),
      resolveTenant: vi.fn(),
      invalidateSecretCache: vi.fn(),
    });

    const result = await processOutreachInboundMail(fakeDb(), REPLY_RAW, OWN_DOMAINS);
    expect(result.outcome).toBe("reply_recorded");
  });

  it("returns reply_unmatched (recording no reply event, but counting the drop) when threading doesn't resolve to a known message", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(["<unknown@outreach.rk9.fi>"]);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([]);

    const result = await processOutreachInboundMail(fakeDb(), REPLY_RAW, OWN_DOMAINS);
    expect(result.outcome).toBe("reply_unmatched");
    expect(mockEvents.recordEvent).not.toHaveBeenCalled();
    // RK9-235: no reply event — the prospect is genuinely unknown — but the
    // drop itself is now counted against the company that owns the recipient.
    expect(mockActivityLog.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "company-1", action: "outreach.reply_unmatched" }),
    );
  });

  it("still returns reply_unmatched when the unmatched-reply bookkeeping itself fails", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(["<unknown@outreach.rk9.fi>"]);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([]);
    mockActivityLog.logActivity.mockRejectedValue(new Error("activity_log is down"));

    // Measuring a dropped reply must not change what happens to the mail: if
    // the counter throws, Postfix still gets its 200 and the warn line stands.
    const result = await processOutreachInboundMail(fakeDb(), REPLY_RAW, OWN_DOMAINS);
    expect(result.outcome).toBe("reply_unmatched");
  });

  it("caps threading candidates and issues a single batched lookup instead of one query per candidate (RK9-195 verifier H2)", async () => {
    const manyCandidates = Array.from({ length: 500 }, (_, i) => `<c${i}@outreach.rk9.fi>`);
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(manyCandidates);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([]);

    const result = await processOutreachInboundMail(fakeDb(), REPLY_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("reply_unmatched");
    expect(mockMessages.getMessagesByRfc822Ids).toHaveBeenCalledTimes(1);
    const [, calledWithIds] = mockMessages.getMessagesByRfc822Ids.mock.calls[0];
    expect(calledWithIds.length).toBeLessThanOrEqual(20);
  });

  it("skips suppression (does not crash) when an unsub@ message has no From address at all", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue([]);
    const noSenderRaw = rawMime(["To: unsub@outreach.rk9.fi", "Subject: unsubscribe", "Message-ID: <x@example.com>", "", "stop"]);

    const result = await processOutreachInboundMail(fakeDb(), noSenderRaw, OWN_DOMAINS);

    expect(result.outcome).toBe("unsubscribe_skipped_no_sender");
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
    expect(mockEvents.recordEvent).not.toHaveBeenCalled();
  });

  it("suppresses via threading when an unsub@ message carries a resolvable Message-ID", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(["<orig-1@outreach.rk9.fi>"]);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([
      { id: "msg-1", companyId: "company-1", prospectId: "prospect-1", messageId: "<orig-1@outreach.rk9.fi>" },
    ]);
    mockEvents.recordEvent.mockResolvedValue({ ok: true, prospectStatus: "unsubscribed", suppressed: true });

    const result = await processOutreachInboundMail(fakeDb(), UNSUB_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("unsubscribed_by_thread");
    expect(mockEvents.recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      expect.objectContaining({ type: "unsubscribe" }),
    );
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
  });

  it("falls back to a global suppression-by-email when unsub@ has no threading header and SPF+DKIM both pass", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue([]);
    mockSuppressions.addOutreachSuppression.mockResolvedValue({ entry: {}, created: true });

    const result = await processOutreachInboundMail(fakeDb(), UNSUB_AUTHENTICATED_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("unsubscribed_by_email");
    expect(mockSuppressions.addOutreachSuppression).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: "prospect@example.com", reason: "unsubscribe" }),
    );
    expect(mockEvents.recordEvent).not.toHaveBeenCalled();
  });

  it("skips the address-based suppression when Authentication-Results is missing entirely (RK9-206, fail closed)", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue([]);

    const result = await processOutreachInboundMail(fakeDb(), UNSUB_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("unsubscribe_skipped_unauthenticated");
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
    expect(mockLogger.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ from: "prospect@example.com" }),
      expect.stringContaining("SPF/DKIM did not both pass"),
    );
  });

  it("skips the address-based suppression when only one of SPF/DKIM passes (RK9-206, fail closed)", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue([]);

    const result = await processOutreachInboundMail(fakeDb(), UNSUB_FAILED_AUTH_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("unsubscribe_skipped_unauthenticated");
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
  });

  it("does NOT honor unsub@ on a domain outside ownDomains (RK9-195 verifier H1: forged To: on any domain)", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue([]);
    const foreignUnsubRaw = rawMime([
      "From: victim@example.com",
      "To: unsub@evil-attacker-domain.example",
      "Subject: unsubscribe",
      "Message-ID: <x2@example.com>",
      "",
      "stop",
    ]);

    const result = await processOutreachInboundMail(fakeDb(), foreignUnsubRaw, OWN_DOMAINS);

    // Falls through to the default "reply" classification since it isn't a
    // self-loop, DSN, or (now correctly scoped) unsubscribe — and there's no
    // thread match, so nothing is recorded either way.
    expect(result.outcome).toBe("reply_unmatched");
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
  });

  it("does NOT honor unsub@ at all when ownDomains is unconfigured (fail closed)", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue([]);

    const result = await processOutreachInboundMail(fakeDb(), UNSUB_RAW, { ownDomains: [] });

    expect(result.outcome).toBe("reply_unmatched");
    expect(mockSuppressions.addOutreachSuppression).not.toHaveBeenCalled();
  });

  it("logs (but does not throw) when recordEvent reports its side effects didn't apply (RK9-195 verifier L1)", async () => {
    mockInboundRouter.extractReferencedMessageIds.mockReturnValue(["<orig-1@outreach.rk9.fi>"]);
    mockMessages.getMessagesByRfc822Ids.mockResolvedValue([
      { id: "msg-1", companyId: "company-1", prospectId: "prospect-1", messageId: "<orig-1@outreach.rk9.fi>" },
    ]);
    mockEvents.recordEvent.mockResolvedValue({ ok: false, reason: "message_not_found" });

    const result = await processOutreachInboundMail(fakeDb(), REPLY_RAW, OWN_DOMAINS);

    expect(result.outcome).toBe("reply_recorded");
    expect(mockLogger.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "message_not_found" }),
      expect.stringContaining("recordEvent did not apply"),
    );
  });

  it("records bounce_hard for a 5.1.1 DSN resolved to its original message", async () => {
    mockMessages.getMessageByRfc822Id.mockResolvedValue({
      id: "msg-1",
      companyId: "company-1",
      prospectId: "prospect-1",
    });
    mockEvents.recordEvent.mockResolvedValue({ ok: true, prospectStatus: "bounced", suppressed: true });

    const result = await processOutreachInboundMail(fakeDb(), dsnRaw("failed", "5.1.1"), OWN_DOMAINS);

    expect(result.outcome).toBe("bounce_recorded");
    expect(mockMessages.getMessageByRfc822Id).toHaveBeenCalledWith(expect.anything(), "<orig-test-1@outreach.rk9.fi>");
    expect(mockEvents.recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      expect.objectContaining({ prospectId: "prospect-1", messageId: "msg-1", type: "bounce_hard" }),
    );
  });

  it("records bounce_soft for a 4.x.x DSN", async () => {
    mockMessages.getMessageByRfc822Id.mockResolvedValue({
      id: "msg-2",
      companyId: "company-1",
      prospectId: "prospect-2",
    });
    mockEvents.recordEvent.mockResolvedValue({ ok: true, prospectStatus: "in_sequence", suppressed: false });

    const result = await processOutreachInboundMail(fakeDb(), dsnRaw("failed", "4.4.7"), OWN_DOMAINS);

    expect(result.outcome).toBe("bounce_recorded");
    expect(mockEvents.recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      expect.objectContaining({ type: "bounce_soft" }),
    );
  });

  it("returns dsn_unmatched (and records nothing) when the DSN's original message is unknown to us", async () => {
    mockMessages.getMessageByRfc822Id.mockResolvedValue(null);

    const result = await processOutreachInboundMail(fakeDb(), dsnRaw("failed", "5.1.1"), OWN_DOMAINS);

    expect(result.outcome).toBe("dsn_unmatched");
    expect(mockEvents.recordEvent).not.toHaveBeenCalled();
  });
});
