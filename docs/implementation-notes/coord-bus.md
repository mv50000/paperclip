# Coord bus: data model (RK9-623)

Part of epic [RK9-620](/RK9/issues/RK9-620), wave 2, key `coord-schema`.
This note describes the tables of the RK9 coordination bus. Later children
add their own sections (API, CLI, hooks, gates) below this one.

- Identity contract (frozen names, actor_id grammar, trust, tokens):
  [`coord-identity.md`](coord-identity.md).
- Migration: `packages/db/src/migrations/9015_rk9_coord.sql`.
- Drizzle schema: `packages/db/src/schema/rk9_coord.ts`.
- Embedded-Postgres test: `packages/db/src/rk9-coord-migration.test.ts`.

Sibling notes in claude-config (`~/.claude/docs/implementation-notes/`):
`session-board.md` (the file board this epic replaces), `wake-context.md`,
`headsup-shadow.md`, `orchestrator-lifecycle.md`. This note lives in the
paperclip repo next to the ADR, because the schema and the server code live
here. `~/.claude/docs/implementation-notes/coord-bus.md` only points here.

## Data model

### Ground rules

- **One migration.** 9015 is the only migration of the epic. It creates every
  table and column the later children need. Fork migrations are hash-pinned in
  `packages/db/src/fork-migration-hashes.json`, so 9015 never changes once it
  is applied. A missing column is a comment on the epic and a new 9016, never
  an edit of 9015.
- **RK9-only tables.** All eight tables are new `rk9_coord_*` tables. No
  upstream table is altered, so upstream upgrades stay conflict-free and the
  snapshot drift test ignores them.
- **Company scope.** Every table has `company_id uuid NOT NULL` with an FK to
  `companies(id) ON DELETE cascade`. Every query filters on `company_id`.
- **Schema and SQL in sync by hand.** The Drizzle file must match the SQL
  exactly. Two objects exist only in the SQL, because the drift test cannot
  filter them by table: the sequence `rk9_coord_lease_fencing_seq` and the
  trigger `rk9_coord_events_append_only_trg`.
- **Identifiers are text.** `issue` (e.g. `RK9-623`) and `repo`
  (`owner/repo`) are text, not FKs: they name tickets and repos of any company
  or outside Paperclip.
- **Actor references.** `actor_ref` is the full actor_id string of the ADR
  grammar (`cc:paperclip-01:<sid>`, `worktree:RK9-623`, `operator`, ...).
  Tables that point at a live actor use an `*_actor_id uuid` FK to
  `rk9_coord_actors`. The journal and the inbox sender also keep the
  `actor_ref` text, so history survives when the actor row is deleted.

### Tables

| Table | Key | Purpose |
|---|---|---|
| `rk9_coord_actors` | `id` uuid; unique (`company_id`, `actor_ref`) | Presence: one row per actor |
| `rk9_coord_leases` | `id` uuid; partial unique (`company_id`, `resource`) WHERE `released_at IS NULL` | TTL leases with fencing tokens |
| `rk9_coord_lease_waiters` | `id` bigserial (FIFO order); unique (`company_id`, `resource`, `actor_id`) | Wait queue per resource |
| `rk9_coord_events` | `id` bigserial (the cursor) | Append-only journal |
| `rk9_coord_cursors` | PK (`company_id`, `actor_id`) | Last event id an actor has seen |
| `rk9_coord_inbox` | `id` bigserial | Messages for actors that are not live |
| `rk9_coord_tokens` | `id` uuid; `token_hash` unique; partial unique (`company_id`, `principal_kind`, `principal_name`) WHERE `revoked_at IS NULL` | Hashed coord tokens (ADR column list) |
| `rk9_coord_escalations` | `id` uuid; unique (`company_id`, `episode_key`) | Telegram escalation ledger |

#### rk9_coord_actors

- `kind`: CHECK in the ADR kind enum `cc | worktree | headless | agent_run |
  orch | remote | rk9claude | grok | operator`.
