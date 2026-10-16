/**
 * Spend guard (A6, RK9-511): the money-critical check before any Meta write
 * that can raise spend.
 *
 * Every check re-reads the ad account (spend_cap, amount_spent, currency),
 * the insights spend of the current local calendar month, today's spend per
 * ad set and every campaign and ad set budget. Nothing is cached. Any read
 * error or timeout refuses.
 *
 * Rules, in order (each refusal has a machine-readable reason):
 * 1. currency_not_eur: the account currency is not EUR.
 * 2. no_spend_cap: Meta's account spend_cap is missing or 0.
 * 3. spend_cap_reached: the headroom Meta still allows (spend_cap -
 *    amount_spent) is 0 or less. Meta would not deliver, so an activation
 *    would "succeed" without spending (RK9-523).
 * 4. spend_cap_headroom_exceeds_remaining: the headroom is above what is left
 *    of the monthly cap (monthlyCapEur - MTD). Meta's own cap is then not a
 *    backstop for ours (G2: the cap resets on the 1st, so headroom replaces
 *    "spend_cap > cap").
 * 5. projection_exceeds_cap: the projected month-end spend is above
 *    monthlyCapEur.
 *
 * Projection = MTD + (daily budgets - today's covered spend) + daily budgets
 * x the remaining local days after today + lifetime budgets. Today counts
 * once (G3, RK9-523): what is already spent today is in MTD, and each counted
 * daily-budget object adds only what its budget still allows today, i.e.
 * budget - min(budget, its own spend today). Spend today of an object that
 * no longer counts (paused, cut or archived earlier today) is never credited
 * to another one. A provisioned budget on pace thus passes its own guard in
 * 28-, 30- and 31-day months. The projection is conservative (G3 and the
 * epic's risk list):
 * - every campaign and ad set whose configured status is ACTIVE counts, also
 *   an ad set under a paused campaign (it runs as soon as the campaign does);
 * - an object with no spend today yet (or spend not yet in insights) counts
 *   its full daily budget for today, which covers the insights lag of today;
 * - a lifetime budget counts in full, once.
 * Meta may deliver up to 75 % above a daily budget on a single day (its
 * weekly total stays within 7 daily budgets); the projection uses the budget
 * itself for the days ahead and adds no overdelivery margin.
 *
 * Insights lag: Meta can report the spend of earlier days hours late, so MTD
 * may read a little low. The guard adds no margin for that. The backstop is
 * Meta's spend_cap, which bills in real time: preflight keeps it at or below
 * the monthly cap (G2) and rule 4 refuses when its headroom is above the rest
 * of the month.
 */

import type { BrandConfig } from "../../config.js";
import { localMonthBounds } from "../../kit/local-time.js";
import type { GuardDecision, MetaGraphClient, WritePlan } from "../../meta/graph.js";
import { pausedOnlyWrites } from "../../meta/graph.js";
import {
  adAccountPath,
  getAccountSpendCents,
  getAccountSummary,
  getAdsetSpendForDay,
  getAdOwner,
  listBudgets,
  parseMinorUnits,
} from "../../meta/methods.js";
import { redactText } from "../../meta/redact.js";
import type { AdsetDaySpend, BudgetObject } from "../../meta/types.js";
import { capCents, monthPosition } from "./position.js";

export { capCents };

export const GUARD_DENY_REASONS = [
  "currency_not_eur",
  "no_spend_cap",
  "spend_cap_reached",
  "spend_cap_headroom_exceeds_remaining",
  "projection_exceeds_cap",
  "meta_read_failed",
  "meta_read_timeout",
  "object_not_in_account",
  "account_timezone_mismatch",
  "unsupported_write",
  "gate_required",
] as const;
export type GuardDenyReason = (typeof GUARD_DENY_REASONS)[number];
export type GuardReason = "ok" | "not_spend_raising" | GuardDenyReason;

/**
 * Standing risks the scheduled watch alerts on (RK9-523), independent of the
 * rule order: Meta's cap is no backstop, or the current budgets overrun the
 * monthly cap. Empty when the figures were not read or the currency is not EUR.
 */
export const SPEND_RISKS = ["no_spend_cap", "spend_cap_headroom_exceeds_remaining", "projection_exceeds_cap"] as const;
export type SpendRisk = (typeof SPEND_RISKS)[number];

