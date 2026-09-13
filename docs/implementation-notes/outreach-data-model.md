# Outreach data model (RK9-193)

Foundation for the RK9 B2B outreach module. This ticket ships schema,
migration `9006_rk9_outreach.sql`, zod validators, the company-scoped API and
pure-logic tests. **No e-mail is sent from this code** — dispatch, templates
and enrichment arrive in later tickets (RK9-196+).

## Tables

| Table | Scope | Purpose |
|-------|-------|---------|
| `outreach_prospects` | company | One row per (company, e-mail). Carries the GDPR fields `source`, `source_url`, `legal_basis`. `enrichment jsonb` is reserved for RK9-196. |
| `outreach_sequences` | company | Named campaign: `sender_identity`, `steps [{dayOffset, templateId}]`, `daily_cap`, `send_window {tz, days, startHour, endHour}`, `ramp_schedule [{fromDay, dailyCap}]`, `active`. Unique name per company. |
| `outreach_messages` | company (denormalised `company_id`) | A drafted/approved/sent e-mail to one prospect. `approved_by` + `approved_at` record the reviewer; `reject_reason` is reserved for RK9-196; `message_id` is the RFC 5322 id assigned at send time. |
| `outreach_events` | company | Inbound signals: `bounce_hard`, `bounce_soft`, `reply`, `unsubscribe`, `complaint`, `dsn`. Payload is the raw provider object. |
| `outreach_suppressions` | **GLOBAL** | Permanent opt-out list keyed on lower-cased e-mail. Never deleted. |

Indexes: `(company_id, email)` unique on prospects, `(company_id, name)`
unique on sequences, `email` unique on suppressions, plus company+status
lookups and a `(status, created_at)` index for the retention job.

All e-mails are stored lower-cased and trimmed; the zod schema
`outreachEmailSchema` does the normalisation before the service sees the value.

## Why a separate, global suppression table

`email_suppression_list` (`packages/db/src/schema/email.ts`) already exists,
but it is **company-scoped** (`unique(company_id, address)`) and it backs the
transactional support-desk sender, where a bounce for one company's inbox has
nothing to do with another company.

Outreach is different: every RK9 company sends cold B2B e-mail from the same
sender domain under the same data controller. When a recipient objects
(unsubscribe, complaint) that objection must hold for **all** companies, or we
would re-contact someone who already said no. A global table is the only
structure where that is impossible to get wrong. Re-using the existing table
would have required either copying every entry to every company (drift) or
dropping its company scope (breaking the support-desk semantics). So:

- `outreach_suppressions` has **no `company_id`**. `source_company_id` is
  informational only (who recorded it) and is not used for filtering.
- There is **no DELETE** route or service function. Entries are permanent.
- Because a single write is permanent and cross-company, **agent keys cannot
  write the list**: `POST …/suppressions` is board-only (`assertBoard`), and
  `POST …/events` refuses `unsubscribe`/`complaint`/`bounce_hard` from agent
  actors (inbound e-mail is a prompt-injection surface in this repo). Agents
  may record `reply`/`bounce_soft`/`dsn`. Provider webhooks (RK9-196+) run as
  system, not as an agent.
- Adding a suppression flips every non-terminal prospect with that e-mail —
  in **every** company — to status `suppressed`. Draft creation and approval
  also consult the list directly, so a prospect that is `approved` on paper
  but suppressed cannot get a message.
- The two tables are not synchronised; a support-desk bounce does not block
  outreach and vice versa. If that ever becomes desirable it should be an
  explicit copy job, not a shared table.

## State machines

Prospect status:

```
new ──(manual review)──▶ approved ──(sender, RK9-196)──▶ in_sequence
                                                              │
   reply ──────────────────────────────────────────────▶ replied
   bounce_hard ────────────────────────────────────────▶ bounced      (+ suppression)
   unsubscribe / complaint ────────────────────────────▶ unsubscribed (+ suppression)
   (suppressed = imported while already on the list; import rejects these instead)
```

- Only `new → approved` (and back) is editable through the API, and the
  UPDATE re-checks `status IN ('new','approved')` in its WHERE clause so a
  concurrent bounce or unsubscribe is never overwritten (409
  `invalid_transition`). Event-driven transitions come from
  `POST …/outreach/events` and are guarded the same way on the status that
  was read, so unsubscribe + auto-reply arriving together resolve cleanly.
- `suppressed` is set when an e-mail lands on the global list while the
  prospect is still non-terminal (manual add, or an event from another
  company); import rejects already-suppressed addresses instead.
- `bounced`, `unsubscribed`, `suppressed` are **terminal and sticky**: a later
  reply does not resurrect the prospect. An opt-out on an already-terminal
  prospect still writes the suppression row.
- `bounce_soft` and `dsn` are recorded but change nothing; repeated soft
  bounces are a policy question for the sender ticket.
