// RK9-81: escalation must skip backlog issues (unrouted/catch-all triage
// queue) — the pre-fix behaviour escalated Instagram notification backlog to
// the CEO. Automated-classified messages are excluded in SQL (isNull), which a
// fake select can't prove; the backlog skip is a JS filter and is tested here.

import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { startEmailEscalationCron } from "../services/email/escalation.js";
import type { EmailService } from "../services/email/index.js";

function fakeDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "leftJoin", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(rows);
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as Db;
}

const baseRow = {
  companyId: "company-1",
  emailMessageId: "msg-1",
  issueId: "issue-1",
  issueTitle: "📧 Apua",
  fromAddress: "customer@example.com",
  subject: "Apua",
  receivedAt: new Date(Date.now() - 48 * 3600 * 1000),
  routeKey: "tuki",
  escalateAfterHours: 24,
  sendingDomain: "sunspot.fi",
};

async function runTick(rows: unknown[]) {
  const sendEmail = vi.fn(async () => ({ ok: true as const, messageId: "m", providerMessageId: "p" }));
  const service = { sendEmail, replyToMessage: vi.fn() } as unknown as EmailService;
  const cron = startEmailEscalationCron(fakeDb(rows), service, { intervalMs: 2 ** 31 - 1 });
  await cron.runNow();
  cron.stop();
  return sendEmail;
}

describe("email escalation filters", () => {
  it("escalates an open, overdue, routed issue", async () => {
    const sendEmail = await runTick([{ ...baseRow, issueStatus: "todo" }]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("skips backlog issues (unrouted/automated triage queue)", async () => {
    const sendEmail = await runTick([{ ...baseRow, issueStatus: "backlog" }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips closed issues", async () => {
    const sendEmail = await runTick([
      { ...baseRow, issueStatus: "done" },
      { ...baseRow, emailMessageId: "msg-2", issueStatus: "cancelled" },
    ]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips messages without a linked issue", async () => {
    const sendEmail = await runTick([{ ...baseRow, issueId: null, issueStatus: null }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
