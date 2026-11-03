-- RK9-653 (epic RK9-620, operator decision Q6, 2026-11-02): a `recall` scope
-- on the per-host coord tokens, so remote recall (qmd-recall-remote.sh on
-- mv-laptop, htpc and skynet) no longer needs a Paperclip board key.
--
-- A recall token is a separate row with scope = 'recall'. It reaches only
-- POST /api/companies/:companyId/knowledge/recall of its own company (global
-- guard in server/src/middleware/rk9-coord-token-auth.ts). A coord token keeps
-- reaching only the coord routes. A host may hold one active token per scope,
-- so the partial unique index gains the scope column.
--
-- recall_all (parent decision, 2026-11-03): an opt-in flag that only the
-- operator sets when issuing a recall token (token management is
-- instance-admin only). With it, the recall route honours scope:"all"
-- (operator mode: every business collection, read-only) for this token.
-- Without it, scope:"all" stays instance-admin only and the token is
-- company-scoped. The flag is allowed only on a recall-scoped token.
-- ADD COLUMN with a constant default is a catalog-only change (no rewrite).
--
-- Startup safety: the runner applies this file in one transaction
-- (BEGIN ... COMMIT in client.ts). SET LOCAL caps every lock wait at 5 s for
-- this transaction only. If a long-running transaction holds a lock on
-- rk9_coord_tokens, the migration fails with lock_not_available after 5 s,
-- rolls back completely and records nothing; the next start retries it. The
-- DDL is small and additive: a CHECK on a table of a few rows and an index
-- rebuild on the same few rows, no table rewrite and no backfill.
-- Idempotent: DROP ... IF EXISTS before each re-create.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "rk9_coord_tokens" DROP CONSTRAINT IF EXISTS "rk9_coord_tokens_scope_check";
--> statement-breakpoint
ALTER TABLE "rk9_coord_tokens" ADD CONSTRAINT "rk9_coord_tokens_scope_check" CHECK ("rk9_coord_tokens"."scope" in ('coord', 'recall'));
--> statement-breakpoint
ALTER TABLE "rk9_coord_tokens" ADD COLUMN IF NOT EXISTS "recall_all" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "rk9_coord_tokens" DROP CONSTRAINT IF EXISTS "rk9_coord_tokens_recall_all_check";
--> statement-breakpoint
ALTER TABLE "rk9_coord_tokens" ADD CONSTRAINT "rk9_coord_tokens_recall_all_check" CHECK ("rk9_coord_tokens"."recall_all" = false or "rk9_coord_tokens"."scope" = 'recall');
--> statement-breakpoint
DROP INDEX IF EXISTS "rk9_coord_tokens_active_principal_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rk9_coord_tokens_active_principal_uq" ON "rk9_coord_tokens" USING btree ("company_id","principal_kind","principal_name","scope") WHERE "rk9_coord_tokens"."revoked_at" is null;
