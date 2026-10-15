/**
 * Pure Finnish formatter of the morning digest (A10, RK9-512).
 *
 * No I/O, no clock, no Intl: the same input always gives the same text.
 * Numbers use the Finnish decimal comma. Telegram limits a message to 4096
 * UTF-16 code units, and JS string length counts exactly those units, so an
 * emoji counts double here too. Long lists are capped first; a final guard
 * cuts at a line break and marks the cut.
 */

import type { FatigueSignal } from "../insights/fatigue.js";
import type { Pacing } from "../insights/mtd.js";
import type { PendingGateSummary, RuleActionSummary } from "../insights/store.js";
import { linkCpc, linkCtr } from "../metrics/cpc.js";

export const TELEGRAM_TEXT_UTF16_LIMIT = 4096;
export const LIST_CAP = 10;
export const TRUNCATION_MARK = "\n… (viesti katkaistu)";

export interface DigestInput {
  brandName: string;
  /** The reported day ("yesterday"), YYYY-MM-DD in the ad account time zone. */
  reportDate: string;
  /** ISO 4217, e.g. EUR. */
  currency: string;
  yesterday: { spendCents: number; impressions: number; clicks: number; inlineLinkClicks: number };
  cpcWarnEur: number;
  zeroSpendMode: "message" | "silent";
  pacing: Pacing | null;
  /** Meta account spend_cap and its headroom (spend_cap − amount_spent), cents. */
  spendCap: { capCents: number | null; headroomCents: number | null } | null;
  /** Ads with effective_status ACTIVE; null when unknown. */
  activeAds: number | null;
  fatigued: Array<{ adId: string; adName?: string | null; signals: FatigueSignal[] }>;
  ruleActions: RuleActionSummary[];
  pendingGates: PendingGateSummary[];
  warnings: string[];
}

const SIGNAL_LABELS: Record<FatigueSignal, string> = {
  frequency: "frekvenssi korkea",
  ctr_decay: "CTR laskenut",
  cpc_rise: "CPC noussut",
  cpm_rise: "CPM noussut",
  age: "vanha mainos",
};

const ACTION_LABELS: Record<string, string> = {
  pause: "pysäytys",
  pause_all: "kaikki pysäytetty",
  propose_scale: "skaalausehdotus",
  none: "ei toimea",
};

const GATE_LABELS: Record<string, string> = {
  activate_ad: "mainoksen aktivointi",
  pause_all: "kaikkien pysäytys",
};

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Integer with a space as thousands separator: 12 345. */
export function formatInt(value: number): string {
  const n = Math.round(value);
  return `${n < 0 ? "-" : ""}${groupThousands(String(Math.abs(n)))}`;
}

