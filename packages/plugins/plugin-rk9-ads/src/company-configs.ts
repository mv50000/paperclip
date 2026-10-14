/**
 * Enumerates companies and their parsed brand config.
 *
 * Scheduled jobs and webhooks run without a company context, so a job lists
 * companies and reads each config explicitly. Without an invocation company,
 * the host serves config only for companies that have a config row and refuses
 * the others with "company context is required": that refusal means the
 * plugin is off there ("absent"). Any other failure is "unavailable", so a job
 * that must act for safety (a pause) can warn instead of silently skipping.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parseBrandConfig, type BrandConfigParseResult } from "./config.js";

const PAGE_SIZE = 100;
const MAX_COMPANIES = 5000;
/** Host refusal for a company without a config row (sdk host-client-factory). */
const NO_CONFIG_ROW_RE = /company context is required/i;

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
    if (NO_CONFIG_ROW_RE.test(message)) return { state: "absent" };
    return { state: "unavailable", error: message.slice(0, 200) };
  }
  return parseBrandConfig(raw);
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
