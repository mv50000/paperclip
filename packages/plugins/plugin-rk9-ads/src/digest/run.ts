/**
 * Morning digest (A10, RK9-512): collects the figures for one brand, formats
 * them (./format.ts) and sends them once per brand per local date.
 *
 * At most once: `digest_runs` gets the day's row (INSERT ... ON CONFLICT DO
 * NOTHING) before anything is sent, and each attempt is claimed with a
 * compare-and-set. A sent or skipped day is never sent again; a failed send
 * is recorded and retried by a later tick (at most MAX_DIGEST_ATTEMPTS). A
 * row left pending (worker restart, unrecorded send) is closed as failed and
 * never resent, because its send state is unknown.
 * `digest.dryRun` builds the same text and writes nothing.
 *
 * Every query is scoped by the brand's company_id, so one brand's digest can
 * never show another brand's ads or spend.
 *
 * Month figures (RK9-526): MTD, the spend_cap headroom, what is left of the
 * monthly cap and the projection come from a spend guard snapshot
 * (checkSpend, fresh Graph reads), through the same monthPosition the guard
 * decides on. insights_daily MTD only cross-checks it: a gap above
 * MTD_SOURCE_GAP_* is logged and shown as a warning. When the guard cannot
 * read Meta, the digest falls back to insights_daily and says so.
 */

import type { BrandConfig } from "../config.js";
import { checkSpend, type GuardResult } from "../features/spend-guard/guard.js";
import { monthPosition, type MonthPosition } from "../features/spend-guard/position.js";
import { isLocalTimeAtOrAfter, localDate, localMonthBounds } from "../kit/local-time.js";
import { TelegramApiError, type BotApi } from "../kit/telegram/bot-api.js";
import { MetaGraphError, TokenInvalidError } from "../meta/errors.js";
import type { GraphDriftEvent } from "../meta/graph.js";
import { getAccountSummary, listAds } from "../meta/methods.js";
import type { AccountSummary } from "../meta/types.js";
import { evaluateFatigue } from "../insights/fatigue-issues.js";
import { closeMarkerKey, INSIGHTS_WARNING_KIND, metaClientFor, type InsightsDeps } from "../insights/ingest.js";
import { addDays, monthToDate, pacingOf, type Pacing } from "../insights/mtd.js";
import { formatDate, formatDigest, formatMoney, type DigestInput } from "./format.js";

export const MAX_DIGEST_ATTEMPTS = 5;
export const DIGEST_RETRY_AFTER_MINUTES = 10;
/**
 * insights_daily MTD may differ from the guard's Graph MTD by up to this much
 * (the larger of the two) before the digest warns: the hourly ingest lags
 * today's spend by up to an hour, and Meta revises recent days (RK9-526).
 */
export const MTD_SOURCE_GAP_MIN_CENTS = 200;
export const MTD_SOURCE_GAP_PCT = 5;
/** Warning markers are read this far back, so a long-running warning can say since when. */
export const WARNING_LOOKBACK_HOURS = 7 * 24;
export interface DigestDeps extends InsightsDeps {
  /** The company's bot and chat, or null when Telegram is not ready. */
  telegram: (companyId: string) => { api: Pick<BotApi, "sendMessage">; chatId: string } | null;
  drift: () => GraphDriftEvent | null;
}

export interface BuiltDigest {
  input: DigestInput;
  text: string | null;
  summary: Record<string, unknown>;
}

