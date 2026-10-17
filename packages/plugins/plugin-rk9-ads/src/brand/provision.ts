/**
 * Idempotent provisioning of a brand's campaign and ad set (A4, RK9-510).
 *
 * One OUTCOME_TRAFFIC campaign and one ad set per brand, both PAUSED and
 * permanent (G8: the name has no month, `<namingPrefix>-traffic`). The monthly
 * limit comes from Meta's spend_cap and the spend guard, not from the name.
 *
 * - Budget (G3): daily_budget = floor(monthlyCapEur * 100 / 31) cents. The ad
 *   set is permanent and its budget is set only when it is created, so it uses
 *   the longest month: the spend guard then passes it in every month (RK9-538).
 *   A requested budget above it, or below Meta's min_daily_budget, is refused
 *   before any write; above the cap is refused before any API call at all.
 * - Lookup order per object: an id given to the action, `meta.campaignId` /
 *   `meta.adSetId` in the config (adopted, e.g. the Sunspot migration), the
 *   brand_bindings row (reused), then an exact name match (reused). Only when
 *   nothing matches is the object created. A stored id falls through to the
 *   name lookup only when it is shown to be stale (Graph code 100, another
 *   account, a dead status); any other error fails the run. Ids are verified against the ad
 *   account (and the ad set against the campaign) before they are used.
 * - dryRun returns the planned Graph writes and changes nothing (the Meta
 *   client's dryRun mode: the write guard still runs, nothing is sent).
 * - A real run passes `assertLaunchReady` first, writes through the brand's
 *   spend-guarded client, logs one activity entry per created object and
 *   records the ids in brand_bindings.
 * - One run per company at a time (in-process lock: the plugin has one
 *   worker), so two concurrent clicks cannot both create.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import { dailyBudgetCents } from "../config.js";
import type { Ledger } from "../db.js";
import type { Initiator } from "../features/spend-guard/support.js";
import { MetaGraphError, RateLimitError, TokenInvalidError, TokenResolveError } from "../meta/errors.js";
import type { MetaGraphClient } from "../meta/graph.js";
import {
  adSetCreateBody,
  createAdSet,
  createCampaign,
  getAccountMinDailyBudgetCents,
  getAdSet,
  getCampaign,
  listAdSets,
  listCampaigns,
} from "../meta/methods.js";
import { redactText } from "../meta/redact.js";
import { isDryRun, type DryRunResult } from "../meta/types.js";
import type { PreflightResult } from "./preflight.js";

export const PROVISION_OBJECTIVE = "OUTCOME_TRAFFIC";
/** Finnish brands only so far; a per-brand country list is a config change for later. */
export const PROVISION_COUNTRIES = ["FI"] as const;
const DEAD_STATUSES = new Set(["DELETED", "ARCHIVED"]);
const ID_RE = /^\d+$/;
const PLANNED_CAMPAIGN_ID = "<new campaign>";

export const PROVISION_ERROR_CODES = [
  "budget_invalid",
  "budget_above_cap",
  "budget_below_minimum",
  "invalid_id",
  "object_not_in_account",
  "object_unusable",
  "adset_not_in_campaign",
  "ambiguous_name",
  "in_progress",
] as const;
export type ProvisionErrorCode = (typeof PROVISION_ERROR_CODES)[number];

export class ProvisionError extends Error {
  readonly code: ProvisionErrorCode;

  constructor(code: ProvisionErrorCode, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
  }
}

export interface ProvisionInput {
  dryRun: boolean;
  /** Cents; defaults to the G3 maximum. */
  dailyBudgetCents?: number;
  /** Ids entered by hand; verified and adopted, never created. */
  campaignId?: string;
  adSetId?: string;
  initiator: Initiator;
}

export type ObjectAction = "created" | "reused" | "adopted" | "planned_create";
export type ObjectSource = "param" | "config" | "binding" | "name" | "new";

export interface ProvisionedObject {
  id: string | null;
  name: string;
  action: ObjectAction;
  source: ObjectSource;
  status: string | null;
  effectiveStatus: string | null;
}

