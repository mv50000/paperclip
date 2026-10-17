import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  assertLaunchReady,
  configFingerprint,
  isFreshPreflight,
  LaunchNotReadyError,
  readCachedPreflight,
  runPreflight,
  type PreflightDeps,
} from "../../brand/preflight.js";
import { provision, ProvisionError, sqlBindingStore, type BindingStore } from "../../brand/provision.js";
import { reportTokenInvalid } from "../../brand/token-alert.js";
import { resolveBrandBot } from "../../brand/telegram.js";
import { loadCompanyConfig } from "../../company-configs.js";
import type { BrandConfig, BrandConfigDraft } from "../../config.js";
import { PLUGIN_ID } from "../../manifest.js";
import { TokenInvalidError } from "../../meta/errors.js";
import { createMetaClient, type MetaClientMode, type MetaGraphClient } from "../../meta/graph.js";
import { brandClient, safeError, sqlOnceStore, type Initiator, type OnceStore } from "../spend-guard/support.js";
import type { FeatureRuntime } from "../types.js";

/**
 * Brand preflight and provisioning (A4, RK9-510).
 *
 * - action `verify-connection` ("Tarkista yhteys"): the live preflight, cached.
 * - action `provision`: the PAUSED campaign + ad set. Dry run by default; a
 *   real run needs `confirm: true` and a launch-ready preflight.
 * - data `preflight-status`: the cached preflight and whether it is fresh. No
 *   Meta call.
 *
 * The operator UI (A12) owns the buttons (G13). Every handler takes the
 * company from the host's invocation context, never from params.
 */

export const VERIFY_CONNECTION_ACTION_KEY = "verify-connection";
export const PROVISION_ACTION_KEY = "provision";
export const PREFLIGHT_STATUS_DATA_KEY = "preflight-status";

export interface BrandOverrides {
  store?: OnceStore;
  bindings?: BindingStore;
  now?: () => Date;
  metaClient?: PreflightDeps["metaClient"];
  /** The brand's write client in `live` or `dryRun` mode. Defaults to the spend-guarded brand client. */
  writeClient?: (companyId: string, config: BrandConfig, mode: MetaClientMode, initiator: Initiator) => MetaGraphClient;
  telegram?: PreflightDeps["telegram"];
}

type LoadedDraft = { ok: true; config: BrandConfigDraft; enabled: BrandConfig | null } | { ok: false; error: string };

async function loadDraft(ctx: PluginContext, companyId: string): Promise<LoadedDraft> {
  const result = await loadCompanyConfig(ctx, companyId);
  if (result.state === "enabled") return { ok: true, config: result.config, enabled: result.config };
  if (result.state === "disabled") return { ok: true, config: result.config, enabled: null };
  if (result.state === "absent") return { ok: false, error: "RK9 Ads is not configured for this company" };
  if (result.state === "invalid") return { ok: false, error: `the brand config is invalid: ${result.errors.join("; ").slice(0, 500)}` };
  return { ok: false, error: `the brand config could not be read: ${result.error}` };
}

export function registerBrand(runtime: FeatureRuntime, overrides: BrandOverrides = {}): void {
  const { ctx, ledger } = runtime;
  const store = overrides.store ?? sqlOnceStore(ledger);
  const bindings = overrides.bindings ?? sqlBindingStore(ledger);
  const now = overrides.now ?? (() => new Date());
  const preflightDeps: PreflightDeps & { ctx: PluginContext } = {
    ctx,
    store,
    pluginId: PLUGIN_ID,
    now,
    metaClient: overrides.metaClient,
    telegram: overrides.telegram,
  };
  const readClientFor = (companyId: string, config: BrandConfigDraft): MetaGraphClient =>
    overrides.metaClient?.(companyId, config) ??
    createMetaClient(ctx, { companyId, tokenRef: config.meta.accessTokenRef, mode: "readOnly" });
  const writeClientFor =
    overrides.writeClient ??
    ((companyId: string, config: BrandConfig, mode: MetaClientMode, initiator: Initiator) => brandClient({ ctx, ledger }, companyId, config, mode, { initiator }));

  /** A 190 seen by a mutating action: one alert and one issue, then the action fails (no retry). */
  async function onTokenInvalid(companyId: string, config: BrandConfigDraft, error: TokenInvalidError, context: string) {
    await reportTokenInvalid(
      {
        ctx,
        store,
        pluginId: PLUGIN_ID,
        sendTelegram: async (id, brand, text) => {
          const bot = await resolveBrandBot({ ctx, ...overrides.telegram }, id, brand);
          if (!bot.ok) {
            if (bot.reason === "not_configured") return "not_configured";
            throw new Error(bot.detail);
          }
          await bot.api.sendMessage({ chat_id: bot.chatId, text });
          return "sent";
        },
      },
      companyId,
      config,
      error,
      context,
    );
  }

  ctx.actions.register(VERIFY_CONNECTION_ACTION_KEY, async (_params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const loaded = await loadDraft(ctx, companyId);
    if (!loaded.ok) throw new Error(loaded.error);
    return runPreflight(preflightDeps, companyId, loaded.config);
  });

  ctx.actions.register(PROVISION_ACTION_KEY, async (params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const dryRun = params.dryRun !== false;
    if (!dryRun && params.confirm !== true) {
      throw new Error("A real provision needs confirm: true; preview it with dryRun first");
    }
    const loaded = await loadDraft(ctx, companyId);
    if (!loaded.ok) throw new Error(loaded.error);
    const config = loaded.enabled;
    if (!config) throw new Error("The brand is disabled: set monthlyCapEur before provisioning");
    const initiator: Initiator = {
      source: "ui",
      userId: context.actor.userId,
      agentId: context.actor.agentId,
      runId: context.actor.runId,
    };
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);
    const budget = params.dailyBudgetCents;
    try {
      return await provision(
        {
          ctx,
          bindings,
          now,
          readClient: readClientFor(companyId, config),
          writeClient: writeClientFor(companyId, config, dryRun ? "dryRun" : "live", initiator),
          assertLaunchReady: () => assertLaunchReady(preflightDeps, companyId, { config }),
          cachedPreflight: () => readCachedPreflight(ctx, companyId),
        },
        companyId,
        config,
        {
          dryRun,
          ...(budget !== undefined && budget !== null ? { dailyBudgetCents: typeof budget === "number" ? budget : Number.NaN } : {}),
          campaignId: str(params.campaignId),
          adSetId: str(params.adSetId),
          initiator,
        },
      );
    } catch (error) {
      if (error instanceof TokenInvalidError) await onTokenInvalid(companyId, config, error, "provision");
      if (error instanceof ProvisionError) throw new Error(`${error.code}: ${error.message}`);
      if (error instanceof LaunchNotReadyError) throw new Error(error.message);
      throw new Error(`Provision failed: ${safeError(error)}`);
    }
  });

  ctx.data.register(PREFLIGHT_STATUS_DATA_KEY, async (params) => {
    // The host sets companyId to the company it authorized for this call.
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { state: "error", error: "company context is required" };
    const loaded = await loadDraft(ctx, companyId);
    if (!loaded.ok) return { state: "unconfigured", error: loaded.error };
    const cached = await readCachedPreflight(ctx, companyId);
    return {
      state: loaded.enabled ? "enabled" : "disabled",
      configFingerprint: configFingerprint(loaded.config),
      fresh: cached ? isFreshPreflight(cached, loaded.config, now()) : false,
      result: cached,
    };
  });
}

export function register(runtime: FeatureRuntime): void {
  registerBrand(runtime);
}
