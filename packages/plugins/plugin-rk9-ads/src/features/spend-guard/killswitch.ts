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
 * the scheduled pause leaves its halt (halt.ts) and closes the company's open
 * activation card rows, so a tap cannot undo the pause (RK9-557). activate_ad
 * checks the halt before every ACTIVE write and after its writes, so the halt
 * also stops an activation that was approved before the close (RK9-561). The
 * kill switch's halt stands until a board user clears it; the scheduled
 * pause's lasts until the next local morning, the cap pause's until the next
 * local month. The cards are edited after the Meta pauses, so a slow Telegram
 * does not delay them. A failed halt write or card close does not stop the
 * pause; the result and the audit row name it.
 *
 * A live kill switch or scheduled pause also stores a re-check (recheck.ts,
 * RK9-565): about a minute later the scheduled-pause job lists the ACTIVE
 * objects again, in case Meta's listing showed an activation's last write
 * late.
 *
 * When Meta refuses the PAUSED write of an ACTIVE object in a live kill
 * switch, cap pause, scheduled pause or re-check, the object goes to the
 * pause retry (pending-undo.ts, RK9-568) and one alert names it: the
 * scheduled-pause job pauses it again every tick until Meta confirms, a
 * board user acknowledges it, or a newer activation is approved after the
 * halt ended. A pause that is not repeated (the kill switch) or whose
 * re-check has a 15-minute window no longer leaves it ACTIVE unnoticed.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { randomUUID } from "node:crypto";
import { localDate, localTime, nextLocalMonthStart, nextLocalTime } from "../../kit/local-time.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { adAccountPath, getObjectStatus, listAds, listCampaignAds, listCampaigns, setObjectStatus } from "../../meta/methods.js";
import { isDryRun, type StatusRow } from "../../meta/types.js";
import { CARD_CLOSING_PAUSES, type CardClosingPause, type PauseCardClose } from "../../gate/staging-card.js";
import { getActivationCards } from "../gate/runtime.js";
import { HALT_RULES, haltIdentity, SCHEDULED_HALT_UNTIL, setHalt, type HaltRule, type HaltState } from "./halt.js";
import { reportPauseFailure, type UndoReport } from "./pending-undo.js";
import { isRecheckRule, RECHECK_DELAY_MS, scheduleRecheck } from "./recheck.js";
import {
  brandClient,
  recordAction,
  safeError,
  type Initiator,
  type NoticeResult,
  type OnceStore,
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
  errors: Array<{ id: string; kind: "campaign" | "ad"; error: string }>;
  /** "skipped": dry run, nothing paused or not asked to notify. */
  telegram: NoticeResult | "skipped" | "failed";
  telegramError?: string;
  /** The rule_actions insert of this run failed (the pause itself stands). */
  auditError?: string;
  /** Activation cards this run closed (live kill switch, cap pause, scheduled pause). */
  closedCardIds: string[];
  /** The open cards could not be listed or closed (all or some); the pause itself stands. */
  cardsError?: string;
  /** The halt a live kill switch, cap pause or scheduled pause left. */
  halt?: HaltState;
  /** The halt could not be stored; the pause itself stands. */
  haltError?: string;
  /** The re-check of a live kill switch or scheduled pause could not be stored (RK9-565). */
  recheckError?: string;
  /** The failed objects of a live halt pause, stored for the pause retry and alerted (RK9-568). */
  retry?: UndoReport;
}

export interface PauseAllDeps {
  ctx: PluginContext;
  ledger: Ledger;
  notifier: SpendGuardNotifier;
  /** The alert markers of the pause retry (RK9-568); without it the retry's next tick sends the alert. */
  store?: OnceStore;
  /** Tests: replaces the brand's Meta client. */
  clientFor?: (companyId: string, config: BrandConfig, mode: "live" | "dryRun", initiator: Initiator) => MetaGraphClient;
  now?: () => Date;
  /** Tests: replaces the running gate's card closer. */
  closeCards?: (companyId: string, input: { rule: CardClosingPause; reason: string }) => Promise<PauseCardClose>;
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
  /** The halt and card close the caller already ran (the kill switch runs them before it loads the config). */
  stopped?: StopActivations;
  /** This run is a re-check (recheck.ts): it stores no re-check of its own. */
  recheck?: boolean;
  /** A re-check's halt id (it sets none of its own), naming its failed objects in the pause retry. */
  haltId?: string | null;
  /**
   * Asked before a job run writes an audit row that has only a halt or card
   * failure to report (nothing paused, no pause error). False skips the row,
   * so a retry every tick does not write one each time (RK9-565). A throw
   * writes it.
   */
  recordStopOnly?: () => Promise<boolean>;
}

