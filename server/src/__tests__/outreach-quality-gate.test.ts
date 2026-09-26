import { describe, expect, it } from "vitest";
import {
  allowedLinkHostSuffix,
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

  // RK9-349: the allowed link host is per template
  it("picks the allowed link host per template, defaulting to saatavilla.fi", () => {
    expect(allowedLinkHostSuffix("rk9")).toBe("rk9.fi");
    expect(allowedLinkHostSuffix("saatavilla")).toBe("saatavilla.fi");
    expect(allowedLinkHostSuffix("ololla")).toBe("saatavilla.fi");
    expect(allowedLinkHostSuffix("alli-audit")).toBe("saatavilla.fi");
    expect(allowedLinkHostSuffix(undefined)).toBe("saatavilla.fi");
  });

  it("rk9: allows one rk9.fi link and rejects saatavilla.fi and third-party links", () => {
    const gate = (bodyText: string) => runQualityGate({ email: "info@acme.fi", bodyText, suppressed: false, company: "rk9" });
    expect(gate("Keitä olemme, 30 sekunnissa: https://rk9.fi/selitys.")).toEqual({ ok: true });
    expect(gate("Ei linkkejä.")).toEqual({ ok: true });
    expect(gate("Katso https://saatavilla.fi")).toEqual({ ok: false, reason: "disallowed_link" });
    expect(gate("Katso https://hieroja-demo.saatavilla.fi")).toEqual({ ok: false, reason: "disallowed_link" });
    expect(gate("Sivunne https://www.acme.fi/")).toEqual({ ok: false, reason: "disallowed_link" });
    expect(gate("https://notrk9.fi/selitys")).toEqual({ ok: false, reason: "disallowed_link" });
    expect(gate("https://evil.example/rk9.fi")).toEqual({ ok: false, reason: "disallowed_link" });
    // still at most one link
    expect(gate("https://rk9.fi/selitys ja https://rk9.fi")).toEqual({ ok: false, reason: "disallowed_link" });
    expect(hasDisallowedLink("https://www.rk9.fi/selitys", "rk9.fi")).toBe(false);
  });

  it("saatavilla gate is unchanged when the template is passed explicitly", () => {
    for (const company of ["saatavilla", "ololla", "alli-audit"] as const) {
      const gate = (bodyText: string) => runQualityGate({ email: "info@acme.fi", bodyText, suppressed: false, company });
      expect(gate("Katso https://jooga-demo.saatavilla.fi")).toEqual({ ok: true });
      expect(gate("Katso https://rk9.fi/selitys")).toEqual({ ok: false, reason: "disallowed_link" });
    }
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
