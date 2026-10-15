/**
 * Month-to-date spend alerts (A6, RK9-511): 80 % and 100 % of the monthly cap,
 * at most once per (company, brand, local month, threshold).
 *
 * The marker is an alert_dedupe row (`spend-alert:<brand>:<YYYY-MM>:<pct>`),
 * so it survives worker restarts, and a new month has new keys. The marker is
 * written before the message is sent: a failed send is audited and reported,
 * never sent twice. The message is a pause_all gate card, so one tap on
 * "⏸ Pysäytä kaikki" runs the kill switch.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import type { GuardResult } from "./guard.js";
import { guardMetrics, recordAction, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "./support.js";

export const ALERT_THRESHOLDS = [80, 100] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];
export const SPEND_ALERT_KIND = "spend_alert";
/** How long the card's pause button stays usable. */
const CARD_VALID_MS = 7 * 24 * 3_600_000;

export function alertKey(brandCode: string, month: string, threshold: AlertThreshold): string {
  return `spend-alert:${brandCode}:${month}:${threshold}`;
}

/** The thresholds already alerted for `month`. */
export async function alertedThresholds(store: OnceStore, companyId: string, brandCode: string, month: string): Promise<AlertThreshold[]> {
  const keys = ALERT_THRESHOLDS.map((threshold) => alertKey(brandCode, month, threshold));
  const claimed = new Set(await store.claimed(companyId, keys));
  return ALERT_THRESHOLDS.filter((threshold) => claimed.has(alertKey(brandCode, month, threshold)));
}

function money(value: number | null): string {
  return value === null ? "?" : `${value.toFixed(2).replace(".", ",")} €`;
}

export function alertText(config: BrandConfig, figures: GuardResult, threshold: AlertThreshold): string {
  const head =
    threshold >= 100
      ? `🛑 ${config.displayName || config.brandCode}: kuukauden kulutuskatto täynnä (${figures.pctUsed} %)`
      : `⚠️ ${config.displayName || config.brandCode}: kuukauden kulutus ${figures.pctUsed} % katosta`;
  return [
    head,
    `Kulutettu ${figures.month}: ${money(figures.mtdEur)} / ${money(figures.monthlyCapEur)}`,
    `Arvio kuun lopussa: ${money(figures.projectedMonthEndEur)} (päiväbudjetit ${money(figures.dailyBudgetSumEur)}, ${figures.remainingDays} pv jäljellä)`,
    `Metan spend_cap ${money(figures.spendCapEur)}, kulutettu siitä ${money(figures.amountSpentEur)}`,
    "Napauta ⏸ Pysäytä kaikki, jos haluat pysäyttää kaikki mainokset nyt.",
  ].join("\n");
}

export interface AlertOutcome {
  /** Thresholds claimed by this call (at most once per month each). */
  claimed: AlertThreshold[];
  telegram: "sent" | "not_configured" | "failed" | "skipped";
  error?: string;
}

/**
 * Sends the alert for the highest newly crossed threshold. Needs figures from
 * a successful read (pctUsed not null). A brand without a Telegram block is
 * skipped without a marker, so the alert goes out once Telegram is set up.
 */
export async function evaluateSpendAlerts(
  deps: { ctx: PluginContext; ledger: Ledger; store: OnceStore; notifier: SpendGuardNotifier; now?: () => Date },
  companyId: string,
  config: BrandConfig,
  figures: GuardResult,
  initiator: Initiator,
): Promise<AlertOutcome> {
  const pct = figures.pctUsed;
  if (pct === null || figures.mtdEur === null) return { claimed: [], telegram: "skipped" };
  const crossed = ALERT_THRESHOLDS.filter((threshold) => pct >= threshold);
  if (crossed.length === 0) return { claimed: [], telegram: "skipped" };
  if (!config.telegram) {
    deps.ctx.logger.info("rk9-ads spend alert: brand has no Telegram block, alert not sent", { companyId, pct });
    return { claimed: [], telegram: "not_configured" };
  }

  const claimed: AlertThreshold[] = [];
  for (const threshold of crossed) {
    const key = alertKey(config.brandCode, figures.month, threshold);
    if (await deps.store.claim(companyId, key, SPEND_ALERT_KIND, { pct, mtdEur: figures.mtdEur, month: figures.month })) {
      claimed.push(threshold);
    }
  }
  if (claimed.length === 0) return { claimed, telegram: "skipped" };

  const highest = claimed[claimed.length - 1]!;
  const validUntil = new Date((deps.now?.() ?? new Date()).getTime() + CARD_VALID_MS);
  let outcome: AlertOutcome;
  try {
    const telegram = await deps.notifier.sendPauseCard(companyId, config, alertText(config, figures, highest), validUntil);
    outcome = { claimed, telegram };
  } catch (error) {
    outcome = { claimed, telegram: "failed", error: safeError(error) };
  }

  for (const threshold of claimed) {
    await recordAction(deps, {
      companyId,
      config,
      ruleId: `spend-alert-${threshold}`,
      ruleType: "pause_all_cap",
      objectType: "account",
      objectId: config.meta.adAccountId,
      action: "none",
      dryRun: false,
      applied: outcome.telegram === "sent",
      reason: `mtd_reached_${threshold}_pct`,
      metrics: { ...guardMetrics(figures), threshold, telegram: outcome.telegram },
      initiator,
      error: outcome.error ?? null,
      message: `MTD alert ${threshold} % (${pct} % used, telegram ${outcome.telegram})`,
    });
  }
  return outcome;
}
