ALTER TABLE "email_messages" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "auto_replied_at" timestamp with time zone;