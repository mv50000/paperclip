/**
 * Kill switch "Pysäytä kaikki" (A6, RK9-511), the plugin port of
 * sunspot-pulse-off.sh.
 *
 * pauseAll lists every ad whose configured status is ACTIVE, pauses them,
 * then pauses the campaign. The scope is `meta.campaignId` when the brand
 * config names one (the ads of that campaign, like the script), otherwise the
 * whole ad account (every ACTIVE ad, then every ACTIVE campaign). Listing
 * follows every page; a list cut short throws instead of pausing part of it.
 *
 * It is idempotent: a second run finds nothing ACTIVE, returns count 0 and
 * sends no Telegram. A dry run lists the same objects, sends no Meta write
 * (the client is in dry-run mode) and no Telegram.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { localDate, localTime } from "../../kit/local-time.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { adAccountPath, getObjectStatus, listAds, listCampaignAds, listCampaigns, setObjectStatus } from "../../meta/methods.js";
import type { StatusRow } from "../../meta/types.js";
import {
  brandClient,
  recordAction,
  safeError,
  type Initiator,
  type NoticeResult,
  type SpendGuardNotifier,
} from "./support.js";

/** 100 objects per page: up to 10 000 ads before a listing refuses as truncated. */
const LIST_MAX_PAGES = 100;

export type PauseRule = "kill_switch" | "scheduled_pause" | "data_gate";

export interface PausedObject {
  id: string;
  name: string;
}

export interface PauseAllResult {
  dryRun: boolean;
  rule: PauseRule;
  /** "campaign" when meta.campaignId scopes the run, else "account". */
  scope: "campaign" | "account";
  pausedAds: PausedObject[];
  pausedCampaigns: PausedObject[];
  /** True when at least one campaign was (or in a dry run, would be) paused. */
  campaignPaused: boolean;
  /** Ads plus campaigns paused (or planned in a dry run). */
  count: number;
  /** One line per object, ads first, for messages and the UI. */
  list: string[];
  /** Objects whose pause failed. The others are paused regardless. */
  errors: Array<{ id: string; error: string }>;
  /** "skipped": dry run, nothing paused or not asked to notify. */
  telegram: NoticeResult | "skipped" | "failed";
  telegramError?: string;
}

export interface PauseAllDeps {
  ctx: PluginContext;
  ledger: Ledger;
  notifier: SpendGuardNotifier;
  /** Tests: replaces the brand's Meta client. */
  clientFor?: (companyId: string, config: BrandConfig, mode: "live" | "dryRun", initiator: Initiator) => MetaGraphClient;
  now?: () => Date;
}

export interface PauseAllOptions {
  dryRun: boolean;
  rule: PauseRule;
  reason: string;
  initiator: Initiator;
  /** Send the Telegram notice after a live pause that paused something. */
  notify: boolean;
  /** Extra text for the notice, e.g. the data gate reading. */
  note?: string;
}

/** The ACTIVE ads and campaigns the run would pause. Exported for parity tests. */
export async function listPauseTargets(
  client: MetaGraphClient,
  config: BrandConfig,
): Promise<{ scope: "campaign" | "account"; ads: StatusRow[]; campaigns: StatusRow[] }> {
  const campaignId = config.meta.campaignId;
  if (campaignId) {
    const campaign = await getObjectStatus(client, campaignId);
    const ads = await listCampaignAds(client, campaignId, { maxPages: LIST_MAX_PAGES });
    return {
      scope: "campaign",
      ads: ads.filter((ad) => ad.status === "ACTIVE"),
      campaigns: campaign.status === "ACTIVE" ? [campaign] : [],
    };
  }
  const account = adAccountPath(config.meta.adAccountId);
  const ads = await listAds(client, account, { maxPages: LIST_MAX_PAGES });
  const campaigns = await listCampaigns(client, account, { maxPages: LIST_MAX_PAGES });
  return {
    scope: "account",
    ads: ads.filter((ad) => ad.status === "ACTIVE"),
    campaigns: campaigns.filter((campaign) => campaign.status === "ACTIVE"),
  };
}

function label(object: PausedObject): string {
  return object.name ? `${object.name} (${object.id})` : object.id;
}

