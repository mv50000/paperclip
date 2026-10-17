/**
 * The `rules-evaluate` job body (A11, RK9-515). Hourly, per company with a
 * valid brand config:
 *
 * 1. Read the live status of the brand's ads and campaigns (read-only client).
 *    A failed read pauses nothing (fail-open) and fails the run.
 * 2. Read the month position from the spend guard (checkSpend, the same MTD
 *    as the digest, RK9-526). Unreadable: the cap rule makes no decision.
 * 3. Read completed ad-days from insights_daily, creative validUntil, A10's
 *    fatigue (only when a pause_fatigued rule is on) and the earlier
 *    rule_actions the cooldowns need.
 * 4. evaluateRules() decides.
 * 5. Every decision goes to rule_actions and the activity log:
 *    - shadow: dry_run=true, no Meta write. The morning digest lists the
 *      shadow hits of the last 24 h, so shadow sends no Telegram of its own.
 *    - live ad pause: setObjectStatus(PAUSED) on the brand client, so the
 *      write passes the spend guard hook (guardedWrite). One Telegram message
 *      per run lists the ads that changed state; none when nothing changed.
 *    - pause_all (the built-in cap rule): A6's pauseAll, dry run in shadow.
 *      It pauses only ACTIVE objects, audits itself and notifies only when
 *      it paused something.
 *
 * One brand's failure does not stop the others. The run throws at the end
 * when anything failed, so the host shows it.
 */

import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { listCompanyConfigs } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { evaluateFatigue, type AdFatigue } from "../../insights/fatigue-issues.js";
import { addDays } from "../../insights/mtd.js";
import { createInsightsStore } from "../../insights/store.js";
import { localDate } from "../../kit/local-time.js";
import type { MetaClientMode, MetaGraphClient } from "../../meta/graph.js";
import { listAds, listCampaigns, setObjectStatus } from "../../meta/methods.js";
import { checkSpend } from "../spend-guard/guard.js";
import { pauseAll } from "../spend-guard/killswitch.js";
import { brandClient, brandReadClient, safeError, type Initiator, type SpendGuardNotifier } from "../spend-guard/support.js";
import { evaluateRules, type RuleDecision, type RuleSnapshots, type RuleStatus } from "./evaluate.js";
import type { RuleSet, ThresholdPauseRule } from "./schema.js";
import type { RulesStore } from "./store.js";

export const RULES_JOB_KEY = "rules-evaluate";
export const RULES_ACTIVITY_PREFIX = "rk9-ads rules";
const LIST_MAX_PAGES = 100;
/** Telegram allows 4096 characters; the notice stays below this. */
const NOTICE_MAX = 3900;

export interface RulesDeps {
  ctx: PluginContext;
  ledger: Ledger;
  store: RulesStore;
  notifier: SpendGuardNotifier;
  now: () => Date;
  /** A10 fatigue of the brand's ads as of a local date. */
  fatigue?: (companyId: string, config: BrandConfig, asOf: string) => Promise<AdFatigue[]>;
  /** Tests: replaces the brand's Meta client (readOnly for reads). */
  clientFor?: (companyId: string, config: BrandConfig, mode: MetaClientMode, initiator: Initiator) => MetaGraphClient;
}

export interface AppliedDecision extends RuleDecision {
  /** True when a live write changed the object (or pauseAll paused something). */
  applied: boolean;
  error: string | null;
}

export interface BrandRulesOutcome {
  brandCode: string;
  decisions: AppliedDecision[];
  /** Ads a live rule paused in this run. */
  changed: number;
  telegram: "sent" | "not_configured" | "failed" | "skipped";
  failures: string[];
}

function clientFor(deps: RulesDeps, companyId: string, config: BrandConfig, mode: MetaClientMode, initiator: Initiator): MetaGraphClient {
  if (deps.clientFor) return deps.clientFor(companyId, config, mode, initiator);
  if (mode === "readOnly") return brandReadClient(deps.ctx, companyId, config);
  return brandClient(deps, companyId, config, mode, { initiator });
}

async function logActivity(deps: RulesDeps, companyId: string, config: BrandConfig, message: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await deps.ctx.activity.log({
      companyId,
      message: `${RULES_ACTIVITY_PREFIX}: ${message}`,
      entityType: "rk9_ads_brand",
      entityId: config.brandCode,
      metadata,
    });
  } catch (error) {
    deps.ctx.logger.error("rk9-ads rules: activity log failed", { companyId, error: safeError(error) });
  }
}

