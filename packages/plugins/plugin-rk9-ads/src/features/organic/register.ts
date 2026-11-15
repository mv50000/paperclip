import type { PluginContext, PluginPerformActionContext, ToolResult } from "@paperclipai/plugin-sdk";
import { loadCompanyConfig } from "../../company-configs.js";
import { ORGANIC_PAGE_TOKEN_CONFIG_PATH, type BrandConfig } from "../../config.js";
import { createMetaClient } from "../../meta/graph.js";
import { sqlCreativeSource, type CreativeSource } from "../../publish/store.js";
import {
  createOrganicService,
  organicClientFactory,
  OrganicError,
  type OrganicCardTransport,
  type OrganicClientFactory,
  type OrganicService,
  type OrganicServiceDeps,
} from "../../organic/service.js";
import { effectiveStatus, sqlOrganicPostStore, type OrganicPostStore, type OrganicPostView } from "../../organic/store.js";
import {
  CHANNEL_LABELS,
  ORGANIC_FREE_TEXT_REASON,
  ORGANIC_GATE_KIND,
  ORGANIC_REASON_PROMPT,
  ORGANIC_REJECT_REASONS,
  type OrganicChannel,
} from "../../organic/types.js";
import { safeError } from "../spend-guard/support.js";
import { getTelegramController } from "../telegram/controller.js";
import { registerGateHandler } from "../telegram/gates.js";
import type { FeatureRuntime } from "../types.js";
import { organicDeclarations } from "./declarations.js";

/**
 * Organic posting (RK9-832):
 * - gate kind `organic_publish`: the only path that publishes (organic/service.ts publishApproved);
 *   a deny asks for the reason on the card itself;
 * - tool `rk9ads_request_organic_post` and action `organic.request`: open one card;
 * - action `organic.delete` (board only, dry run by default): deletes a live post at Meta;
 * - action `organic.posts`: the posts and their state;
 * - job `organic-reconcile` and action `organic.reconcile` (board only): close a post stuck
 *   in publishing from what Meta reports (RK9-852). They read Meta and never write to it.
 * No new Telegram messages besides the card: notices go to the digest.
 */

export const ORGANIC_TOOL = "rk9ads_request_organic_post";
export const ORGANIC_REQUEST_ACTION_KEY = "organic.request";
export const ORGANIC_DELETE_ACTION_KEY = "organic.delete";
export const ORGANIC_POSTS_ACTION_KEY = "organic.posts";
export const ORGANIC_RECONCILE_ACTION_KEY = "organic.reconcile";
export const ORGANIC_RECONCILE_JOB_KEY = "organic-reconcile";

export interface OrganicOverrides {
  posts?: OrganicPostStore;
  creatives?: CreativeSource;
  transport?: () => OrganicCardTransport | null;
  loadConfig?: OrganicServiceDeps["loadConfig"];
  writeClient?: OrganicClientFactory;
  readClient?: OrganicServiceDeps["readClient"];
  pageReadClient?: OrganicServiceDeps["pageReadClient"];
  wait?: OrganicServiceDeps["wait"];
  fetch?: OrganicServiceDeps["fetch"];
  now?: () => Date;
}

async function loadEnabled(ctx: PluginContext, companyId: string): Promise<{ ok: true; config: BrandConfig } | { ok: false; error: string }> {
  const result = await loadCompanyConfig(ctx, companyId);
  if (result.state === "enabled") return { ok: true, config: result.config };
  if (result.state === "disabled") return { ok: false, error: "the brand is disabled: set monthlyCapEur first" };
  if (result.state === "invalid") return { ok: false, error: `the brand config is invalid: ${result.errors.join("; ").slice(0, 300)}` };
  if (result.state === "unavailable") return { ok: false, error: `the brand config could not be read: ${result.error}` };
  return { ok: false, error: "RK9 Ads is not configured for this company" };
}

function initiatorOf(context: { actor?: { type?: string; userId?: string | null; agentId?: string | null; runId?: string | null } }) {
  return {
    source: context.actor?.agentId ? "agent" : "ui",
    userId: context.actor?.userId ?? null,
    agentId: context.actor?.agentId ?? null,
    runId: context.actor?.runId ?? null,
  };
}

function errorText(error: unknown): string {
  return error instanceof OrganicError ? `${error.code}: ${error.message}` : safeError(error);
}

function requestInput(params: Record<string, unknown>) {
  return {
    creativeId: params.creativeId as string,
    channel: params.channel as OrganicChannel,
    ...(params.caption !== undefined ? { caption: params.caption as string } : {}),
    ...(params.brandLint !== undefined ? { brandLint: params.brandLint } : {}),
  };
}