const WARNING_LABELS: Record<string, string> = {
  token: "Meta-token ei kelpaa (190), insights-haku epäonnistui",
  rate_limit: "Meta rajoitti kutsuja, insights-haku epäonnistui",
  graph: "Insights-haku epäonnistui",
  field: "Insights-kenttä ohitettiin",
  config: "Asetusvirhe",
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** Guard figures are EUR with whole cents (cents / 100), so this is exact. */
const toCents = (eur: number): number => Math.round(eur * 100);

/** Why the digest could not use the guard's figures. */
function guardUnreadWarning(guard: GuardResult, account: AccountSummary, config: BrandConfig): string {
  const fallback = "kuukauden luvut on laskettu tallennetuista insighteista";
  if (guard.reason === "account_timezone_mismatch") {
    return `Mainostilin aikavyöhyke ${account.timezone} poikkeaa brändin aikavyöhykkeestä ${config.timeZone}: spend guard estää kulutuksen nostot, ${fallback}`;
  }
  return `Spend guardin Meta-lukua ei saatu (${guard.reason}): ${fallback}`;
}

/**
 * The digest's month figures. Canonical: the guard snapshot through
 * monthPosition. Fallback: insights_daily MTD with the account summary the
 * digest read itself, through the same monthPosition.
 */
function monthFigures(input: {
  guard: GuardResult | null;
  stored: Pacing;
  account: AccountSummary | null;
  config: BrandConfig;
  now: Date;
}): { pacing: Pacing; position: MonthPosition | null; guardRead: boolean } {
  const { guard, stored, account, config } = input;
  if (guard && guard.mtdEur !== null && guard.amountSpentEur !== null && guard.projectedMonthEndEur !== null) {
    const position = monthPosition({
      monthlyCapEur: config.monthlyCapEur,
      mtdCents: toCents(guard.mtdEur),
      spendCapCents: guard.spendCapEur === null ? null : toCents(guard.spendCapEur),
      amountSpentCents: toCents(guard.amountSpentEur),
    });
    const pacing = pacingOf({
      month: localMonthBounds(input.now, config.timeZone),
      mtdCents: position.mtdCents,
      monthlyCapEur: config.monthlyCapEur,
      projectedCents: toCents(guard.projectedMonthEndEur),
      source: "spend_guard",
    });
    return { pacing, position, guardRead: true };
  }
  const position = account
    ? monthPosition({
        monthlyCapEur: config.monthlyCapEur,
        mtdCents: stored.mtdCents,
        spendCapCents: account.spendCapCents,
        amountSpentCents: account.amountSpentCents,
      })
    : null;
  return { pacing: stored, position, guardRead: false };
}

/** Warning markers grouped by digest line: shown while one recurred in the last 24 h. */
async function insightsWarnings(deps: DigestDeps, companyId: string): Promise<string[]> {
  const lines = new Map<string, { fresh: boolean; days: Set<string> }>();
  for (const mark of await deps.store.recentMarks(companyId, INSIGHTS_WARNING_KIND, WARNING_LOOKBACK_HOURS, 200)) {
    const code = String(mark.metadata.code ?? "graph");
    const message = String(mark.metadata.message ?? "");
    const line = `${WARNING_LABELS[code] ?? WARNING_LABELS.graph}${code === "field" ? `: ${message}` : ""}`;
    const entry = lines.get(line) ?? { fresh: false, days: new Set<string>() };
    entry.fresh ||= mark.fresh;
    // recordWarning keys a marker by account-local day: insights-warning:<day>:<code>...
    const day = /^insights-warning:(\d{4}-\d{2}-\d{2}):/.exec(mark.dedupeKey)?.[1];
    if (day) entry.days.add(day);
    lines.set(line, entry);
  }
  const out: string[] = [];
  for (const [line, entry] of lines) {
    // A warning that has not recurred in 24 h is over; it is not shown.
    if (!entry.fresh) continue;
    const days = [...entry.days].sort();
    const latest = days.at(-1);
    let since = latest;
    while (since && entry.days.has(addDays(since, -1))) since = addDays(since, -1);
    out.push(since && latest && since < latest ? `${line} (jatkunut ${formatDate(since)} alkaen)` : line);
  }
  return out;
}

/** Collects every figure of the digest. Reads only: Graph in readOnly mode, SELECTs on the ledger. */
export async function buildDigest(
  deps: DigestDeps,
  companyId: string,
  config: BrandConfig,
): Promise<BuiltDigest> {
  const warnings: string[] = [];
  const client = metaClientFor(deps, companyId, config);
  const now = deps.now();

  let account: AccountSummary | null = null;
  try {
    account = await getAccountSummary(client, config.meta.adAccountId);
  } catch (error) {
    warnings.push(
      `${
        error instanceof TokenInvalidError ? "Meta-token ei kelpaa (190): tilin tietoja ei saatu" : `Meta-tilin tietoja ei saatu: ${errorText(error)}`
      }; kuukauden luvut on laskettu tallennetuista insighteista`,
    );
  }
  const accountTimeZone = account?.timezone ?? config.timeZone;
  const currency = account?.currency ?? "EUR";
  const today = localDate(now, accountTimeZone);
  const reportDate = addDays(today, -1);

  const yesterday = await deps.store.dayTotals(companyId, reportDate);
  const stored = await monthToDate(deps.store, companyId, { now, accountTimeZone, monthlyCapEur: config.monthlyCapEur });

  // Canonical month figures: a spend guard snapshot on fresh Meta reads (RK9-526).
  const guard = account ? await checkSpend({ config, client, now }) : null;
  const { pacing, position, guardRead } = monthFigures({ guard, stored, account, config, now });
  let mtdGapCents: number | null = null;
  if (guard && account && !guardRead) warnings.push(guardUnreadWarning(guard, account, config));
  if (guard?.reason === "currency_not_eur") {
    warnings.push(`Mainostilin valuutta on ${currency}: spend guard estää kaikki kulutusta nostavat muutokset`);
  }
  if (guardRead) {
    mtdGapCents = stored.mtdCents - pacing.mtdCents;
    const tolerance = Math.max(MTD_SOURCE_GAP_MIN_CENTS, Math.round((pacing.mtdCents * MTD_SOURCE_GAP_PCT) / 100));
    if (Math.abs(mtdGapCents) > tolerance) {
      warnings.push(
        `Kuukauden kulutus poikkeaa lähteiden välillä: Meta ${formatMoney(pacing.mtdCents, currency)}, tallennetut insightsit ${formatMoney(stored.mtdCents, currency)}`,
      );
      deps.ctx.logger.warn("rk9-ads digest: MTD sources differ", {
        companyId,
        brandCode: config.brandCode,
        metaMtdCents: pacing.mtdCents,
        insightsMtdCents: stored.mtdCents,
        gapCents: mtdGapCents,
        toleranceCents: tolerance,
      });
    }
  }

  let spendCap: DigestInput["spendCap"] = null;
  if (position) {
    spendCap = { capCents: position.spendCapCents, headroomCents: position.headroomCents };
    if (position.spendCapCents === null || position.headroomCents === null) {
      warnings.push("Metan tilillä ei ole kulutusrajaa (spend_cap)");
    } else {
      if (position.headroomCents <= 0) {
        warnings.push("Metan kulutusraja on käytetty: Meta ei toimita mainoksia, ennen kuin rajaa nostetaan tai se nollataan");
      } else if (position.headroomExceedsRemaining && currency === "EUR") {
        // The guard's rule 4: it refuses every spend-raising write in this state.
        // It compares with the EUR cap, so only a EUR account is checked.
        warnings.push(
          `Metan kulutusrajaa on jäljellä ${formatMoney(position.headroomCents, currency)}, mutta kuukausikattoa vain ${formatMoney(position.remainingCents, currency)}: Meta ei pysäytä kulutusta ajoissa`,
        );
      }
      // amount_spent counts from the last reset. On day 2+ of a month it should be close to MTD (G2).
      const gap = position.amountSpentCents - position.mtdCents;
      if (pacing.completeDays >= 1 && gap > Math.max(200, Math.round(position.mtdCents * 0.1))) {
        warnings.push(
          `Kulutusrajan kuun 1. päivän nollaus näyttää puuttuvan: kulutettu rajaa vasten ${formatMoney(position.amountSpentCents, currency)}, kuukausi ${formatMoney(position.mtdCents, currency)}`,
        );
      }
    }
  }

  let activeAds: number | null = null;
  const names = new Map<string, string>();
  if (account) {
    try {
      const ads = await listAds(client, config.meta.adAccountId, { effectiveStatus: ["ACTIVE"] });
      activeAds = ads.length;
      for (const ad of ads) if (ad.name) names.set(ad.id, ad.name);
    } catch (error) {
      warnings.push(`Aktiivisia mainoksia ei saatu: ${errorText(error)}`);
    }
  }

  let fatigue: Awaited<ReturnType<typeof evaluateFatigue>> = [];
  try {
    fatigue = await evaluateFatigue(deps.store, companyId, config, reportDate);
  } catch (error) {
    // Fatigue is advisory: it must not cost the day's digest. The store error stays in the log.
    deps.ctx.logger.warn("rk9-ads digest: fatigue evaluation failed", { companyId, error: errorText(error) });
    warnings.push("Mainosten väsymistä ei saatu arvioitua");
  }
  const fatigued = fatigue
    .filter((ad) => ad.result.status === "fatigued")
    .map((ad) => ({ adId: ad.adId, adName: names.get(ad.adId) ?? null, signals: ad.result.signals }));

  const ruleActions = await deps.store.recentRuleActions(companyId, 24);
  const pendingGates = await deps.store.pendingGates(companyId);

  warnings.push(...(await insightsWarnings(deps, companyId)));
  // The close marks the account-local date whose yesterday it closed.
  if (!(await deps.store.hasMark(companyId, closeMarkerKey(today)))) {
    warnings.push("Eilisen luvut voivat olla vajaat: päivän sulkuajo ei ole vielä onnistunut");
  }
  const drift = deps.drift();
  if (drift) {
    warnings.push(`Graph API -versio vaihtui: client ${drift.expectedVersion}, Meta vastasi ${drift.observedVersion}`);
  }

  const input: DigestInput = {
    brandName: config.displayName || config.brandCode,
    reportDate,
    currency,
    yesterday: {
      spendCents: yesterday.spendCents,
      impressions: yesterday.impressions,
      clicks: yesterday.clicks,
      inlineLinkClicks: yesterday.inlineLinkClicks,
    },
    cpcWarnEur: config.digest.cpcWarnEur,
    zeroSpendMode: config.digest.zeroSpendMode,
    pacing,
    spendCap,
    activeAds,
    fatigued,
    ruleActions,
    pendingGates,
    warnings,
  };
  return {
    input,
    text: formatDigest(input),
    summary: {
      reportDate,
      accountTimeZone,
      spendCents: yesterday.spendCents,
      mtdCents: pacing.mtdCents,
      mtdSource: pacing.source,
      insightsMtdCents: stored.mtdCents,
      mtdGapCents,
      remainingCents: pacing.remainingCents,
      headroomCents: position?.headroomCents ?? null,
      guardReason: guard?.reason ?? null,
      projectedCents: pacing.projectedCents,
      activeAds,
      fatigued: fatigued.length,
      ruleActions: ruleActions.length,
      pendingGates: pendingGates.length,
      warnings: warnings.length,
    },
  };
}

export type DigestTickOutcome =
  | "not_due"
  | "done"
  | "busy"
  | "sent"
  | "skipped"
  | "failed"
  | "send_unknown"
  | "abandoned"
  | "disabled"
  | "telegram_not_ready";

/** Transport errors raised before a connection exists: nothing reached Telegram. */
const NEVER_CONNECTED_RE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/;

/**
 * True only when the message certainly was not delivered: Telegram answered
 * and refused it (HTTP 4xx), or the request never connected (DNS failure,
 * connection refused). Any other transport error (status 0), a 5xx or any
 * other error during the send leaves the delivery unknown.
 */
export function sendRefused(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  if (error.status >= 400 && error.status < 500) return true;
  return error.status === 0 && NEVER_CONNECTED_RE.test(error.description);
}

const FINISH_SENT_ATTEMPTS = 3;
const FINISH_SENT_BACKOFF_MS = 500;

/**
 * One brand's tick: sends the digest once per local date at or after
 * digest.time. Never throws; a failure is stored on the day's row.
 */
export async function digestTickBrand(deps: DigestDeps, companyId: string, config: BrandConfig): Promise<DigestTickOutcome> {
  if (!config.digest.enabled || !config.telegram) return "disabled";
  const now = deps.now();
  if (!isLocalTimeAtOrAfter(now, config.digest.time, config.timeZone)) return "not_due";
  const digestDate = localDate(now, config.timeZone);

  const existing = await deps.store.digestRun(companyId, digestDate);
  if (existing && (existing.status === "sent" || existing.status === "skipped")) return "done";
  if (existing && existing.status === "failed" && existing.attempts >= MAX_DIGEST_ATTEMPTS) return "done";
  if (await deps.store.abandonStaleDigestRun(companyId, digestDate, MAX_DIGEST_ATTEMPTS, DIGEST_RETRY_AFTER_MINUTES)) {
    deps.ctx.logger.warn("rk9-ads digest: abandoned a send that never finished; not resent", { companyId, digestDate });
    return "abandoned";
  }
  // Checked before the claim, so a bot that is still starting does not use up attempts.
  const bot = deps.telegram(companyId);
  if (!bot) {
    deps.ctx.logger.warn("rk9-ads digest: Telegram is not ready; the digest waits", { companyId, digestDate });
    return "telegram_not_ready";
  }
  await deps.store.ensureDigestRun(companyId, config.brandCode, digestDate);
  if (!(await deps.store.claimDigestRun(companyId, digestDate, MAX_DIGEST_ATTEMPTS, DIGEST_RETRY_AFTER_MINUTES))) return "busy";

  let delivered: { messageId: number | null; summary: Record<string, unknown> } | null = null;
  let sending = false;
  try {
    const built = await buildDigest(deps, companyId, config);
    if (built.text === null) {
      await deps.store.finishDigestRun(companyId, digestDate, { status: "skipped", summary: built.summary });
      return "skipped";
    }
    // A slow build can outlive the claim: a later tick may have abandoned the row meanwhile.
    const current = await deps.store.digestRun(companyId, digestDate);
    if (current?.status !== "pending") return "abandoned";
    sending = true;
    const message = await bot.api.sendMessage({ chat_id: bot.chatId, text: built.text });
    // Nothing after the send may throw into the catch below: that would mark a delivered digest retryable.
    delivered = { messageId: typeof message?.message_id === "number" ? message.message_id : null, summary: built.summary };
  } catch (error) {
    const message = error instanceof MetaGraphError ? error.message : errorText(error);
    if (sending && !sendRefused(error)) {
      // Telegram may have the message. Missed beats duplicate: the row stays
      // pending, and a later tick abandons it without a resend.
      deps.ctx.logger.warn("rk9-ads digest: send outcome unknown; not resent", { companyId, digestDate, error: message.slice(0, 200) });
      return "send_unknown";
    }
    deps.ctx.logger.warn("rk9-ads digest: send failed", { companyId, brandCode: config.brandCode, digestDate, error: message.slice(0, 200) });
    try {
      await deps.store.finishDigestRun(companyId, digestDate, { status: "failed", error: message });
    } catch (storeError) {
      deps.ctx.logger.warn("rk9-ads digest: could not record failure", { companyId, error: errorText(storeError) });
    }
    return "failed";
  }

  // Telegram has the message: never mark this row failed-and-retryable. If
  // every write fails, the row stays pending and a later tick abandons it
  // without a resend (abandonStaleDigestRun).
  for (let attempt = 1; attempt <= FINISH_SENT_ATTEMPTS; attempt += 1) {
    try {
      const updated = await deps.store.finishDigestRun(companyId, digestDate, { status: "sent", chatId: bot.chatId, ...delivered });
      if (updated === 0) deps.ctx.logger.warn("rk9-ads digest: sent, but the row was no longer pending", { companyId, digestDate });
      return "sent";
    } catch (error) {
      deps.ctx.logger.warn("rk9-ads digest: could not record a sent digest", { companyId, digestDate, attempt, error: errorText(error) });
      if (attempt < FINISH_SENT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, FINISH_SENT_BACKOFF_MS * attempt));
    }
  }
  return "sent";
}