/** Decimal with a comma: 0,29. */
export function formatDecimal(value: number, places = 2): string {
  const fixed = Math.abs(value).toFixed(places);
  const [whole, fraction] = fixed.split(".");
  const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${groupThousands(whole!)}${fraction ? `,${fraction}` : ""}`;
}

function currencySymbol(currency: string): string {
  return currency === "EUR" ? "€" : currency;
}

export function formatMoney(cents: number, currency: string): string {
  return `${formatDecimal(cents / 100)} ${currencySymbol(currency)}`;
}

function formatDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

function capped<T>(items: readonly T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, LIST_CAP).map(render);
  if (items.length > LIST_CAP) lines.push(`• … ja ${items.length - LIST_CAP} muuta`);
  return lines;
}

/** Cuts to the Telegram limit at a line break, never inside a surrogate pair. */
export function truncateForTelegram(text: string, limit = TELEGRAM_TEXT_UTF16_LIMIT): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - TRUNCATION_MARK.length);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const lineBreak = cut.lastIndexOf("\n");
  if (lineBreak > 0) cut = cut.slice(0, lineBreak);
  return `${cut}${TRUNCATION_MARK}`;
}

function isZeroDay(input: DigestInput): boolean {
  return input.yesterday.spendCents === 0 && (input.activeAds === null || input.activeAds === 0);
}

function hasNews(input: DigestInput): boolean {
  return input.warnings.length > 0 || input.pendingGates.length > 0 || input.fatigued.length > 0 || input.ruleActions.length > 0;
}

/**
 * The digest text, or null when zeroSpendMode is "silent", nothing was spent,
 * no ad is active and there is nothing else to report.
 */
export function formatDigest(input: DigestInput): string | null {
  const zero = isZeroDay(input);
  if (zero && input.zeroSpendMode === "silent" && !hasNews(input)) return null;

  const cur = input.currency;
  const lines: string[] = [`📊 ${input.brandName} · mainosraportti ${formatDate(input.reportDate)}`];

  if (zero) {
    lines.push(`Eilen: 0 ${currencySymbol(cur)} kulutus, ei aktiivisia mainoksia`);
  } else {
    const y = input.yesterday;
    lines.push(
      `Eilen: ${formatMoney(y.spendCents, cur)} · ${formatInt(y.impressions)} näyttöä · ${formatInt(y.clicks)} klikkiä · ${formatInt(y.inlineLinkClicks)} linkkiklikkiä`,
    );
    const ctr = linkCtr(y.inlineLinkClicks, y.impressions);
    const cpc = linkCpc(y.spendCents, y.inlineLinkClicks);
    const ctrText = ctr === null ? "CTR –" : `CTR ${formatDecimal(ctr)} %`;
    let cpcText = "CPC – (ei linkkiklikkejä)";
    if (cpc !== null) {
      cpcText = `CPC ${formatDecimal(cpc)} ${currencySymbol(cur)}`;
      if (cpc > input.cpcWarnEur) cpcText += ` ⚠️ yli ${formatDecimal(input.cpcWarnEur)} ${currencySymbol(cur)}`;
    }
    lines.push(`${ctrText} · ${cpcText}`);
  }

  if (input.pacing) {
    const p = input.pacing;
    const pct = p.monthlyCapCents > 0 ? Math.round((p.mtdCents / p.monthlyCapCents) * 100) : 0;
    lines.push(`Kuukausi: ${formatMoney(p.mtdCents, cur)} / ${formatMoney(p.monthlyCapCents, cur)} (${pct} %)`);
    if (p.projectedCents !== null) {
      const over = p.projectedCents > p.monthlyCapCents;
      lines.push(
        `Ennuste kuun loppuun: ${formatMoney(p.projectedCents, cur)}${over ? ` ⚠️ ylittää katon ${formatMoney(p.monthlyCapCents, cur)}` : ""}`,
      );
    }
    if (p.mtdCents > p.monthlyCapCents) lines.push(`⚠️ Kuukauden kulutus on jo yli katon`);
  }
  if (input.spendCap) {
    const { capCents, headroomCents } = input.spendCap;
    if (capCents === null) {
      lines.push("Metan kulutusraja: ei asetettu");
    } else {
      lines.push(
        `Metan kulutusraja: ${formatMoney(capCents, cur)}${headroomCents !== null ? `, jäljellä ${formatMoney(headroomCents, cur)}` : ""}`,
      );
    }
  }
  if (input.activeAds !== null && !zero) lines.push(`Aktiivisia mainoksia: ${formatInt(input.activeAds)}`);

  if (input.fatigued.length > 0) {
    lines.push("");
    lines.push(
      ...capped(input.fatigued, (ad) => {
        const label = ad.adName ? `${ad.adName} (${ad.adId})` : ad.adId;
        const why = ad.signals.map((signal) => SIGNAL_LABELS[signal]).join(", ");
        return `🔁 väsynyt: ${label}${why ? ` – ${why}` : ""}`;
      }),
    );
  }

  if (input.ruleActions.length > 0) {
    lines.push("");
    lines.push(`⚙️ Sääntötoimet (24 h): ${formatInt(input.ruleActions.length)}`);
    lines.push(
      ...capped(input.ruleActions, (action) => {
        const what = ACTION_LABELS[action.action] ?? action.action;
        const mode = action.mode === "live" ? (action.applied ? "tehty" : "ei tehty") : "varjotila";
        return `• ${action.ruleId}: ${what} ${action.objectType} ${action.objectId} (${mode})`;
      }),
    );
  }

  if (input.pendingGates.length > 0) {
    lines.push("");
    lines.push(`🟡 Odottaa hyväksyntää: ${formatInt(input.pendingGates.length)}`);
    lines.push(
      ...capped(input.pendingGates, (gate) => `• ${GATE_LABELS[gate.kind] ?? gate.kind}${gate.adId ? ` ${gate.adId}` : ""}`),
    );
  }

  if (input.warnings.length > 0) {
    lines.push("");
    lines.push("⚠️ Varoitukset:");
    lines.push(...capped(input.warnings, (warning) => `• ${warning}`));
  }

  return truncateForTelegram(lines.join("\n"));
}
