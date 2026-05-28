// SES inbound adapter (SEC-108/L5).
//
// SES does not deliver a pre-parsed inbound webhook like Resend. Instead a
// receipt rule stores the raw MIME in S3 and publishes an SNS notification; SES
// bounce/complaint events arrive as SNS notifications too. This module turns an
// SNS notification's inner `Message` JSON into the SAME event shapes the
// inbound-router already consumes (InboundEmailEvent / BounceEvent /
// ComplaintEvent), so the routing, suppression and auto-reply logic is shared
// across providers.
//
// Raw MIME is parsed with `mailparser` (a hand-rolled MIME parser is a footgun);
// the S3 fetch is injectable so the normalization can be unit-tested with a
// fixture instead of a live bucket.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { simpleParser, type AddressObject } from "mailparser";
import type {
  InboundEmailEvent,
  BounceEvent,
  ComplaintEvent,
} from "./inbound-router.js";

export type S3GetClient = Pick<S3Client, "send">;

export interface SesAdapterDeps {
  /** Injected for tests; production builds an S3Client from `region`. */
  s3?: S3GetClient;
  region?: string;
}

interface SesMail {
  messageId?: string;
  source?: string;
  destination?: string[];
  timestamp?: string;
  commonHeaders?: { from?: string[]; to?: string[]; subject?: string };
}

export type SesNotification =
  | { kind: "inbound"; mail: SesMail; content?: string; s3?: { bucket: string; key: string } }
  | { kind: "bounce"; mail: SesMail; bounceType: "hard" | "soft"; recipients: string[] }
  | { kind: "complaint"; mail: SesMail; recipients: string[] }
  | { kind: "unknown" };

/**
 * Classify an SES SNS `Message` (already JSON-parsed). Supports the inbound
 * receipt notification (S3 action or inline `content`) and bounce/complaint
 * notifications (both `notificationType` and config-set `eventType` spellings).
 */
export function parseSesNotification(msg: Record<string, unknown>): SesNotification {
  const type = (msg.notificationType ?? msg.eventType) as string | undefined;
  const mail = (msg.mail ?? {}) as SesMail;

  if (type === "Received") {
    const receipt = (msg.receipt ?? {}) as { action?: { type?: string; bucketName?: string; objectKey?: string } };
    const action = receipt.action ?? {};
    const content = typeof msg.content === "string" ? (msg.content as string) : undefined;
    const s3 =
      action.bucketName && action.objectKey
        ? { bucket: action.bucketName, key: action.objectKey }
        : undefined;
    return { kind: "inbound", mail, content, s3 };
  }

  if (type === "Bounce") {
    const bounce = (msg.bounce ?? {}) as { bounceType?: string; bouncedRecipients?: Array<{ emailAddress?: string }> };
    const recipients = (bounce.bouncedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((x): x is string => !!x);
    return { kind: "bounce", mail, bounceType: bounce.bounceType === "Permanent" ? "hard" : "soft", recipients };
  }

  if (type === "Complaint") {
    const complaint = (msg.complaint ?? {}) as { complainedRecipients?: Array<{ emailAddress?: string }> };
    const recipients = (complaint.complainedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((x): x is string => !!x);
    return { kind: "complaint", mail, recipients };
  }

  return { kind: "unknown" };
}

/** Fetch the raw MIME for an inbound notification (inline content or from S3). */
export async function getInboundRawEmail(
  deps: SesAdapterDeps,
  parsed: Extract<SesNotification, { kind: "inbound" }>,
): Promise<Buffer> {
  if (parsed.content) return Buffer.from(parsed.content, "base64");
  if (!parsed.s3) throw new Error("inbound notification has neither inline content nor an S3 location");
  const s3 = deps.s3 ?? new S3Client({ region: deps.region });
  const res = await s3.send(new GetObjectCommand({ Bucket: parsed.s3.bucket, Key: parsed.s3.key }));
  if (!res.Body) throw new Error("S3 object has no body");
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

function firstAddress(addr: AddressObject | AddressObject[] | undefined): string | undefined {
  if (!addr) return undefined;
  const list = Array.isArray(addr) ? addr : [addr];
  return list[0]?.value?.[0]?.address ?? undefined;
}

function allAddresses(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  return list.flatMap((a) => a.value.map((v) => v.address).filter((x): x is string => !!x));
}

/** Parse raw MIME and normalize into the InboundEmailEvent the router consumes. */
export async function normalizeInbound(rawMime: Buffer, mail: SesMail): Promise<InboundEmailEvent> {
  const parsed = await simpleParser(rawMime);
  const to = allAddresses(parsed.to);
  const cc = allAddresses(parsed.cc);
  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? "attachment",
    content_type: a.contentType ?? "application/octet-stream",
    size: a.size ?? 0,
  }));
  return {
    type: "email.received",
    created_at: mail.timestamp ?? new Date().toISOString(),
    data: {
      email_id: mail.messageId,
      from: firstAddress(parsed.from) ?? mail.source ?? "",
      to: to.length > 0 ? to : (mail.destination ?? []),
      cc,
      subject: parsed.subject ?? mail.commonHeaders?.subject ?? "(ei aihetta)",
      text: parsed.text ?? null,
      html: typeof parsed.html === "string" ? parsed.html : null,
      attachments,
    },
  };
}

export function normalizeBounce(parsed: Extract<SesNotification, { kind: "bounce" }>): BounceEvent {
  const recipient = parsed.recipients[0];
  return {
    type: "email.bounced",
    data: {
      email_id: parsed.mail.messageId,
      to: parsed.recipients,
      bounce: { type: parsed.bounceType, recipient },
    },
  };
}

export function normalizeComplaint(parsed: Extract<SesNotification, { kind: "complaint" }>): ComplaintEvent {
  return {
    type: "email.complained",
    data: { email_id: parsed.mail.messageId, to: parsed.recipients },
  };
}

/**
 * Extract the lowercased domain from an address that may be in bare
 * (`info@sunspot.fi`) or display-name (`"Sunspot" <info@sunspot.fi>`) form.
 * SES's `mail.source` / `mail.destination` can carry the full header value, so
 * the angle-bracket address must be unwrapped before splitting on `@` — a naive
 * split would yield `sunspot.fi>` and break tenant resolution.
 */
function addressDomain(addr: string): string | undefined {
  let s = addr.trim();
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt >= 0 && gt > lt) s = s.slice(lt + 1, gt).trim();
  const at = s.lastIndexOf("@");
  if (at < 0 || at === s.length - 1) return undefined;
  return s.slice(at + 1).toLowerCase();
}

/** The recipient domains of an inbound mail, lowercased (for tenant lookup). */
export function recipientDomains(mail: SesMail): string[] {
  return (mail.destination ?? [])
    .map((addr) => addressDomain(addr))
    .filter((x): x is string => !!x);
}

/** The sender domain of a bounce/complaint (the company that sent it). */
export function sourceDomain(mail: SesMail): string | undefined {
  return mail.source ? addressDomain(mail.source) : undefined;
}
