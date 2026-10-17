/**
 * The publishing pipeline (A8, RK9-514), a brand-agnostic port of Sunspot's
 * publish-ad.mjs:
 *
 *   staged creative + publication text -> prevalidate (no Meta call) ->
 *   final URL with UTM -> media (video by file_url, ready polling) ->
 *   ad creative -> PAUSED ad in the bound ad set (or a creative swap on an
 *   existing ad) -> publications row -> spend gate hand-off.
 *
 * Safety:
 * - Every ad is created PAUSED (`createAd` hard-codes it, and the spend
 *   guarded client refuses anything else). No code path here sends ACTIVE or
 *   touches an ad set or campaign status; activation is A9's Telegram gate.
 * - Swap mode sends only `{ creative: { creative_id }, status: "PAUSED" }`, and
 *   only to a PAUSED ad that a publication of this company made.
 * - A publications row is written as `pending` before the first Meta write,
 *   and every Meta id is stored right after the write that made it, so a re-run
 *   with the same key resumes and never creates a second creative or ad.
 * - Long work (video processing can take minutes) runs as a background
 *   promise of short Graph calls, each well inside the host's 30 s RPC limit.
 *   The action returns the publication id at once; `publication` data polls it.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import type { BindingStore } from "../brand/provision.js";
import type { BrandConfig } from "../config.js";
import { parseCreativeManifest } from "../creative-manifest/schema.js";
import type { Initiator, OnceStore } from "../features/spend-guard/support.js";
import { localDate } from "../kit/local-time.js";
import { MediaProcessingError, MetaGraphError, operatorMessage, WriteRefusedError } from "../meta/errors.js";
import type { MetaGraphClient } from "../meta/graph.js";
import {
  adAccountPath,
  createAd,
  createAdCreative,
  deleteObject,
  getAdOwner,
  getObjectStatus,
  getVideoThumbnails,
  listAdSetAds,
  swapAdCreative,
  uploadVideoByUrl,
  waitForVideoReady,
} from "../meta/methods.js";
import { isDryRun } from "../meta/types.js";
import { adName, contentHash, publicationKey } from "./ad-name.js";
import { buildCreativeBody, type CreativeBody } from "./creative.js";
import { baseFinalUrl, buildFinalUrl } from "./final-url.js";
import { onPublished as defaultOnPublished, type OnPublishedHook } from "./handoff.js";
import { prevalidate, PrevalidationError } from "./prevalidate.js";
import type { CreativeRow, CreativeSource, PublicationPatch, PublicationStore } from "./store.js";
import { PLACEMENTS, type PublicationMode, type PublicationPayload, type PublicationRecord, type PublicationText, type PublishSpec } from "./types.js";

export const PUBLICATION_ENTITY_TYPE = "rk9_ads_publication";
export const HANDOFF_ONCE_KIND = "publication_handoff";

/** Placeholders a dry-run plan shows for ids that only exist after a write. */
export const PLACEHOLDER = {
  adsetId: "{adset_id}",
  videoId: "{video_id}",
  thumbnailUrl: "{thumbnail_url}",
  creativeId: "{creative_id}",
} as const;

export type PublishErrorCode =
  | "invalid_request"
  | "plugin_not_enabled"
  | "creative_not_found"
  | "creative_not_publishable"
  | "creative_expired"
  | "no_bound_adset"
  | "adset_not_bound"
  | "ad_not_in_account"
  | "ad_not_owned"
  | "ad_not_paused"
  | "idempotency_key_conflict"
  | "publication_not_found";

export class PublishError extends Error {
  readonly code: PublishErrorCode;

