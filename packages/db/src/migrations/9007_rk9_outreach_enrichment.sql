-- RK9-196: personalization + approval gate. A PRH import may land before any
-- address is known (the operator/enrichment step fills it in later), so the
-- prospect e-mail can no longer be NOT NULL. Additive/relaxing only — the DB
-- is shared dev/prod. See docs/implementation-notes/outreach-enrichment.md.
ALTER TABLE "outreach_prospects" ALTER COLUMN "email" DROP NOT NULL;
