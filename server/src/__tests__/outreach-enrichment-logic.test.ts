import { describe, expect, it } from "vitest";
import { buildEnrichmentSnippet, extractGenericEmail } from "../services/outreach/enrich.js";

describe("outreach website enrichment — pure extraction (RK9-196)", () => {
  it("finds a generic/role address and ignores private/free domains", () => {
    const markdown = `
# Acme Oy

Ota yhteyttä: info@acme.fi tai soita meille.

Johtaja Matti Meikäläinen (matti.meikalainen@gmail.com) vastaa mielellään.
`;
    expect(extractGenericEmail(markdown)).toBe("info@acme.fi");
  });

  it("accepts a firstname.lastname address from a role page as a fallback", () => {
    const markdown = "Yhteystiedot\n\nliisa.virtanen@acme.fi";
    expect(extractGenericEmail(markdown)).toBe("liisa.virtanen@acme.fi");
  });

  it("returns null when no eligible address is present", () => {
    expect(extractGenericEmail("Ei sähköposteja tällä sivulla.")).toBeNull();
    expect(extractGenericEmail("random@gmail.com only")).toBeNull();
  });

  it("strips markdown noise into a short plain-text snippet", () => {
    const markdown = "# Acme\n\nTarjoamme **loistavia** palveluita. [Lue lisää](https://acme.fi/palvelut) ![kuva](x.png)";
    const snippet = buildEnrichmentSnippet(markdown);
    expect(snippet).not.toMatch(/[[\]#*]/);
    expect(snippet).toContain("Lue lisää");
    expect(snippet).toContain("Tarjoamme");
  });

  it("truncates a long snippet with an ellipsis", () => {
    const markdown = "sana ".repeat(500);
    const snippet = buildEnrichmentSnippet(markdown, 50);
    expect(snippet.length).toBeLessThanOrEqual(51);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
