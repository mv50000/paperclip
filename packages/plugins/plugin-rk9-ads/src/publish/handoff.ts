/**
 * Publication -> spend gate hand-off (G15, A8 RK9-514; implemented by A9 RK9-517).
 *
 * The publish service calls `onPublished` at most once per publication, after
 * its PAUSED ad exists and the row says `published`, or after a creative swap
 * (`swapped`: the new creative needs its own approval) (a once-marker; a hook
 * that throws gives it back, a worker crash mid-hook does not). The service itself never
 * activates anything. The activation gate (src/gate/) opens the Telegram
 * approval card for the ad.
 *
 * A creative swap calls `onCreativeSwap` before its Meta write: the gate
 * closes every open approval of that ad, and refuses (throws) while an
 * approved activation of the ad is running, so an approval of the old
 * preview never puts the new creative live (RK9-514 verifier).
 *
 * The defaults here are no-ops; the worker wires the gate in
 * features/publish/register.ts.
 */

import type { CreativeKind } from "../creative-manifest/schema.js";
import type { AdCopy } from "./types.js";

export interface PublishedPublication {
  publicationId: string;
  companyId: string;
  brandCode: string;
  adName: string;
  adId: string;
  adsetId: string;
  campaignId: string | null;
  creativeId: string;
  /** The publication's content hash: the approval is bound to it and to `creativeId`. */
  contentHash: string;
  finalUrl: string;
  publishedAt: string;
  /** What the card previews. */
  preview: {
    kind: CreativeKind;
    mediaUrl: string;
    posterUrl: string | null;
    copy: AdCopy;
  };
}

export type OnPublishedHook = (publication: PublishedPublication) => Promise<void>;

export interface CreativeSwap {
  companyId: string;
  adId: string;
  /** The swap publication. */
  publicationId: string;
}

/** Throws to stop the swap before its Meta write. */
export type OnCreativeSwapHook = (swap: CreativeSwap) => Promise<void>;

export const onPublished: OnPublishedHook = async () => undefined;

export const onCreativeSwap: OnCreativeSwapHook = async () => undefined;
