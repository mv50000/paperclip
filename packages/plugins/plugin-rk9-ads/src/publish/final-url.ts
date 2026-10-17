/**
 * The final URL of an ad (A8, RK9-514): the brand landing URL with
 * utm_source=meta, utm_medium=paid and utm_campaign=<campaign>, plus the
 * other parameters of the brand's `landing.utmTemplate` (for example
 * utm_content={ad}).
 *
 * The three fixed parameters win over the template, whose default still says
 * facebook/paid_social. Existing query parameters keep their bytes, the
 * fragment stays last, and building the URL again from its own output gives
 * the same URL.
 */

import { queryValues, setQueryParams } from "../brand/utm.js";

export const UTM_SOURCE = "meta";
export const UTM_MEDIUM = "paid";
export const FIXED_UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

export interface UtmConflict {
  param: string;
  existing: string;
  wanted: string;
}

function fixedParams(campaign: string): Array<[string, string]> {
  return [
    ["utm_source", UTM_SOURCE],
    ["utm_medium", UTM_MEDIUM],
    ["utm_campaign", campaign],
  ];
}

/** Fixed UTM parameters that `landingUrl` already carries with another value. */
export function utmConflicts(landingUrl: string, campaign: string): UtmConflict[] {
  const out: UtmConflict[] = [];
  for (const [param, wanted] of fixedParams(campaign)) {
    const existing = queryValues(landingUrl, param);
    if (existing.length > 1 || (existing.length === 1 && existing[0] !== wanted)) {
      out.push({ param, existing: existing.join(","), wanted });
    }
  }
  return out;
}

/**
 * The landing URL with the three fixed UTM parameters. Throws
 * QueryParamConflictError when the landing URL carries one of them with
 * another value; prevalidate() reports that first.
 */
export function baseFinalUrl(landingUrl: string, campaign: string): string {
  return setQueryParams(landingUrl, fixedParams(campaign), "throw");
}

export interface TemplateValues {
  brand: string;
  campaign: string;
  adset: string;
  ad: string;
}

/**
 * The extra parameters of `utmTemplate` with their placeholders filled.
 * Fixed keys are skipped (they are already set), and so is a parameter whose
 * value names an unknown placeholder.
 */
export function templateParams(utmTemplate: string, values: TemplateValues): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, raw] of new URLSearchParams(utmTemplate)) {
    if (!key || (FIXED_UTM_KEYS as readonly string[]).includes(key)) continue;
    let unknown = false;
    const value = raw.replace(/\{([a-z]+)\}/g, (_match, name: string) => {
      if (Object.hasOwn(values, name)) return values[name as keyof TemplateValues];
      unknown = true;
      return "";
    });
    if (!unknown) out.push([key, value]);
  }
  return out;
}

/** The URL the ad links to: `baseFinalUrl` plus the template parameters. Idempotent. */
export function buildFinalUrl(landingUrl: string, input: { campaign: string; utmTemplate: string; values: Omit<TemplateValues, "campaign"> }): string {
  const base = baseFinalUrl(landingUrl, input.campaign);
  return setQueryParams(base, templateParams(input.utmTemplate, { ...input.values, campaign: input.campaign }), "replace");
}