/** One Meta read phase may take this long before the guard refuses. */
export const GUARD_READ_TIMEOUT_MS = 60_000;
const SPEND_CURRENCY = "EUR";
const LIST_MAX_PAGES = 100;

/** The spend numbers the guard decided on. Money in EUR; null when it was not read. */
export interface SpendFigures {
  /** Local calendar month, "YYYY-MM". */
  month: string;
  remainingDays: number;
  monthlyCapEur: number;
  currency: string | null;
  accountTimeZone: string | null;
  spendCapEur: number | null;
  amountSpentEur: number | null;
  /** spend_cap - amount_spent. */
  headroomEur: number | null;
  mtdEur: number | null;
  /** What is left of the monthly cap: monthlyCapEur - MTD. */
  remainingEur: number | null;
  /** Today's spend credited to the counted daily budgets, each at most its own budget. */
  todayCoveredEur: number | null;
  /** Sum of the counted daily budgets after the proposed change. */
  dailyBudgetSumEur: number | null;
  /** Lifetime budgets counted in full. */
  lifetimeCommitEur: number | null;
  projectedMonthEndEur: number | null;
  /** MTD as a share of the monthly cap, 0-100+ with one decimal. */
  pctUsed: number | null;
  /** The standing risks on these figures (see SPEND_RISKS). */
  risks: SpendRisk[];
}

export interface GuardResult extends SpendFigures {
  allow: boolean;
  reason: GuardReason;
  /** Short human text for logs and cards. No token, no URL. */
  detail: string;
}

/** What a write proposes, in budget terms. */
export interface ProposedChange {
  /** The object the write changes; null for a create. */
  objectId: string | null;
  /** Known for creates; resolved from the account listing for an object id. */
  level: "campaign" | "adset" | "ad" | null;
  /** The write sets status ACTIVE (or creates an object that will run). */
  activate: boolean;
  /** New daily budget in cents when the write sets one; null clears it. */
  dailyBudgetCents?: number | null;
  /** New lifetime budget in cents when the write sets one. */
  lifetimeBudgetCents?: number | null;
}

/** The raw inputs of a guard decision, in cents. */
export interface GuardNumbers {
  monthlyCapEur: number;
  currency: string;
  accountTimeZone: string | null;
  spendCapCents: number | null;
  amountSpentCents: number;
  mtdCents: number;
  /**
   * Today's spend of the counted daily-budget objects, each at most its own
   * budget (projectBudgets). Part of mtdCents.
   */
  todayCoveredCents: number;
  dailySumCents: number;
  lifetimeCommitCents: number;
  month: string;
  remainingDays: number;
}

const eur = (cents: number): number => Math.round(cents) / 100;

/**
 * Month-end projection in cents: MTD, then what the counted daily budgets
 * still allow today, then the remaining days after today, then lifetime
 * budgets once.
 */
export function projectMonthEndCents(numbers: Pick<GuardNumbers, "mtdCents" | "todayCoveredCents" | "dailySumCents" | "lifetimeCommitCents" | "remainingDays">): number {
  const covered = Math.min(Math.max(numbers.todayCoveredCents, 0), numbers.mtdCents, numbers.dailySumCents);
  const todayLeft = numbers.dailySumCents - covered;
  const laterDays = Math.max(0, numbers.remainingDays - 1);
  return numbers.mtdCents + todayLeft + numbers.dailySumCents * laterDays + numbers.lifetimeCommitCents;
}

