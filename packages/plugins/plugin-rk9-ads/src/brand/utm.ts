/**
 * Landing links with UTM attribution (A4, RK9-510; fragment and idempotency A8, RK9-514).
 *
 * `withUtm` matches Sunspot's `marketing/reel-studio/links.mjs` byte for byte
 * for a landing URL without a query string (tests/utm.spec.ts pins its
 * output). The landing URL comes from the brand config instead of a constant.
 * Existing query parameters keep their bytes, a `#fragment` stays at the end,
 * and applying the same parameters again changes nothing.
 */

import type { BrandConfigDraft } from "../config.js";

/** A parameter already in the URL with another value, under `onConflict: "throw"`. */
export class QueryParamConflictError extends Error {
  readonly param: string;
  readonly existing: string;

  constructor(param: string, existing: string, wanted: string) {
    super(`${param} is already "${existing}" in the URL; refusing to change it to "${wanted}"`);
    this.name = "QueryParamConflictError";
    this.param = param;
    this.existing = existing;
  }
}

function decodedKey(segment: string): string {
  const [entry] = new URLSearchParams(segment);
  return entry?.[0] ?? "";
}

function decodedValue(segment: string): string {
  const [entry] = new URLSearchParams(segment);
  return entry?.[1] ?? "";
}

/** The values of `name` already in `url`, decoded as URLSearchParams decodes them. */
export function queryValues(url: string, name: string): string[] {
  const beforeHash = url.split("#", 1)[0]!;
  const queryStart = beforeHash.indexOf("?");
  if (queryStart < 0) return [];
  return beforeHash
    .slice(queryStart + 1)
    .split("&")
    .filter((segment) => segment.length > 0 && decodedKey(segment) === name)
    .map(decodedValue);
}

/**
 * Sets query parameters on `url` in order. A parameter that is absent is
 * appended in URLSearchParams encoding; one that already has the same value
 * is left alone, so a second call is a no-op. One with another value is
 * replaced (`replace`) or refused with QueryParamConflictError (`throw`).
 * Other parameters keep their exact bytes and the fragment stays last.
 */
export function setQueryParams(url: string, params: ReadonlyArray<readonly [string, string]>, onConflict: "replace" | "throw"): string {
  const hashAt = url.indexOf("#");
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  let segments = queryAt >= 0 ? beforeHash.slice(queryAt + 1).split("&").filter((segment) => segment.length > 0) : [];

  for (const [name, value] of params) {
    const existing = segments.filter((segment) => decodedKey(segment) === name);
    if (existing.length === 1 && decodedValue(existing[0]!) === value) continue;
    if (existing.length > 0) {
      if (onConflict === "throw") throw new QueryParamConflictError(name, decodedValue(existing[0]!), value);
      segments = segments.filter((segment) => decodedKey(segment) !== name);
    }
    segments.push(new URLSearchParams([[name, value]]).toString());
  }
  return `${base}${segments.length > 0 ? `?${segments.join("&")}` : ""}${fragment}`;
}

/**
 * `<landingUrl>?utm_source=..&utm_medium=..&utm_campaign=..`, encoded with
 * URLSearchParams as links.mjs does. A landing URL that already has a query
 * gets the UTM parameters appended with `&`; a UTM parameter it already has
 * is replaced, and a fragment stays at the end.
 */
export function withUtm(landingUrl: string, source: string, medium: string, campaign: string): string {
  return setQueryParams(
    landingUrl,
    [
      ["utm_source", source],
      ["utm_medium", medium],
      ["utm_campaign", campaign],
    ],
    "replace",
  );
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