  constructor(code: PublishErrorCode, message: string) {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const copySchema = z
  .object({
    message: z.string().max(10_000),
    title: z.string().max(10_000).optional(),
    description: z.string().max(10_000).optional(),
  })
  .strict();

const textSchema = z
  .object({
    copy: copySchema.optional(),
    cta: z.string().max(64).optional(),
    landingUrlKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
    utmCampaign: z.string().max(200).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    creativeId: z.string().uuid().optional(),
    manifest: z.unknown().optional(),
    text: textSchema.optional(),
    placement: z.enum(PLACEMENTS).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    durationSec: z.number().positive().optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
    adId: z.string().regex(/^\d{1,32}$/).optional(),
    dryRun: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export type PublishRequest = z.infer<typeof requestSchema>;

/** Parses action params; throws PublishError("invalid_request") naming the first bad field. */
export function parsePublishRequest(params: Record<string, unknown>): PublishRequest {
  const result = requestSchema.safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join(".") || "params";
    throw new PublishError("invalid_request", `${path}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type MediaPlan =
  | {
      kind: "video";
      /** `reuse` an uploaded video id, or `upload` by file_url. */
      action: "reuse" | "upload";
      videoId: string | null;
      upload: { method: "POST"; path: string; body: { file_url: string; name: string } } | null;
      thumbnail: { source: "poster"; url: string } | { source: "meta_thumbnails"; path: string };
    }
  | { kind: "image"; action: "url"; imageUrl: string };

export interface PublishPlan {
  dryRun: true;
  mode: PublicationMode;
  brandCode: string;
  adName: string;
  contentHash: string;
  idempotencyKey: string;
  finalUrl: string;
  campaignId: string | null;
  adsetId: string;
  media: MediaPlan;
  creative: { method: "POST"; path: string; body: CreativeBody };
  ad:
    | { method: "POST"; path: string; body: { name: string; adset_id: string; creative: { creative_id: string }; status: "PAUSED" } }
    | { method: "POST"; path: string; body: { creative: { creative_id: string }; status: "PAUSED" } };
  warnings: string[];
}

interface Resolved {
  config: BrandConfig;
  spec: PublishSpec;
  creative: CreativeRow | null;
  adsetId: string | null;
  campaignId: string | null;
  targetAdId: string | null;
}

export interface PublicationView {
  id: string;
  mode: PublicationMode;
  status: PublicationRecord["status"];
  adName: string | null;
  finalUrl: string | null;
  adsetId: string | null;
  metaVideoId: string | null;
  metaCreativeId: string | null;
  metaAdId: string | null;
  error: string | null;
  cleanup: PublicationPayload["cleanup"] | null;
  publishedAt: string | null;
  updatedAt: string | null;
}

export function toPublicationView(record: PublicationRecord): PublicationView {
  return {
    id: record.id,
    mode: record.mode,
    status: record.status,
    adName: record.adName,
    finalUrl: record.payload?.finalUrl ?? null,
    adsetId: record.adsetId,
    metaVideoId: record.metaVideoId,
    metaCreativeId: record.metaCreativeId,
    metaAdId: record.metaAdId,
    error: record.error,
    cleanup: record.payload?.cleanup ?? null,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface VideoOptions {
  /** Pause between video status polls. Default 5 s. */
  pollIntervalMs?: number;
  /** Total wait for video_status=ready. Default 10 min. */
  timeoutMs?: number;
  /** Reads of /{video}/thumbnails before giving up (they can be empty right after ready). Default 3. */
  thumbnailAttempts?: number;
  /** Pause between those reads. Default 5 s. */
  thumbnailRetryMs?: number;
}

export interface PublishServiceDeps {
  ctx: Pick<PluginContext, "activity" | "logger">;
  store: PublicationStore;
  creatives: CreativeSource;
  bindings: BindingStore;
  once: OnceStore;
  loadConfig(companyId: string): Promise<{ ok: true; config: BrandConfig } | { ok: false; error: string }>;
  /** The brand's live, spend-guarded write client. */
  writeClient(companyId: string, config: BrandConfig, initiator: Initiator): MetaGraphClient;
  /** A read-only client for checks before a run (swap target ownership). */
  readClient(companyId: string, config: BrandConfig): MetaGraphClient;
  /** The launch gate (A4). Runs before the first Meta write of a run. */
  assertLaunchReady?(companyId: string, config: BrandConfig): Promise<void>;
  onPublished?: OnPublishedHook;
  now?: () => Date;
  video?: VideoOptions;
}

export interface PublishOutcome {
  created: boolean;
  /** True when this call started (or resumed) a background run. */
  started: boolean;
  publication: PublicationView;
}

const PUBLISHABLE_CREATIVE_STATUSES = new Set(["ready", "staged", "uploading", "published"]);

export function createPublishService(deps: PublishServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const handoff = deps.onPublished ?? defaultOnPublished;
  const running = new Map<string, Promise<void>>();

  async function enabledConfig(companyId: string): Promise<BrandConfig> {
    const loaded = await deps.loadConfig(companyId);
    if (!loaded.ok) throw new PublishError("plugin_not_enabled", loaded.error);
    return loaded.config;
  }

  async function logActivity(companyId: string, publicationId: string, message: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await deps.ctx.activity.log({
        companyId,
        message: `rk9-ads publication: ${message}`,
        entityType: PUBLICATION_ENTITY_TYPE,
        entityId: publicationId,
        metadata,
      });
    } catch (error) {
      // The Meta id is already stored; a lost audit line must not fail the publication.
      deps.ctx.logger.warn("rk9-ads: could not write a publication activity entry", {
        companyId,
        publicationId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // --- resolving ----------------------------------------------------------

  function specFromCreative(creative: CreativeRow, request: PublishRequest): PublishSpec {
    const text: PublicationText = request.text ?? {};
    const copy = text.copy ?? creative.copy;
    const cta = text.cta ?? creative.cta;
    const landingUrlKey = text.landingUrlKey ?? creative.landingUrlKey;
    const utmCampaign = text.utmCampaign ?? creative.utmCampaign;
    return {
      brand: creative.brand,
      kind: creative.kind,
      mediaUrl: creative.mediaUrl,
      posterUrl: creative.kind === "video" ? creative.posterUrl : null,
      sha256: creative.sha256,
      aspectRatio: creative.aspectRatio ?? "",
      copy: copy ?? { message: "" },
      cta: cta ?? "",
      landingUrlKey: landingUrlKey ?? "",
      utmCampaign: utmCampaign ?? "",
      ...(request.placement ? { placement: request.placement } : {}),
      ...(request.sizeBytes !== undefined ? { sizeBytes: request.sizeBytes } : {}),
      ...(request.durationSec !== undefined ? { durationSec: request.durationSec } : {}),
    };
  }

  async function resolve(companyId: string, request: PublishRequest, mode: PublicationMode, options: { requireStaged: boolean; requireAdset: boolean }): Promise<Resolved> {
    const config = await enabledConfig(companyId);
    let spec: PublishSpec;
    let creative: CreativeRow | null = null;
    let targetAdsetId: string | null = null;

    if (request.creativeId) {
      creative = await deps.creatives.get(companyId, request.creativeId);
      if (!creative) throw new PublishError("creative_not_found", `creative ${request.creativeId} not found for this company`);
      if (!PUBLISHABLE_CREATIVE_STATUSES.has(creative.status)) {
        throw new PublishError("creative_not_publishable", `creative is ${creative.status}; stage it again first`);
      }
      if (creative.kind === "video" && creative.status === "uploading" && !creative.metaVideoId) {
        throw new PublishError("creative_not_publishable", "the creative's video upload is still starting; retry in a minute");
      }
      if (creative.validUntil && new Date(creative.validUntil).getTime() <= now().getTime()) {
        throw new PublishError("creative_expired", `creative was valid until ${creative.validUntil}`);
      }
      spec = specFromCreative(creative, request);
      targetAdsetId = creative.targetAdsetId;
    } else if (request.manifest !== undefined && !options.requireStaged) {
      const parsed = parseCreativeManifest(request.manifest);
      if (!parsed.ok) {
        const first = parsed.issues[0];
        throw new PublishError("invalid_request", `manifest${first?.path ?? ""}: ${first?.message ?? "invalid"}`);
      }
      const manifest = parsed.manifest;
      const text = request.text ?? {};
      spec = {
        brand: manifest.brand,
        kind: manifest.kind,
        mediaUrl: manifest.mediaUrl,
        posterUrl: manifest.posterUrl ?? null,
        sha256: manifest.sha256,
        aspectRatio: manifest.aspectRatio,
        copy: text.copy ?? manifest.copy,
        cta: text.cta ?? manifest.cta,
        landingUrlKey: text.landingUrlKey ?? manifest.landingUrlKey,
        utmCampaign: text.utmCampaign ?? manifest.utmCampaign,
        ...(request.placement ? { placement: request.placement } : {}),
        ...(request.sizeBytes !== undefined ? { sizeBytes: request.sizeBytes } : {}),
        ...(request.durationSec !== undefined ? { durationSec: request.durationSec } : {}),
      };
      targetAdsetId = manifest.targetAdsetId ?? null;
    } else {
      throw new PublishError("invalid_request", options.requireStaged ? "creativeId is required" : "creativeId or manifest is required");
    }

    let adsetId: string | null;
    let campaignId: string | null;
    let targetAdId: string | null = null;
    if (mode === "swap") {
      if (!request.adId) throw new PublishError("invalid_request", "adId is required for a creative swap");
      // Only an ad that a publication of this company made, and only while it is PAUSED:
      // a swap must never put new content live or restart spend (G1).
      if (!(await deps.store.findByAd(companyId, request.adId))) {
        throw new PublishError("ad_not_owned", `ad ${request.adId} was not published by this company's ads plugin`);
      }
      const readClient = deps.readClient(companyId, config);
      const owner = await getAdOwner(readClient, request.adId);
      if (owner.accountId !== config.meta.adAccountId) {
        throw new PublishError("ad_not_in_account", `ad ${request.adId} is not in this brand's ad account`);
      }
      const adStatus = await getObjectStatus(readClient, request.adId);
      if (adStatus.status !== "PAUSED") {
        throw new PublishError("ad_not_paused", `ad ${request.adId} has status ${adStatus.status ?? "unknown"}; pause it before a creative swap`);
      }
      targetAdId = request.adId;
      adsetId = owner.adsetId;
      campaignId = null;
    } else {
      const binding = await deps.bindings.get(companyId, config.brandCode);
      adsetId = binding?.adSetId ?? config.meta.adSetId ?? null;
      campaignId = binding?.campaignId ?? config.meta.campaignId ?? null;
      if (!adsetId && options.requireAdset) {
        throw new PublishError("no_bound_adset", "the brand has no bound ad set; run provision first (G8)");
      }
      if (targetAdsetId && adsetId && targetAdsetId !== adsetId) {
        throw new PublishError("adset_not_bound", `targetAdsetId ${targetAdsetId} is not the brand's bound ad set ${adsetId}`);
      }
    }
    return { config, spec, creative, adsetId, campaignId, targetAdId };
  }

  function buildPlan(companyId: string, resolved: Resolved, mode: PublicationMode, callerKey: string | undefined): PublishPlan {
    const { config, spec, creative } = resolved;
    const checked = prevalidate(spec, config);
    if (!checked.ok) throw new PrevalidationError(checked.issues);

    const warnings: string[] = [];
    const adsetId = resolved.adsetId ?? PLACEHOLDER.adsetId;
    if (!resolved.adsetId) warnings.push("no bound ad set yet: run provision before a real publish");
    const base = baseFinalUrl(checked.landingUrl, spec.utmCampaign);
    const hash = contentHash({
      kind: spec.kind,
      sha256: spec.sha256,
      mediaUrl: spec.mediaUrl,
      posterUrl: spec.posterUrl,
      copy: spec.copy,
      cta: spec.cta,
      finalUrl: base,
      adsetId,
    });
    const name = adName({ brandCode: config.brandCode, campaign: spec.utmCampaign, kind: spec.kind, localDate: localDate(now(), config.timeZone), contentHash: hash });
    const finalUrl = buildFinalUrl(checked.landingUrl, {
      campaign: spec.utmCampaign,
      utmTemplate: config.landing.utmTemplate,
      values: { brand: config.brandCode, adset: adsetId, ad: name },
    });
    const account = adAccountPath(config.meta.adAccountId);

    let media: MediaPlan;
    let creativeMedia: Parameters<typeof buildCreativeBody>[0]["media"];
    if (spec.kind === "video") {
      const videoId = creative?.metaVideoId ?? null;
      media = {
        kind: "video",
        action: videoId ? "reuse" : "upload",
        videoId,
        upload: videoId ? null : { method: "POST", path: `${account}/advideos`, body: { file_url: spec.mediaUrl, name } },
        thumbnail: spec.posterUrl
          ? { source: "poster", url: spec.posterUrl }
          : { source: "meta_thumbnails", path: `${videoId ?? PLACEHOLDER.videoId}/thumbnails` },
      };
      creativeMedia = { kind: "video", videoId: videoId ?? PLACEHOLDER.videoId, thumbnailUrl: spec.posterUrl ?? PLACEHOLDER.thumbnailUrl };
    } else {
      media = { kind: "image", action: "url", imageUrl: spec.mediaUrl };
      creativeMedia = { kind: "image", imageUrl: spec.mediaUrl };
    }

    const creativeBody = buildCreativeBody({
      name,
      pageId: config.meta.pageId,
      igUserId: config.meta.igUserId ?? null,
      finalUrl,
      copy: spec.copy,
      cta: spec.cta,
      media: creativeMedia,
    });
    const ad: PublishPlan["ad"] =
      mode === "swap"
        ? { method: "POST", path: resolved.targetAdId!, body: { creative: { creative_id: PLACEHOLDER.creativeId }, status: "PAUSED" } }
        : {
            method: "POST",
            path: `${account}/ads`,
            body: { name, adset_id: adsetId, creative: { creative_id: PLACEHOLDER.creativeId }, status: "PAUSED" },
          };

    return {
      dryRun: true,
      mode,
      brandCode: config.brandCode,
      adName: name,
      contentHash: hash,
      idempotencyKey: publicationKey({ companyId, mode, key: callerKey ?? hash, ...(resolved.targetAdId ? { targetAdId: resolved.targetAdId } : {}) }),
      finalUrl,
      campaignId: resolved.campaignId,
      adsetId,
      media,
      creative: { method: "POST", path: `${account}/adcreatives`, body: creativeBody },
      ad,
      warnings,
    };
  }

  // --- runner -------------------------------------------------------------

  async function save(companyId: string, id: string, patch: PublicationPatch): Promise<void> {
    if (!(await deps.store.update(companyId, id, "pending", patch))) {
      throw new Error(`publication ${id} is no longer pending; this run stops`);
    }
  }

  async function firstThumbnail(client: MetaGraphClient, videoId: string): Promise<string> {
    const attempts = Math.max(1, Math.min(deps.video?.thumbnailAttempts ?? 3, 10));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const thumbnails = await getVideoThumbnails(client, videoId);
      const pick = thumbnails.find((thumbnail) => thumbnail.isPreferred) ?? thumbnails[0];
      if (pick) return pick.uri;
      if (attempt < attempts) await client.sleep(deps.video?.thumbnailRetryMs ?? 5_000);
    }
    throw new Error(`Meta has no thumbnail for video ${videoId} yet; give the manifest a posterUrl or retry later`);
  }

  async function cleanupCreative(companyId: string, record: PublicationRecord, client: MetaGraphClient, creativeId: string, cause: unknown): Promise<void> {
    try {
      await deleteObject(client, creativeId);
      await save(companyId, record.id, { metaCreativeId: null });
      await logActivity(companyId, record.id, "orphan creative deleted", { metaObjectId: creativeId, step: "cleanup_delete" });
    } catch (error) {
      const reason = `${operatorMessage(error)} (after: ${operatorMessage(cause)})`.slice(0, 500);
      // The creative stays referenced, so a re-run reuses it instead of leaving it behind.
      await save(companyId, record.id, { payload: { ...record.payload, cleanup: { creativeId, reason } } }).catch(() => undefined);
      await logActivity(companyId, record.id, "orphan creative needs cleanup", { metaObjectId: creativeId, step: "cleanup_pending" });
    }
  }

  /** The ad write surely did not happen: the guard refused it, or Meta answered with a 4xx Graph error. */
  function adWriteRejected(error: unknown): boolean {
    if (error instanceof WriteRefusedError) return true;
    return error instanceof MetaGraphError && error.code !== null && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500;
  }

  /** A settled run drops a stale cleanup marker: its creative is now the ad's creative. */
  async function clearedCleanup(companyId: string, id: string): Promise<{ payload?: PublicationPayload }> {
    const latest = await deps.store.get(companyId, id);
    if (!latest?.payload.cleanup) return {};
    const { cleanup: _cleanup, ...payload } = latest.payload;
    return { payload };
  }

  async function ensureHandoff(companyId: string, record: PublicationRecord): Promise<void> {
    if (record.status !== "published" || !record.metaAdId || !record.metaCreativeId || !record.adsetId || !record.adName) return;
    const key = `publication-handoff:${record.id}`;
    if (!(await deps.once.claim(companyId, key, HANDOFF_ONCE_KIND, { publicationId: record.id }))) return;
    try {
      await handoff({
        publicationId: record.id,
        companyId,
        brandCode: record.brandCode,
        adName: record.adName,
        adId: record.metaAdId,
        adsetId: record.adsetId,
        campaignId: record.campaignId,
        creativeId: record.metaCreativeId,
        finalUrl: record.payload.finalUrl,
        publishedAt: record.publishedAt ?? now().toISOString(),
      });
    } catch (error) {
      // Give the claim back so the next call for this publication hands it off again.
      await deps.once.release(companyId, key);
      deps.ctx.logger.warn("rk9-ads: spend gate hand-off failed", { companyId, publicationId: record.id, error: operatorMessage(error) });
    }
  }

  async function run(companyId: string, id: string, initiator: Initiator): Promise<void> {
    let record = await deps.store.get(companyId, id);
    if (!record || record.status !== "pending") return;
    let client: MetaGraphClient | null = null;
    // The creative this run made, until an ad write that used it succeeded.
    let createdCreativeId: string | null = null;
    let adWriteSent = false;
    try {
      const config = await enabledConfig(companyId);
      if (record.brandCode !== config.brandCode) throw new Error(`the publication is for brand ${record.brandCode}, the config is ${config.brandCode}`);
      if (!record.adsetId || !record.adName) throw new Error("the publication has no ad set or ad name");
      if (deps.assertLaunchReady) await deps.assertLaunchReady(companyId, config);
      client = deps.writeClient(companyId, config, initiator);
      const account = config.meta.adAccountId;
      const payload = record.payload;

      let videoId: string | null = null;
      let thumbnailUrl: string | null = null;
      if (payload.kind === "video") {
        videoId = record.metaVideoId;
        if (!videoId) {
          const uploaded = await uploadVideoByUrl(client, account, { fileUrl: payload.mediaUrl, name: record.adName });
          if (isDryRun(uploaded)) throw new Error("the write client is in dry-run mode");
          videoId = uploaded.videoId;
          await save(companyId, id, { metaVideoId: videoId });
          await logActivity(companyId, id, "video upload started", { metaObjectId: videoId, step: "advideos" });
        }
        try {
          await waitForVideoReady(client, videoId, { intervalMs: deps.video?.pollIntervalMs, timeoutMs: deps.video?.timeoutMs });
        } catch (error) {
          // A failed video is uploaded again on a re-run; a timeout keeps polling the same one.
          if (error instanceof MediaProcessingError) await save(companyId, id, { metaVideoId: null });
          throw error;
        }
        thumbnailUrl = payload.thumbnailUrl ?? payload.posterUrl ?? (await firstThumbnail(client, videoId));
        if (payload.thumbnailUrl !== thumbnailUrl) {
          await save(companyId, id, { payload: { ...payload, thumbnailUrl } });
        }
      }
      record = (await deps.store.get(companyId, id)) ?? record;

      let creativeId = record.metaCreativeId;
      if (!creativeId) {
        const body = buildCreativeBody({
          name: record.adName!,
          pageId: payload.pageId,
          igUserId: payload.igUserId,
          finalUrl: payload.finalUrl,
          copy: payload.copy,
          cta: payload.cta,
          media: payload.kind === "video" ? { kind: "video", videoId: videoId!, thumbnailUrl: thumbnailUrl! } : { kind: "image", imageUrl: payload.mediaUrl },
        });
        const created = await createAdCreative(client, account, body);
        if (isDryRun(created)) throw new Error("the write client is in dry-run mode");
        creativeId = created.creativeId;
        createdCreativeId = creativeId;
        await save(companyId, id, { metaCreativeId: creativeId });
        await logActivity(companyId, id, "ad creative created", { metaObjectId: creativeId, step: "adcreatives" });
      }

      if (record.mode === "swap") {
        const target = payload.targetAdId ?? record.metaAdId;
        if (!target) throw new Error("the swap has no target ad");
        adWriteSent = true;
        const swapped = await swapAdCreative(client, target, creativeId);
        if (isDryRun(swapped)) throw new Error("the write client is in dry-run mode");
        // Unknown outcome: keep the creative on the row; the re-run retries the swap with it.
        if (!swapped.success) throw new Error(`Meta did not confirm the creative swap on ad ${target}; run the swap again`);
        createdCreativeId = null;
        await logActivity(companyId, id, "ad creative swapped", { metaObjectId: target, creativeId, step: "ads_update" });
        await save(companyId, id, { status: "swapped", error: null, publishedAt: now(), ...(await clearedCleanup(companyId, id)) });
        return;
      }

      let adId = record.metaAdId;
      if (!adId) {
        // A crash after the create but before the save leaves an ad with this name and creative: adopt it.
        const existing = (await listAdSetAds(client, record.adsetId!)).find((ad) => ad.name === record!.adName && ad.creativeId === creativeId);
        if (existing) {
          adId = existing.id;
          await save(companyId, id, { metaAdId: adId });
          await logActivity(companyId, id, "existing PAUSED ad adopted", { metaObjectId: adId, step: "ads_adopt" });
        } else {
          adWriteSent = true;
          const created = await createAd(client, account, { name: record.adName!, adsetId: record.adsetId!, creativeId });
          if (isDryRun(created)) throw new Error("the write client is in dry-run mode");
          createdCreativeId = null;
          adId = created.adId;
          await save(companyId, id, { metaAdId: adId });
          await logActivity(companyId, id, "PAUSED ad created", { metaObjectId: adId, creativeId, step: "ads_create" });
        }
      }
      await save(companyId, id, { status: "published", error: null, publishedAt: now(), ...(await clearedCleanup(companyId, id)) });
      const published = await deps.store.get(companyId, id);
      if (published) await ensureHandoff(companyId, published);
    } catch (error) {
      const message = error instanceof PublishError ? `${error.code}: ${error.message}` : operatorMessage(error);
      const current = (await deps.store.get(companyId, id).catch(() => null)) ?? record;
      // Only a creative this run made, and only when no ad can use it: the ad write was not
      // sent or surely did not happen. A lost response or a failed save keeps it; a creative
      // from an earlier run stays referenced, and a re-run reuses or adopts it.
      const orphan = createdCreativeId && (!adWriteSent || adWriteRejected(error)) ? createdCreativeId : null;
      if (client && orphan && current.status === "pending") await cleanupCreative(companyId, current, client, orphan, error);
      const failed = await deps.store.update(companyId, id, "pending", { status: "failed", error: message }).catch(() => false);
      if (failed) await logActivity(companyId, id, "publication failed", { error: message, step: "failed" });
    }
  }

  function start(companyId: string, id: string, initiator: Initiator): boolean {
    if (running.has(id)) return false;
    const task = run(companyId, id, initiator)
      .catch((error) => {
        deps.ctx.logger.error("rk9-ads: publication run crashed", { companyId, publicationId: id, error: operatorMessage(error) });
      })
      .finally(() => running.delete(id));
    running.set(id, task);
    return true;
  }

  async function submit(companyId: string, request: PublishRequest, mode: PublicationMode, initiator: Initiator): Promise<PublishOutcome> {
    const resolved = await resolve(companyId, request, mode, { requireStaged: true, requireAdset: true });
    const plan = buildPlan(companyId, resolved, mode, request.idempotencyKey);
    const existing = await deps.store.findByKey(companyId, plan.idempotencyKey);
    if (existing && existing.contentHash !== plan.contentHash) {
      throw new PublishError("idempotency_key_conflict", "idempotencyKey is already used by a publication with other content");
    }
    let record = existing;
    let created = false;
    if (!record) {
      const replaces = mode === "swap" ? await deps.store.findByAd(companyId, resolved.targetAdId!) : null;
      const payload: PublicationPayload = {
        v: 1,
        kind: resolved.spec.kind,
        mediaUrl: resolved.spec.mediaUrl,
        posterUrl: resolved.spec.posterUrl,
        sha256: resolved.spec.sha256,
        aspectRatio: resolved.spec.aspectRatio,
        placement: resolved.spec.placement ?? null,
        copy: resolved.spec.copy,
        cta: resolved.spec.cta,
        landingUrlKey: resolved.spec.landingUrlKey,
        utmCampaign: resolved.spec.utmCampaign,
        finalUrl: plan.finalUrl,
        pageId: resolved.config.meta.pageId,
        igUserId: resolved.config.meta.igUserId ?? null,
        ...(resolved.targetAdId ? { targetAdId: resolved.targetAdId } : {}),
        thumbnailUrl: null,
        cleanup: null,
      };
      const inserted = await deps.store.insertPending(companyId, {
        brandCode: resolved.config.brandCode,
        creativeId: resolved.creative?.id ?? null,
        idempotencyKey: plan.idempotencyKey,
        contentHash: plan.contentHash,
        mode,
        adName: plan.adName,
        campaignId: resolved.campaignId,
        adsetId: plan.adsetId,
        metaVideoId: resolved.creative?.metaVideoId ?? null,
        metaAdId: resolved.targetAdId,
        replacesPublicationId: replaces?.id ?? null,
        payload,
      });
      record = inserted.record;
      created = inserted.inserted;
      if (record.contentHash !== plan.contentHash) {
        throw new PublishError("idempotency_key_conflict", "idempotencyKey is already used by a publication with other content");
      }
      if (created) await logActivity(companyId, record.id, "publication recorded", { mode, adName: plan.adName, step: "pending" });
    }

    if (record.status === "published") {
      await ensureHandoff(companyId, record);
      return { created, started: false, publication: toPublicationView(record) };
    }
    if (record.status === "swapped") return { created, started: false, publication: toPublicationView(record) };
    if (record.status === "failed") {
      // A re-run resumes from the stored Meta ids.
      await deps.store.update(companyId, record.id, "failed", { status: "pending", error: null });
      record = (await deps.store.get(companyId, record.id)) ?? record;
      if (record.status !== "pending") return { created, started: false, publication: toPublicationView(record) };
    }
    const started = start(companyId, record.id, initiator);
    return { created, started, publication: toPublicationView(record) };
  }

  return {
    /** The full planned payloads. Makes no Meta write (and no Meta call outside swap's ownership read). */
    async plan(companyId: string, request: PublishRequest, mode: PublicationMode = "publish"): Promise<PublishPlan> {
      const resolved = await resolve(companyId, request, mode, { requireStaged: false, requireAdset: false });
      return buildPlan(companyId, resolved, mode, request.idempotencyKey);
    },

    /** Records the publication and starts its run in the background. Returns at once. */
    publish: (companyId: string, request: PublishRequest, initiator: Initiator) => submit(companyId, request, "publish", initiator),

    /** Replaces the creative of a PAUSED ad (`adId`) that this company published. The ad stays PAUSED. */
    swap: (companyId: string, request: PublishRequest, initiator: Initiator) => submit(companyId, request, "swap", initiator),

    async get(companyId: string, id: string): Promise<PublicationView | null> {
      const record = await deps.store.get(companyId, id);
      return record ? toPublicationView(record) : null;
    },

    /** Resolves when the background run of `id` (or every run) has finished. Tests and shutdown. */
    async settled(id?: string): Promise<void> {
      if (id) await running.get(id);
      else await Promise.all([...running.values()]);
    },

    isRunning: (id: string) => running.has(id),
  };
}

export type PublishService = ReturnType<typeof createPublishService>;