/** The pure decision on numbers that were read successfully. */
export function evaluateGuard(numbers: GuardNumbers): GuardResult {
  // MTD, headroom and what is left of the cap: the computation the digest shares (RK9-526).
  const position = monthPosition(numbers);
  const cap = position.capCents;
  const projected = projectMonthEndCents(numbers);
  const headroom = position.headroomCents;
  const remaining = position.remainingCents;
  const risks: SpendRisk[] = [];
  if (numbers.currency === SPEND_CURRENCY) {
    if (headroom === null) risks.push("no_spend_cap");
    // Headroom 0 or less: Meta delivers nothing more, so nothing can overrun.
    else if (position.headroomExceedsRemaining) risks.push("spend_cap_headroom_exceeds_remaining");
    // With the headroom used up Meta delivers nothing more: no overrun to warn about.
    if (projected > cap && !(headroom !== null && headroom <= 0)) risks.push("projection_exceeds_cap");
  }
  const figures: SpendFigures = {
    month: numbers.month,
    remainingDays: numbers.remainingDays,
    monthlyCapEur: numbers.monthlyCapEur,
    currency: numbers.currency,
    accountTimeZone: numbers.accountTimeZone,
    spendCapEur: numbers.spendCapCents === null ? null : eur(numbers.spendCapCents),
    amountSpentEur: eur(numbers.amountSpentCents),
    headroomEur: headroom === null ? null : eur(headroom),
    mtdEur: eur(numbers.mtdCents),
    remainingEur: eur(remaining),
    todayCoveredEur: eur(numbers.todayCoveredCents),
    dailyBudgetSumEur: eur(numbers.dailySumCents),
    lifetimeCommitEur: eur(numbers.lifetimeCommitCents),
    projectedMonthEndEur: eur(projected),
    pctUsed: position.pctUsed,
    risks,
  };
  const deny = (reason: GuardDenyReason, detail: string): GuardResult => ({ ...figures, allow: false, reason, detail });

  if (numbers.currency !== SPEND_CURRENCY) {
    return deny("currency_not_eur", `account currency is ${numbers.currency}, the guard only handles ${SPEND_CURRENCY}`);
  }
  if (numbers.spendCapCents === null || headroom === null) {
    return deny("no_spend_cap", "the ad account has no spend_cap; set one in Meta Billing before any spend");
  }
  if (headroom <= 0) {
    return deny(
      "spend_cap_reached",
      `Meta's spend_cap is used up (spend_cap - amount_spent = ${eur(headroom)} EUR), so Meta would not deliver; the operator raises or resets it in Meta Billing`,
    );
  }
  if (headroom > remaining) {
    return deny(
      "spend_cap_headroom_exceeds_remaining",
      `Meta allows ${eur(headroom)} EUR more (spend_cap - amount_spent) but only ${eur(remaining)} EUR of the monthly cap is left`,
    );
  }
  if (projected > cap) {
    return deny(
      "projection_exceeds_cap",
      `projected month-end ${eur(projected)} EUR is above the monthly cap ${numbers.monthlyCapEur} EUR`,
    );
  }
  return { ...figures, allow: true, reason: "ok", detail: `projected month-end ${eur(projected)} EUR within ${numbers.monthlyCapEur} EUR` };
}

/**
 * Daily and lifetime totals of the counted objects, with `change` applied.
 * Counted: configured status ACTIVE, or the object the change activates.
 *
 * `todayCoveredCents` is the spend today of the counted daily-budget objects,
 * each at most its own daily budget: an ad set's own rows; a campaign
 * (campaign budget) the rows of its ad sets that are not counted with a
 * budget of their own. No row is credited twice, and a row of an object that
 * does not count is never credited.
 */
export function projectBudgets(
  budgets: { campaigns: BudgetObject[]; adsets: BudgetObject[] },
  change: ProposedChange | null,
  todaySpend: readonly AdsetDaySpend[] = [],
): { dailySumCents: number; lifetimeCommitCents: number; todayCoveredCents: number } {
  let dailySumCents = 0;
  let lifetimeCommitCents = 0;
  const countedDaily: Array<{ object: BudgetObject; daily: number }> = [];
  for (const object of [...budgets.campaigns, ...budgets.adsets]) {
    const changed = change !== null && change.objectId === object.id;
    const active = object.status === "ACTIVE" || (changed && change.activate);
    if (!active) continue;
    const daily = changed && change.dailyBudgetCents !== undefined ? change.dailyBudgetCents : object.dailyBudgetCents;
    const lifetime = changed && change.lifetimeBudgetCents !== undefined ? change.lifetimeBudgetCents : object.lifetimeBudgetCents;
    dailySumCents += daily ?? 0;
    lifetimeCommitCents += lifetime ?? 0;
    if (daily) countedDaily.push({ object, daily });
  }
  // A create of a campaign or ad set that will run adds its own budget.
  if (change && change.objectId === null && change.activate && (change.level === "campaign" || change.level === "adset")) {
    dailySumCents += change.dailyBudgetCents ?? 0;
    lifetimeCommitCents += change.lifetimeBudgetCents ?? 0;
  }

  const budgetAdsets = new Set(countedDaily.filter((entry) => entry.object.level === "adset").map((entry) => entry.object.id));
  let todayCoveredCents = 0;
  for (const { object, daily } of countedDaily) {
    let spent = 0;
    for (const row of todaySpend) {
      const own =
        object.level === "adset"
          ? row.adsetId === object.id
          : row.campaignId === object.id && !(row.adsetId !== null && budgetAdsets.has(row.adsetId));
      if (own) spent += row.cents;
    }
    todayCoveredCents += Math.min(daily, spent);
  }
  return { dailySumCents, lifetimeCommitCents, todayCoveredCents };
}

