/**
 * Helpers around the SDK test harness (`@paperclipai/plugin-sdk/testing`).
 *
 * The stock harness returns one config for every company and resolves any
 * secret to `resolved:<ref>`. These helpers make it behave like the host:
 * config and secrets are per company, a company without config throws, and
 * string secret refs fail closed. Test-only; never imported by the worker.
 */

import type { TestHarness } from "@paperclipai/plugin-sdk/testing";

export interface SecretResolutionRecord {
  companyId: string | null;
  secretId: string | null;
  configPath: string | null;
  resolved: boolean;
}

/**
 * Serves `configs[companyId]`. Like the host, a company without a config row
 * gets `{}`, and a call without a company throws.
 */
export function useCompanyConfigs(harness: TestHarness, configs: Record<string, Record<string, unknown>>): void {
  harness.ctx.config.get = async (companyId?: string) => {
    if (!companyId) throw new Error("company context is required");
    return configs[companyId] ?? {};
  };
}

/**
 * Serves `secrets[companyId][secretId]`. Returns the call log (ids and paths
 * only, never values) for assertions.
 */
export function useCompanySecrets(
  harness: TestHarness,
  secrets: Record<string, Record<string, string>>,
): SecretResolutionRecord[] {
  const calls: SecretResolutionRecord[] = [];
  harness.ctx.secrets.resolve = async (secretRef, options) => {
    const companyId = options?.companyId ?? null;
    const configPath = options?.configPath ?? null;
    if (typeof secretRef === "string") {
      calls.push({ companyId, secretId: null, configPath, resolved: false });
      throw new Error("Legacy string secret refs fail closed");
    }
    if (!companyId) {
      calls.push({ companyId, secretId: secretRef.secretId, configPath, resolved: false });
      throw new Error("companyId is required");
    }
    const value = secrets[companyId]?.[secretRef.secretId];
    calls.push({ companyId, secretId: secretRef.secretId, configPath, resolved: value !== undefined });
    if (value === undefined) throw new Error("binding_missing");
    return value;
  };
  return calls;
}

/** Everything the harness recorded, as one string, for "value never leaks" checks. */
export function recordedOutput(harness: TestHarness): string {
  return JSON.stringify({
    logs: harness.logs,
    activity: harness.activity,
    metrics: harness.metrics,
    telemetry: harness.telemetry,
    dbQueries: harness.dbQueries,
    dbExecutes: harness.dbExecutes,
  });
}
