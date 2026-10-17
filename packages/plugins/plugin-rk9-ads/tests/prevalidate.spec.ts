/**
 * prevalidate() (A8, RK9-514): pure checks before any Meta call. Each bad
 * input gives a typed issue that names its field.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prevalidate, type PrevalidateCode } from "../src/publish/prevalidate.js";
import type { PublishSpec } from "../src/publish/types.js";
import { olollaConfig } from "./publish/rig.js";

const config = olollaConfig();

function spec(overrides: Partial<PublishSpec> = {}): PublishSpec {
  return {
    brand: "OLL",
    kind: "video",
    mediaUrl: "https://media.ololla.fi/a.mp4",
    posterUrl: null,
    sha256: "a".repeat(64),
    aspectRatio: "9:16",
    copy: { message: "Hei", title: "Otsikko", description: "Kuvaus" },
    cta: "LEARN_MORE",
    landingUrlKey: "home",
    utmCampaign: "syksy",
    ...overrides,
  };
}

function codes(input: PublishSpec, cfg = config): Array<[PrevalidateCode, string]> {
  const result = prevalidate(input, cfg);
  return result.ok ? [] : result.issues.map((issue) => [issue.code, issue.field]);
}

function withLanding(url: string, allowedDomains = ["ololla.fi"]) {
  return { ...config, landing: { ...config.landing, allowedDomains, urls: { home: url } } };
}

describe("prevalidate", () => {
  it("passes a valid spec and returns the landing URL", () => {
    expect(prevalidate(spec(), config)).toEqual({ ok: true, landingUrl: "https://www.ololla.fi/" });
    expect(prevalidate(spec({ kind: "image", aspectRatio: "4:5", placement: "feed", sizeBytes: 1000 }), config).ok).toBe(true);
  });

  it("rejects an aspect ratio outside 1:1, 4:5, 9:16, and one that does not fit the placement", () => {
    expect(codes(spec({ aspectRatio: "16:9" }))).toEqual([["aspect_ratio_unsupported", "aspectRatio"]]);
    expect(codes(spec({ aspectRatio: "1.91:1" }))).toEqual([["aspect_ratio_unsupported", "aspectRatio"]]);
    expect(codes(spec({ aspectRatio: "9:16", placement: "feed" }))).toEqual([["aspect_ratio_unsupported", "aspectRatio"]]);
    expect(codes(spec({ aspectRatio: "4:5", placement: "story" }))).toEqual([["aspect_ratio_unsupported", "aspectRatio"]]);
    expect(codes(spec({ aspectRatio: "9:16", placement: "reels" }))).toEqual([]);
  });

  it("rejects a file over the size limit and a video duration outside the placement's range", () => {
    expect(codes(spec({ kind: "image", aspectRatio: "1:1", sizeBytes: 30 * 1024 * 1024 + 1 }))).toEqual([["media_too_large", "sizeBytes"]]);
    expect(codes(spec({ sizeBytes: 1024 * 1024 * 1024 + 1 }))).toEqual([["media_too_large", "sizeBytes"]]);
    expect(codes(spec({ durationSec: 61, placement: "story" }))).toEqual([["video_duration_out_of_range", "durationSec"]]);
    expect(codes(spec({ durationSec: 91, placement: "reels" }))).toEqual([["video_duration_out_of_range", "durationSec"]]);
    expect(codes(spec({ durationSec: 0.5 }))).toEqual([["video_duration_out_of_range", "durationSec"]]);
    expect(codes(spec({ durationSec: 60, placement: "story" }))).toEqual([]);
  });

  it("rejects primary text, headline and description over their limits, and empty primary text", () => {
    expect(codes(spec({ copy: { message: "x".repeat(2001) } }))).toEqual([["copy_too_long", "copy.message"]]);
    expect(codes(spec({ copy: { message: "x", title: "t".repeat(256) } }))).toEqual([["copy_too_long", "copy.title"]]);
    expect(codes(spec({ copy: { message: "x", description: "d".repeat(256) } }))).toEqual([["copy_too_long", "copy.description"]]);
    expect(codes(spec({ copy: { message: "  " } }))).toEqual([["copy_missing", "copy.message"]]);
    // Characters, not UTF-16 units: 2000 emoji fit.
    expect(codes(spec({ copy: { message: "☀️".repeat(1000) } }))).toEqual([]);
  });

  it("rejects a CTA outside the supported enum, and NO_BUTTON on a video", () => {
    expect(codes(spec({ cta: "CLICK_HERE" }))).toEqual([["cta_unsupported", "cta"]]);
    expect(codes(spec({ cta: "NO_BUTTON" }))).toEqual([["cta_unsupported", "cta"]]);
    expect(codes(spec({ kind: "image", aspectRatio: "1:1", cta: "NO_BUTTON" }))).toEqual([]);
  });

  it("rejects a landing domain outside the brand allowlist and an unknown landing key", () => {
    expect(codes(spec(), withLanding("https://evil.example/ololla.fi"))).toEqual([["landing_domain_not_allowed", "landingUrlKey"]]);
    expect(codes(spec(), withLanding("https://ololla.fi.evil.example/"))).toEqual([["landing_domain_not_allowed", "landingUrlKey"]]);
    expect(codes(spec(), withLanding("http://www.ololla.fi/"))).toEqual([["landing_domain_not_allowed", "landingUrlKey"]]);
    expect(codes(spec({ landingUrlKey: "missing" }))).toEqual([["landing_url_key_unknown", "landingUrlKey"]]);
    expect(codes(spec({ landingUrlKey: "constructor" }))).toEqual([["landing_url_key_unknown", "landingUrlKey"]]);
  });

  it("rejects a missing utm_campaign and a UTM that conflicts with the landing URL's own parameters", () => {
    expect(codes(spec({ utmCampaign: "" }))).toEqual([["utm_campaign_missing", "utmCampaign"]]);
    expect(codes(spec({ utmCampaign: "has space" }))).toEqual([["utm_campaign_missing", "utmCampaign"]]);
    expect(codes(spec(), withLanding("https://www.ololla.fi/?utm_source=google"))).toEqual([["utm_conflict", "landingUrlKey"]]);
    expect(codes(spec(), withLanding("https://www.ololla.fi/?utm_campaign=other#top"))).toEqual([["utm_conflict", "landingUrlKey"]]);
    // The same values are not a conflict.
    expect(codes(spec(), withLanding("https://www.ololla.fi/?utm_source=meta&utm_medium=paid&utm_campaign=syksy"))).toEqual([]);
  });

  it("reports every issue at once and refuses another brand", () => {
    expect(codes(spec({ brand: "AUR", aspectRatio: "16:9", cta: "X", utmCampaign: "" })).map(([code]) => code)).toEqual([
      "brand_mismatch",
      "aspect_ratio_unsupported",
      "cta_unsupported",
      "utm_campaign_missing",
    ]);
  });

  it("is pure: the module does no I/O and reads no clock", () => {
    const source = readFileSync(new URL("../src/publish/prevalidate.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\(|ctx\.|Date\.now|new Date\(|node:fs|child_process|await /);
  });
});
