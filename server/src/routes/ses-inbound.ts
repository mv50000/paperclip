// Global SES inbound webhook endpoint (SEC-108/L5).
//
// SES inbound + bounce/complaint events arrive as Amazon SNS HTTP POSTs at
// `/api/webhooks/ses`. We verify the SNS signature (sns-verify), confirm the
// subscription handshake, then for a Notification we parse the inner SES
// payload, normalize it (ses-inbound-adapter) into the shared event shape, and
// resolve the tenant by recipient domain (inbound) or sender domain
// (bounce/complaint) — there is no per-tenant secret as with Resend/Svix.
//
// We respond 200 on internal failures (so SNS doesn't retry-loop) except
// signature failure → 401. SubscriptionConfirmation is confirmed by GETting the
// SubscribeURL.

import express, { Router } from "express";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyEmailConfig } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { createInboundRouter, type InboundRouter } from "../services/email/inbound-router.js";
import { verifySnsSignature, type SnsMessage } from "../services/email/sns-verify.js";
import {
  parseSesNotification,
  getInboundRawEmail,
  normalizeInbound,
  normalizeBounce,
  normalizeComplaint,
  recipientDomains,
  sourceDomain,
  type SesAdapterDeps,
} from "../services/email/ses-inbound-adapter.js";

export interface SesInboundOptions {
  inbound?: InboundRouter;
  adapterDeps?: SesAdapterDeps;
  verify?: typeof verifySnsSignature;
  confirmSubscription?: (url: string) => Promise<void>;
}

const defaultConfirm = async (url: string) => {
  await fetch(url);
};

/** Resolve the company owning `domain` (matches primary or sending domain). */
async function resolveTenantByDomain(db: Db, domain: string): Promise<string | null> {
  const [row] = await db
    .select({ companyId: companyEmailConfig.companyId })
    .from(companyEmailConfig)
    .where(
      and(
        eq(companyEmailConfig.mailProvider, "ses"),
        or(
          eq(companyEmailConfig.primaryDomain, domain),
          eq(companyEmailConfig.sendingDomain, domain),
        ),
      ),
    );
  return row?.companyId ?? null;
}

export function sesInboundRoutes(db: Db, opts: SesInboundOptions = {}) {
  const router = Router();
  const inbound = opts.inbound ?? createInboundRouter(db);
  const verify = opts.verify ?? verifySnsSignature;
  const confirm = opts.confirmSubscription ?? defaultConfirm;
  const adapterDeps = opts.adapterDeps ?? {};

  router.post("/webhooks/ses", express.json({ type: "*/*" }), async (req, res) => {
    const envelope = req.body as SnsMessage;
    if (!envelope || typeof envelope.Type !== "string") {
      res.status(200).json({ ok: false, reason: "invalid_payload" });
      return;
    }

    const verified = await verify(envelope);
    if (!verified.ok) {
      logger.warn({ reason: verified.reason, messageId: envelope.MessageId }, "sns signature verification failed");
      res.status(401).json({ error: "signature_verification_failed", reason: verified.reason });
      return;
    }

    try {
      if (envelope.Type === "SubscriptionConfirmation" || envelope.Type === "UnsubscribeConfirmation") {
        if (envelope.SubscribeURL) await confirm(envelope.SubscribeURL);
        res.status(200).json({ ok: true, status: "subscription_confirmed" });
        return;
      }

      if (envelope.Type !== "Notification") {
        res.status(200).json({ ok: true, status: "ignored" });
        return;
      }

      const sesMessage = JSON.parse(envelope.Message) as Record<string, unknown>;
      const parsed = parseSesNotification(sesMessage);

      if (parsed.kind === "inbound") {
        const domains = recipientDomains(parsed.mail);
        const companyId = await firstTenant(db, domains);
        if (!companyId) {
          res.status(200).json({ ok: false, reason: "no_tenant_for_recipient" });
          return;
        }
        const raw = await getInboundRawEmail(adapterDeps, parsed);
        const event = await normalizeInbound(raw, parsed.mail);
        const result = await inbound.handleEvent(companyId, event);
        res.status(200).json(result);
        return;
      }

      if (parsed.kind === "bounce" || parsed.kind === "complaint") {
        const domain = sourceDomain(parsed.mail);
        const companyId = domain ? await resolveTenantByDomain(db, domain) : null;
        if (!companyId) {
          res.status(200).json({ ok: false, reason: "no_tenant_for_sender" });
          return;
        }
        const event = parsed.kind === "bounce" ? normalizeBounce(parsed) : normalizeComplaint(parsed);
        const result = await inbound.handleEvent(companyId, event);
        res.status(200).json(result);
        return;
      }

      res.status(200).json({ ok: true, status: "ignored" });
    } catch (err) {
      logger.error({ err, messageId: envelope.MessageId }, "ses inbound handler threw");
      res.status(200).json({ ok: false, reason: "internal_error" });
    }
  });

  async function firstTenant(database: Db, domains: string[]): Promise<string | null> {
    for (const d of domains) {
      const id = await resolveTenantByDomain(database, d);
      if (id) return id;
    }
    return null;
  }

  return router;
}
