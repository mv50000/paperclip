/**
 * Ad creative bodies (A8, RK9-514), ported from Sunspot's publish-ad.mjs
 * (createCreative, createImageCreative).
 *
 * - Video: `object_story_spec.video_data`, plus `instagram_user_id` when the
 *   brand has an IG actor. The thumbnail is a URL (`image_url`): the poster,
 *   or Meta's own first thumbnail. No ffmpeg frame, no adimages upload (G4).
 * - Image: `object_story_spec.link_data` with the media URL as `picture`
 *   (G4) and no `instagram_user_id`: link_data rejects it, and Meta uses the
 *   page's connected IG account for the IG placement.
 * - Neither carries `degrees_of_freedom_spec`, so no OPT_OUT either.
 */

import type { AdCopy } from "./types.js";

export interface CreativeBodyInput {
  name: string;
  pageId: string;
  igUserId: string | null;
  finalUrl: string;
  copy: AdCopy;
  cta: string;
  media: { kind: "video"; videoId: string; thumbnailUrl: string } | { kind: "image"; imageUrl: string };
}

export type CreativeBody = { name: string; object_story_spec: Record<string, unknown> };

function callToAction(cta: string, link: string): Record<string, unknown> | undefined {
  return cta === "NO_BUTTON" ? undefined : { type: cta, value: { link } };
}

/** Drops undefined values so the body has only the keys that are sent. */
function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function buildCreativeBody(input: CreativeBodyInput): CreativeBody {
  if (input.media.kind === "video") {
    const videoData = compact({
      video_id: input.media.videoId,
      image_url: input.media.thumbnailUrl,
      title: input.copy.title,
      message: input.copy.message,
      link_description: input.copy.description,
      call_to_action: callToAction(input.cta, input.finalUrl),
    });
    const storySpec: Record<string, unknown> = { page_id: input.pageId, video_data: videoData };
    if (input.igUserId) storySpec.instagram_user_id = input.igUserId;
    return { name: input.name, object_story_spec: storySpec };
  }
  const linkData = compact({
    picture: input.media.imageUrl,
    link: input.finalUrl,
    message: input.copy.message,
    name: input.copy.title,
    description: input.copy.description,
    call_to_action: callToAction(input.cta, input.finalUrl),
  });
  return { name: input.name, object_story_spec: { page_id: input.pageId, link_data: linkData } };
}
