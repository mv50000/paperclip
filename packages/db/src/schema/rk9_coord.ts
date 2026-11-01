// --- RK9 Custom (RK9-623): coordination bus tables (epic RK9-620) ---
//
// Created by the hand-written fork migration 9015_rk9_coord.sql. Fork
// migrations are hash-pinned, so this file and the SQL are kept in sync by
// hand: change both or neither, and never change 9015 once it is applied
// anywhere (later changes need 9016+). Names are frozen in the ADR
// docs/implementation-notes/coord-identity.md; the data model is documented in
// docs/implementation-notes/coord-bus.md.
//
// Two objects live only in the SQL, because the snapshot drift test cannot
// filter them by table: the global fencing sequence
// `rk9_coord_lease_fencing_seq` (referenced by the leases default below) and
// the append-only trigger `rk9_coord_events_append_only_trg` on events.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Lease resource format: `<prefix>:<name>`, prefixes frozen in the ADR. */
const RESOURCE_RE = "^(prod|migrate|repo|vault|host):[^[:space:]]+$";
const KINDS_SQL = sql.raw(
  "('cc', 'worktree', 'headless', 'agent_run', 'orch', 'remote', 'rk9claude', 'grok', 'operator')",
);
const TRUST_SQL = sql.raw("('verified', 'attributed', 'unverified')");