class GuardTimeoutError extends Error {
  constructor() {
    super(`Meta reads did not finish within ${GUARD_READ_TIMEOUT_MS / 1000} s`);
    this.name = "GuardTimeoutError";
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GuardTimeoutError()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyFigures(config: BrandConfig, now: Date): SpendFigures {
  const bounds = localMonthBounds(now, config.timeZone);
  return {
    month: bounds.month,
    remainingDays: bounds.remainingDays,
    monthlyCapEur: config.monthlyCapEur,
    currency: null,
    accountTimeZone: null,
    spendCapEur: null,
    amountSpentEur: null,
    headroomEur: null,
    mtdEur: null,
    remainingEur: null,
    todayCoveredEur: null,
    dailyBudgetSumEur: null,
    lifetimeCommitEur: null,
    projectedMonthEndEur: null,
    pctUsed: null,
    risks: [],
  };
}

function readFailure(config: BrandConfig, now: Date, error: unknown): GuardResult {
  const timedOut = error instanceof GuardTimeoutError;
  const detail = error instanceof Error ? `${error.name}: ${redactText(error.message)}` : "unknown error";
  return {
    ...emptyFigures(config, now),
    allow: false,
    reason: timedOut ? "meta_read_timeout" : "meta_read_failed",
    detail: detail.slice(0, 300),
  };
}

export interface GuardCheckInput {
  config: BrandConfig;
  /** Any client of the brand; the guard only reads with it. */
  client: MetaGraphClient;
  now?: Date;
  /** The write being checked; null for a plain snapshot. */
  change?: ProposedChange | null;
  timeoutMs?: number;
}

/**
 * guard.check: re-reads Meta and decides. A non-activating write that does
 * not raise any budget is allowed once the reads succeed (`not_spend_raising`),
 * so the cap never blocks a budget cut. (The hook still asks `authorizeSpend`
 * first, and its default refuses every budget write.)
 *
 * MTD uses local month bounds in `config.timeZone`, and Meta reads the
 * insights time_range in the account's time zone. When the two differ, MTD
 * would be off by hours of spend, so the guard refuses.
 */
export async function checkSpend(input: GuardCheckInput): Promise<GuardResult> {
  const { config, client } = input;
  const now = input.now ?? new Date();
  // A copy: the level is filled in from the account listing.
  const change = input.change ? { ...input.change } : null;
  const bounds = localMonthBounds(now, config.timeZone);
  const account = adAccountPath(config.meta.adAccountId);

  let numbers: GuardNumbers;
  let raisesSpend = true;
  try {
    numbers = await withTimeout(
      (async () => {
        const summary = await getAccountSummary(client, account);
        if (summary.timezone !== config.timeZone) throw new TimezoneMismatchError(summary.timezone, config.timeZone);
        // Today per ad set first, then MTD: spend only grows, so MTD read later
        // holds at least the spend credited from the earlier read.
        const todaySpend = await getAdsetSpendForDay(client, account, bounds.until);
        const mtdCents = await getAccountSpendCents(client, account, { since: bounds.since, until: bounds.until });
        const budgets = await listBudgets(client, account, { maxPages: LIST_MAX_PAGES });
        if (change?.objectId) {
          const known = [...budgets.campaigns, ...budgets.adsets].find((object) => object.id === change.objectId);
          if (known) {
            change.level = known.level;
          } else {
            // Not a listed campaign or ad set of this account. Only an ad of it
            // passes: an unlisted (e.g. archived) campaign or ad set would
            // carry a budget the projection does not count. getAdOwner fails
            // on anything but an ad.
            if (change.dailyBudgetCents !== undefined || change.lifetimeBudgetCents !== undefined) {
              throw new UnsupportedWriteError("a budget can only be set on a listed campaign or ad set");
            }
            const owner = await getAdOwner(client, change.objectId);
            if (`act_${owner.accountId}` !== account) throw new ObjectNotInAccountError(change.objectId);
            change.level = "ad";
          }
        }
        const before = projectBudgets(budgets, null);
        const after = projectBudgets(budgets, change, todaySpend);
        if (change && !change.activate) {
          raisesSpend = after.dailySumCents > before.dailySumCents || after.lifetimeCommitCents > before.lifetimeCommitCents;
        }
        return {
          monthlyCapEur: config.monthlyCapEur,
          currency: summary.currency,
          accountTimeZone: summary.timezone,
          spendCapCents: summary.spendCapCents,
          amountSpentCents: summary.amountSpentCents,
          mtdCents,
          todayCoveredCents: after.todayCoveredCents,
          dailySumCents: after.dailySumCents,
          lifetimeCommitCents: after.lifetimeCommitCents,
          month: bounds.month,
          remainingDays: bounds.remainingDays,
        };
      })(),
      input.timeoutMs ?? GUARD_READ_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ObjectNotInAccountError) {
      return { ...emptyFigures(config, now), allow: false, reason: "object_not_in_account", detail: error.message };
    }
    if (error instanceof UnsupportedWriteError) {
      return { ...emptyFigures(config, now), allow: false, reason: "unsupported_write", detail: error.message };
    }
    if (error instanceof TimezoneMismatchError) {
      return { ...emptyFigures(config, now), allow: false, reason: "account_timezone_mismatch", detail: error.message };
    }
    return readFailure(config, now, error);
  }

  const result = evaluateGuard(numbers);
  if (!raisesSpend) return { ...result, allow: true, reason: "not_spend_raising", detail: "the write lowers or keeps every budget" };
  return result;
}

class ObjectNotInAccountError extends Error {
  constructor(objectId: string) {
    super(`object ${objectId} does not belong to the brand's ad account`);
    this.name = "ObjectNotInAccountError";
  }
}

class TimezoneMismatchError extends Error {
  constructor(accountTimeZone: string, configTimeZone: string) {
    super(`the ad account reports in ${accountTimeZone} but the brand's month is ${configTimeZone}`);
    this.name = "TimezoneMismatchError";
  }
}

class UnsupportedWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedWriteError";
  }
}

