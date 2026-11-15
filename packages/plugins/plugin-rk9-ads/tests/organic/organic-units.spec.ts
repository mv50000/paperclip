/** RK9-832 units: the organic write allowlist, the config block, brand-lint and the digest lines. */
import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "../../src/config.js";
import { mapGraphError, type WritePlan } from "../../src/meta/graph.js";
import { organicWriteGuard, outcomeUnknown, OrganicOutcomeUnknownError } from "../../src/meta/organic.js";
import { InvalidParamError, MetaGraphError, MetaResponseError, RateLimitError, TokenResolveError, WriteRefusedError } from "../../src/meta/errors.js";
import { captionLines, CAPTION_CHUNK_COLUMNS, chunkLine, chunkSegments, columns, displayUrl, lintLines, unwrapCaptionLines } from "../../src/organic/card.js";
import { cardDeadline, lockMedia, recheckMedia } from "../../src/organic/media-lock.js";
import { captionProblem, oneLineText } from "../../src/organic/text.js";
import { checkLint } from "../../src/organic/lint.js";
import { cleanCaption } from "../../src/organic/service.js";
import { formatDigest, type DigestInput } from "../../src/digest/format.js";
import { computePacing } from "../../src/insights/mtd.js";
import { localMonthBounds } from "../../src/kit/local-time.js";
import { brandConfig, SECRET_A_META, secretRef } from "../fixtures.js";

const IG = "17841414934844046";
const PAGE = "1284777064729996";
const PAGE_SECRET = "aaaaaaaa-0000-4000-8000-00000000000c";

function plan(method: WritePlan["method"], path: string, fields: Record<string, unknown> = {}): WritePlan {
  return { companyId: "c", mode: "live", method, path, fields };
}

describe("organicWriteGuard", () => {
  const guard = organicWriteGuard({ igUserId: IG, pageId: PAGE });
  const allowed = (p: WritePlan) => (guard(p) as { allow: boolean }).allow;

  it("allows exactly the four publish shapes", () => {
    expect(allowed(plan("POST", `${IG}/media`, { media_type: "REELS", video_url: "https://x.fi/v.mp4", caption: "c" }))).toBe(true);
    expect(allowed(plan("POST", `${IG}/media`, { image_url: "https://x.fi/i.jpg", caption: "c" }))).toBe(true);
    expect(allowed(plan("POST", `${IG}/media_publish`, { creation_id: "17900000000000001" }))).toBe(true);
    expect(allowed(plan("POST", `${PAGE}/photos`, { url: "https://x.fi/i.jpg", caption: "c" }))).toBe(true);
    expect(allowed(plan("POST", `${PAGE}/videos`, { file_url: "https://x.fi/v.mp4", description: "c" }))).toBe(true);
  });

  it("refuses ad edges, status and budget fields, other nodes, plain http and extra fields", () => {
    for (const p of [
      plan("POST", "act_29231592883113369/ads", { name: "x", status: "ACTIVE" }),
      plan("POST", "120200000000000301", { status: "ACTIVE" }),
      plan("POST", `${PAGE}/feed`, { message: "hei" }),
      plan("POST", "99999999/media", { image_url: "https://x.fi/i.jpg" }),
      plan("POST", `${IG}/media`, { image_url: "http://x.fi/i.jpg" }),
      plan("POST", `${IG}/media`, { media_type: "REELS", video_url: "https://x.fi/v.mp4", share_to_feed: true, collaborators: ["x"] }),
      plan("POST", `${IG}/media`, { media_type: "CAROUSEL", children: "1,2" }),
      plan("POST", `${IG}/media_publish`, { creation_id: "1;DROP" }),
      plan("POST", `${PAGE}/photos`, { url: "https://x.fi/i.jpg", published: false, scheduled_publish_time: 1 }),
      plan("POST", `${PAGE}/videos`, { file_url: "https://x.fi/v.mp4", daily_budget: 100 }),
      plan("POST", `${IG}/media`, { image_url: "https://x.fi/i.jpg", caption: "x".repeat(2201) }),
      plan("DELETE", "17900000000000002"),
    ]) {
      expect(allowed(p), `${p.method} ${p.path} ${JSON.stringify(p.fields)}`).toBe(false);
    }
  });

  it("allows a delete of only the named object", () => {
    const del = organicWriteGuard({ igUserId: IG, pageId: PAGE, deleteId: "17900000000000002" });
    expect((del(plan("DELETE", "17900000000000002")) as { allow: boolean }).allow).toBe(true);
    expect((del(plan("DELETE", "17900000000000003")) as { allow: boolean }).allow).toBe(false);
    expect((del(plan("DELETE", "17900000000000002", { x: 1 })) as { allow: boolean }).allow).toBe(false);
  });
});

