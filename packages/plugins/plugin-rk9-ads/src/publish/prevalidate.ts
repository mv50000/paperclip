/**
 * Checks before any Meta write (A8, RK9-514). Pure: no I/O, no clock, no Meta
 * call. Every problem is a typed issue that names the field at fault, so the
 * caller sees all of them at once.
 */

import type { BrandConfigDraft } from "../config.js";
import { MAX_MEDIA_BYTES } from "../creative-manifest/ingress.js";
import { META_CTA_TYPES } from "../creative-manifest/schema.js";
import { utmConflicts } from "./final-url.js";
import type { Placement, PublishSpec } from "./types.js";

export const SUPPORTED_ASPECT_RATIOS = ["1:1", "4:5", "9:16"] as const;

/** Aspect ratios each placement accepts. No placement means any supported ratio. */
export const PLACEMENT_ASPECT_RATIOS: Readonly<Record<Placement, readonly string[]>> = {
  feed: ["1:1", "4:5"],
  story: ["9:16"],
  reels: ["9:16"],
};

/** Video length in seconds per placement (Meta: feed up to 241 min, stories 60 s, reels 90 s). */
export const VIDEO_DURATION_LIMITS: Readonly<Record<Placement | "any", { min: number; max: number }>> = {
  any: { min: 1, max: 241 * 60 },
  feed: { min: 1, max: 241 * 60 },
  story: { min: 1, max: 60 },
  reels: { min: 1, max: 90 },
};

/** Hard text limits. Meta truncates long text in the UI well before these. */
export const COPY_LIMITS = { message: 2000, title: 255, description: 255 } as const;

const UTM_CAMPAIGN_RE = /^[A-Za-z0-9._-]{1,100}$/;

export type PrevalidateCode =
  | "aspect_ratio_unsupported"
  | "media_too_large"
  | "video_duration_out_of_range"
  | "copy_missing"
  | "copy_too_long"
  | "cta_unsupported"
  | "landing_url_key_unknown"
  | "landing_domain_not_allowed"
  | "utm_campaign_missing"
  | "utm_conflict"
  | "brand_mismatch";

export interface PrevalidateIssue {
  code: PrevalidateCode;
  /** Dot path into the publish spec, e.g. "copy.title". */
  field: string;
  message: string;
}

export type PrevalidateResult = { ok: true; landingUrl: string } | { ok: false; issues: PrevalidateIssue[] };

/** Thrown by callers that need prevalidate() to pass; carries every issue. */
export class PrevalidationError extends Error {
  readonly issues: PrevalidateIssue[];

  constructor(issues: PrevalidateIssue[]) {
    super(`Publish refused before any Meta call: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`);
    this.name = "PrevalidationError";
    this.issues = issues;
  }
}

function hostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const lower = host.toLowerCase().replace(/\.+$/, "");
  return allowedDomains.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

export function prevalidate(spec: PublishSpec, config: Pick<BrandConfigDraft, "brandCode" | "landing">): PrevalidateResult {
  const issues: PrevalidateIssue[] = [];
  const add = (code: PrevalidateCode, field: string, message: string) => issues.push({ code, field, message });

  if (spec.brand !== config.brandCode) add("brand_mismatch", "brand", `brand ${spec.brand} is not this company's brand ${config.brandCode}`);

  const allowedRatios = spec.placement ? PLACEMENT_ASPECT_RATIOS[spec.placement] : SUPPORTED_ASPECT_RATIOS;
  if (!allowedRatios.includes(spec.aspectRatio)) {
    add(
      "aspect_ratio_unsupported",
      "aspectRatio",
      `${spec.aspectRatio} is not supported${spec.placement ? ` for ${spec.placement}` : ""}; use ${allowedRatios.join(", ")}`,
    );
  }

  const maxBytes = MAX_MEDIA_BYTES[spec.kind];
  if (spec.sizeBytes !== undefined && (!Number.isFinite(spec.sizeBytes) || spec.sizeBytes < 0 || spec.sizeBytes > maxBytes)) {
    add("media_too_large", "sizeBytes", `${spec.sizeBytes} bytes is over the ${spec.kind} limit of ${maxBytes} bytes`);
  }
  if (spec.kind === "video" && spec.durationSec !== undefined) {
    const limit = VIDEO_DURATION_LIMITS[spec.placement ?? "any"];
    if (!Number.isFinite(spec.durationSec) || spec.durationSec < limit.min || spec.durationSec > limit.max) {
      add("video_duration_out_of_range", "durationSec", `${spec.durationSec} s is outside ${limit.min}-${limit.max} s${spec.placement ? ` for ${spec.placement}` : ""}`);
    }
  }

  if (typeof spec.copy?.message !== "string" || spec.copy.message.trim().length === 0) {
    add("copy_missing", "copy.message", "primary text is required");
  }
  for (const key of ["message", "title", "description"] as const) {
    const value = spec.copy?.[key];
    if (typeof value === "string" && [...value].length > COPY_LIMITS[key]) {
      add("copy_too_long", `copy.${key}`, `${[...value].length} characters is over the limit of ${COPY_LIMITS[key]}`);
    }
  }

  if (!(META_CTA_TYPES as readonly string[]).includes(spec.cta)) {
    add("cta_unsupported", "cta", `${spec.cta} is not a supported call to action`);
  } else if (spec.cta === "NO_BUTTON" && spec.kind === "video") {
    add("cta_unsupported", "cta", "a video ad carries its landing link in the call to action, so NO_BUTTON is not allowed");
  }

  let landingUrl: string | null = null;
  if (!Object.hasOwn(config.landing.urls, spec.landingUrlKey)) {
    add("landing_url_key_unknown", "landingUrlKey", `landing.urls has no key ${spec.landingUrlKey}`);
  } else {
    const candidate = config.landing.urls[spec.landingUrlKey]!;
    let host: string | null = null;
    try {
      const url = new URL(candidate);
      host = url.protocol === "https:" ? url.hostname : null;
    } catch {
      host = null;
    }
    if (!host || !hostAllowed(host, config.landing.allowedDomains)) {
      add("landing_domain_not_allowed", "landingUrlKey", `the landing URL host ${host ?? "(none)"} is not in landing.allowedDomains`);
    } else {
      landingUrl = candidate;
    }
  }

  if (typeof spec.utmCampaign !== "string" || spec.utmCampaign.length === 0) {
    add("utm_campaign_missing", "utmCampaign", "utm_campaign is required");
  } else if (!UTM_CAMPAIGN_RE.test(spec.utmCampaign)) {
    add("utm_campaign_missing", "utmCampaign", "utm_campaign must match ^[A-Za-z0-9._-]{1,100}$");
  } else if (landingUrl) {
    for (const conflict of utmConflicts(landingUrl, spec.utmCampaign)) {
      add("utm_conflict", "landingUrlKey", `the landing URL already has ${conflict.param}=${conflict.existing}, not ${conflict.wanted}`);
    }
  }

  return issues.length === 0 && landingUrl ? { ok: true, landingUrl } : { ok: false, issues };
}
