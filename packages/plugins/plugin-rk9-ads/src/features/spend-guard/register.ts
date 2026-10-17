import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import { loadCompanyConfig } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import { registerGateHandler } from "../telegram/gates.js";
import type { FeatureRuntime } from "../types.js";
import { spendGuardDeclarations } from "./declarations.js";
import { alertedThresholds } from "./alerts.js";
import { checkSpend, type GuardResult } from "./guard.js";
import { DEFAULT_TIME_ZONE } from "../../kit/local-time.js";
import { clearHalt, readHalt, type HaltState } from "./halt.js";
import { pauseAll, PauseListError, stopActivations, type PauseAllDeps, type PauseAllResult, type Stopped } from "./killswitch.js";
import { loadPauseConfig, pauseReason, type PauseConfig } from "./pause-config.js";
import { sqlActivationGateRepo } from "../../gate/gate-requests.js";
import { acknowledgePendingUndos, readPendingUndos, undoEntryKey, type UndoRetryDeps } from "./pending-undo.js";
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
 * - data `spend-guard`: MTD, cap, spend_cap, projection, % used, alerted thresholds,
 *   and `halt`: the halt in force or null (`haltError` when it cannot be read)
 * - action `pause-all`: the UI's "Pysäytä kaikki" (dry-run preview, then confirm)
 * - action `clear-halt`: lifts the halt in force (RK9-557, RK9-561). Dry run
 *   by default; a real clear needs `confirm: true`, a board user (an agent
 *   or the system may only preview it) and `since` from the preview: it
 *   clears only the halt with that `since`, so a newer kill switch or pause
 *   that set the halt again is not lifted blind. No Telegram button clears it.
 *   The preview names the open activation undos (pending-undo.ts). A real
 *   call acknowledges those named in `acknowledgeUndos` (keys from the
 *   preview), and their retry stops (RK9-565); with no halt to clear, `since`
 *   may be left out to only acknowledge them.
 *
 * Every live kill switch (action, tool, Telegram button) leaves its halt and
 * closes the open cards also when no brand config can be loaded; then it
 * pauses nothing in Meta and fails (RK9-561).
 * - tools `rk9ads_pause_all` and `rk9ads_get_pacing`
 * - gate kind `pause_all`: one tap on the card's button pauses everything
 */

export const SPEND_GUARD_DATA_KEY = "spend-guard";
export const PAUSE_ALL_ACTION_KEY = "pause-all";
export const CLEAR_HALT_ACTION_KEY = "clear-halt";
export const HALT_CLEARED_ACTIVITY = "rk9-ads spend guard: halt cleared";
export const UNDO_ACKNOWLEDGED_ACTIVITY = "rk9-ads spend guard: activation undo acknowledged";
const REASON_MAX = 300;

export interface SpendGuardOverrides {
  store?: OnceStore;
  notifier?: SpendGuardNotifier;
  now?: () => Date;
  clientFor?: PauseAllDeps["clientFor"];
  feedFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  closeCards?: PauseAllDeps["closeCards"];
  newerActivation?: UndoRetryDeps["newerActivation"];
}

type Loaded = { ok: true; config: BrandConfig } | { ok: false; state: string; error: string };

