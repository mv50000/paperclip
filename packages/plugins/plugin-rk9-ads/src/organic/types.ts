/**
 * Organic posts (RK9-832): shared types, labels and the reject reasons.
 * The status and channel sets mirror the CHECK constraints of migration 006.
 */

import type { OrganicChannel, OrganicMode } from "../config.js";
import type { IgAiLabel } from "../meta/organic.js";

export { ORGANIC_CHANNELS, type OrganicChannel, type OrganicMode } from "../config.js";

export const ORGANIC_GATE_KIND = "organic_publish" as const;
export const ORGANIC_ENTITY_TYPE = "rk9_ads_organic_post";
export const ORGANIC_ACTIVITY_PREFIX = "rk9-ads organic";

export const ORGANIC_POST_STATUSES = ["pending", "rejected", "expired", "publishing", "published", "dry_run", "failed", "deleted"] as const;
export type OrganicPostStatus = (typeof ORGANIC_POST_STATUSES)[number];
/** At most one post per content in these statuses (partial unique index of migration 006). */
export const OPEN_ORGANIC_STATUSES: readonly OrganicPostStatus[] = ["pending", "publishing", "published"];

export const CHANNEL_LABELS: Record<OrganicChannel, string> = {
  ig_reel: "Instagram Reel",
  ig_feed: "Instagram-syöte (kuva)",
  fb_video: "Facebook-sivu (video)",
  fb_photo: "Facebook-sivu (kuva)",
};

/** The creative kind each channel takes. */
export const CHANNEL_MEDIA: Record<OrganicChannel, "video" | "image"> = {
  ig_reel: "video",
  ig_feed: "image",
  fb_video: "video",
  fb_photo: "image",
};

/** Aspect ratios a channel accepts; absent = any the manifest allows. */
export const CHANNEL_ASPECT_RATIOS: Partial<Record<OrganicChannel, readonly string[]>> = {
  ig_reel: ["9:16"],
  ig_feed: ["1:1", "4:5", "1.91:1"],
};

/**
 * Preset reject reasons on the card (at most 8). A reply to the card is
 * stored as `other` with its text. The codes are the classes child 5
 * (RK9-833) counts.
 */
export const ORGANIC_REJECT_REASONS = [
  { code: "visual", label: "🎨 Visuaalinen virhe" },
  { code: "text", label: "✏️ Teksti tai kieli" },
  { code: "claim", label: "🔢 Väite tai luku" },
  { code: "brand", label: "🏷 Brändi tai sävy" },
  { code: "topic", label: "🗓 Aihe tai ajoitus" },
  { code: "repeat", label: "🔁 Toistoa" },
] as const;
export const ORGANIC_FREE_TEXT_REASON = "other";
export const ORGANIC_REASON_PROMPT = "Valitse syy tai vastaa tähän viestiin omalla syyllä.";

export interface OrganicLintRow {
  id: string;
  rule: string;
  status: "pass" | "partial" | "fail" | "skip" | "human";
  detail?: string;
}

/** The brand-lint result as stored on the post (rk9-motion scripts/brand-lint.mjs, RK9-830/RK9-841). */
export interface OrganicLint {
  brand: string | null;
  mode: "strict" | "draft";
  ok: boolean;
  needsHumanReview: boolean;
  summary: { pass: number; partial: number; fail: number; skip: number; human: number };
  results: OrganicLintRow[];
}

export interface OrganicPost {
  id: string;
  companyId: string;
  brandCode: string;
  creativeId: string;
  channel: OrganicChannel;
  caption: string;
  contentHash: string;
  /** Stored status. A pending post whose card has expired reads as `expired` (see effectiveStatus). */
  status: OrganicPostStatus;
  mode: OrganicMode;
  gateRequestId: string | null;
  lint: OrganicLint | null;
  metaContainerId: string | null;
  metaMediaId: string | null;
  metaPostId: string | null;
  permalink: string | null;
  rejectReasonCode: string | null;
  rejectReasonText: string | null;
  decidedByTgUserId: number | null;
  decidedAt: string | null;
  publishedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  error: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** The read-back of Instagram's "AI info" label, stored on the post as `payload.aiLabel` (RK9-954). */
export type OrganicAiLabel = IgAiLabel;
export const ORGANIC_AI_LABELS: readonly OrganicAiLabel[] = ["confirmed", "missing", "unknown"];

/**
 * True when the post asked for Instagram's "AI info" label (RK9-954). The flag
 * lives in `payload.aiGenerated`, so it needs no migration; a post from before
 * RK9-954 has no such key and reads as false.
 */
export function postAiGenerated(post: Pick<OrganicPost, "payload">): boolean {
  return post.payload.aiGenerated === true;
}

/** The stored read-back of the label; null when none was stored. */
export function postAiLabel(post: Pick<OrganicPost, "payload">): OrganicAiLabel | null {
  const value = post.payload.aiLabel;
  return typeof value === "string" && (ORGANIC_AI_LABELS as readonly string[]).includes(value) ? (value as OrganicAiLabel) : null;
}

/** What the gate card's payload binds: the handler acts only on this post and content. */
export interface OrganicBinding {
  postId: string;
  contentHash: string;
  channel: OrganicChannel;
  /**
   * RK9-954: the "AI info" flag the card showed. The card's payload has the
   * key `aiGenerated: true` only for a flagged post, so a card from before
   * RK9-954 (no key) reads as false and still publishes.
   */
  aiGenerated: boolean;
}
