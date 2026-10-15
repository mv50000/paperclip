/**
 * Meta Marketing API shapes the client returns (RK9-508). Money is integer
 * minor units (cents) parsed from Graph's strings, never floats.
 */

/** Graph `account_status`, mapped to names. Unknown numbers become UNKNOWN. */
export type AdAccountStatus =
  | "ACTIVE"
  | "DISABLED"
  | "UNSETTLED"
  | "PENDING_RISK_REVIEW"
  | "PENDING_SETTLEMENT"
  | "IN_GRACE_PERIOD"
  | "PENDING_CLOSURE"
  | "CLOSED"
  | "ANY_ACTIVE"
  | "ANY_CLOSED"
  | "UNKNOWN";

export const AD_ACCOUNT_STATUS_BY_CODE: Readonly<Record<number, AdAccountStatus>> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

export interface AccountSummary {
  /** Ad account id without the act_ prefix. */
  accountId: string;
  /** ISO 4217 code, e.g. EUR. */
  currency: string;
  /** IANA zone from `timezone_name`, e.g. Europe/Helsinki. */
  timezone: string;
  /** Account spending limit in minor units; null when none is set (Graph "0" or absent). */
  spendCapCents: number | null;
  /**
   * `amount_spent` in minor units: spend counted against spend_cap since the
   * cap was last reset, or lifetime spend when no cap is set. Not a calendar
   * month-to-date figure; the spend guard uses insights for that (G2).
   */
  amountSpentCents: number;
  status: AdAccountStatus;
  /** The raw `account_status` number, for diagnostics. */
  statusCode: number | null;
}

/** Configured status of a campaign, ad set or ad. */
export type ObjectStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

/** A status a write may set. Activation is the gate's call (G1), not the caller's. */
export type WritableStatus = "ACTIVE" | "PAUSED";

export interface StatusRow {
  id: string;
  name: string;
  /** What the object is set to. */
  status: string;
  /** What Meta actually runs, after parents, review and billing (e.g. CAMPAIGN_PAUSED, PENDING_REVIEW). */
  effectiveStatus: string;
}

export type Campaign = StatusRow;

export interface AdSet extends StatusRow {
  campaignId: string | null;
}

export interface Ad extends StatusRow {
  adsetId: string | null;
  campaignId: string | null;
  creativeId: string | null;
}

/**
 * A campaign or ad set with its budget, for the spend guard's projection.
 * Budgets are minor units; null when the object has no budget of that kind
 * (Graph "0" or absent: an ad set under a campaign budget has none).
 */
export interface BudgetObject extends StatusRow {
  level: "campaign" | "adset";
  /** The parent campaign of an ad set; null for a campaign. */
  campaignId: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
}

export type InsightsLevel = "account" | "campaign" | "adset" | "ad";

/** One insights row as Graph returns it: numbers stay strings, the caller parses. */
export type InsightsRow = Record<string, unknown> & {
  date_start?: string;
  date_stop?: string;
};

export type VideoStatus = "ready" | "processing" | "error" | string;

export interface VideoThumbnail {
  id: string;
  uri: string;
  isPreferred: boolean;
  width: number | null;
  height: number | null;
}

/** What a write returns in dry-run mode instead of a Graph response. */
export interface DryRunResult {
  dryRun: true;
  planned: {
    method: "POST" | "DELETE";
    path: string;
    fields: Record<string, unknown>;
  };
}

export type WriteResult<T> = T | DryRunResult;

export function isDryRun(value: unknown): value is DryRunResult {
  return typeof value === "object" && value !== null && (value as { dryRun?: unknown }).dryRun === true;
}
