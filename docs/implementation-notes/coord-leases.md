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
| `POST /acquire` | `resource`, `ttl_s` (10..86400, default 1800), `reason`, `wait`, `mode` | `{granted:true, lease_id, fencing_token, expires_at, holder, already_held, adopted_from}`, or `{granted:false, queued:true, position, holder, holder_phase, expires_at, eta}`. With `wait=false` and a live holder: 409 `rk9_coord_lease_held` with the same holder fields and no queue entry. |
| `POST /:leaseId/renew` | `fencing_token`, `ttl_s` | `{expires_at}`. 409 `rk9_coord_lease_stale` when the lease is lost. |
| `POST /:leaseId/release` | `resource`, `fencing_token` (optional), `client_event_id` (ignored) | `{released, noop}`. A second release is 200 with `noop:true` and writes nothing. 409 when the lease was lost. |
| `POST /break` | `resource`, `reason` (required) | `{broken, previous_holder, release_reason, promoted}` |
| `POST /validate` | `resource`, `fencing_token` | 200 `{valid:true, holder, expires_at}` or 409 `rk9_coord_lease_stale` |
| `GET /` | `prefix`, `holder`, `resource` | `{leases:[{lease_id, resource, holder, holder_kind, holder_phase, mode, expires_at, expired, fencing_token, queue:[{actor, position}]}]}` |
| `GET /status` | `resource` | one row: `held`, `holder`, `holder_phase`, `expires_at`, `queue`, and the caller's `position` |

- `fencing_token` appears in a list or status row only for the holder itself.
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
- Each transaction reads the DB clock once with `now()` and uses it for
  every comparison. A CLI host with a skewed clock cannot change a lease.

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
| `dequeue` | a dead waiter skipped at promotion |
| `stuck` | the head waiter waited longer than `RK9_COORD_LEASE_STUCK_S` (default 30 min); once per lease (dedupe key `lease-stuck:<leaseId>`), for the escalation child |

- Renew writes no event and no activity row. The spec marks it optional.
  It is frequent and changes no holder.
- An acquire on an expired or dead holder's lease adopts it only when no
  live waiter is ahead of the caller. Otherwise the old lease is released
  (`expire` or `dead_release`), the head waiter is promoted, and the caller
  is queued.
- The fencing token comes from the global sequence
  `rk9_coord_lease_fencing_seq`. A takeover or promotion always gets a
  higher token.

## Liveness

The engine treats a holder or a waiter as dead by this rule:

| Kind | Dead when | Release reason |
|---|---|---|
| `operator` | never (TTL only) | |
| `agent_run` | `heartbeat_runs.status` is `succeeded`, `failed`, `cancelled` or `timed_out`. `interrupted` can resume, and an unknown run counts as live (TTL only). | `heartbeat_run_terminal` |
| `headless` | presence ended, or no signal within the grace period | `headless_run_ended` |
| `remote` | the same | `remote_heartbeat_ttl` |
| other kinds | the same | `presence_stale` |

- A signal is a presence heartbeat (`last_seen_at`), an acquire or renew of
  the lease (holder), or an acquire poll (waiter, stored as the waiter's
  `expires_at`).
- Grace: `RK9_COORD_LEASE_DEAD_GRACE_S`. The default is 3 × the CLI
  heartbeat (`RK9_COORD_HEARTBEAT_S`, default 60 s), but never less than
  the presence TTL (`RK9_COORD_PRESENCE_TTL_S`, default 300 s). An actor
  that presence lists as live is never released as dead.

## Break

The parent decided on 2026-11-02:

- Only actor kind `operator` (a signed-in instance-admin session) and
  `rk9claude` (service token, ADR Q5) may break a live holder's lease. Every
  other kind gets 403 `rk9_coord_break_requires_operator`. So `rk9 lease
  break` from an ordinary terminal (board key, `cc` actor) gets 403 by
  design: one AI session cannot free another session's live `prod:` lease.
- An expired or dead holder needs no break. A non-operator break of such a
  lease runs the sweeper path (`expire` or `dead_release` with the liveness
  reason).
- A break always needs a non-empty reason. It is journaled with
  `release_reason = 'operator_break'` and promotes the next waiter.
- The operator's low-effort path is the Telegram escalation after 30 min
  (the `stuck` event), with a break action through rk9claude. That belongs
  to the escalation child.

## Sweeper

`sweepRk9CoordLeases()` runs on startup and then every
`RK9_COORD_LEASE_SWEEP_INTERVAL_MS` (default 30 s). It is registered in
`server/src/index.ts` and stopped on shutdown. One sweep does this:

1. It expires leases past their TTL (`ttl_expired`). It releases leases of
   dead holders. Then it promotes the next live waiter and dequeues dead
   waiters.
2. It promotes the head of a queue that has no active lease, for example
   after a crash between a release and its promotion.
3. It emits the `stuck` signal.

The sweeper is idempotent and safe across restarts and instances. Each
resource runs in its own transaction under `pg_try_advisory_xact_lock`. A
busy resource is skipped until the next tick. The lease row is re-read
`FOR UPDATE SKIP LOCKED` and the verdict is recomputed. A second sweep over
a swept state changes nothing.
