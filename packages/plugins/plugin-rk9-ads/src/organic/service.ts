/**
 * Organic posting (RK9-832): the card, the publish after an approved card, the
 * reject reason and the board delete.
 *
 * Invariant: a post reaches Meta only from `publishApproved`, which runs only
 * as the organic_publish gate handler, i.e. after a pending -> approved tap
 * by an allowlisted approver in the brand's chat (kit/gate/callback-router).
 * `requestCard` writes nothing to Meta. There is no buttonless path; a later
 * standing permission (RK9-833) is a separate decision.
 *
 * Notices go to the Ads digest (digest/run.ts reads organic_posts), never as
 * new Telegram messages: the only Telegram writes here are the card and its
 * edits (RK9-815).
 */

import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ORGANIC_PAGE_TOKEN_CONFIG_PATH, type BrandConfig, type OrganicChannel } from "../config.js";
import type { GateHandler, GateHandlerResult } from "../kit/gate/registry.js";
import type { GateCard, GateRequestRecord } from "../kit/gate/state-machine.js";
import { createMetaClient, type MetaClientContext, type MetaGraphClient } from "../meta/graph.js";
import { getTokenPermissions } from "../meta/methods.js";
import {
  deleteOrganicObject,
  ORGANIC_CAPTION_MAX_CHARS,
  organicWriteGuard,
  publishFbPhoto,
  publishFbVideo,
  publishIgImage,
  publishIgReel,
  type ContainerWaitOptions,
  type OrganicPublishResult,
  type OrganicTarget,
} from "../meta/organic.js";
import { redactText } from "../meta/redact.js";
import type { CreativeRow, CreativeSource } from "../publish/store.js";
import { fitsTextCard, organicCardCandidates, organicCardText } from "./card.js";
import { checkLint } from "./lint.js";
import { effectiveStatus, type OrganicPostStore } from "./store.js";
import {
  CHANNEL_ASPECT_RATIOS,
  CHANNEL_LABELS,
  CHANNEL_MEDIA,
  ORGANIC_ACTIVITY_PREFIX,
  ORGANIC_ENTITY_TYPE,
  ORGANIC_GATE_KIND,
  ORGANIC_REJECT_REASONS,
  type OrganicBinding,
  type OrganicLint,
  type OrganicPost,
} from "./types.js";

/** Scopes an IG publish needs on meta.accessTokenRef. A missing one is the operator's decision (RK9-832). */
export const IG_PUBLISH_SCOPES = ["instagram_basic", "instagram_content_publish"] as const;
const MAX_HASHTAGS = 30;
const USABLE_CREATIVE_STATUSES = new Set(["staged", "uploading", "ready", "published"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^\d+$/;

export const ORGANIC_LABELS = { approve: "📣 Julkaise", deny: "❌ Hylkää" } as const;

export class OrganicError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrganicError";
  }
}

export interface OrganicCardTransport {
  sendGateCard(input: {
    companyId: string;
    kind: typeof ORGANIC_GATE_KIND;
    validUntil: Date;
    card: GateCard & { mediaUrl?: string };
    payload?: Record<string, unknown>;
    labels?: { approve?: string; deny?: string };
    denyDecision?: "denied";
  }): Promise<{ id: string; messageId: number }>;
}

export type LoadConfig = (companyId: string) => Promise<{ ok: true; config: BrandConfig } | { ok: false; error: string }>;

/** Which client a write needs: IG on meta.accessTokenRef, FB on the Page token. */
export type OrganicClientFactory = (companyId: string, config: BrandConfig, channel: OrganicChannel, target: OrganicTarget) => MetaGraphClient;

export interface OrganicServiceDeps {
  ctx: Pick<PluginContext, "activity" | "logger">;
  posts: OrganicPostStore;
  creatives: CreativeSource;
  transport(): OrganicCardTransport | null;
  loadConfig: LoadConfig;
  /** Write client with the organic guard. Mode: live only when config.organic.mode is live. */
  writeClient: OrganicClientFactory;
  /** Read-only client on meta.accessTokenRef (the scope check). */
  readClient(companyId: string, config: BrandConfig): MetaGraphClient;
  wait?: ContainerWaitOptions;
  now?: () => Date;
}

export interface OrganicRequestInput {
  creativeId: string;
  channel: OrganicChannel;
  caption?: string;
  brandLint?: unknown;
}

