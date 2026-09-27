import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";

export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Mirrors the agent-source low-trust markers consumed by
 * resolveCoreTrustPreset: the low-trust review preset (top-level or inside
 * authorizationPolicy) or a low-trust boundary. Defaults must never grant
 * agent-creation authority to a low-trust agent.
 */
export function permissionsImplyLowTrust(permissions: unknown): boolean {
  const record = asRecord(permissions);
  if (!record) return false;
  const authorizationPolicy = asRecord(record.authorizationPolicy);
  return (
    record.trustPreset === LOW_TRUST_REVIEW_PRESET ||
    authorizationPolicy?.trustPreset === LOW_TRUST_REVIEW_PRESET ||
    asRecord(record.reviewPreset)?.id === LOW_TRUST_REVIEW_PRESET ||
    asRecord(authorizationPolicy?.reviewPreset)?.id === LOW_TRUST_REVIEW_PRESET ||
    asRecord(authorizationPolicy?.trustBoundary) !== null
  );
}

/**
 * "create" is the context for permissions arriving on a new-agent write: the
 * hire/create default applies and the resolved value is persisted. "stored"
 * is the context for rows read back from the database: a row without an
 * explicit value stays fail-closed, so the default is never granted
 * retroactively to legacy or malformed records at read or enforcement time.
 */
export type AgentPermissionsContext = "create" | "stored";

// --- RK9 Custom (RK9-309, RK9-317): upstream v2026.916 grants canCreateAgents by default to every
// standard-trust agent on the hire/create path. The fork keeps hire rights with the board, the CEO
// role and explicit canCreateAgents / agents:create grants, as before 916 (defaultPermissionsForRole).
// The create default therefore applies only to role "ceo". See doc/upgrade/defaults-hardening.md. ---
function isCeoRole(role: string | null | undefined): boolean {
  return typeof role === "string" && role.trim().toLowerCase() === "ceo";
}
// --- end RK9 Custom ---

export function defaultAgentPermissions(
  options?: { lowTrust?: boolean; context?: AgentPermissionsContext; role?: string | null },
): NormalizedAgentPermissions {
  return {
    // RK9 Custom (RK9-317): `&& isCeoRole(...)` is the fork pin.
    canCreateAgents: options?.context === "create" && options?.lowTrust !== true && isCeoRole(options?.role),
    canCreateSkills: true,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  options?: { context?: AgentPermissionsContext; role?: string | null },
): NormalizedAgentPermissions {
  const defaults = defaultAgentPermissions({
    lowTrust: permissionsImplyLowTrust(permissions),
    context: options?.context ?? "stored",
    role: options?.role,
  });
  const record = asRecord(permissions);
  if (!record) {
    return defaults;
  }

  return {
    ...record,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
  };
}
