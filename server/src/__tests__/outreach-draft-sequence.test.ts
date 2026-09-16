// RK9-224: an AI-drafted outreach message that never got a `sequence_id`
// could sit `approved` forever — the scheduler only promotes `approved` →
// `queued` by iterating active sequences and joining messages onto them
// (server/src/services/outreach/scheduler.ts), so a sequence-less message is
// invisible to it. This covers both halves of the fix: the batch-drafting
// sequence resolution (resolveDraftSequence) and the scheduler-side
// regression it prevents.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, outreachProspects, outreachSequences, outreachMessages } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveDraftSequence } from "../services/outreach/draft.js";
import { createDraftMessage } from "../services/outreach/messages.js";
import { queueDueMessages } from "../services/outreach/scheduler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach sequence-attach tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date(Date.UTC(2026, 0, 13, 8, 0, 0)); // Tuesday 10:00 Europe/Helsinki
const SEND_WINDOW = { tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 };

describeEmbeddedPostgres("outreach draft sequence attachment (real DB, RK9-224)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-draft-sequence-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
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

  async function seedSequence(opts: {
    name: string;
    templateId?: string;
    active?: boolean;
    senderIdentity?: string;
    companyId?: string;
  }) {
    const [seq] = await db
      .insert(outreachSequences)
      .values({
        companyId: opts.companyId ?? companyId,
        name: opts.name,
        senderIdentity: opts.senderIdentity ?? `${opts.name}@example.com`,
        steps: opts.templateId ? [{ dayOffset: 0, templateId: opts.templateId }] : [],
        dailyCap: 20,
        sendWindow: SEND_WINDOW,
        rampSchedule: [],
        active: opts.active ?? true,
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

  describe("resolveDraftSequence", () => {
    it("resolves to the single active sequence whose first step targets the requested template", async () => {
      companyId = await seedCompany();
      const seq = await seedSequence({ name: "saatavilla-pilot", templateId: "saatavilla" });
      await seedSequence({ name: "ololla-pilot", templateId: "ololla" });

      const result = await resolveDraftSequence(db, companyId, "saatavilla", undefined);
      expect(result).toEqual({ ok: true, sequenceId: seq.id });
    });

    it("422s sequence_required when no active sequence targets the template", async () => {
      companyId = await seedCompany();
      await seedSequence({ name: "ololla-pilot", templateId: "ololla" });

      const result = await resolveDraftSequence(db, companyId, "saatavilla", undefined);
      expect(result).toEqual({ ok: false, reason: "sequence_required" });
    });

    it("422s sequence_required when two active sequences target the same template — never guesses", async () => {
      companyId = await seedCompany();
      await seedSequence({ name: "saatavilla-a", templateId: "saatavilla", senderIdentity: "a@example.com" });
      await seedSequence({ name: "saatavilla-b", templateId: "saatavilla", senderIdentity: "b@example.com" });

      const result = await resolveDraftSequence(db, companyId, "saatavilla", undefined);
      expect(result).toEqual({ ok: false, reason: "sequence_required" });
    });

    it("ignores an inactive sequence even if its template matches", async () => {
      companyId = await seedCompany();
      await seedSequence({ name: "saatavilla-inactive", templateId: "saatavilla", active: false });

      const result = await resolveDraftSequence(db, companyId, "saatavilla", undefined);
      expect(result).toEqual({ ok: false, reason: "sequence_required" });
    });

    it("accepts an explicit sequenceId that belongs to the company without requiring a template match", async () => {
      companyId = await seedCompany();
      const seq = await seedSequence({ name: "manual-pick", templateId: "ololla" });

      const result = await resolveDraftSequence(db, companyId, "saatavilla", seq.id);
      expect(result).toEqual({ ok: true, sequenceId: seq.id });
    });

    it("404s sequence_not_found for an explicit sequenceId belonging to another company", async () => {
      const otherCompanyId = await seedCompany();
      const otherSeq = await seedSequence({ name: "other-co-seq", templateId: "saatavilla", companyId: otherCompanyId });
      companyId = await seedCompany(); // the requesting company — distinct from otherCompanyId

      const result = await resolveDraftSequence(db, companyId, "saatavilla", otherSeq.id);
      expect(result).toEqual({ ok: false, reason: "sequence_not_found" });
    });
  });

  it("createDraftMessage stores the resolved sequenceId", async () => {
    companyId = await seedCompany();
    const seq = await seedSequence({ name: "saatavilla-pilot", templateId: "saatavilla" });
    const prospect = await seedProspect("prospect@example.com");

    const result = await createDraftMessage(db, companyId, {
      prospectId: prospect.id,
      sequenceId: seq.id,
      step: 0,
      subject: "hi",
      bodyText: "hi",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.message.sequenceId).toBe(seq.id);
  });

  // The regression this whole issue is about: before RK9-224, drafting never
  // set sequenceId, so an approved draft looked exactly like this row — and
  // the scheduler could never find it.
  it("an approved message with no sequenceId is never promoted by the scheduler", async () => {
    companyId = await seedCompany();
    await seedSequence({ name: "saatavilla-pilot", templateId: "saatavilla" });
    const prospect = await seedProspect("orphan@example.com");
    const [orphan] = await db
      .insert(outreachMessages)
      .values({
        companyId,
        prospectId: prospect.id,
        sequenceId: null,
        subject: "hi",
        bodyText: "hi",
        status: "approved",
      })
      .returning();

    const result = await queueDueMessages(db, NOW);
    expect(result.queued).toBe(0);

    const [reloaded] = await db.select().from(outreachMessages).where(eq(outreachMessages.id, orphan.id));
    expect(reloaded.status).toBe("approved");
  });
});
