/**
 * Organic (unpaid) Instagram and Facebook Page posts (RK9-832).
 *
 * Only the organic gate handler (src/organic/handler.ts) and the board delete
 * action call these writes, and only through a client built with
 * `organicWriteGuard`. The guard allows exactly the edges below for the
 * brand's own IG user and Page, with exactly the fields these methods send.
 * Every other write, including every ad-account edge, is refused, so an
 * organic client can never create or change an ad.
 *
 * Graph endpoints (Sunspot's publish-ig.mjs / publish-fb.mjs, 14.11.2026):
 * - IG Reel: POST {ig}/media {media_type: REELS, video_url, caption}, poll the
 *   container's status_code until FINISHED, POST {ig}/media_publish {creation_id}.
 * - IG feed image: POST {ig}/media {image_url, caption}, then media_publish.
 * - FB photo: POST {page}/photos {url, caption} -> { id, post_id }.
 * - FB video: POST {page}/videos {file_url, description} -> { id }.
 * - Delete: DELETE {object id}. The FB calls use the Page token.
 */

import { InvalidParamError, MediaProcessingError, MediaTimeoutError, MetaGraphError, MetaResponseError } from "./errors.js";
import type { GuardDecision, GuardedWriteHook, MetaGraphClient, WritePlan } from "./graph.js";
import { redactText } from "./redact.js";
import { isDryRun, type DryRunResult } from "./types.js";

const ID_RE = /^\d+$/;
/** Instagram's caption limit. */
export const ORGANIC_CAPTION_MAX_CHARS = 2_200;

export interface OrganicTarget {
  /** The brand's Instagram professional account id (meta.igUserId). */
  igUserId?: string;
  /** The brand's Facebook Page id (meta.pageId). */
  pageId: string;
  /** The one object id a DELETE may remove (the post being deleted). */
  deleteId?: string;
}

function own(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((key) => fields[key] !== undefined && fields[key] !== null);
}

function isHttps(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isCaption(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= ORGANIC_CAPTION_MAX_CHARS);
}

