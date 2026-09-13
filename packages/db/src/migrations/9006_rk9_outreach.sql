-- RK9-193: outreach data model (prospects, sequences, messages, events,
-- GLOBAL suppression). Additive only — the DB is shared dev/prod.
-- See docs/implementation-notes/outreach-data-model.md.
CREATE TABLE IF NOT EXISTS "outreach_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"org_name" text NOT NULL,
	"business_id" text,
	"email" text NOT NULL,
	"contact_name" text,
	"role" text,
	"source" text NOT NULL,
	"source_url" text,
	"legal_basis" text DEFAULT 'b2b_legitimate_interest' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"enrichment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_contacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sender_identity" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"daily_cap" integer DEFAULT 20 NOT NULL,
	"send_window" jsonb DEFAULT '{"tz":"Europe/Helsinki","days":[1,2,3,4,5],"startHour":8,"endHour":16}'::jsonb NOT NULL,
	"ramp_schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"sequence_id" uuid,
	"step" integer DEFAULT 0 NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"sent_at" timestamp with time zone,
	"message_id" text,
	"in_reply_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"message_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"source_company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_prospects" ADD CONSTRAINT "outreach_prospects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_sequences" ADD CONSTRAINT "outreach_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_prospect_id_outreach_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."outreach_prospects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_prospect_id_outreach_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."outreach_prospects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_message_id_outreach_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."outreach_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "outreach_suppressions" ADD CONSTRAINT "outreach_suppressions_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_prospects_company_email_unique_idx" ON "outreach_prospects" USING btree ("company_id","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_prospects_company_status_idx" ON "outreach_prospects" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_prospects_company_business_id_idx" ON "outreach_prospects" USING btree ("company_id","business_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_prospects_status_created_idx" ON "outreach_prospects" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_sequences_company_name_unique_idx" ON "outreach_sequences" USING btree ("company_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_sequences_company_active_idx" ON "outreach_sequences" USING btree ("company_id","active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_messages_company_status_idx" ON "outreach_messages" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_messages_prospect_idx" ON "outreach_messages" USING btree ("prospect_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_messages_sequence_idx" ON "outreach_messages" USING btree ("sequence_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_messages_message_id_idx" ON "outreach_messages" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_events_company_type_occurred_idx" ON "outreach_events" USING btree ("company_id","type","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_events_prospect_idx" ON "outreach_events" USING btree ("prospect_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_events_message_idx" ON "outreach_events" USING btree ("message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_suppressions_email_unique_idx" ON "outreach_suppressions" USING btree ("email");
