-- RK9-623 (epic RK9-620, key coord-schema): the RK9 coordination bus.
--
-- The only migration of the epic: every table and column the later children
-- need is created here up front, because 9000-series fork migrations are
-- hash-pinned and cannot change once applied. Names are frozen in
-- docs/implementation-notes/coord-identity.md (ADR, RK9-621); the data model
-- is documented in docs/implementation-notes/coord-bus.md.
--
-- Only new rk9_coord_* tables: no upstream table is altered. Every table is
-- company-scoped with company_id -> companies(id) ON DELETE cascade.
-- Idempotent: CREATE ... IF NOT EXISTS, FK adds wrapped in DO $$ ...
-- duplicate_object, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS.
CREATE SEQUENCE IF NOT EXISTS "rk9_coord_lease_fencing_seq" AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_ref" text NOT NULL,
	"host" text,
	"external_id" text,
	"name" text,
	"trust" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"issue" text,
	"repo" text,
	"branch" text,
	"phase" text,
	"phase_at" timestamp with time zone,
	"pid" integer,
	"liveness_source" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rk9_coord_actors_kind_check" CHECK ("rk9_coord_actors"."kind" in ('cc', 'worktree', 'headless', 'agent_run', 'orch', 'remote', 'rk9claude', 'grok', 'operator')),
	CONSTRAINT "rk9_coord_actors_actor_ref_check" CHECK (char_length("rk9_coord_actors"."actor_ref") between 1 and 200 and split_part("rk9_coord_actors"."actor_ref", ':', 1) = "rk9_coord_actors"."kind"),
	CONSTRAINT "rk9_coord_actors_host_check" CHECK ("rk9_coord_actors"."host" is null or "rk9_coord_actors"."host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "rk9_coord_actors_external_id_check" CHECK ("rk9_coord_actors"."external_id" is null or char_length("rk9_coord_actors"."external_id") between 1 and 128),
	CONSTRAINT "rk9_coord_actors_name_check" CHECK ("rk9_coord_actors"."name" is null or char_length("rk9_coord_actors"."name") <= 200),
	CONSTRAINT "rk9_coord_actors_trust_check" CHECK ("rk9_coord_actors"."trust" in ('verified', 'attributed', 'unverified')),
	CONSTRAINT "rk9_coord_actors_issue_check" CHECK ("rk9_coord_actors"."issue" is null or char_length("rk9_coord_actors"."issue") <= 64),
	CONSTRAINT "rk9_coord_actors_repo_check" CHECK ("rk9_coord_actors"."repo" is null or char_length("rk9_coord_actors"."repo") <= 200),
	CONSTRAINT "rk9_coord_actors_branch_check" CHECK ("rk9_coord_actors"."branch" is null or char_length("rk9_coord_actors"."branch") <= 255),
	CONSTRAINT "rk9_coord_actors_phase_check" CHECK ("rk9_coord_actors"."phase" is null or char_length("rk9_coord_actors"."phase") <= 140),
	CONSTRAINT "rk9_coord_actors_pid_check" CHECK ("rk9_coord_actors"."pid" is null or "rk9_coord_actors"."pid" > 0),
	CONSTRAINT "rk9_coord_actors_liveness_source_check" CHECK ("rk9_coord_actors"."liveness_source" is null or "rk9_coord_actors"."liveness_source" ~ '^[a-z][a-z0-9_]{0,31}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"holder_actor_id" uuid NOT NULL,
	"fencing_token" bigint DEFAULT nextval('rk9_coord_lease_fencing_seq') NOT NULL,
	"mode" text DEFAULT 'enforce' NOT NULL,
	"reason" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "rk9_coord_leases_resource_check" CHECK (char_length("rk9_coord_leases"."resource") <= 300 and "rk9_coord_leases"."resource" ~ '^(prod|migrate|repo|vault|host):[^[:space:]]+$'),
	CONSTRAINT "rk9_coord_leases_mode_check" CHECK ("rk9_coord_leases"."mode" in ('shadow', 'warn', 'enforce')),
	CONSTRAINT "rk9_coord_leases_reason_check" CHECK ("rk9_coord_leases"."reason" is null or char_length("rk9_coord_leases"."reason") <= 300),
	CONSTRAINT "rk9_coord_leases_release_check" CHECK (("rk9_coord_leases"."released_at" is null) = ("rk9_coord_leases"."release_reason" is null)),
	CONSTRAINT "rk9_coord_leases_release_reason_check" CHECK ("rk9_coord_leases"."release_reason" is null or "rk9_coord_leases"."release_reason" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_lease_waiters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"mode" text DEFAULT 'enforce' NOT NULL,
	"reason" text,
	"requested_ttl_seconds" integer,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "rk9_coord_lease_waiters_resource_check" CHECK (char_length("rk9_coord_lease_waiters"."resource") <= 300 and "rk9_coord_lease_waiters"."resource" ~ '^(prod|migrate|repo|vault|host):[^[:space:]]+$'),
	CONSTRAINT "rk9_coord_lease_waiters_mode_check" CHECK ("rk9_coord_lease_waiters"."mode" in ('shadow', 'warn', 'enforce')),
	CONSTRAINT "rk9_coord_lease_waiters_reason_check" CHECK ("rk9_coord_lease_waiters"."reason" is null or char_length("rk9_coord_lease_waiters"."reason") <= 300),
	CONSTRAINT "rk9_coord_lease_waiters_ttl_check" CHECK ("rk9_coord_lease_waiters"."requested_ttl_seconds" is null or "rk9_coord_lease_waiters"."requested_ttl_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_ref" text NOT NULL,
	"actor_kind" text NOT NULL,
	"trust" text NOT NULL,
	"issue" text,
	"repo" text,
	"resource" text,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_event_id" text,
	"ref_event_id" bigint,
	"vault_path" text,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rk9_coord_events_type_check" CHECK ("rk9_coord_events"."type" in ('decision', 'deploy', 'handoff', 'blocker', 'done', 'ask-operator', 'lease', 'phase', 'break-glass', 'decision-vaulted', 'escalated', 'headsup')),
	CONSTRAINT "rk9_coord_events_actor_ref_check" CHECK (char_length("rk9_coord_events"."actor_ref") between 1 and 200),
	CONSTRAINT "rk9_coord_events_actor_kind_check" CHECK ("rk9_coord_events"."actor_kind" in ('cc', 'worktree', 'headless', 'agent_run', 'orch', 'remote', 'rk9claude', 'grok', 'operator')),
	CONSTRAINT "rk9_coord_events_trust_check" CHECK ("rk9_coord_events"."trust" in ('verified', 'attributed', 'unverified')),
	CONSTRAINT "rk9_coord_events_issue_check" CHECK ("rk9_coord_events"."issue" is null or char_length("rk9_coord_events"."issue") <= 64),
	CONSTRAINT "rk9_coord_events_repo_check" CHECK ("rk9_coord_events"."repo" is null or char_length("rk9_coord_events"."repo") <= 200),
	CONSTRAINT "rk9_coord_events_resource_check" CHECK ("rk9_coord_events"."resource" is null or (char_length("rk9_coord_events"."resource") <= 300 and "rk9_coord_events"."resource" ~ '^(prod|migrate|repo|vault|host):[^[:space:]]+$')),
	CONSTRAINT "rk9_coord_events_summary_check" CHECK (char_length("rk9_coord_events"."summary") between 1 and 300),
	CONSTRAINT "rk9_coord_events_client_event_id_check" CHECK ("rk9_coord_events"."client_event_id" is null or char_length("rk9_coord_events"."client_event_id") between 1 and 128),
	CONSTRAINT "rk9_coord_events_vault_path_check" CHECK ("rk9_coord_events"."vault_path" is null or char_length("rk9_coord_events"."vault_path") <= 500),
	CONSTRAINT "rk9_coord_events_dedupe_key_check" CHECK ("rk9_coord_events"."dedupe_key" is null or char_length("rk9_coord_events"."dedupe_key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_cursors" (
	"company_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rk9_coord_cursors_company_id_actor_id_pk" PRIMARY KEY("company_id","actor_id"),
	CONSTRAINT "rk9_coord_cursors_last_event_id_check" CHECK ("rk9_coord_cursors"."last_event_id" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"to_actor_id" uuid,
	"to_issue" text,
	"to_name" text,
	"from_actor_id" uuid,
	"from_actor_ref" text NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivered_to_actor_id" uuid,
	CONSTRAINT "rk9_coord_inbox_target_check" CHECK (num_nonnulls("rk9_coord_inbox"."to_actor_id", "rk9_coord_inbox"."to_issue", "rk9_coord_inbox"."to_name") = 1),
	CONSTRAINT "rk9_coord_inbox_to_issue_check" CHECK ("rk9_coord_inbox"."to_issue" is null or char_length("rk9_coord_inbox"."to_issue") between 1 and 64),
	CONSTRAINT "rk9_coord_inbox_to_name_check" CHECK ("rk9_coord_inbox"."to_name" is null or char_length("rk9_coord_inbox"."to_name") between 1 and 200),
	CONSTRAINT "rk9_coord_inbox_from_actor_ref_check" CHECK (char_length("rk9_coord_inbox"."from_actor_ref") between 1 and 200),
	CONSTRAINT "rk9_coord_inbox_kind_check" CHECK ("rk9_coord_inbox"."kind" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "rk9_coord_inbox_body_check" CHECK (char_length("rk9_coord_inbox"."body") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scope" text DEFAULT 'coord' NOT NULL,
	"label" text,
	"created_by_user_id" text,
	"rotated_from_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "rk9_coord_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "rk9_coord_tokens_principal_kind_check" CHECK ("rk9_coord_tokens"."principal_kind" in ('host', 'service')),
	CONSTRAINT "rk9_coord_tokens_principal_name_check" CHECK (("rk9_coord_tokens"."principal_kind" = 'host' and "rk9_coord_tokens"."principal_name" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') or ("rk9_coord_tokens"."principal_kind" = 'service' and "rk9_coord_tokens"."principal_name" in ('rk9claude', 'grok'))),
	CONSTRAINT "rk9_coord_tokens_token_hash_check" CHECK ("rk9_coord_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rk9_coord_tokens_token_prefix_check" CHECK (char_length("rk9_coord_tokens"."token_prefix") = 14 and left("rk9_coord_tokens"."token_prefix", 10) = 'rk9_coord_'),
	CONSTRAINT "rk9_coord_tokens_scope_check" CHECK ("rk9_coord_tokens"."scope" in ('coord')),
	CONSTRAINT "rk9_coord_tokens_label_check" CHECK ("rk9_coord_tokens"."label" is null or char_length("rk9_coord_tokens"."label") <= 200)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rk9_coord_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"episode_key" text NOT NULL,
	"reason" text NOT NULL,
	"resource" text,
	"issue" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"event_id" bigint,
	"message" text,
	"channel_message_id" text,
	"error" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "rk9_coord_escalations_episode_key_check" CHECK (char_length("rk9_coord_escalations"."episode_key") between 1 and 300),
	CONSTRAINT "rk9_coord_escalations_reason_check" CHECK ("rk9_coord_escalations"."reason" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "rk9_coord_escalations_resource_check" CHECK ("rk9_coord_escalations"."resource" is null or (char_length("rk9_coord_escalations"."resource") <= 300 and "rk9_coord_escalations"."resource" ~ '^(prod|migrate|repo|vault|host):[^[:space:]]+$')),
	CONSTRAINT "rk9_coord_escalations_issue_check" CHECK ("rk9_coord_escalations"."issue" is null or char_length("rk9_coord_escalations"."issue") <= 64),
	CONSTRAINT "rk9_coord_escalations_mode_check" CHECK ("rk9_coord_escalations"."mode" in ('shadow', 'enforce')),
	CONSTRAINT "rk9_coord_escalations_status_check" CHECK ("rk9_coord_escalations"."status" in ('reserved', 'sent', 'failed', 'suppressed', 'shadow')),
	CONSTRAINT "rk9_coord_escalations_message_check" CHECK ("rk9_coord_escalations"."message" is null or char_length("rk9_coord_escalations"."message") <= 1000),
	CONSTRAINT "rk9_coord_escalations_channel_message_id_check" CHECK ("rk9_coord_escalations"."channel_message_id" is null or char_length("rk9_coord_escalations"."channel_message_id") <= 128),
	CONSTRAINT "rk9_coord_escalations_error_check" CHECK ("rk9_coord_escalations"."error" is null or char_length("rk9_coord_escalations"."error") <= 500)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_actors" ADD CONSTRAINT "rk9_coord_actors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_actors" ADD CONSTRAINT "rk9_coord_actors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_leases" ADD CONSTRAINT "rk9_coord_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_leases" ADD CONSTRAINT "rk9_coord_leases_holder_actor_id_rk9_coord_actors_id_fk" FOREIGN KEY ("holder_actor_id") REFERENCES "public"."rk9_coord_actors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_lease_waiters" ADD CONSTRAINT "rk9_coord_lease_waiters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_lease_waiters" ADD CONSTRAINT "rk9_coord_lease_waiters_actor_id_rk9_coord_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rk9_coord_actors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_events" ADD CONSTRAINT "rk9_coord_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_cursors" ADD CONSTRAINT "rk9_coord_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_cursors" ADD CONSTRAINT "rk9_coord_cursors_actor_id_rk9_coord_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."rk9_coord_actors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_inbox" ADD CONSTRAINT "rk9_coord_inbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_inbox" ADD CONSTRAINT "rk9_coord_inbox_to_actor_id_rk9_coord_actors_id_fk" FOREIGN KEY ("to_actor_id") REFERENCES "public"."rk9_coord_actors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_inbox" ADD CONSTRAINT "rk9_coord_inbox_from_actor_id_rk9_coord_actors_id_fk" FOREIGN KEY ("from_actor_id") REFERENCES "public"."rk9_coord_actors"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_inbox" ADD CONSTRAINT "rk9_coord_inbox_delivered_to_actor_id_rk9_coord_actors_id_fk" FOREIGN KEY ("delivered_to_actor_id") REFERENCES "public"."rk9_coord_actors"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_tokens" ADD CONSTRAINT "rk9_coord_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_tokens" ADD CONSTRAINT "rk9_coord_tokens_rotated_from_token_id_rk9_coord_tokens_id_fk" FOREIGN KEY ("rotated_from_token_id") REFERENCES "public"."rk9_coord_tokens"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_coord_escalations" ADD CONSTRAINT "rk9_coord_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_actors_company_actor_ref_uq" ON "rk9_coord_actors" USING btree ("company_id","actor_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_actors_company_live_idx" ON "rk9_coord_actors" USING btree ("company_id","last_seen_at") WHERE "rk9_coord_actors"."ended_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_actors_company_issue_idx" ON "rk9_coord_actors" USING btree ("company_id","issue");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_actors_agent_idx" ON "rk9_coord_actors" USING btree ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_leases_active_resource_uq" ON "rk9_coord_leases" USING btree ("company_id","resource") WHERE "rk9_coord_leases"."released_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_leases_active_expiry_idx" ON "rk9_coord_leases" USING btree ("expires_at") WHERE "rk9_coord_leases"."released_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_leases_holder_idx" ON "rk9_coord_leases" USING btree ("holder_actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_leases_company_resource_idx" ON "rk9_coord_leases" USING btree ("company_id","resource","acquired_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_lease_waiters_resource_actor_uq" ON "rk9_coord_lease_waiters" USING btree ("company_id","resource","actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_lease_waiters_fifo_idx" ON "rk9_coord_lease_waiters" USING btree ("company_id","resource","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_lease_waiters_actor_idx" ON "rk9_coord_lease_waiters" USING btree ("actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_events_company_id_idx" ON "rk9_coord_events" USING btree ("company_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_events_company_repo_idx" ON "rk9_coord_events" USING btree ("company_id","repo","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_events_company_issue_idx" ON "rk9_coord_events" USING btree ("company_id","issue","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_events_company_type_idx" ON "rk9_coord_events" USING btree ("company_id","type","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_events_company_created_idx" ON "rk9_coord_events" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_events_client_event_uq" ON "rk9_coord_events" USING btree ("company_id","client_event_id") WHERE "rk9_coord_events"."client_event_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_events_dedupe_uq" ON "rk9_coord_events" USING btree ("company_id","type","dedupe_key") WHERE "rk9_coord_events"."dedupe_key" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_cursors_actor_idx" ON "rk9_coord_cursors" USING btree ("actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_inbox_undelivered_idx" ON "rk9_coord_inbox" USING btree ("company_id","id") WHERE "rk9_coord_inbox"."delivered_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_inbox_to_actor_idx" ON "rk9_coord_inbox" USING btree ("to_actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_inbox_from_actor_idx" ON "rk9_coord_inbox" USING btree ("from_actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_inbox_delivered_to_actor_idx" ON "rk9_coord_inbox" USING btree ("delivered_to_actor_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_tokens_active_principal_uq" ON "rk9_coord_tokens" USING btree ("company_id","principal_kind","principal_name") WHERE "rk9_coord_tokens"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_tokens_rotated_from_idx" ON "rk9_coord_tokens" USING btree ("rotated_from_token_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_escalations_episode_uq" ON "rk9_coord_escalations" USING btree ("company_id","episode_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_coord_escalations_company_reserved_idx" ON "rk9_coord_escalations" USING btree ("company_id","reserved_at");
--> statement-breakpoint
-- The journal is append-only (epic RK9-620 contract). State changes are
-- follow-up events (decision-vaulted, escalated), never an UPDATE. A DELETE is
-- allowed only (a) as the cascade of a company delete (the FK action runs as
-- a nested trigger, pg_trigger_depth() > 1), or (b) inside the retention
-- prune transaction, which sets `SET LOCAL rk9.coord_events_prune = 'on'`.
CREATE OR REPLACE FUNCTION "rk9_coord_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND (pg_trigger_depth() > 1 OR current_setting('rk9.coord_events_prune', true) = 'on') THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'rk9_coord_events is append-only (% rejected)', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "rk9_coord_events_append_only_trg" ON "rk9_coord_events";
--> statement-breakpoint
CREATE TRIGGER "rk9_coord_events_append_only_trg" BEFORE UPDATE OR DELETE ON "rk9_coord_events" FOR EACH ROW EXECUTE FUNCTION "rk9_coord_events_append_only"();
