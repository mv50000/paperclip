/**
 * Kill switch "Pysäytä kaikki" (A6, RK9-511), the plugin port of
 * sunspot-pulse-off.sh.
 *
 * pauseAll lists every campaign and ad whose configured status is ACTIVE and
 * pauses the campaigns first (that alone stops delivery), then the ads.
 *
 * Scope (RK9-523): the kill switch (rule `kill_switch`) always covers the
 * whole ad account, also when the config names `meta.campaignId`, so
 * campaigns created by hand in Meta's UI stop too (operator decision
 * 15.10.2026): the brand's ad account belongs to that brand, and the guard's
 * projection counts the whole account. The scheduled pause and the data gate
 * are the brand's pulse schedule, not the emergency brake: they keep the
 * `meta.campaignId` scope when it is set (Sunspot parity), else the whole
 * account. spend_cap is never touched (G2). Every paused campaign is in the
 * audit row and the Telegram notice, so a restore knows what to turn back on.
 * Listing follows every page; a list cut short throws instead of pausing part
 * of it.
 *
 * It is idempotent: a second run finds nothing ACTIVE, returns count 0 and
 * sends no Telegram. A dry run lists the same objects, sends no Meta write
 * (the client is in dry-run mode) and no Telegram.
 *
 * Before the first Meta call a live run of the kill switch, the cap pause or
 * the scheduled pause closes the company's open activation cards, so a tap
 * cannot undo the pause (RK9-557). The kill switch first leaves the standing
 * halt (halt.ts), which activate_ad checks before every write: it also stops
 * a tap that won before the close and every later card. A failed halt write
 * or card close does not stop the pause; the result and the audit row name it.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { localDate, localTime } from "../../kit/local-time.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { adAccountPath, getObjectStatus, listAds, listCampaignAds, listCampaigns, setObjectStatus } from "../../meta/methods.js";
import type { StatusRow } from "../../meta/types.js";
import { CARD_CLOSING_PAUSES, type CardClosingPause } from "../../gate/staging-card.js";
import { getActivationCards } from "../gate/runtime.js";
import { setHalt, type HaltState } from "./halt.js";
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
/** Telegram allows 4096 characters; the notice stays below this. */
const NOTICE_MAX = 3900;

/** `pause_all_cap` is the rule engine's built-in 90 % cap pause (A11, RK9-515). */
export type PauseRule = "kill_switch" | "scheduled_pause" | "data_gate" | "pause_all_cap";

export interface PausedObject {
  id: string;
  name: string;
}

export interface PauseAllResult {
  dryRun: boolean;
  rule: PauseRule;
  /** "account" for the kill switch; "campaign" when meta.campaignId scopes a scheduled or data-gate pause. */
  scope: "campaign" | "account";
  pausedAds: PausedObject[];
  pausedCampaigns: PausedObject[];
  /** True when at least one campaign was (or in a dry run, would be) paused. */
  campaignPaused: boolean;
  /** Ads plus campaigns paused (or planned in a dry run). */
  count: number;
  /** One line per object, campaigns first, for messages and the UI. */
  list: string[];
  /** Objects whose pause failed. The others are paused regardless. */
  errors: Array<{ id: string; error: string }>;
  /** "skipped": dry run, nothing paused or not asked to notify. */
  telegram: NoticeResult | "skipped" | "failed";
  telegramError?: string;
  /** The rule_actions insert of this run failed (the pause itself stands). */
  auditError?: string;
  /** Activation cards this run closed (live kill switch, cap pause, scheduled pause). */
  closedCardIds: string[];
  /** The open cards could not be listed or closed; the pause itself stands. */
  cardsError?: string;
  /** The standing halt a live kill switch left. */
  halt?: HaltState;
  /** The halt could not be stored; the pause itself stands. */
  haltError?: string;
}

export interface PauseAllDeps {
  ctx: PluginContext;
  ledger: Ledger;
  notifier: SpendGuardNotifier;
  /** Tests: replaces the brand's Meta client. */
  clientFor?: (companyId: string, config: BrandConfig, mode: "live" | "dryRun", initiator: Initiator) => MetaGraphClient;
  now?: () => Date;
  /** Tests: replaces the running gate's card closer. */
  closeCards?: (companyId: string, input: { rule: CardClosingPause; reason: string }) => Promise<string[]>;
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
  /** Extra figures for the audit row, e.g. the rule engine's MTD reading. */
  metrics?: Record<string, unknown>;
}

/**
 * The scope of a pause: the kill switch and the cap pause always take the
 * whole ad account (the cap counts the whole account's spend).
 */
