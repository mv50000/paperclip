import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { sesInboundRoutes, type SesInboundOptions } from "../routes/ses-inbound.js";
import type { InboundRouter } from "../services/email/inbound-router.js";

// Fake db whose companyEmailConfig lookup returns `row` (or nothing).
function makeDb(row: Record<string, unknown> | null) {
  const chain = { from: vi.fn(() => chain), where: vi.fn(async () => (row ? [row] : [])) };
  return { select: vi.fn(() => chain) };
}

function makeApp(db: unknown, opts: SesInboundOptions) {
  const app = express();
  app.use(sesInboundRoutes(db as never, opts));
  return app;
}

const handleEvent = vi.fn(async () => ({ ok: true as const, status: "issue_created" as const }));
const inbound = { handleEvent, resolveTenant: vi.fn(), invalidateSecretCache: vi.fn() } as unknown as InboundRouter;

function baseOpts(over: Partial<SesInboundOptions> = {}): SesInboundOptions {
  return { inbound, verify: (async () => ({ ok: true })) as never, ...over };
}

const rawMime = Buffer.from("Subject: Hi\r\n\r\nbody", "utf8").toString("base64");

describe("POST /webhooks/ses", () => {
  it("returns 401 when the SNS signature is invalid", async () => {
    const app = makeApp(makeDb(null), baseOpts({ verify: (async () => ({ ok: false, reason: "signature_mismatch" })) as never }));
    await request(app).post("/webhooks/ses").send({ Type: "Notification", Message: "{}" }).expect(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("confirms a SubscriptionConfirmation by fetching the SubscribeURL", async () => {
    const confirmSubscription = vi.fn(async () => {});
    const app = makeApp(makeDb(null), baseOpts({ confirmSubscription }));
    await request(app)
      .post("/webhooks/ses")
      .send({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.eu-west-1.amazonaws.com/confirm" })
      .expect(200)
      .expect((r) => expect(r.body.status).toBe("subscription_confirmed"));
    expect(confirmSubscription).toHaveBeenCalledWith("https://sns.eu-west-1.amazonaws.com/confirm");
  });

  it("routes an inbound notification to the matched tenant", async () => {
    handleEvent.mockClear();
    const app = makeApp(makeDb({ companyId: "company-1" }), baseOpts());
    const message = JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "ses-9", source: "c@example.com", destination: ["tuki@sunspot.fi"] },
      content: rawMime,
    });
    await request(app).post("/webhooks/ses").send({ Type: "Notification", Message: message }).expect(200);
    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(handleEvent.mock.calls[0][0]).toBe("company-1");
    expect((handleEvent.mock.calls[0][1] as { type: string }).type).toBe("email.received");
  });

  it("routes a bounce notification by sender domain", async () => {
    handleEvent.mockClear();
    const app = makeApp(makeDb({ companyId: "company-2" }), baseOpts());
    const message = JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: "ses-10", source: "noreply@sunspot.fi" },
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@dead.com" }] },
    });
    await request(app).post("/webhooks/ses").send({ Type: "Notification", Message: message }).expect(200);
    expect(handleEvent.mock.calls[0][0]).toBe("company-2");
    expect((handleEvent.mock.calls[0][1] as { type: string }).type).toBe("email.bounced");
  });

  it("returns no_tenant when no company owns the recipient domain", async () => {
    handleEvent.mockClear();
    const app = makeApp(makeDb(null), baseOpts());
    const message = JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "ses-11", destination: ["tuki@unknown.example"] },
      content: rawMime,
    });
    await request(app)
      .post("/webhooks/ses")
      .send({ Type: "Notification", Message: message })
      .expect(200)
      .expect((r) => expect(r.body.reason).toBe("no_tenant_for_recipient"));
    expect(handleEvent).not.toHaveBeenCalled();
  });
});