/** A post as the board sees it. The typed reject reason is shown; tokens never are. */
export function postView(post: OrganicPostView) {
  return {
    id: post.id,
    channel: post.channel,
    channelLabel: CHANNEL_LABELS[post.channel],
    status: effectiveStatus(post),
    mode: post.mode,
    caption: post.caption,
    creativeId: post.creativeId,
    permalink: post.permalink,
    metaMediaId: post.metaMediaId,
    lintOk: post.lint ? post.lint.ok : null,
    rejectReasonCode: post.rejectReasonCode,
    rejectReasonText: post.rejectReasonText,
    error: post.error,
    createdAt: post.createdAt,
    decidedAt: post.decidedAt,
    publishedAt: post.publishedAt,
    deletedAt: post.deletedAt,
  };
}

export function registerOrganic(runtime: FeatureRuntime, overrides: OrganicOverrides = {}): OrganicService {
  const { ctx, ledger } = runtime;
  const posts = overrides.posts ?? sqlOrganicPostStore(ctx.db, ledger);
  const service = createOrganicService({
    ctx,
    posts,
    creatives: overrides.creatives ?? sqlCreativeSource(ledger),
    transport: overrides.transport ?? getTelegramController,
    loadConfig: overrides.loadConfig ?? ((companyId) => loadEnabled(ctx, companyId)),
    writeClient: overrides.writeClient ?? organicClientFactory(ctx),
    readClient:
      overrides.readClient ??
      ((companyId, config) => createMetaClient(ctx, { companyId, tokenRef: config.meta.accessTokenRef, mode: "readOnly" })),
    pageReadClient:
      overrides.pageReadClient ??
      ((companyId, config) => {
        if (!config.organic?.pageAccessTokenRef) throw new OrganicError("channel_unavailable", "organic.pageAccessTokenRef is not set");
        return createMetaClient(ctx, { companyId, tokenRef: config.organic.pageAccessTokenRef, tokenConfigPath: ORGANIC_PAGE_TOKEN_CONFIG_PATH, mode: "readOnly" });
      }),
    fetch: overrides.fetch ?? ((url, init) => ctx.http.fetch(url, init)),
    ...(overrides.wait ? { wait: overrides.wait } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  registerGateHandler(ORGANIC_GATE_KIND, service.publishApproved, {
    denyReasons: {
      options: ORGANIC_REJECT_REASONS,
      freeText: true,
      freeTextCode: ORGANIC_FREE_TEXT_REASON,
      prompt: ORGANIC_REASON_PROMPT,
      onDenied: ({ request, tgUserId }) => service.onDenied(request, tgUserId),
      onReason: ({ request, tgUserId, code, text }) => service.onReason(request, tgUserId, code, text),
    },
  });

  const declaration = organicDeclarations.tools![0]!;
  // The company is the agent run's own company; the host checks the run belongs to it.
  ctx.tools.register(
    ORGANIC_TOOL,
    { displayName: declaration.displayName, description: declaration.description, parametersSchema: declaration.parametersSchema },
    async (params, runContext): Promise<ToolResult> => {
      try {
        const input = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
        const result = await service.requestCard(runContext.companyId, requestInput(input), {
          source: "agent",
          agentId: runContext.agentId ?? null,
          runId: runContext.runId ?? null,
        });
        return { content: JSON.stringify(result), data: result };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
  );

  ctx.actions.register(ORGANIC_REQUEST_ACTION_KEY, async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    try {
      return await service.requestCard(companyId, requestInput(params), initiatorOf(context));
    } catch (error) {
      throw new Error(errorText(error));
    }
  });

  ctx.actions.register(ORGANIC_DELETE_ACTION_KEY, async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const dryRun = params.dryRun !== false;
    if (!dryRun) {
      if (context.actor.type !== "user") throw new Error("board_only: deleting a published post is board-only");
      if (params.confirm !== true) throw new Error("invalid_request: a real delete needs confirm: true; preview it with a dry run first");
    }
    try {
      return await service.deletePost(companyId, { postId: params.postId as string, dryRun }, { userId: context.actor.userId ?? null });
    } catch (error) {
      throw new Error(errorText(error));
    }
  });

  ctx.actions.register(ORGANIC_RECONCILE_ACTION_KEY, async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    if (context.actor.type !== "user") throw new Error("board_only: reconciling a post is board-only");
    try {
      return await service.reconcile(companyId, params.postId as string, {
        closeUnknown: params.closeUnknown === true,
        by: `board:${context.actor.userId ?? "user"}`,
      });
    } catch (error) {
      throw new Error(errorText(error));
    }
  });

  ctx.jobs.register(ORGANIC_RECONCILE_JOB_KEY, async () => {
    const result = await service.reconcileStale();
    if (result.checked > 0) ctx.logger.info("rk9-ads organic: reconciled publishing posts", result);
  });

  ctx.actions.register(ORGANIC_POSTS_ACTION_KEY, async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 50;
    return { posts: (await posts.list(companyId, Math.min(Math.max(limit, 1), 200))).map(postView) };
  });

  return service;
}

export function register(runtime: FeatureRuntime): void {
  registerOrganic(runtime);
}
