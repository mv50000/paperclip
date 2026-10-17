import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertLaunchReady } from "../../brand/preflight.js";
import { loadCompanyConfig } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import { createActivateAdHandler, createActivationClient, type ActivateAdDeps } from "../../gate/activate-ad.js";
import { sqlActivationGateRepo, withActivationColumns, type ActivationGateRepo } from "../../gate/gate-requests.js";
import { createStagingCards, type GateCardTransport, type StagingCards } from "../../gate/staging-card.js";
import { createSqlGateStore, type GateStore } from "../../kit/gate/state-machine.js";
import { PLUGIN_ID } from "../../manifest.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { sqlPublicationStore, type PublicationStore } from "../../publish/store.js";
import { readHalt } from "../spend-guard/halt.js";
import { reportUndoFailure } from "../spend-guard/pending-undo.js";
import { brandReadClient, controllerNotifier, safeError, sqlOnceStore, type OnceStore, type SpendGuardNotifier } from "../spend-guard/support.js";
import { getTelegramController } from "../telegram/controller.js";
import { registerGateHandler } from "../telegram/gates.js";
import type { FeatureRuntime } from "../types.js";
import { setActivationCards } from "./runtime.js";

/**
 * The activation gate (A9, RK9-517), the plugin's own spend gate (G1):
 *
 * - gate kind `activate_ad`: the only path that sets anything ACTIVE
 *   (src/gate/activate-ad.ts);
 * - the publish hand-off and the swap hook (features/publish wires them from
 *   ./runtime.ts): the staging card after publish, closing open cards on a
 *   creative swap (src/gate/staging-card.ts);
 * - job `gate-expiry`: pending cards past valid_until move to `expired`;
 * - action `resend_gate_card`: posts a pending, unexpired card again
 *   (`gateRequestId` or `publicationId`). The company comes from the host's
 *   invocation context.
 *
 * The kill switch, the cap pause and the scheduled pause close the open
 * cards through the same runtime (closeCardsForPause), and their halts
 * refuse every activation while in force (RK9-557, RK9-561,
 * spend-guard/halt.ts). An undo that Meta refused after a halt is stored for
 * the scheduled-pause job's retry and alerted (spend-guard/pending-undo.ts,
 * RK9-565).
 *
 * No scale_budget handler (G9) and no ctx.approvals (G1).
 */

export const GATE_EXPIRY_JOB_KEY = "gate-expiry";
export const RESEND_GATE_CARD_ACTION_KEY = "resend_gate_card";

export interface GateOverrides {
  store?: GateStore;
  repo?: ActivationGateRepo;
  transport?: () => GateCardTransport | null;
  loadConfig?: ActivateAdDeps["loadConfig"];
  readClient?: (companyId: string, config: BrandConfig) => MetaGraphClient;
  activationClient?: ActivateAdDeps["activationClient"];
  assertLaunchReady?: ActivateAdDeps["assertLaunchReady"];
  checkSpend?: ActivateAdDeps["checkSpend"];
  haltOf?: ActivateAdDeps["haltOf"];
  publications?: Pick<PublicationStore, "findByAd">;
  /** The failed-undo alert's Telegram and dedupe markers. */
  notifier?: SpendGuardNotifier;
  onceStore?: OnceStore;
  now?: () => Date;
}

async function loadEnabled(ctx: PluginContext, companyId: string): Promise<{ ok: true; config: BrandConfig } | { ok: false; error: string }> {
  const result = await loadCompanyConfig(ctx, companyId);
  if (result.state === "enabled") return { ok: true, config: result.config };
  if (result.state === "unavailable") return { ok: false, error: `the brand config could not be read: ${result.error}` };
  return { ok: false, error: `the brand config is ${result.state}` };
}

export function registerGate(runtime: FeatureRuntime, overrides: GateOverrides = {}): { cards: StagingCards } {
  const { ctx, ledger } = runtime;
  const now = overrides.now ?? (() => new Date());
  const haltOf = overrides.haltOf ?? ((companyId: string) => readHalt(ctx, companyId, now()));
  const store = overrides.store ?? withActivationColumns(createSqlGateStore(ctx.db), ctx.db);
  const repo = overrides.repo ?? sqlActivationGateRepo(ctx.db);
  const loadConfig = overrides.loadConfig ?? ((companyId: string) => loadEnabled(ctx, companyId));
  const readClient = overrides.readClient ?? ((companyId: string, config: BrandConfig) => brandReadClient(ctx, companyId, config));
  const onceStore = overrides.onceStore ?? sqlOnceStore(ledger);
  const preflightDeps = { ctx, store: sqlOnceStore(ledger), pluginId: PLUGIN_ID, now };
  const undoDeps = { ctx, store: onceStore, notifier: overrides.notifier ?? controllerNotifier };
  const publications = overrides.publications ?? sqlPublicationStore(ledger);

  registerGateHandler(
    "activate_ad",
    createActivateAdHandler({
      ctx,
      repo,
      loadConfig,
      readClient,
      // maxAgeMs -1: never the cached preflight; every activation re-runs it.
      assertLaunchReady:
        overrides.assertLaunchReady ??
        (async (companyId, config) => {
          await assertLaunchReady(preflightDeps, companyId, { config, maxAgeMs: -1 });
        }),
      activationClient:
        overrides.activationClient ??
        ((companyId, config, initiator, allowed) => createActivationClient({ ctx, ledger }, companyId, config, initiator, allowed)),
      haltOf,
      publicationOf: async (companyId, adId) => {
        const owner = await publications.findByAd(companyId, adId);
        return owner ? { id: owner.id, contentHash: owner.contentHash, metaCreativeId: owner.metaCreativeId } : null;
      },
      onUndoFailed: (companyId, config, input) => reportUndoFailure(undoDeps, companyId, config, input, now()),
      ...(overrides.checkSpend ? { checkSpend: overrides.checkSpend } : {}),
      now,
    }),
  );

  const cards = createStagingCards({
    ctx,
    store,
    repo,
    transport: overrides.transport ?? getTelegramController,
    loadConfig,
    readClient,
    haltOf,
    ...(overrides.checkSpend ? { checkSpend: overrides.checkSpend } : {}),
    now,
  });
  setActivationCards(cards);

  ctx.jobs.register(GATE_EXPIRY_JOB_KEY, async () => {
    const expired = await cards.expireDueCards();
    if (expired > 0) ctx.logger.info("rk9-ads gate: expired activation cards", { expired });
  });

  ctx.actions.register(RESEND_GATE_CARD_ACTION_KEY, async (params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const gateRequestId = typeof params.gateRequestId === "string" ? params.gateRequestId : undefined;
    const publicationId = typeof params.publicationId === "string" ? params.publicationId : undefined;
    if (!gateRequestId && !publicationId) throw new Error("gateRequestId or publicationId is required");
    try {
      return await cards.resendActivationCard(companyId, { gateRequestId, publicationId });
    } catch (error) {
      throw new Error(safeError(error));
    }
  });

  runtime.onShutdown(async () => {
    setActivationCards(null);
  });
  return { cards };
}

export function register(runtime: FeatureRuntime): void {
  registerGate(runtime);
}