export function pauseNoticeText(config: BrandConfig, result: PauseAllResult, at: Date, options: Pick<PauseAllOptions, "rule" | "note" | "reason">): string {
  const when = `${localDate(at, config.timeZone)} ${localTime(at, config.timeZone)}`;
  const why =
    options.rule === "scheduled_pause" ? "ajastettu pysäytys" : options.rule === "data_gate" ? "data-gate" : "hätäkatkaisin";
  const lines = [
    `⏸ ${config.displayName || config.brandCode}: mainokset pysäytetty (${when}, ${why})`,
    ...(options.note ? [options.note] : []),
    `Syy: ${options.reason}`.slice(0, 300),
    `${result.pausedAds.length} mainos(ta) ja ${result.pausedCampaigns.length} kampanja(a) → PAUSED:`,
    ...result.list.slice(0, 40).map((line) => `• ${line}`),
    ...(result.list.length > 40 ? [`… ja ${result.list.length - 40} muuta`] : []),
    ...(result.errors.length > 0 ? [`⚠️ ${result.errors.length} pysäytys epäonnistui, katso aktiviteettiloki.`] : []),
  ];
  return lines.join("\n").slice(0, 4000);
}

/**
 * Pauses every ACTIVE ad, then the campaign(s). Meta errors on single objects
 * are collected and the rest still run; a listing error throws (nothing was
 * paused). The audit row is written for every run that paused, planned or
 * failed something, and for every explicit (non-job) run.
 */
export async function pauseAll(
  deps: PauseAllDeps,
  companyId: string,
  config: BrandConfig,
  options: PauseAllOptions,
): Promise<PauseAllResult> {
  const now = deps.now?.() ?? new Date();
  const mode = options.dryRun ? "dryRun" : "live";
  const client = deps.clientFor
    ? deps.clientFor(companyId, config, mode, options.initiator)
    : brandClient(deps, companyId, config, mode, { initiator: options.initiator });

  let targets: Awaited<ReturnType<typeof listPauseTargets>>;
  try {
    targets = await listPauseTargets(client, config);
  } catch (error) {
    const message = safeError(error);
    await recordAction(deps, {
      companyId,
      config,
      ruleId: options.rule,
      ruleType: options.rule,
      objectType: config.meta.campaignId ? "campaign" : "account",
      objectId: config.meta.campaignId ?? config.meta.adAccountId,
      action: "pause_all",
      dryRun: options.dryRun,
      applied: false,
      reason: options.reason,
      metrics: { count: 0, stage: "list" },
      initiator: options.initiator,
      error: message,
      message: `${options.rule} failed before any pause: could not list the active ads (source ${options.initiator.source})`,
    });
    throw error;
  }
  const result: PauseAllResult = {
    dryRun: options.dryRun,
    rule: options.rule,
    scope: targets.scope,
    pausedAds: [],
    pausedCampaigns: [],
    campaignPaused: false,
    count: 0,
    list: [],
    errors: [],
    telegram: "skipped",
  };

  for (const [kind, objects] of [["ad", targets.ads], ["campaign", targets.campaigns]] as const) {
    for (const object of objects) {
      try {
        await setObjectStatus(client, object.id, "PAUSED");
        const paused = { id: object.id, name: object.name };
        (kind === "ad" ? result.pausedAds : result.pausedCampaigns).push(paused);
        result.list.push(`${kind === "ad" ? "mainos" : "kampanja"} ${label(paused)}`);
      } catch (error) {
        result.errors.push({ id: object.id, error: safeError(error) });
      }
    }
  }
  result.campaignPaused = result.pausedCampaigns.length > 0;
  result.count = result.pausedAds.length + result.pausedCampaigns.length;

  if (!options.dryRun && options.notify && result.count > 0) {
    try {
      result.telegram = await deps.notifier.sendMessage(companyId, config, pauseNoticeText(config, result, now, options));
    } catch (error) {
      result.telegram = "failed";
      result.telegramError = safeError(error);
    }
  }

  if (result.count > 0 || result.errors.length > 0 || options.initiator.source !== "job") {
    const campaignId = config.meta.campaignId;
    await recordAction(deps, {
      companyId,
      config,
      ruleId: options.rule,
      ruleType: options.rule,
      objectType: campaignId ? "campaign" : "account",
      objectId: campaignId ?? config.meta.adAccountId,
      action: "pause_all",
      dryRun: options.dryRun,
      applied: !options.dryRun && result.count > 0,
      reason: options.reason,
      metrics: {
        count: result.count,
        scope: result.scope,
        adIds: result.pausedAds.map((ad) => ad.id),
        campaignIds: result.pausedCampaigns.map((campaign) => campaign.id),
        failedIds: result.errors.map((entry) => entry.id),
        telegram: result.telegram,
        ...(options.note ? { note: options.note } : {}),
      },
      initiator: options.initiator,
      error: [...result.errors.map((entry) => `${entry.id}: ${entry.error}`), ...(result.telegramError ? [`telegram: ${result.telegramError}`] : [])]
        .join("; ")
        .slice(0, 1000) || null,
      message: `${options.rule}${options.dryRun ? " dry-run" : ""} ${options.dryRun ? "would pause" : "paused"} ${result.count} (source ${options.initiator.source})`,
    });
  }
  return result;
}
