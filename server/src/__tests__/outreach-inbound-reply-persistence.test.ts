// RK9-234 regression: a prospect's reply must survive the inbound path even
// when no route is configured for the outreach domain.
//
// The pilot's first reply (17.9.2026) was lost because the CS-desk router did
// two things: it re-checked the recipient domain against the company's own
// domain (outreach replies always arrive at the shared `outreach.rk9.fi`), and
// it refused to persist anything without a matching route. The `outreach_events`
// row that remained records only that a reply happened, with an empty payload.
//
// This runs the real MIME → Postfix-receiver → Paperclip path against an
// embedded Postgres, so it fails if either half regresses.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  companies,
  companyEmailConfig,
  emailMessages,
  emailRoutes,
  outreachEvents,
  outreachProspects,
  outreachSequences,
  outreachMessages,
} from "@paperclipai/db";
import { processOutreachInboundMail } from "../services/outreach/inbound.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

const SENDER_IDENTITY = "saatavilla@outreach.rk9.fi";
const OUTREACH_DOMAIN = "outreach.rk9.fi";
const PROSPECT_EMAIL = "prospekti@example.com";
const REPLY_BODY = "Kiitos viestistä! Timma maksaa meille noin 39 e/kk. Voisiko tuon demon nähdä?";

describe("outreach inbound: a prospect reply is never dropped", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  let outboundRfc822Id = "";

  function replyMime(): Buffer {
    return Buffer.from(
      [
        `From: Prospekti <${PROSPECT_EMAIL}>`,
        `To: ${SENDER_IDENTITY}`,
        "Subject: Re: Timma vai kiinteä 19 EUR/kk?",
        `In-Reply-To: ${outboundRfc822Id}`,
        `References: ${outboundRfc822Id}`,
        `Message-ID: <reply-${randomUUID()}@mail.example.com>`,
        'Content-Type: text/plain; charset="utf-8"',
        "",
        REPLY_BODY,
        "",
      ].join("\r\n"),
      "utf-8",
    );
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-outreach-reply-");
    db = createDb(started.connectionString);
    tempDb = started;

    await db.insert(companies).values({ id: companyId, name: "Saatavilla", issuePrefix: "SAA" });
    // The company's own domain is NOT the outreach domain — that mismatch is
    // exactly what used to reject the reply.
    await db
      .insert(companyEmailConfig)
      .values({ companyId, primaryDomain: "saatavilla.fi", sendingDomain: "mail.saatavilla.fi" });
  }, 120_000);

  beforeEach(async () => {
    await db.delete(emailMessages);
    await db.delete(emailRoutes);
    await db.delete(outreachEvents);
    await db.delete(outreachMessages);
    await db.delete(outreachSequences);
    await db.delete(outreachProspects);

    const prospectId = randomUUID();
    await db.insert(outreachProspects).values({
      id: prospectId,
      companyId,
      orgName: "Esimerkki Oy",
      email: PROSPECT_EMAIL,
      source: "test",
    });
    const sequenceId = randomUUID();
    await db.insert(outreachSequences).values({
      id: sequenceId,
      companyId,
      name: "pilotti",
      senderIdentity: SENDER_IDENTITY,
      active: true,
    });
    outboundRfc822Id = `<${randomUUID()}@${OUTREACH_DOMAIN}>`;
    await db.insert(outreachMessages).values({
      companyId,
      prospectId,
      sequenceId,
      subject: "Timma vai kiinteä 19 EUR/kk?",
      bodyText: "Hei, ...",
      status: "sent",
      sentAt: new Date(),
      messageId: outboundRfc822Id,
    });
  });

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("stores the reply body even when the outreach domain has no route", async () => {
    const result = await processOutreachInboundMail(db, replyMime(), { ownDomains: [OUTREACH_DOMAIN] });
    expect(result.outcome).toBe("reply_recorded");

    const stored = await db.select().from(emailMessages).where(eq(emailMessages.companyId, companyId));
    expect(stored).toHaveLength(1);
    expect(stored[0].bodyText).toContain(REPLY_BODY);
    expect(stored[0].fromAddress).toContain(PROSPECT_EMAIL);
    // Unrouted: no owner, no issue — but the words are safe.
    expect(stored[0].routeKey).toBeNull();
    expect(stored[0].issueId).toBeNull();
  });

  it("opens an issue and assigns the route once the outreach domain is routed", async () => {
    await db.insert(emailRoutes).values({
      companyId,
      localPart: "saatavilla",
      domain: OUTREACH_DOMAIN,
      routeKey: "outreach",
      escalateAfterHours: 24,
    });

    const result = await processOutreachInboundMail(db, replyMime(), { ownDomains: [OUTREACH_DOMAIN] });
    expect(result.outcome).toBe("reply_recorded");

    const stored = await db.select().from(emailMessages).where(eq(emailMessages.companyId, companyId));
    expect(stored).toHaveLength(1);
    expect(stored[0].bodyText).toContain(REPLY_BODY);
    expect(stored[0].routeKey).toBe("outreach");
    expect(stored[0].issueId).not.toBeNull();
  });

  it("still records the outreach reply event itself", async () => {
    await processOutreachInboundMail(db, replyMime(), { ownDomains: [OUTREACH_DOMAIN] });
    const events = await db
      .select()
      .from(outreachEvents)
      .where(and(eq(outreachEvents.companyId, companyId), eq(outreachEvents.type, "reply")));
    expect(events).toHaveLength(1);
  });
});