/** Presence: one row per actor (actor_ref = the ADR actor_id string). */
export const rk9CoordActors = pgTable(
  "rk9_coord_actors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** The full actor_id from the ADR grammar, e.g. `cc:paperclip-01:<sid>`. */
    actorRef: text("actor_ref").notNull(),
    /** Host the server attributes the actor to; null for agent_run/operator. */
    host: text("host"),
    /** Kind-specific part of actor_ref (session, issue, run or name). */
    externalId: text("external_id"),
    name: text("name"),
    trust: text("trust").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    issue: text("issue"),
    repo: text("repo"),
    branch: text("branch"),
    phase: text("phase"),
    phaseAt: timestamp("phase_at", { withTimezone: true }),
    pid: integer("pid"),
    livenessSource: text("liveness_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActorRefUq: uniqueIndex("rk9_coord_actors_company_actor_ref_uq").on(table.companyId, table.actorRef),
    companyLiveIdx: index("rk9_coord_actors_company_live_idx")
      .on(table.companyId, table.lastSeenAt)
      .where(sql`${table.endedAt} is null`),
    companyIssueIdx: index("rk9_coord_actors_company_issue_idx").on(table.companyId, table.issue),
    agentIdx: index("rk9_coord_actors_agent_idx").on(table.agentId),
    kindCheck: check("rk9_coord_actors_kind_check", sql`${table.kind} in ${KINDS_SQL}`),
    actorRefCheck: check(
      "rk9_coord_actors_actor_ref_check",
      sql`char_length(${table.actorRef}) between 1 and 200 and split_part(${table.actorRef}, ':', 1) = ${table.kind}`,
    ),
    hostCheck: check(
      "rk9_coord_actors_host_check",
      sql`${table.host} is null or ${table.host} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    externalIdCheck: check(
      "rk9_coord_actors_external_id_check",
      sql`${table.externalId} is null or char_length(${table.externalId}) between 1 and 128`,
    ),
    nameCheck: check("rk9_coord_actors_name_check", sql`${table.name} is null or char_length(${table.name}) <= 200`),
    trustCheck: check("rk9_coord_actors_trust_check", sql`${table.trust} in ${TRUST_SQL}`),
    issueCheck: check("rk9_coord_actors_issue_check", sql`${table.issue} is null or char_length(${table.issue}) <= 64`),
    repoCheck: check("rk9_coord_actors_repo_check", sql`${table.repo} is null or char_length(${table.repo}) <= 200`),
    branchCheck: check(
      "rk9_coord_actors_branch_check",
      sql`${table.branch} is null or char_length(${table.branch}) <= 255`,
    ),
    phaseCheck: check("rk9_coord_actors_phase_check", sql`${table.phase} is null or char_length(${table.phase}) <= 140`),
    pidCheck: check("rk9_coord_actors_pid_check", sql`${table.pid} is null or ${table.pid} > 0`),
    livenessSourceCheck: check(
      "rk9_coord_actors_liveness_source_check",
      sql`${table.livenessSource} is null or ${table.livenessSource} ~ '^[a-z][a-z0-9_]{0,31}$'`,
    ),
  }),
);

/** TTL leases with fencing tokens. At most one active lease per resource. */
export const rk9CoordLeases = pgTable(
  "rk9_coord_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    holderActorId: uuid("holder_actor_id")
      .notNull()
      .references(() => rk9CoordActors.id, { onDelete: "cascade" }),
    /** Global, monotonic across releases (sequence rk9_coord_lease_fencing_seq). */
    fencingToken: bigint("fencing_token", { mode: "number" })
      .notNull()
      .default(sql`nextval('rk9_coord_lease_fencing_seq')`),
    mode: text("mode").$type<"shadow" | "warn" | "enforce">().notNull().default("enforce"),
    reason: text("reason"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
  },
  (table) => ({
    activeResourceUq: uniqueIndex("rk9_coord_leases_active_resource_uq")
      .on(table.companyId, table.resource)
      .where(sql`${table.releasedAt} is null`),
    activeExpiryIdx: index("rk9_coord_leases_active_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.releasedAt} is null`),
    holderIdx: index("rk9_coord_leases_holder_idx").on(table.holderActorId),
    companyResourceIdx: index("rk9_coord_leases_company_resource_idx").on(
      table.companyId,
      table.resource,
      table.acquiredAt,
    ),
    resourceCheck: check(
      "rk9_coord_leases_resource_check",
      sql`char_length(${table.resource}) <= 300 and ${table.resource} ~ ${sql.raw(`'${RESOURCE_RE}'`)}`,
    ),
    modeCheck: check("rk9_coord_leases_mode_check", sql`${table.mode} in ('shadow', 'warn', 'enforce')`),
    reasonCheck: check(
      "rk9_coord_leases_reason_check",
      sql`${table.reason} is null or char_length(${table.reason}) <= 300`,
    ),
    releaseCheck: check(
      "rk9_coord_leases_release_check",
      sql`(${table.releasedAt} is null) = (${table.releaseReason} is null)`,
    ),
    releaseReasonCheck: check(
      "rk9_coord_leases_release_reason_check",
      sql`${table.releaseReason} is null or ${table.releaseReason} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  }),
);

/** FIFO wait queue per resource; the bigserial id is the queue order. */
export const rk9CoordLeaseWaiters = pgTable(
  "rk9_coord_lease_waiters",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => rk9CoordActors.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"shadow" | "warn" | "enforce">().notNull().default("enforce"),
    reason: text("reason"),
    requestedTtlSeconds: integer("requested_ttl_seconds"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    resourceActorUq: uniqueIndex("rk9_coord_lease_waiters_resource_actor_uq").on(
      table.companyId,
      table.resource,
      table.actorId,
    ),
    fifoIdx: index("rk9_coord_lease_waiters_fifo_idx").on(table.companyId, table.resource, table.id),
    actorIdx: index("rk9_coord_lease_waiters_actor_idx").on(table.actorId),
    resourceCheck: check(
      "rk9_coord_lease_waiters_resource_check",
      sql`char_length(${table.resource}) <= 300 and ${table.resource} ~ ${sql.raw(`'${RESOURCE_RE}'`)}`,
    ),
    modeCheck: check("rk9_coord_lease_waiters_mode_check", sql`${table.mode} in ('shadow', 'warn', 'enforce')`),
    reasonCheck: check(
      "rk9_coord_lease_waiters_reason_check",
      sql`${table.reason} is null or char_length(${table.reason}) <= 300`,
    ),
    ttlCheck: check(
      "rk9_coord_lease_waiters_ttl_check",
      sql`${table.requestedTtlSeconds} is null or ${table.requestedTtlSeconds} > 0`,
    ),
  }),
);

/**
 * Append-only journal. The bigserial id is the cursor. A DB trigger rejects
 * UPDATE and DELETE (except a company-delete cascade and the retention prune).
 */
export const rk9CoordEvents = pgTable(
  "rk9_coord_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** Author's actor_id string; kept as text so the journal outlives the actor row. */
    actorRef: text("actor_ref").notNull(),
    actorKind: text("actor_kind").notNull(),
    trust: text("trust").notNull(),
    issue: text("issue"),
    repo: text("repo"),
    resource: text("resource"),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Client-generated id for spool replay dedupe (unique per company). */
    clientEventId: text("client_event_id"),
    /** Earlier event this one follows up (decision-vaulted, escalated). No FK: prune-safe. */
    refEventId: bigint("ref_event_id", { mode: "number" }),
    vaultPath: text("vault_path"),
    /** Producer dedupe key (headsup observation key, rk9claude alert key). */
    dedupeKey: text("dedupe_key"),
    /** Client-side time for spooled events; created_at is the server time. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("rk9_coord_events_company_id_idx").on(table.companyId, table.id),
    companyRepoIdx: index("rk9_coord_events_company_repo_idx").on(table.companyId, table.repo, table.id),
    companyIssueIdx: index("rk9_coord_events_company_issue_idx").on(table.companyId, table.issue, table.id),
    companyTypeIdx: index("rk9_coord_events_company_type_idx").on(table.companyId, table.type, table.id),
    companyCreatedIdx: index("rk9_coord_events_company_created_idx").on(table.companyId, table.createdAt),
    clientEventUq: uniqueIndex("rk9_coord_events_client_event_uq")
      .on(table.companyId, table.clientEventId)
      .where(sql`${table.clientEventId} is not null`),
    dedupeUq: uniqueIndex("rk9_coord_events_dedupe_uq")
      .on(table.companyId, table.type, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    typeCheck: check(
      "rk9_coord_events_type_check",
      sql`${table.type} in ('decision', 'deploy', 'handoff', 'blocker', 'done', 'ask-operator', 'lease', 'phase', 'break-glass', 'decision-vaulted', 'escalated', 'headsup')`,
    ),
    actorRefCheck: check(
      "rk9_coord_events_actor_ref_check",
      sql`char_length(${table.actorRef}) between 1 and 200`,
    ),
    actorKindCheck: check("rk9_coord_events_actor_kind_check", sql`${table.actorKind} in ${KINDS_SQL}`),
    trustCheck: check("rk9_coord_events_trust_check", sql`${table.trust} in ${TRUST_SQL}`),
    issueCheck: check("rk9_coord_events_issue_check", sql`${table.issue} is null or char_length(${table.issue}) <= 64`),
    repoCheck: check("rk9_coord_events_repo_check", sql`${table.repo} is null or char_length(${table.repo}) <= 200`),
    resourceCheck: check(
      "rk9_coord_events_resource_check",
      sql`${table.resource} is null or (char_length(${table.resource}) <= 300 and ${table.resource} ~ ${sql.raw(`'${RESOURCE_RE}'`)})`,
    ),
    summaryCheck: check("rk9_coord_events_summary_check", sql`char_length(${table.summary}) between 1 and 300`),
    clientEventIdCheck: check(
      "rk9_coord_events_client_event_id_check",
      sql`${table.clientEventId} is null or char_length(${table.clientEventId}) between 1 and 128`,
    ),
    vaultPathCheck: check(
      "rk9_coord_events_vault_path_check",
      sql`${table.vaultPath} is null or char_length(${table.vaultPath}) <= 500`,
    ),
    dedupeKeyCheck: check(
      "rk9_coord_events_dedupe_key_check",
      sql`${table.dedupeKey} is null or char_length(${table.dedupeKey}) between 1 and 200`,
    ),
  }),
);

/** Per-actor journal cursor: the last event id the actor has seen. */
export const rk9CoordCursors = pgTable(
  "rk9_coord_cursors",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => rk9CoordActors.id, { onDelete: "cascade" }),
    lastEventId: bigint("last_event_id", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.actorId], name: "rk9_coord_cursors_company_id_actor_id_pk" }),
    actorIdx: index("rk9_coord_cursors_actor_idx").on(table.actorId),
    lastEventIdCheck: check("rk9_coord_cursors_last_event_id_check", sql`${table.lastEventId} >= 0`),
  }),
);

/** Messages for actors that are not live; exactly one target is set. */
export const rk9CoordInbox = pgTable(
  "rk9_coord_inbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    toActorId: uuid("to_actor_id").references(() => rk9CoordActors.id, { onDelete: "cascade" }),
    toIssue: text("to_issue"),
    toName: text("to_name"),
    fromActorId: uuid("from_actor_id").references(() => rk9CoordActors.id, { onDelete: "set null" }),
    fromActorRef: text("from_actor_ref").notNull(),
    kind: text("kind").notNull().default("message"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredToActorId: uuid("delivered_to_actor_id").references(() => rk9CoordActors.id, { onDelete: "set null" }),
  },
  (table) => ({
    undeliveredIdx: index("rk9_coord_inbox_undelivered_idx")
      .on(table.companyId, table.id)
      .where(sql`${table.deliveredAt} is null`),
    toActorIdx: index("rk9_coord_inbox_to_actor_idx").on(table.toActorId),
    fromActorIdx: index("rk9_coord_inbox_from_actor_idx").on(table.fromActorId),
    deliveredToActorIdx: index("rk9_coord_inbox_delivered_to_actor_idx").on(table.deliveredToActorId),
    targetCheck: check(
      "rk9_coord_inbox_target_check",
      sql`num_nonnulls(${table.toActorId}, ${table.toIssue}, ${table.toName}) = 1`,
    ),
    toIssueCheck: check(
      "rk9_coord_inbox_to_issue_check",
      sql`${table.toIssue} is null or char_length(${table.toIssue}) between 1 and 64`,
    ),
    toNameCheck: check(
      "rk9_coord_inbox_to_name_check",
      sql`${table.toName} is null or char_length(${table.toName}) between 1 and 200`,
    ),
    fromActorRefCheck: check(
      "rk9_coord_inbox_from_actor_ref_check",
      sql`char_length(${table.fromActorRef}) between 1 and 200`,
    ),
    kindCheck: check("rk9_coord_inbox_kind_check", sql`${table.kind} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    bodyCheck: check("rk9_coord_inbox_body_check", sql`char_length(${table.body}) between 1 and 500`),
  }),
);

