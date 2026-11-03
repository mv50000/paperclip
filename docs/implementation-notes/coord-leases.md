# Coord lease engine (RK9-627)

Part of epic [RK9-620](/RK9/issues/RK9-620), wave 4, key `lease-engine`.
The engine gives TTL leases with fencing tokens and a FIFO wait queue on the
tables of migration 9015 (`rk9_coord_leases`, `rk9_coord_lease_waiters`).
It exposes primitives only. Gate enforcement (shadow, warn, enforce) belongs
to the gate children.

- Service: `server/src/services/rk9-coord-leases.ts`
- Routes: `server/src/routes/rk9-coord-leases.ts`, mounted at
  `/api/companies/:companyId/rk9/coord/leases`
- Bodies: `packages/shared/src/validators/rk9-coord-leases.ts`
- Tests: `server/src/__tests__/rk9-coord-leases-e2e.test.ts`,
  `server/src/__tests__/rk9-coord-leases-sweeper.test.ts`

## Routes

The field names follow the rk9 CLI (RK9-624, `~/.claude/bin/rk9`, `cmd_lease`).

| Route | Body or query | Answer |
|---|---|---|
| `POST /acquire` | `resource`, `ttl_s` (10..86400, default 1800; a hard gate is clamped to the cap, see [TTL cap](#hard-gate-ttl-cap)), `reason`, `wait`, `mode` | `{granted:true, lease_id, fencing_token, expires_at, holder, already_held, adopted_from}`, or `{granted:false, queued:true, position, holder, holder_phase, expires_at, eta}`. With `wait=false` and a live holder: 409 `rk9_coord_lease_held` with the same holder fields and no queue entry, unless the caller is already queued (then 200 `queued:true`). |
| `POST /:leaseId/renew` | `fencing_token`, `ttl_s` (clamped like acquire) | `{expires_at}`. 409 `rk9_coord_lease_stale` when the lease is lost. |
| `POST /:leaseId/release` | `resource`, `fencing_token` (required for a hard-gate lease, 422 `rk9_coord_lease_fencing_required` otherwise), `client_event_id` (ignored) | `{released, noop}`. A second release is 200 with `noop:true` and writes nothing. 409 when the lease was lost, and 409 when the token is not this lease's, also after the release (RK9-648 R2). |
| `POST /break` | `resource`, `reason` (required), `lease_id` (optional, RK9-629) | `{broken, previous_holder, release_reason, promoted}`. With `lease_id`, a different active lease is 409 `rk9_coord_lease_changed` and nothing is broken. |
| `POST /leave` | `resource` | `{left, resource}` (RK9-648). Same kind and trust checks as acquire. The caller leaves the wait queue (`dequeue` event, `dequeue_reason: left`). Not queued: 200 `left:false`, nothing written. It never releases a lease. |
| `POST /validate` | `resource`, `fencing_token` | 200 `{valid:true, holder, expires_at}` or 409 `rk9_coord_lease_stale` |
| `GET /` | `prefix`, `holder`, `resource` | `{leases:[{lease_id, resource, holder, holder_kind, holder_phase, mode, expires_at, expired, queue:[{actor, position}]}]}` |
| `GET /status` | `resource` | one row: `held`, `holder`, `holder_phase`, `expires_at`, `queue`, and the caller's `position` |

- RK9-684 (item 7): the 6-hourly prune may delete a stale stub actor row
  while an acquire for that actor waits on the row lock; the lease or
  waiter insert then fails on the foreign key. The acquire runs once more
  (a fresh actor row) and, if it loses again, answers 503
  `rk9_coord_lease_retry` (retry the call), never 500.
- Only the acquire answer that grants (or re-reports) the lease carries
  `fencing_token`. List and status rows, journal payloads, event summaries
  and inbox messages never show it; `activity_log` details keep it for
  audit. This limits exposure. It is not authentication: board-key `cc`
  sessions on one host are attributed, not authenticated (ADR), so a
  session that names another session's actor id can still act as it. The
  hard-gate rules guard against accidents, not against a determined local
  session.
- `wait=false` by a caller that is already queued answers 200
  `{queued:true, position}`. Like a `wait=true` poll, it refreshes the
  waiter's liveness (RK9-648 R1). It never enqueues a new waiter.
- `rk9 lease wait` calls `POST /leave` on Ctrl-C, on SIGTERM and on its
  timeout (RK9-648). An older server answers 404 there, and the CLI ignores
  it: the sweeper then removes the waiter after the grace period. The gate
  library splits one enforce wait into chunks; it passes `--keep-place`
  for a chunk and calls `rk9 lease leave` when the whole wait gives up.
- A lease id that does not exist in the company, or is not a UUID, is 404
  `rk9_coord_lease_not_found`. The CLI dead-letters a spooled release on
  that code.
- The error codes are in the ADR table (`coord-identity.md`).

## Resource grammar

The service checks the grammar and answers 422
`rk9_coord_lease_resource_invalid`.

| Prefix | Name |
|---|---|
| `prod:` and `migrate:` | an app or database name, `[A-Za-z0-9][A-Za-z0-9._-]{0,99}` |
| `repo:` | `name` or `owner/name`, optionally `@<branch>` (the CLI hook uses both forms) |
| `vault:` | a relative vault path, no `.` or `..` segment |
| `host:` | a lower-case host name |

Hard-gate prefixes are `prod`, `migrate` and `host`.

## Trust

- Actor kind `grok` may not acquire, wait on, leave, renew, release or
  break any lease, of any prefix, `repo:` and `vault:` included. It gets
  403 `rk9_coord_lease_kind_not_allowed` (RK9-633). Since RK9-648 the
  route checks the kind before the body (400), the resource or reason
  (422) and the lease id (404), so grok cannot probe which lease ids exist. Grok reaches the bus only
  through the vault-mcp proxy, which refuses lease calls itself; the server
  check is the backstop. Kind `remote` keeps the ADR rule: soft prefixes are
  allowed, hard gates are not.
- A hard-gate lease needs `verified` or `attributed` trust. An unverified
  actor gets 403 `rk9_coord_lease_trust_insufficient`.
- An `agent_run` actor needs a run JWT (`verified`) to acquire, renew or
  release a hard-gate lease. An agent key can name any running sibling run
  of its agent, so it gets 403 `rk9_coord_lease_run_jwt_required`. This
  closes the RK9-621 open point. Agent keys may still use `repo:` and
  `vault:` leases.

## Concurrency and clock

- Every change of one (company, resource) runs in one transaction. The
  transaction first takes `pg_advisory_xact_lock` on the resource. Acquire,
  renew, release, break and the sweeper therefore serialize per resource.
- The FIFO order is the waiter `bigserial` id. A position is the rank of
  that id. No position is computed with `MAX()+1`.
- Each transaction reads the DB clock once with `clock_timestamp()`, after
  it has the resource lock, and uses it for every comparison. A CLI host
  with a skewed clock cannot change a lease, and a long lock wait does not
  make the clock stale.

## Transitions

Every transition writes exactly one `rk9_coord_events` row and one
`activity_log` row in the same transaction. The event has `type = 'lease'`
and the subtype in `payload.subtype`. The activity action is
`rk9.coord.lease_<subtype>`.

| Subtype | When |
|---|---|
| `grant` | acquire on a free resource |
| `queue` | first acquire of a waiter; a poll keeps the place and writes nothing |
| `release` | release by the holder |
| `expire` | lease past its TTL (sweeper, or a renew or release that finds it expired) |
| `dead_release` | dead holder (sweeper, or a non-operator break of a dead holder) |
| `adopt` | acquire takes over an expired or dead holder's lease inline; `previous_holder` and `release_reason` are in the payload |
| `break` | operator force-release |
| `promote` | the next live waiter gets the lease; it also gets an inbox row of kind `lease_promote` |
| `dequeue` | a dead waiter skipped at promotion or swept (`dequeue_reason: waiter_gone`), or a waiter that left with `POST /leave` (`left`) |
| `stuck` | the head waiter waited longer than `RK9_COORD_LEASE_STUCK_S` (default 30 min); once per lease (dedupe key `lease-stuck:<leaseId>`), for the escalation child |

- Renew writes no event and no activity row. The spec marks it optional.
  It is frequent and changes no holder.
- An acquire on an expired or dead holder's lease adopts it only when no
  live waiter is ahead of the caller. Otherwise the old lease is released
  (`expire` or `dead_release` event first), the head waiter is promoted
  (`promote` event), and the caller is queued.
- The fencing token comes from the global sequence
  `rk9_coord_lease_fencing_seq`. A takeover or promotion always gets a
  higher token.

## Liveness

### Holder

| Kind | Dead when | Release reason |
|---|---|---|
| `operator` | never (TTL only) | |
| `agent_run` | `heartbeat_runs.status` is `succeeded`, `failed`, `cancelled` or `timed_out`. `interrupted` can resume, and an unknown run counts as live (TTL only). | `heartbeat_run_terminal` |
| `headless` | see the rules below | `headless_run_ended` |
| `remote` | see the rules below | `remote_heartbeat_ttl` |
| other kinds | see the rules below | `presence_stale` |

- **Explicit signal:** the presence row ended (`ended_at`) after the lease
  was acquired or last renewed. An older `ended_at` (a session that ended
  and registered again) does not count.
- **Hard-gate lease** (`prod`, `migrate`, `host`): only the explicit
  signal releases it before its TTL. The CLI heartbeats presence from
  hooks, so a session inside one long tool call (a migration, a deploy)
  looks stale while it still works. A false release there would let two
  migrations run at once. A crashed holder (kill -9) keeps the lease until
  its TTL. The [TTL cap](#hard-gate-ttl-cap) bounds that time, and the
  `stuck` signal and the escalation path cover it when someone queues.
- **Advisory lease** (`repo`, `vault`): also released when neither the
  presence heartbeat (`last_seen_at`) nor the lease activity (acquire or
  renew) is newer than the grace period.
- Grace: `RK9_COORD_LEASE_DEAD_GRACE_S`. The default is 3 × the CLI
  heartbeat (`RK9_COORD_HEARTBEAT_S`, default 60 s), but never less than
  the presence TTL (`RK9_COORD_PRESENCE_TTL_S`, default 300 s).

### Waiter

- A waiter is live only while it polls: every acquire poll sets the
  waiter's `expires_at` to now + grace. Presence does not count. A session
  whose `rk9 lease wait` timed out keeps heartbeating from hooks, but it no
  longer waits, and promoting it would block the resource for a whole TTL.
- A waiter is also dead when its agent run is terminal or its presence
  ended after its last poll.
- A dead waiter is dequeued at the next promotion or by the next sweep
  (`dequeue` event, `dequeue_reason: waiter_gone`). The `stuck` signal
  counts only waiters that still poll.
- **Claim window:** a promoted waiter may already be gone (Ctrl-C on
  `rk9 lease wait`). Its lease first lives for at most the grace period
  and at most `RK9_COORD_LEASE_CLAIM_WINDOW_S` (default 300 s, 30..3600;
  RK9-648 R3, because the grace can be set up to 86 400 s). The holder's
  next acquire poll (`already_held`) extends it to the requested TTL. An
  unclaimed promotion therefore expires after the claim window, not after
  the full TTL.

### Hard-gate TTL cap

- RK9-648: a hard-gate lease (`prod`, `migrate`, `host`) gets at most
  `RK9_COORD_LEASE_HARD_GATE_TTL_MAX_S` (default 21 600 s = 6 h,
  3600..86 400; the floor keeps a holder that renews every 1200 s inside
  the cap). The cap applies to acquire, to the claim poll and to
  renew. A larger request is clamped, not rejected: gate clients ask for up
  to 86 400 s. The answer's `expires_at` shows the clamped time. `repo:`
  and `vault:` keep the full 86 400 s.
- Why: a crashed hard-gate holder keeps the lease until its TTL, and no
  `stuck` signal fires while nobody queues.
- A holder that needs longer renews the lease. The gate library renews at
  `ttl/3`, at most every 1200 s (RK9-648), so it keeps a lease under any
  allowed cap. rk9claude holds a `host:` lease for a scheduled
  reboot for at most 6 h (RK9-656), which fits the default cap.
- Decision (RK9-664, 2026-11-03, the parent on the operator's
  delegation): the default stays 6 h for now. RK9-660 removes
  rk9claude's long reboot hold, and RK9-643 decides whether the cap goes
  lower (for example 1 h, which shortens the worst case of a crashed
  `prod:` or `migrate:` holder).
- Leftovers (RK9-664): a lease or waiter row from before the cap
  (RK9-648) is not clamped after the fact. The cap applies to grant, the
  claim poll and renew only. Parent decision 2026-11-03: shortening a
  granted lease mid-operation could let another actor into the resource,
  and the prod check found no active lease beyond the cap. The queue ETA
  does clamp each waiter's `requested_ttl_seconds` at read time, so an
  old waiter row never adds more than the cap to the ETA.

## Break

The parent decided on 2026-11-02:

- Only actor kind `operator` (a signed-in instance-admin session) and
  `rk9claude` (service token, ADR Q5) may break a live holder's lease. Every
  other kind gets 403 `rk9_coord_break_requires_operator`. So `rk9 lease
  break` from an ordinary terminal (board key, `cc` actor) gets 403 by
  design: one AI session cannot free another session's live `prod:` lease.
- An expired or dead holder needs no break. A non-operator break of such a
  lease runs the sweeper path (`expire` or `dead_release` with the liveness
  reason). A hard-gate break still needs a caller that may hold the lease
  (the trust rules above), so an unverified actor cannot trigger it.
- A break always needs a non-empty reason. It is journaled with
  `release_reason = 'operator_break'` and promotes the next waiter.
- The operator's low-effort path is the Telegram escalation after 30 min
  (the `stuck` event), with a break action through rk9claude. That belongs
  to the escalation child.
  It is documented in `coord-stall-escalator.md` (RK9-629).

## Sweeper

`sweepRk9CoordLeases()` runs on startup and then every
`RK9_COORD_LEASE_SWEEP_INTERVAL_MS` (default 30 s). It is registered in
`server/src/index.ts` and stopped on shutdown. One sweep does this:

1. It expires leases past their TTL (`ttl_expired`). It releases leases of
   dead holders. Then it promotes the next live waiter and dequeues dead
   waiters. It reads every active lease in keyset pages of 500 (at most
   50 000 per sweep).
2. It promotes the head of a queue that has no active lease, for example
   after a crash between a release and its promotion.
3. It emits the `stuck` signal, under the resource lock, after it re-checks
   that the lease is still active.

The sweeper is idempotent and safe across restarts and instances. Each
resource runs in its own transaction under `pg_try_advisory_xact_lock`. A
busy resource is skipped until the next tick. The lease row is re-read
`FOR UPDATE SKIP LOCKED` and the verdict is recomputed. A second sweep over
a swept state changes nothing.
