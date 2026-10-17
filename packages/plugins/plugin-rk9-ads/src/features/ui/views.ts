/**
 * Read models of the operator UI (A12, RK9-518). Every builder takes the
 * company from the host-authorized `companyId` and copies named fields into
 * the DTOs of ./dto.ts. A section that cannot be read reports its own error;
 * the rest of the page still renders.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isFreshPreflight, readCachedPreflight } from "../../brand/preflight.js";
import { loadCompanyConfig, type CompanyConfigResult } from "../../company-configs.js";
import type { BrandConfig, BrandConfigDraft } from "../../config.js";
import type { Ledger, LedgerRow } from "../../db.js";
import { evaluateFatigue } from "../../insights/fatigue-issues.js";
import { addDays } from "../../insights/mtd.js";
import { createInsightsStore } from "../../insights/store.js";
import { localDate } from "../../kit/local-time.js";
import { listAds } from "../../meta/methods.js";
import { REDACTED, redactValue } from "../../meta/redact.js";
import { linkCpc, linkCtr } from "../../metrics/cpc.js";
import { toPublicationRecord } from "../../publish/store.js";
import { readHalt, type HaltState } from "../spend-guard/halt.js";
import { spendSnapshot } from "../spend-guard/register.js";
import { brandReadClient, safeError, type OnceStore } from "../spend-guard/support.js";
import type {
  UiBrand,
  UiGateCard,
  UiHalt,
  UiOverview,
  UiPublication,
  UiRuleAction,
  UiSettings,
  UiSpend,
  UiSpendDay,
  UiWidget,
} from "./dto.js";

/** The local days of the spend/CPC table and the per-publication figures. */
export const SPEND_TABLE_DAYS = 14;
export const PUBLICATION_ROWS = 50;
export const RULE_LOG_HOURS = 7 * 24;
const GATE_ROWS = 50;

/** Telegram bot token shape (`<bot id>:<secret>`); redactText covers Meta tokens. */
const BOT_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g;

export interface ViewDeps {
  ctx: PluginContext;
  ledger: Ledger;
  store: OnceStore;
  now: () => Date;
}

/** Last pass over a DTO: token shapes are redacted even in free text (errors, Meta details). */
export function sanitize<T>(dto: T): T {
  const redacted = redactValue(dto);
  return JSON.parse(JSON.stringify(redacted).replace(BOT_TOKEN_RE, REDACTED)) as T;
}

/** `companyId` from the host-merged params; never another source. */
export function companyOf(params: Record<string, unknown>): string | null {
  return typeof params.companyId === "string" && params.companyId !== "" ? params.companyId : null;
}

type Section<T> = { ok: true; value: T } | { ok: false; error: string };

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

function draftOf(result: CompanyConfigResult): BrandConfigDraft | null {
  return result.state === "enabled" || result.state === "disabled" ? result.config : null;
}

function brandOf(config: BrandConfigDraft): UiBrand {
  return { brandCode: config.brandCode, displayName: config.displayName, timeZone: config.timeZone, monthlyCapEur: config.monthlyCapEur };
}

