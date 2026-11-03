// --- RK9 Custom (RK9-626): coord journal + inbox request bodies ---
//
// The six client-writable journal event types and the inbox message body of
// the RK9 coordination bus (epic RK9-620). Field names are snake_case, as the
// child spec and the ask-operator interface name them; the rk9 CLI sends them
// verbatim. The server redacts and one-lines every free-text field before the
// insert (server/src/services/rk9-coord-text.ts), so the limits here are only
// raw-input caps. Contract: docs/implementation-notes/coord-bus.md.
import { z } from "zod";
import { RK9_COORD_ACTOR_ID_MAX_LENGTH } from "../rk9-coord.js";
import { parseRk9CoordLeaseResource, RK9_COORD_LEASE_RESOURCE_MAX } from "./rk9-coord-leases.js";

/** Issue identifier, the same grammar as the worktree actor id (`RK9-626`). */
export const RK9_COORD_ISSUE_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$/;
/** `owner/repo`. */
export const RK9_COORD_REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Event types a client may POST. The other journal types are server-produced. */
export const RK9_COORD_CLIENT_EVENT_TYPES = [
  "decision",
  "deploy",
  "handoff",
  "blocker",
  "done",
  "ask-operator",
  // RK9-631: the follow-up of a `decision` whose vault note was written (rk9 decision --vault).
  "decision-vaulted",
  // RK9-647: heads-up from any session (RK9-636). Always stored unverified.
  "headsup",
  // RK9-647 (from RK9-632): a break-glass record; cc, operator and rk9claude only.
  "break-glass",
] as const;
export type Rk9CoordClientEventType = (typeof RK9_COORD_CLIENT_EVENT_TYPES)[number];

export const RK9_COORD_DEPLOY_RESULTS = ["started", "success", "failure", "rolled_back"] as const;
export const RK9_COORD_ASK_OPERATOR_URGENCIES = ["low", "normal", "high", "urgent"] as const;

/** Raw free text: the server collapses it to one line and caps it after redaction. */
const freeText = (max: number) => z.string().trim().min(1).max(max);

export const rk9CoordIssueSchema = z.string().regex(RK9_COORD_ISSUE_PATTERN, "issue must look like RK9-626");
export const rk9CoordRepoSchema = z.string().regex(RK9_COORD_REPO_PATTERN, "repo must be owner/repo");

const commonEventFields = {
  /** Client id for spool replay; a repeat is answered with the stored row. */
  client_event_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  /** Client time of a spooled event. */
  occurred_at: z.string().datetime({ offset: true }).optional(),
  repo: rk9CoordRepoSchema.optional(),
};

const decisionSchema = z.object({
  ...commonEventFields,
  type: z.literal("decision"),
  issue: rk9CoordIssueSchema.optional(),
  title: freeText(1000),
  rationale: freeText(4000),
  /** Vault note path, e.g. `rk9/resources/coord_bus.md`. */
  vault_note: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/, "vault_note must be a relative vault path")
    .refine((value) => !value.split("/").includes(".."), "vault_note must not contain ..")
    .optional(),
});

const deploySchema = z.object({
  ...commonEventFields,
  type: z.literal("deploy"),
  issue: rk9CoordIssueSchema.optional(),
  app: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "app must be a short app name"),
  sha: z.string().regex(/^[0-9a-fA-F]{7,40}$/, "sha must be 7-40 hex characters"),
  result: z.enum(RK9_COORD_DEPLOY_RESULTS),
});

const handoffSchema = z.object({
  ...commonEventFields,
  type: z.literal("handoff"),
  /** Who takes over: an actor id or a name. Free text, not resolved. */
  to: z.string().trim().min(1).max(RK9_COORD_ACTOR_ID_MAX_LENGTH).optional(),
  issue: rk9CoordIssueSchema,
  summary: freeText(2000),
});

const blockerSchema = z.object({
  ...commonEventFields,
  type: z.literal("blocker"),
  issue: rk9CoordIssueSchema,
  what: freeText(2000),
});

const doneSchema = z.object({
  ...commonEventFields,
  type: z.literal("done"),
  issue: rk9CoordIssueSchema,
  /** PR number or PR URL. */
  pr: z.union([z.number().int().positive(), z.string().trim().min(1).max(300)]).optional(),
});

/**
 * ask-operator: the interface for the separate operator_todo epic
 * (documented in coord-bus.md). `actor` is always overwritten by the server
 * with the resolved caller; a client value is ignored.
 */
export const rk9CoordAskOperatorSchema = z.object({
  ...commonEventFields,
  type: z.literal("ask-operator"),
  question: freeText(2000),
  options: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
  urgency: z.enum(RK9_COORD_ASK_OPERATOR_URGENCIES),
  issue: rk9CoordIssueSchema.optional(),
  actor: z.string().max(RK9_COORD_ACTOR_ID_MAX_LENGTH).optional(),
  /** Journal id of the event this one answers or follows up. */
  reply_to: z.number().int().positive().optional(),
});

/**
 * Vault note of `rk9 decision --vault` (RK9-631): an rk9/ PARA note, the same
 * grammar as vault-mcp's decision_append. No `..` segment can match.
 */
export const RK9_COORD_DECISION_NOTE_PATTERN = /^rk9\/(projects|areas|resources|archives|tacit)\/[a-z0-9][a-z0-9_.-]{0,119}\.md$/;

/**
 * decision-vaulted (RK9-631): the vault note of decision `ref_event_id` is
 * committed. The journal is append-only, so this follow-up event is the
 * "vault_pending=false" flag. One per decision (server dedupe key).
 */
