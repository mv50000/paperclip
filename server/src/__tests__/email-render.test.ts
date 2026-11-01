import { describe, expect, it } from "vitest";
import {
  buildFromAddress,
  renderMarkdown,
  validateOutboundHeaders,
} from "../services/email/render.js";

describe("validateOutboundHeaders", () => {
  it("accepts a clean header set", () => {
    const r = validateOutboundHeaders({
      subject: "Vahvistus",
      to: ["customer@example.com"],
      cc: ["copy@example.com"],
      replyTo: "tuki@ololla.fi",
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects CRLF in subject (header injection)", () => {
    const r = validateOutboundHeaders({
      subject: "OK\r\nBcc: attacker@evil.com",
      to: ["customer@example.com"],
    });
    expect(r).toEqual({ ok: false, field: "subject", reason: "header_injection" });
  });

  it("rejects CRLF in to address", () => {
    const r = validateOutboundHeaders({
      subject: "ok",
      to: ["customer@example.com\nBcc: leak@evil.com"],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects CRLF in cc address", () => {
    const r = validateOutboundHeaders({
      subject: "ok",
      to: ["a@b.fi"],
      cc: ["c@d.fi\rBcc: x@y.fi"],
    });
    expect(r).toEqual({ ok: false, field: "cc", reason: "header_injection" });
  });

  it("rejects CRLF in replyTo", () => {
    const r = validateOutboundHeaders({
      subject: "ok",
      to: ["a@b.fi"],
      replyTo: "x@y.fi\nBcc: z@w.fi",
    });
    expect(r).toEqual({ ok: false, field: "replyTo", reason: "header_injection" });
  });

  it("rejects clearly invalid addresses", () => {
    const r = validateOutboundHeaders({
      subject: "ok",
      to: ["not an email"],
    });
    expect(r).toEqual({ ok: false, field: "to", reason: "invalid_address" });
  });
});

describe("buildFromAddress", () => {
  it("produces a plain address when no display name", () => {
    expect(buildFromAddress("tuki", "ololla.fi")).toBe("tuki@ololla.fi");
  });

  it("quotes a display name and escapes quotes/backslashes", () => {
    const out = buildFromAddress("tuki", "ololla.fi", 'Aski "Helper" \\bot');
    expect(out).toBe('"Aski \\"Helper\\" \\\\bot" <tuki@ololla.fi>');
  });

  it("strips CRLF from display name (cannot inject headers via display name)", () => {
    const out = buildFromAddress("tuki", "ololla.fi", "Aski\r\nBcc: leak@evil.com");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
  });

  it("throws on a route key with invalid characters", () => {
    expect(() => buildFromAddress("tuki@evil", "ololla.fi")).toThrow(/invalid routeKey/);
  });
});

describe("renderMarkdown", () => {
  it("escapes HTML in user text", () => {
    const { html } = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("converts paragraphs and line breaks", () => {
    const { html } = renderMarkdown("Hei.\n\nKiitos viestistä.\nTerveisin\nAski");
    expect(html).toContain("<p>Hei.</p>");
    expect(html).toContain("Terveisin<br>Aski");
  });

  it("autolinks bare URLs", () => {
    const { html } = renderMarkdown("Katso https://ololla.fi tarkemmin.");
    expect(html).toContain('<a href="https://ololla.fi">https://ololla.fi</a>');
  });

  it("renders **bold** as <strong> in the HTML part", () => {
    const { html, text } = renderMarkdown(
      "1. **Palvelut ovat piilossa.** Avaa Palvelut.\n2. **Aukioloajat puuttuvat.** Lisää ne.",
    );
    expect(html).toContain("1. <strong>Palvelut ovat piilossa.</strong> Avaa Palvelut.<br>");
    expect(html).toContain("2. <strong>Aukioloajat puuttuvat.</strong> Lisää ne.");
    expect(html).not.toContain("**");
    expect(text).toContain("**Palvelut ovat piilossa.**");
  });

  it("escapes HTML inside a bold span", () => {
    const { html } = renderMarkdown("**<img src=x onerror=alert(1)>**");
    expect(html).toContain("<strong>&lt;img src=x onerror=alert(1)&gt;</strong>");
    expect(html).not.toContain("<img");
  });

  it("does not bold across lines or around whitespace", () => {
    expect(renderMarkdown("**alku\nloppu**").html).not.toContain("<strong>");
    expect(renderMarkdown("2 ** 3 ** 4").html).not.toContain("<strong>");
    expect(renderMarkdown("****").html).not.toContain("<strong>");
  });

  it("keeps a URL at the end of a bold span intact", () => {
    const { html } = renderMarkdown("**https://saatavilla.fi**");
    expect(html).toContain(
      '<strong><a href="https://saatavilla.fi">https://saatavilla.fi</a></strong>',
    );
  });

  it("preserves the original text version verbatim", () => {
    const md = "Hei,\n\nKiitos.";
    expect(renderMarkdown(md).text).toBe(md);
  });
});
