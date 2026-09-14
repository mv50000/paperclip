import { describe, expect, it } from "vitest";
import {
  containsPlaceholderText,
  countWords,
  emailDomain,
  findLinks,
  hasDisallowedLink,
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

  it("detects bracket and template-literal placeholder text, including common leftover-template variants", () => {
    expect(containsPlaceholderText("Hei [yritys], ...")).toBe(true);
    expect(containsPlaceholderText("Hei {{orgName}}, ...")).toBe(true);
    expect(containsPlaceholderText("Hei [COMPANY_NAME], ...")).toBe(true);
    expect(containsPlaceholderText("Hei [client-name], ...")).toBe(true);
    expect(containsPlaceholderText("Hei {company}, ...")).toBe(true);
    expect(containsPlaceholderText("Ref [123], ...")).toBe(true);
    expect(containsPlaceholderText("Hei Acme Oy, ...")).toBe(false);
  });

  // RK9-223: at most one link, and only to saatavilla.fi or a subdomain
  it("allows exactly one saatavilla.fi link (demo tenant) and nothing else", () => {
    expect(hasDisallowedLink("Katso 2 minuutissa: https://hieroja-demo.saatavilla.fi — kiitos.")).toBe(false);
    expect(hasDisallowedLink("Lisää: https://saatavilla.fi.")).toBe(false);
    expect(hasDisallowedLink("Ei linkkejä tässä.")).toBe(false);
    expect(hasDisallowedLink("Katso https://timma.fi/hinnat")).toBe(true);
    expect(hasDisallowedLink("Katso www.esimerkki.fi/demo")).toBe(true);
    expect(hasDisallowedLink("https://evil.example/saatavilla.fi")).toBe(true);
    expect(hasDisallowedLink("https://notsaatavilla.fi")).toBe(true);
    // two links, even if both allowed
    expect(hasDisallowedLink("https://saatavilla.fi ja https://pt-demo.saatavilla.fi")).toBe(true);
    expect(findLinks("Demo: https://pt-demo.saatavilla.fi, kiitos")).toEqual(["https://pt-demo.saatavilla.fi"]);
  });

  it("rejects a draft with a disallowed link, after the placeholder check and before the domain check", () => {
    expect(
      runQualityGate({ email: "info@acme.fi", bodyText: "Katso https://timma.fi/hinnat", suppressed: false }),
    ).toEqual({ ok: false, reason: "disallowed_link" });
    expect(
      runQualityGate({ email: "info@gmail.com", bodyText: "[yritys] https://timma.fi", suppressed: false }),
    ).toEqual({ ok: false, reason: "placeholder_text" });
    expect(
      runQualityGate({ email: "info@gmail.com", bodyText: "Katso https://timma.fi", suppressed: false }),
    ).toEqual({ ok: false, reason: "disallowed_link" });
    expect(
      runQualityGate({ email: "info@acme.fi", bodyText: "Katso https://jooga-demo.saatavilla.fi", suppressed: false }),
    ).toEqual({ ok: true });
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