const decisionVaultedSchema = z.object({
  ...commonEventFields,
  type: z.literal("decision-vaulted"),
  ref_event_id: z.number().int().positive(),
  vault_path: z.string().regex(RK9_COORD_DECISION_NOTE_PATTERN, "vault_path must be rk9/<section>/<name>.md"),
  /** Vault commit that holds the section (short or full hash). */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/, "commit must be 7-40 lower-case hex characters"),
  /** false: committed locally, the push is still pending (the vault-sync rebase pushes it later). */
  pushed: z.boolean().optional(),
});

/** Heads-up class (ADR / coord-bus.md naming): operator decision or other. */
export const RK9_COORD_HEADSUP_CLASSES = ["operator", "other"] as const;
/** Observation key of a heads-up; stored in the `dedupe_key` column. */
export const RK9_COORD_OBSERVATION_KEY_PATTERN = /^[0-9a-f]{8,64}$/;

/**
 * headsup (RK9-647, client side RK9-636): an observation a session reports.
 * The server stores it as `unverified` whatever the credential, dedupes it
 * on (company, type, observation_key) and never creates an ask-operator from
 * it. `class_rule` is dropped from the payload when `class` is `other`.
 */
export const rk9CoordHeadsupSchema = z.object({
  ...commonEventFields,
  type: z.literal("headsup"),
  text: freeText(2000),
  explanation: freeText(4000).optional(),
  class: z.enum(RK9_COORD_HEADSUP_CLASSES),
  class_rule: z.string().regex(/^[a-z][a-z_]{0,39}$/, "class_rule must be a lower-case rule name").optional(),
  observation_key: z.string().regex(RK9_COORD_OBSERVATION_KEY_PATTERN, "observation_key must be 8-64 lower-case hex"),
  session_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "session_id must be a session id").optional(),
  issue: rk9CoordIssueSchema.optional(),
});

/** Gate a break-glass record bypassed (RK9-632 naming). */
export const RK9_COORD_BREAK_GLASS_GATES = ["deploy", "tag", "migrate", "host", "repo"] as const;

/**
 * break-glass (RK9-647, from RK9-632): a record that someone bypassed a gate
 * on `resource`. It changes no lease state; an operator lease break stays
 * POST /leases/break. Only kinds cc, operator and rk9claude may post it.
 */
export const rk9CoordBreakGlassSchema = z.object({
  ...commonEventFields,
  type: z.literal("break-glass"),
  resource: z
    .string()
    .max(RK9_COORD_LEASE_RESOURCE_MAX)
    .refine((value) => parseRk9CoordLeaseResource(value) !== null, "resource must be a lease resource like prod:<app>"),
  reason: freeText(1000),
  gate: z.enum(RK9_COORD_BREAK_GLASS_GATES),
  issue: rk9CoordIssueSchema.optional(),
});

/** POST /companies/:companyId/rk9/coord/events */
export const appendRk9CoordEventSchema = z.discriminatedUnion("type", [
  decisionSchema,
  deploySchema,
  handoffSchema,
  blockerSchema,
  doneSchema,
  rk9CoordAskOperatorSchema,
  decisionVaultedSchema,
  rk9CoordHeadsupSchema,
  rk9CoordBreakGlassSchema,
]);
export type AppendRk9CoordEvent = z.infer<typeof appendRk9CoordEventSchema>;

/** Control (\p{Cc}) and format (\p{Cf}) characters; not allowed in a verbatim `to`. */
const RK9_COORD_TO_FORBIDDEN_RX = /[\p{Cc}\p{Cf}]/u;

/** POST /companies/:companyId/rk9/coord/inbox */
export const sendRk9CoordInboxSchema = z.object({
  /**
   * An actor id, an issue identifier or a name (orchestrator, session,
   * Paperclip agent). Stored verbatim (to_name), so control and format
   * characters (NUL, C1, zero-width, bidi) are 400 here (RK9-641).
   */
  to: z
    .string()
    .trim()
    .min(1)
    .max(RK9_COORD_ACTOR_ID_MAX_LENGTH)
    .refine((value) => !RK9_COORD_TO_FORBIDDEN_RX.test(value), "to must not contain control or format characters"),
  body: freeText(4000),
  /** Lower-case token, default `message`. */
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
  /** Issue for a message to a Paperclip agent; it becomes a comment there. */
  issue: rk9CoordIssueSchema.optional(),
  /** Undelivered messages expire after this many seconds (60 s to 30 d). */
  expires_in_s: z.number().int().min(60).max(30 * 24 * 3600).optional(),
});
export type SendRk9CoordInbox = z.infer<typeof sendRk9CoordInboxSchema>;

const queryFlag = z.enum(["0", "1", "true", "false"]).transform((value) => value === "1" || value === "true");

/** GET /companies/:companyId/rk9/coord/events/delta query string. */
export const rk9CoordDeltaQuerySchema = z.object({
  /** Optional: must equal the resolved caller (header or credential). */
  actorId: z.string().min(1).max(RK9_COORD_ACTOR_ID_MAX_LENGTH).optional(),
  peek: queryFlag.optional(),
  fmt: z.enum(["json", "line"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  repo: rk9CoordRepoSchema.optional(),
  issue: rk9CoordIssueSchema.optional(),
});
export type Rk9CoordDeltaQuery = z.infer<typeof rk9CoordDeltaQuerySchema>;

/** GET /companies/:companyId/rk9/coord/events/vault-pending query string (RK9-631). */
export const rk9CoordVaultPendingQuerySchema = z.object({
  /** One decision event id; omitted = every pending decision. */
  id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type Rk9CoordVaultPendingQuery = z.infer<typeof rk9CoordVaultPendingQuerySchema>;

/** GET /companies/:companyId/rk9/coord/board query string. */
export const rk9CoordBoardQuerySchema = z.object({
  events: z.coerce.number().int().min(1).max(100).optional(),
});
// --- /RK9 Custom ---
