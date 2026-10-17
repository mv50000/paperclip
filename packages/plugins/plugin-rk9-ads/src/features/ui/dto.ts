/**
 * Shapes the operator UI reads (A12, RK9-518). Types only: the UI bundle
 * imports them with `import type`, so no worker code reaches the browser.
 *
 * Every DTO is an allowlist: the worker copies named fields into these
 * shapes, never a raw config, a secret_ref or a resolved secret.
 */

/** The brand config of the company, as the UI sees it. `error`: no company context. */
export type UiConfigState = "absent" | "invalid" | "disabled" | "enabled" | "unavailable" | "error";

export interface UiBrand {
  brandCode: string;
  displayName: string;
  timeZone: string;
  /** null while the brand is disabled (monthlyCapEur not set). */
  monthlyCapEur: number | null;
}

/** The halt in force (RK9-557, RK9-561): which pause, when, until when, who and why. */
export interface UiHalt {
  rule: string;
  since: string;
  /** The end of a timed halt (scheduled pause, cap pause); null for the kill switch's. */
  until: string | null;
  reason: string;
  source: string;
  userId: string | null;
  agentId: string | null;
  tgUserId: number | null;
}

/** An activation undo Meta refused after a halt; retried while a halt is in force (RK9-565). */
export interface UiPendingUndo {
  kind: string;
  objectId: string;
  gateRequestId: string;
  since: string;
}

export type UiSpendCapStatus = "set" | "missing" | "above_cap" | "unknown";

export interface UiSpend {
  month: string;
  mtdEur: number | null;
  monthlyCapEur: number;
  pctUsed: number | null;
  projectedMonthEndEur: number | null;
  dailyBudgetSumEur: number | null;
  remainingDays: number;
  spendCapEur: number | null;
  /** Meta's account spend_cap against the plugin cap: missing, set, or higher than the cap. */
  spendCapStatus: UiSpendCapStatus;
  /** The spend guard would allow a spend-raising write now. */
  allow: boolean;
  reason: string;
  detail: string;
  risks: string[];
}

export interface UiPublication {
  id: string;
  adName: string | null;
  status: string;
  mode: string;
  metaAdId: string | null;
  /** Meta's status of the ad (ACTIVE, PAUSED); null when not read. */
  adStatus: string | null;
  adEffectiveStatus: string | null;
  publishedAt: string | null;
  createdAt: string | null;
  error: string | null;
  /** The last 14 local days. */
  spendEur: number;
  impressions: number;
  linkClicks: number;
  ctrPct: number | null;
  cpcEur: number | null;
  fatigue: string | null;
  fatigueReasons: string[];
}

export interface UiGateCard {
  id: string;
  kind: string;
  adId: string | null;
  publicationId: string | null;
  validUntil: string;
}

export interface UiRuleAction {
  ruleId: string;
  ruleType: string;
  action: string;
  objectType: string;
  objectId: string;
  mode: string;
  applied: boolean;
  decidedAt: string;
}

export interface UiSpendDay {
  date: string;
  spendEur: number;
  impressions: number;
  linkClicks: number;
  cpcEur: number | null;
}

/** Data key `ads-overview`: the AdsPage. Each section reports its own read error. */
export interface UiOverview {
  state: UiConfigState;
  error?: string;
  brand: UiBrand | null;
  launchReady: boolean | null;
  preflightCheckedAt: string | null;
  preflightFresh: boolean;
  spend: UiSpend | null;
  spendError?: string;
  halt: UiHalt | null;
  haltError?: string;
  /** Clearing the halt acknowledges these: they are no longer retried. */
  pendingUndo: UiPendingUndo[];
  pendingUndoError?: string;
  publications: UiPublication[];
  publicationsError?: string;
  adsError?: string;
  pendingGates: UiGateCard[];
  gatesError?: string;
  ruleLog: UiRuleAction[];
  ruleLogError?: string;
  spend14d: UiSpendDay[];
  insightsError?: string;
}

/** Data key `ads-widget`: the dashboard widget. */
export interface UiWidget {
  state: UiConfigState;
  error?: string;
  brandCode: string | null;
  mtdEur: number | null;
  monthlyCapEur: number | null;
  pctUsed: number | null;
  spendError?: string;
  pendingGates: number | null;
  gatesError?: string;
  halted: boolean;
}

/** Data key `ads-settings`: the redacted config view. Secrets show only as "configured". */
export interface UiSettings {
  state: UiConfigState;
  error?: string;
  /** Config validation errors (state invalid). */
  errors: string[];
  /** Why the brand is disabled (state disabled). */
  reason?: string;
  brand: UiBrand | null;
  meta: {
    adAccountId: string;
    pageId: string;
    igUserId: string | null;
    datasetId: string | null;
    campaignId: string | null;
    adSetId: string | null;
    accessTokenConfigured: boolean;
    specialAdCategories: string[];
  } | null;
  telegram: {
    configured: boolean;
    mode: string | null;
    chatId: string | null;
    approverCount: number;
    gateTtlHours: number | null;
  } | null;
  landing: { allowedDomains: string[]; urlKeys: string[]; defaultUrlKey: string } | null;
  schedule: { scheduledPauseEnabled: boolean; scheduledPauseAt: string; dataGate: boolean } | null;
  digest: { enabled: boolean; time: string; cpcWarnEur: number } | null;
  fatigue: { enabled: boolean; issuesEnabled: boolean } | null;
}

/** Action `pause-ad`. */
export interface UiPauseAdResult {
  dryRun: boolean;
  adId: string;
  name: string | null;
  /** Status before the call. */
  previousStatus: string;
  /** Status after the call; equals previousStatus in a dry run. */
  status: string;
  paused: boolean;
  /** Activation cards of the ad a live pause closed (RK9-562). */
  closedCardIds?: string[];
  /** The ad's open cards could not be listed or closed (all or some), or running activations could not be read; the pause itself stands. */
  cardsError?: string;
  /** An approved activation of the ad may still be running (RK9-566); with `adHalt` it pauses the ad again. */
  activationRunning?: boolean;
  /**
   * The ad's short pause-ad halt (RK9-566): until then no activation of the
   * ad runs, unless a board user clears it (`clear-halt` with `adId` and `id`).
   */
  adHalt?: { id: string; until: string };
  /** The pause-ad halt was not stored: an approved activation may still set the ad ACTIVE. */
  haltError?: string;
  auditError?: string;
}