function configError(result: CompanyConfigResult): string | undefined {
  if (result.state === "absent") return "RK9 Ads is not configured for this company";
  if (result.state === "invalid") return "the brand config is invalid";
  if (result.state === "unavailable") return `the brand config could not be read: ${result.error}`;
  if (result.state === "disabled") return result.reason;
  return undefined;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const eur = (cents: number): number => Math.round(cents) / 100;

export function haltView(halt: HaltState): UiHalt {
  return {
    rule: halt.rule,
    since: halt.since,
    until: halt.until ?? null,
    reason: halt.reason,
    source: halt.initiator?.source ?? "unknown",
    userId: halt.initiator?.userId ?? null,
    agentId: halt.initiator?.agentId ?? null,
    tgUserId: halt.initiator?.tgUserId ?? null,
  };
}

export function spendView(snapshot: Awaited<ReturnType<typeof spendSnapshot>>): UiSpend {
  const spendCapStatus =
    snapshot.mtdEur === null && snapshot.spendCapEur === null
      ? "unknown"
      : snapshot.spendCapEur === null
        ? "missing"
        : snapshot.spendCapEur > snapshot.monthlyCapEur
          ? "above_cap"
          : "set";
  return {
    month: snapshot.month,
    mtdEur: snapshot.mtdEur,
    monthlyCapEur: snapshot.monthlyCapEur,
    pctUsed: snapshot.pctUsed,
    projectedMonthEndEur: snapshot.projectedMonthEndEur,
    dailyBudgetSumEur: snapshot.dailyBudgetSumEur,
    remainingDays: snapshot.remainingDays,
    spendCapEur: snapshot.spendCapEur,
    spendCapStatus,
    allow: snapshot.allow,
    reason: snapshot.reason,
    detail: snapshot.detail,
    risks: [...snapshot.risks],
  };
}

async function readHaltSection(ctx: PluginContext, companyId: string): Promise<{ halt: UiHalt | null; haltError?: string }> {
  const halt = await section(() => readHalt(ctx, companyId));
  return halt.ok ? { halt: halt.value ? haltView(halt.value) : null } : { halt: null, haltError: halt.error };
}

async function pendingGates(deps: ViewDeps, companyId: string): Promise<UiGateCard[]> {
  const rows = await deps.ledger.select(companyId, "gate_requests", {
    where: { status: "pending" },
    // Newest valid_until first: a backlog of expired rows the expiry job has not moved yet cannot push live cards past the limit.
    orderBy: { column: "valid_until", direction: "desc" },
    limit: GATE_ROWS,
  });
  const now = deps.now().getTime();
  const out: UiGateCard[] = [];
  for (const row of rows) {
    const validUntil = iso(row.valid_until);
    // A pending card past valid_until is expired; the gate-expiry job only has not moved it yet.
    if (!validUntil || Date.parse(validUntil) <= now) continue;
    out.push({ id: String(row.id), kind: String(row.kind), adId: str(row.ad_id), publicationId: str(row.publication_id), validUntil });
  }
  // Show the soonest-expiring card first.
  return out.reverse();
}

interface AdTotals {
  spendCents: number;
  impressions: number;
  linkClicks: number;
}

interface InsightsRead {
  days: UiSpendDay[];
  perAd: Map<string, AdTotals>;
}

async function readInsights(deps: ViewDeps, companyId: string, timeZone: string): Promise<InsightsRead> {
  const today = localDate(deps.now(), timeZone);
  const since = addDays(today, -(SPEND_TABLE_DAYS - 1));
  const rows = await createInsightsStore(deps.ctx.db).recentAdSeries(companyId, since, since);
  const byDay = new Map<string, AdTotals>();
  const perAd = new Map<string, AdTotals>();
  for (const row of rows) {
    if (row.date < since || row.date > today) continue;
    for (const [map, key] of [[byDay, row.date], [perAd, row.adId]] as const) {
      const entry = map.get(key) ?? { spendCents: 0, impressions: 0, linkClicks: 0 };
      entry.spendCents += row.spendCents;
      entry.impressions += row.impressions;
      entry.linkClicks += row.inlineLinkClicks;
      map.set(key, entry);
    }
  }
  const days: UiSpendDay[] = [];
  for (let offset = SPEND_TABLE_DAYS - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const day = byDay.get(date) ?? { spendCents: 0, impressions: 0, linkClicks: 0 };
    days.push({ date, spendEur: eur(day.spendCents), impressions: day.impressions, linkClicks: day.linkClicks, cpcEur: linkCpc(day.spendCents, day.linkClicks) });
  }
  return { days, perAd };
}

function publicationRow(row: LedgerRow): Omit<UiPublication, "adStatus" | "adEffectiveStatus" | "spendEur" | "impressions" | "linkClicks" | "ctrPct" | "cpcEur" | "fatigue" | "fatigueReasons"> {
  const record = toPublicationRecord(row);
  return {
    id: record.id,
    adName: record.adName,
    status: record.status,
    mode: record.mode,
    metaAdId: record.metaAdId,
    publishedAt: record.publishedAt,
    createdAt: record.createdAt,
    error: record.error,
  };
}

/** Data key `ads-overview`. */
export async function buildOverview(deps: ViewDeps, companyId: string): Promise<UiOverview> {
  const { ctx, ledger, store, now } = deps;
  const result = await loadCompanyConfig(ctx, companyId);
  const draft = draftOf(result);
  const base: UiOverview = {
    state: result.state,
    ...(configError(result) ? { error: configError(result) } : {}),
    brand: draft ? brandOf(draft) : null,
    launchReady: null,
    preflightCheckedAt: null,
    preflightFresh: false,
    spend: null,
    ...(await readHaltSection(ctx, companyId)),
    publications: [],
    pendingGates: [],
    ruleLog: [],
    spend14d: [],
  };
  if (!draft) return sanitize(base);
  const enabled: BrandConfig | null = result.state === "enabled" ? result.config : null;

  const [preflight, spend, publications, ads, gates, ruleLog, insights, fatigue] = await Promise.all([
    readCachedPreflight(ctx, companyId),
    enabled ? section(() => spendSnapshot(ctx, store, companyId, enabled, now())) : Promise.resolve(null),
    section(() => ledger.select(companyId, "publications", { orderBy: { column: "created_at", direction: "desc" }, limit: PUBLICATION_ROWS })),
    enabled ? section(() => listAds(brandReadClient(ctx, companyId, enabled), enabled.meta.adAccountId)) : Promise.resolve(null),
    section(() => pendingGates(deps, companyId)),
    section(() => createInsightsStore(ctx.db).recentRuleActions(companyId, RULE_LOG_HOURS, 50)),
    section(() => readInsights(deps, companyId, draft.timeZone)),
    enabled && enabled.fatigue.enabled
      ? section(() => evaluateFatigue(createInsightsStore(ctx.db), companyId, enabled, addDays(localDate(now(), enabled.timeZone), -1)))
      : Promise.resolve(null),
  ]);

  const out: UiOverview = { ...base };
  if (preflight) {
    out.launchReady = preflight.launchReady;
    out.preflightCheckedAt = preflight.checkedAt;
    out.preflightFresh = isFreshPreflight(preflight, draft, now());
  }
  if (spend) {
    if (spend.ok) out.spend = spendView(spend.value);
    else out.spendError = spend.error;
  }
  const adStatus = new Map<string, { status: string; effectiveStatus: string }>();
  if (ads) {
    if (ads.ok) for (const ad of ads.value) adStatus.set(ad.id, { status: ad.status, effectiveStatus: ad.effectiveStatus });
    else out.adsError = ads.error;
  }
  const fatigueOf = new Map<string, { status: string; reasons: string[] }>();
  if (fatigue) {
    if (fatigue.ok) for (const entry of fatigue.value) fatigueOf.set(entry.adId, { status: entry.result.status, reasons: entry.result.reasons });
    else out.insightsError = fatigue.error;
  }
  const perAd = insights.ok ? insights.value.perAd : new Map<string, AdTotals>();
  if (insights.ok) out.spend14d = insights.value.days;
  else out.insightsError = insights.error;
  if (publications.ok) {
    out.publications = publications.value.map((row) => {
      const view = publicationRow(row);
      const totals = (view.metaAdId ? perAd.get(view.metaAdId) : undefined) ?? { spendCents: 0, impressions: 0, linkClicks: 0 };
      const meta = view.metaAdId ? adStatus.get(view.metaAdId) : undefined;
      const tired = view.metaAdId ? fatigueOf.get(view.metaAdId) : undefined;
      return {
        ...view,
        adStatus: meta?.status ?? null,
        adEffectiveStatus: meta?.effectiveStatus ?? null,
        spendEur: eur(totals.spendCents),
        impressions: totals.impressions,
        linkClicks: totals.linkClicks,
        ctrPct: linkCtr(totals.linkClicks, totals.impressions),
        cpcEur: linkCpc(totals.spendCents, totals.linkClicks),
        fatigue: tired?.status ?? null,
        fatigueReasons: tired?.reasons ?? [],
      };
    });
  } else out.publicationsError = publications.error;
  if (gates.ok) out.pendingGates = gates.value;
  else out.gatesError = gates.error;
  if (ruleLog.ok) out.ruleLog = ruleLog.value.map((entry): UiRuleAction => ({ ...entry }));
  else out.ruleLogError = ruleLog.error;
  return sanitize(out);
}

/** Data key `ads-widget`. */
export async function buildWidget(deps: ViewDeps, companyId: string): Promise<UiWidget> {
  const { ctx, store, now } = deps;
  const result = await loadCompanyConfig(ctx, companyId);
  const draft = draftOf(result);
  const halt = await readHaltSection(ctx, companyId);
  const out: UiWidget = {
    state: result.state,
    ...(configError(result) ? { error: configError(result) } : {}),
    brandCode: draft?.brandCode ?? null,
    mtdEur: null,
    monthlyCapEur: draft?.monthlyCapEur ?? null,
    pctUsed: null,
    pendingGates: null,
    // A halt that cannot be read is shown as one: the widget must not look clear.
    halted: halt.halt !== null || halt.haltError !== undefined,
  };
  if (!draft) return sanitize(out);
  const [spend, gates] = await Promise.all([
    result.state === "enabled" ? section(() => spendSnapshot(ctx, store, companyId, result.config, now())) : Promise.resolve(null),
    section(() => pendingGates(deps, companyId)),
  ]);
  if (spend) {
    if (spend.ok) {
      out.mtdEur = spend.value.mtdEur;
      out.pctUsed = spend.value.pctUsed;
    } else out.spendError = spend.error;
  }
  if (gates.ok) out.pendingGates = gates.value.length;
  else out.gatesError = gates.error;
  return sanitize(out);
}

/** Data key `ads-settings`: named fields only; a secret shows as "configured". */
export async function buildSettings(ctx: PluginContext, companyId: string): Promise<UiSettings> {
  const result = await loadCompanyConfig(ctx, companyId);
  const empty: UiSettings = {
    state: result.state,
    ...(result.state === "absent" || result.state === "unavailable" ? { error: configError(result) } : {}),
    errors: result.state === "invalid" ? result.errors.slice(0, 50) : [],
    ...(result.state === "disabled" ? { reason: result.reason } : {}),
    brand: null,
    meta: null,
    telegram: null,
    landing: null,
    schedule: null,
    digest: null,
    fatigue: null,
  };
  const config = draftOf(result);
  if (!config) return sanitize(empty);
  return sanitize({
    ...empty,
    brand: brandOf(config),
    meta: {
      adAccountId: config.meta.adAccountId,
      pageId: config.meta.pageId,
      igUserId: config.meta.igUserId ?? null,
      datasetId: config.meta.datasetId ?? null,
      campaignId: config.meta.campaignId ?? null,
      adSetId: config.meta.adSetId ?? null,
      accessTokenConfigured: config.meta.accessTokenRef?.type === "secret_ref",
      specialAdCategories: [...config.meta.specialAdCategories],
    },
    telegram: config.telegram
      ? {
          configured: true,
          mode: config.telegram.mode,
          chatId: config.telegram.chatId,
          approverCount: config.telegram.allowedUserIds.length,
          gateTtlHours: config.telegram.gateTtlHours,
        }
      : { configured: false, mode: null, chatId: null, approverCount: 0, gateTtlHours: null },
    landing: {
      allowedDomains: [...config.landing.allowedDomains],
      urlKeys: Object.keys(config.landing.urls),
      defaultUrlKey: config.landing.defaultUrlKey,
    },
    schedule: {
      scheduledPauseEnabled: config.schedule.scheduledPause.enabled,
      scheduledPauseAt: config.schedule.scheduledPause.at,
      dataGate: config.schedule.dataGate !== undefined,
    },
    digest: { enabled: config.digest.enabled, time: config.digest.time, cpcWarnEur: config.digest.cpcWarnEur },
    fatigue: { enabled: config.fatigue.enabled, issuesEnabled: config.fatigue.issuesEnabled },
  });
}