export function pauseScope(config: BrandConfig, rule: PauseRule): "campaign" | "account" {
  return rule !== "kill_switch" && rule !== "pause_all_cap" && config.meta.campaignId ? "campaign" : "account";
}

/** The ACTIVE campaigns and ads the run would pause. Exported for parity tests. */
export async function listPauseTargets(
  client: MetaGraphClient,
  config: BrandConfig,
  rule: PauseRule,
): Promise<{ scope: "campaign" | "account"; ads: StatusRow[]; campaigns: StatusRow[] }> {
  const campaignId = config.meta.campaignId;
  if (pauseScope(config, rule) === "campaign" && campaignId) {
    const campaign = await getObjectStatus(client, campaignId);
    const ads = await listCampaignAds(client, campaignId, { maxPages: LIST_MAX_PAGES });
    return {
      scope: "campaign",
      ads: ads.filter((ad) => ad.status === "ACTIVE"),
      campaigns: campaign.status === "ACTIVE" ? [campaign] : [],
    };
  }
  const account = adAccountPath(config.meta.adAccountId);
  const campaigns = await listCampaigns(client, account, { maxPages: LIST_MAX_PAGES });
  const ads = await listAds(client, account, { maxPages: LIST_MAX_PAGES });
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
    options.rule === "scheduled_pause"
      ? "ajastettu pysäytys"
      : options.rule === "data_gate"
        ? "data-gate"
        : options.rule === "pause_all_cap"
          ? "kulutuskatto 90 %"
          : "hätäkatkaisin";
  const what = result.scope === "account" ? "koko mainostili pysäytetty" : "kampanja pysäytetty";
  const head = [
    `⏸ ${config.displayName || config.brandCode}`.slice(0, 120) + `: ${what} (${when}, ${why})`,
    ...(options.note ? [options.note.slice(0, 300)] : []),
    `Syy: ${options.reason}`.slice(0, 300),
    `${result.pausedCampaigns.length} kampanja(a) ja ${result.pausedAds.length} mainos(ta) → PAUSED:`,
  ];
  const tail = result.errors.length > 0 ? [`⚠️ ${result.errors.length} pysäytys epäonnistui, katso aktiviteettiloki.`] : [];
  // Campaigns first (a restore turns them back on), then ads. Whatever does
  // not fit is counted on its own line, never cut silently; the audit row has
  // every id.
  const lines = [...head];
  if (result.halt) lines.push("⛔ Pysäytystila päällä: aktivointikortit eivät aktivoi mitään, kunnes board poistaa tilan.");
  if (result.closedCardIds.length > 0) lines.push(`Avoimia aktivointikortteja mitätöity: ${result.closedCardIds.length}`);
  let length = [...lines, ...tail].join("\n").length;
  const fit = (items: PausedObject[], kind: string, rest: (n: number) => string) => {
    for (const [index, item] of items.entries()) {
      const line = `• ${kind} ${label(item)}`.slice(0, 200);
      if (length + line.length + 1 > NOTICE_MAX - 120) {
        lines.push(rest(items.length - index));
        length += 80;
        return;
      }
      lines.push(line);
      length += line.length + 1;
    }
  };
  fit(result.pausedCampaigns, "kampanja", (n) => `… ja ${n} muuta kampanjaa (kaikki id:t aktiviteettilokissa)`);
  fit(result.pausedAds, "mainos", (n) => `… ja ${n} muuta mainosta (lista aktiviteettilokissa)`);
  return [...lines, ...tail].join("\n");
}

/**
 * Pauses every ACTIVE campaign, then the ads. Meta errors on single objects
 * are collected and the rest still run; a listing error throws (nothing was
 * paused). The audit row is written for every run that paused, planned or
 * failed something, and for every explicit (non-job) run.
 */
function closesCards(rule: PauseRule): rule is CardClosingPause {
  return (CARD_CLOSING_PAUSES as readonly string[]).includes(rule);
}