export interface ProvisionResult {
  dryRun: boolean;
  brandCode: string;
  campaign: ProvisionedObject;
  adSet: ProvisionedObject & { dailyBudgetCents: number | null };
  /** The budget a new ad set gets (G3, 31-day month), cents. */
  dailyBudgetCents: number;
  maxDailyBudgetCents: number;
  minDailyBudgetCents: number | null;
  /** An adopted or reused ad set whose own budget is above the G3 maximum. Provision does not change it. */
  adSetBudgetAboveCap: boolean;
  /** Writes a dry run would send, as the Meta client planned them. */
  plannedCalls: DryRunResult["planned"][];
  creates: number;
  preflight: { launchReady: boolean | null; checkedAt: string | null };
}

export interface BrandBinding {
  campaignId: string | null;
  adSetId: string | null;
  adAccountId: string;
}

export interface BindingStore {
  get(companyId: string, brandCode: string): Promise<BrandBinding | null>;
  save(
    companyId: string,
    config: BrandConfig,
    binding: { campaignId: string; adSetId: string | null; source: "provisioned" | "adopted"; igUserId: string | null },
  ): Promise<void>;
}

export function sqlBindingStore(ledger: Ledger): BindingStore {
  return {
    async get(companyId, brandCode) {
      const rows = await ledger.select<"brand_bindings", { campaign_id: unknown; adset_id: unknown; ad_account_id: unknown }>(
        companyId,
        "brand_bindings",
        { where: { brand_code: brandCode, status: "active" }, limit: 1 },
      );
      const row = rows[0];
      if (!row) return null;
      const id = (value: unknown) => (typeof value === "string" && ID_RE.test(value) ? value : null);
      return { campaignId: id(row.campaign_id), adSetId: id(row.adset_id), adAccountId: String(row.ad_account_id ?? "") };
    },
    async save(companyId, config, binding) {
      const values = {
        ad_account_id: config.meta.adAccountId,
        page_id: config.meta.pageId,
        ig_user_id: binding.igUserId,
        dataset_id: config.meta.datasetId ?? null,
        campaign_id: binding.campaignId,
        adset_id: binding.adSetId,
        binding_source: binding.source,
        status: "active",
      };
      const { inserted } = await ledger.insertIfAbsent(companyId, "brand_bindings", { brand_code: config.brandCode, ...values });
      if (!inserted) await ledger.update(companyId, "brand_bindings", { brand_code: config.brandCode }, values);
    },
  };
}

export function memoryBindingStore(): BindingStore & { rows: Map<string, BrandBinding & { source: string }> } {
  const rows = new Map<string, BrandBinding & { source: string }>();
  return {
    rows,
    async get(companyId, brandCode) {
      const row = rows.get(`${companyId}|${brandCode}`);
      return row ? { campaignId: row.campaignId, adSetId: row.adSetId, adAccountId: row.adAccountId } : null;
    },
    async save(companyId, config, binding) {
      rows.set(`${companyId}|${config.brandCode}`, {
        campaignId: binding.campaignId,
        adSetId: binding.adSetId,
        adAccountId: config.meta.adAccountId,
        source: binding.source,
      });
    },
  };
}

export interface ProvisionDeps {
  ctx: Pick<PluginContext, "activity" | "logger">;
  bindings: BindingStore;
  /** Read-only client of the brand. */
  readClient: MetaGraphClient;
  /** Spend-guarded client of the brand in `live` or `dryRun` mode. */
  writeClient: MetaGraphClient;
  /** The launch gate (preflight.ts assertLaunchReady). Called on real runs only. */
  assertLaunchReady: () => Promise<PreflightResult>;
  /** The cached preflight for a dry run's report. */
  cachedPreflight?: () => Promise<PreflightResult | null>;
}

/** G8: one permanent name per brand. Campaign and ad set share it. */
export function provisionNames(config: Pick<BrandConfig, "namingPrefix">): { campaign: string; adSet: string } {
  const name = `${config.namingPrefix}-traffic`;
  return { campaign: name, adSet: name };
}

/** The longest month. The permanent ad set's budget must fit it, whatever month it is created in. */
export const PERMANENT_BUDGET_DAYS = 31;

