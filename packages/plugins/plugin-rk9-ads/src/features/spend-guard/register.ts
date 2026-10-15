import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import { loadCompanyConfig } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import { registerGateHandler } from "../telegram/gates.js";
import type { FeatureRuntime } from "../types.js";
import { spendGuardDeclarations } from "./declarations.js";
import { alertedThresholds } from "./alerts.js";
import { checkSpend, type GuardResult } from "./guard.js";
import { pauseAll, type PauseAllDeps, type PauseAllResult } from "./killswitch.js";
import { loadPauseConfig, pauseReason } from "./pause-config.js";
import { createScheduledPauseJob, SCHEDULED_PAUSE_JOB_KEY } from "./scheduled-pause.js";
import {
  brandReadClient,
  controllerNotifier,
  safeError,
  sqlOnceStore,
  type Initiator,
  type OnceStore,
  type SpendGuardNotifier,
} from "./support.js";

/**
 * Spend guard, kill switch and scheduled pause (A6, RK9-511).
 *
 * - job `scheduled-pause`: alerts, scheduled pause, data gate (scheduled-pause.ts)
 * - data `spend-guard`: MTD, cap, spend_cap, projection, % used, alerted thresholds
 * - action `pause-all`: the UI's "Pysäytä kaikki" (dry-run preview, then confirm)
 * - tools `rk9ads_pause_all` and `rk9ads_get_pacing`
 * - gate kind `pause_all`: one tap on the card's button pauses everything
 */

export const SPEND_GUARD_DATA_KEY = "spend-guard";
export const PAUSE_ALL_ACTION_KEY = "pause-all";
const REASON_MAX = 300;