describe("organic config", () => {
  it("parses organic.mediaHosts as lowercase exact hostnames and refuses a URL or a port (RK9-852)", () => {
    const meta = { adAccountId: "act_1", pageId: "1", igUserId: "2", accessTokenRef: secretRef(SECRET_A_META) };
    const ok = parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["ig_reel"], mediaHosts: ["Media.Ololla.fi", "media.ololla.fi"], mediaHostTtlHours: 2 } }));
    expect(ok.state).toBe("enabled");
    if (ok.state !== "enabled") throw new Error("unreachable");
    expect(ok.config.organic).toMatchObject({ mediaHosts: ["media.ololla.fi"], mediaHostTtlHours: 2 });
    const none = parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["ig_reel"] } }));
    if (none.state !== "enabled") throw new Error("unreachable");
    expect(none.config.organic!.mediaHosts).toEqual([]);
    expect(none.config.organic!.mediaHostTtlHours).toBeUndefined();
    for (const bad of [["https://media.ololla.fi"], ["media.ololla.fi:443"], ["localhost"]]) {
      expect(parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["ig_reel"], mediaHosts: bad } })).state).toBe("invalid");
    }
    expect(parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["ig_reel"], mediaHostTtlHours: 0 } })).state).toBe("invalid");
  });

  const meta = { adAccountId: "act_29231592883113369", pageId: PAGE, igUserId: IG, accessTokenRef: secretRef(SECRET_A_META) };

  it("defaults to dry run and parses the channels", () => {
    const result = parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["ig_reel", "ig_reel", "ig_feed"] } }));
    expect(result.state).toBe("enabled");
    if (result.state !== "enabled") return;
    expect(result.config.organic).toMatchObject({ enabled: true, mode: "dry_run", channels: ["ig_reel", "ig_feed"], cardTtlHours: 24 });
  });

  it("requires a Page token for FB channels, an IG user for IG channels and at least one channel", () => {
    const fb = parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["fb_photo"] } }));
    expect(fb.state).toBe("invalid");
    expect(JSON.stringify(fb)).toMatch(/pageAccessTokenRef/);
    const ig = parseBrandConfig(brandConfig({ organic: { enabled: true, channels: ["ig_reel"] } }));
    expect(ig.state).toBe("invalid");
    expect(JSON.stringify(ig)).toMatch(/igUserId/);
    expect(parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: [] } })).state).toBe("invalid");
    expect(parseBrandConfig(brandConfig({ meta, organic: { enabled: true, channels: ["ig_story"] } })).state).toBe("invalid");
    expect(parseBrandConfig(brandConfig({ meta, organic: { enabled: true, mode: "yolo", channels: ["ig_reel"] } })).state).toBe("invalid");
    const ok = parseBrandConfig(brandConfig({ meta, organic: { enabled: true, mode: "live", channels: ["fb_photo"], pageAccessTokenRef: secretRef(PAGE_SECRET) } }));
    expect(ok.state).toBe("enabled");
  });
});

