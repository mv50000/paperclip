import { loadCompanyConfig } from "../../company-configs.js";
import { createInsightsStore } from "../../insights/store.js";
import { controllerNotifier, safeError } from "../spend-guard/support.js";
import type { FeatureRuntime } from "../types.js";
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
 */

export const RULES_DATA_KEY = "rules";
export const RULES_DRY_RUN_ACTION_KEY = "rules.dryRun";

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

  return deps;
}

export function register(runtime: FeatureRuntime): void {
  registerRules(runtime);
}
