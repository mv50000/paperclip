/** RK9-832 units: the organic write allowlist, the config block, brand-lint and the digest lines. */
import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "../../src/config.js";
import type { WritePlan } from "../../src/meta/graph.js";
import { organicWriteGuard } from "../../src/meta/organic.js";
import { checkLint } from "../../src/organic/lint.js";
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
        ],
      }),
    );
    expect(text).not.toBeNull();
    expect(text).toContain("📣 Orgaaniset julkaisut (24 h): 5");
    expect(text).toContain("✅ Instagram Reel julkaistu: https://www.instagram.com/reel/ABC/");
    expect(text).toContain("⚠️ Facebook-sivu (kuva): ei julkaistu (OAuthException (#200))");
    expect(text).toContain("❌ Instagram-syöte (kuva): hylätty (väite tai luku)");
    expect(text).toContain("hylätty, syy puuttuu");
    expect(text).toContain("🧪 Facebook-sivu (video): kuivaharjoitus, ei julkaistu");
  });
});