describe("organic brand-lint", () => {
  const row = (status: string, id = "r") => ({ id, rule: id, status });

  it("passes a strict result and counts the human rows", () => {
    const result = checkLint({ brand: "sunspot", mode: "strict", ok: true, results: [row("pass"), row("human", "h"), row("skip", "s")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lint.summary).toEqual({ pass: 1, partial: 0, fail: 0, skip: 1, human: 1 });
  });

  it("does not trust ok: a fail row refuses even when ok is true", () => {
    expect(checkLint({ brand: "sunspot", mode: "strict", ok: true, results: [row("fail", "safe_top")] })).toMatchObject({ ok: false, code: "lint_failed" });
    expect(checkLint({ brand: "sunspot", mode: "strict", ok: false, results: [row("pass")] })).toMatchObject({ ok: false, code: "lint_failed" });
    expect(checkLint({ brand: "sunspot", mode: "draft", ok: true, results: [row("pass")] })).toMatchObject({ ok: false, code: "lint_draft" });
    expect(checkLint("ok")).toMatchObject({ ok: false, code: "invalid_lint" });
    expect(checkLint({ brand: "sunspot", mode: "strict", ok: true, results: [row("maybe")] })).toMatchObject({ ok: false, code: "invalid_lint" });
  });
});

describe("organic digest lines", () => {
  function day(overrides: Partial<DigestInput> = {}): DigestInput {
    return {
      brandName: "Ololla",
      reportDate: "2026-11-13",
      currency: "EUR",
      yesterday: { spendCents: 0, impressions: 0, clicks: 0, inlineLinkClicks: 0 },
      cpcWarnEur: 0.5,
      zeroSpendMode: "silent",
      pacing: computePacing({ month: localMonthBounds(new Date("2026-11-14T09:00:00Z")), mtdCents: 0, completeDaysCents: 0, monthlyCapEur: 100 }),
      spendCap: { capCents: 10000, headroomCents: 10000 },
      activeAds: 0,
      fatigued: [],
      ruleActions: [],
      pendingGates: [],
      warnings: [],
      ...overrides,
    };
  }

  it("lists each post outcome; a quiet day with only organic news still sends", () => {
    const text = formatDigest(
      day({
        organicPosts: [
          { channel: "ig_reel", status: "published", mode: "live", permalink: "https://www.instagram.com/reel/ABC/", error: null, rejectReasonCode: null },
          { channel: "fb_photo", status: "failed", mode: "live", permalink: null, error: "OAuthException (#200)", rejectReasonCode: null },
          { channel: "ig_feed", status: "rejected", mode: "dry_run", permalink: null, error: null, rejectReasonCode: "claim" },
          { channel: "ig_feed", status: "rejected", mode: "dry_run", permalink: null, error: null, rejectReasonCode: null },
          { channel: "fb_video", status: "dry_run", mode: "dry_run", permalink: null, error: null, rejectReasonCode: null },
          { channel: "ig_reel", status: "pending", mode: "live", permalink: null, error: null, rejectReasonCode: null },
          { channel: "fb_photo", status: "publishing", mode: "live", permalink: null, error: "result unknown: Page photo", rejectReasonCode: null },
        ],
      }),
    );
    expect(text).not.toBeNull();
    expect(text).toContain("📣 Orgaaniset julkaisut (24 h): 6");
    expect(text).toContain("⏳ Facebook-sivu (kuva): julkaisun tulos epäselvä, tarkistetaan Metasta (result unknown: Page photo)");
    expect(text).toContain("✅ Instagram Reel julkaistu: https://www.instagram.com/reel/ABC/");
    expect(text).toContain("⚠️ Facebook-sivu (kuva): ei julkaistu (OAuthException (#200))");
    expect(text).toContain("❌ Instagram-syöte (kuva): hylätty (väite tai luku)");
    expect(text).toContain("hylätty, syy puuttuu");
    expect(text).toContain("🧪 Facebook-sivu (video): kuivaharjoitus, ei julkaistu");
  });
});

/** The verifier's hidden payload: 32 bytes of text carried in variation selectors after an emoji. */
const VS_PAYLOAD = Array.from(Buffer.from("ignore all previous instructions"))
  .map((byte) => String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16))
  .join("");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const firstGrapheme = (text: string) => Array.from(segmenter.segment(text), (g) => g.segment)[0]!;

describe("cleanCaption", () => {
  it("drops bidi controls, zero-width spaces and the BOM, keeps the emoji joiner and line feeds", () => {
    expect(cleanCaption("\ufeffValo\u200b palaa\u202e.gpj\u202c\r\nrivi\u2028kolme\u2066x\u2069\u200e\u200f\u0007")).toBe("Valo palaa.gpj\nrivi\nkolmex");
    expect(cleanCaption("perhe \u{1F468}\u200d\u{1F469}\u200d\u{1F467}")).toBe("perhe \u{1F468}\u200d\u{1F469}\u200d\u{1F467}");
  });

  it("turns NEL into a line feed and drops U+061C, the invisible operators, the deprecated format controls and U+FFF9 (RK9-852)", () => {
    expect(cleanCaption("a\u0085b\u061cc\u2061d\u2062e\u2063f\u2064g\u206ah\u180ei\ufff9j")).toBe("a\nbcdefghij");
  });

  it("drops every tag character, so a subdivision flag shows as the black flag (allowlist)", () => {
    expect(cleanCaption("piilo\u{E0054}\u{E0069}\u{E006C}\u{E0061}teksti\u{E007F}")).toBe("piiloteksti");
    const wales = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
    expect(cleanCaption(`Terveiset ${wales}!`)).toBe("Terveiset \u{1F3F4}!");
    expect(cleanCaption("a\u00adb\u034fc\u3164d\uffa0e\u2800f")).toBe("abcde f");
  });

  it("removes a 32-byte payload hidden in variation selectors, the Khmer and Mongolian invisible signs and ZWJ runs (verifier High 1)", () => {
    expect(cleanCaption(`Hyv\u00e4\u00e4 huomenta \u{1F600}${VS_PAYLOAD} kaikille`)).toBe("Hyv\u00e4\u00e4 huomenta \u{1F600} kaikille");
    expect(cleanCaption("a\u17b4\u17b5b\u180b\u180c\u180d\u180fc")).toBe("abc");
    expect(cleanCaption(`a${"\u200d".repeat(50)}b`)).toBe("ab");
    expect(cleanCaption("a\ufe0fb\ufe00c")).toBe("abc");
  });

  it("keeps U+FE0F once right after an emoji and the ZWJ only between two emoji", () => {
    expect(cleanCaption("\u2764\ufe0f\ufe0f")).toBe("\u2764\ufe0f");
    expect(cleanCaption("\u{1F3F3}\ufe0f\u200d\u{1F308}")).toBe("\u{1F3F3}\ufe0f\u200d\u{1F308}");
    expect(cleanCaption("\u{1F468}\u{1F3FD}\u200d\u{1F4BB}")).toBe("\u{1F468}\u{1F3FD}\u200d\u{1F4BB}");
    expect(cleanCaption("\u{1F600}\u200da \u{1F600}\u200d\u200d\u{1F600}")).toBe("\u{1F600}a \u{1F600}\u200d\u{1F600}");
  });

  it("turns every space separator into U+0020, drops lone surrogates and normalises to NFC", () => {
    expect(cleanCaption(`a${"\u2001".repeat(3)}b\u00a0c\u3000d`)).toBe("a b c d");
    expect(cleanCaption("a\ud83db\udc00c")).toBe("abc");
    expect(cleanCaption("e\u0301")).toBe("\u00e9");
  });

  it("keeps a mark only on a base of its own script or when it is Inherited/Common, two at most; drops enclosing marks (verifier High 2)", () => {
    expect(cleanCaption("x\u0941\u0941")).toBe("x");
    expect(cleanCaption("\u0915\u094d\u0937\u093f")).toBe("\u0915\u094d\u0937\u093f");
    expect(cleanCaption("\u0645\u064e\u0631\u0652")).toBe("\u0645\u064e\u0631\u0652");
    expect(cleanCaption("a\u0301\u0308\u0302\u0303")).toBe("\u00e1\u0308\u0302");
    expect(cleanCaption("W\u20dd\u20dd W\ua670\ua670 1\ufe0f\u20e3")).toBe("W W 1");
  });

  it("is a fixed point: cleaning a cleaned caption changes nothing", () => {
    const samples = [
      `\u{1F600}${VS_PAYLOAD}`, "x\u0941\u0941", "a\u0301\u0301\u0301", "\u{1F3F3}\ufe0f\u200d\u{1F308}", "e\u034f\u0301", "a\u0085b",
      `${"\u2001".repeat(10)}Tila: LIVE`, "\u0e01\u0e48\u0e33", "\u2800\u2800x",
    ];
    for (const sample of samples) {
      const once = cleanCaption(sample);
      expect(cleanCaption(once), JSON.stringify(sample)).toBe(once);
    }
  });

  it("oneLineText turns NEL and line feeds into spaces and drops bidi controls", () => {
    expect(oneLineText("Logo\u0085Tila:\n\u{1F9EA} x\u202e  y")).toBe("Logo Tila: \u{1F9EA} x y");
  });
});

describe("caption chunks (RK9-852)", () => {
  it("splits a long line into chunks of at most CAPTION_CHUNK_COLUMNS columns without losing text", () => {
    const line = "Valo palaa Helsinkiin ja aurinko nousee taas joka aamu aikaisemmin kuin eilen";
    const chunks = chunkLine(line);
    expect(unwrapCaptionLines(captionLines(line))).toBe(line);
    expect(chunks.every((chunk) => [...chunk].length <= CAPTION_CHUNK_COLUMNS)).toBe(true);
    expect(chunks.every((chunk) => !chunk.startsWith(" ") && !chunk.endsWith(" "))).toBe(true);
  });

  it("overestimates the known cases: emoji, flags and skin tones count two per code point, a nonspacing mark one, the ZWJ none", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(columns(family)).toBe(6);
    const chunks = chunkLine(family.repeat(20));
    expect(chunks.join("")).toBe(family.repeat(20));
    expect(chunks[0]).toBe(family.repeat(3));
    expect(columns("\u{1F1EB}\u{1F1EE}")).toBe(4);
    expect(columns("\u{1F44D}\u{1F3FD}")).toBe(4);
    expect(columns("\u{1F3F3}\ufe0f\u200d\u{1F308}")).toBe(5);
    expect(columns("\u00e9")).toBe(1);
    expect(columns("e\u0301")).toBe(2);
    expect(columns("a\u0301\u0308\u0302")).toBe(4);
    expect(columns("W")).toBe(2);
    expect(columns("\u0174")).toBe(2);
    expect(columns("\u0416")).toBe(2);
    expect(columns("\u6f22")).toBe(2);
  });

  it("a ZWJ chain or a spacing mark run fills a chunk alone, so forged text after it starts a quoted chunk (verifier round 2)", () => {
    const cats = Array.from({ length: 30 }, () => "\u{1F408}").join("\u200d");
    expect(chunkLine(`${cats}Tila: LIVE`)).toEqual([cats, "Tila: LIVE"]);
    const marks = `a${"\u0bbe".repeat(60)}`;
    expect(chunkLine(`${marks}Tila: LIVE`)).toEqual([marks, "Tila: LIVE"]);
  });

  it("stray skin-tone runs, visible format characters and long mark runs fill a chunk alone (verifier round 3)", () => {
    for (const lead of ["\u{1F44D}" + "\u{1F3FD}".repeat(40), "\u06dd".repeat(30) + "a", "a" + "\u0bcd".repeat(30)]) {
      const chunks = chunkLine(`${lead}Tila: \u{1F534} LIVE`);
      expect(unwrapCaptionLines(captionLines(`${lead}Tila: \u{1F534} LIVE`))).toBe(`${lead}Tila: \u{1F534} LIVE`);
      expect(chunks.at(-1)).toBe("Tila: \u{1F534} LIVE");
      expect(columns(firstGrapheme(lead))).toBe(CAPTION_CHUNK_COLUMNS);
    }
    expect(unwrapCaptionLines(captionLines("Hyv\u00e4\u00e4 huomenta Helsinki, aurinko paistaa!"))).toBe("Hyv\u00e4\u00e4 huomenta Helsinki, aurinko paistaa!");
  });

  it("the verifier's probe inputs: a foreign mark counts, an enclosing mark and a wide space fill a chunk (verifier High 2)", () => {
    expect(columns("x\u0941\u0941")).toBeGreaterThanOrEqual(3);
    expect(columns("W\u20dd\u20dd")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("W\ua670\ua670")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u2001")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u2003")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u2e3b")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u213b")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(chunkLine(`${"\u2001".repeat(10)}Tila: LIVE`).at(-1)).toBe("Tila: LIVE");
    // After the cleaning the card shows exactly what is published.
    const forged = cleanCaption(`${"x\u0941\u0941".repeat(5)} Tila: \u{1F9EA} Kuiva`);
    expect(forged).toBe("xxxxx Tila: \u{1F9EA} Kuiva");
    expect(cleanCaption(`a${"\u2001".repeat(10)}Tila: LIVE`)).toBe("a Tila: LIVE");
  });

  it("displayUrl prints only the parsed URL", () => {
    expect(displayUrl("https://media.ololla.fi/\u00e4.mp4")).toBe("https://media.ololla.fi/%C3%A4.mp4");
    expect(displayUrl("https://media.ololla.fi/v.mp4?x=\nTila: LIVE")).toBe("https://media.ololla.fi/v.mp4?x=Tila:%20LIVE");
    expect(displayUrl("not a url")).toBe("(virheellinen osoite)");
  });

  it("puts a glyph of an uncommon script in a chunk of its own (M1)", () => {
    expect(chunkLine("\ufdfd\ufdfd\ufdfd Tila: x")).toEqual(["\ufdfd", "\ufdfd", "\ufdfd", "Tila: x"]);
  });

  it("opens each caption line with the quote mark and each continuation with the dashed mark", () => {
    const letter = "\u00e4";
    expect(captionLines(`${letter.repeat(30)}Tila: LIVE\nok`)).toEqual([`\u2502 ${letter.repeat(20)}`, `\u21b3 ${letter.repeat(10)}Tila: LIVE`, "\u2502 ok"]);
    expect(captionLines("")).toEqual(["(ei teksti\u00e4)"]);
  });
});

