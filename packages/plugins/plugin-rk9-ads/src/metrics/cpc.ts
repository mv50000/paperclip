/**
 * The one definition of the ads metrics (G18, RK9-512). Rules (A11), the UI
 * (A12), the digest and fatigue all use these functions.
 *
 * - CPC is link CPC: spend / inline_link_clicks. This is the Sunspot SOP
 *   definition. Meta's own `cpc` field divides by all clicks, so it is never used.
 * - CTR is link CTR in percent: inline_link_clicks / impressions × 100.
 * - CPM: spend / impressions × 1000.
 *
 * Money is integer minor units (cents). Insights `spend` arrives as a decimal
 * string in major units ("3.21"), unlike the account money fields, which are
 * minor units. `parseSpendCents` converts it with string math, so 0.1 + 0.2
 * style float errors cannot reach a sum.
 */

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** "3.21" -> 321. Rounds half up past two decimals. Throws on anything that is not a non-negative decimal. */
export function parseSpendCents(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error("spend must be a non-negative number");
    return Math.round(value * 100);
  }
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "string") throw new Error("spend must be a decimal string");
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new Error("spend must be a non-negative decimal string");
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const cents = whole * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) throw new Error("spend is out of range");
  return cents;
}

/** Non-negative integer count from a Graph string or number; missing is 0. */
export function parseCount(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("count must be a non-negative number");
  return Math.round(parsed);
}

/** Link CPC in EUR (account currency units); null without link clicks. */
export function linkCpc(spendCents: number, inlineLinkClicks: number): number | null {
  return inlineLinkClicks > 0 ? spendCents / 100 / inlineLinkClicks : null;
}

/** Link CTR in percent; null without impressions. */
export function linkCtr(inlineLinkClicks: number, impressions: number): number | null {
  return impressions > 0 ? (inlineLinkClicks / impressions) * 100 : null;
}

/** CPM in account currency units; null without impressions. */
export function cpm(spendCents: number, impressions: number): number | null {
  return impressions > 0 ? (spendCents / 100 / impressions) * 1000 : null;
}
