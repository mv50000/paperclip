import { describe, expect, it, vi } from "vitest";
import {
  parseSesNotification,
  getInboundRawEmail,
  normalizeInbound,
  normalizeBounce,
  normalizeComplaint,
  recipientDomains,
  sourceDomain,
  type S3GetClient,
  type SesNotification,
} from "../services/email/ses-inbound-adapter.js";

const mail = {
  messageId: "ses-1",
  source: "customer@example.com",
  destination: ["tuki@sunspot.fi"],
  timestamp: "2026-05-26T20:00:00.000Z",
};

describe("parseSesNotification", () => {
  it("classifies an inbound S3 receipt", () => {
    const p = parseSesNotification({
      notificationType: "Received",
      mail,
      receipt: { action: { type: "S3", bucketName: "rk9-ses-inbound", objectKey: "abc" } },
    });
    expect(p).toMatchObject({ kind: "inbound", s3: { bucket: "rk9-ses-inbound", key: "abc" } });
  });

  it("classifies an inbound inline-content receipt", () => {
    const p = parseSesNotification({ notificationType: "Received", mail, content: "cmF3" }) as Extract<
      SesNotification,
      { kind: "inbound" }
    >;
    expect(p.kind).toBe("inbound");
    expect(p.content).toBe("cmF3");
  });

  it("maps Permanent→hard and Transient→soft bounces", () => {
    expect(
      parseSesNotification({
        notificationType: "Bounce",
        mail,
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@x.com" }] },
      }),
    ).toMatchObject({ kind: "bounce", bounceType: "hard", recipients: ["a@x.com"] });
    expect(
      parseSesNotification({ eventType: "Bounce", mail, bounce: { bounceType: "Transient", bouncedRecipients: [] } }),
    ).toMatchObject({ kind: "bounce", bounceType: "soft" });
  });

  it("classifies a complaint and an unknown type", () => {
    expect(
      parseSesNotification({
        notificationType: "Complaint",
        mail,
        complaint: { complainedRecipients: [{ emailAddress: "b@x.com" }] },
      }),
    ).toMatchObject({ kind: "complaint", recipients: ["b@x.com"] });
    expect(parseSesNotification({ notificationType: "DeliveryDelay", mail })).toEqual({ kind: "unknown" });
  });
});

describe("getInboundRawEmail", () => {
  it("base64-decodes inline content without touching S3", async () => {
    const raw = await getInboundRawEmail({}, { kind: "inbound", mail, content: Buffer.from("RAW MIME").toString("base64") });
    expect(raw.toString("utf8")).toBe("RAW MIME");
  });

  it("fetches from S3 when only a location is given", async () => {
    const s3: S3GetClient = {
      send: vi.fn(async () => ({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from("S3 BODY")) } })),
    } as unknown as S3GetClient;
    const raw = await getInboundRawEmail({ s3 }, { kind: "inbound", mail, s3: { bucket: "b", key: "k" } });
    expect(raw.toString("utf8")).toBe("S3 BODY");
    expect((s3.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeInbound", () => {
  const rawMime = [
    "From: Customer <customer@example.com>",
    "To: tuki@sunspot.fi",
    "Cc: cc@example.com",
    "Subject: Hei",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hei maailma ä",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hei maailma ä</p>",
    "--b1",
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    "",
    "liite",
    "--b1--",
    "",
  ].join("\r\n");

  it("parses MIME into the InboundEmailEvent shape", async () => {
    const event = await normalizeInbound(Buffer.from(rawMime, "utf8"), mail);
    expect(event.type).toBe("email.received");
    expect(event.data.email_id).toBe("ses-1");
    expect(event.data.from).toBe("customer@example.com");
    expect(event.data.to).toContain("tuki@sunspot.fi");
    expect(event.data.cc).toContain("cc@example.com");
    expect(event.data.subject).toBe("Hei");
    expect(event.data.text).toContain("Hei maailma ä");
    expect(event.data.html).toContain("<p>Hei maailma ä</p>");
    expect(event.data.attachments).toEqual([
      expect.objectContaining({ filename: "note.txt", content_type: "text/plain" }),
    ]);
  });

  it("falls back to envelope fields when headers are sparse", async () => {
    const event = await normalizeInbound(Buffer.from("Subject: x\r\n\r\nbody", "utf8"), mail);
    expect(event.data.from).toBe("customer@example.com"); // from mail.source
    expect(event.data.to).toEqual(["tuki@sunspot.fi"]); // from mail.destination
  });
});

describe("normalizeBounce / normalizeComplaint", () => {
  it("builds a BounceEvent", () => {
    expect(normalizeBounce({ kind: "bounce", mail, bounceType: "hard", recipients: ["a@x.com"] })).toEqual({
      type: "email.bounced",
      data: { email_id: "ses-1", to: ["a@x.com"], bounce: { type: "hard", recipient: "a@x.com" } },
    });
  });
  it("builds a ComplaintEvent", () => {
    expect(normalizeComplaint({ kind: "complaint", mail, recipients: ["b@x.com"] })).toEqual({
      type: "email.complained",
      data: { email_id: "ses-1", to: ["b@x.com"] },
    });
  });
});

describe("domain helpers", () => {
  it("extracts recipient and source domains lowercased", () => {
    expect(recipientDomains({ destination: ["Tuki@Sunspot.FI", "x@other.com"] })).toEqual(["sunspot.fi", "other.com"]);
    expect(sourceDomain({ source: "noreply@Sunspot.FI" })).toBe("sunspot.fi");
  });
});
