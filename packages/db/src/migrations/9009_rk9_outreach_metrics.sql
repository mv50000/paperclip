-- RK9-197: outreach metrics + auto-pause. Additive only — the DB is shared
-- dev/prod. See docs/implementation-notes/outreach-metrics.md.
CREATE TABLE IF NOT EXISTS "outreach_sender_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_identity" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resumed_at" timestamp with time zone,
	"resumed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_sender_pauses_active_identity_unique_idx" ON "outreach_sender_pauses" USING btree ("sender_identity") WHERE "resumed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_sender_pauses_identity_idx" ON "outreach_sender_pauses" USING btree ("sender_identity");
