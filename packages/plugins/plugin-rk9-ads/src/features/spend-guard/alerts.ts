/**
 * Spend alerts of the scheduled watch (A6, RK9-511; risks RK9-523).
 *
 * - Month-to-date: 80 % and 100 % of the monthly cap, at most once per
 *   (company, brand, local month, threshold).
 * - Standing risks (guard.ts SPEND_RISKS): Meta's spend_cap is missing, its
 *   headroom is above the rest of the monthly cap (Meta is no backstop), or
 *   the current budgets project above the cap. At most once per (company,
 *   brand, local day, risk), so an unresolved risk is repeated daily.
 *
 * There is no automatic pause at 100 %: the A6 spec asks for an alert, and
 * the hard stop is Meta's spend_cap (G2: at most the monthly cap, reset on the
 * 1st). The 100 % and risk alerts say when that stop is missing.
 *
 * Markers are alert_dedupe rows (`spend-alert:<brand>:<YYYY-MM>:<pct>`,
 * `spend-risk:<brand>:<YYYY-MM-DD>:<risk>`), so they survive worker restarts.
 * A marker is claimed before the message is sent, so two runs never both send
 * it. When the send fails, the markers are given back and the next check
 * sends again: a failed send never loses an alert. One card carries every
 * newly claimed alert; it is a pause_all gate card, so one tap on
 * "⏸ Pysäytä kaikki" runs the kill switch.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { localDate } from "../../kit/local-time.js";
import type { GuardResult, SpendRisk } from "./guard.js";
import { guardMetrics, recordAction, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "./support.js";

export const ALERT_THRESHOLDS = [80, 100] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];
export const SPEND_ALERT_KIND = "spend_alert";
export const SPEND_RISK_KIND = "spend_risk";
/** How long the card's pause button stays usable. */
const CARD_VALID_MS = 7 * 24 * 3_600_000;

export function alertKey(brandCode: string, month: string, threshold: AlertThreshold): string {
  return `spend-alert:${brandCode}:${month}:${threshold}`;
}