function exactly(keys: string[], allowed: readonly string[], required: readonly string[]): boolean {
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

const refuse = (reason: string): GuardDecision => ({ allow: false, reason });

/**
 * The write hook of an organic client. It never allows an ad-account edge,
 * a status or budget field, or a node other than the brand's own IG user and
 * Page (and the single object a delete names).
 */
export function organicWriteGuard(target: OrganicTarget): GuardedWriteHook {
  const ig = target.igUserId && ID_RE.test(target.igUserId) ? target.igUserId : null;
  const page = ID_RE.test(target.pageId) ? target.pageId : null;
  const deleteId = target.deleteId && ID_RE.test(target.deleteId) ? target.deleteId : null;
  return (plan: WritePlan): GuardDecision => {
    const keys = own(plan.fields);
    const f = plan.fields;
    if (plan.method === "DELETE") {
      return deleteId && plan.path === deleteId && keys.length === 0 ? { allow: true } : refuse("an organic delete removes only the post it names");
    }
    if (ig && plan.path === `${ig}/media`) {
      if (f.media_type === "REELS") {
        return exactly(keys, ["media_type", "video_url", "caption"], ["media_type", "video_url"]) && isHttps(f.video_url) && isCaption(f.caption)
          ? { allow: true }
          : refuse("an IG Reel container carries only media_type REELS, an https video_url and a caption");
      }
      return exactly(keys, ["image_url", "caption"], ["image_url"]) && isHttps(f.image_url) && isCaption(f.caption)
        ? { allow: true }
        : refuse("an IG feed container carries only an https image_url and a caption");
    }
    if (ig && plan.path === `${ig}/media_publish`) {
      return exactly(keys, ["creation_id"], ["creation_id"]) && typeof f.creation_id === "string" && ID_RE.test(f.creation_id)
        ? { allow: true }
        : refuse("media_publish carries only a numeric creation_id");
    }
    if (page && plan.path === `${page}/photos`) {
      return exactly(keys, ["url", "caption"], ["url"]) && isHttps(f.url) && isCaption(f.caption)
        ? { allow: true }
        : refuse("a Page photo carries only an https url and a caption");
    }
    if (page && plan.path === `${page}/videos`) {
      return exactly(keys, ["file_url", "description"], ["file_url"]) && isHttps(f.file_url) && isCaption(f.description)
        ? { allow: true }
        : refuse("a Page video carries only an https file_url and a description");
    }
    return refuse("this edge is not on the organic write allowlist");
  };
}

/** The outcome of one organic publish. */
export type OrganicPublishResult =
  | { dryRun: true; planned: DryRunResult["planned"][] }
  | {
      dryRun: false;
      /** The object a delete removes (IG media, FB photo or FB video id). */
      mediaId: string | null;
      /** IG container id (IG only). */
      containerId: string | null;
      /** FB feed post id (pageId_postId) when Graph gives one. */
      postId: string | null;
      permalink: string | null;
      /** True when media_publish failed but the container reports PUBLISHED. */
      recovered: boolean;
    };

export interface ContainerWaitOptions {
  /** Pause between polls. Default 5 s, clamped to 0.5-30 s. */
  intervalMs?: number;
  /** Total wait before MediaTimeoutError. Default 5 min, at most 15 min. */
  timeoutMs?: number;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new MetaResponseError(`Graph field ${field} is not a numeric id`);
  return value;
}

function requireHttps(value: string, field: string): string {
  if (!isHttps(value)) throw new InvalidParamError(`${field} must be an absolute https URL`);
  return new URL(value).toString();
}

function requireCaption(value: string): string {
  if (typeof value !== "string" || value.length > ORGANIC_CAPTION_MAX_CHARS) {
    throw new InvalidParamError(`caption must be a string of at most ${ORGANIC_CAPTION_MAX_CHARS} characters`);
  }
  return value;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/** Polls an IG container until FINISHED. ERROR and EXPIRED throw MediaProcessingError. */
export async function waitForContainer(client: MetaGraphClient, containerId: string, options: ContainerWaitOptions = {}): Promise<void> {
  const intervalMs = bounded(options.intervalMs, 5_000, 500, 30_000);
  const timeoutMs = bounded(options.timeoutMs, 300_000, 0, 900_000);
  const started = client.now();
  let last: string | null = null;
  for (;;) {
    const raw = await client.get<{ status_code?: unknown; status?: unknown }>(containerId, { fields: "status_code,status" });
    last = typeof raw.status_code === "string" ? raw.status_code : null;
    if (last === "FINISHED") return;
    if (last === "ERROR" || last === "EXPIRED") {
      const detail = typeof raw.status === "string" ? raw.status : `status_code ${last}`;
      throw new MediaProcessingError(containerId, redactText(`Instagram container ${containerId} failed: ${detail}`));
    }
    const elapsed = client.now() - started;
    if (elapsed >= timeoutMs) throw new MediaTimeoutError(containerId, timeoutMs, last);
    await client.sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

async function igPermalink(client: MetaGraphClient, mediaId: string): Promise<string | null> {
  try {
    const raw = await client.get<{ permalink?: unknown }>(mediaId, { fields: "permalink" });
    return typeof raw.permalink === "string" && isHttps(raw.permalink) ? raw.permalink : null;
  } catch {
    return null;
  }
}

/**
 * media_publish can answer an error although the post went live (seen in
 * Sunspot's publish-ig.mjs). The container's status_code then says PUBLISHED.
 * The media id is taken only when exactly one recent media item (created
 * after `startedAtMs` - 60 s) carries the same caption; otherwise it stays
 * null, so a board delete can never remove a post of another publisher.
 */
async function recoverPublished(
  client: MetaGraphClient,
  igUserId: string,
  containerId: string,
  startedAtMs: number,
  caption: string,
): Promise<string | null | false> {
  let status: unknown;
  try {
    status = (await client.get<{ status_code?: unknown }>(containerId, { fields: "status_code" })).status_code;
  } catch {
    return false;
  }
  if (status !== "PUBLISHED") return false;
  try {
    const page = await client.get<{ data?: Array<{ id?: unknown; timestamp?: unknown; caption?: unknown }> }>(`${igUserId}/media`, {
      fields: "id,timestamp,caption",
      limit: 5,
    });
    const matches = (page.data ?? []).filter((item) => {
      const at = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : Number.NaN;
      const text = typeof item.caption === "string" ? item.caption.trim() : "";
      return typeof item.id === "string" && ID_RE.test(item.id) && Number.isFinite(at) && at >= startedAtMs - 60_000 && text === caption.trim();
    });
    return matches.length === 1 ? String(matches[0]!.id) : null;
  } catch {
    return null;
  }
}

async function publishIgContainer(
  client: MetaGraphClient,
  igUserId: string,
  fields: Record<string, unknown>,
  wait: ContainerWaitOptions | null,
): Promise<OrganicPublishResult> {
  const startedAtMs = client.now();
  const created = await client.post<{ id?: unknown }>(`${igUserId}/media`, fields);
  if (isDryRun(created)) {
    // The plan names the publish step too; "0" stands for the container id Meta would return.
    const publish = await client.post(`${igUserId}/media_publish`, { creation_id: "0" });
    return { dryRun: true, planned: [created.planned, ...(isDryRun(publish) ? [publish.planned] : [])] };
  }
  const containerId = requireId(created.id, "id");
  if (wait) await waitForContainer(client, containerId, wait);
  let mediaId: string | null;
  let recovered = false;
  try {
    const published = await client.post<{ id?: unknown }>(`${igUserId}/media_publish`, { creation_id: containerId });
    if (isDryRun(published)) throw new MetaResponseError("media_publish answered a dry run on a live client");
    mediaId = requireId(published.id, "id");
  } catch (error) {
    if (!(error instanceof MetaGraphError) || error instanceof MetaResponseError) throw error;
    const found = await recoverPublished(client, igUserId, containerId, startedAtMs, typeof fields.caption === "string" ? fields.caption : "");
    if (found === false) throw error;
    mediaId = found;
    recovered = true;
  }
  return {
    dryRun: false,
    mediaId,
    containerId,
    postId: null,
    permalink: mediaId ? await igPermalink(client, mediaId) : null,
    recovered,
  };
}

/** Instagram Reel from a public video URL. */
export async function publishIgReel(
  client: MetaGraphClient,
  igUserId: string,
  input: { videoUrl: string; caption: string },
  wait: ContainerWaitOptions = {},
): Promise<OrganicPublishResult> {
  if (!ID_RE.test(igUserId)) throw new InvalidParamError("igUserId must be a numeric Graph id");
  return publishIgContainer(
    client,
    igUserId,
    { media_type: "REELS", video_url: requireHttps(input.videoUrl, "videoUrl"), caption: requireCaption(input.caption) },
    wait,
  );
}

/** Instagram feed image from a public image URL. */
export async function publishIgImage(
  client: MetaGraphClient,
  igUserId: string,
  input: { imageUrl: string; caption: string },
  wait: ContainerWaitOptions = {},
): Promise<OrganicPublishResult> {
  if (!ID_RE.test(igUserId)) throw new InvalidParamError("igUserId must be a numeric Graph id");
  // An image container is usually FINISHED at once; the poll is one short GET then.
  return publishIgContainer(client, igUserId, { image_url: requireHttps(input.imageUrl, "imageUrl"), caption: requireCaption(input.caption) }, wait);
}

async function fbPermalink(client: MetaGraphClient, postId: string | null): Promise<string | null> {
  if (!postId || !/^\d+_\d+$/.test(postId)) return null;
  try {
    const raw = await client.get<{ permalink_url?: unknown }>(postId, { fields: "permalink_url" });
    return typeof raw.permalink_url === "string" && isHttps(raw.permalink_url) ? raw.permalink_url : null;
  } catch {
    return null;
  }
}

/** Facebook Page photo post. `client` must carry the Page token. */
export async function publishFbPhoto(client: MetaGraphClient, pageId: string, input: { url: string; caption: string }): Promise<OrganicPublishResult> {
  if (!ID_RE.test(pageId)) throw new InvalidParamError("pageId must be a numeric Graph id");
  const result = await client.post<{ id?: unknown; post_id?: unknown }>(`${pageId}/photos`, {
    url: requireHttps(input.url, "url"),
    caption: requireCaption(input.caption),
  });
  if (isDryRun(result)) return { dryRun: true, planned: [result.planned] };
  const mediaId = requireId(result.id, "id");
  const postId = typeof result.post_id === "string" && /^\d+_\d+$/.test(result.post_id) ? result.post_id : null;
  return { dryRun: false, mediaId, containerId: null, postId, permalink: await fbPermalink(client, postId), recovered: false };
}

/** Facebook Page video post. `client` must carry the Page token. */
export async function publishFbVideo(client: MetaGraphClient, pageId: string, input: { fileUrl: string; description: string }): Promise<OrganicPublishResult> {
  if (!ID_RE.test(pageId)) throw new InvalidParamError("pageId must be a numeric Graph id");
  const result = await client.post<{ id?: unknown }>(`${pageId}/videos`, {
    file_url: requireHttps(input.fileUrl, "fileUrl"),
    description: requireCaption(input.description),
  });
  if (isDryRun(result)) return { dryRun: true, planned: [result.planned] };
  const mediaId = requireId(result.id, "id");
  return { dryRun: false, mediaId, containerId: null, postId: null, permalink: null, recovered: false };
}

/** Deletes one published organic object. */
export async function deleteOrganicObject(client: MetaGraphClient, objectId: string): Promise<{ dryRun: true; planned: DryRunResult["planned"] } | { dryRun: false; success: boolean }> {
  if (!ID_RE.test(objectId)) throw new InvalidParamError("objectId must be a numeric Graph id");
  const result = await client.delete<{ success?: unknown }>(objectId);
  if (isDryRun(result)) return { dryRun: true, planned: result.planned };
  return { dryRun: false, success: result.success === true };
}
