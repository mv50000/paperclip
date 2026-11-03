// --- RK9 Custom (RK9-621): coordination bus identity contract ---
//
// The frozen names and the actor_id grammar of the RK9 coordination bus
// (epic RK9-620). The ADR docs/implementation-notes/coord-identity.md is the
// human-readable source; this module is the machine-readable one, so server
// routes, the rk9 CLI tests and the coord-schema migration (RK9-623) share
// one definition. Change a name here only together with the ADR, and never
// after coord-schema's migration has been applied: fork migrations are
// hash-pinned.

/** Actor kinds, in the order the ADR lists them. Closed set. */
export const RK9_COORD_ACTOR_KINDS = [
  "cc",
  "worktree",
  "headless",
  "agent_run",
  "orch",
  "remote",
  "rk9claude",
  "grok",
  "operator",
] as const;
export type Rk9CoordActorKind = (typeof RK9_COORD_ACTOR_KINDS)[number];

/**
 * How far the server can vouch for an actor claim.
 * - verified: the server derived the identity from a credential bound to it
 *   (agent run with a run JWT, signed-in operator, a service token for one
 *   service).
 * - attributed: a local AI-session claim made with the paperclip-01 board key
 *   (the server knows the host but cannot tell sessions apart), or an agent-key
 *   run (the server knows the agent but not which of its running runs).
 * - unverified: advisory only (grok, remote:*); cannot hold hard-gate leases
 *   without operator escalation.
 */
export const RK9_COORD_TRUST_LEVELS = ["verified", "attributed", "unverified"] as const;
export type Rk9CoordTrust = (typeof RK9_COORD_TRUST_LEVELS)[number];

/** Table names reserved for the coordination bus. Only RK9-623 creates them. */
export const RK9_COORD_TABLES = [
  "rk9_coord_actors",
  "rk9_coord_leases",
  "rk9_coord_lease_waiters",
  "rk9_coord_events",
  "rk9_coord_cursors",
  "rk9_coord_inbox",
  "rk9_coord_tokens",
  "rk9_coord_escalations",
] as const;
export type Rk9CoordTable = (typeof RK9_COORD_TABLES)[number];

/** Lease resource prefixes: `<prefix>:<name>`. */
export const RK9_COORD_RESOURCE_PREFIXES = ["prod", "migrate", "repo", "vault", "host"] as const;
export type Rk9CoordResourcePrefix = (typeof RK9_COORD_RESOURCE_PREFIXES)[number];

/**
 * Kinds a board-key caller (AI sessions on paperclip-01) may claim. `operator`
 * is not among them: per the operator's approval of the ADR (2026-11-01), the
 * operator actor exists only behind a signed-in instance-admin session.
 */
export const RK9_COORD_BOARD_KEY_ACTOR_KINDS = ["cc", "worktree", "headless", "orch"] as const satisfies readonly Rk9CoordActorKind[];

export function rk9CoordBoardKeyMayClaim(kind: Rk9CoordActorKind): boolean {
  return (RK9_COORD_BOARD_KEY_ACTOR_KINDS as readonly Rk9CoordActorKind[]).includes(kind);
}

/** Hard-gate prefixes: deploys, migrations and Proxmox host outages. */
export const RK9_COORD_HARD_GATE_PREFIXES = ["prod", "migrate", "host"] as const satisfies readonly Rk9CoordResourcePrefix[];

/** Journal event types. Closed set; state changes are follow-up events. */
export const RK9_COORD_EVENT_TYPES = [
  "decision",
  "deploy",
  "handoff",
  "blocker",
  "done",
  "ask-operator",
  "lease",
  "phase",
  "break-glass",
  "decision-vaulted",
  "escalated",
  // Amended by RK9-623 for RK9-636 (heads-up on the coord bus).
  "headsup",
] as const;
export type Rk9CoordEventType = (typeof RK9_COORD_EVENT_TYPES)[number];

/** Header that carries the caller's actor claim. Not a secret. */
export const RK9_COORD_ACTOR_HEADER = "x-rk9-actor";
/**
 * Reserved header name for a coord token. Clients send the token as
 * `Authorization: Bearer rk9_coord_...`; the server never reads this header,
 * but the HTTP logger redacts it in case a client sends it anyway.
 */