describe("cleanCaption: hidden channels (RK9-852 verifier round 2)", () => {
  it("removes a message carried in braille blanks against spaces (SECRET42)", () => {
    const bits = Array.from(Buffer.from("SECRET42")).flatMap((byte) => Array.from({ length: 8 }, (_, k) => (byte >> (7 - k)) & 1));
    const words = Array.from({ length: 65 }, (_, i) => ["kahvi", "ja", "pulla", "t\u00e4n\u00e4\u00e4n", "meill\u00e4"][i % 5]!);
    const stego = words.map((word, i) => (i === 0 ? word : (bits[i - 1] ? "\u2800" : " ") + word)).join("");
    const clean = cleanCaption(stego);
    expect(clean).not.toContain("\u2800");
    expect(clean).toBe(words.join(" "));
  });

  it("drops spaces at the end of a line, collapses space runs and keeps at most two line feeds in a row", () => {
    const lines = Array.from(Buffer.from("SECRET42")).map((byte) => `rivi${" ".repeat(byte & 0x0f)}`);
    expect(cleanCaption(`${lines.join("\n")}\nloppu`)).toBe(`${Array.from({ length: 8 }, () => "rivi").join("\n")}\nloppu`);
    expect(cleanCaption("a   b\u2003\u2003c")).toBe("a b c");
    expect(cleanCaption("a\n\n\n\n\nb\n \n \n c")).toBe("a\n\nb\n\nc");
  });

  it("removes private-use, unassigned and noncharacter code points as base characters", () => {
    expect(cleanCaption("Hei \u{F0000}\u{F1234}\u{10FFFD}\ue000 kaikki")).toBe("Hei kaikki");
    expect(cleanCaption("Hei\u2072\u2073\u208f\uff00\uffe7 kaikki")).toBe("Hei kaikki");
    expect(cleanCaption("a\ufdd0\ufffeb\u{1FFFF}c")).toBe("abc");
    expect(columns("\u2072")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\uff00")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\ue000")).toBe(CAPTION_CHUNK_COLUMNS);
  });

  it("keeps a combining mark only on a letter or a digit, not on a space, punctuation or a line start (L3)", () => {
    expect(cleanCaption(" \u0301Hei")).toBe("Hei");
    expect(cleanCaption("a \u0301b !\u0301 1\u0301")).toBe("a b ! 1\u0301");
    expect(cleanCaption("x\n\u0301y")).toBe("x\ny");
  });

  it("is a fixed point on 20 000 random inputs (fixed seed)", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const specials = [0x200d, 0xfe0f, 0x20, 0x0a, 0x0d, 0x85, 0x2028, 0x3000, 0x2800, 0x0301, 0x094d, 0x0915, 0x1100, 0x1161, 0x11a8, 0xac00, 0x41, 0x1f3fb];
    const pools = [
      () => Math.floor(random() * 0x110000),
      () => 0x300 + Math.floor(random() * 0x70),
      () => 0x1f300 + Math.floor(random() * 0x300),
      () => specials[Math.floor(random() * specials.length)]!,
      () => 0xd800 + Math.floor(random() * 0x800),
    ];
    const failures: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      let input = i === 0 ? " \u0301Hei" : "";
      const length = 1 + Math.floor(random() * 12);
      for (let j = 0; j < length; j += 1) {
        const point = pools[Math.floor(random() * pools.length)]!();
        input += point >= 0xd800 && point <= 0xdfff ? String.fromCharCode(point) : String.fromCodePoint(point);
      }
      const once = cleanCaption(input);
      if (cleanCaption(once) !== once || once !== once.normalize("NFC") || /\p{Surrogate}/u.test(once)) failures.push(JSON.stringify(input));
    }
    expect(failures).toEqual([]);
  });
});

