import type { BrandConfig } from "../../config.js";
import type { PauseCardClose } from "../../gate/staging-card.js";
import { getAdOwner, getObjectStatus, setObjectStatus } from "../../meta/methods.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { loadPauseConfig, pauseReason } from "../spend-guard/pause-config.js";
import { brandClient, brandReadClient, recordAction, safeError, sqlOnceStore, type Initiator, type OnceStore } from "../spend-guard/support.js";
import { getActivationCards } from "../gate/runtime.js";
import type { FeatureRuntime } from "../types.js";
import type { UiPauseAdResult } from "./dto.js";
import { buildOverview, buildSettings, buildWidget, companyOf, sanitize, type ViewDeps } from "./views.js";

/**
 * Worker side of the operator UI (A12, RK9-518). The UI also calls actions
 * that other features own (pause-all, clear-halt, resend_gate_card,
 * verify-connection, provision, rules.dryRun, rules.prepareSave, digest.dryRun);
 * this feature adds only:
 *
 * - data `ads-overview`, `ads-widget`, `ads-settings`: allowlisted DTOs
 *   (./dto.ts), never the raw config, a secret_ref or a resolved secret;
 * - action `pause-ad`: pauses one ad of the brand's ad account. Dry run by
 *   default; a real pause needs `confirm: true` and a board user (an agent may
 *   only preview it). It writes rule_actions and the activity log. Before the
 *   Meta write it closes the ad's open activation cards, so an old card
 *   cannot activate the ad again (RK9-562); a failed close is `cardsError`.
 *
 * There is no activate, resume or unpause action (G1): an ad goes ACTIVE only
 * through the Telegram activation gate. Every handler takes the company from
 * the host's invocation context, never from params.
 */

export const OVERVIEW_DATA_KEY = "ads-overview";
export const WIDGET_DATA_KEY = "ads-widget";
export const SETTINGS_DATA_KEY = "ads-settings";
export const PAUSE_AD_ACTION_KEY = "pause-ad";
/** rule_actions.rule_id of a pause from the UI; its rule_type is kill_switch (the operator's manual stop). */
export const UI_PAUSE_RULE_ID = "ui-pause-ad";

const AD_ID_RE = /^\d{1,30}$/;
const REASON_MAX = 300;

export interface UiOverrides {
  store?: OnceStore;
  now?: () => Date;
  /** Tests: replaces the brand's Meta clients. */
  clientFor?: (companyId: string, config: BrandConfig, mode: "live" | "readOnly", initiator: Initiator | null) => MetaGraphClient;
  /** Tests: replaces the running gate's card closer. */
  closeAdCards?: (companyId: string, adId: string, input: { reason: string }) => Promise<PauseCardClose>;
}

function reasonText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, REASON_MAX) : fallback;
}