- `actor_ref`: 1 to 200 characters, and its first `:` part must equal `kind`.
  The API validates the full grammar with `parseRk9CoordActorId` before the
  insert.
- `host`: the host the server attributes the actor to (a DNS label), null for
  `agent_run` and `operator`. `external_id`: the kind-specific part of
  `actor_ref` (session, issue, run or name), at most 128 characters.
- Uniqueness is (`company_id`, `actor_ref`), not (`company_id`, `host`,
  `external_id`): `actor_ref` already encodes kind, host and id, and a
  nullable `host` would let duplicate rows through a three-column unique
  index (NULLs are distinct). The presence API upserts on this key.
- `trust`: `verified | attributed | unverified`, as the actor middleware
  resolved it.
- `agent_id` (FK `agents`, cascade) and `run_id` for `agent_run` actors.
  `run_id` has no FK, because heartbeat runs are pruned on their own schedule.
  The lease engine can check lease ownership by agent id (RK9-627 comment).
- `phase` at most 140 characters, `phase_at` when it last changed (stall
  detection, RK9-629). `name`, `issue`, `repo`, `branch` are length-capped.
- `pid` (positive), `liveness_source` (a lower-case token such as `hook`,
  `pid`, `tmux`, `heartbeat_run`, `cli_ttl`, `service_ttl`), `metadata` jsonb
  for extras such as the tmux window id (RK9-630).
- `last_seen_at`, `expires_at`, `ended_at`. An actor is live when
  `ended_at IS NULL` and `last_seen_at` is inside the TTL.

#### rk9_coord_leases

- `resource`: CHECK `^(prod|migrate|repo|vault|host):[^[:space:]]+$`, at most
  300 characters. Forms: `prod:<app>`, `migrate:<db>`,
  `repo:<owner/repo>@<branch>`, `vault:<note>`, `host:<node>`.
- `holder_actor_id`: FK `rk9_coord_actors`, cascade.
- `fencing_token`: bigint, default `nextval('rk9_coord_lease_fencing_seq')`.
  The sequence is global, so the token is monotonic per resource across
  releases and takeovers. Never reset it.
- `mode`: `shadow | warn | enforce` (default `enforce`; `repo:` leases of
  worktrees use `warn`, RK9-630).
- `reason` at most 300 characters, `acquired_at`, `renewed_at`, `expires_at`.
- `released_at` and `release_reason` are set together (CHECK). The reason is
  a lower-case token: `released`, `ttl_expired`, `presence_stale`,
  `heartbeat_run_terminal`, `headless_run_ended`, `remote_heartbeat_ttl`,
  `operator_break`, ...
- **Expiry vs the partial unique index.** An expired lease that nobody has
  released still blocks the resource. The acquire path of the lease engine
  (RK9-627) must, in one transaction: release the expired or dead-holder row
  (`release_reason = 'ttl_expired'` or the dead-holder reason), then insert
  the new lease. A concurrent second insert fails with `unique_violation`
  (23505, `rk9_coord_leases_active_resource_uq`); treat it as "taken".
- Index for the expiry sweep: (`expires_at`) WHERE `released_at IS NULL`.

#### rk9_coord_lease_waiters

- FIFO by the bigserial `id`: never compute a position with `MAX()+1`.
- One row per (`company_id`, `resource`, `actor_id`).
- `mode`, `reason`, `requested_ttl_seconds` (positive), `enqueued_at`,
  `expires_at` (a waiter TTL). Dequeue and promotion delete the row; the
  journal records the transition.

#### rk9_coord_events

- `id` bigserial is the cursor. Ids are increasing, not gap-free.
- `type`: CHECK in `decision | deploy | handoff | blocker | done |
  ask-operator | lease | phase | break-glass | decision-vaulted | escalated |
  headsup` (`headsup` amended by RK9-623 for RK9-636).