export interface SpendGuardOverrides {
  store?: OnceStore;
  notifier?: SpendGuardNotifier;
  now?: () => Date;
  clientFor?: PauseAllDeps["clientFor"];
  feedFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

type Loaded = { ok: true; config: BrandConfig } | { ok: false; state: string; error: string };

async function loadEnabled(ctx: PluginContext, companyId: string): Promise<Loaded> {
  const result = await loadCompanyConfig(ctx, companyId);
  if (result.state === "enabled") return { ok: true, config: result.config };
  if (result.state === "absent") return { ok: false, state: "absent", error: "RK9 Ads is not configured for this company" };
  if (result.state === "invalid") return { ok: false, state: "invalid", error: "the brand config is invalid" };
  return { ok: false, state: "unavailable", error: `the brand config could not be read: ${result.error}` };
}

/** The manifest's own declaration, so the worker cannot drift from it. */
function toolDeclaration(name: string) {
  const tool = spendGuardDeclarations.tools?.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool ${name} is not declared by the spend-guard feature`);
  return { displayName: tool.displayName, description: tool.description, parametersSchema: tool.parametersSchema };
}

function reasonText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, REASON_MAX) : fallback;
}

/** Spend figures for the UI, the digest and the pacing tool. Never a token. */
export async function spendSnapshot(
  ctx: PluginContext,
  store: OnceStore,
  companyId: string,
  config: BrandConfig,
  now: Date,
): Promise<GuardResult & { brandCode: string; alertedThresholds: number[] }> {
  const result = await checkSpend({ config, client: brandReadClient(ctx, companyId, config), now });
  let alerted: number[] = [];
  try {
    alerted = await alertedThresholds(store, companyId, config.brandCode, result.month);
  } catch (error) {
    ctx.logger.warn("rk9-ads spend guard: could not read alert markers", { companyId, error: safeError(error) });
  }
  return { ...result, brandCode: config.brandCode, alertedThresholds: alerted };
}

function pauseSummary(result: PauseAllResult): string {
  const verb = result.dryRun ? "Would pause" : "Paused";
  const head = `${verb} ${result.pausedAds.length} ad(s) and ${result.pausedCampaigns.length} campaign(s) (scope ${result.scope}).`;
  const failed = result.errors.length > 0 ? ` ${result.errors.length} pause(s) failed: ${result.errors.map((e) => e.id).join(", ")}.` : "";
  return `${head}${failed}${result.list.length > 0 ? `\n${result.list.join("\n")}` : ""}`;
}

export function registerSpendGuard(runtime: FeatureRuntime, overrides: SpendGuardOverrides = {}): void {
  const { ctx, ledger } = runtime;
  const store = overrides.store ?? sqlOnceStore(ledger);
  const notifier = overrides.notifier ?? controllerNotifier;
  const now = overrides.now ?? (() => new Date());
  const deps = { ctx, ledger, store, notifier, now, clientFor: overrides.clientFor, feedFetch: overrides.feedFetch };

  ctx.jobs.register(SCHEDULED_PAUSE_JOB_KEY, createScheduledPauseJob(deps));

  ctx.data.register(SPEND_GUARD_DATA_KEY, async (params) => {
    // The host sets companyId to the company it authorized for this call.
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { state: "error", error: "company context is required" };
    const loaded = await loadEnabled(ctx, companyId);
    if (!loaded.ok) return { state: loaded.state, error: loaded.error };
    return { state: "enabled", ...(await spendSnapshot(ctx, store, companyId, loaded.config, now())) };
  });

  ctx.actions.register(PAUSE_ALL_ACTION_KEY, async (params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const dryRun = params.dryRun !== false;
    if (!dryRun && params.confirm !== true) {
      throw new Error("A live pause needs confirm: true; preview it with dryRun first");
    }
    // Stopping works on the last valid config too (pause-config.ts).
    const loaded = await loadPauseConfig(ctx, companyId);
    if (!loaded.ok) throw new Error(loaded.error);
    const initiator: Initiator = {
      source: "ui",
      userId: context.actor.userId,
      agentId: context.actor.agentId,
      runId: context.actor.runId,
    };
    const result = await pauseAll(deps, companyId, loaded.config, {
      dryRun,
      rule: "kill_switch",
      reason: pauseReason(loaded, reasonText(params.reason, "Pysäytä kaikki (UI)")),
      initiator,
      notify: true,
    });
    return loaded.fallback ? { ...result, fallbackConfig: loaded.fallback.state } : result;
  });

  ctx.tools.register(
    "rk9ads_pause_all",
    toolDeclaration("rk9ads_pause_all"),
    async (params, runCtx): Promise<ToolResult> => {
      const loaded = await loadPauseConfig(ctx, runCtx.companyId);
      if (!loaded.ok) return { error: loaded.error };
      const reason = reasonText((params as { reason?: unknown } | null)?.reason, "");
      if (!reason) return { error: "reason is required" };
      try {
        const result = await pauseAll(deps, runCtx.companyId, loaded.config, {
          dryRun: false,
          rule: "kill_switch",
          reason: pauseReason(loaded, reason),
          initiator: { source: "agent", agentId: runCtx.agentId, runId: runCtx.runId },
          notify: true,
        });
        const summary = loaded.fallback
          ? `${pauseSummary(result)} The brand config is ${loaded.fallback.state}: paused the whole ad account on the last valid config. Fix the config.`
          : pauseSummary(result);
        if (result.errors.length > 0) return { error: summary, data: result };
        return { content: summary, data: result };
      } catch (error) {
        return { error: `Pause failed before anything was paused: ${safeError(error)}` };
      }
    },
  );

  ctx.tools.register(
    "rk9ads_get_pacing",
    toolDeclaration("rk9ads_get_pacing"),
    async (_params, runCtx): Promise<ToolResult> => {
      const loaded = await loadEnabled(ctx, runCtx.companyId);
      if (!loaded.ok) return { error: loaded.error };
      const snapshot = await spendSnapshot(ctx, store, runCtx.companyId, loaded.config, now());
      if (snapshot.pctUsed === null) return { error: `Spend figures unavailable: ${snapshot.reason} (${snapshot.detail})`, data: snapshot };
      const content = [
        `${snapshot.brandCode} ${snapshot.month}: spent ${snapshot.mtdEur} EUR of ${snapshot.monthlyCapEur} EUR (${snapshot.pctUsed} %).`,
        `Projected month-end ${snapshot.projectedMonthEndEur} EUR at ${snapshot.dailyBudgetSumEur} EUR/day for ${snapshot.remainingDays} day(s).`,
        `Spend guard: ${snapshot.allow ? "would allow" : "refuses"} new spend (${snapshot.reason}).`,
      ].join(" ");
      return { content, data: snapshot };
    },
  );

  registerGateHandler("pause_all", async ({ request, tgUserId }) => {
    const loaded = await loadPauseConfig(ctx, request.companyId);
    if (!loaded.ok) throw new Error(loaded.error);
    const result = await pauseAll(deps, request.companyId, loaded.config, {
      dryRun: false,
      rule: "kill_switch",
      reason: pauseReason(loaded, "Pysäytä kaikki (Telegram)"),
      initiator: { source: "telegram", tgUserId },
      // The card itself shows the outcome.
      notify: false,
    });
    const outcome = {
      count: result.count,
      adIds: result.pausedAds.map((ad) => ad.id),
      campaignIds: result.pausedCampaigns.map((campaign) => campaign.id),
      failedIds: result.errors.map((entry) => entry.id),
    };
    if (result.errors.length > 0) throw new Error(`${result.errors.length} pause(s) failed`);
    return {
      statusText:
        (result.count > 0 ? `⏸ Pysäytetty: ${result.pausedAds.length} mainosta, ${result.pausedCampaigns.length} kampanjaa` : "⏸ Ei aktiivisia mainoksia") +
        (loaded.fallback ? " (konfiguraatio ei luettavissa: koko mainostili, viimeisin kelvollinen konfiguraatio)" : ""),
      outcome,
    };
  });
}

export function register(runtime: FeatureRuntime): void {
  registerSpendGuard(runtime);
}