// ---------------------------------------------------------------------------
// guardedWrite: the one hook every spend-raising write passes
// ---------------------------------------------------------------------------

const CREATE_EDGE_RE = /^act_(\d+)\/(campaigns|adsets|ads)$/;
const NODE_RE = /^\d+$/;
const NODE_WRITE_KEYS = new Set(["name", "status", "daily_budget", "lifetime_budget"]);
const CREATE_LEVEL = { campaigns: "campaign", adsets: "adset", ads: "ad" } as const;
/**
 * Budget fields the projection does not model, e.g. `budget_schedule_specs`
 * (scheduled budget increases) or `adset_budgets`. Refused on every write,
 * also on a PAUSED create, which the default hook would let through.
 */
const PLAIN_BUDGET_KEYS = new Set(["daily_budget", "lifetime_budget"]);
export function unmodelledBudgetKeys(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((key) => fields[key] !== undefined && /budget/i.test(key) && !PLAIN_BUDGET_KEYS.has(key));
}

function budgetField(fields: Record<string, unknown>, key: string): number | null | undefined {
  if (!Object.hasOwn(fields, key) || fields[key] === undefined) return undefined;
  if (fields[key] === null || fields[key] === "" || fields[key] === "0" || fields[key] === 0) return null;
  return parseMinorUnits(fields[key], key);
}

/**
 * Turns a write the default hook refused into a budget change, or says why
 * it is not a write the guard understands. Exported for tests.
 */