- `actor_ref`, `actor_kind`, `trust` of the author. `trust` uses the three
  ADR levels. A "verified=false" flag in a child spec maps to `unverified`.
- `issue`, `repo`, `resource` (resource CHECK as on leases), `summary`
  (1 to 300 characters, one line), `payload` jsonb (per-type fields).
- `client_event_id`: client id for spool replay, partial unique per company.
  A replay that hits `rk9_coord_events_client_event_uq` is a duplicate, not
  an error.
- `dedupe_key`: producer dedupe (the heads-up observation key, the rk9claude
  alert key), partial unique per (`company_id`, `type`).
- `ref_event_id`: the earlier event that a follow-up refers to
  (`decision-vaulted`, `escalated`). No FK, so the prune never cascades.
- `vault_path`: set on a `decision` written with `--vault` in one step. The
  later `decision-vaulted` event carries the commit and the final path.
- `occurred_at`: client time of a spooled event; `created_at` is server time.
- Heads-up fields of RK9-636 (`class` `operator|other`, `class_rule`, the
  observed actor) live in `payload`; only the dedupe key is a column.

**Append-only.** The trigger `rk9_coord_events_append_only_trg` rejects
every UPDATE and every DELETE with SQLSTATE 23001 (`restrict_violation`).
Two DELETE paths are allowed:

1. the FK cascade of a company delete (it runs as a nested trigger,
   `pg_trigger_depth() > 1`);
2. the retention prune, which runs in its own transaction with
   `SET LOCAL rk9.coord_events_prune = 'on'`.

State changes are follow-up events, never an UPDATE.

#### rk9_coord_cursors

- PK (`company_id`, `actor_id`), `last_event_id` bigint (default 0), cascade
  with the actor. A read that consumes the delta advances the cursor in the
  same transaction; a peek does not.

#### rk9_coord_inbox

- Exactly one target (CHECK `num_nonnulls(...) = 1`): `to_actor_id` (FK,
  cascade), `to_issue` (delivered once, to the first actor that registers with
  that issue) or `to_name` (an orchestrator or service name).
- `from_actor_id` (FK, set null) plus `from_actor_ref` text, so a message
  keeps its sender when the sender's row is deleted.
- `kind`: a lower-case token, default `message` (also `lease_promote`,
  `nudge`, ...). `body`: 1 to 500 characters, redacted before insert.
- `delivered_at` and `delivered_to_actor_id` (FK, set null). Claim with
  `WHERE delivered_at IS NULL ... FOR UPDATE SKIP LOCKED`.

#### rk9_coord_tokens

Exactly the ADR column list. CHECKs: `principal_kind` in (`host`,
`service`); a host name is a DNS label, a service name is `rk9claude` or
`grok`; `token_hash` is 64 lower-case hex characters; `token_prefix` is 14
characters starting with `rk9_coord_`; `scope` is `coord`; `label` at most
200. `rotated_from_token_id` is a self-FK (set null).

#### rk9_coord_escalations

- `episode_key`: one row per stuck episode (e.g. `<resource>#<lease id>`),
  unique per company. The stall escalator inserts the row as a reservation
  **before** it sends, so a second process loses on the unique index.
- `reason` (lower-case token), `resource`, `issue`, `mode` (`shadow |
  enforce`), `status` (`reserved | sent | failed | suppressed | shadow`),
  `event_id` (the journal row, no FK), `message` (at most 1000),
  `channel_message_id`, `error`, `reserved_at`, `sent_at`.
- The daily cap (6/day, RK9-629) counts rows by (`company_id`,
  `reserved_at`). A failed send still counts.

### Indexes and the delta query

The hook delta (RK9-626) reads only what is new for the actor:

```sql
SELECT id, type, actor_ref, issue, repo, resource, summary, created_at
FROM rk9_coord_events
WHERE company_id = $1
  AND id > $2                       -- the actor's cursor
  AND (repo = $3 OR issue = $4 OR resource = ANY($5))
ORDER BY id
LIMIT 20;
```

