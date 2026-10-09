// RK9-370: `draftMessageForProspect` resolves its sequence once per batch, so the
// sequence can be deleted, or the prospect suppressed, between that resolution
// and the message insert. Both must be reported as what they are, not as a
// generic `generation_failed` (RK9-230 fixed the sequence case without a test).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, companies, outreachProspects, outreachSequences, outreachMessages } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { draftMessageForProspect } from "../services/outreach/draft.js";
import { okResolver } from "./helpers/recipient-domain-resolver.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach draft race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("outreach draft mid-batch races (real DB, RK9-370)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalKey = process.env.OUTREACH_ANTHROPIC_API_KEY;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-draft-race-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    process.env.OUTREACH_ANTHROPIC_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "SUBJECT: Hei\nBODY:\nMoi, tässä viesti." }],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
          { status: 200 },
        ),
      ),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.OUTREACH_ANTHROPIC_API_KEY;
    else process.env.OUTREACH_ANTHROPIC_API_KEY = originalKey;
    await db.delete(outreachMessages);
    await db.delete(outreachSequences);
    await db.delete(outreachProspects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProspect(status: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `test-${companyId}`, issuePrefix: companyId.slice(0, 6).toUpperCase() });
    const [prospect] = await db
      .insert(outreachProspects)
      .values({ companyId, orgName: "org", email: "p@example.com", source: "manual", status })
      .returning();
    return { companyId, prospect };
  }

  it("reports sequence_not_found when the sequence is deleted after batch start", async () => {
    const { companyId, prospect } = await seedProspect("approved");
    const [sequence] = await db
      .insert(outreachSequences)
      .values({ companyId, name: "seq", senderIdentity: "a@example.com", active: true })
      .returning();
    await db.delete(outreachSequences);

    const outcome = await draftMessageForProspect(db, companyId, "rk9", prospect.id, sequence.id, okResolver);

    expect(outcome).toMatchObject({ ok: false, reason: "sequence_not_found" });
    expect(await db.select().from(outreachMessages)).toEqual([]);
  });

  it("reports prospect_not_contactable when the prospect turns terminal after batch start", async () => {
    const { companyId, prospect } = await seedProspect("unsubscribed");
    const [sequence] = await db
      .insert(outreachSequences)
      .values({ companyId, name: "seq", senderIdentity: "a@example.com", active: true })
      .returning();

    const outcome = await draftMessageForProspect(db, companyId, "rk9", prospect.id, sequence.id, okResolver);

    expect(outcome).toMatchObject({ ok: false, reason: "prospect_not_contactable" });
    expect(await db.select().from(outreachMessages)).toEqual([]);
  });
});
