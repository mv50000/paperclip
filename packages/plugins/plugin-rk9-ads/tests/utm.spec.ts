import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandLandingUrl, brandWithUtm, withUtm } from "../src/brand/utm.js";
import { enabledConfig, loadFixtureConfig } from "./brand/fake-routes.js";

/**
 * Output of Sunspot's marketing/reel-studio/links.mjs `withUtm(...)`, recorded
 * 2026-10-17 by running that file with node. The live comparison below runs
 * too when the Sunspot repo is checked out next to this one.
 */
const LINKS_MJS_OUTPUT: Array<[[string, string, string], string]> = [
  [["instagram", "social", "daily"], "https://sunspot.fi/get?utm_source=instagram&utm_medium=social&utm_campaign=daily"],
  [["facebook", "paid", "pulssi"], "https://sunspot.fi/get?utm_source=facebook&utm_medium=paid&utm_campaign=pulssi"],
  [["meta", "bio", "story"], "https://sunspot.fi/get?utm_source=meta&utm_medium=bio&utm_campaign=story"],
  [["facebook", "paid", "syys kampanja/ä&ö=1"], "https://sunspot.fi/get?utm_source=facebook&utm_medium=paid&utm_campaign=syys+kampanja%2F%C3%A4%26%C3%B6%3D1"],
];
const LINKS_MJS = "/opt/repos/sunspot/marketing/reel-studio/links.mjs";

describe("withUtm", () => {
  const sunspot = enabledConfig(loadFixtureConfig("sunspot"));

  it.each(LINKS_MJS_OUTPUT)("is byte-identical to links.mjs for %j", (args, expected) => {
    expect(brandWithUtm(sunspot)(...args)).toBe(expected);
    expect(withUtm("https://sunspot.fi/get", ...args)).toBe(expected);
  });

  it.runIf(existsSync(LINKS_MJS))("matches the live links.mjs", async () => {
    const links = (await import(/* @vite-ignore */ LINKS_MJS)) as { withUtm(source: string, medium: string, campaign: string): string };
    for (const [args] of LINKS_MJS_OUTPUT) expect(brandWithUtm(sunspot)(...args)).toBe(links.withUtm(...args));
  });

  it("uses the brand's own landing URL and appends to an existing query with &", () => {
    const ololla = enabledConfig(loadFixtureConfig("ololla"));
    expect(brandLandingUrl(ololla)).toBe("https://www.ololla.fi/");
    expect(brandWithUtm(ololla)("facebook", "paid", "syksy")).toBe("https://www.ololla.fi/?utm_source=facebook&utm_medium=paid&utm_campaign=syksy");
    expect(withUtm("https://www.ololla.fi/?ref=a", "facebook", "paid", "x")).toBe("https://www.ololla.fi/?ref=a&utm_source=facebook&utm_medium=paid&utm_campaign=x");
    expect(brandLandingUrl(ololla, "constructor")).toBeNull();
    expect(() => brandWithUtm(ololla, "missing")).toThrow("No landing URL with key missing");
  });
});
