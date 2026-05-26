import { describe, expect, it } from "vitest";
import { buildRawMime, encodeAddressHeader, encodeHeaderWord } from "../services/email/mime.js";

// Decode a (possibly folded, multi-word) RFC 2047 UTF-8 base64 header value.
function decodeEncodedWords(value: string): string {
  const words = value.match(/=\?UTF-8\?B\?([^?]*)\?=/g);
  if (!words) return value;
  return words
    .map((w) => {
      const b64 = w.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
      return Buffer.from(b64, "base64").toString("utf8");
    })
    .join("");
}

function headerBlock(raw: string): string {
  return raw.split("\r\n\r\n")[0];
}

const baseInput = {
  from: "Tuki <tuki@sunspot.fi>",
  to: ["asiakas@example.com"],
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

describe("encodeHeaderWord", () => {
  it("passes ASCII through unchanged", () => {
    expect(encodeHeaderWord("Order #1234 confirmed")).toBe("Order #1234 confirmed");
  });

  it("encodes a Finnish subject and round-trips", () => {
    const out = encodeHeaderWord("Tervetuloa – tilauksesi on käsitelty");
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeEncodedWords(out)).toBe("Tervetuloa – tilauksesi on käsitelty");
  });

  it("never splits a multibyte char across encoded-words", () => {
    const original = "ä".repeat(120); // each ä = 2 UTF-8 bytes
    const out = encodeHeaderWord(original);
    // multiple words, each folded with CRLF + space, and the full value decodes back
    expect(out.split("\r\n ").length).toBeGreaterThan(1);
    expect(decodeEncodedWords(out)).toBe(original);
    // every encoded-word stays within the RFC 2047 75-char limit
    for (const w of out.split("\r\n ")) expect(w.length).toBeLessThanOrEqual(75);
  });
});

describe("encodeAddressHeader", () => {
  it("leaves a bare ASCII address alone", () => {
    expect(encodeAddressHeader("asiakas@example.com")).toBe("asiakas@example.com");
  });

  it("encodes only the phrase, keeping the addr-spec intact", () => {
    const out = encodeAddressHeader("Käyttäjä Ärrä <ceo@sunspot.fi>");
    expect(out).toMatch(/<ceo@sunspot\.fi>$/);
    expect(decodeEncodedWords(out.replace(/ <ceo@sunspot\.fi>$/, ""))).toBe("Käyttäjä Ärrä");
  });

  it("quotes an ASCII phrase with specials", () => {
    expect(encodeAddressHeader("Sunspot, Oy <ceo@sunspot.fi>")).toBe('"Sunspot, Oy" <ceo@sunspot.fi>');
  });
});

describe("buildRawMime", () => {
  it("produces a multipart/alternative with decodable text and html parts", () => {
    const raw = Buffer.from(buildRawMime({ ...baseInput, text: "Hei ä", html: "<p>Hei ä</p>" })).toString("utf8");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain("Content-Type: multipart/alternative; boundary=");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("Content-Type: text/html; charset=utf-8");

    // Pull each base64 part body and confirm it decodes to the UTF-8 original.
    const b64s = raw.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g) ?? [];
    const decoded = b64s.map((seg) => {
      const body = seg.replace(/^.*base64\r\n\r\n/s, "").replace(/\r\n--$/, "").replace(/\r\n/g, "");
      return Buffer.from(body, "base64").toString("utf8");
    });
    expect(decoded).toContain("Hei ä");
    expect(decoded).toContain("<p>Hei ä</p>");
  });

  it("uses CRLF line endings and encodes a Finnish subject in the header block", () => {
    const raw = Buffer.from(buildRawMime({ ...baseInput, subject: "Käsitelty" })).toString("utf8");
    expect(raw).toContain("\r\n");
    const hdr = headerBlock(raw);
    const subjectLine = hdr.split("\r\n").find((l) => l.startsWith("Subject:"))!;
    expect(decodeEncodedWords(subjectLine.replace("Subject: ", ""))).toBe("Käsitelty");
  });

  it("includes Cc, Reply-To and caller headers, but drops header-injection attempts", () => {
    const raw = Buffer.from(
      buildRawMime({
        ...baseInput,
        cc: ["cc@example.com"],
        replyTo: "reply@sunspot.fi",
        headers: {
          "List-Unsubscribe": "<mailto:support+unsubscribe@sunspot.fi>",
          "X-Evil": "value\r\nBcc: attacker@example.com",
        },
      }),
    ).toString("utf8");
    const hdr = headerBlock(raw);
    expect(hdr).toContain("Cc: cc@example.com");
    expect(hdr).toContain("Reply-To: reply@sunspot.fi");
    expect(hdr).toContain("List-Unsubscribe: <mailto:support+unsubscribe@sunspot.fi>");
    expect(hdr).not.toContain("X-Evil");
    expect(hdr).not.toContain("Bcc: attacker@example.com");
  });
});