/** Hashed coord tokens (ADR column list; plaintext is never stored). */
export const rk9CoordTokens = pgTable(
  "rk9_coord_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    principalKind: text("principal_kind").$type<"host" | "service">().notNull(),
    principalName: text("principal_name").notNull(),
    tokenHash: text("token_hash").notNull().unique("rk9_coord_tokens_token_hash_unique"),
    tokenPrefix: text("token_prefix").notNull(),
    scope: text("scope").$type<"coord">().notNull().default("coord"),
    label: text("label"),
    createdByUserId: text("created_by_user_id"),
    rotatedFromTokenId: uuid("rotated_from_token_id").references((): AnyPgColumn => rk9CoordTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    activePrincipalUq: uniqueIndex("rk9_coord_tokens_active_principal_uq")
      .on(table.companyId, table.principalKind, table.principalName)
      .where(sql`${table.revokedAt} is null`),
    rotatedFromIdx: index("rk9_coord_tokens_rotated_from_idx").on(table.rotatedFromTokenId),
    principalKindCheck: check(
      "rk9_coord_tokens_principal_kind_check",
      sql`${table.principalKind} in ('host', 'service')`,
    ),
    principalNameCheck: check(
      "rk9_coord_tokens_principal_name_check",
      sql`(${table.principalKind} = 'host' and ${table.principalName} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') or (${table.principalKind} = 'service' and ${table.principalName} in ('rk9claude', 'grok'))`,
    ),
    tokenHashCheck: check("rk9_coord_tokens_token_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    tokenPrefixCheck: check(
      "rk9_coord_tokens_token_prefix_check",
      sql`char_length(${table.tokenPrefix}) = 14 and left(${table.tokenPrefix}, 10) = 'rk9_coord_'`,
    ),
    scopeCheck: check("rk9_coord_tokens_scope_check", sql`${table.scope} in ('coord')`),
    labelCheck: check("rk9_coord_tokens_label_check", sql`${table.label} is null or char_length(${table.label}) <= 200`),
  }),
);

