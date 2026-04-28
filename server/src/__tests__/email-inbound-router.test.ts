import { describe, expect, it } from "vitest";
import { parseInboundAddress } from "../services/email/inbound-router.js";

describe("parseInboundAddress", () => {
  it("parses a plain address", () => {
    expect(parseInboundAddress("tuki@ololla.fi")).toEqual({
      localPart: "tuki",
      domain: "ololla.fi",
    });
  });

  it("lowercases both local-part and domain", () => {
    expect(parseInboundAddress("Tuki@OLOLLA.fi")).toEqual({
      localPart: "tuki",
      domain: "ololla.fi",
    });
  });

  it("extracts the address from a display-name form", () => {
    expect(parseInboundAddress(`"Aski Helper" <aski@ololla.fi>`)).toEqual({
      localPart: "aski",
      domain: "ololla.fi",
    });
  });

  it("trims whitespace inside the angle brackets", () => {
    expect(parseInboundAddress("Name < aski@ololla.fi >")).toEqual({
      localPart: "aski",
      domain: "ololla.fi",
    });
  });

  it("rejects an address without @", () => {
    expect(parseInboundAddress("just-a-string")).toBeNull();
  });

  it("rejects an address with @ at the start or end", () => {
    expect(parseInboundAddress("@domain.fi")).toBeNull();
    expect(parseInboundAddress("local@")).toBeNull();
  });

  it("rejects whitespace inside the local part (CRLF injection-like)", () => {
    expect(parseInboundAddress("local part@ololla.fi")).toBeNull();
    expect(parseInboundAddress("local\r\n@ololla.fi")).toBeNull();
    expect(parseInboundAddress("local\t@ololla.fi")).toBeNull();
  });

  it("rejects domain without a dot", () => {
    expect(parseInboundAddress("user@localhost")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseInboundAddress("")).toBeNull();
    expect(parseInboundAddress("   ")).toBeNull();
  });

  it("handles unicode-domain input by passing through (case-folded)", () => {
    // We don't IDN-normalise — domain is just lowercased. The route lookup
    // in the DB stores the same lowercased form, so they match.
    const out = parseInboundAddress("user@xn--mnchen-3ya.de");
    expect(out).toEqual({ localPart: "user", domain: "xn--mnchen-3ya.de" });
  });

  it("rejects an address with a null byte (defence in depth)", () => {
    expect(parseInboundAddress("user\0@ololla.fi")).toBeNull();
  });
});