export function classifySpendWrite(
  plan: WritePlan,
  account: string,
): { ok: true; change: ProposedChange } | { ok: false; reason: string } {
  if (plan.method !== "POST") return { ok: false, reason: "only POST writes can raise spend" };
  const fields = plan.fields;
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  const status = Object.hasOwn(fields, "status") ? fields.status : undefined;
  if (status !== undefined && status !== "ACTIVE" && status !== "PAUSED") {
    return { ok: false, reason: "status must be ACTIVE or PAUSED" };
  }
  let daily: number | null | undefined;
  let lifetime: number | null | undefined;
  try {
    daily = budgetField(fields, "daily_budget");
    lifetime = budgetField(fields, "lifetime_budget");
  } catch {
    return { ok: false, reason: "daily_budget and lifetime_budget must be whole minor units" };
  }

  const create = CREATE_EDGE_RE.exec(plan.path);
  if (create) {
    if (`act_${create[1]}` !== account) return { ok: false, reason: "the write targets another ad account" };
    if (keys.some((key) => (key !== "status" && /status/i.test(key)) || /^(adset|campaign)_spec$/i.test(key))) {
      return { ok: false, reason: "a create may carry only the plain status field, and no inline campaign or ad set spec" };
    }
    const level = CREATE_LEVEL[create[2] as keyof typeof CREATE_LEVEL];
    if (level === "ad" && (daily !== undefined || lifetime !== undefined)) {
      return { ok: false, reason: "an ad has no budget" };
    }
    // Meta creates an ad ACTIVE when status is left out.
    return {
      ok: true,
      change: {
        objectId: null,
        level,
        activate: status !== "PAUSED",
        ...(daily !== undefined ? { dailyBudgetCents: daily } : {}),
        ...(lifetime !== undefined ? { lifetimeBudgetCents: lifetime } : {}),
      },
    };
  }

  if (NODE_RE.test(plan.path)) {
    const unknown = keys.filter((key) => !NODE_WRITE_KEYS.has(key));
    if (unknown.length > 0) return { ok: false, reason: `the spend guard does not handle the fields ${unknown.join(", ")}` };
    return {
      ok: true,
      change: {
        objectId: plan.path,
        level: null,
        activate: status === "ACTIVE",
        ...(daily !== undefined ? { dailyBudgetCents: daily } : {}),
        ...(lifetime !== undefined ? { lifetimeBudgetCents: lifetime } : {}),
      },
    };
  }
  return { ok: false, reason: "this edge is not on the write allowlist" };
}

export interface SpendGuardHookOptions {
  config: BrandConfig;
  /** Read client of the same brand; read-only mode is enough. */
  readClient: MetaGraphClient;
  /**
   * Who may raise spend at all (G1: activation only from a Telegram tap). It
   * runs before the Meta reads. The default refuses every spend-raising write.
   */
  authorizeSpend?: (plan: WritePlan, change: ProposedChange) => GuardDecision | Promise<GuardDecision>;
  /**
   * Called with every decision on a write the default hook refused: each
   * refusal (record it) and each allowed spend-raising write.
   */
  onDecision?: (result: GuardResult, plan: WritePlan) => Promise<void>;
  now?: () => Date;
}

/**
 * The `guardedWrite` hook of a brand's Meta client. Pauses, renames, media
 * and PAUSED creates pass as with the default hook. Every other write must be
 * a status or budget write the guard understands, authorized by
 * `authorizeSpend`, and allowed by `checkSpend` on fresh Meta reads.
 */
export function createSpendGuardHook(options: SpendGuardHookOptions) {
  const account = adAccountPath(options.config.meta.adAccountId);
  const authorize =
    options.authorizeSpend ?? (() => ({ allow: false, reason: "spend-raising writes need the activation gate (G1)" }));
  return async (plan: WritePlan): Promise<GuardDecision> => {
    const now = options.now?.() ?? new Date();
    const refuse = async (reason: GuardDenyReason, detail: string): Promise<GuardDecision> => {
      const result: GuardResult = { ...emptyFigures(options.config, now), allow: false, reason, detail: redactText(detail).slice(0, 300) };
      if (options.onDecision) await options.onDecision(result, plan);
      return { allow: false, reason: `spend_guard:${reason}: ${result.detail}` };
    };
    const unmodelled = unmodelledBudgetKeys(plan.fields);
    if (unmodelled.length > 0) return refuse("unsupported_write", `the spend guard does not model the fields ${unmodelled.join(", ")}`);
    const base = pausedOnlyWrites(plan);
    if (base.allow) return base;
    const classified = classifySpendWrite(plan, account);
    if (!classified.ok) return refuse("unsupported_write", classified.reason);
    const authorized = await authorize(plan, classified.change);
    if (!authorized.allow) return refuse("gate_required", authorized.reason);
    const result = await checkSpend({ config: options.config, client: options.readClient, now, change: classified.change });
    if (options.onDecision) await options.onDecision(result, plan);
    return result.allow ? { allow: true } : { allow: false, reason: `spend_guard:${result.reason}: ${result.detail}` };
  };
}
