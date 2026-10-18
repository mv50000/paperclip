import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertLaunchReady, LaunchNotReadyError, type PreflightDeps } from "../../brand/preflight.js";
import { sqlBindingStore, type BindingStore } from "../../brand/provision.js";
import { loadCompanyConfig } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import { PLUGIN_ID } from "../../manifest.js";
import { operatorMessage } from "../../meta/errors.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import type { OnCreativeSwapHook, OnPublishedHook } from "../../publish/handoff.js";
import { PrevalidationError } from "../../publish/prevalidate.js";
import {
  createPublishService,
  parsePublishRequest,
  PublishError,
  type PublishService,
  type VideoOptions,
} from "../../publish/publish-service.js";
import { sqlCreativeSource, sqlPublicationStore, type CreativeSource, type PublicationStore } from "../../publish/store.js";
import { getActivationCards } from "../gate/runtime.js";
import { sanitize } from "../ui/sanitize.js";
import { brandClient, brandReadClient, sqlOnceStore, type Initiator, type OnceStore } from "../spend-guard/support.js";
import type { FeatureRuntime } from "../types.js";

/**
 * Publishing (A8, RK9-514). Actions and data need no manifest entry, so the
 * capability set and the manifest stay as installed (G11).
 *
 * - action `publish`: a dry run by default (the full planned payloads, no
 *   Meta write). A real run needs `confirm: true`; it records the publication
 *   and starts the run in the background. The action waits at most `waitMs`
 *   (default 10 s, at most 20 s: the host cuts an RPC at 30 s) so a quick
 *   result or failure shows in the action result; a longer run returns
 *   `pending` with the publication id to poll.
 * - action `swap-creative`: the same for a new creative on an existing ad
 *   (`adId`); the ad's status is never touched.
 * - data `publication`: one publication by id, for polling. Its stored error
 *   text goes through the UI's `sanitize` again when it is read (RK9-563).
 *
 * Every handler takes the company from the host's invocation context.
 */

export const PUBLISH_ACTION_KEY = "publish";
export const SWAP_CREATIVE_ACTION_KEY = "swap-creative";
export const PUBLICATION_DATA_KEY = "publication";
export const DEFAULT_ACTION_WAIT_MS = 10_000;
export const MAX_ACTION_WAIT_MS = 20_000;

/** Resolves when `work` settles or after `ms`, whichever is first. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

export interface PublishOverrides {
  store?: PublicationStore;
  creatives?: CreativeSource;
  bindings?: BindingStore;
  once?: OnceStore;
  now?: () => Date;
  writeClient?: (companyId: string, config: BrandConfig, initiator: Initiator) => MetaGraphClient;
  readClient?: (companyId: string, config: BrandConfig) => MetaGraphClient;
  /** Replaces the A4 launch gate; `null` skips it (tests). */
  assertLaunchReady?: ((companyId: string, config: BrandConfig) => Promise<void>) | null;
  onPublished?: OnPublishedHook;
  onCreativeSwap?: OnCreativeSwapHook;
  video?: VideoOptions;
}

function activationCards() {
  const cards = getActivationCards();
  if (!cards) throw new Error("the activation gate is not running");
  return cards;
}

/** The hand-off to the activation gate (G15, A9 RK9-517). */
const gateOnPublished: OnPublishedHook = async (publication) => {
  await activationCards().openActivationCard(publication);
};

/** A swap closes the ad's open activation cards first; without the gate it does not run. */
const gateOnCreativeSwap: OnCreativeSwapHook = async (swap) => {
  await activationCards().closeCardsForSwap(swap);
};

function initiatorOf(context: { actor: { userId?: string | null; agentId?: string | null; runId?: string | null } }): Initiator {
  return {
    source: context.actor.agentId ? "agent" : "ui",
    userId: context.actor.userId ?? null,
    agentId: context.actor.agentId ?? null,
    runId: context.actor.runId ?? null,
  };
}

/** A one-line, token-free error for the action result. */
function actionError(error: unknown): Error {
  if (error instanceof PublishError) return new Error(`${error.code}: ${error.message}`);
  if (error instanceof PrevalidationError) {
    return new Error(`prevalidation_failed: ${error.issues.map((issue) => `${issue.field} ${issue.code}: ${issue.message}`).join("; ")}`);
  }
  if (error instanceof LaunchNotReadyError) return new Error(error.message);
  return new Error(operatorMessage(error));
}

