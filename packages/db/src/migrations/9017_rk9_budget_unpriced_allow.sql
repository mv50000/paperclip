-- RK9-701 (step 3, upstream v2026.1023.0; decision RK9-693 / RK9-707, PR #279 and #281):
-- upstream 0312 adds budget_policies.unpriced_usage_policy with DEFAULT 'block', so one unpriced,
-- non-subscription cost event hard-stops the scope even below 100 %. A claude_local run that
-- reports billing type `api` or none, with no price, is stored as cost_status 'unpriced'. The fork
-- never paused on such usage, and the wanted value after the lift is 'allow'.
--
-- This file sets the column default to 'allow' and moves every existing 'block' row to 'allow'.
-- Every existing row got 'block' from the 0312 default in the same upgrade, so no board choice is
-- overwritten. A board can still set 'block' per policy afterwards (Costs page checkbox).
-- The server create path (services/budgets.ts) uses the same 'allow' default.
--
-- Startup safety: SET LOCAL caps lock waits at 5 s for this file. ALTER COLUMN SET DEFAULT is a
-- catalog-only change; the UPDATE touches a few rows (13 active hard policies on the prod copy).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "budget_policies" ALTER COLUMN "unpriced_usage_policy" SET DEFAULT 'allow';
--> statement-breakpoint
UPDATE "budget_policies" SET "unpriced_usage_policy" = 'allow' WHERE "unpriced_usage_policy" = 'block';