It uses `rk9_coord_events_company_repo_idx` (`company_id`, `repo`, `id`) and
`rk9_coord_events_company_issue_idx` (`company_id`, `issue`, `id`) through a
BitmapOr, and `rk9_coord_events_company_id_idx` (`company_id`, `id`) for the
unfiltered board view. `rk9_coord_events_company_type_idx` serves per-type
views such as the open `ask-operator` list.

Other indexes: live actors (`company_id`, `last_seen_at`) WHERE `ended_at IS
NULL`; leases by holder and by (`company_id`, `resource`, `acquired_at`) for
history; waiters FIFO (`company_id`, `resource`, `id`); undelivered inbox
(`company_id`, `id`) WHERE `delivered_at IS NULL`; and one index per actor
FK, so an actor delete does not scan the referencing tables.

### Retention

RK9-626 implements the retention job in
`server/src/services/rk9-coord-retention.ts` (`pruneRk9Coord`). The server
runs it on startup and every 6 hours. The periods below are the ones it uses.
Escalations and revoked tokens are not pruned yet.

| Data | Keep | How |
|---|---|---|
| Events | 90 days | prune transaction with `SET LOCAL rk9.coord_events_prune = 'on'` |
| `decision` and `decision-vaulted` events | at least 1 year | excluded from the 90-day prune |
| Ended actors | 7 days after `ended_at` | DELETE (cascades to their leases, waiters, cursors, inbox) |
| Released leases | 30 days | DELETE |
| Delivered or expired inbox rows | 30 days | DELETE |
| Escalations | 1 year | DELETE |
| Revoked tokens | kept | audit trail; `rotated_from_token_id` chains stay intact |

The prune deletes in batches of 5,000 by `id`. It does not wait for old
cursors: an actor whose cursor points at a pruned event simply continues
with the oldest remaining one. A re-run over pruned data deletes nothing.

### ask-operator interface

`ask-operator` is the contract for the separate operator_todo epic. See
"ask-operator JSON schema" under the journal API below. This epic does not
build the view.

## Journal and inbox API (RK9-626)

Part of epic [RK9-620](/RK9/issues/RK9-620), wave 3, key `journal-inbox-api`.

- Routes: `server/src/routes/rk9-coord-{events,inbox,board}.ts`, mounted in
  the sibling block of `server/src/routes/rk9-coord.ts`.
- Services: `server/src/services/rk9-coord-journal.ts` (append, delta, line
  format, board), `rk9-coord-inbox.ts` (send, claim),
  `rk9-coord-retention.ts` (prune), `rk9-coord-text.ts` (redaction).
- Bodies: `packages/shared/src/validators/rk9-coord-journal.ts`.
- Tests: `server/src/__tests__/rk9-coord-journal.test.ts` and
  `rk9-coord-inbox.test.ts` (embedded Postgres).

Every route runs behind the actor middleware of the ADR
([`coord-identity.md`](coord-identity.md)): company scope, the RK9-616
loopback rule and the actor claim. A route that acts as an actor needs a
resolved actor. A board-key call without `X-RK9-Actor` gets 400
`rk9_coord_actor_required`. Request and response fields are snake_case.

### Free text

Every free-text field (titles, rationale, summaries, questions, message
bodies) is redacted, collapsed to one line and capped before the insert. No
model is called.

- The pattern is the `RK9_SESSIONS_SECRET_RX` default of `rk9-sessions.sh`
  (RK9-549). The env var overrides it on the server too. An invalid value
  falls back to the default. `rk9_coord_` tokens are always redacted.
- Matches become `[redacted]`. Whitespace, control, zero-width and bidi
  characters collapse to one space.
- Caps: `summary` 300, each payload text field 500 (`rationale` 1000), an
  inbox `body` 500 characters. A cut ends with `…`.

### POST /events

