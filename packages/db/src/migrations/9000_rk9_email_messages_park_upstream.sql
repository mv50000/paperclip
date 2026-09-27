-- RK9 Custom (RK9-317): fresh-database path of the email_messages split (see 0126).
-- Upstream 0272 has created its AgentMail "email_messages" table, and the fork's 9002 will
-- create a table with the same name. Park the upstream table as "rk9tmp_email_messages" until
-- 9011 swaps both tables to their final names. Only the table and its primary key are renamed:
-- no other upstream index or constraint name collides with 9002. On a database that already
-- has "rk9_email_messages" (the upgrade path), this is a no-op.
DO $$
BEGIN
  IF to_regclass('public.rk9_email_messages') IS NOT NULL
     OR to_regclass('public.rk9tmp_email_messages') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_messages' AND column_name = 'endpoint_id'
     ) THEN
    RETURN;
  END IF;
  ALTER TABLE "public"."email_messages" RENAME TO "rk9tmp_email_messages";
  ALTER TABLE "public"."rk9tmp_email_messages" RENAME CONSTRAINT "email_messages_pkey" TO "rk9tmp_email_messages_pkey";
END $$;
