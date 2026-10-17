import { loadCompanyConfig } from "../../company-configs.js";
import { createInsightsStore } from "../../insights/store.js";
import { controllerNotifier, safeError } from "../spend-guard/support.js";
import type { FeatureRuntime } from "../types.js";
import { prepareRules } from "./editor.js";
import { createRulesJob, RULES_JOB_KEY, runRulesForBrand, type RulesDeps } from "./runner.js";
import { createRulesStore } from "./store.js";

/**
 * Rule engine (A11, RK9-515): pause rules, shadow mode first.
 *
 * - job `rules-evaluate` (hourly): runner.ts
 * - data `rules`: the brand's effective rules, liveMode and the rule actions
 *   of the last 24 h, for the operator UI (A12 owns the editor, G13)
 * - action `rules.dryRun`: what the rules would decide now. Reads only: no
 *   rule_actions row, no Meta write, no Telegram.
 * - action `rules.prepareSave`: checks the rule editor's pause rules and
 *   returns the `rules` block the UI saves through the host config route
 *   (editor.ts). Writes nothing.
 */

export const RULES_DATA_KEY = "rules";
export const RULES_DRY_RUN_ACTION_KEY = "rules.dryRun";
export const RULES_PREPARE_SAVE_ACTION_KEY = "rules.prepareSave";

export function registerRules(runtime: FeatureRuntime, overrides: Partial<RulesDeps> = {}): RulesDeps {
  const { ctx, ledger } = runtime;
  const deps: RulesDeps = {
    ctx,
    ledger,
    store: createRulesStore(ctx.db),
    notifier: controllerNotifier,
    now: () => new Date(),
    ...overrides,
  };

  ctx.jobs.register(RULES_JOB_KEY, createRulesJob(deps));

  ctx.data.register(RULES_DATA_KEY, async (params) => {
    // The host sets companyId to the company it authorized for this call.
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { state: "error", error: "company context is required" };
    const result = await loadCompanyConfig(ctx, companyId);
    if (result.state !== "enabled") return { state: result.state };
    let recentActions: unknown[] = [];
    try {
      recentActions = await createInsightsStore(ctx.db).recentRuleActions(companyId, 24);
    } catch (error) {
      ctx.logger.warn("rk9-ads rules: could not read recent rule actions", { companyId, error: safeError(error) });
    }
    return { state: "enabled", liveMode: result.config.rules.liveMode, rules: result.config.rules.list, recentActions };
  });

  ctx.actions.register(RULES_DRY_RUN_ACTION_KEY, async (_params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const result = await loadCompanyConfig(ctx, companyId);
    if (result.state !== "enabled") return { error: `Brand config is ${result.state}` };
    const outcome = await runRulesForBrand(deps, companyId, result.config, {
      initiator: { source: "ui", userId: context.actor.userId, agentId: context.actor.agentId, runId: context.actor.runId },
      persist: false,
    });
    return { liveMode: result.config.rules.liveMode, decisions: outcome.decisions, warnings: outcome.failures };
  });

  ctx.actions.register(RULES_PREPARE_SAVE_ACTION_KEY, async (params, context) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    const result = await loadCompanyConfig(ctx, companyId);
    // A broken config can still take a rules fix; without a saved config there is nothing to put rules into.
    if (result.state === "absent" || result.state === "unavailable") return { ok: false, errors: [`Brand config is ${result.state}`] };
    const raw = await ctx.config.get(companyId);
    return prepareRules(raw, { liveMode: params.liveMode, list: params.list });
  });

  return deps;
}

export function register(runtime: FeatureRuntime): void {
  registerRules(runtime);
}
