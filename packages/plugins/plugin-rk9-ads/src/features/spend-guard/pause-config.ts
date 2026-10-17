/**
 * The config the pause side runs on (A6, RK9-511, README ADR 3).
 *
 * A live brand can turn `invalid` after an edit (the host checks only the
 * JSON schema), `disabled` when its monthly cap is cleared, or `unavailable`
 * when the host refuses its config. Stopping
 * must still work then. Every successful read stores the brand's last valid
 * config (it holds secret refs, never a secret value), and the pause paths
 * (scheduled pause, data gate, kill switch) fall back to it. Nothing that can
 * raise spend uses the fallback, and an absent config (removed on purpose)
 * never falls back. A fallback always pauses the whole ad account.
 *
 * Instance scope on purpose, as with the config markers: in a job the host
 * refuses company-scoped state for exactly the companies whose config it
 * refuses.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { loadCompanyConfig, type CompanyConfigResult } from "../../company-configs.js";
import type { BrandConfig } from "../../config.js";

export type PauseConfig =
  | { ok: true; config: BrandConfig; fallback: null }
  | { ok: true; config: BrandConfig; fallback: { state: "invalid" | "disabled" | "unavailable"; detail: string } }
  | { ok: false; state: string; error: string; neverEnabled?: true };

function lastValidKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: "spend-guard", stateKey: `last-valid-config:${companyId}` };
}

/** What was last written per company by this worker, to skip identical writes. */
const written = new WeakMap<PluginContext, Map<string, string>>();

export async function rememberValidConfig(ctx: PluginContext, companyId: string, config: BrandConfig): Promise<void> {
  const json = JSON.stringify(config);
  let seen = written.get(ctx);
  if (!seen) written.set(ctx, (seen = new Map()));
  if (seen.get(companyId) === json) return;
  try {
    await ctx.state.set(lastValidKey(companyId), json);
    seen.set(companyId, json);
  } catch (error) {
    ctx.logger.warn("rk9-ads spend guard: could not store the last valid config", {
      companyId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

function isStoredConfig(value: unknown): value is BrandConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Partial<BrandConfig>;
  return (
    typeof config.brandCode === "string" &&
    typeof config.timeZone === "string" &&
    typeof config.meta?.adAccountId === "string" &&
    /^\d+$/.test(config.meta.adAccountId) &&
    config.meta.accessTokenRef?.type === "secret_ref" &&
    typeof config.meta.accessTokenRef.secretId === "string" &&
    typeof config.schedule?.scheduledPause?.at === "string"
  );
}

async function lastValidConfig(ctx: PluginContext, companyId: string): Promise<BrandConfig | null> {
  const raw = await ctx.state.get(lastValidKey(companyId));
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The config for a pause: the current one, or the last valid one when the current one is invalid or unavailable. */
export async function loadPauseConfig(ctx: PluginContext, companyId: string, known?: CompanyConfigResult): Promise<PauseConfig> {
  const result = known ?? (await loadCompanyConfig(ctx, companyId));
  if (result.state === "enabled") {
    await rememberValidConfig(ctx, companyId, result.config);
    return { ok: true, config: result.config, fallback: null };
  }
  if (result.state === "absent") return { ok: false, state: "absent", error: "RK9 Ads is not configured for this company" };
  const detail =
    result.state === "invalid" ? result.errors.join("; ").slice(0, 300) : result.state === "disabled" ? result.reason : result.error;
  let fallback: BrandConfig | null;
  try {
    fallback = await lastValidConfig(ctx, companyId);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "unknown";
    return { ok: false, state: result.state, error: `the brand config is ${result.state} and the last valid config could not be read: ${message}` };
  }
  if (!fallback) {
    const error = `the brand config is ${result.state} and there is no last valid config to pause with`;
    // A brand saved disabled and never enabled has had no spend guard to run.
    return result.state === "disabled" ? { ok: false, state: result.state, error, neverEnabled: true } : { ok: false, state: result.state, error };
  }
  // The stored campaign scope may be stale (the broken save may have moved
  // it), so a fallback pauses the whole ad account.
  const { campaignId: _staleScope, ...meta } = fallback.meta;
  return { ok: true, config: { ...fallback, meta }, fallback: { state: result.state, detail } };
}

/** The pause reason, marked when it runs on the fallback; the mark reaches the audit row and the notice. */
export function pauseReason(loaded: Extract<PauseConfig, { ok: true }>, reason: string): string {
  return loaded.fallback ? `${reason} [konfiguraatio ${loaded.fallback.state}: viimeisin kelvollinen, koko mainostili]` : reason;
}
