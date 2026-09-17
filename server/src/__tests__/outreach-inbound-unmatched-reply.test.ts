// RK9-235 phase 1: an unthreadable reply is dropped on purpose, but it must
// leave a durable trace. Before this, `reply_unmatched` was returned in the HTTP
// response body and logged nowhere — Postfix recorded a successful delivery, the
// receiver exited 0 and Paperclip answered 200, so nobody could tell the
// difference between "never happens" and "we cannot see it".
//
// The count lives in `activity_log` rather than a module-level variable, so it
// survives a restart. Metadata only: keeping the body is phase 2.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, activityLog, companies, emailRoutes, outreachEvents } from "@paperclipai/db";
import { processOutreachInboundMail } from "../services/outreach/inbound.ts";
import { buildOutreachDigest, collectOutreachPrometheusMetrics } from "../services/outreach/metrics.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

const OUTREACH_DOMAIN = "outreach.rk9.fi";
const RECIPIENT = `saatavilla@${OUTREACH_DOMAIN}`;
const SECRET_BODY = "Tämä runko ei saa päätyä mihinkään talteen vaiheessa 1.";

describe("outreach inbound: an unthreadable reply leaves a durable trace", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  /** No In-Reply-To / References at all — nothing to thread against. */
  function unthreadableReply(to = RECIPIENT): Buffer {
    return Buffer.from(
      [
        "From: Tuntematon <joku@example.com>",
        `To: ${to}`,
        "Subject: Re: Timma vai kiinteä 19 EUR/kk?",
        `Message-ID: <${randomUUID()}@mail.example.com>`,
        'Content-Type: text/plain; charset="utf-8"',
        "",
        SECRET_BODY,
        "",
      ].join("\r\n"),
      "utf-8",
    );
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-unmatched-reply-");
    db = createDb(started.connectionString);
    tempDb = started;
    await db.insert(companies).values({ id: companyId, name: "Saatavilla", issuePrefix: "SAA" });
  }, 120_000);

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(emailRoutes);
    await db.insert(emailRoutes).values({
      companyId,
      localPart: "saatavilla",
      domain: OUTREACH_DOMAIN,
      routeKey: "outreach",
      escalateAfterHours: 24,
    });
  });

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("attributes the dropped reply to the company that was written to", async () => {
    const result = await processOutreachInboundMail(db, unthreadableReply(), {
      ownDomains: [OUTREACH_DOMAIN],
    });
    expect(result.outcome).toBe("reply_unmatched");

    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "outreach.reply_unmatched")));
    expect(rows).toHaveLength(1);
    // Threading tells us the prospect; the recipient tells us the company.
    // Losing the first must not cost us the second.
    expect(rows[0].entityType).toBe("outreach_reply");
    expect(JSON.stringify(rows[0].details)).toContain("joku@example.com");
  });

  it("records metadata only — the body is not kept in phase 1", async () => {
    await processOutreachInboundMail(db, unthreadableReply(), { ownDomains: [OUTREACH_DOMAIN] });
    const rows = await db.select().from(activityLog).where(eq(activityLog.action, "outreach.reply_unmatched"));
    expect(JSON.stringify(rows[0].details)).not.toContain(SECRET_BODY);
  });

  it("counts into outreach_inbound_reply_unmatched from the database, not from memory", async () => {
    await processOutreachInboundMail(db, unthreadableReply(), { ownDomains: [OUTREACH_DOMAIN] });
    await processOutreachInboundMail(db, unthreadableReply(), { ownDomains: [OUTREACH_DOMAIN] });

    const metrics = await collectOutreachPrometheusMetrics(db);
    expect(metrics.replyUnmatched).toBe(2);
  });

  it("says so in the daily digest, where a human actually reads it", async () => {
    await processOutreachInboundMail(db, unthreadableReply(), { ownDomains: [OUTREACH_DOMAIN] });

    // Nobody is alerting on the Prometheus counter in phase 1, so the digest
    // line is the whole difference between "measured" and "noticed".
    const digest = await buildOutreachDigest(db);
    expect(digest.replyUnmatchedToday).toBe(1);
    expect(digest.text).toContain("RK9-235");
  });

  it("still drops quietly when the recipient belongs to no route at all", async () => {
    const result = await processOutreachInboundMail(db, unthreadableReply(`tuntematon@${OUTREACH_DOMAIN}`), {
      ownDomains: [OUTREACH_DOMAIN],
    });
    expect(result.outcome).toBe("reply_unmatched");
    const rows = await db.select().from(activityLog).where(eq(activityLog.action, "outreach.reply_unmatched"));
    expect(rows).toHaveLength(0);
    const events = await db.select().from(outreachEvents);
    expect(events).toHaveLength(0);
  });
});
