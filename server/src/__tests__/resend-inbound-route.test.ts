// RK9 Custom (RK9-309): route-level signature test for the Resend inbound
// webhook. Upstream security fixes (#12776, #11400) and new host/auth
// middleware land in later upgrade stages; this locks that a correctly signed
// replay of a Svix request still reaches the handler and that a tampered body
// is rejected with 401 before any event handling. The verification runs on the
// raw request bytes, so a body parser mounted ahead of this route would break it.
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const signingSecret = "resend_route_test_secret_not_real";

const handleEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({}) }));

vi.mock("../services/email/inbound-router.js", async () => {
  const { readSvixHeaders, verifySvixSignature } = await vi.importActual<
    typeof import("../services/email/svix-verify.js")
  >("../services/email/svix-verify.js");
  return {
    readSvixHeaders,
    createInboundRouter: () => ({
      handleEvent,
      invalidateSecretCache: vi.fn(),
      // Same contract as the real router: try each company secret, and the
      // matching one names the tenant.
      resolveTenant: async (rawBody: string, headers: Parameters<typeof verifySvixSignature>[1]) => {
        const result = verifySvixSignature(rawBody, headers, signingSecret);
        return result.ok ? { ok: true, companyId } : { ok: false, reason: "no_match" };
      },
    }),
  };
});

const { resendInboundRoutes } = await import("../routes/resend-inbound.js");

function sign(id: string, ts: string, body: string) {
  const digest = createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

function createApp() {
  const app = express();
  app.use("/api", resendInboundRoutes({} as any));
  return app;
}

function signedRequest(body: string, overrides: { signature?: string; timestamp?: string } = {}) {
  const id = "msg_rk9_309";
  const ts = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  return request(createApp())
    .post("/api/webhooks/resend-inbound")
    .set("Content-Type", "application/json")
    .set("svix-id", id)
    .set("svix-timestamp", ts)
    .set("svix-signature", overrides.signature ?? sign(id, ts, body))
    .send(body);
}

// Key order and whitespace differ from JSON.stringify output on purpose:
// the signature must be checked against the bytes Resend sent.
const body = '{"type": "email.received",  "data": {"email_id": "e-1", "to": ["cs@rk9.fi"]}}';

describe("POST /api/webhooks/resend-inbound signature gate", () => {
  beforeEach(() => {
    handleEvent.mockReset();
    handleEvent.mockResolvedValue({ ok: true });
  });

  it("accepts a correctly signed request and hands it to the inbound router", async () => {
    const res = await signedRequest(body);

    expect(res.status).toBe(200);
    expect(handleEvent).toHaveBeenCalledOnce();
    expect(handleEvent).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ type: "email.received" }),
    );
  });

  it("rejects a tampered body with 401 and never handles the event", async () => {
    const id = "msg_rk9_309";
    const ts = String(Math.floor(Date.now() / 1000));
    const tampered = body.replace("cs@rk9.fi", "attacker@example.com");

    const res = await signedRequest(tampered, { signature: sign(id, ts, body), timestamp: ts });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "signature_verification_failed" });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("rejects a replay outside the 5-minute window with 401", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 10 * 60);

    const res = await signedRequest(body, { timestamp: staleTs });

    expect(res.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("rejects a request without Svix headers with 401", async () => {
    const res = await request(createApp())
      .post("/api/webhooks/resend-inbound")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });
});
