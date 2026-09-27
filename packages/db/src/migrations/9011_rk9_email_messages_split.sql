-- RK9 Custom (RK9-317): finish the fresh-database path of the email_messages split (see 0126
-- and 9000). The fork table created by 9002 becomes "rk9_email_messages" with the same "rk9_"
-- names that 0126 gives on the upgrade path, and the parked upstream table gets its 0272 names
-- back. On a database without "rk9tmp_email_messages" (the upgrade path), this is a no-op.
DO $$
DECLARE
  obj record;
BEGIN
  IF to_regclass('public.rk9tmp_email_messages') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('public.rk9_email_messages') IS NULL AND to_regclass('public.email_messages') IS NOT NULL THEN
    ALTER TABLE "public"."email_messages" RENAME TO "rk9_email_messages";
    FOR obj IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.rk9_email_messages'::regclass AND conname LIKE 'email\_messages\_%'
    LOOP
      EXECUTE format('ALTER TABLE "public"."rk9_email_messages" RENAME CONSTRAINT %I TO %I', obj.conname, 'rk9_' || obj.conname);
    END LOOP;
    FOR obj IN
      SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'public.rk9_email_messages'::regclass AND c.relname LIKE 'email\_messages\_%'
    LOOP
      EXECUTE format('ALTER INDEX "public".%I RENAME TO %I', obj.relname, 'rk9_' || obj.relname);
    END LOOP;
  END IF;
  ALTER TABLE "public"."rk9tmp_email_messages" RENAME TO "email_messages";
  ALTER TABLE "public"."email_messages" RENAME CONSTRAINT "rk9tmp_email_messages_pkey" TO "email_messages_pkey";
END $$;
