// RK9-434: real-Postgres coverage for the recipient-domain check in the send
// scheduler and in drafting. DNS is always a stub — never a real lookup. The
// point of the "no event" assertions: a dead domain must not become a
// bounce_hard event, which is what feeds the auto-pause rate.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  companies,
  outreachEvents,
  outreachProspects,
  outreachSequences,
  outreachMessages,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { domainResolver } from "./helpers/recipient-domain-resolver.js";
import { queueDueMessages } from "../services/outreach/scheduler.js";
import { draftMessageForProspect } from "../services/outreach/draft.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach recipient-domain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date(Date.UTC(2026, 0, 13, 8, 0, 0)); // Tuesday 10:00 Europe/Helsinki
const SEND_WINDOW = { tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 };

describeEmbeddedPostgres("outreach recipient-domain check (real DB, RK9-434)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-recipient-domain-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(outreachEvents);
    await db.delete(outreachMessages);
    await db.delete(outreachSequences);
    await db.delete(outreachProspects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSequence() {
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
    return seq;
  }

  async function seedProspect(email: string) {
    const [p] = await db
      .insert(outreachProspects)
      .values({ companyId, orgName: `org-${email}`, email, source: "manual", status: "approved" })
      .returning();
    return p;
  }

  async function seedApproved(sequenceId: string, prospectId: string) {
    const [m] = await db
      .insert(outreachMessages)
      .values({ companyId, prospectId, sequenceId, subject: "hi", bodyText: "hi", status: "approved" })
      .returning();
    return m;
  }

  async function messageOf(id: string) {
    const [m] = await db.select().from(outreachMessages).where(eq(outreachMessages.id, id));
    return m;
  }

  it("rejects a message whose domain does not exist, records no event, and still queues the others", async () => {
    const seq = await seedSequence();
    const dead = await seedApproved(seq.id, (await seedProspect("info@8aisi.com")).id);
    const alive = await seedApproved(seq.id, (await seedProspect("hello@alive.test")).id);
    const { resolver } = domainResolver({ "8aisi.com": "nxdomain" });

    const result = await queueDueMessages(db, NOW, resolver);

    expect(result).toEqual({ queued: 1, rejected: 1 });
    const deadRow = await messageOf(dead.id);
    expect(deadRow.status).toBe("rejected");
    expect(deadRow.rejectReason).toBe("recipient_domain_unresolvable");
    expect(deadRow.rejectedBy).toBe("system:scheduler");
    expect((await messageOf(alive.id)).status).toBe("queued");
    expect(await db.select().from(outreachEvents)).toHaveLength(0);
  });

  it("leaves a message approved on a transient DNS failure, uncounted and without an event", async () => {
    const seq = await seedSequence();
    const flaky = await seedApproved(seq.id, (await seedProspect("a@flaky.test")).id);
    const { resolver } = domainResolver({ "flaky.test": "timeout" });

    const result = await queueDueMessages(db, NOW, resolver);

    expect(result).toEqual({ queued: 0, rejected: 0 });
    const row = await messageOf(flaky.id);
    expect(row.status).toBe("approved");
    expect(row.rejectReason).toBeNull();
    expect(await db.select().from(outreachEvents)).toHaveLength(0);
  });

  it("looks up each domain once per tick", async () => {
    const seq = await seedSequence();
    await seedApproved(seq.id, (await seedProspect("a@shared.test")).id);
    await seedApproved(seq.id, (await seedProspect("b@shared.test")).id);
    const { resolver, lookups } = domainResolver({});

    const result = await queueDueMessages(db, NOW, resolver);

    expect(result.queued).toBe(2);
    expect(lookups).toEqual(["shared.test"]);
  });

  describe("drafting", () => {
    function failIfClaudeCalled() {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("Claude must not be called for an undeliverable recipient");
      });
    }

    it("does not call Claude or create a message for an unresolvable domain", async () => {
      const seq = await seedSequence();
      const prospect = await seedProspect("info@8aisi.com");
      const fetchSpy = failIfClaudeCalled();
      const { resolver } = domainResolver({ "8aisi.com": "nxdomain" });

      const outcome = await draftMessageForProspect(db, companyId, "saatavilla", prospect.id, seq.id, resolver);

      expect(outcome).toEqual({ ok: false, reason: "recipient_domain_unresolvable", costUsd: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await db.select().from(outreachMessages)).toHaveLength(0);
      expect(await db.select().from(outreachEvents)).toHaveLength(0);
    });

    it("skips the prospect on a transient DNS failure without calling Claude", async () => {
      const seq = await seedSequence();
      const prospect = await seedProspect("a@flaky.test");
      const fetchSpy = failIfClaudeCalled();
      const { resolver } = domainResolver({ "flaky.test": "timeout" });

      const outcome = await draftMessageForProspect(db, companyId, "saatavilla", prospect.id, seq.id, resolver);

      expect(outcome).toEqual({ ok: false, reason: "recipient_domain_transient", costUsd: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await db.select().from(outreachMessages)).toHaveLength(0);
    });
  });
});