export function riskKey(brandCode: string, date: string, risk: SpendRisk): string {
  return `spend-risk:${brandCode}:${date}:${risk}`;
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

function riskLine(figures: GuardResult, risk: SpendRisk): string {
  switch (risk) {
    case "no_spend_cap":
      return "⚠️ Metan spend_cap puuttuu: Meta ei pysäytä kulutusta katossa.";
    case "spend_cap_headroom_exceeds_remaining": {
      const left = figures.mtdEur === null ? null : Math.round((figures.monthlyCapEur - figures.mtdEur) * 100) / 100;
      return `⚠️ Metan spend_cap sallii vielä ${money(figures.headroomEur)}, mutta katosta on jäljellä ${money(left)}: Meta ei pysäytä ajoissa.`;
    }
    case "projection_exceeds_cap":
      return `⚠️ Nykyisillä budjeteilla kuun loppuun arvio ${money(figures.projectedMonthEndEur)} ylittää katon ${money(figures.monthlyCapEur)}.`;
  }
}

export function alertText(config: BrandConfig, figures: GuardResult, threshold: AlertThreshold | null, risks: readonly SpendRisk[] = []): string {
  const name = config.displayName || config.brandCode;
  const head =
    threshold === null
      ? `⚠️ ${name}: kulutusvahdin varoitus (${figures.pctUsed} % katosta käytetty)`
      : threshold >= 100
        ? `🛑 ${name}: kuukauden kulutuskatto täynnä (${figures.pctUsed} %)`
        : `⚠️ ${name}: kuukauden kulutus ${figures.pctUsed} % katosta`;
  return [
    head,
    ...risks.map((risk) => riskLine(figures, risk)),
    `Kulutettu ${figures.month}: ${money(figures.mtdEur)} / ${money(figures.monthlyCapEur)}`,
    `Arvio kuun lopussa: ${money(figures.projectedMonthEndEur)} (päiväbudjetit ${money(figures.dailyBudgetSumEur)}, ${figures.remainingDays} pv jäljellä)`,
    `Metan spend_cap ${money(figures.spendCapEur)}, kulutettu siitä ${money(figures.amountSpentEur)}`,
    "Napauta ⏸ Pysäytä kaikki, jos haluat pysäyttää kaikki mainokset nyt.",
  ].join("\n");
}

export interface AlertOutcome {
  /** Thresholds claimed by this call (at most once per month each). */
  claimed: AlertThreshold[];
  /** Risks claimed by this call (at most once per local day each). */
  risks: SpendRisk[];
  telegram: "sent" | "not_configured" | "failed" | "skipped";
  error?: string;
}

/**
 * Sends one card for the highest newly crossed threshold and every newly
 * found risk. Needs figures from a successful read (pctUsed not null). A
 * brand without a Telegram block is skipped without a marker, so the alert
 * goes out once Telegram is set up.
 */
export async function evaluateSpendAlerts(
  deps: { ctx: PluginContext; ledger: Ledger; store: OnceStore; notifier: SpendGuardNotifier; now?: () => Date },
  companyId: string,
  config: BrandConfig,
  figures: GuardResult,
  initiator: Initiator,
): Promise<AlertOutcome> {
  const pct = figures.pctUsed;
  if (pct === null || figures.mtdEur === null) return { claimed: [], risks: [], telegram: "skipped" };
  const crossed = ALERT_THRESHOLDS.filter((threshold) => pct >= threshold);
  if (crossed.length === 0 && figures.risks.length === 0) return { claimed: [], risks: [], telegram: "skipped" };
  if (!config.telegram) {
    deps.ctx.logger.info("rk9-ads spend alert: brand has no Telegram block, alert not sent", { companyId, pct, risks: figures.risks });
    return { claimed: [], risks: [], telegram: "not_configured" };
  }

  const now = deps.now?.() ?? new Date();
  const day = localDate(now, config.timeZone);
  const claimed: AlertThreshold[] = [];
  const risks: SpendRisk[] = [];
  for (const threshold of crossed) {
    const key = alertKey(config.brandCode, figures.month, threshold);
    if (await deps.store.claim(companyId, key, SPEND_ALERT_KIND, { pct, mtdEur: figures.mtdEur, month: figures.month })) {
      claimed.push(threshold);
    }
  }
  for (const risk of figures.risks) {
    if (await deps.store.claim(companyId, riskKey(config.brandCode, day, risk), SPEND_RISK_KIND, { pct, mtdEur: figures.mtdEur, date: day })) {
      risks.push(risk);
    }
  }
  if (claimed.length === 0 && risks.length === 0) return { claimed, risks, telegram: "skipped" };

  const highest = claimed.length > 0 ? claimed[claimed.length - 1]! : null;
  const validUntil = new Date(now.getTime() + CARD_VALID_MS);
  let outcome: AlertOutcome;
  try {
    const telegram = await deps.notifier.sendPauseCard(companyId, config, alertText(config, figures, highest, risks), validUntil);
    outcome = { claimed, risks, telegram };
  } catch (error) {
    outcome = { claimed, risks, telegram: "failed", error: safeError(error) };
    // Give the markers back so the next check sends again.
    const keys = [
      ...claimed.map((threshold) => alertKey(config.brandCode, figures.month, threshold)),
      ...risks.map((risk) => riskKey(config.brandCode, day, risk)),
    ];
    for (const key of keys) {
      try {
        await deps.store.release(companyId, key);
      } catch (releaseError) {
        outcome.error = `${outcome.error}; marker ${key} not released (${safeError(releaseError)})`;
      }
    }
  }

  const audit = [
    ...claimed.map((threshold) => ({
      ruleId: `spend-alert-${threshold}`,
      reason: `mtd_reached_${threshold}_pct`,
      extra: { threshold },
      label: `MTD alert ${threshold} %`,
    })),
    ...risks.map((risk) => ({ ruleId: `spend-risk-${risk}`, reason: risk, extra: { risk }, label: `spend risk ${risk}` })),
  ];
  for (const entry of audit) {
    await recordAction(deps, {
      companyId,
      config,
      ruleId: entry.ruleId,
      ruleType: "pause_all_cap",
      objectType: "account",
      objectId: config.meta.adAccountId,
      action: "none",
      dryRun: false,
      applied: outcome.telegram === "sent",
      reason: entry.reason,
      metrics: { ...guardMetrics(figures), ...entry.extra, telegram: outcome.telegram },
      initiator,
      error: outcome.error ?? null,
      message: `${entry.label} (${pct} % used, telegram ${outcome.telegram})`,
    });
  }
  return outcome;
}
