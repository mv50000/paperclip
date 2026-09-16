# Personalization + approval gate (RK9-196)

Builds on [outreach-data-model.md](./outreach-data-model.md) (RK9-193). This
ticket adds the pipeline that turns a PRH-prospector export into
operator-reviewed draft messages: **import → enrich → draft → review**. It
still sends nothing — dispatch is a later ticket.

## Why `email` became nullable

RK9-193 required `outreach_prospects.email NOT NULL`. PRH's public register
has no e-mail field at all (GDPR: `~/.claude/skills/prh-prospector/references/gdpr-rules.md`
forbids joining officer names to contact-finding services), so a PRH import
routinely has an org name and nothing to reach it with yet. Migration
`9007_rk9_outreach_enrichment.sql` drops the `NOT NULL` constraint; the
`(company_id, email)` unique index is untouched — Postgres treats every NULL
as distinct, so multiple addressless prospects for one company coexist
without conflict. `packages/shared/src/validators/outreach.ts` and
`server/src/services/outreach/logic.ts#classifyImport` were updated to treat
a missing address as "nothing to dedupe/suppress-check", not a validation
error.

A prospect stays `status: "new"` with `email: null` until either the
enrichment step finds a generic/role address on its own website, or the
operator sets one by hand via the existing `PATCH .../prospects/:id`
(`email` is now one of its editable fields; a collision with another
prospect's address in the same company surfaces as `409 duplicate_email`,
mapped in `updateProspect`'s unique-violation catch).

## Pipeline

1. **Import** (`paperclipai outreach import <file>`) — maps PRH-prospector
   output to `CreateOutreachProspect[]` and calls the existing (RK9-193)
   `POST .../prospects/import`. `cli/src/commands/client/outreach.ts#mapPrhRecordToProspect`
   accepts either `prh-lookup.ts`'s `NormalizedCompany` shape or
   `enrich-fetch.ts`'s `{prh, website}` shape (both external to this repo,
   under `~/.claude/skills/prh-prospector/scripts/`) so the operator can feed
   either script's output straight in. Known AI-enrichment fields
   (`techStack`, `eaaRelevance`, ...) land in `enrichment` verbatim.
