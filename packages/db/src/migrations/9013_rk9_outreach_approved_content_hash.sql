-- RK9-475: fingerprint of the approved outreach content. Additive only — the
-- DB is shared dev/prod. NULL = approved before this migration; the send queue
-- skips the check for those rows. See docs/implementation-notes/outreach-sender.md.
ALTER TABLE "outreach_messages" ADD COLUMN IF NOT EXISTS "approved_content_hash" text;