describe("caption chunks: the width list (RK9-852 verifier round 2)", () => {
  it("counts one column only for ASCII and the named letters; other Latin letters two; digraphs fill a chunk", () => {
    for (const narrow of ["a", "\u00e4", "\u00f6", "\u00e5", "\u00f5", "\u00fc", "\u00df", "\u0161", "\u017e", "\u0160", "\u017d", "\u1e9e"]) expect(columns(narrow), narrow).toBe(1);
    for (const two of ["\u0238", "\u01f6", "\u019c", "\ua732", "\u0101", "\u0142"]) expect(columns(two), two).toBe(2);
    for (const wide of ["\u01c4", "\u01c5", "\u01c6", "\u01c7", "\u01ca", "\u01f1", "\u0132", "\u1efa", "\ufb03"]) expect(columns(wide), wide).toBe(CAPTION_CHUNK_COLUMNS);
    expect(captionLines(cleanCaption(`${"\u01c4".repeat(14)}Tila:`)).at(-1)).toBe("\u21b3 Tila:");
  });

  it("long arrows, multi-line brackets and unlisted symbols fill a chunk alone", () => {
    for (const glyph of ["\u27ff", "\u27f7", "\u23dc", "\u23de", "\u2b33", "\u2031", "\u2e3a", "\u2e3b", "\u216b", "\u338f", "\u337b", "\u0bf5"]) {
      expect(columns(glyph), glyph).toBe(CAPTION_CHUNK_COLUMNS);
    }
    for (const glyph of ["\u263a", "\u00a9", "\u2122", "\u2194", "\u2026", "\u3231"]) expect(columns(glyph), glyph).toBe(2);
    expect(captionLines(cleanCaption("\u27ff\u27ff\u27ffTila: \u{1F534}")).at(-1)).toBe("\u21b3 Tila: \u{1F534}");
  });
});

