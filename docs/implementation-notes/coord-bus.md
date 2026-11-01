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

Retention is documented here and implemented by a later child. This child has
no UPDATE or DELETE path on the journal.
RK9-626 sets the event, decision and ended-actor periods. The other periods
are proposals for the child that builds the retention job.

| Data | Keep | How |
|---|---|---|
| Events | 90 days | prune transaction with `SET LOCAL rk9.coord_events_prune = 'on'` |
| `decision` and `decision-vaulted` events | at least 1 year | excluded from the 90-day prune |
| Ended actors | 7 days after `ended_at` | DELETE (cascades to their leases, waiters, cursors, inbox) |
| Released leases | 30 days | DELETE |
| Delivered or expired inbox rows | 30 days | DELETE |
| Escalations | 1 year | DELETE |
| Revoked tokens | kept | audit trail; `rotated_from_token_id` chains stay intact |

The prune deletes in batches by `id` and never touches a row newer than the
oldest cursor that is still live.

### ask-operator interface

`ask-operator` is the contract for the separate operator_todo epic. The
journal row carries `summary` (the question in one line) and
`payload = { question, options?, urgency, issue?, actor, reply_to? }`
(RK9-626). The operator_todo view reads these events by
`rk9_coord_events_company_type_idx`; the answer is a follow-up event with
`ref_event_id` set. This epic does not build the view.

## Presence API (RK9-625)

Routes under `/api/companies/:companyId/rk9/coord/actors`. They are mounted
in `server/src/routes/rk9-coord.ts` behind the actor middleware, so company
scope, the RK9-616 loopback rule and the actor claim come from the ADR. The
router reads `req.rk9CoordActor` and never parses `X-RK9-Actor` itself.

- Router: `server/src/routes/rk9-coord-actors.ts`.
- Service: `server/src/services/rk9-coord-presence.ts`.
- Redaction: `server/src/services/rk9-coord-redact.ts`.
- Bodies and query: `packages/shared/src/validators/rk9-coord.ts`.
- Tests: `server/src/__tests__/rk9-coord-actors-routes.test.ts`
  (embedded Postgres).

| Call | Body / query | Answer |
|---|---|---|
| `PUT /actors/me` | `name`, `issue`, `repo`, `branch`, `phase`, `pid`, `liveness_source`, `metadata`; advisory `kind`, `host`, `external_id`, `client_event_id` | 201 on the first insert, 200 after: `{id, actorId, kind, host, trust, created, ttlS}` |
| `POST /actors/me/phase` | `phase` (string or null) | 200 `{id, actorId, phase}`; 404 `rk9_coord_actor_not_found` without an open row |
| `DELETE /actors/me` | optional advisory fields | 204, also when the actor already ended or never registered |
| `GET /actors` | `active` (`1` default, `0` = include ended and stale rows), `repo` (exact, or `<name>` matches `<owner>/<name>`), `issue`, `limit` (1-500, default 200, per source) | `{actors: [row], ttlS}` |

Rules:

- **Key.** The upsert key is (`company_id`, `actor_ref`), the unique index of
  9015. The issue text named (`company`, `host`, `external_id`); the ADR and
  this note win. `host` and `external_id` are derived from the resolved actor:
  `external_id` is the kind-specific part of the actor id. A different client
  id (the CLI sends its session id for a worktree) is kept in
  `metadata.client_external_id`.
- **Advisory fields.** The rk9 CLI (RK9-624) sends snake_case bodies with
  `kind`, `host` and `external_id`; camelCase aliases work too. A badly formed
  value is 422. A well-formed `kind` or `host` that differs from the resolved
  actor is 403 (`rk9_coord_actor_spoof`, `rk9_coord_host_mismatch`).
  Unknown keys are 422.
- **PUT semantics.** An omitted key keeps the stored value, `null` clears it.
  Every PUT refreshes `last_seen_at` and `expires_at`, and clears `ended_at`,
  so PUT is also the presence heartbeat. A `worktree:<issue>` actor gets
  `issue` from its id when the body does not name one.