- `recordEvent` is three autocommit statements; the suppression row is
  written **first**, then the status, then the event row, so a failure
  mid-way never loses the opt-out and a retry is harmless.
- Only `approved` and `in_sequence` prospects are contactable; approving a
  message for any other prospect status returns `409 prospect_not_contactable`.

Message status:

```
draft ──▶ approved ──▶ queued ──▶ sent
  │           │                     ▲
  └─▶ rejected ◀┘        failed ──▶ (queued, retry)
```

`approved`/`rejected` are the only transitions this ticket exposes
(`POST …/messages/:id/approve|reject`). The UPDATE re-checks the current
status in its WHERE clause so two concurrent reviewers cannot both win.
Approval also requires the prospect to be contactable **and** absent from the
global suppression list. `approved_by/approved_at` and
`rejected_by/rejected_at` are separate columns so rejecting an approved
message keeps the original approver on the row. `queued/sent/failed` belong
to the sender.

## GDPR fields and rules

- `source` (`prh` | `web` | `manual`) and `legal_basis`
  (`b2b_legitimate_interest`) are **required** on every prospect; the
  validator rejects anything else. `source_url` should point at the public
  page the address was taken from.
- Only B2B contact data is modelled (organisation, role, generic/work e-mail).
  No personal profile fields beyond `contact_name`/`role`.
- **Retention rule:** prospects in status `new` with `last_contacted_at IS
  NULL` and `created_at` older than `OUTREACH_PROSPECT_RETENTION_DAYS` (180)
  must be deleted. The cron that enforces it is a follow-up ticket; the
  `(status, created_at)` index exists for it.
- **Suppression is exempt from retention** — it is the record that lets us
  honour the objection right, so it is kept for ever.
- Bulk import rejects suppressed addresses up front and reports them by row
  index with reason `suppressed`, so a re-imported list never re-enters an
  opted-out address.

## API

All routes under `/api/companies/:companyId/outreach/`, guarded by
`assertCompanyAccess` (agents of another company → 403, viewer members →
read-only). Every write goes through `validate(schema)` from
`packages/shared/src/validators/outreach.ts` and is audited with
`logActivity` (`outreach.*` actions).

| Method | Path | Notes |
|--------|------|-------|
| GET/POST | `prospects` | list (`?status=&limit=`), create one (409 on duplicate/suppressed) |
| POST | `prospects/import` | ≤1000 rows; returns `{imported, rejected[{index,email,reason}], ids}`; 201 if any row imported, else 200 |
| GET/PATCH/DELETE | `prospects/:id` | PATCH allows `status` only between `new`/`approved` |
| GET/POST | `sequences`, `sequences/:id` (GET/PATCH/DELETE) | 409 `duplicate_name` |
| GET/POST | `messages` | POST creates a `draft`; 409 if the prospect is terminal |
| GET | `messages/:id` | |
| POST | `messages/:id/approve` | 404 / 409 `invalid_transition` / 409 `prospect_not_contactable` |
| POST | `messages/:id/reject` | body `{reason}` (stored in `reject_reason`) |
| GET/POST | `events` | POST records the event and applies the state machine + suppression; returns `{event, prospectStatus, suppressed}`. Agents: informational types only (403 otherwise) |
| GET/POST | `suppressions` | POST is **board-only**, idempotent: 201 created / 200 already present |
| POST | `suppressions/check` | `{emails[]}` → `{suppressed[]}` |

Malformed path ids return 404 (guarded before the query). List `limit` is
clamped to 1..1000 everywhere, including the global suppression list.

Deliberately absent: `DELETE suppressions/:id`, any send/queue endpoint.

**Independent verifier (13.9.2026, pre-merge):** first pass returned FAIL
with one High (agent keys could permanently poison the global list) and four
Mediums (approval ignored the list, unguarded status races, unclamped
suppression limit, event write ordering). All were fixed as described above
before the PR left draft.

## Migration

`packages/db/src/migrations/9006_rk9_outreach.sql` is additive (`CREATE TABLE
IF NOT EXISTS`, FK adds wrapped in `duplicate_object` guards, `CREATE INDEX IF
NOT EXISTS`). The shared dev/prod database gets it on the next
`paperclip.service` restart via the dev runner's auto-apply. Journal entry
idx 78; no drizzle snapshot, matching 9004/9005.

## Tests

- `server/src/__tests__/outreach-logic.test.ts` — import classification
  (100-row batch with in-batch, existing and suppressed duplicates), prospect
  and message state machines.
- `server/src/__tests__/outreach-routes.test.ts` — 100-prospect import via
  HTTP, validation 400s, cross-company 403, viewer 403, approve/reject status
  mapping, suppression idempotency and the absent DELETE route.
- `packages/shared/src/validators/outreach.test.ts` — normalisation, required
  GDPR fields, defaults, size caps.