describe("cleanCaption and columns (RK9-852 verifier round 3)", () => {
  it("removes U+FFFC, U+FFFD, U+1D159 and the fillers; a line of only such characters is left empty", () => {
    expect(cleanCaption("a\u{1D159}b")).toBe("ab");
    expect(cleanCaption("a\ufffcb")).toBe("ab");
    expect(cleanCaption("a\ufffdb\u3164c\u115fd\u1160e\uffa0f\u{16FE4}g")).toBe("abcdefg");
    expect(cleanCaption("a\u1680b")).toBe("a b");
    expect(cleanCaption("a\n\u{1D159}")).toBe("a");
    expect(cleanCaption("a\n\u{1D159}\u{1D159}\nb")).toBe("a\n\nb");
    expect(cleanCaption("a\n\u{1D159}\n\u{1D159}\n\u{1D159}\nb")).toBe("a\n\nb");
  });

  it("drops spaces at the start of a line", () => {
    for (const input of ["a \n b", "a\n\u2800b", "a\n\u3000b", "a\n   b"]) expect(cleanCaption(input), JSON.stringify(input)).toBe("a\nb");
  });

  it("U+2103, U+2109 and U+2116 fill a chunk; the wide Malayalam vowel signs fill a chunk before the spacing-mark rule", () => {
    for (const glyph of ["\u2103", "\u2109", "\u2116"]) expect(columns(glyph), glyph).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u0d15\u0d4c")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u0d15\u0d57")).toBe(CAPTION_CHUNK_COLUMNS);
    expect(columns("\u0d15\u0d3e")).toBe(4);
  });
});

