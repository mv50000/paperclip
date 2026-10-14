/**
 * Enumerates companies and their parsed brand config.
 *
 * Scheduled jobs and webhooks run without a company context, so a job lists
 * companies and reads each config explicitly. A company without a config row
 * gets `{}` (plugin off). When `config.get` throws, the result is
 * "unavailable", not "absent": a job that must act for safety (a pause) can
 * then warn instead of silently skipping the company.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parseBrandConfig, type BrandConfigParseResult } from "./config.js";

const PAGE_SIZE = 100;
const MAX_COMPANIES = 5000;

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
    return { state: "unavailable", error: error instanceof Error ? error.message.slice(0, 200) : "unknown error" };
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
