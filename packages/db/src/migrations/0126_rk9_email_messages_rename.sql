-- RK9 Custom (RK9-317): upstream v2026.916.1 adds its own "email_messages" table (0272, AgentMail).
-- The fork's Resend mail table (9002) has the same name. On a database that already carries the
-- fork table, rename it to "rk9_email_messages" before 0272 runs. Every index and constraint of
-- the table gets the same "rk9_" prefix. A fresh database has no table yet, so this is a no-op
-- there: 9000 and 9011 handle that path.
DO $$
DECLARE
  obj record;
BEGIN
  IF to_regclass('public.email_messages') IS NULL
     OR to_regclass('public.rk9_email_messages') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_messages' AND column_name = 'endpoint_id'
     ) THEN
    RETURN;
  END IF;
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
END $$;
