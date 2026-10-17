/**
 * Deterministic ad names and content hashes (A8, RK9-514).
 *
 * The name is `{BRAND}-{campaign}-{format}-{yyyymmdd}-{hash6}`. hash6 comes
 * from the content hash (media + copy + final URL + ad set), so the same
 * inputs give the same name on the same local day.
 */

import { createHash } from "node:crypto";
import type { CreativeKind } from "../creative-manifest/schema.js";
import type { AdCopy, PublicationMode } from "./types.js";

export const AD_NAME_RE = /^[A-Z0-9]+-[a-z0-9-]+-(image|video)-\d{8}-[0-9a-f]{6}$/;
const MAX_CAMPAIGN_SLUG = 40;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ContentHashInput {
  kind: CreativeKind;
  /** The manifest's media sha256 (dedupe key) and URL. */
  sha256: string;
  mediaUrl: string;
  posterUrl: string | null;
  copy: AdCopy;
  cta: string;
  /** The final URL before any `{ad}` template parameter (that one depends on the name). */
  finalUrl: string;
  adsetId: string;
}

/** sha256 over a fixed-order JSON of the inputs. Lower-case hex. */
export function contentHash(input: ContentHashInput): string {
  return sha256Hex(
    JSON.stringify([
      "rk9-ads-publication-v1",
      input.kind,
      input.sha256,
      input.mediaUrl,
      input.posterUrl,
      input.copy.message,
      input.copy.title ?? null,
      input.copy.description ?? null,
      input.cta,
      input.finalUrl,
      input.adsetId,
    ]),
  );
}

/** Lower-case `[a-z0-9-]` slug of a utm_campaign; "ad" when nothing is left. */
export function campaignSlug(campaign: string): string {
  const slug = campaign
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CAMPAIGN_SLUG)
    .replace(/-+$/g, "");
  return slug || "ad";
}

/** `localDate` is YYYY-MM-DD in the brand time zone. */
export function adName(input: { brandCode: string; campaign: string; kind: CreativeKind; localDate: string; contentHash: string }): string {
  if (!/^[A-Z0-9]+$/.test(input.brandCode)) throw new Error("brandCode must be upper-case letters and digits");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)) throw new Error("localDate must be YYYY-MM-DD");
  if (!/^[0-9a-f]{64}$/.test(input.contentHash)) throw new Error("contentHash must be a sha256 hex digest");
  return `${input.brandCode}-${campaignSlug(input.campaign)}-${input.kind}-${input.localDate.replaceAll("-", "")}-${input.contentHash.slice(0, 6)}`;
}

/**
 * The stored publications.idempotency_key. The column is unique across the
 * table, so the key hashes the company in: two companies never collide.
 * `key` is the caller's idempotency key, or the content hash by default.
 */
export function publicationKey(input: { companyId: string; mode: PublicationMode; key: string; targetAdId?: string }): string {
  return `pub:v1:${sha256Hex(JSON.stringify([input.companyId, input.mode, input.targetAdId ?? null, input.key]))}`;
}