/**
 * G3 maximum of the permanent ad set: floor(cap * 100 / 31). A budget sized to
 * a shorter month (e.g. 333 c in a 30-day one) projects above the cap in the
 * next 31-day month, and the spend guard would refuse its activation.
 */
export function maxDailyBudgetCents(config: Pick<BrandConfig, "monthlyCapEur">): number {
  return dailyBudgetCents(config.monthlyCapEur, PERMANENT_BUDGET_DAYS);
}

export function campaignFields(config: Pick<BrandConfig, "meta">): Record<string, unknown> {
  const special = config.meta.specialAdCategories;
  return {
    objective: PROVISION_OBJECTIVE,
    buying_type: "AUCTION",
    special_ad_categories: [...special],
    ...(special.includes("NONE") ? {} : { special_ad_category_country: [...PROVISION_COUNTRIES] }),
    // Ad set budgets (no campaign budget), each spending only its own budget.
    is_adset_budget_sharing_enabled: false,
  };
}

/** The ad set fields an OUTCOME_TRAFFIC ad set needs besides name, campaign, budget and status. */
export function adSetFields(): Record<string, unknown> {
  return {
    billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WEBSITE",
    targeting: {
      geo_locations: { countries: [...PROVISION_COUNTRIES] },
      age_min: 18,
      targeting_automation: { advantage_audience: 0 },
    },
  };
}

const locks = new Set<string>();

function optionalId(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!ID_RE.test(value)) throw new ProvisionError("invalid_id", `${field} must be a numeric Graph id`);
  return value;
}

/** Graph code 100: the stored object does not exist (or cannot be read) any more. */
const GRAPH_OBJECT_MISSING = 100;

/**
 * A stored binding id is stale only on proof: Graph code 100, or a ProvisionError
 * (another ad account, DELETED/ARCHIVED, another campaign). A 5xx, throttling or
 * a token error is not proof: falling through to the name lookup then could
 * create a duplicate of a renamed object.
 */
function staleBinding(error: unknown): boolean {
  if (error instanceof ProvisionError) return true;
  return (
    error instanceof MetaGraphError &&
    !(error instanceof TokenInvalidError || error instanceof TokenResolveError || error instanceof RateLimitError) &&
    error.code === GRAPH_OBJECT_MISSING
  );
}

function safe(error: unknown): string {
  return redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);
}

function outcome(id: string | null, name: string, action: ObjectAction, source: ObjectSource, row?: { status: string; effectiveStatus: string }): ProvisionedObject {
  return { id, name, action, source, status: row?.status ?? null, effectiveStatus: row?.effectiveStatus ?? null };
}