export type OrganicRequestResult =
  | { status: "card_sent"; postId: string; gateRequestId: string; channel: OrganicChannel; mode: "dry_run" | "live"; validUntil: string }
  | { status: "exists"; postId: string; postStatus: string; channel: OrganicChannel };

function safe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactText(text).slice(0, 300);
}

/** Content identity: company, the creative's bytes, the channel and the exact caption. */
export function organicContentHash(companyId: string, creativeSha256: string, channel: OrganicChannel, caption: string): string {
  return createHash("sha256").update(JSON.stringify([companyId, creativeSha256, channel, caption])).digest("hex");
}

export function bindingOf(request: Pick<GateRequestRecord, "kind" | "payload">): OrganicBinding | null {
  if (request.kind !== ORGANIC_GATE_KIND) return null;
  const raw = request.payload?.organic as Partial<OrganicBinding> | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.postId !== "string" || !UUID_RE.test(raw.postId)) return null;
  if (typeof raw.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.contentHash)) return null;
  if (typeof raw.channel !== "string" || !(raw.channel in CHANNEL_LABELS)) return null;
  return { postId: raw.postId, contentHash: raw.contentHash, channel: raw.channel as OrganicChannel };
}

/** Why a brand cannot use a channel now; null when it can. */
export function channelProblem(config: BrandConfig, channel: OrganicChannel): string | null {
  const organic = config.organic;
  if (!organic?.enabled) return "organic posting is off for this brand (organic.enabled)";
  if (!organic.channels.includes(channel)) return `channel ${channel} is not in organic.channels`;
  if (channel.startsWith("ig_") && !config.meta.igUserId) return "an ig_* channel needs meta.igUserId";
  if (channel.startsWith("fb_") && !organic.pageAccessTokenRef) return "an fb_* channel needs organic.pageAccessTokenRef";
  return null;
}

function cleanCaption(text: string): string {
  // Control characters other than the line feed are dropped; Meta and Telegram show the rest as typed.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
}

function creativeProblem(creative: CreativeRow, channel: OrganicChannel, now: Date): string | null {
  if (!USABLE_CREATIVE_STATUSES.has(creative.status)) return `the creative is ${creative.status}`;
  if (creative.validUntil && Date.parse(creative.validUntil) <= now.getTime()) return "the creative is past its validUntil";
  if (CHANNEL_MEDIA[channel] !== creative.kind) return `${channel} takes a ${CHANNEL_MEDIA[channel]} creative, this one is ${creative.kind}`;
  const ratios = CHANNEL_ASPECT_RATIOS[channel];
  if (ratios && creative.aspectRatio && !ratios.includes(creative.aspectRatio)) {
    return `${channel} takes aspect ratio ${ratios.join(" or ")}, this creative is ${creative.aspectRatio}`;
  }
  return null;
}

