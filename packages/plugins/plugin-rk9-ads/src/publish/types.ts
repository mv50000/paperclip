/**
 * Shapes of the publishing pipeline (A8, RK9-514).
 */

import type { CreativeKind } from "../creative-manifest/schema.js";

export const PLACEMENTS = ["feed", "story", "reels"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export interface AdCopy {
  message: string;
  title?: string;
  description?: string;
}

/**
 * One ad to publish, resolved from a staged creative (or a manifest, for a
 * dry run) plus the publication's own text (RK9-525: text variants belong to
 * the publication).
 */
export interface PublishSpec {
  brand: string;
  kind: CreativeKind;
  mediaUrl: string;
  posterUrl: string | null;
  sha256: string;
  aspectRatio: string;
  copy: AdCopy;
  cta: string;
  landingUrlKey: string;
  utmCampaign: string;
  placement?: Placement;
  /** Media size and video length when the caller knows them; the plugin never reads the bytes (G4). */
  sizeBytes?: number;
  durationSec?: number;
}

/** Text a publication may set over the creative's defaults. */
export interface PublicationText {
  copy?: AdCopy;
  cta?: string;
  landingUrlKey?: string;
  utmCampaign?: string;
}

export type PublicationMode = "publish" | "swap";
export type PublicationStatus = "pending" | "published" | "failed" | "swapped";

/** Everything a publication needs to resume, kept in publications.payload. */
export interface PublicationPayload {
  v: 1;
  kind: CreativeKind;
  mediaUrl: string;
  posterUrl: string | null;
  sha256: string;
  aspectRatio: string;
  placement: Placement | null;
  copy: AdCopy;
  cta: string;
  landingUrlKey: string;
  utmCampaign: string;
  finalUrl: string;
  pageId: string;
  igUserId: string | null;
  /** Swap mode: the ad whose creative is replaced. */
  targetAdId?: string;
  /** The video thumbnail actually used: the poster or Meta's first thumbnail. */
  thumbnailUrl?: string | null;
  /** A creative that could not be deleted after a failed ad create. */
  cleanup?: { creativeId: string; reason: string } | null;
}

export interface PublicationRecord {
  id: string;
  companyId: string;
  brandCode: string;
  creativeId: string | null;
  idempotencyKey: string;
  contentHash: string;
  mode: PublicationMode;
  status: PublicationStatus;
  adName: string | null;
  campaignId: string | null;
  adsetId: string | null;
  metaVideoId: string | null;
  metaImageHash: string | null;
  metaCreativeId: string | null;
  metaAdId: string | null;
  replacesPublicationId: string | null;
  error: string | null;
  payload: PublicationPayload;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
