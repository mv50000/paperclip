// RK9-224: `approved_without_sequence` is the safety net for the bug this
// issue fixes — an `approved` message the scheduler can never promote
// because it has no `sequence_id` (server/src/services/outreach/scheduler.ts
// only reaches messages via an active sequence's join). Drafting now always
// resolves a sequence, so this should stay at 0; this test pins the counter
// itself, real DB, so a future regression in either write path still shows up.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, outreachProspects, outreachSequences, outreachMessages } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildOutreachDigest, collectOutreachPrometheusMetrics, renderOutreachPrometheusText } from "../services/outreach/metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach approved_without_sequence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("outreach approved_without_sequence metric (real DB, RK9-224)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-approved-no-seq-");
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

  async function seedOrphanApprovedMessage() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `test-${companyId}`, issuePrefix: companyId.slice(0, 6).toUpperCase() });
    const [prospect] = await db
      .insert(outreachProspects)
      .values({ companyId, orgName: "org", email: "orphan@example.com", source: "manual", status: "approved" })
      .returning();
    await db.insert(outreachMessages).values({
      companyId,
      prospectId: prospect.id,
      sequenceId: null,
      subject: "hi",
      bodyText: "hi",
      status: "approved",
    });
    return companyId;
  }

  it("collectOutreachPrometheusMetrics counts it by company, and renders as a gauge", async () => {
    const companyId = await seedOrphanApprovedMessage();

    const metrics = await collectOutreachPrometheusMetrics(db);
    expect(metrics.approvedWithoutSequence).toEqual([{ companyId, count: 1 }]);

    const text = renderOutreachPrometheusText(metrics);
    expect(text).toContain(`outreach_approved_without_sequence{company="${companyId}"} 1`);
  });

  it("is 0 once every approved message has a sequence", async () => {
    const metrics = await collectOutreachPrometheusMetrics(db);
    expect(metrics.approvedWithoutSequence).toEqual([]);
  });

  it("buildOutreachDigest surfaces the total and warns in the digest text", async () => {
    await seedOrphanApprovedMessage();

    const digest = await buildOutreachDigest(db, new Date(Date.UTC(2026, 0, 13, 8, 0, 0)));
    expect(digest.approvedWithoutSequenceTotal).toBe(1);
    expect(digest.text).toContain("1 hyväksyttyä viestiä ilman sekvenssiä");
  });

  it("buildOutreachDigest omits the warning when the count is 0", async () => {
    const digest = await buildOutreachDigest(db, new Date(Date.UTC(2026, 0, 13, 8, 0, 0)));
    expect(digest.approvedWithoutSequenceTotal).toBe(0);
    expect(digest.text).not.toContain("ilman sekvenssiä");
  });
});
