import { describe, expect, it } from "vitest";
import {
  containsPlaceholderText,
  countWords,
  emailDomain,
  isPrivateEmailDomain,
  runQualityGate,
} from "../services/outreach/quality-gate.js";

describe("outreach quality gate (RK9-196)", () => {
  it("rejects a message with no known e-mail address", () => {
    expect(runQualityGate({ email: null, bodyText: "Moikka, tervehdys.", suppressed: false })).toEqual({
      ok: false,
      reason: "missing_email",
    });
  });

  it("detects bracket and template-literal placeholder text", () => {
    expect(containsPlaceholderText("Hei [yritys], ...")).toBe(true);
    expect(containsPlaceholderText("Hei {{orgName}}, ...")).toBe(true);
    expect(containsPlaceholderText("Hei Acme Oy, ...")).toBe(false);
  });

  it("flags private/free e-mail domains from the AC list", () => {
    for (const domain of ["gmail.com", "hotmail.com", "outlook.com", "icloud.com"]) {
      expect(isPrivateEmailDomain(`contact@${domain}`)).toBe(true);
    }
    expect(isPrivateEmailDomain("info@acme.fi")).toBe(false);
    expect(emailDomain("Contact@Example.FI")).toBe("example.fi");
  });

  it("counts words on whitespace", () => {
    expect(countWords("  one   two three  ")).toBe(3);
    expect(countWords("")).toBe(0);
  });

  it("runs the AC checks in order: placeholder -> private domain -> suppressed -> too long", () => {
    const longBody = Array.from({ length: 121 }, (_, i) => `sana${i}`).join(" ");
    expect(
      runQualityGate({ email: "info@acme.fi", bodyText: "Hei [yritys]", suppressed: true }),
    ).toEqual({ ok: false, reason: "placeholder_text" });
    expect(
      runQualityGate({ email: "contact@gmail.com", bodyText: "Hei Acme", suppressed: true }),
    ).toEqual({ ok: false, reason: "private_email_domain" });
    expect(
      runQualityGate({ email: "info@acme.fi", bodyText: "Hei Acme", suppressed: true }),
    ).toEqual({ ok: false, reason: "suppressed" });
    expect(
      runQualityGate({ email: "info@acme.fi", bodyText: longBody, suppressed: false }),
    ).toEqual({ ok: false, reason: "too_long" });
  });

  it("passes a clean, on-brief draft", () => {
    expect(
      runQualityGate({
        email: "info@acme.fi",
        bodyText: "Hei Acme Oy, huomasimme sivunne. Sopisiko lyhyt puhelu?",
        suppressed: false,
      }),
    ).toEqual({ ok: true });
  });
});