Appends one event. The body is a zod discriminated union on `type`. An
unknown type, a server-only type (`lease`, `phase`, ...) or a missing
required field is 400. Common optional fields: `client_event_id`,
`occurred_at` (ISO time of a spooled event), `repo` (`owner/repo`).

| type | Required | Optional | summary |
|---|---|---|---|
| `decision` | `title`, `rationale` | `issue`, `vault_note` (stored in `vault_path`) | title |
| `deploy` | `app`, `sha` (7–40 hex), `result` (`started`, `success`, `failure`, `rolled_back`) | `issue` | `<app> <sha7> <result>` |
| `handoff` | `issue`, `summary` | `to` | `-> <to>: <summary>` |
| `blocker` | `issue`, `what` | | what |
| `done` | `issue` | `pr` (number or URL) | `PR #<n>` |
| `ask-operator` | `question`, `urgency` | `options`, `issue`, `reply_to` | `[<urgency>] <question>` |

- Answer: 201 `{ event, duplicate: false }`. A repeat of a stored
  `client_event_id` is 200 `{ event, duplicate: true }` with the stored row.
  This is the spool dedupe of the rk9 CLI.
- `trust` comes from the server, never from the body. Rows of a host coord
  token (also its `cc` claims) and of Grok are always `unverified`.
- Each new event writes one `activity_log` row
  (`rk9.coord.event_appended`).
- There is no PATCH, PUT or DELETE route; those methods get the coord 404.
  The DB trigger rejects UPDATE and DELETE as well (see "Append-only").

### ask-operator JSON schema

This is the interface for the separate operator_todo epic. The natural
producer is the heads-up and stall path of
[RK9-608](/RK9/issues/RK9-608); the rk9 CLI accepts the type as
`rk9 log ask-operator`. This epic builds no consumer.

```json
{
  "type": "ask-operator",
  "question": "Merge PR #244 now or wait for the deploy window?",
  "options": ["merge now", "wait"],
  "urgency": "low | normal | high | urgent",
  "issue": "RK9-626",
  "actor": "worktree:RK9-626",
  "reply_to": 1234
}
```

- `question` and `urgency` are required. `options` has 1–10 entries of at
  most 200 characters.
- `actor` is always the resolved caller. A client value is ignored.
- `reply_to` is the journal id of the event this one follows up. It is also
  stored as `ref_event_id`.
- The stored row has `type = 'ask-operator'`, `summary = "[<urgency>]
  <question>"` and the fields above in `payload`. A consumer lists open asks
  with `rk9_coord_events_company_type_idx`. The answer is a follow-up event
  whose `ref_event_id` points at the ask.

### GET /events/delta

Returns the events after the caller's cursor that concern it:

- events whose `repo` is the actor's repo, or whose `issue` is the actor's
  issue (the presence row, or the issue in `worktree:<issue>`);
- events whose `resource` is a lease the actor holds now;
- every `deploy` and `ask-operator` event;
- never the actor's own events.

Query: `peek=1`, `fmt=line`, `limit` (1–100, default 20), and `repo` and
`issue` as extra filters for a caller whose presence row has none yet.
`actorId` is optional. When given, it must equal the resolved actor (403
`rk9_coord_actor_spoof`): it never selects another actor's cursor.

- The cursor row is read FOR UPDATE, and the cursor moves in the same
  transaction to the newest company event the read saw. Two concurrent calls
  of one actor serialize, so the event goes to one of them. An immediate
  second call is 204.
- `peek=1` reads without a lock and leaves the cursor as it is.
- A new cursor starts at the newest event older than 24 hours, so a new
  session is not flooded with old history.
- JSON: `{ events, total, more, cursor, previous_cursor, peek }`. `events`
  holds the newest `limit` matches in ascending id order. `total` counts all
  matches after the old cursor.
- Nothing new: 204 with an empty body, also with `fmt=line`.
- The actor row: when the caller has no row in `rk9_coord_actors`, the
  route inserts a stub (kind, actor_ref, host, trust; ON CONFLICT DO
  NOTHING). The presence API (RK9-625) owns every other column.
