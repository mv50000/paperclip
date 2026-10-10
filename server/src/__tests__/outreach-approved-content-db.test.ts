// RK9-475: real-Postgres coverage for the approved-content gate. approve
// stores the fingerprint; the send queue refuses a message whose content
// changed after approval and logs it; a message approved before RK9-475
// (no fingerprint) still sends; the normal approve → queue → send path is
// unchanged (RK9-198 pilot regression).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  createDb,
  companies,
  outreachEvents,
  outreachProspects,
  outreachSequences,
  outreachMessages,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { domainResolver } from "./helpers/recipient-domain-resolver.js";
import { approveMessage } from "../services/outreach/messages.js";
import { listSendQueue, markMessageSent, queueDueMessages } from "../services/outreach/scheduler.js";
import { computeApprovedContentHash } from "../services/outreach/approved-content.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach approved-content tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date(Date.UTC(2026, 0, 13, 8, 0, 0)); // Tuesday 10:00 Europe/Helsinki
const SEND_WINDOW = { tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 };
const UNSUB = { unsubscribeBaseUrl: "https://example.com" };

describeEmbeddedPostgres("outreach approved-content gate (real DB, RK9-475)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-approved-content-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(outreachEvents);
    await db.delete(outreachMessages);
    await db.delete(outreachSequences);
    await db.delete(outreachProspects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(email = "info@alive.test") {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `test-${companyId}`, issuePrefix: companyId.slice(0, 6).toUpperCase() });
    const [seq] = await db
      .insert(outreachSequences)
      .values({
        companyId,
        name: "seq",
        senderIdentity: "sender@example.com",
        dailyCap: 20,
        sendWindow: SEND_WINDOW,
        rampSchedule: [],
        active: true,
      })
      .returning();
    const [prospect] = await db
      .insert(outreachProspects)
      .values({ companyId, orgName: "org", email, source: "manual", status: "approved" })
      .returning();
    const [draft] = await db
      .insert(outreachMessages)
      .values({
        companyId,
        prospectId: prospect.id,
        sequenceId: seq.id,
        subject: "Hei",
        bodyText: "Hyväksytty teksti",
        status: "draft",
      })
      .returning();
    return { seq, prospect, draft };
  }

  async function messageOf(id: string) {
    const [m] = await db.select().from(outreachMessages).where(eq(outreachMessages.id, id));
    return m;
  }

  async function approveAndQueue(id: string) {
    const approved = await approveMessage(db, companyId, id, "user-1");
    expect(approved.ok).toBe(true);
    const { resolver } = domainResolver({});
    expect(await queueDueMessages(db, NOW, resolver)).toEqual({ queued: 1, rejected: 0 });
  }

  async function blockedActivity(id: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, id), eq(activityLog.action, "outreach.message.send_blocked")));
  }

  it("approve stores the fingerprint of the approved content and recipient", async () => {
    const { draft } = await seed();
    const result = await approveMessage(db, companyId, draft.id, "user-1");

    expect(result.ok).toBe(true);
    const row = await messageOf(draft.id);
    expect(row.approvedContentHash).toBe(
      computeApprovedContentHash({
        subject: "Hei",
        bodyText: "Hyväksytty teksti",
        bodyHtml: null,
        inReplyTo: null,
        recipientEmail: "info@alive.test",
      }),
    );
  });

  it("approve → queue → send path is unchanged (RK9-198)", async () => {
    const { draft } = await seed();
    await approveAndQueue(draft.id);

    const items = await listSendQueue(db, UNSUB);

    expect(items.map((i) => i.id)).toEqual([draft.id]);
    expect(items[0].envelopeTo).toBe("info@alive.test");
    expect(items[0].raw).toContain("Hyväksytty teksti");
    expect((await markMessageSent(db, draft.id)).ok).toBe(true);
    expect((await messageOf(draft.id)).status).toBe("sent");
    expect(await blockedActivity(draft.id)).toHaveLength(0);
  });

  it("refuses a message whose body changed after approval, rejects it and logs activity", async () => {
    const { draft } = await seed();
    await approveAndQueue(draft.id);
    // A direct DB change: no route lets an approved message be edited.
    await db.update(outreachMessages).set({ bodyText: "Peukaloitu teksti" }).where(eq(outreachMessages.id, draft.id));

    const items = await listSendQueue(db, UNSUB);

    expect(items).toHaveLength(0);
    const row = await messageOf(draft.id);
    expect(row.status).toBe("rejected");
    expect(row.rejectReason).toBe("approved_content_changed");
    expect(row.rejectedBy).toBe("system:scheduler");
    expect(row.messageId).toBeNull();
    const activity = await blockedActivity(draft.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "outreach-scheduler",
      entityType: "outreach_message",
    });
    expect(activity[0].details).toMatchObject({
      reason: "approved_content_changed",
      fromStatus: "queued",
      toStatus: "rejected",
      expectedHash: row.approvedContentHash,
    });
    // Rejected is terminal: the next poll does not pick it up again.
    expect(await listSendQueue(db, UNSUB)).toHaveLength(0);
    expect(await blockedActivity(draft.id)).toHaveLength(1);
  });

  it("refuses a message whose recipient changed after approval", async () => {
    const { draft, prospect } = await seed();
    await approveAndQueue(draft.id);
    await db.update(outreachProspects).set({ email: "attacker@alive.test" }).where(eq(outreachProspects.id, prospect.id));

    expect(await listSendQueue(db, UNSUB)).toHaveLength(0);
    expect((await messageOf(draft.id)).rejectReason).toBe("approved_content_changed");
    expect(await blockedActivity(draft.id)).toHaveLength(1);
  });

  it("refuses a message whose subject changed after approval", async () => {
    const { draft } = await seed();
    await approveAndQueue(draft.id);
    await db.update(outreachMessages).set({ subject: "Uusi otsikko" }).where(eq(outreachMessages.id, draft.id));

    expect(await listSendQueue(db, UNSUB)).toHaveLength(0);
    expect((await messageOf(draft.id)).status).toBe("rejected");
  });

  it("still sends a legacy message approved before RK9-475 (NULL fingerprint)", async () => {
    const { draft } = await seed();
    await approveAndQueue(draft.id);
    // Simulate a row approved before the column existed, then edited: no
    // retroactive block, the gate only covers fingerprinted approvals.
    await db
      .update(outreachMessages)
      .set({ approvedContentHash: null, bodyText: "Vanha hyväksytty teksti" })
      .where(eq(outreachMessages.id, draft.id));

    const items = await listSendQueue(db, UNSUB);

    expect(items.map((i) => i.id)).toEqual([draft.id]);
    expect(items[0].raw).toContain("Vanha hyväksytty teksti");
    expect((await messageOf(draft.id)).status).toBe("queued");
    expect(await blockedActivity(draft.id)).toHaveLength(0);
  });
});
