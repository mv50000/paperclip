/** RK9-832 units: the organic write allowlist, the config block, brand-lint and the digest lines. */
import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "../../src/config.js";
import type { WritePlan } from "../../src/meta/graph.js";
import { organicWriteGuard, outcomeUnknown, OrganicOutcomeUnknownError } from "../../src/meta/organic.js";
import { InvalidParamError, MetaGraphError, MetaResponseError, RateLimitError, TokenResolveError, WriteRefusedError } from "../../src/meta/errors.js";
import { captionLines, CAPTION_CHUNK_COLUMNS, chunkLine } from "../../src/organic/card.js";
import { cardDeadline, lockMedia, recheckMedia } from "../../src/organic/media-lock.js";
import { oneLineText } from "../../src/organic/text.js";
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

describe("cleanCaption", () => {
  it("drops bidi controls, zero-width spaces and the BOM, keeps the emoji joiner and line feeds", () => {
    expect(cleanCaption("\ufeffValo\u200b palaa\u202e.gpj\u202c\r\nrivi\u2028kolme\u2066x\u2069\u200e\u200f\u0007")).toBe("Valo palaa.gpj\nrivi\nkolmex");
    expect(cleanCaption("perhe 👨\u200d👩\u200d👧")).toBe("perhe 👨\u200d👩\u200d👧");
  });

  it("drops NEL, U+061C, the invisible operators, the deprecated format controls and stray tag characters (RK9-852)", () => {
    expect(cleanCaption("a\u0085b\u061cc\u2061d\u2062e\u2063f\u2064g\u206ah\u180ei\ufff9j")).toBe("abcdefghij");
    expect(cleanCaption("piilo\u{E0054}\u{E0069}\u{E006C}\u{E0061}teksti\u{E007F}")).toBe("piiloteksti");
  });

  it("drops tag characters after U+1F3F4 unless they spell one of the three subdivision flags (L3)", () => {
    const hidden = "\u{1F3F4}\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}\u{E007F}";
    expect(cleanCaption(`x${hidden}y`)).toBe("x\u{1F3F4}y");
    expect(cleanCaption("a\u00adb\u034fc\u3164d\uffa0e\u2800f")).toBe("abcde\u2800f");
  });

  it("keeps a subdivision flag emoji, which needs tag characters", () => {
    const wales = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
    expect(cleanCaption(`Terveiset ${wales}!`)).toBe(`Terveiset ${wales}!`);
  });

  it("oneLineText turns NEL and line feeds into spaces and drops bidi controls", () => {
    expect(oneLineText("Logo\u0085Tila:\n🧪 x\u202e  y")).toBe("Logo Tila: 🧪 x y");
  });
});

describe("caption chunks (RK9-852)", () => {
  it("splits a long line into chunks of at most CAPTION_CHUNK_COLUMNS columns without losing text", () => {
    const line = "Valo palaa Helsinkiin ja aurinko nousee taas joka aamu aikaisemmin kuin eilen";
    const chunks = chunkLine(line);
    expect(chunks.join("")).toBe(line);
    expect(chunks.every((chunk) => [...chunk].length <= CAPTION_CHUNK_COLUMNS)).toBe(true);
    expect(chunks[0]!.endsWith(" ")).toBe(true);
  });

  it("counts an emoji as two columns and never splits a grapheme", () => {
    const chunks = chunkLine("👨\u200d👩\u200d👧".repeat(20));
    expect(chunks.join("")).toBe("👨\u200d👩\u200d👧".repeat(20));
    expect(chunks[0]).toBe("👨\u200d👩\u200d👧".repeat(CAPTION_CHUNK_COLUMNS / 2));
  });

  it("puts a glyph of an uncommon script in a chunk of its own (M1)", () => {
    expect(chunkLine("\ufdfd\ufdfd\ufdfd Tila: x")).toEqual(["\ufdfd", "\ufdfd", "\ufdfd", " Tila: x"]);
  });

  it("opens each caption line with the quote mark and each continuation with the dashed mark", () => {
    expect(captionLines(`${"\u2800".repeat(30)}Tila: LIVE\nok`)).toEqual([`│ ${"\u2800".repeat(20)}`, `┆ ${"\u2800".repeat(10)}Tila: LIVE`, "│ ok"]);
    expect(captionLines("")).toEqual(["│ (ei tekstiä)"]);
  });
});

describe("outcomeUnknown (RK9-852)", () => {
  it("treats a missing or unreadable answer and a 5xx as unknown, a local refusal and a Graph 4xx as not published", () => {
    expect(outcomeUnknown(new MetaGraphError("Meta POST x: request failed (TypeError: fetch failed)"))).toBe(true);
    expect(outcomeUnknown(new MetaResponseError("not JSON"))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("boom", { httpStatus: 503 }))).toBe(true);
    expect(outcomeUnknown(new TypeError("x"))).toBe(true);
    expect(outcomeUnknown(new OrganicOutcomeUnknownError("x", null))).toBe(true);
    expect(outcomeUnknown(new MetaGraphError("bad", { httpStatus: 400, code: 1 }))).toBe(false);
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