export function registerPublish(runtime: FeatureRuntime, overrides: PublishOverrides = {}): PublishService {
  const { ctx, ledger } = runtime;
  const once = overrides.once ?? sqlOnceStore(ledger);
  const now = overrides.now ?? (() => new Date());
  const preflightDeps: PreflightDeps & { ctx: PluginContext } = { ctx, store: once, pluginId: PLUGIN_ID, now };
  const gate =
    overrides.assertLaunchReady === null
      ? undefined
      : (overrides.assertLaunchReady ??
        (async (companyId: string, config: BrandConfig) => {
          await assertLaunchReady(preflightDeps, companyId, { config });
        }));

  const service = createPublishService({
    ctx,
    store: overrides.store ?? sqlPublicationStore(ledger),
    creatives: overrides.creatives ?? sqlCreativeSource(ledger),
    bindings: overrides.bindings ?? sqlBindingStore(ledger),
    once,
    now,
    async loadConfig(companyId) {
      const result = await loadCompanyConfig(ctx, companyId);
      if (result.state === "enabled") return { ok: true, config: result.config };
      if (result.state === "disabled") return { ok: false, error: "the brand is disabled: set monthlyCapEur first" };
      if (result.state === "invalid") return { ok: false, error: `the brand config is invalid: ${result.errors.join("; ").slice(0, 300)}` };
      if (result.state === "unavailable") return { ok: false, error: `the brand config could not be read: ${result.error}` };
      return { ok: false, error: "RK9 Ads is not configured for this company" };
    },
    writeClient:
      overrides.writeClient ?? ((companyId, config, initiator) => brandClient({ ctx, ledger }, companyId, config, "live", { initiator })),
    readClient: overrides.readClient ?? ((companyId, config) => brandReadClient(ctx, companyId, config)),
    ...(gate ? { assertLaunchReady: gate } : {}),
    onPublished: overrides.onPublished ?? gateOnPublished,
    onCreativeSwap: overrides.onCreativeSwap ?? gateOnCreativeSwap,
    ...(overrides.video ? { video: overrides.video } : {}),
  });

  const handle = (mode: "publish" | "swap") => async (params: Record<string, unknown>, context: Parameters<Parameters<typeof ctx.actions.register>[1]>[1]) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    try {
      // The host adds companyId and renderEnvironment to params; the company comes from the context only.
      const { waitMs, companyId: _hostCompanyId, renderEnvironment: _renderEnvironment, ...rest } = params;
      const request = parsePublishRequest(rest);
      if (request.dryRun !== false) return await service.plan(companyId, request, mode);
      if (request.confirm !== true) throw new PublishError("invalid_request", "a real publish needs confirm: true; preview it with a dry run first");
      const outcome =
        mode === "publish"
          ? await service.publish(companyId, request, initiatorOf(context))
          : await service.swap(companyId, request, initiatorOf(context));
      const wait = typeof waitMs === "number" && Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), MAX_ACTION_WAIT_MS) : DEFAULT_ACTION_WAIT_MS;
      if (outcome.started && wait > 0) await within(service.settled(outcome.publication.id), wait);
      const latest = await service.get(companyId, outcome.publication.id);
      return { ...outcome, publication: latest ?? outcome.publication };
    } catch (error) {
      throw actionError(error);
    }
  };

  ctx.actions.register(PUBLISH_ACTION_KEY, handle("publish"));
  ctx.actions.register(SWAP_CREATIVE_ACTION_KEY, handle("swap"));

  ctx.data.register(PUBLICATION_DATA_KEY, async (params) => {
    // The host sets companyId to the company it authorized for this call.
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { state: "error", error: "company context is required" };
    const id = typeof params.publicationId === "string" ? params.publicationId : null;
    if (!id) return { state: "error", error: "publicationId is required" };
    const publication = await service.get(companyId, id);
    return publication ? { state: "ok", publication: sanitize(publication) } : { state: "not_found" };
  });

  runtime.onShutdown(async () => {
    // Let short Graph calls finish; a run cut off here resumes on the next publish with the same key.
    await Promise.race([service.settled(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  });

  return service;
}

export function register(runtime: FeatureRuntime): void {
  registerPublish(runtime);
}