export function registerUi(runtime: FeatureRuntime, overrides: UiOverrides = {}): void {
  const { ctx, ledger } = runtime;
  const deps: ViewDeps = { ctx, ledger, store: overrides.store ?? sqlOnceStore(ledger), now: overrides.now ?? (() => new Date()) };
  const readClient = (companyId: string, config: BrandConfig) =>
    overrides.clientFor?.(companyId, config, "readOnly", null) ?? brandReadClient(ctx, companyId, config);
  const writeClient = (companyId: string, config: BrandConfig, initiator: Initiator) =>
    overrides.clientFor?.(companyId, config, "live", initiator) ?? brandClient({ ctx, ledger }, companyId, config, "live", { initiator });

  // The host sets companyId to the company it authorized for this call.
  ctx.data.register(OVERVIEW_DATA_KEY, async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { state: "error", error: "company context is required" };
    return buildOverview(deps, companyId);
  });

  ctx.data.register(WIDGET_DATA_KEY, async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { state: "error", error: "company context is required" };
    return buildWidget(deps, companyId);
  });

  ctx.data.register(SETTINGS_DATA_KEY, async (params) => {
    const companyId = companyOf(params);
    if (!companyId) return { state: "error", error: "company context is required" };
    return buildSettings(ctx, companyId);
  });

  ctx.actions.register(PAUSE_AD_ACTION_KEY, async (params, context): Promise<UiPauseAdResult> => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const adId = typeof params.adId === "string" ? params.adId.trim() : "";
    if (!AD_ID_RE.test(adId)) throw new Error("adId must be a Meta ad id (digits only)");
    const dryRun = params.dryRun !== false;
    if (!dryRun && params.confirm !== true) {
      throw new Error("A live pause needs confirm: true; preview it with dryRun first");
    }
    // A pause from the UI stops live spend on the operator's word: a board user decides, an agent only previews.
    if (!dryRun && context.actor.type !== "user") {
      throw new Error("Pausing an ad from the UI is board-only; an agent can run it with dryRun only");
    }
    // Stopping works on the last valid config too (pause-config.ts).
    const loaded = await loadPauseConfig(ctx, companyId);
    if (!loaded.ok) throw new Error(loaded.error);
    const config = loaded.config;
    const read = readClient(companyId, config);
    let before: { name: string; status: string };
    try {
      // A token can reach other ad accounts: the ad must belong to this brand's account.
      const owner = await getAdOwner(read, adId);
      if (owner.accountId !== config.meta.adAccountId) throw new Error("the ad is not in this company's ad account");
      before = await getObjectStatus(read, adId);
    } catch (error) {
      throw new Error(`Ad ${adId} could not be checked: ${safeError(error)}`);
    }
    if (dryRun) {
      return sanitize({ dryRun: true, adId, name: before.name || null, previousStatus: before.status, status: before.status, paused: false });
    }

    const initiator: Initiator = {
      source: "ui",
      userId: context.actor.userId,
      agentId: context.actor.agentId,
      runId: context.actor.runId,
    };
    const reason = pauseReason(loaded, reasonText(params.reason, "Pysäytä mainos (UI)"));
    // The ad's open cards close first, so no tap after this point activates it again.
    let closedCardIds: string[] = [];
    let cardsError: string | undefined;
    let announce: () => Promise<void> = async () => undefined;
    const close = overrides.closeAdCards ?? getActivationCards()?.closeCardsForAdPause;
    if (!close) {
      cardsError = "the activation gate is not running; open cards were not closed";
    } else {
      try {
        const closed = await close(companyId, adId, { reason });
        closedCardIds = closed.ids;
        cardsError = closed.error;
        announce = closed.announce;
      } catch (cause) {
        cardsError = safeError(cause);
      }
    }
    if (cardsError) ctx.logger.error("rk9-ads ui: open activation cards of the ad not closed", { companyId, adId, detail: cardsError });

    let paused = false;
    let error: string | null = null;
    try {
      const result = await setObjectStatus(writeClient(companyId, config, initiator), adId, "PAUSED");
      paused = "success" in result && result.success === true;
      if (!paused) error = "Meta did not confirm the pause";
    } catch (cause) {
      error = safeError(cause);
    }
    const auditError = await recordAction(
      { ctx, ledger },
      {
        companyId,
        config,
        ruleId: UI_PAUSE_RULE_ID,
        ruleType: "kill_switch",
        objectType: "ad",
        objectId: adId,
        action: "pause",
        dryRun: false,
        applied: paused,
        reason,
        metrics: { previousStatus: before.status, name: before.name, closedCardIds, ...(cardsError ? { cardsError } : {}) },
        initiator,
        error,
        message: `ui ${paused ? "paused" : "could not pause"} ad ${adId}`,
      },
    );
    try {
      await announce();
    } catch (cause) {
      ctx.logger.warn("rk9-ads ui: closed activation cards not edited", { companyId, adId, detail: safeError(cause) });
    }
    if (!paused) {
      throw new Error(`The pause of ad ${adId} failed: ${error}${cardsError ? `; open activation cards were not closed: ${cardsError}` : ""}`);
    }
    return sanitize({
      dryRun: false,
      adId,
      name: before.name || null,
      previousStatus: before.status,
      status: "PAUSED",
      paused: true,
      closedCardIds,
      ...(cardsError ? { cardsError } : {}),
      ...(auditError ? { auditError } : {}),
    });
  });
}

export function register(runtime: FeatureRuntime): void {
  registerUi(runtime);
}