/** Telegram escalation ledger: one row per stuck episode (reservation before send). */
export const rk9CoordEscalations = pgTable(
  "rk9_coord_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    episodeKey: text("episode_key").notNull(),
    reason: text("reason").notNull(),
    resource: text("resource"),
    issue: text("issue"),
    mode: text("mode").$type<"shadow" | "enforce">().notNull(),
    status: text("status")
      .$type<"reserved" | "sent" | "failed" | "suppressed" | "shadow">()
      .notNull()
      .default("reserved"),
    /** Journal event that records the escalation. No FK: prune-safe. */
    eventId: bigint("event_id", { mode: "number" }),
    message: text("message"),
    channelMessageId: text("channel_message_id"),
    error: text("error"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => ({
    episodeUq: uniqueIndex("rk9_coord_escalations_episode_uq").on(table.companyId, table.episodeKey),
    companyReservedIdx: index("rk9_coord_escalations_company_reserved_idx").on(table.companyId, table.reservedAt),
    episodeKeyCheck: check(
      "rk9_coord_escalations_episode_key_check",
      sql`char_length(${table.episodeKey}) between 1 and 300`,
    ),
    reasonCheck: check("rk9_coord_escalations_reason_check", sql`${table.reason} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    resourceCheck: check(
      "rk9_coord_escalations_resource_check",
      sql`${table.resource} is null or (char_length(${table.resource}) <= 300 and ${table.resource} ~ ${sql.raw(`'${RESOURCE_RE}'`)})`,
    ),
    issueCheck: check(
      "rk9_coord_escalations_issue_check",
      sql`${table.issue} is null or char_length(${table.issue}) <= 64`,
    ),
    modeCheck: check("rk9_coord_escalations_mode_check", sql`${table.mode} in ('shadow', 'enforce')`),
    statusCheck: check(
      "rk9_coord_escalations_status_check",
      sql`${table.status} in ('reserved', 'sent', 'failed', 'suppressed', 'shadow')`,
    ),
    messageCheck: check(
      "rk9_coord_escalations_message_check",
      sql`${table.message} is null or char_length(${table.message}) <= 1000`,
    ),
    channelMessageIdCheck: check(
      "rk9_coord_escalations_channel_message_id_check",
      sql`${table.channelMessageId} is null or char_length(${table.channelMessageId}) <= 128`,
    ),
    errorCheck: check("rk9_coord_escalations_error_check", sql`${table.error} is null or char_length(${table.error}) <= 500`),
  }),
);
// --- /RK9 Custom ---
