// RK9-207 regression: `buildOutreachDigest` runs against a real Postgres here,
// not a mocked `Db`. The route test (outreach-metrics-routes.test.ts) mocks the
// whole metrics module, so a query that only fails at bind time stayed green in
// CI while the 08:00 cron 500'd every single morning. Any future digest query
// that binds a value postgres.js can't serialise fails here instead.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  outreachProspects,
  outreachSequences,
  outreachMessages,
  outreachEvents,
} from "@paperclipai/db";
import { buildOutreachDigest } from "../services/outreach/metrics.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

describe("buildOutreachDigest against a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const senderIdentity = "mv@rk9.fi";
  // Mid-afternoon Helsinki time, so "today" is unambiguous in both EET and EEST.
  const now = new Date("2026-09-17T12:00:00Z");

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-outreach-digest-");
    db = createDb(started.connectionString);
    tempDb = started;

    await db.insert(companies).values({ id: companyId, name: "RK9", issuePrefix: "RK9" });
    const prospectId = randomUUID();
    await db.insert(outreachProspects).values({
      id: prospectId,
      companyId,
      orgName: "Testiyritys Oy",
      email: "asiakas@example.com",
      source: "test",
    });
    const sequenceId = randomUUID();
    await db.insert(outreachSequences).values({
      id: sequenceId,
      companyId,
      name: "pilotti",
      senderIdentity,
      dailyCap: 5,
      active: true,
      activatedAt: new Date("2026-09-15T06:00:00Z"),
    });
    const messageId = randomUUID();
    await db.insert(outreachMessages).values({
      id: messageId,
      companyId,
      prospectId,
      sequenceId,
      subject: "Hei",
      bodyText: "Testi",
      status: "sent",
      sentAt: new Date("2026-09-17T07:00:00Z"),
    });
    // One event inside today's window and one the day before — the digest must
    // count only the first, which is what the upper bound of the range is for.
    await db.insert(outreachEvents).values([
      { companyId, prospectId, messageId, type: "reply", occurredAt: new Date("2026-09-17T08:00:00Z") },
      { companyId, prospectId, messageId, type: "reply", occurredAt: new Date("2026-09-16T08:00:00Z") },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("builds the digest without a bind error and counts only today's rows", async () => {
    const digest = await buildOutreachDigest(db, now);

    expect(digest.date).toBe("2026-09-17");
    const sender = digest.senders.find((s) => s.senderIdentity === senderIdentity);
    expect(sender).toBeDefined();
    expect(sender?.sentToday).toBe(1);
    expect(sender?.repliesToday).toBe(1);
    expect(digest.text).toContain(senderIdentity);
  });
});