export async function provision(deps: ProvisionDeps, companyId: string, config: BrandConfig, input: ProvisionInput): Promise<ProvisionResult> {
  // Budget rules first: an invalid or over-cap request makes no API call.
  const maxDaily = maxDailyBudgetCents(config);
  const requested = input.dailyBudgetCents ?? maxDaily;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new ProvisionError("budget_invalid", "dailyBudgetCents must be a positive integer (cents)");
  }
  if (requested > maxDaily) {
    throw new ProvisionError(
      "budget_above_cap",
      `dailyBudgetCents ${requested} is above the cap ${maxDaily} (floor(${config.monthlyCapEur} EUR * 100 / ${PERMANENT_BUDGET_DAYS} days), G3)`,
    );
  }
  const campaignParam = optionalId(input.campaignId, "campaignId");
  const adSetParam = optionalId(input.adSetId, "adSetId");

  const lockKey = companyId;
  if (locks.has(lockKey)) throw new ProvisionError("in_progress", "a provision run for this brand is already in progress");
  locks.add(lockKey);
  try {
    const preflight = input.dryRun ? ((await deps.cachedPreflight?.()) ?? null) : await deps.assertLaunchReady();
    const act = `act_${config.meta.adAccountId}`;
    const names = provisionNames(config);
    const planned: DryRunResult["planned"][] = [];

    const minDaily = await getAccountMinDailyBudgetCents(deps.readClient, act);
    if (minDaily !== null && requested < minDaily) {
      throw new ProvisionError("budget_below_minimum", `dailyBudgetCents ${requested} is below Meta's minimum daily budget ${minDaily} for this ad account`);
    }

    const stored = await deps.bindings.get(companyId, config.brandCode);
    const binding = stored && stored.adAccountId === config.meta.adAccountId ? stored : null;

    // Campaign
    let campaign: ProvisionedObject | null = null;
    const campaignRef: { id: string; source: ObjectSource } | null = campaignParam
      ? { id: campaignParam, source: "param" }
      : config.meta.campaignId
        ? { id: config.meta.campaignId, source: "config" }
        : binding?.campaignId
          ? { id: binding.campaignId, source: "binding" }
          : null;
    if (campaignRef) {
      try {
        const detail = await getCampaign(deps.readClient, campaignRef.id);
        if (detail.accountId !== config.meta.adAccountId) {
          throw new ProvisionError("object_not_in_account", `campaign ${campaignRef.id} is not in ${act}`);
        }
        if (DEAD_STATUSES.has(detail.status)) throw new ProvisionError("object_unusable", `campaign ${campaignRef.id} is ${detail.status}`);
        campaign = outcome(detail.id, detail.name, campaignRef.source === "binding" ? "reused" : "adopted", campaignRef.source, detail);
      } catch (error) {
        // A stale binding (object deleted, account changed) falls through to the name lookup; a hand-entered id never does.
        if (campaignRef.source !== "binding" || !staleBinding(error)) throw error;
        deps.ctx.logger.warn("rk9-ads provision: stored campaign id is not usable; looking up by name", { companyId, error: safe(error) });
      }
    }
    if (!campaign) {
      const matches = (await listCampaigns(deps.readClient, act)).filter((row) => row.name === names.campaign && !DEAD_STATUSES.has(row.status));
      if (matches.length > 1) {
        throw new ProvisionError("ambiguous_name", `${matches.length} campaigns are named ${names.campaign} (${matches.map((row) => row.id).join(", ")}); enter the right one as campaignId`);
      }
      if (matches[0]) campaign = outcome(matches[0].id, matches[0].name, "reused", "name", matches[0]);
    }
    let creates = 0;
    if (!campaign) {
      const created = await createCampaign(deps.writeClient, act, { name: names.campaign, fields: campaignFields(config) });
      if (isDryRun(created)) {
        planned.push(created.planned);
        campaign = outcome(null, names.campaign, "planned_create", "new");
      } else {
        creates += 1;
        campaign = outcome(created.campaignId, names.campaign, "created", "new", { status: "PAUSED", effectiveStatus: "PAUSED" });
        await logCreate(deps, companyId, config, input, "campaign", created.campaignId, names.campaign, {});
      }
    }

    // Ad set
    let adSet: (ProvisionedObject & { dailyBudgetCents: number | null }) | null = null;
    const adSetRef: { id: string; source: ObjectSource } | null = adSetParam
      ? { id: adSetParam, source: "param" }
      : config.meta.adSetId
        ? { id: config.meta.adSetId, source: "config" }
        : binding?.adSetId && campaign.source !== "new"
          ? { id: binding.adSetId, source: "binding" }
          : null;
    if (adSetRef) {
      try {
        const detail = await getAdSet(deps.readClient, adSetRef.id);
        if (detail.accountId !== config.meta.adAccountId) throw new ProvisionError("object_not_in_account", `ad set ${adSetRef.id} is not in ${act}`);
        if (DEAD_STATUSES.has(detail.status)) throw new ProvisionError("object_unusable", `ad set ${adSetRef.id} is ${detail.status}`);
        if (campaign.id === null || detail.campaignId !== campaign.id) {
          throw new ProvisionError("adset_not_in_campaign", `ad set ${adSetRef.id} belongs to campaign ${detail.campaignId ?? "?"}, not ${campaign.id ?? "the new campaign"}`);
        }
        adSet = { ...outcome(detail.id, detail.name, adSetRef.source === "binding" ? "reused" : "adopted", adSetRef.source, detail), dailyBudgetCents: detail.dailyBudgetCents };
      } catch (error) {
        if (adSetRef.source !== "binding" || !staleBinding(error)) throw error;
        deps.ctx.logger.warn("rk9-ads provision: stored ad set id is not usable; looking up by name", { companyId, error: safe(error) });
      }
    }
    if (!adSet && campaign.id !== null) {
      const campaignId = campaign.id;
      const matches = (await listAdSets(deps.readClient, act)).filter(
        (row) => row.name === names.adSet && row.campaignId === campaignId && !DEAD_STATUSES.has(row.status),
      );
      if (matches.length > 1) {
        throw new ProvisionError("ambiguous_name", `${matches.length} ad sets are named ${names.adSet} in campaign ${campaignId}; enter the right one as adSetId`);
      }
      if (matches[0]) {
        const detail = await getAdSet(deps.readClient, matches[0].id);
        adSet = { ...outcome(detail.id, detail.name, "reused", "name", detail), dailyBudgetCents: detail.dailyBudgetCents };
      }
    }
    if (!adSet) {
      const fields = adSetFields();
      if (campaign.id === null) {
        // Dry run with a planned campaign: the ad set call cannot be built by the client without a campaign id.
        planned.push({
          method: "POST",
          path: `${act}/adsets`,
          fields: adSetCreateBody({ name: names.adSet, campaignId: PLANNED_CAMPAIGN_ID, dailyBudgetCents: requested, fields }),
        });
        adSet = { ...outcome(null, names.adSet, "planned_create", "new"), dailyBudgetCents: requested };
      } else {
        const created = await createAdSet(deps.writeClient, act, { name: names.adSet, campaignId: campaign.id, dailyBudgetCents: requested, fields });
        if (isDryRun(created)) {
          planned.push(created.planned);
          adSet = { ...outcome(null, names.adSet, "planned_create", "new"), dailyBudgetCents: requested };
        } else {
          creates += 1;
          adSet = { ...outcome(created.adSetId, names.adSet, "created", "new", { status: "PAUSED", effectiveStatus: "PAUSED" }), dailyBudgetCents: requested };
          await logCreate(deps, companyId, config, input, "adset", created.adSetId, names.adSet, { campaignId: campaign.id, dailyBudgetCents: requested });
        }
      }
    }

    if (!input.dryRun && campaign.id !== null) {
      const adopted = campaign.action === "adopted" || adSet.action === "adopted";
      await deps.bindings.save(companyId, config, {
        campaignId: campaign.id,
        adSetId: adSet.id,
        source: adopted ? "adopted" : "provisioned",
        igUserId: preflight?.igUserId ?? config.meta.igUserId ?? null,
      });
    }

    return {
      dryRun: input.dryRun,
      brandCode: config.brandCode,
      campaign,
      adSet,
      dailyBudgetCents: requested,
      maxDailyBudgetCents: maxDaily,
      minDailyBudgetCents: minDaily,
      adSetBudgetAboveCap: adSet.dailyBudgetCents !== null && adSet.dailyBudgetCents > maxDaily,
      plannedCalls: planned,
      creates,
      preflight: { launchReady: preflight?.launchReady ?? null, checkedAt: preflight?.checkedAt ?? null },
    };
  } finally {
    locks.delete(lockKey);
  }
}

async function logCreate(
  deps: ProvisionDeps,
  companyId: string,
  config: BrandConfig,
  input: ProvisionInput,
  objectType: "campaign" | "adset",
  objectId: string,
  name: string,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.ctx.activity.log({
      companyId,
      message: `rk9-ads provision: created ${objectType} ${objectId} (PAUSED)`,
      entityType: "rk9_ads_brand",
      entityId: config.brandCode,
      metadata: { objectType, objectId, name, status: "PAUSED", initiator: { ...input.initiator }, ...extra },
    });
  } catch (error) {
    // The object exists; a failed audit line must not make the caller retry the create.
    deps.ctx.logger.error("rk9-ads provision: activity log failed", { companyId, objectType, objectId, error: safe(error) });
  }
}
