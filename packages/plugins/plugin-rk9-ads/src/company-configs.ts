/**
 * Enumerates companies and their parsed brand config.
 *
 * Scheduled jobs and webhooks run without a company context, so a job lists
 * companies and reads each config explicitly. Without an invocation company,
 * the host serves config only for companies in the worker's list of configured
 * companies and refuses the others with "company context is required".
 *
 * That list can be stale: the host fills it at worker start and refreshes it on
 * save, and both paths swallow their own failures. So the refusal alone does
 * not prove a company is off. The plugin keeps its own marker per company
 * ("this company has a saved config", instance-scoped state), set on every config change and on every
 * successful read. A refusal for a marked company is "unavailable"; only an
 * unmarked company is "absent". Any other failure is "unavailable" too, so a
 * job that must act for safety (a pause) warns instead of silently skipping.
 */

import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import { parseBrandConfig, type BrandConfigParseResult } from "./config.js";

const PAGE_SIZE = 100;
const MAX_COMPANIES = 5000;
/** Host refusal for a company outside its configured list (sdk host-client-factory). */
const NOT_CONFIGURED_RE = /company context is required/i;

/**
 * Instance scope on purpose: in a job the host refuses company-scoped state
 * for exactly the companies whose config it refuses, so a company-scoped
 * marker could never be read when it matters.
 */
function configMarkerKey(companyId: string): ScopeKey {
  return { scopeKind: "instance", namespace: "config-markers", stateKey: companyId };
}

/**
 * Records whether `companyId` has a non-empty saved config. The worker calls
 * it from onConfigChanged; loadCompanyConfig calls it after a successful read.
 */
export async function rememberConfigPresence(ctx: PluginContext, companyId: string, raw: Record<string, unknown> | null): Promise<void> {
  const present = parseBrandConfig(raw ?? {}).state !== "absent";
  if (present) await ctx.state.set(configMarkerKey(companyId), true);
  else await ctx.state.delete(configMarkerKey(companyId));
}

async function hasConfigMarker(ctx: PluginContext, companyId: string): Promise<boolean> {
  return (await ctx.state.get(configMarkerKey(companyId))) === true;
}

export type CompanyConfigResult = BrandConfigParseResult | { state: "unavailable"; error: string };

export interface CompanyConfig {
  companyId: string;
  companyName: string;
  result: CompanyConfigResult;
}

export async function loadCompanyConfig(ctx: PluginContext, companyId: string): Promise<CompanyConfigResult> {
  let raw: Record<string, unknown>;
  try {
    raw = await ctx.config.get(companyId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!NOT_CONFIGURED_RE.test(message)) return { state: "unavailable", error: message.slice(0, 200) };
    try {
      if (!(await hasConfigMarker(ctx, companyId))) return { state: "absent" };
    } catch (markerError) {
      const markerMessage = markerError instanceof Error ? markerError.message : String(markerError);
      return { state: "unavailable", error: `config refused and marker unreadable: ${markerMessage}`.slice(0, 200) };
    }
    return { state: "unavailable", error: `config refused for a company with a saved config: ${message}`.slice(0, 200) };
  }
  const result = parseBrandConfig(raw);
  try {
    await rememberConfigPresence(ctx, companyId, raw);
  } catch (error) {
    // The read itself succeeded; a missed marker only matters after a later host failure.
    ctx.logger.warn("rk9-ads: could not record config marker", {
      companyId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  return result;
}

export async function listCompanyConfigs(ctx: PluginContext): Promise<CompanyConfig[]> {
  const out: CompanyConfig[] = [];
  for (let offset = 0; offset < MAX_COMPANIES; offset += PAGE_SIZE) {
    const page = await ctx.companies.list({ limit: PAGE_SIZE, offset });
    for (const company of page) {
      out.push({ companyId: company.id, companyName: company.name, result: await loadCompanyConfig(ctx, company.id) });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}
