-- RK9-319: a heartbeat run that received untrusted external content (inbound
-- email, outreach reply) is marked tainted by the server. A tainted run's
-- outward actions (email send/reply, GitHub credential export, write-level
-- tool calls) always go through an existing approval gate.
--
-- A fork table instead of new heartbeat_runs columns: the upstream table stays
-- byte-identical for upgrades, and the snapshot drift test ignores fork tables.
-- One row per run. No route writes this table from agent input, and no code
-- path deletes or clears a row: the mark is monotonic for the life of the run.
CREATE TABLE IF NOT EXISTS "rk9_run_taints" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tainted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_run_taints" ADD CONSTRAINT "rk9_run_taints_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_run_taints" ADD CONSTRAINT "rk9_run_taints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "rk9_run_taints" ADD CONSTRAINT "rk9_run_taints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rk9_run_taints_company_agent_idx" ON "rk9_run_taints" USING btree ("company_id","agent_id","tainted_at");
