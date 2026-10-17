import { describe, expect, it } from "vitest";
import { setQueryParams, withUtm } from "../../src/brand/utm.js";
import { adName, AD_NAME_RE, campaignSlug, contentHash, publicationKey } from "../../src/publish/ad-name.js";
import { buildFinalUrl, templateParams } from "../../src/publish/final-url.js";

const TEMPLATE = "utm_source=facebook&utm_medium=paid_social&utm_campaign={campaign}&utm_content={ad}";
const values = { brand: "OLL", adset: "120200000000000201", ad: "OLL-syksy-image-20261017-abcdef" };

describe("final URL", () => {
  it("always has utm_source=meta, utm_medium=paid and utm_campaign, and keeps other params and the fragment", () => {
    const url = buildFinalUrl("https://www.ololla.fi/mokit?ref=a%20b&x=1#varaa", { campaign: "syksy", utmTemplate: TEMPLATE, values });
    expect(url).toBe(
      "https://www.ololla.fi/mokit?ref=a%20b&x=1&utm_source=meta&utm_medium=paid&utm_campaign=syksy&utm_content=OLL-syksy-image-20261017-abcdef#varaa",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("meta");
    expect(parsed.searchParams.get("utm_medium")).toBe("paid");
    expect(parsed.searchParams.get("utm_campaign")).toBe("syksy");
    expect(parsed.hash).toBe("#varaa");
  });

  it("is a no-op when applied twice", () => {
    const once = buildFinalUrl("https://www.ololla.fi/?ref=1#a", { campaign: "syksy", utmTemplate: TEMPLATE, values });
    expect(buildFinalUrl(once, { campaign: "syksy", utmTemplate: TEMPLATE, values })).toBe(once);
  });

  it("refuses a landing URL whose own UTM disagrees", () => {
    expect(() => buildFinalUrl("https://www.ololla.fi/?utm_source=google", { campaign: "syksy", utmTemplate: "", values })).toThrow(/utm_source/);
  });

  it("takes extra template params but never the fixed keys, and skips unknown placeholders", () => {
    expect(templateParams(TEMPLATE, { ...values, campaign: "c" })).toEqual([["utm_content", values.ad]]);
    expect(templateParams("utm_term={nope}&utm_id={brand}", { ...values, campaign: "c" })).toEqual([["utm_id", "OLL"]]);
  });
});

describe("withUtm fragment and idempotency (moved from RK9-538)", () => {
  it("keeps the fragment last and is idempotent", () => {
    expect(withUtm("https://sunspot.fi/get#app", "meta", "paid", "pulssi")).toBe("https://sunspot.fi/get?utm_source=meta&utm_medium=paid&utm_campaign=pulssi#app");
    const once = withUtm("https://sunspot.fi/get?x=1#app", "meta", "paid", "pulssi");
    expect(withUtm(once, "meta", "paid", "pulssi")).toBe(once);
  });

  it("replaces a UTM param with another value instead of duplicating it", () => {
    expect(withUtm("https://sunspot.fi/get?utm_source=old&a=1", "meta", "paid", "p")).toBe("https://sunspot.fi/get?a=1&utm_source=meta&utm_medium=paid&utm_campaign=p");
    expect(setQueryParams("https://x.fi/?", [["a", "1"]], "replace")).toBe("https://x.fi/?a=1");
  });
});

describe("ad name", () => {
  const hash = contentHash({
    kind: "image",
    sha256: "a".repeat(64),
    mediaUrl: "https://media.ololla.fi/a.jpg",
    posterUrl: null,
    copy: { message: "m" },
    cta: "LEARN_MORE",
    finalUrl: "https://www.ololla.fi/?utm_source=meta",
    adsetId: "1",
  });

  it("matches the deterministic pattern and is stable for the same inputs", () => {
    const name = adName({ brandCode: "OLL", campaign: "Syksy 2026 / Mökit", kind: "image", localDate: "2026-10-17", contentHash: hash });
    expect(name).toMatch(AD_NAME_RE);
    expect(name).toBe(`OLL-syksy-2026-m-kit-image-20261017-${hash.slice(0, 6)}`);
    expect(adName({ brandCode: "OLL", campaign: "Syksy 2026 / Mökit", kind: "image", localDate: "2026-10-17", contentHash: hash })).toBe(name);
    expect(adName({ brandCode: "OLL", campaign: "___", kind: "video", localDate: "2026-10-17", contentHash: hash })).toMatch(AD_NAME_RE);
    expect(campaignSlug("___")).toBe("ad");
  });

  it("changes the hash when copy, final URL or ad set change", () => {
    const base = { kind: "image" as const, sha256: "a".repeat(64), mediaUrl: "https://m/a.jpg", posterUrl: null, copy: { message: "m" }, cta: "LEARN_MORE", finalUrl: "https://u", adsetId: "1" };
    const h = contentHash(base);
    expect(contentHash({ ...base, copy: { message: "n" } })).not.toBe(h);
    expect(contentHash({ ...base, finalUrl: "https://v" })).not.toBe(h);
    expect(contentHash({ ...base, adsetId: "2" })).not.toBe(h);
    expect(contentHash({ ...base })).toBe(h);
  });

  it("hashes the company into the stored idempotency key", () => {
    const a = publicationKey({ companyId: "11111111-1111-4111-8111-111111111111", mode: "publish", key: "k" });
    const b = publicationKey({ companyId: "22222222-2222-4222-8222-222222222222", mode: "publish", key: "k" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pub:v1:[0-9a-f]{64}$/);
  });
});
