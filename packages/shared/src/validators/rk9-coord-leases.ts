// --- RK9 Custom (RK9-627): coord lease request bodies and resource grammar ---
//
// Bodies of the lease engine routes under
// /api/companies/:companyId/rk9/coord/leases (epic RK9-620, key lease-engine).
// Field names follow the rk9 CLI (RK9-624, ~/.claude/bin/rk9 cmd_lease):
//   POST /leases/acquire       { resource, ttl_s, reason, wait }
//   POST /leases/:id/renew     { fencing_token, ttl_s }
//   POST /leases/:id/release   { resource, fencing_token, client_event_id }
//   POST /leases/break         { resource, reason }
// Unknown keys (e.g. the CLI's client_event_id) are stripped, not rejected.
//
// The resource is a plain string here on purpose: the service checks the
// per-prefix grammar and answers 422 (`rk9_coord_lease_resource_invalid`),
// while a zod failure would be a generic 400.
import { z } from "zod";
import { RK9_COORD_HARD_GATE_PREFIXES, RK9_COORD_RESOURCE_PREFIXES, type Rk9CoordResourcePrefix } from "../rk9-coord.js";

/** DB CHECK on rk9_coord_leases.resource. */
export const RK9_COORD_LEASE_RESOURCE_MAX = 300;
export const RK9_COORD_LEASE_TTL_MIN_S = 10;
export const RK9_COORD_LEASE_TTL_MAX_S = 86_400;
export const RK9_COORD_LEASE_TTL_DEFAULT_S = 1_800;
/** DB CHECK on rk9_coord_leases.reason. */
export const RK9_COORD_LEASE_REASON_MAX = 300;
export const RK9_COORD_LEASE_MODES = ["shadow", "warn", "enforce"] as const;
export type Rk9CoordLeaseMode = (typeof RK9_COORD_LEASE_MODES)[number];

/**
 * Name grammar per resource prefix:
 * - `prod:<app>`, `migrate:<db>`: an app or database name;
 * - `repo:<repo>` or `repo:<repo>@<branch>`: `name` or `owner/name`, branch as git allows it
 *   (the CLI hook uses both forms);
 * - `vault:<note>`: a relative vault path, no `..` segment;
 * - `host:<node>`: a lower-case host name (DNS labels, dots allowed).
 */
const RESOURCE_NAME_PATTERNS: Readonly<Record<Rk9CoordResourcePrefix, RegExp>> = {
  prod: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  migrate: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  repo: /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})?(@[A-Za-z0-9._\/+-]{1,200})?$/,
  vault: /^[A-Za-z0-9_+-][A-Za-z0-9._\/+@-]{0,254}$/,
  host: /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/,
};

export interface Rk9CoordLeaseResource {
  resource: string;
  prefix: Rk9CoordResourcePrefix;
  name: string;
  /** `prod`, `migrate` and `host` need verified or attributed trust. */
  hardGate: boolean;
  /** `owner/name` part of a `repo:` resource, for the journal repo column. */
  repo: string | null;
}

/** Parse `<prefix>:<name>`. Returns null for an unknown prefix or a bad name. */
export function parseRk9CoordLeaseResource(value: string): Rk9CoordLeaseResource | null {
  if (typeof value !== "string" || value.length === 0 || value.length > RK9_COORD_LEASE_RESOURCE_MAX) return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const prefix = value.slice(0, colon) as Rk9CoordResourcePrefix;
  if (!(RK9_COORD_RESOURCE_PREFIXES as readonly string[]).includes(prefix)) return null;
  const name = value.slice(colon + 1);
  if (!RESOURCE_NAME_PATTERNS[prefix].test(name)) return null;
  if (name.split(/[\/@]/).some((segment) => segment === "." || segment === "..")) return null;
  const repo = prefix === "repo" ? name.split("@")[0]! : null;
  return {
    resource: value,
    prefix,
    name,
    hardGate: (RK9_COORD_HARD_GATE_PREFIXES as readonly string[]).includes(prefix),
    repo,
  };
}

const resourceSchema = z.string().min(1).max(RK9_COORD_LEASE_RESOURCE_MAX);
const ttlSchema = z.number().int().min(RK9_COORD_LEASE_TTL_MIN_S).max(RK9_COORD_LEASE_TTL_MAX_S);
/** The CLI stores the token from the JSON answer (a number); a numeric string is accepted too. */
export const rk9CoordFencingTokenSchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform((value) => Number(value)),
]);
const reasonSchema = z.string().max(2_000).nullable().optional();

/** POST /leases/acquire */
export const acquireRk9CoordLeaseSchema = z.object({
  resource: resourceSchema,
  ttl_s: ttlSchema.optional(),
  reason: reasonSchema,
  wait: z.boolean().optional(),
  mode: z.enum(RK9_COORD_LEASE_MODES).optional(),
});
export type AcquireRk9CoordLease = z.infer<typeof acquireRk9CoordLeaseSchema>;

/** POST /leases/:leaseId/renew */
export const renewRk9CoordLeaseSchema = z.object({
  fencing_token: rk9CoordFencingTokenSchema,
  ttl_s: ttlSchema.optional(),
});
export type RenewRk9CoordLease = z.infer<typeof renewRk9CoordLeaseSchema>;

/** POST /leases/:leaseId/release; the fencing token is optional, a stale one is 409. */
export const releaseRk9CoordLeaseSchema = z.object({
  resource: resourceSchema.optional(),
  fencing_token: rk9CoordFencingTokenSchema.nullable().optional(),
});
export type ReleaseRk9CoordLease = z.infer<typeof releaseRk9CoordLeaseSchema>;

/** POST /leases/break: operator force-release; the reason is required. */
export const breakRk9CoordLeaseSchema = z.object({
  resource: resourceSchema,
  reason: z.string().trim().min(1).max(2_000),
});
export type BreakRk9CoordLease = z.infer<typeof breakRk9CoordLeaseSchema>;

/** POST /leases/validate: is this fencing token the current one for the resource? */
export const validateRk9CoordLeaseSchema = z.object({
  resource: resourceSchema,
  fencing_token: rk9CoordFencingTokenSchema,
});
export type ValidateRk9CoordLease = z.infer<typeof validateRk9CoordLeaseSchema>;

/** GET /leases */
export const rk9CoordLeaseListQuerySchema = z.object({
  prefix: z.enum(RK9_COORD_RESOURCE_PREFIXES).optional(),
  holder: z.string().min(1).max(200).optional(),
  resource: resourceSchema.optional(),
});

/** GET /leases/status */
export const rk9CoordLeaseStatusQuerySchema = z.object({ resource: resourceSchema });
// --- /RK9 Custom ---