async function loadEnabled(ctx: PluginContext, companyId: string): Promise<Loaded> {
  const result = await loadCompanyConfig(ctx, companyId);
  if (result.state === "enabled") return { ok: true, config: result.config };
  if (result.state === "absent") return { ok: false, state: "absent", error: "RK9 Ads is not configured for this company" };
  if (result.state === "invalid") return { ok: false, state: "invalid", error: "the brand config is invalid" };
  if (result.state === "disabled") return { ok: false, state: "disabled", error: `the brand is disabled: ${result.reason}` };
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

/** The halt for the data endpoint: a read failure is reported, never shown as "no halt". */
async function haltView(ctx: PluginContext, companyId: string, now: Date): Promise<{ halt: HaltState | null; haltError?: string }> {
  try {
    return { halt: await readHalt(ctx, companyId, now) };
  } catch (error) {
    return { halt: null, haltError: safeError(error) };
  }
}

function stopSummary(stopped: Stopped): string[] {
  return [
    ...(stopped.halt ? ["Standing halt set: no activation until a board user clears it (clear-halt)."] : []),
    ...(stopped.haltError ? [`The standing halt was NOT stored: ${stopped.haltError}.`] : []),
    ...(stopped.closedCardIds.length > 0 ? [`Closed ${stopped.closedCardIds.length} open activation card(s).`] : []),
    ...(stopped.cardsError ? [`Open activation cards were not closed: ${stopped.cardsError}.`] : []),
  ];
}

function pauseSummary(result: PauseAllResult): string {
  const verb = result.dryRun ? "Would pause" : "Paused";
  const head = `${verb} ${result.pausedAds.length} ad(s) and ${result.pausedCampaigns.length} campaign(s) (scope ${result.scope}).`;
  const failed = result.errors.length > 0 ? ` ${result.errors.length} pause(s) failed: ${result.errors.map((e) => e.id).join(", ")}.` : "";
  const stop = stopSummary(result);
  return `${head}${failed}${stop.length > 0 ? ` ${stop.join(" ")}` : ""}${result.list.length > 0 ? `\n${result.list.join("\n")}` : ""}`;
}

type KillSwitchRun =
  | { ok: true; loaded: Extract<PauseConfig, { ok: true }>; result: PauseAllResult }
  | { ok: false; error: string; stopped: Stopped };

/** The failure text of a kill switch that had no config to pause with. */
function noConfigText(run: Extract<KillSwitchRun, { ok: false }>): string {
  return [`${run.error}; nothing was paused in Meta.`, ...stopSummary(run.stopped)].join(" ");
}

export function registerSpendGuard(runtime: FeatureRuntime, overrides: SpendGuardOverrides = {}): void {
  const { ctx, ledger } = runtime;
  const store = overrides.store ?? sqlOnceStore(ledger);
  const notifier = overrides.notifier ?? controllerNotifier;
  const now = overrides.now ?? (() => new Date());
  const newerActivation: UndoRetryDeps["newerActivation"] =
    overrides.newerActivation ?? ((companyId, input) => sqlActivationGateRepo(ctx.db).newerActivation(companyId, input));
  const deps = { ctx, ledger, store, notifier, now, clientFor: overrides.clientFor, feedFetch: overrides.feedFetch, closeCards: overrides.closeCards, newerActivation };

  /**
   * The kill switch. A live run leaves the halt and closes the open cards
   * whether or not a config loads: the halt is per company and needs none
   * (RK9-561). Only the Meta pauses need the config.
   */
  async function killSwitch(companyId: string, input: { dryRun: boolean; reason: string; initiator: Initiator }): Promise<KillSwitchRun> {
    let loaded: PauseConfig;
    try {
      loaded = await loadPauseConfig(ctx, companyId);
    } catch (error) {
      loaded = { ok: false, state: "unavailable", error: `the brand config could not be loaded: ${safeError(error)}` };
    }
    const options = { dryRun: input.dryRun, rule: "kill_switch" as const, reason: input.reason, initiator: input.initiator };
    const brand = loaded.ok ? loaded.config : { brandCode: "?", timeZone: DEFAULT_TIME_ZONE };
    const stop = input.dryRun ? undefined : await stopActivations(deps, companyId, brand, options, now());
    if (!loaded.ok) {
      await stop?.announce();
      return { ok: false, error: loaded.error, stopped: stop?.stopped ?? { closedCardIds: [] } };
    }
    const result = await pauseAll(deps, companyId, loaded.config, {
      ...options,
      reason: pauseReason(loaded, input.reason),
      notify: true,
      ...(stop ? { stopped: stop } : {}),
    });
    return { ok: true, loaded, result };
  }

  ctx.jobs.register(SCHEDULED_PAUSE_JOB_KEY, createScheduledPauseJob(deps));

  ctx.data.register(SPEND_GUARD_DATA_KEY, async (params) => {
    // The host sets companyId to the company it authorized for this call.
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { state: "error", error: "company context is required" };
    const halt = await haltView(ctx, companyId, now());
    const loaded = await loadEnabled(ctx, companyId);
    if (!loaded.ok) return { state: loaded.state, error: loaded.error, ...halt };
    return { state: "enabled", ...(await spendSnapshot(ctx, store, companyId, loaded.config, now())), ...halt };
  });

  ctx.actions.register(CLEAR_HALT_ACTION_KEY, async (params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const dryRun = params.dryRun !== false;
    if (!dryRun && params.confirm !== true) {
      throw new Error("A real clear needs confirm: true; preview it with dryRun first");
    }
    // Lifting the halt lets activations spend again: a board user decides, an agent only previews.
    if (!dryRun && context.actor.type !== "user") {
      throw new Error("Clearing the halt is board-only; an agent can run it with dryRun only");
    }
    if (dryRun) {
      const halt = await readHalt(ctx, companyId, now());
      let pendingUndo: Awaited<ReturnType<typeof readPendingUndos>> = [];
      try {
        pendingUndo = await readPendingUndos(ctx, companyId);
      } catch (error) {
        return { dryRun, cleared: false, halt, pendingUndoError: safeError(error) };
      }
      return { dryRun, cleared: false, halt, ...(pendingUndo.length > 0 ? { pendingUndo: pendingUndo.map((entry) => ({ ...entry, key: undoEntryKey(entry) })) } : {}) };
    }
    const reason = reasonText(params.reason, "");
    const ackKeys = Array.isArray(params.acknowledgeUndos) ? params.acknowledgeUndos.filter((key): key is string => typeof key === "string") : [];
    /** The open undos the board saw in the preview: their retry stops. */
    const acknowledge = async (): Promise<number> => {
      if (ackKeys.length === 0) return 0;
      const acknowledged = await acknowledgePendingUndos(ctx, companyId, ackKeys);
      if (acknowledged.length === 0) return 0;
      const by = { userId: context.actor.userId ?? null, runId: context.actor.runId ?? null };
      try {
        await ctx.activity.log({
          companyId,
          message: UNDO_ACKNOWLEDGED_ACTIVITY,
          entityType: "rk9_ads_brand",
          entityId: acknowledged[0]!.brandCode,
          metadata: { acknowledged, acknowledgedBy: by, ...(reason ? { reason } : {}) },
        });
      } catch (error) {
        ctx.logger.warn("rk9-ads spend guard: undo acknowledgement not logged", { companyId, detail: safeError(error) });
      }
      return acknowledged.length;
    };
    // Only an acknowledgement: there was no halt to clear in the preview.
    if ((typeof params.since !== "string" || params.since === "") && ackKeys.length > 0) {
      return { dryRun: false, cleared: false, halt: null, acknowledgedUndos: await acknowledge() };
    }
    // `since` from the preview names the halt to clear: a kill switch or pause that ran after the preview stored a newer halt, which stays.
    if (typeof params.since !== "string" || params.since === "") {
      throw new Error("A real clear needs `since` of the halt from the preview (dryRun)");
    }
    const { cleared, current } = await clearHalt(ctx, companyId, params.since, now());
    if (!cleared) {
      if (current) throw new Error("A newer kill switch or pause set the halt after the preview; preview it again and clear the current one");
      const acknowledgedUndos = await acknowledge();
      return { dryRun: false, cleared: false, halt: null, ...(acknowledgedUndos > 0 ? { acknowledgedUndos } : {}) };
    }
    const halt = cleared;
    const acknowledgedUndos = await acknowledge();
    const metadata = {
      halt,
      clearedBy: { userId: context.actor.userId ?? null, runId: context.actor.runId ?? null },
      ...(reason ? { reason } : {}),
    };
    try {
      await ctx.activity.log({ companyId, message: HALT_CLEARED_ACTIVITY, entityType: "rk9_ads_brand", entityId: halt.brandCode, metadata });
    } catch (error) {
      ctx.logger.warn("rk9-ads spend guard: halt clear not logged", { companyId, detail: safeError(error) });
    }
    ctx.logger.info("rk9-ads spend guard: halt cleared", { companyId, brandCode: halt.brandCode, rule: halt.rule, since: halt.since });
    // `remaining`: another halt (e.g. a scheduled pause's under a cleared kill switch) still in force.
    return { dryRun: false, cleared: true, halt, ...(current ? { remaining: current } : {}), ...(acknowledgedUndos > 0 ? { acknowledgedUndos } : {}) };
  });

  ctx.actions.register(PAUSE_ALL_ACTION_KEY, async (params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const dryRun = params.dryRun !== false;
    if (!dryRun && params.confirm !== true) {
      throw new Error("A live pause needs confirm: true; preview it with dryRun first");
    }
    // Stopping works on the last valid config too (pause-config.ts).
    const initiator: Initiator = {
      source: "ui",
      userId: context.actor.userId,
      agentId: context.actor.agentId,
      runId: context.actor.runId,
    };
    let run: KillSwitchRun;
    try {
      run = await killSwitch(companyId, { dryRun, reason: reasonText(params.reason, "Pysäytä kaikki (UI)"), initiator });
    } catch (error) {
      // The halt and the card close ran before the failed listing: the UI must say so.
      if (error instanceof PauseListError) throw new Error([`Pause failed before anything was paused: ${error.message}.`, ...stopSummary(error.stopped)].join(" "));
      throw error;
    }
    if (!run.ok) throw new Error(dryRun ? run.error : noConfigText(run));
    return run.loaded.fallback ? { ...run.result, fallbackConfig: run.loaded.fallback.state } : run.result;
  });

  ctx.tools.register(
    "rk9ads_pause_all",
    toolDeclaration("rk9ads_pause_all"),
    async (params, runCtx): Promise<ToolResult> => {
      const reason = reasonText((params as { reason?: unknown } | null)?.reason, "");
      if (!reason) return { error: "reason is required" };
      try {
        const run = await killSwitch(runCtx.companyId, {
          dryRun: false,
          reason,
          initiator: { source: "agent", agentId: runCtx.agentId, runId: runCtx.runId },
        });
        if (!run.ok) return { error: noConfigText(run), data: run.stopped };
        const { loaded, result } = run;
        const summary = loaded.fallback
          ? `${pauseSummary(result)} The brand config is ${loaded.fallback.state}: paused the whole ad account on the last valid config. Fix the config.`
          : pauseSummary(result);
        if (result.errors.length > 0 || result.haltError || result.cardsError) return { error: summary, data: result };
        return { content: summary, data: result };
      } catch (error) {
        const stop = error instanceof PauseListError ? stopSummary(error.stopped) : [];
        return { error: [`Pause failed before anything was paused: ${safeError(error)}.`, ...stop].join(" ") };
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
      const { halt } = await haltView(ctx, runCtx.companyId, now());
      const content = [
        `${snapshot.brandCode} ${snapshot.month}: spent ${snapshot.mtdEur} EUR of ${snapshot.monthlyCapEur} EUR (${snapshot.pctUsed} %).`,
        `Projected month-end ${snapshot.projectedMonthEndEur} EUR at ${snapshot.dailyBudgetSumEur} EUR/day for ${snapshot.remainingDays} day(s).`,
        `Spend guard: ${snapshot.allow ? "would allow" : "refuses"} new spend (${snapshot.reason}).`,
        ...(halt
          ? [
              halt.until
                ? `${halt.rule} halt since ${halt.since} until ${halt.until}: no activation before then unless a board user clears it.`
                : `${halt.rule} halt since ${halt.since}: no activation until a board user clears it.`,
            ]
          : []),
      ].join(" ");
      return { content, data: { ...snapshot, halt } };
    },
  );

  registerGateHandler("pause_all", async ({ request, tgUserId }) => {
    // The card shows the counts; the notice lists every paused campaign for
    // the restore (RK9-523).
    const run = await killSwitch(request.companyId, { dryRun: false, reason: "Pysäytä kaikki (Telegram)", initiator: { source: "telegram", tgUserId } });
    if (!run.ok) throw new Error(noConfigText(run));
    const { loaded, result } = run;
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
        (loaded.fallback ? " (konfiguraatio ei luettavissa: koko mainostili, viimeisin kelvollinen konfiguraatio)" : "") +
        (result.halt ? "\n⛔ Pysäytystila päällä: aktivointi estetty, kunnes board poistaa tilan" : "") +
        (result.haltError ? "\n⚠️ Pysäytystilan tallennus epäonnistui" : "") +
        (result.closedCardIds.length > 0 ? `\nAktivointikortteja mitätöity: ${result.closedCardIds.length}` : "") +
        (result.cardsError ? "\n⚠️ Avoimia aktivointikortteja ei voitu sulkea" : "") +
        (result.telegram === "failed" ? " (ilmoitus epäonnistui, kampanjalista aktiviteettilokissa)" : ""),
      outcome,
    };
  });
}

export function register(runtime: FeatureRuntime): void {
  registerSpendGuard(runtime);
}