- Known limit: event ids come from a sequence. An event whose transaction
  commits after a newer id is already visible can be skipped by a cursor
  that has passed it. Appends are single-row autocommits, so the window is
  tiny. The board shows everything.

### Line format (`fmt=line`)

`text/plain`, at most 400 characters (~100 tokens), newest event first:

```text
rk9: deploy: saatavilla 1a2b3c4 success @SAA-12 · blocker RK9-626: waits for 9015 @cc:3f9e2a1b · +7 more: rk9 board
```

- One item per event: `<type>[ <issue>]: <summary> @<short actor>`. Short
  actor: the issue for a worktree, `cc:<8 chars of the session>`,
  `run:<8 chars of the run id>`, else the actor id.
- Items are joined with ` · `. When matches do not fit, the line ends with
  `+N more: rk9 board`. N counts every match after the old cursor that the
  line does not show.
- A single first item that is too long is cut with `…`.

### POST /inbox

Body: `{ to, body, kind?, issue?, expires_in_s? }`. `to` resolves in this
order:

1. **Issue identifier** (`RKI-9`): an inbox row with `to_issue`. The first
   actor that claims with that issue gets it, exactly once.
2. **`agent_run:<runId>`**: a Paperclip agent. The message becomes a comment
   on the run's issue (`contextSnapshot.issueId`), or on `issue` when given.
3. **Other actor id**: `to_actor_id` when the actor has a row, else
   `to_name = <actor id>`. The actor gets it when it claims.
4. **Name**: when a coord actor has that `name`, an inbox row with `to_name`.
   Otherwise, when an agent of the company has that name
   (case-insensitive), a comment on `issue`, which is then required. Otherwise
   an inbox row with `to_name` for a future actor of that name.

Answer 201: `{ delivery: "inbox" | "issue_comment", id, to: { kind, value },
target_live, name, issue, comment_id }`. `target_live` is true when the
target is a live coord actor now (`ended_at IS NULL` and `last_seen_at`
within `RK9_COORD_PRESENCE_TTL_S`, default 300 s). `name` is its session
name. The CLI uses both to suggest SendMessage instead.

Paperclip agent targets:

- The comment goes through `issueService.addComment`. It is authored by the
  board user or the calling agent, and one `activity_log` row
  (`rk9.coord.message_commented`) records it. No inbox row is left.
- The comment does not wake the agent. The agent sees it on its next
  heartbeat, so a message never buys a heartbeat run.
- A coord-token caller cannot write comments (403
  `rk9_coord_kind_not_allowed`), per the least-privilege rule of the ADR.
- No issue: 422 `rk9_coord_inbox_issue_required`. Run or issue not found:
  404 `rk9_coord_inbox_target_not_found`. The rk9 CLI dead-letters a
  spooled write only on that 404 code.

Each inbox row also writes one `activity_log` row (`rk9.coord.inbox_sent`).

### GET /inbox/me

Claims every pending message for the caller and marks it delivered:

- rows with `to_actor_id` = its row, `to_name` = its actor id or its name,
  or `to_issue` = its issue;
- not expired, at most 50 per call, ascending id.

One statement claims the rows:
`UPDATE ... SET delivered_at, delivered_to_actor_id WHERE delivered_at IS NULL
AND id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`. Two simultaneous
claimers never get the same row (tests: two claimers on one issue message,
and five claimers on 30 messages).

Answer: 200 `{ actor, messages: [{ id, kind, body, from, name, target_live,
to, created_at }] }`, or 204 when nothing is pending. `name` and
`target_live` describe the sender, for a SendMessage reply.

### GET /board

The full view for an explicit `rk9 board`. Hook paths never call it. It
returns live actors, active leases with holder phase and FIFO queue, the
newest events (`?events=`, default 20) and the pending inbox. Unverified
viewers (remote hosts, Grok) get the inbox without message bodies.