/** rule_actions row + activity entry of one ad decision. An audit failure is logged, never thrown. */
async function audit(deps: RulesDeps, companyId: string, config: BrandConfig, decision: AppliedDecision, initiator: Initiator, now: Date): Promise<void> {
  const shadow = decision.mode === "shadow";
  try {
    await deps.store.insertAction(companyId, {
      brandCode: config.brandCode,
      ruleId: decision.ruleId,
      ruleType: decision.ruleType,
      objectType: decision.objectType,
      objectId: decision.objectId,
      action: decision.action,
      mode: decision.mode,
      dryRun: shadow,
      applied: decision.applied,
      reason: decision.reason,
      metrics: { ...decision.metrics, initiator },
      error: decision.error,
      decidedAt: now,
    });
  } catch (error) {
    deps.ctx.logger.error("rk9-ads rules: rule_actions insert failed", { companyId, error: safeError(error) });
  }
  const verb = shadow ? "would pause" : decision.applied ? "paused" : "failed to pause";
  await logActivity(deps, companyId, config, `${decision.ruleId} ${verb} ${decision.objectType} ${decision.objectId}${shadow ? " (shadow)" : ""}`, {
    rule: decision.ruleType,
    ruleId: decision.ruleId,
    action: decision.action,
    mode: decision.mode,
    dryRun: shadow,
    applied: decision.applied,
    reason: decision.reason,
    objectType: decision.objectType,
    objectId: decision.objectId,
    initiator,
    ...decision.metrics,
    ...(decision.error ? { error: decision.error } : {}),
  });
}

