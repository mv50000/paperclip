import { LOW_TRUST_REVIEW_PRESET, type PermissionKey } from "@paperclipai/shared";

/** Direct grants for newly activated standard agents. Existing agents are not backfilled. */
const UPSTREAM_NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS = [
  "agents:configure",
  "agents:suggest-changes",
  "skills:create",
  "skills:suggest-changes",
  "tools:manage_connections",
  "tools:manage_profiles",
  "tools:view_audit",
  "audit:view_agent_actions",
  "tools:use",
  "tools:manage_runtime",
  "inbox:manage",
  "tasks:assign",
  "tasks:assign_scope",
  "tasks:manage_active_checkouts",
] as const satisfies readonly PermissionKey[];

// --- RK9 Custom (RK9-700): upstream v2026.1012 (#15283) gives every new standard agent 14 direct
// grants at create, approval activation and invite join. Several widen what the agent can do without
// an approval: agents:configure (peer agent config), tasks:assign / tasks:assign_scope (bypasses the
// RK9-313 task-assignment rule), tools:use (an unscoped grant passes the tool-profile check),
// agents:suggest-changes (reads every peer's config and instructions), skills:create (direct skill
// changes). A partial set also changes self-edit decisions (suggest-changes without configure turns
// allow_self into deny_missing_consent). The fork therefore keeps new agents at the level of existing
// agents: no default direct grants. The board grants keys explicitly per agent.
// See doc/upgrade/defaults-hardening.md, "Porras v2026.1012.0". ---
export const RK9_WITHHELD_NEW_AGENT_GRANT_KEYS: readonly PermissionKey[] = UPSTREAM_NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS;

export const NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS: readonly PermissionKey[] =
  UPSTREAM_NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.filter(
    (permissionKey) => !RK9_WITHHELD_NEW_AGENT_GRANT_KEYS.includes(permissionKey),
  );
// --- end RK9 Custom ---

export function newStandardAgentGrantScope(
  permissionKey: PermissionKey,
  agentId: string,
): Record<string, unknown> | null {
  if (permissionKey === "tasks:assign_scope") return { subtreeRootAgentId: agentId };
  if (permissionKey === "inbox:manage") return { responsibleUserOnly: true };
  return null;
}

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