export function createOrganicService(deps: OrganicServiceDeps) {
  const now = deps.now ?? (() => new Date());

  async function audit(companyId: string, postId: string, event: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await deps.ctx.activity.log({ companyId, message: `${ORGANIC_ACTIVITY_PREFIX}: ${event}`, entityType: ORGANIC_ENTITY_TYPE, entityId: postId, metadata });
    } catch (error) {
      deps.ctx.logger.warn("rk9-ads organic: activity log failed", { postId, detail: safe(error) });
    }
  }

  async function config(companyId: string): Promise<BrandConfig> {
    const loaded = await deps.loadConfig(companyId);
    if (!loaded.ok) throw new OrganicError("config_unavailable", loaded.error);
    return loaded.config;
  }

  function targetOf(config: BrandConfig, deleteId?: string): OrganicTarget {
    return { pageId: config.meta.pageId, ...(config.meta.igUserId ? { igUserId: config.meta.igUserId } : {}), ...(deleteId ? { deleteId } : {}) };
  }

  async function assertIgScopes(companyId: string, cfg: BrandConfig): Promise<void> {
    let granted: string[];
    try {
      granted = (await getTokenPermissions(deps.readClient(companyId, cfg))).granted;
    } catch (error) {
      throw new OrganicError("scope_check_failed", `could not read the token permissions: ${safe(error)}`);
    }
    const missing = IG_PUBLISH_SCOPES.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) {
      throw new OrganicError("missing_scope", `meta.accessTokenRef lacks ${missing.join(", ")}; a new permission is the operator's decision`);
    }
  }

  /**
   * Opens one card for one post. Writes nothing to Meta. Refuses a failed or
   * draft brand-lint, a creative the channel cannot take, and a caption over
   * Instagram's limits. The same content with an open card or a live post
   * returns that post instead of a second card.
   */
  async function requestCard(companyId: string, input: OrganicRequestInput, initiator: Record<string, unknown>): Promise<OrganicRequestResult> {
    if (!UUID_RE.test(companyId)) throw new OrganicError("invalid_request", "company context is required");
    if (typeof input.creativeId !== "string" || !UUID_RE.test(input.creativeId)) throw new OrganicError("invalid_request", "creativeId must be a uuid");
    if (typeof input.channel !== "string" || !(input.channel in CHANNEL_LABELS)) {
      throw new OrganicError("invalid_request", `channel must be one of ${Object.keys(CHANNEL_LABELS).join(", ")}`);
    }
    const channel = input.channel;
    const cfg = await config(companyId);
    const problem = channelProblem(cfg, channel);
    if (problem) throw new OrganicError("channel_unavailable", problem);
    const creative = await deps.creatives.get(companyId, input.creativeId);
    if (!creative) throw new OrganicError("not_found", "creative not found");
    const creativeIssue = creativeProblem(creative, channel, now());
    if (creativeIssue) throw new OrganicError("creative_unusable", creativeIssue);

    if (input.caption !== undefined && typeof input.caption !== "string") throw new OrganicError("invalid_request", "caption must be a string");
    const caption = cleanCaption(input.caption ?? creative.copy?.message ?? "");
    if (caption.length > ORGANIC_CAPTION_MAX_CHARS) throw new OrganicError("invalid_caption", `caption exceeds ${ORGANIC_CAPTION_MAX_CHARS} characters`);
    if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > MAX_HASHTAGS) throw new OrganicError("invalid_caption", `caption has more than ${MAX_HASHTAGS} hashtags`);

    let lint: OrganicLint | null = null;
    if (input.brandLint !== undefined && input.brandLint !== null) {
      const checked = checkLint(input.brandLint);
      if (!checked.ok) throw new OrganicError(checked.code, checked.message);
      lint = checked.lint;
    }

    const mode = cfg.organic!.mode;
    if (mode === "live" && channel.startsWith("ig_")) await assertIgScopes(companyId, cfg);

    const contentHash = organicContentHash(companyId, creative.sha256, channel, caption);
    const existing = await deps.posts.findOpen(companyId, contentHash);
    if (existing) {
      if (effectiveStatus(existing) !== "expired") {
        return { status: "exists", postId: existing.id, postStatus: existing.status, channel };
      }
      await deps.posts.update(companyId, existing.id, "pending", { status: "expired" });
    }

    const transport = deps.transport();
    if (!transport) throw new OrganicError("telegram_unavailable", "Telegram is not configured or not ready for this company");
    const validUntil = new Date(now().getTime() + cfg.organic!.cardTtlHours * 3_600_000);
    const text = organicCardText({ brandCode: cfg.brandCode, channel, mode, caption, lint, validUntil, timeZone: cfg.timeZone, creativeId: creative.id });
    if (!fitsTextCard(text, creative.mediaUrl)) throw new OrganicError("invalid_caption", "the card does not fit a Telegram message");

    const post = await deps.posts.insertPending(companyId, {
      brandCode: cfg.brandCode,
      creativeId: creative.id,
      channel,
      caption,
      contentHash,
      mode,
      lint,
      payload: { initiator, mediaUrl: creative.mediaUrl },
    });
    if (!post) {
      const raced = await deps.posts.findOpen(companyId, contentHash);
      if (raced) return { status: "exists", postId: raced.id, postStatus: raced.status, channel };
      throw new OrganicError("conflict", "an open post of this content exists");
    }

    const binding: OrganicBinding = { postId: post.id, contentHash, channel };
    let sent: { id: string; messageId: number } | null = null;
    let lastError: unknown = null;
    for (const candidate of organicCardCandidates(text, { kind: creative.kind, mediaUrl: creative.mediaUrl, posterUrl: creative.posterUrl })) {
      try {
        sent = await transport.sendGateCard({
          companyId,
          kind: ORGANIC_GATE_KIND,
          validUntil,
          card: { media: candidate.media, text: candidate.text, ...(candidate.mediaUrl ? { mediaUrl: candidate.mediaUrl } : {}) },
          payload: { organic: binding },
          labels: ORGANIC_LABELS,
          denyDecision: "denied",
        });
        break;
      } catch (error) {
        lastError = error;
        deps.ctx.logger.warn("rk9-ads organic: card send failed, trying the next preview", { postId: post.id, media: candidate.media, detail: safe(error) });
      }
    }
    if (!sent) {
      await deps.posts.update(companyId, post.id, "pending", { status: "failed", error: `card not sent: ${safe(lastError)}` });
      await audit(companyId, post.id, "card failed", { channel, error: safe(lastError) });
      throw new OrganicError("card_failed", `the card could not be sent: ${safe(lastError)}`);
    }
    // A tap can come before this write; the handler finds the post through the card's binding.
    await deps.posts.update(companyId, post.id, "pending", { gateRequestId: sent.id });
    await audit(companyId, post.id, "card sent", { channel, mode, gateRequestId: sent.id, creativeId: creative.id, lintOk: lint?.ok ?? null });
    return { status: "card_sent", postId: post.id, gateRequestId: sent.id, channel, mode, validUntil: validUntil.toISOString() };
  }

  function refuse(statusText: string, reason: string, binding: OrganicBinding | null, tgUserId: number): GateHandlerResult {
    return {
      status: "denied",
      statusText,
      outcome: { handler: "done", result: "denied", reason, postId: binding?.postId ?? null, decidedBy: { tgUserId } },
      error: reason,
    };
  }

  /**
   * The organic_publish gate handler: runs once, after an approved tap. It
   * checks again that the card still names this post and its unchanged
   * content and that the brand still allows the channel, then publishes.
   */
  const publishApproved: GateHandler = async ({ request, tgUserId }) => {
    const binding = bindingOf(request);
    if (!binding || request.status !== "approved") return refuse("⛔ Kortti ei kelpaa: ei julkaistu.", "invalid_card", binding, tgUserId);
    const { companyId } = request;
    const post = await deps.posts.get(companyId, binding.postId);
    if (!post || post.contentHash !== binding.contentHash || post.channel !== binding.channel) {
      return refuse("⛔ Postaus ei vastaa korttia: ei julkaistu.", "post_mismatch", binding, tgUserId);
    }
    if (post.gateRequestId && post.gateRequestId !== request.id) return refuse("⛔ Postauksella on toinen kortti: ei julkaistu.", "other_card", binding, tgUserId);
    if (post.status !== "pending") return refuse(`⛔ Postaus on jo ${post.status}: ei julkaistu.`, `post_${post.status}`, binding, tgUserId);

    // A refusal from here on closes the post too, so the same content can get a new card.
    const close = async (statusText: string, reason: string): Promise<GateHandlerResult> => {
      await deps.posts.update(companyId, post.id, "pending", { status: "failed", gateRequestId: request.id, error: `not published: ${reason}`.slice(0, 300) });
      await audit(companyId, post.id, "refused", { channel: post.channel, gateRequestId: request.id, reason: reason.slice(0, 300) });
      return refuse(statusText, reason, binding, tgUserId);
    };
    let cfg: BrandConfig;
    try {
      cfg = await config(companyId);
    } catch (error) {
      return close("⛔ Brändin asetuksia ei saatu: ei julkaistu.", safe(error));
    }
    const problem = cfg.brandCode === request.brandCode ? channelProblem(cfg, post.channel) : "the brand code changed";
    if (problem) return close("⛔ Kanava ei ole enää käytössä: ei julkaistu.", problem);
    const creative = await deps.creatives.get(companyId, post.creativeId);
    if (!creative || organicContentHash(companyId, creative.sha256, post.channel, post.caption) !== post.contentHash) {
      return close("⛔ Creative on muuttunut: ei julkaistu.", "creative_changed");
    }
    const creativeIssue = creativeProblem(creative, post.channel, now());
    if (creativeIssue) return close("⛔ Creative ei kelpaa enää: ei julkaistu.", creativeIssue);

    const mode = cfg.organic!.mode;
    if (
      !(await deps.posts.update(companyId, post.id, "pending", {
        status: "publishing",
        gateRequestId: request.id,
        decidedByTgUserId: tgUserId,
        decidedAt: now(),
        payload: { ...post.payload, publishMode: mode },
      }))
    ) {
      return refuse("⛔ Postaus käsitelty jo: ei julkaistu.", "post_not_pending", binding, tgUserId);
    }

    const client = deps.writeClient(companyId, cfg, post.channel, targetOf(cfg));
    let result: OrganicPublishResult;
    try {
      result = await publish(client, cfg, post, creative);
    } catch (error) {
      const message = safe(error);
      await deps.posts.update(companyId, post.id, "publishing", { status: "failed", error: message });
      await audit(companyId, post.id, "publish failed", { channel: post.channel, mode, gateRequestId: request.id, error: message });
      return {
        status: "failed",
        statusText: `⚠️ Julkaisu epäonnistui (${CHANNEL_LABELS[post.channel]}). Tiedot aamun koosteessa.`,
        outcome: { handler: "done", result: "failed", postId: post.id, decidedBy: { tgUserId } },
        error: message,
      };
    }

    if (result.dryRun) {
      await deps.posts.update(companyId, post.id, "publishing", { status: "dry_run", payload: { ...post.payload, publishMode: mode, planned: result.planned } });
      await audit(companyId, post.id, "dry run", { channel: post.channel, gateRequestId: request.id, planned: result.planned.map((step) => `${step.method} ${step.path}`) });
      return {
        statusText: "🧪 Kuivaharjoitus hyväksytty: mitään ei julkaistu.",
        outcome: { handler: "done", result: "dry_run", postId: post.id, planned: result.planned.length, decidedBy: { tgUserId } },
      };
    }

    const stored = await deps.posts.update(companyId, post.id, "publishing", {
      status: "published",
      metaContainerId: result.containerId,
      metaMediaId: result.mediaId,
      metaPostId: result.postId,
      permalink: result.permalink,
      publishedAt: now(),
      ...(result.recovered ? { error: "media_publish answered an error; the container reports PUBLISHED" } : {}),
    });
    if (!stored) deps.ctx.logger.error("rk9-ads organic: published but the row was not updated", { postId: post.id, mediaId: result.mediaId });
    await audit(companyId, post.id, "published", {
      channel: post.channel,
      gateRequestId: request.id,
      mediaId: result.mediaId,
      postId: result.postId,
      permalink: result.permalink,
      recovered: result.recovered,
    });
    return {
      statusText: `✅ Julkaistu: ${CHANNEL_LABELS[post.channel]}${result.permalink ? `\n${result.permalink}` : ""}`,
      outcome: { handler: "done", result: "published", postId: post.id, mediaId: result.mediaId, recovered: result.recovered, decidedBy: { tgUserId } },
    };
  };

  async function publish(client: MetaGraphClient, cfg: BrandConfig, post: OrganicPost, creative: CreativeRow): Promise<OrganicPublishResult> {
    switch (post.channel) {
      case "ig_reel":
        return publishIgReel(client, cfg.meta.igUserId!, { videoUrl: creative.mediaUrl, caption: post.caption }, deps.wait);
      case "ig_feed":
        return publishIgImage(client, cfg.meta.igUserId!, { imageUrl: creative.mediaUrl, caption: post.caption }, deps.wait);
      case "fb_photo":
        return publishFbPhoto(client, cfg.meta.pageId, { url: creative.mediaUrl, caption: post.caption });
      case "fb_video":
        return publishFbVideo(client, cfg.meta.pageId, { fileUrl: creative.mediaUrl, description: post.caption });
    }
  }

  /** pending -> rejected on the deny tap (the router has stored the denial). */
  async function onDenied(request: GateRequestRecord, tgUserId: number): Promise<void> {
    const binding = bindingOf(request);
    if (!binding) return;
    const changed = await deps.posts.update(request.companyId, binding.postId, "pending", {
      status: "rejected",
      gateRequestId: request.id,
      decidedByTgUserId: tgUserId,
      decidedAt: now(),
    });
    if (changed) await audit(request.companyId, binding.postId, "rejected", { channel: binding.channel, gateRequestId: request.id, tgUserId });
  }

  /** Stores the first reason of a rejected post. */
  async function onReason(request: GateRequestRecord, tgUserId: number, code: string, text: string | null): Promise<void> {
    const binding = bindingOf(request);
    if (!binding) return;
    const preset = ORGANIC_REJECT_REASONS.some((reason) => reason.code === code);
    const stored = await deps.posts.setRejectReason(request.companyId, binding.postId, code, preset ? null : text);
    if (stored) {
      // The typed text stays in the post row; the activity entry names only the class.
      await audit(request.companyId, binding.postId, "reject reason", { code, typed: !preset, gateRequestId: request.id, tgUserId });
    }
  }

  /**
   * Board action: deletes one live post at Meta and records it. Dry run by
   * default; a real delete needs confirm. It deletes only the object id this
   * plugin stored for the post, through a guard that allows nothing else.
   */
  async function deletePost(
    companyId: string,
    input: { postId: string; dryRun: boolean },
    actor: { userId: string | null },
  ): Promise<{ status: "deleted" | "already_deleted" | "dry_run"; postId: string; planned?: unknown }> {
    if (!UUID_RE.test(companyId)) throw new OrganicError("invalid_request", "company context is required");
    if (typeof input.postId !== "string" || !UUID_RE.test(input.postId)) throw new OrganicError("invalid_request", "postId must be a uuid");
    const post = await deps.posts.get(companyId, input.postId);
    if (!post) throw new OrganicError("not_found", "post not found");
    if (post.status === "deleted") return { status: "already_deleted", postId: post.id };
    if (post.status !== "published") throw new OrganicError("not_published", `the post is ${post.status}; only a published post can be deleted`);
    if (!post.metaMediaId || !ID_RE.test(post.metaMediaId)) {
      throw new OrganicError("no_media_id", "the post has no stored Meta object id; delete it in the Meta app");
    }
    const cfg = await config(companyId);
    if (cfg.brandCode !== post.brandCode) throw new OrganicError("brand_changed", "the brand code changed since the post was published");
    if (post.channel.startsWith("fb_") && !cfg.organic?.pageAccessTokenRef) throw new OrganicError("channel_unavailable", "organic.pageAccessTokenRef is not set");

    const client = deps.writeClient(companyId, cfg, post.channel, targetOf(cfg, post.metaMediaId));
    if (input.dryRun || client.mode !== "live") {
      const planned = { method: "DELETE", path: post.metaMediaId };
      return { status: "dry_run", postId: post.id, planned };
    }
    let result: Awaited<ReturnType<typeof deleteOrganicObject>>;
    try {
      result = await deleteOrganicObject(client, post.metaMediaId);
    } catch (error) {
      await audit(companyId, post.id, "delete failed", { channel: post.channel, mediaId: post.metaMediaId, error: safe(error), by: actor.userId });
      throw new OrganicError("delete_failed", `Meta refused the delete: ${safe(error)}`);
    }
    if (result.dryRun || !result.success) {
      await audit(companyId, post.id, "delete failed", { channel: post.channel, mediaId: post.metaMediaId, error: "Meta did not confirm", by: actor.userId });
      throw new OrganicError("delete_failed", "Meta did not confirm the delete");
    }
    await deps.posts.update(companyId, post.id, "published", { status: "deleted", deletedAt: now(), deletedBy: actor.userId ?? "board" });
    await audit(companyId, post.id, "deleted", { channel: post.channel, mediaId: post.metaMediaId, by: actor.userId });
    return { status: "deleted", postId: post.id };
  }

  return { requestCard, publishApproved, onDenied, onReason, deletePost };
}

export type OrganicService = ReturnType<typeof createOrganicService>;

/** The worker's client factory: IG on meta.accessTokenRef, FB on organic.pageAccessTokenRef; dry run unless organic.mode is live. */
export function organicClientFactory(ctx: MetaClientContext): OrganicClientFactory {
  return (companyId, config, channel, target) => {
    const page = channel.startsWith("fb_");
    const tokenRef = page ? config.organic?.pageAccessTokenRef : config.meta.accessTokenRef;
    if (!tokenRef) throw new OrganicError("channel_unavailable", `${channel} has no token configured`);
    return createMetaClient(ctx, {
      companyId,
      tokenRef,
      tokenConfigPath: page ? ORGANIC_PAGE_TOKEN_CONFIG_PATH : "meta.accessTokenRef",
      mode: config.organic?.mode === "live" ? "live" : "dryRun",
      guardedWrite: organicWriteGuard(target),
    });
  };
}