/** The halt and the card close of a live run, before any Meta call. Never throws. */
async function stopActivations(
  deps: PauseAllDeps,
  companyId: string,
  config: BrandConfig,
  options: PauseAllOptions,
  now: Date,
): Promise<Pick<PauseAllResult, "closedCardIds" | "cardsError" | "halt" | "haltError">> {
  const out: Pick<PauseAllResult, "closedCardIds" | "cardsError" | "halt" | "haltError"> = { closedCardIds: [] };
  if (options.dryRun || !closesCards(options.rule)) return out;
  if (options.rule === "kill_switch") {
    const halt: HaltState = {
      brandCode: config.brandCode,
      rule: "kill_switch",
      since: now.toISOString(),
      reason: options.reason.slice(0, 300),
      initiator: options.initiator,
    };
    try {
      await setHalt(deps.ctx, companyId, halt);
      out.halt = halt;
    } catch (error) {
      out.haltError = safeError(error);
      deps.ctx.logger.error("rk9-ads kill switch: the standing halt was not stored", { companyId, detail: out.haltError });
    }
  }
  const close = deps.closeCards ?? getActivationCards()?.closeCardsForPause;
  if (!close) {
    out.cardsError = "the activation gate is not running; open cards were not closed";
  } else {
    try {
      out.closedCardIds = await close(companyId, { rule: options.rule, reason: options.reason });
    } catch (error) {
      out.cardsError = safeError(error);
    }
  }
  if (out.cardsError) deps.ctx.logger.error("rk9-ads pause: open activation cards not closed", { companyId, rule: options.rule, detail: out.cardsError });
  return out;
}

export async function pauseAll(
  deps: PauseAllDeps,
  companyId: string,
  config: BrandConfig,
  options: PauseAllOptions,
): Promise<PauseAllResult> {
  const now = deps.now?.() ?? new Date();
  const mode = options.dryRun ? "dryRun" : "live";
  const stopped = await stopActivations(deps, companyId, config, options, now);
  const stopErrors = [
    ...(stopped.haltError ? [`halt: ${stopped.haltError}`] : []),
    ...(stopped.cardsError ? [`cards: ${stopped.cardsError}`] : []),
  ];
  const client = deps.clientFor
    ? deps.clientFor(companyId, config, mode, options.initiator)
    : brandClient(deps, companyId, config, mode, { initiator: options.initiator });

  let targets: Awaited<ReturnType<typeof listPauseTargets>>;
  try {
    targets = await listPauseTargets(client, config, options.rule);
  } catch (error) {
    const message = safeError(error);
    await recordAction(deps, {
      companyId,
      config,
      ruleId: options.rule,
      ruleType: options.rule,
      objectType: pauseScope(config, options.rule),
      objectId: pauseScope(config, options.rule) === "campaign" ? config.meta.campaignId! : config.meta.adAccountId,
      action: "pause_all",
      dryRun: options.dryRun,
      applied: false,
      reason: options.reason,
      metrics: { count: 0, stage: "list", closedCardIds: stopped.closedCardIds, halt: stopped.halt !== undefined },
      initiator: options.initiator,
      error: [message, ...stopErrors].join("; ").slice(0, 1000),
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
    ...stopped,
  };

  for (const [kind, objects] of [["campaign", targets.campaigns], ["ad", targets.ads]] as const) {
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

  const stopRecorded = result.closedCardIds.length > 0 || result.halt !== undefined || stopErrors.length > 0;
  if (result.count > 0 || result.errors.length > 0 || stopRecorded || options.initiator.source !== "job") {
    const auditError = await recordAction(deps, {
      companyId,
      config,
      ruleId: options.rule,
      ruleType: options.rule,
      objectType: result.scope,
      objectId: result.scope === "campaign" ? config.meta.campaignId! : config.meta.adAccountId,
      action: "pause_all",
      dryRun: options.dryRun,
      applied: !options.dryRun && result.count > 0,
      reason: options.reason,
      metrics: {
        // The caller's figures first: they never overwrite the pause's own keys.
        ...options.metrics,
        count: result.count,
        scope: result.scope,
        adIds: result.pausedAds.map((ad) => ad.id),
        campaignIds: result.pausedCampaigns.map((campaign) => campaign.id),
        campaigns: result.pausedCampaigns,
        failedIds: result.errors.map((entry) => entry.id),
        telegram: result.telegram,
        closedCardIds: result.closedCardIds,
        halt: result.halt !== undefined,
        ...(options.note ? { note: options.note } : {}),
      },
      initiator: options.initiator,
      error: [
        ...result.errors.map((entry) => `${entry.id}: ${entry.error}`),
        ...(result.telegramError ? [`telegram: ${result.telegramError}`] : []),
        ...stopErrors,
      ]
        .join("; ")
        .slice(0, 1000) || null,
      message: `${options.rule}${options.dryRun ? " dry-run" : ""} ${options.dryRun ? "would pause" : "paused"} ${result.count} (source ${options.initiator.source})`,
    });
    if (auditError) result.auditError = auditError;
  }
  return result;
}