describe("the card is injective: a space at a chunk break stays visible (RK9-852 verifier round 4)", () => {
  const card = (caption: string) => captionLines(cleanCaption(caption)).map((line) => line.trimEnd()).join("\n");

  it("the verifier's two mentions give two different cards", () => {
    const pairs = [
      ["Hi @ololla_finland Mukaan kes\u00e4n tapahtumaan!", "Hi @ololla_finlandMukaan kes\u00e4n tapahtumaan!"],
      ["Seuraa @ololla_suomi Wau mik\u00e4 ilta meill\u00e4 oli!", "Seuraa @ololla_suomiWau mik\u00e4 ilta meill\u00e4 oli!"],
      ["Katso #kes\u00e4tarjous24 nyt heti", "Katso #kes\u00e4tarjous24nyt heti"],
    ];
    for (const [a, b] of pairs) {
      expect(card(a!)).not.toBe(card(b!));
      expect(unwrapCaptionLines(captionLines(cleanCaption(a!)))).toBe(cleanCaption(a!));
      expect(unwrapCaptionLines(captionLines(cleanCaption(b!)))).toBe(cleanCaption(b!));
    }
    expect(captionLines("Hi @ololla_finland Mukaan")).toEqual(["\u2502 Hi @ololla_finland", "\u2506 Mukaan"]);
    expect(captionLines("Hi @ololla_finlandMukaan")).toEqual(["\u2502 Hi @ololla_finland", "\u21b3 Mukaan"]);
  });

  it("a prepended mark before a space (U+0D4E, U+11A3A) never pulls the space into a chunk end", () => {
    for (const prepend of ["\u0d4e", "\u{11A3A}"]) {
      for (let lead = 10; lead <= 22; lead += 1) {
        const line = cleanCaption(`${"x".repeat(lead)}${prepend} Tila: LIVE ja ${prepend} muuta`);
        const lines = captionLines(line).map((card) => card.trimEnd());
        expect(unwrapCaptionLines(lines), JSON.stringify(line)).toBe(line);
        expect(chunkLine(line).some((chunk) => chunk.startsWith(" ") || chunk.endsWith(" "))).toBe(false);
      }
    }
  });

  it("20 000 seeded pairs that differ by one space near a chunk break give different cards, also after trimming line ends", () => {
    let seed = 852;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = "abcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00e5_@#WM0123456789.,!";
    const extras = ["\u{1F600}", "\u00e9", "\u0416", "\u6f22", "\u2026"];
    const word = () => {
      let out = "";
      const length = 1 + Math.floor(random() * 14);
      for (let i = 0; i < length; i += 1) out += random() < 0.05 ? extras[Math.floor(random() * extras.length)]! : alphabet[Math.floor(random() * alphabet.length)]!;
      return out;
    };
    const failures: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const words = Array.from({ length: 2 + Math.floor(random() * 10) }, word);
      const base = words.join(" ");
      // The spaces of the line, the ones the chunker consumed at a break first.
      const segments = chunkSegments(base);
      let offset = 0;
      const breakSpaces: number[] = [];
      for (const [index, segment] of segments.entries()) {
        if (index > 0 && segment.join === "space") breakSpaces.push(offset - 1);
        offset += Array.from(segment.text).length + (segments[index + 1]?.join === "space" ? 1 : 0);
      }
      const points = Array.from(base);
      const spaces = points.flatMap((point, index) => (point === " " ? [index] : []));
      const candidates = breakSpaces.length > 0 && random() < 0.7 ? breakSpaces : spaces;
      const at = candidates[Math.floor(random() * candidates.length)]!;
      const variant = [...points.slice(0, at), ...points.slice(at + 1)].join("");
      if (card(base) === card(variant)) failures.push(JSON.stringify([base, variant]));
      for (const caption of [base, variant]) {
        const clean = cleanCaption(caption);
        if (unwrapCaptionLines(captionLines(clean).map((line) => line.trimEnd())) !== clean) failures.push(`unwrap ${JSON.stringify(caption)}`);
        if (chunkLine(clean).some((chunk) => chunk.startsWith(" ") || chunk.endsWith(" "))) failures.push(`space ${JSON.stringify(caption)}`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe("captionProblem (RK9-852 verifier round 4)", () => {
  it("refuses right-to-left text and a grapheme of more than 10 code points, and passes ordinary captions", () => {
    for (const rtl of ["\u05e9\u05dc\u05d5\u05dd", "Hei \u0645\u0631\u062d\u0628\u0627", "\u0710", "\u0780", "\u07ca", "\ufb1d", "\ufe8d", "\u{10900}", "\u{1E900}"]) {
      expect(captionProblem(cleanCaption(rtl)), rtl).toMatch(/right-to-left/);
    }
    const chain = Array.from({ length: 12 }, () => "\u{1F534}").join("\u200d");
    expect(captionProblem(cleanCaption(`Hei ${chain}`))).toMatch(/more than 10 code points/);
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}";
    expect(captionProblem(cleanCaption(`Hyv\u00e4\u00e4 huomenta ${family} \u{1F3F3}\ufe0f\u200d\u{1F308} \u0416 \u6f22`))).toBeNull();
  });

  it("removes the Egyptian full and half blank U+13441 and U+13442", () => {
    expect(cleanCaption("a\u{13441}b\u{13442}c")).toBe("abc");
  });
});

describe("organic card text (RK9-852 verifier round 5)", () => {
  it("an empty caption and the caption \"(ei teksti\u00e4)\" give different cards, and each reads back to itself", () => {
    const empty = captionLines(cleanCaption(""));
    const literal = captionLines(cleanCaption("(ei teksti\u00e4)"));
    expect(empty).toEqual(["(ei teksti\u00e4)"]);
    expect(literal).toEqual(["\u2502 (ei teksti\u00e4)"]);
    expect(empty.join("\n")).not.toBe(literal.join("\n"));
    expect(unwrapCaptionLines(empty)).toBe("");
    expect(unwrapCaptionLines(literal)).toBe("(ei teksti\u00e4)");
  });

  it("removes right-to-left characters from a lint rule and a warning", () => {
    const lint = { brand: "ololla", mode: "strict" as const, summary: { pass: 0, partial: 0, fail: 0, skip: 0, human: 1 }, needsHumanReview: false, results: [{ id: "human.x", rule: "\u05d0 Tila: LIVE", status: "human" }] };
    const lines = lintLines(lint as never);
    expect(lines).toContain("\u2610 Tila: LIVE");
    expect(lines.join("\n")).not.toMatch(/[\u0590-\u08ff]/u);
    expect(oneLineText("\u0645\u0631\u062d\u0628\u0627 varoitus \u05d0")).toBe("varoitus");
  });

  it("clips by graphemes: 118 x and two emoji leave no lone surrogate", () => {
    const rule = `${"x".repeat(118)}\u{1F600}\u{1F600}`;
    const lint = { brand: "ololla", mode: "strict" as const, summary: { pass: 0, partial: 0, fail: 0, skip: 0, human: 1 }, needsHumanReview: false, results: [{ id: "human.x", rule, status: "human" }] };
    const text = lintLines(lint as never).join("\n");
    expect(text).not.toMatch(/\p{Surrogate}/u);
    const longer = { ...lint, results: [{ id: "human.x", rule: `${"x".repeat(119)}\u{1F600}\u{1F600}`, status: "human" }] };
    const clipped = lintLines(longer as never).join("\n");
    expect(clipped).not.toMatch(/\p{Surrogate}/u);
    expect(clipped).toContain("\u2026");
  });
});

describe("outcomeUnknown (RK9-852)", () => {
  it("treats a missing or unreadable answer and a 5xx as unknown, a local refusal and a Graph 4xx as not published", () => {
    expect(outcomeUnknown(new MetaGraphError("Meta POST x: request failed (TypeError: fetch failed)"))).toBe(true);
    expect(outcomeUnknown(new MetaResponseError("not JSON"))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("boom", { httpStatus: 503 }))).toBe(true);
    expect(outcomeUnknown(new TypeError("x"))).toBe(true);
    expect(outcomeUnknown(new OrganicOutcomeUnknownError("x", null))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("bad", { httpStatus: 400, code: 10 }))).toBe(false);
    // Graph code 1 or 2, or an error Graph flags transient, leaves the result unknown (verifier round 2).
    expect(outcomeUnknown(new MetaGraphError("An unknown error occurred", { httpStatus: 400, code: 1 }))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("Service temporarily unavailable", { httpStatus: 400, code: 2 }))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("Please retry", { httpStatus: 400, code: 368, isTransient: true }))).toBe(true);
    const parsed = mapGraphError(400, { message: "Please retry", code: 368, is_transient: true } as never, "Meta POST x", []);
    expect(parsed.isTransient).toBe(true);
    expect(outcomeUnknown(parsed)).toBe(true);
    expect(outcomeUnknown(mapGraphError(400, { message: "Invalid", code: 368, is_transient: false } as never, "Meta POST x", []))).toBe(false);
    // A 4xx without a readable Graph error body did not come from Graph (verifier Low).
    expect(outcomeUnknown(new MetaGraphError("Meta POST x: HTTP 403", { httpStatus: 403 }))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("Meta POST x: HTTP 404", { httpStatus: 404, type: "OAuthException" }))).toBe(false);
    expect(outcomeUnknown(new RateLimitError("slow", { httpStatus: 400, code: 4 }))).toBe(false);
    expect(outcomeUnknown(new InvalidParamError("caption too long"))).toBe(false);
    expect(outcomeUnknown(new WriteRefusedError("POST", "x", "guard"))).toBe(false);
    expect(outcomeUnknown(new TokenResolveError("no token"))).toBe(false);
  });
});

