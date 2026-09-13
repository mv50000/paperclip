import { describe, expect, it } from "vitest";
import {
  addOutreachSuppressionSchema,
  createOutreachProspectSchema,
  createOutreachSequenceSchema,
  importOutreachProspectsSchema,
  updateOutreachProspectSchema,
} from "./outreach.js";

describe("outreach validators", () => {
  it("lower-cases and trims prospect e-mails and requires source + legal basis", () => {
    const parsed = createOutreachProspectSchema.parse({
      orgName: "Testi Oy",
      email: "  Info@Testi.FI ",
      source: "prh",
    });
    expect(parsed.email).toBe("info@testi.fi");
    expect(parsed.legalBasis).toBe("b2b_legitimate_interest");
    expect(() => createOutreachProspectSchema.parse({ orgName: "X", email: "a@b.fi" })).toThrow();
    expect(() =>
      createOutreachProspectSchema.parse({ orgName: "X", email: "a@b.fi", source: "linkedin" }),
    ).toThrow();
    expect(() =>
      createOutreachProspectSchema.parse({ orgName: "X", email: "a@b.fi", source: "web", legalBasis: "consent" }),
    ).toThrow();
  });

  it("rejects malformed e-mails and business ids", () => {
    expect(() => createOutreachProspectSchema.parse({ orgName: "X", email: "not-an-email", source: "manual" })).toThrow();
    expect(() => createOutreachProspectSchema.parse({ orgName: "X", email: "a b@c.fi", source: "manual" })).toThrow();
    expect(() =>
      createOutreachProspectSchema.parse({ orgName: "X", email: "a@b.fi", source: "prh", businessId: "12345678" }),
    ).toThrow();
    expect(
      createOutreachProspectSchema.parse({ orgName: "X", email: "a@b.fi", source: "prh", businessId: "1234567-8" })
        .businessId,
    ).toBe("1234567-8");
  });

  it("caps bulk import at 1000 rows and needs at least one", () => {
    expect(() => importOutreachProspectsSchema.parse({ prospects: [] })).toThrow();
    const rows = Array.from({ length: 1001 }, (_, i) => ({ orgName: "O", email: `p${i}@x.fi`, source: "web" }));
    expect(() => importOutreachProspectsSchema.parse({ prospects: rows })).toThrow();
    expect(importOutreachProspectsSchema.parse({ prospects: rows.slice(0, 100) }).prospects).toHaveLength(100);
  });

  it("limits manual prospect status edits to new/approved and rejects empty patches", () => {
    expect(updateOutreachProspectSchema.parse({ status: "approved" }).status).toBe("approved");
    expect(() => updateOutreachProspectSchema.parse({ status: "unsubscribed" })).toThrow();
    expect(() => updateOutreachProspectSchema.parse({ email: "new@x.fi" } as never)).toThrow();
    expect(() => updateOutreachProspectSchema.parse({})).toThrow();
  });

  it("fills sequence defaults (Europe/Helsinki, Mon–Fri 08–16, cap 20, inactive)", () => {
    const seq = createOutreachSequenceSchema.parse({ name: "Intro", senderIdentity: "Hello@RK9.fi" });
    expect(seq.senderIdentity).toBe("hello@rk9.fi");
    expect(seq.dailyCap).toBe(20);
    expect(seq.active).toBe(false);
    expect(seq.sendWindow).toEqual({ tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 });
    expect(() =>
      createOutreachSequenceSchema.parse({
        name: "Bad",
        senderIdentity: "a@b.fi",
        sendWindow: { startHour: 16, endHour: 8 },
      }),
    ).toThrow();
  });

  it("normalizes suppression e-mails and defaults the reason to manual", () => {
    const s = addOutreachSuppressionSchema.parse({ email: "NoMore@Example.fi" });
    expect(s).toEqual({ email: "nomore@example.fi", reason: "manual" });
  });
});