- **Activity log.** Only the first registration writes `activity_log`
  (`rk9.coord.actor_registered`, entity `rk9_coord_actor`). The upsert offers
  a per-request nonce as the server-set marker
  `metadata.presence_registered_at` and keeps an existing marker (coalesce).
  The request is the first registration exactly when the returned marker is
  its own nonce. So a stub row inserted by another coord route (RK9-626
  inserts a minimal row `ON CONFLICT DO NOTHING`), at any moment, still logs
  exactly one registration, and concurrent first PUTs log once. The activity
  row is written in the same transaction as the marker. Clients cannot set
  the marker. Phase updates, refreshes and ends write no activity rows.
- **Secrets in verbatim fields.** `branch`, `external_id` and `metadata` are
  stored as sent, so a value that matches the redaction pattern is 422
  (`rk9_coord_secret_in_field`) instead of being stored. Control characters
  in `branch` and NUL in `metadata` are 422 too.
- **Trust.** Every write (PUT, phase, end) stores the trust of the current
  writer, so a row never shows a stale higher trust.
- **Liveness.** Live means `ended_at IS NULL AND last_seen_at > now -
  RK9_COORD_PRESENCE_TTL_S`. It is a read rule, so a crashed actor drops out
  after one TTL and no cleanup job runs. Its row stays until retention.
- **Phase and name.** The text is first collapsed to one line: every run of
  whitespace and control characters becomes one space (JS `\s` misses most
  C0 controls, so redacting first would let `Bearer\x01<token>` through).
  It is then matched case-insensitively against `RK9_SESSIONS_SECRET_RX`
  and every match becomes `[redacted]`. `rk9_coord_` tokens are always
  redacted on top. Last, the text is capped: phase at 140 code points, name
  at 200. The raw input limit is
  1000 characters (422 beyond). `phase_at` changes only when the phase text
  changes.
- **Agent runs.** `heartbeat_runs` rows of the company with status `running`
  are projected as `kind=agent_run` rows: agent name, issue identifier from
  `contextSnapshot->>'issueId'` (fallback `taskId`), `runStatus`, `ageS` from
  `startedAt`. A run with no activity (latest of `last_output_at`,
  `updated_at`, `started_at`, `created_at`) for `RK9_COORD_AGENT_RUN_STALE_S`
  is treated as an orphan and left out. A run that registered itself with
  `PUT me` is listed once, as its presence row. After `DELETE me` the run is
  still listed, as a projected row, while it is `running`. `limit` applies to
  each source on its own, so ended presence rows never hide running runs. A `repo` filter excludes
  projected runs, because runs have no repo. The whole list runs in one
  `READ ONLY` transaction, so the projection cannot write. The heartbeat
  service is not changed.
- **Company scope.** Each company sees only its own actors and runs. Agent
  runs of other companies do not appear on the RK9 board; that would need an
  explicit cross-company grant (ADR open point, decided here: no).

Row shape:

```json
{ "actorId": "cc:paperclip-01:<sid>", "kind": "cc", "host": "paperclip-01",
  "name": "...", "issue": "RK9-625", "repo": "paperclip", "branch": "work/RK9-625",
  "repoBranch": "paperclip@work/RK9-625", "phase": "running tests", "trust": "attributed",
  "ageS": 120, "lastSeenS": 4, "runStatus": null, "source": "presence" }
```

`ageS` counts from registration (agent runs: from `startedAt`). `lastSeenS`
counts from the last refresh (agent runs: from the last run activity).

Env vars:

| Variable | Default | Meaning |
|---|---|---|
| `RK9_COORD_PRESENCE_TTL_S` | 300 (10-86400) | presence TTL; the client should refresh at most every TTL/3 |
| `RK9_COORD_AGENT_RUN_STALE_S` | 7200 (0 = off) | orphan cutoff for projected running runs |
| `RK9_SESSIONS_SECRET_RX` | the `rk9-sessions.sh` default | redaction pattern; an invalid JS RegExp falls back to the default |