export function liveNoticeText(config: BrandConfig, paused: readonly AppliedDecision[], names: ReadonlyMap<string, string>, at: Date): string {
  const head = `⏸ ${config.displayName || config.brandCode}`.slice(0, 120) + `: säännöt pysäyttivät ${paused.length} mainos(ta) (${localDate(at, config.timeZone)})`;
  const lines = [head];
  let length = head.length;
  for (const [index, decision] of paused.entries()) {
    const name = names.get(decision.objectId);
    const line = `• ${decision.ruleId}: mainos ${name ? `${name} (${decision.objectId})` : decision.objectId} – ${decision.reason}`.slice(0, 400);
    if (length + line.length + 1 > NOTICE_MAX - 120) {
      lines.push(`… ja ${paused.length - index} muuta (lista aktiviteettilokissa)`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/** The snapshots evaluateRules needs. A status read failure throws (fail-open: nothing is decided). */
async function readInputs(
  deps: RulesDeps,
  companyId: string,
  config: BrandConfig,
  rules: RuleSet,
  now: Date,
  initiator: Initiator,
  failures: string[],
): Promise<{ snapshots: RuleSnapshots; status: RuleStatus }> {
  const brand = config.brandCode;
  const enabled = rules.list.filter((rule) => rule.enabled);
  const readClient = clientFor(deps, companyId, config, "readOnly", initiator);

  let status: RuleStatus;
  try {
    const [ads, campaigns] = await Promise.all([
      listAds(readClient, config.meta.adAccountId, { maxPages: LIST_MAX_PAGES }),
      listCampaigns(readClient, config.meta.adAccountId, { maxPages: LIST_MAX_PAGES }),
    ]);
    status = { adAccountId: config.meta.adAccountId, ads, campaigns };
  } catch (error) {
    throw new Error(`${brand}: Meta status read failed, nothing paused (fail-open): ${safeError(error)}`);
  }

  let spend: RuleSnapshots["spend"] = null;
  if (enabled.some((rule) => rule.type === "pause_all_cap")) {
    const figures = await checkSpend({ config, client: readClient, now });
    if (figures.pctUsed === null || figures.mtdEur === null) {
      failures.push(`${brand}: month-to-date not read (${figures.reason}: ${figures.detail}), pause_all_cap skipped (fail-open)`);
    } else {
      spend = { month: figures.month, mtdEur: figures.mtdEur, monthlyCapEur: figures.monthlyCapEur, pctUsed: figures.pctUsed };
    }
  }

  const yesterday = addDays(localDate(now, config.timeZone), -1);
  const thresholdRules = enabled.filter((rule): rule is ThresholdPauseRule => rule.type === "threshold_pause");
  const maxDays = Math.max(0, ...thresholdRules.map((rule) => rule.days));
  const days = maxDays > 0 ? await deps.store.adDays(companyId, addDays(yesterday, -(maxDays - 1)), yesterday) : [];

  const creatives = enabled.some((rule) => rule.type === "pause_valid_until") ? await deps.store.creativeValidity(companyId) : [];

  let fatigue: RuleSnapshots["fatigue"] = [];
  if (enabled.some((rule) => rule.type === "pause_fatigued") && config.fatigue.enabled) {
    try {
      const evaluate = deps.fatigue ?? ((id, brandConfig, asOf) => evaluateFatigue(createInsightsStore(deps.ctx.db), id, brandConfig, asOf));
      fatigue = (await evaluate(companyId, config, yesterday)).map((entry) => ({ adId: entry.adId, status: entry.result.status, signals: entry.result.signals }));
    } catch (error) {
      failures.push(`${brand}: fatigue not read (${safeError(error)}), pause_fatigued skipped (fail-open)`);
    }
  }

  const maxCooldownHours = Math.max(0, ...enabled.map((rule) => rule.cooldownHours));
  const priorActions = maxCooldownHours > 0
    ? await deps.store.priorActions(companyId, enabled.map((rule) => rule.ruleId), new Date(now.getTime() - maxCooldownHours * 3_600_000))
    : [];

  return { snapshots: { timeZone: config.timeZone, days, creatives, fatigue, spend, priorActions }, status };
}

/**
 * Evaluates one brand. `persist: false` is the dry run: the same reads and
 * decisions, but no rule_actions row, no activity entry, no Meta write and
 * no Telegram.
 */
export async function runRulesForBrand(
  deps: RulesDeps,
  companyId: string,
  config: BrandConfig,
  options: { initiator: Initiator; persist: boolean },
): Promise<BrandRulesOutcome> {
  const now = deps.now();
  const failures: string[] = [];
  const outcome: BrandRulesOutcome = { brandCode: config.brandCode, decisions: [], changed: 0, telegram: "skipped", failures };
  const { snapshots, status } = await readInputs(deps, companyId, config, config.rules, now, options.initiator, failures);
  const decisions = evaluateRules(snapshots, status, config.rules, now);
  if (!options.persist) {
    outcome.decisions = decisions.map((decision) => ({ ...decision, applied: false, error: null }));
    return outcome;
  }

  const names = new Map(status.ads.map((ad) => [ad.id, ad.name ?? ""]));
  const paused: AppliedDecision[] = [];
  let liveClient: MetaGraphClient | null = null;

  for (const decision of decisions) {
    if (decision.action === "pause_all") {
      const shadow = decision.mode === "shadow";
      try {
        const result = await pauseAll(
          {
            ctx: deps.ctx,
            ledger: deps.ledger,
            notifier: deps.notifier,
            now: deps.now,
            ...(deps.clientFor ? { clientFor: (id, brandConfig, mode, initiator) => deps.clientFor!(id, brandConfig, mode, initiator) } : {}),
          },
          companyId,
          config,
          {
            dryRun: shadow,
            rule: "pause_all_cap",
            reason: `${decision.ruleId}: ${decision.reason}`,
            initiator: options.initiator,
            notify: true,
            note: `Kulutus ${decision.metrics.pctUsed} % kuukauden katosta (${decision.metrics.mtdEur} / ${decision.metrics.monthlyCapEur} €)`,
            metrics: { ruleId: decision.ruleId, mode: decision.mode, ...decision.metrics },
          },
        );
        const error = result.errors.length > 0 ? `${result.errors.length} pause(s) failed` : null;
        outcome.decisions.push({ ...decision, applied: !shadow && result.count > 0, error });
        if (error) failures.push(`${config.brandCode} ${decision.ruleId}: ${error}`);
        if (result.telegram === "failed") failures.push(`${config.brandCode} ${decision.ruleId}: paused ${result.count} but the Telegram notice failed (${result.telegramError})`);
      } catch (error) {
        // pauseAll audited the failed listing itself.
        outcome.decisions.push({ ...decision, applied: false, error: safeError(error) });
        failures.push(`${config.brandCode} ${decision.ruleId}: ${safeError(error)}`);
      }
      continue;
    }

    const applied: AppliedDecision = { ...decision, applied: false, error: null };
    if (decision.mode === "live") {
      try {
        liveClient ??= clientFor(deps, companyId, config, "live", options.initiator);
        const result = await setObjectStatus(liveClient, decision.objectId, "PAUSED");
        applied.applied = "success" in result && result.success === true;
        if (!applied.applied) applied.error = "Meta did not confirm the pause";
      } catch (error) {
        applied.error = safeError(error);
      }
      if (applied.applied) paused.push(applied);
      else failures.push(`${config.brandCode} ${decision.ruleId}: pause of ad ${decision.objectId} failed (${applied.error})`);
    }
    await audit(deps, companyId, config, applied, options.initiator, now);
    outcome.decisions.push(applied);
  }

  outcome.changed = paused.length;
  if (paused.length > 0) {
    try {
      outcome.telegram = await deps.notifier.sendMessage(companyId, config, liveNoticeText(config, paused, names, now));
    } catch (error) {
      outcome.telegram = "failed";
      failures.push(`${config.brandCode}: paused ${paused.length} ad(s) but the Telegram notice failed (${safeError(error)})`);
    }
  }
  return outcome;
}

export function createRulesJob(deps: RulesDeps) {
  return async (job: PluginJobContext): Promise<void> => {
    const { ctx } = deps;
    const failures: string[] = [];
    let brands = 0;
    for (const { companyId, result } of await listCompanyConfigs(ctx)) {
      if (result.state === "absent") continue;
      if (result.state !== "enabled") {
        // No rule acts on a config it cannot read. The spend guard's pause side still runs (A6).
        failures.push(`company ${companyId}: brand config is ${result.state}, rules not evaluated`);
        continue;
      }
      brands += 1;
      try {
        const outcome = await runRulesForBrand(deps, companyId, result.config, { initiator: { source: "job", jobRunId: job.runId }, persist: true });
        failures.push(...outcome.failures);
      } catch (error) {
        ctx.logger.warn("rk9-ads rules: brand failed", { companyId, error: safeError(error) });
        failures.push(`${result.config.brandCode}: ${safeError(error)}`);
      }
    }
    ctx.logger.info("rk9-ads rules-evaluate done", { runId: job.runId, brands, failures: failures.length });
    if (failures.length > 0) throw new Error(`rules-evaluate: ${failures.join("; ")}`.slice(0, 2000));
  };
}
