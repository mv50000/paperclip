-- RK9-194: outreach sequence engine (scheduler, warm-up ramp, SMTP send
-- bookkeeping, one-click unsubscribe). Additive only — the DB is shared
-- dev/prod. See docs/implementation-notes/outreach-sender.md.
ALTER TABLE "outreach_sequences" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD COLUMN IF NOT EXISTS "queued_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD COLUMN IF NOT EXISTS "unsubscribe_token" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_messages_status_next_retry_idx" ON "outreach_messages" USING btree ("status","next_retry_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_messages_unsubscribe_token_unique_idx" ON "outreach_messages" USING btree ("unsubscribe_token") WHERE "unsubscribe_token" IS NOT NULL;
