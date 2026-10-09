// A sender identity needs an inbound route, or a prospect's reply is stored
// but never opens an issue or escalates. Migration 9010 seeded routes only for
// the identities that existed then; rk9@outreach.rk9.fi (created 26.9.2026)
// had none. The sequence service now creates the route itself.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, emailRoutes, outreachSequences } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createSequence, updateSequence } from "../services/outreach/sequences.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres outreach reply-route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SEND_WINDOW = { tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 9, endHour: 15 };

describeEmbeddedPostgres("outreach sequence sender reply route (real DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outreach-reply-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(emailRoutes);
    await db.delete(outreachSequences);
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

  function sequenceInput(name: string, senderIdentity: string) {
    return {
      name,
      senderIdentity,
      steps: [{ dayOffset: 0, templateId: "rk9" }],
      dailyCap: 5,
      sendWindow: SEND_WINDOW,
      rampSchedule: [],
      active: false,
    };
  }

  async function routesFor(localPart: string) {
    return db
      .select()
      .from(emailRoutes)
      .where(and(eq(emailRoutes.companyId, companyId), eq(emailRoutes.localPart, localPart)));
  }

  it("creates a human-owned outreach route for a new sender identity", async () => {
    companyId = await seedCompany();
    await createSequence(db, companyId, sequenceInput("Kanta-Häme", "RK9@Outreach.rk9.fi"));

    const routes = await routesFor("rk9");
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      domain: "outreach.rk9.fi",
      routeKey: "outreach",
      assignedAgentId: null,
      autoReplyTemplateId: null,
      escalateAfterHours: 24,
      approvalRequired: true,
    });
  });

  it("adds a route when the sender identity changes, and keeps an existing route as configured", async () => {
    companyId = await seedCompany();
    await db.insert(emailRoutes).values({
      companyId,
      localPart: "pilot",
      domain: "outreach.rk9.fi",
      routeKey: "custom",
      escalateAfterHours: 4,
    });
    const seq = await createSequence(db, companyId, sequenceInput("Pilotti", "pilot@outreach.rk9.fi"));
    expect(seq).not.toBeNull();

    const [kept] = await routesFor("pilot");
    expect(kept).toMatchObject({ routeKey: "custom", escalateAfterHours: 4 });

    await updateSequence(db, companyId, seq!.id, { senderIdentity: "pilot2@outreach.rk9.fi" });
    expect(await routesFor("pilot2")).toHaveLength(1);

    await updateSequence(db, companyId, seq!.id, { dailyCap: 10 });
    expect(await db.select().from(emailRoutes).where(eq(emailRoutes.companyId, companyId))).toHaveLength(2);
  });
});