export const RK9_COORD_TOKEN_HEADER = "x-rk9-coord-token";
/** Bearer prefix of a coord token (resolved in server/src/middleware/auth.ts, RK9-623). */
export const RK9_COORD_TOKEN_PREFIX = "rk9_coord_";
/** Coord token principal kinds: a tailnet host or one named service. */
export const RK9_COORD_TOKEN_PRINCIPAL_KINDS = ["host", "service"] as const;
export type Rk9CoordTokenPrincipalKind = (typeof RK9_COORD_TOKEN_PRINCIPAL_KINDS)[number];
/**
 * Token scopes (RK9-653). `coord` reaches only the coord routes; `recall`
 * reaches only `POST /api/companies/:companyId/knowledge/recall` of the
 * token's company. A host or service holds at most one active token per scope.
 */
export const RK9_COORD_TOKEN_SCOPES = ["coord", "recall"] as const;
export type Rk9CoordTokenScope = (typeof RK9_COORD_TOKEN_SCOPES)[number];
/** Services that may hold a coord service token. */
export const RK9_COORD_TOKEN_SERVICES = ["rk9claude", "grok"] as const;
/** Host token name: a lower-case DNS label (the tailnet host name). */
export const RK9_COORD_HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Canonical host name of the machine that holds the board key. */
export const RK9_COORD_BOARD_HOST_DEFAULT = "paperclip-01";
/** Route prefix under `/api`. */
export const RK9_COORD_ROUTE_PREFIX = "/companies/:companyId/rk9/coord";

export const RK9_COORD_ACTOR_ID_MAX_LENGTH = 200;

const HOST = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SESSION = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const ISSUE = "[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}";
const NAME = "[a-z0-9][a-z0-9._-]{0,62}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The actor_id grammar, one anchored pattern per kind. */
export const RK9_COORD_ACTOR_ID_PATTERNS: Readonly<Record<Rk9CoordActorKind, RegExp>> = {
  cc: new RegExp(`^cc:(${HOST}):(${SESSION})$`),
  worktree: new RegExp(`^worktree:(${ISSUE})$`),
  headless: new RegExp(`^headless:(${SESSION})$`),
  agent_run: new RegExp(`^agent_run:(${UUID})$`),
  orch: new RegExp(`^orch:(${NAME})$`),
  remote: new RegExp(`^remote:(${HOST})$`),
  rk9claude: /^rk9claude$/,
  grok: /^grok$/,
  operator: /^operator$/,
};

export interface Rk9CoordParsedActorId {
  kind: Rk9CoordActorKind;
  actorId: string;
  /** Host named inside the id (cc, remote), else null. */
  host: string | null;
  /** Kind-specific identifier: session, issue, run or name; else null. */
  ref: string | null;
}

/**
 * Parse an actor_id. Returns null for anything outside the grammar, including
 * surrounding whitespace and upper-case hosts: the id is compared verbatim.
 */
export function parseRk9CoordActorId(value: string): Rk9CoordParsedActorId | null {
  if (typeof value !== "string" || value.length === 0 || value.length > RK9_COORD_ACTOR_ID_MAX_LENGTH) {
    return null;
  }
  const kind = value.split(":", 1)[0] as Rk9CoordActorKind;
  const pattern = RK9_COORD_ACTOR_ID_PATTERNS[kind];
  if (!pattern || !Object.prototype.hasOwnProperty.call(RK9_COORD_ACTOR_ID_PATTERNS, kind)) return null;
  const match = pattern.exec(value);
  if (!match) return null;
  switch (kind) {
    case "cc":
      return { kind, actorId: value, host: match[1]!, ref: match[2]! };
    case "remote":
      return { kind, actorId: value, host: match[1]!, ref: null };
    case "worktree":
    case "headless":
    case "agent_run":
    case "orch":
      return { kind, actorId: value, host: null, ref: match[1]! };
    default:
      return { kind, actorId: value, host: null, ref: null };
  }
}

/** Hard-gate leases need a vouched-for actor; unverified actors escalate. */
export function rk9CoordTrustCanHoldHardGate(trust: Rk9CoordTrust): boolean {
  return trust === "verified" || trust === "attributed";
}
// --- /RK9 Custom ---
