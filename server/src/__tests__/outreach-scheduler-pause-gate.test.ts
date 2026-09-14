// RK9-197: end-to-end (real Postgres) coverage for the auto-pause gate. A
// mocked-service route test can't catch a gap between two DB query
// functions the way this can — an independent adversarial review of this
// PR found exactly that gap (queueDueMessages gated the approved→queued
// promotion but listSendQueue, what the sender daemon actually polls, did
// not), so this test exists specifically to keep that fixed.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  outreachProspects,
  outreachSequences,
  outreachMessages,
  outreachSenderPauses,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { queueDueMessages, listSendQueue } from "../services/outreach/scheduler.js";
import { pauseSender } from "../services/outreach/sender-pauses.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach auto-pause gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Tuesday 10:00 Europe/Helsinki, matches outreach-scheduler-logic.test.ts's fixture — inside the default send window.
const NOW = new Date(Date.UTC(2026, 0, 13, 8, 0, 0));
const SEND_WINDOW = { tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 };

describeEmbeddedPostgres("outreach auto-pause gate (real DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-pause-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(outreachSenderPauses);
    await db.delete(outreachMessages);
    await db.delete(outreachSequences);
    await db.delete(outreachProspects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `test-${id}`, issuePrefix: id.slice(0, 6).toUpperCase() });
    return id;
  }

  async function seedSequence(senderIdentity: string, active = true) {
    const [seq] = await db
      .insert(outreachSequences)
      .values({
        companyId,
        name: `seq-${senderIdentity}`,
        senderIdentity,
        dailyCap: 20,
        sendWindow: SEND_WINDOW,
        rampSchedule: [],
        active,
      })
      .returning();
    return seq;
  }

  async function seedProspect(email: string) {
    const [p] = await db
      .insert(outreachProspects)
      .values({ companyId, orgName: `org-${email}`, email, source: "manual", status: "approved" })
      .returning();
    return p;
  }

  async function seedMessage(sequenceId: string, prospectId: string, status: "approved" | "queued") {
    const [m] = await db
      .insert(outreachMessages)
      .values({
        companyId,
        prospectId,
        sequenceId,
        subject: "hi",
        bodyText: "hi",
        status,
        queuedAt: status === "queued" ? NOW : null,
      })
      .returning();
    return m;
  }

  it("queueDueMessages does not promote approved messages for a paused sender identity", async () => {
    companyId = await seedCompany();
    const seq = await seedSequence("paused@example.com");
    const prospect = await seedProspect("prospect1@example.com");
    await seedMessage(seq.id, prospect.id, "approved");
    await pauseSender(db, { senderIdentity: "paused@example.com", reason: "hard_bounce_rate" });

    const result = await queueDueMessages(db, NOW);
    expect(result.queued).toBe(0);

    const [message] = await db.select().from(outreachMessages).where(eq(outreachMessages.sequenceId, seq.id));
    expect(message.status).toBe("approved");
  });

  it("queueDueMessages promotes normally once resumed", async () => {
    companyId = await seedCompany();
    const seq = await seedSequence("resumable@example.com");
    const prospect = await seedProspect("prospect2@example.com");
    await seedMessage(seq.id, prospect.id, "approved");

    const result = await queueDueMessages(db, NOW);
    expect(result.queued).toBe(1);
  });

  it("listSendQueue excludes already-queued messages for a paused sender identity", async () => {
    companyId = await seedCompany();
    const pausedSeq = await seedSequence("paused-daemon@example.com");
    const activeSeq = await seedSequence("active-daemon@example.com");
    const pausedProspect = await seedProspect("pd1@example.com");
    const activeProspect = await seedProspect("ad1@example.com");
    // The paused identity's message was queued BEFORE the pause tripped —
    // this is exactly the gap the adversarial review found: the promotion
    // gate alone doesn't stop something already sitting in `queued`.
    await seedMessage(pausedSeq.id, pausedProspect.id, "queued");
    await seedMessage(activeSeq.id, activeProspect.id, "queued");

    await pauseSender(db, { senderIdentity: "paused-daemon@example.com", reason: "spam_complaint" });

    const items = await listSendQueue(db, { unsubscribeBaseUrl: "https://example.com" });
    expect(items).toHaveLength(1);
    expect(items[0].envelopeFrom).toBe("active-daemon@example.com");
  });

  it("a paused identity with many queued messages does not starve another identity's newer message out of a small LIMIT", async () => {
    companyId = await seedCompany();
    const pausedSeq = await seedSequence("bulk-paused@example.com");
    const activeSeq = await seedSequence("bulk-active@example.com");
    const pausedProspect = await seedProspect("bp1@example.com");
    const activeProspect = await seedProspect("ba1@example.com");

    // Queue 5 messages for the paused identity, all older than the active one's single message.
    for (let i = 0; i < 5; i += 1) {
      await seedMessage(pausedSeq.id, pausedProspect.id, "queued");
    }
    await seedMessage(activeSeq.id, activeProspect.id, "queued");
    await pauseSender(db, { senderIdentity: "bulk-paused@example.com", reason: "hard_bounce_rate" });

    // A limit smaller than the paused backlog: if the pause were filtered
    // post-query (after LIMIT) instead of in the WHERE, this would return 0
    // items even though the active identity has one ready to send.
    const items = await listSendQueue(db, { limit: 3, unsubscribeBaseUrl: "https://example.com" });
    expect(items).toHaveLength(1);
    expect(items[0].envelopeFrom).toBe("bulk-active@example.com");
  });
});