2. **Enrich** (`POST .../prospects/enrich`, batch; `paperclipai outreach
   enrich`) — `server/src/services/outreach/enrich.ts` shells out to the
   keyless Firecrawl CLI (`firecrawl scrape <url> -f markdown
   --only-main-content`, no Playwright — see the `/webscrape` skill and
   `~/.claude/skills/prh-prospector`'s own SPA note) for `prospect.sourceUrl`,
   stores a short plain-text excerpt at `enrichment.website.snippet`, and —
   only when `prospect.email` is still null — looks for a *generic/role*
   address (`info@`, `myynti@`, `sales@`, ...; never a `firstname.lastname@`
   or other name-shaped local part, and never a private/free domain — an
   independent adversarial review of this PR flagged an earlier version that
   also accepted `firstname.lastname@` as a GDPR violation, since it is a
   named individual's address by construction; fixed before merge).
   `runFirecrawlScrape`
   is the only network/exec boundary; every other function in this module is
   pure and unit-tested without it (`server/src/__tests__/outreach-enrichment-logic.test.ts`).
3. **Draft** (`POST .../messages/draft`, batch; `paperclipai outreach draft
   --company <slug>`) — `server/src/services/outreach/draft.ts` loads
   `docs/outreach/templates/<company>.md` **as the Claude `system` prompt
   verbatim** (one source of truth for the human-reviewable voice and the
   model instructions — no separate copy in code to drift), asks
   Claude Sonnet 5 (`claude-sonnet-5`, `output_config.effort: "low"`, this is
   light copywriting) for one `SUBJECT:`/`BODY:` message per prospect, and
   creates a `draft` message row. A gate failure (see below) still creates
   the row, immediately rejected with the reason recorded — rejections feed
   prompt iteration per the AC, so they must not be silently dropped.
   `draftMessages` runs prospects **sequentially** and stops once the
   running Anthropic spend estimate reaches `maxCostUsd` (default $1): a
   budget check only means something between requests, not across
   in-flight ones.
   **RK9-223 (14.9.2026):** the user turn also carries the PRH scan's
   `enrichment.providers` (Timma, Slotti, …) and `seg`. A detected system
   makes the template write a *switch* message that names the tool and sells
   the difference (19 €/kk flat, 0 % commission, reminders included); no
   system → the original *start* message. The first 20-draft batch was
   rejected wholesale because 16/20 prospects already had online booking and
   every draft still sold "book without a phone call". The turn also names
   the one link the model may use — the segment demo tenant
   (`hieroja-/jooga-/pt-demo.saatavilla.fi`, beauty → hieroja) or
   `saatavilla.fi` — and the template asks for a checkable observation plus a
   concrete next step instead of "olisiko ajankohtaista".
   **RK9-224 (16.9.2026):** every draft the batch creates now gets a
   `sequence_id` at creation time — an `approved` message with none never
   left `approved`, since the scheduler (`outreach-sender.md`) only reaches
   messages via an active sequence's join. `POST .../messages/draft` takes an
   optional `sequenceId`; if it belongs to the company, drafts attach to it.
   Omitted, `resolveDraftSequence` (`draft.ts`) picks the company's one
   *active* sequence whose `steps[0].templateId` equals the requested
   `company` template — zero or more than one match is ambiguous, so the
   batch 422s `sequence_required` rather than guessing. An explicit
   `sequenceId` from an unrelated company 404s `sequence_not_found`. CLI:
   `paperclipai outreach draft --company <slug> --sequence <id>` (optional).
   The review tool and the Telegram approval card
   (`outreach-telegram-approvals.md`) both show the attached sequence's name,
   or a visible `⚠️ ei sekvenssiä` marker if somehow still missing.

4. **Review** (`paperclipai outreach review`, or ✅/❌ from Telegram — RK9-222,
   `outreach-telegram-approvals.md`) — lists `status: draft`
   messages and lets the operator **a**pprove / **e**dit / **r**eject
   (reason required) / **s**kip / **q**uit, reusing the RK9-193 endpoints
   (`.../messages/:id/approve|reject`) plus two additions this ticket needed:
   `PATCH .../messages/:id` (edit a still-`draft` message; re-checks
   `status = 'draft'` in the WHERE) and the review tool's approve action
   promoting the prospect from `new` to `approved` on demand — the RK9-193
   state machine only lets `approved`/`in_sequence` prospects receive an
   approved message, and approving a specific draft *is* the human decision
   that this prospect is worth contacting, so the CLI does the promotion
   automatically on a `409 prospect_not_contactable` rather than requiring a
   separate prospect-approval step.

## Quality gate (`server/src/services/outreach/quality-gate.ts`)

Pure, DB-free, checked in this order (first failure wins, stored verbatim as
`reject_reason`): `missing_email` → `placeholder_text` (`[yritys]`,
`{{...}}`) → `disallowed_link` (RK9-223: more than one link, or any link
outside `saatavilla.fi`/its subdomains) → `private_email_domain`
(gmail/hotmail/outlook/icloud, per AC) → `suppressed` (global list) →
`too_long` (>120 words, `OUTREACH_DRAFT_MAX_WORDS`). Runs once per draft in `draftMessageForProspect`;
the CLI's `review` command does not re-run it — a gate-passed draft reaching
review is assumed clean, and an edited draft is re-approved by the operator,
not re-gated automatically (a human just read it).

## Cost tracking

`estimateCostUsd` in `draft.ts` uses Claude Sonnet 5's per-token price
($2/$10 per 1M input/output tokens, cached from the `claude-api` skill on
2026-09-13) against `response.usage`. This is an *estimate*, not a billing
record — reverify the constants via that skill if actual Anthropic spend
drifts from what a run reports.

## Templates (`docs/outreach/templates/<company>.md`)

One file per `OUTREACH_TEMPLATE_COMPANIES` slug (`saatavilla`, `alli-audit`,
`ololla`). Each file **is** the prompt sent to Claude — edit the template to
change voice or rules, not `draft.ts`. Company descriptions in the current
templates are a first-pass summary from the RK9 knowledge vault
(2026-09-13); reverify against the company's own docs before the first real
send — every message still clears the human approval gate regardless, so a
rough starting template is a safe default, not a shipped claim.

## Tests

- `server/src/__tests__/outreach-quality-gate.test.ts`,
  `outreach-enrichment-logic.test.ts`, `outreach-draft-logic.test.ts` — pure
  logic, no network/Claude/Firecrawl calls (`runFirecrawlScrape` and the
  Anthropic client are the only exec/network boundaries and are not invoked
  by these tests).
- `server/src/__tests__/outreach-routes.test.ts` — extended with the three
  new routes (`PATCH messages/:id`, `POST prospects/enrich`, `POST
  messages/draft`), services mocked as in the rest of the file.
- `packages/shared/src/validators/outreach.test.ts` — extended for the
  nullable/settable e-mail and the three new schemas.
- `cli/src/__tests__/outreach.test.ts` — the PRH-record mapper, the review
  tool's pure formatting/parsing helpers, and command registration.
- `server/src/__tests__/outreach-draft-sequence.test.ts` (RK9-224, real
  Postgres — see `outreach-scheduler-pause-gate.test.ts` for the embedded-PG
  pattern this follows) — `resolveDraftSequence`'s single/zero/many-match
  cases, `createDraftMessage` persisting the resolved id, and the regression
  this whole issue is about: an `approved` message with `sequence_id = null`
  is never promoted by `queueDueMessages`.

No test exercises Firecrawl or Claude — those calls' cost/nondeterminism keep
them out of CI; the AC's "50 prospects imported/enriched/drafted" numbers are
meant to be verified live by the operator after merge. `outreach-draft-sequence.test.ts`
and `outreach-metrics-approved-without-sequence.test.ts` are the exceptions
that do use a real (embedded, ephemeral) Postgres, skipped automatically on a
host without embedded-PG support.
