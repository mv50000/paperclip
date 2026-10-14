/**
 * Helpers around the SDK test harness (`@paperclipai/plugin-sdk/testing`).
 *
 * The stock harness returns one config for every company and resolves any
 * secret to `resolved:<ref>`. These helpers make it behave like the host:
 * config and secrets are per company, a company without config throws, and
 * string secret refs fail closed. Test-only; never imported by the worker.
 */

import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";

export interface SecretResolutionRecord {
  companyId: string | null;
  secretId: string | null;
  configPath: string | null;
  resolved: boolean;
}

/**
 * Serves `configs[companyId]`. Like the host in a job or webhook (no
 * invocation company), a company without a config row is refused with
 * "company context is required", and so is a call without a company.
 * Company-scoped `ctx.state` calls get the same gate.
 */
export function useCompanyConfigs(harness: TestHarness, configs: Record<string, Record<string, unknown>>): void {
  harness.ctx.config.get = async (companyId?: string) => {
    const config = companyId ? configs[companyId] : undefined;
    if (!config) throw new Error("company context is required");
    return config;
  };
  // The host gates company-scoped state the same way; instance state is not gated.
  const state = harness.ctx.state;
  const base = { get: state.get.bind(state), set: state.set.bind(state), delete: state.delete.bind(state) };
  const gate = (input: ScopeKey): void => {
    if (input.scopeKind === "company" && !(input.scopeId && configs[input.scopeId])) {
      throw new Error("company context is required");
    }
  };
  state.get = async (input) => (gate(input), base.get(input));
  state.set = async (input, value) => (gate(input), base.set(input, value));
  state.delete = async (input) => (gate(input), base.delete(input));
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