/** The halt and the card close of a live run; `announce` edits the closed cards. */
export interface StopActivations {
  stopped: Stopped;
  announce: () => Promise<void>;
}

/**
 * The listing failed, so nothing was paused. Carries the halt and card
 * close that ran before it, so the caller can report them (RK9-561). The
 * message is the listing error's.
 */
export class PauseListError extends Error {
  readonly stopped: Stopped;
  constructor(cause: unknown, stopped: Stopped) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : "Error";
    this.stopped = stopped;
  }
}

/** The pause retry's store or alert failure of a pause (RK9-568), as failure lines for a job run. */
export function retryFailures(prefix: string, result: Pick<PauseAllResult, "errors" | "retry">): string[] {
  if (result.errors.length === 0) return [];
  const last = result.errors.at(-1)!.error;
  return [
    result.retry?.stored
      ? `${prefix}: ${result.errors.length} pause(s) failed (last error: ${last}), moved to the pause retry`
      : `${prefix}: ${result.errors.length} pause(s) failed (last error: ${last})`,
    ...(result.retry?.error ? [`${prefix}: pause retry: ${result.retry.error}`] : []),
  ];
}

/** The halt and card-close failures of a pause, as failure lines for a job run. */
export function stopFailures(prefix: string, stopped: Pick<Stopped, "cardsError" | "haltError">): string[] {
  return [
    ...(stopped.cardsError ? [`${prefix}: open activation cards were not closed (${stopped.cardsError})`] : []),
    ...(stopped.haltError ? [`${prefix}: the halt was not stored (${stopped.haltError})`] : []),
  ];
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
  const tail =
    result.errors.length > 0
      ? [
          `⚠️ ${result.errors.length} pysäytys epäonnistui, katso aktiviteettiloki.` +
            (result.retry?.stored ? " Niitä yritetään uudelleen 5 minuutin välein." : ""),
        ]
      : [];
  // Campaigns first (a restore turns them back on), then ads. Whatever does
  // not fit is counted on its own line, never cut silently; the audit row has
  // every id.
  const lines = [...head];
  if (result.halt) {
    const until = result.halt.until ? new Date(result.halt.until) : null;
    lines.push(
      until
        ? `⛔ Pysäytystila päällä ${localDate(until, config.timeZone)} klo ${localTime(until, config.timeZone)} asti: aktivointikortit eivät aktivoi mitään (board voi poistaa tilan aiemmin).`
        : "⛔ Pysäytystila päällä: aktivointikortit eivät aktivoi mitään, kunnes board poistaa tilan.",
    );
  }
  if (result.haltError) lines.push("⚠️ Pysäytystilan tallennus epäonnistui: avoin kortti voi yhä aktivoida. Tarkista aktiviteettiloki.");
  if (result.closedCardIds.length > 0) lines.push(`Avoimia aktivointikortteja mitätöity: ${result.closedCardIds.length}`);
  if (result.cardsError) lines.push("⚠️ Avoimia aktivointikortteja ei voitu sulkea. Tarkista aktiviteettiloki.");
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

function isHaltRule(rule: PauseRule): rule is HaltRule {
  return (HALT_RULES as readonly string[]).includes(rule);
}

export type Stopped = Pick<PauseAllResult, "closedCardIds" | "cardsError" | "halt" | "haltError">;

/** The cap pause's MTD and cap, from the rules runner's figures, for the halt's early release. */
function capFigures(options: Pick<PauseAllOptions, "rule" | "metrics">): Pick<HaltState, "cap"> {
  const mtdEur = options.metrics?.mtdEur;
  const monthlyCapEur = options.metrics?.monthlyCapEur;
  if (options.rule !== "pause_all_cap" || typeof mtdEur !== "number" || typeof monthlyCapEur !== "number") return {};
  return { cap: { mtdEur, monthlyCapEur } };
}

/** When the rule's halt ends: never for the kill switch. */
export function haltUntil(rule: CardClosingPause, timeZone: string, now: Date): string | undefined {
  if (rule === "scheduled_pause") return nextLocalTime(now, SCHEDULED_HALT_UNTIL, timeZone).toISOString();
  if (rule === "pause_all_cap") return nextLocalMonthStart(now, timeZone).toISOString();
  return undefined;
}

/**
 * The halt and the card row close of a live run, before any Meta call.
 * Never throws. `announce` edits the closed cards; call it after the pauses.
 * It needs no brand config: the kill switch runs it before it loads one
 * (`brandCode` "?" when none could be loaded).
 */
export async function stopActivations(
  deps: Pick<PauseAllDeps, "ctx" | "closeCards">,
  companyId: string,
  brand: { brandCode: string; timeZone: string },
  options: Pick<PauseAllOptions, "dryRun" | "rule" | "reason" | "initiator" | "metrics">,
  now: Date,
): Promise<StopActivations> {
  const out: Stopped = { closedCardIds: [] };
  let announce: () => Promise<void> = async () => undefined;
  if (options.dryRun || !closesCards(options.rule)) return { stopped: out, announce };
  const until = haltUntil(options.rule, brand.timeZone, now);
  const halt: HaltState = {
    brandCode: brand.brandCode,
    rule: options.rule,
    id: randomUUID(),
    since: now.toISOString(),
    ...(until ? { until } : {}),
    reason: options.reason.slice(0, 300),
    initiator: options.initiator,
    ...capFigures(options),
  };
  try {
    await setHalt(deps.ctx, companyId, halt);
    out.halt = halt;
  } catch (error) {
    out.haltError = safeError(error);
    deps.ctx.logger.error("rk9-ads pause: the halt was not stored", { companyId, rule: options.rule, detail: out.haltError });
  }
  const close = deps.closeCards ?? getActivationCards()?.closeCardsForPause;
  if (!close) {
    out.cardsError = "the activation gate is not running; open cards were not closed";
  } else {
    try {
      const closed = await close(companyId, { rule: options.rule, reason: options.reason });
      out.closedCardIds = closed.ids;
      if (closed.error) out.cardsError = closed.error;
      announce = async () => {
        try {
          await closed.announce();
        } catch (error) {
          deps.ctx.logger.warn("rk9-ads pause: closed activation cards not edited", { companyId, detail: safeError(error) });
        }
      };
    } catch (error) {
      out.cardsError = safeError(error);
    }
  }
  if (out.cardsError) deps.ctx.logger.error("rk9-ads pause: open activation cards not closed", { companyId, rule: options.rule, detail: out.cardsError });
  return { stopped: out, announce };
}

async function stopOnlyRowWanted(options: PauseAllOptions): Promise<boolean> {
  if (!options.recordStopOnly) return true;
  try {
    return await options.recordStopOnly();
  } catch {
    return true;
  }
}

/** Stores the re-check of a live kill switch or scheduled pause. Returns the error text when it could not. */
async function storeRecheck(deps: Pick<PauseAllDeps, "ctx">, companyId: string, options: PauseAllOptions, stopped: Stopped, now: Date): Promise<string | undefined> {
  if (!isRecheckRule(options.rule)) return undefined;
  try {
    await scheduleRecheck(deps.ctx, companyId, {
      rule: options.rule,
      haltId: stopped.halt ? haltIdentity(stopped.halt) : null,
      dueAt: new Date(now.getTime() + RECHECK_DELAY_MS).toISOString(),
      reason: options.reason.slice(0, 300),
    });
    return undefined;
  } catch (error) {
    const detail = safeError(error);
    deps.ctx.logger.error("rk9-ads pause: the re-check was not stored", { companyId, rule: options.rule, detail });
    return detail;
  }
}

export async function pauseAll(
  deps: PauseAllDeps,
  companyId: string,
  config: BrandConfig,
  options: PauseAllOptions,
): Promise<PauseAllResult> {
  const now = deps.now?.() ?? new Date();
  const mode = options.dryRun ? "dryRun" : "live";
  const { stopped, announce } = options.stopped ?? (await stopActivations(deps, companyId, config, options, now));
  // A halt was set or tried: a pause that reused a halt the board cleared re-checks nothing.
  const recheckError =
    !options.dryRun && !options.recheck && isRecheckRule(options.rule) && (stopped.halt || stopped.haltError)
      ? await storeRecheck(deps, companyId, options, stopped, now)
      : undefined;
  const stopErrors = [
    ...(stopped.haltError ? [`halt: ${stopped.haltError}`] : []),
    ...(stopped.cardsError ? [`cards: ${stopped.cardsError}`] : []),
    ...(recheckError ? [`re-check: ${recheckError}`] : []),
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
    await announce();
    throw new PauseListError(error, stopped);
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
    ...(recheckError ? { recheckError } : {}),
  };

  for (const [kind, objects] of [["campaign", targets.campaigns], ["ad", targets.ads]] as const) {
    for (const object of objects) {
      try {
        const written = await setObjectStatus(client, object.id, "PAUSED");
        if (!isDryRun(written) && !written.success) throw new Error(`Meta did not confirm status PAUSED on ${object.id}`);
        const paused = { id: object.id, name: object.name };
        (kind === "ad" ? result.pausedAds : result.pausedCampaigns).push(paused);
        result.list.push(`${kind === "ad" ? "mainos" : "kampanja"} ${label(paused)}`);
      } catch (error) {
        result.errors.push({ id: object.id, kind, error: safeError(error) });
      }
    }
  }
  result.campaignPaused = result.pausedCampaigns.length > 0;
  result.count = result.pausedAds.length + result.pausedCampaigns.length;
  await announce();

  // An object a halt pause could not pause must not stay ACTIVE unnoticed (RK9-568).
  if (!options.dryRun && isHaltRule(options.rule) && result.errors.length > 0) {
    const haltId = options.haltId ?? (stopped.halt ? haltIdentity(stopped.halt) : null);
    result.retry = await reportPauseFailure(
      deps,
      companyId,
      config,
      {
        rule: options.rule,
        ref: `${options.rule}:${haltId ?? `no-halt-${now.toISOString()}`}`,
        failed: result.errors.map((entry) => ({ kind: entry.kind, objectId: entry.id, error: entry.error })),
      },
      now,
    );
  }

  if (!options.dryRun && options.notify && result.count > 0) {
    try {
      result.telegram = await deps.notifier.sendMessage(companyId, config, pauseNoticeText(config, result, now, options));
    } catch (error) {
      result.telegram = "failed";
      result.telegramError = safeError(error);
    }
  }

  // A live pause a rerun has nothing left to fix: every target paused or handed
  // to the pause retry, the halt stored and the cards closed. The rule engine's
  // cooldown counts such a row although a Telegram failure fills `error`
  // (rules/store.ts priorActions, RK9-541).
  const settled =
    !options.dryRun &&
    result.count + result.errors.length > 0 &&
    (result.errors.length === 0 || result.retry?.stored === true) &&
    stopErrors.length === 0;
  const stopRecorded = result.closedCardIds.length > 0 || result.halt !== undefined || stopErrors.length > 0;
  const stopOnly = result.count === 0 && result.errors.length === 0 && options.initiator.source === "job";
  if (result.count > 0 || result.errors.length > 0 || (stopRecorded && (!stopOnly || (await stopOnlyRowWanted(options)))) || options.initiator.source !== "job") {
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
        ...(result.retry ? { retry: { stored: result.retry.stored, telegram: result.retry.telegram } } : {}),
        closedCardIds: result.closedCardIds,
        halt: result.halt !== undefined,
        settled,
        ...(options.note ? { note: options.note } : {}),
      },
      initiator: options.initiator,
      error: [
        ...result.errors.map((entry) => `${entry.id}: ${entry.error}`),
        ...(result.telegramError ? [`telegram: ${result.telegramError}`] : []),
        ...(result.retry?.error ? [`pause retry: ${result.retry.error}`] : []),
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
