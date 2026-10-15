/**
 * Morning digest (A10, RK9-512): collects the figures for one brand, formats
 * them (./format.ts) and sends them once per brand per local date.
 *
 * Once-only: `digest_runs` gets the day's row (INSERT ... ON CONFLICT DO
 * NOTHING) before anything is sent, and each attempt is claimed with a
 * compare-and-set. A sent or skipped day is never sent again; a failed send
 * is recorded and retried by a later tick (at most MAX_DIGEST_ATTEMPTS).
 * `digest.dryRun` builds the same text and writes nothing.
 *
 * Every query is scoped by the brand's company_id, so one brand's digest can
 * never show another brand's ads or spend.
 */

import type { BrandConfig } from "../config.js";
import { isLocalTimeAtOrAfter, localDate } from "../kit/local-time.js";
import type { BotApi } from "../kit/telegram/bot-api.js";
import { MetaGraphError, TokenInvalidError } from "../meta/errors.js";
import type { GraphDriftEvent } from "../meta/graph.js";
import { getAccountSummary, listAds } from "../meta/methods.js";
import type { AccountSummary } from "../meta/types.js";
import { evaluateFatigue } from "../insights/fatigue-issues.js";
import { closeMarkerKey, INSIGHTS_WARNING_KIND, metaClientFor, type InsightsDeps } from "../insights/ingest.js";
import { addDays, monthToDate } from "../insights/mtd.js";
import { formatDigest, formatMoney, type DigestInput } from "./format.js";

export const MAX_DIGEST_ATTEMPTS = 5;
export const DIGEST_RETRY_AFTER_MINUTES = 10;
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
      error instanceof TokenInvalidError
        ? "Meta-token ei kelpaa (190): tilin tietoja ei saatu"
        : `Meta-tilin tietoja ei saatu: ${errorText(error)}`,
    );
  }
  const accountTimeZone = account?.timezone ?? config.timeZone;
  const currency = account?.currency ?? "EUR";
  const today = localDate(now, accountTimeZone);
  const reportDate = addDays(today, -1);

  const yesterday = await deps.store.dayTotals(companyId, reportDate);
  const pacing = await monthToDate(deps.store, companyId, { now, accountTimeZone, monthlyCapEur: config.monthlyCapEur });

  let spendCap: DigestInput["spendCap"] = null;
  if (account) {
    const capCents = account.spendCapCents;
    spendCap = { capCents, headroomCents: capCents === null ? null : capCents - account.amountSpentCents };
    if (capCents === null) {
      warnings.push("Metan tilillä ei ole kulutusrajaa (spend_cap)");
    } else {
      if (capCents > pacing.monthlyCapCents) {
        warnings.push(`Metan kulutusraja ${formatMoney(capCents, currency)} on yli kuukausikaton ${formatMoney(pacing.monthlyCapCents, currency)}`);
      }
      // amount_spent counts from the last reset. On day 2+ of a month it should be close to MTD (G2).
      const gap = account.amountSpentCents - pacing.mtdCents;
      if (pacing.completeDays >= 1 && gap > Math.max(200, Math.round(pacing.mtdCents * 0.1))) {
        warnings.push(
          `Kulutusrajan kuun 1. päivän nollaus näyttää puuttuvan: kulutettu rajaa vasten ${formatMoney(account.amountSpentCents, currency)}, kuukausi ${formatMoney(pacing.mtdCents, currency)}`,
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

  const fatigue = await evaluateFatigue(deps.store, companyId, config, reportDate);
  const fatigued = fatigue
    .filter((ad) => ad.result.status === "fatigued")
    .map((ad) => ({ adId: ad.adId, adName: names.get(ad.adId) ?? null, signals: ad.result.signals }));

  const ruleActions = await deps.store.recentRuleActions(companyId, 24);
  const pendingGates = await deps.store.pendingGates(companyId);

  const seen = new Set<string>();
  for (const mark of await deps.store.recentMarks(companyId, INSIGHTS_WARNING_KIND, 24)) {
    const code = String(mark.metadata.code ?? "graph");
    const message = String(mark.metadata.message ?? "");
    const line = `${WARNING_LABELS[code] ?? WARNING_LABELS.graph}${code === "field" ? `: ${message}` : ""}`;
    if (!seen.has(line)) {
      seen.add(line);
      warnings.push(line);
    }
  }
  if (!(await deps.store.hasMark(companyId, closeMarkerKey(localDate(now, config.timeZone))))) {
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
      projectedCents: pacing.projectedCents,
      activeAds,
      fatigued: fatigued.length,
      ruleActions: ruleActions.length,
      pendingGates: pendingGates.length,
      warnings: warnings.length,
    },
  };
}

export type DigestTickOutcome = "not_due" | "done" | "busy" | "sent" | "skipped" | "failed" | "disabled";

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
  await deps.store.ensureDigestRun(companyId, config.brandCode, digestDate);
  if (!(await deps.store.claimDigestRun(companyId, digestDate, MAX_DIGEST_ATTEMPTS, DIGEST_RETRY_AFTER_MINUTES))) return "busy";

  try {
    const built = await buildDigest(deps, companyId, config);
    if (built.text === null) {
      await deps.store.finishDigestRun(companyId, digestDate, { status: "skipped", summary: built.summary });
      return "skipped";
    }
    const bot = deps.telegram(companyId);
    if (!bot) throw new Error("Telegram is not ready for this company");
    const message = await bot.api.sendMessage({ chat_id: bot.chatId, text: built.text });
    await deps.store.finishDigestRun(companyId, digestDate, {
      status: "sent",
      chatId: bot.chatId,
      messageId: message.message_id,
      summary: built.summary,
    });
    return "sent";
  } catch (error) {
    const message = error instanceof MetaGraphError ? error.message : errorText(error);
    deps.ctx.logger.warn("rk9-ads digest: send failed", { companyId, brandCode: config.brandCode, digestDate, error: message.slice(0, 200) });
    try {
      await deps.store.finishDigestRun(companyId, digestDate, { status: "failed", error: message });
    } catch (storeError) {
      deps.ctx.logger.warn("rk9-ads digest: could not record failure", { companyId, error: errorText(storeError) });
    }
    return "failed";
  }
}