describe("media lock (RK9-852 M2)", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  const url = "https://media.ololla.fi/v.mp4";
  const answer = (status: number, headers: Record<string, string>) => async () => new Response(null, { status, headers });
  const good = { "content-type": "video/mp4", "content-length": "100", etag: '"a"', "last-modified": "Sun, 15 Nov 2026 09:00:00 GMT" };

  it("refuses http, a port and credentials in the URL", async () => {
    for (const bad of ["http://media.ololla.fi/v.mp4", "https://media.ololla.fi:8443/v.mp4", "https://u:p@media.ololla.fi/v.mp4"]) {
      expect(await lockMedia(answer(200, good), { url: bad, mode: "dry_run", mediaHosts: ["media.ololla.fi"], now })).toMatchObject({ ok: false, code: "media_untrusted" });
    }
  });

  it("matches the host exactly: a subdomain or a look-alike is not trusted", async () => {
    for (const bad of ["https://evil.media.ololla.fi/v.mp4", "https://media.ololla.fi.evil.fi/v.mp4"]) {
      expect(await lockMedia(answer(200, good), { url: bad, mode: "live", mediaHosts: ["media.ololla.fi"], now })).toMatchObject({ ok: false, code: "media_untrusted" });
    }
  });

  it("computes the expiry from Last-Modified and cuts the card deadline 10 min before it", async () => {
    const locked = await lockMedia(answer(200, good), { url, mode: "live", mediaHosts: ["media.ololla.fi"], mediaHostTtlHours: 2, now });
    expect(locked).toMatchObject({ ok: true, lock: { expiresAt: "2026-11-15T11:00:00.000Z" } });
    if (!locked.ok) throw new Error("unreachable");
    expect(cardDeadline(locked.lock, new Date("2026-11-16T10:00:00Z")).toISOString()).toBe("2026-11-15T10:50:00.000Z");
    expect(cardDeadline(locked.lock, new Date("2026-11-15T10:30:00Z")).toISOString()).toBe("2026-11-15T10:30:00.000Z");
  });

  it("recheck: a header that vanished counts as a change, the same answer passes", async () => {
    const locked = await lockMedia(answer(200, good), { url, mode: "live", mediaHosts: ["media.ololla.fi"], now });
    if (!locked.ok) throw new Error("unreachable");
    const input = { url, mode: "live" as const, mediaHosts: ["media.ololla.fi"], now };
    expect(await recheckMedia(answer(200, good), locked.lock, input)).toBeNull();
    const { etag: _etag, ...noEtag } = good;
    expect(await recheckMedia(answer(200, noEtag), locked.lock, input)).toMatch(/media_changed: etag/);
    expect(await recheckMedia(answer(200, good), locked.lock, { ...input, mediaHosts: [] })).toMatch(/media_untrusted/);
    expect(await recheckMedia(async () => { throw new Error("ECONNRESET"); }, locked.lock, input)).toMatch(/media_changed: HEAD failed/);
  });
});
