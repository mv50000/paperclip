/**
 * Landing links with UTM attribution (A4, RK9-510).
 *
 * `withUtm` matches Sunspot's `marketing/reel-studio/links.mjs` byte for byte
 * for a landing URL without a query string (tests/utm.spec.ts pins its
 * output). The landing URL comes from the brand config instead of a constant.
 */

import type { BrandConfigDraft } from "../config.js";

/**
 * `<landingUrl>?utm_source=..&utm_medium=..&utm_campaign=..`, encoded with
 * URLSearchParams as links.mjs does. A landing URL that already has a query
 * gets the UTM parameters appended with `&`.
 */
export function withUtm(landingUrl: string, source: string, medium: string, campaign: string): string {
  const params = new URLSearchParams({
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign,
  });
  return `${landingUrl}${landingUrl.includes("?") ? "&" : "?"}${params.toString()}`;
}

/** The brand's landing URL (`landing.urls[key]`, default key when omitted); null for an unknown key. */
export function brandLandingUrl(config: Pick<BrandConfigDraft, "landing">, urlKey?: string): string | null {
  const key = urlKey ?? config.landing.defaultUrlKey;
  return Object.hasOwn(config.landing.urls, key) ? config.landing.urls[key]! : null;
}

/** `withUtm(source, medium, campaign)` bound to one brand landing URL, the shape of links.mjs. */
export function brandWithUtm(config: Pick<BrandConfigDraft, "landing">, urlKey?: string) {
  const landingUrl = brandLandingUrl(config, urlKey);
  if (!landingUrl) throw new Error(`No landing URL with key ${urlKey ?? config.landing.defaultUrlKey}`);
  return (source: string, medium: string, campaign: string) => withUtm(landingUrl, source, medium, campaign);
}
