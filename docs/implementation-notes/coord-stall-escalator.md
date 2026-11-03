# Coord stall escalator (RK9-629)

Part of epic [RK9-620](/RK9/issues/RK9-620), wave 5, key `stall-escalator`.
The server finds coord jams that do not resolve on their own and hands them
to the operator. It sends a Telegram message only through rk9claude.

- Service: `server/src/services/rk9-coord-stall-escalator.ts`
- Routes: `server/src/routes/rk9-coord-escalations.ts`, mounted at
  `/api/companies/:companyId/rk9/coord/escalations`
- Bodies: `packages/shared/src/validators/rk9-coord-escalations.ts`
- Tick: `startRk9CoordStallEscalator()` in `server/src/index.ts`, next to the
  lease sweeper
- Ledger: `rk9_coord_escalations` (migration 9015). This child adds no
  migration.
- Tests: `server/src/__tests__/rk9-coord-stall-escalator.test.ts` (fake
  clock, real Postgres, no Telegram)

## Split of work (parent decision 2.11.2026)

| Part | Owner |
|---|---|
| Detector, 30-min threshold, holder nudge, recheck | server (this child) |
| Ledger: reservation, dedupe, 6/day cap, suppression | server |
| One `escalated` journal event per escalation | server |
| Shadow report `GET /escalations`, board list | server |
| Telegram message with its own bot | rk9claude ([RK9-634](/RK9/issues/RK9-634)) |
| Break button: `POST /leases/break` as kind `rk9claude` | rk9claude |
| Delivery result: `POST /escalations/:id/ack` | rk9claude |

The server has no Telegram sender and no Telegram credentials. The rk9claude
bot token stays in one place. No `/etc/paperclip` or systemd change is
needed. The server makes no model calls.

## What is a jam

| Reason | Condition |
|---|---|
| `lease_stuck` | An active lease. At least one waiter still polls (`expires_at` in the future), and the oldest one has waited longer than `stuckS`. The holder is live by the lease engine's own rule. The holder made no progress for `stuckS`: no acquire or renew of the lease, and no presence phase change. |
| `blocker_unanswered` | A `blocker` event older than `stuckS` (and younger than the lookback) with no follow-up. |
| `ask_operator_unanswered` | The same for an `ask-operator` event. |

A follow-up is a later event of the same company that answers the event
(`ref_event_id`, the `reply_to` of ask-operator) or concerns the same issue or
resource, by an author who may follow it up (RK9-657 and
[RK9-662](/RK9/issues/RK9-662), operator decision 3.11.2026):

- **ask-operator:** only an operator-side actor answers: kind `operator`, or
  a `cc` row that is not `unverified` (a paperclip-01 session on the board
  key). Its event must be a `reply_to` of the ask, or concern the ask's issue
  or resource. The asker (or another run of the same agent) closes its own
  question only with a `done` of the question's issue; its phase or decision
  does not answer it.
- **blocker:** the author itself (any later event on the issue or resource,
  or a `reply_to`: the work moved; also another run of the same agent), or
  an operator-side actor as above.

These events never count:

- a `headsup`, an automatic `lease` event, or the escalator's own events;
- any event by an unverified actor (remote host, a `cc:<host>` claim through
  a host coord token, Grok);
- any event by another actor that is not operator-side: an `agent_run`,
  `worktree`, `headless`, `orch` or `rk9claude` event on the same issue. So
  rk9claude's alert blockers and their `done` on a shared ops issue (RK9-677)
  answer and mute no other actor's ask-operator or blocker.

These cases never produce a nudge or an escalation:

- The lease is released, past its TTL, or expires before the recheck.
- The holder is dead (ended presence, terminal agent run, stale advisory
  holder). The sweeper releases its lease.
- The holder renews the lease or changes its phase.
- The waiters stop polling (`rk9 lease wait` timed out or Ctrl-C).
- The event gets a follow-up.
- The event author is `operator` (asking themselves) or `rk9claude` (its
  alerts already reach the operator through its own bot).
- The event author is unverified (remote host, Grok). Its text must not
  reach the operator's chat or use the cap.

A crashed hard-gate holder (kill -9) keeps its lease until the TTL; the lease
engine treats its stale heartbeat as live. That case IS a jam and is
escalated, as `coord-leases.md` intends.

## Stages

Each jam has a base key: `lease:<leaseId>` or `event:<journalId>`. Ledger
rows add `#<n>`.

A round is one nudge, one recheck and at most one escalation.

1. **Nudge.** The holder (for an event: the author) gets an inbox message of
   kind `stall_nudge`, from `orch:rk9-stall-escalator`. A ledger row
   `nudge:<base>#<n>` (reason `holder_nudge`, status `sent`) records the
   time. An author without an actor row gets the message on its issue. If it
   has no issue either, only the ledger row is written.
2. **Recheck.** After `recheckS` the tick evaluates the jam again. If the jam
   is gone, nothing more happens. A nudge covers only its own round. Holder
   progress after the nudge, or an escalation after it, needs a new nudge
   and a new recheck. A holder that renews once and stalls again is
   therefore warned again before any escalation. The nudge takes a per-jam
   advisory lock, so two servers write one nudge.
3. **Escalate.** Under a global advisory lock, the tick checks the cap and
   inserts the ledger row `<base>#<n>`. It writes the `escalated` journal
   event and the activity row in the same transaction. The unique index on
   (`company_id`, `episode_key`) and the lock make a second server or a
   repeated tick lose: one jam gives exactly one escalation per window.

## Ledger semantics

The rules follow `~/.claude/bin/pcp-headsup.sh` `tg_route`: the reservation is
written before the send, and a failed send uses quota. The two ledgers do not
share a cap: pcp-headsup has its own file ledger.

- **Status.** `reserved` (enforce, waiting for rk9claude), `sent` and
  `failed` (rk9claude's ack), `shadow` (shadow mode), `suppressed` (over the
  daily cap, `error = daily_cap`, no journal event).
- **Daily cap.** `RK9_COORD_ESCALATE_DAY_MAX` (default 6, as pcp-headsup
  `TG_DAY_MAX`) over a rolling 24 h. It counts every company together,
  because there is one operator chat. It counts rows of the current mode with
  status `reserved`, `sent`, `failed` or `shadow`. Nudge rows do not count.
- **No retry loop.** The ack moves a `reserved` row to `sent` or `failed`
  once. A second ack is 409. rk9claude never retries a send.
- **Dedupe window.** After an escalation row of any status, the same base key
  gets no new round for `RK9_COORD_ESCALATE_DEDUPE_S` (default 6 h). After
  the window, a new round (`#2`) starts only in two cases:
  - the last escalation never reached the operator (`failed` or
    `suppressed`), so a failed send or the cap does not silence the jam for
    good;
  - no escalation row of the CURRENT mode exists after the jam's last
    progress, for example `shadow` before the switch to `enforce`. A mode
    switch therefore sends each open jam once. A flap (shadow, enforce,
    shadow) or two servers with different modes do not repeat a delivered
    jam, and an unacked `reserved` row is not doubled by a mode round trip;
  - the holder made progress after the last escalation and then stalled
    again (a new episode on the same lease).

  A delivered escalation (`reserved`, `sent`, `shadow`) is not repeated for
  an unchanged jam, so a few open blockers cannot fill the daily cap.
- **Visibility.** A failed or suppressed escalation never vanishes silently.
  It is listed in `GET /escalations` and in `escalations_attention` on
  `GET /board` (a suppressed enforce row shows `error: daily_cap`; a suppressed shadow row is a dry run and is not listed). A `reserved` row
  that rk9claude has not acked within `recheckS` is shown on the board as
  `unacked`. The board stays fail-open: if this list fails, the field is
  null and the rest of the board still answers.
- **Unacked rows.** A `reserved` row that rk9claude never acks (rk9claude
  down) is not escalated again by the server: it stays `unacked` on the
  board for 7 days and in `GET /escalations?status=reserved`, where
  rk9claude's catch-up can still send it.
- **Cap scope.** `cap.used` counts every company, because the cap is
  global. The count is the only cross-company value in a payload. The cap
  window and the row time use the insert time (database clock after the
  lock), not the tick start.

## The `escalated` event

| Column | Value |
|---|---|
| `type` | `escalated` |
| `actor_ref` | `orch:rk9-stall-escalator` (kind `orch`, trust `verified`) |
| `resource`, `issue` | the lease resource and the holder's issue, or the blocker's issue. Null for an ask-operator jam: the question text then reaches only rk9claude and the operator, as the RK9-647 ask-operator visibility rule requires |
| `ref_event_id` | the unanswered event (event jams) |
| `dedupe_key` | `escalation:<episode_key>` |

The payload (agreed with RK9-634):

| Field | Meaning |
|---|---|
| `escalation_id` | ledger row id (uuid): the ack target |
| `episode_key` | `<base>#<n>` |
| `reason` | `lease_stuck`, `ask_operator_unanswered`, `blocker_unanswered` |
| `mode` | `shadow` or `enforce`. rk9claude only logs a shadow event |
| `resource`, `lease_id` | lease jams; null for event jams |
| `holder`, `holder_kind`, `holder_host`, `holder_issue`, `holder_phase` | the holder; for an event jam, the author |
| `waiter`, `waiters` | head waiter and the count of polling waiters |
| `waited_s`, `age_s` | the oldest wait, and the time without progress (or since the event) |
| `breakable` | true only for `lease_stuck` |
| `cap` | `{limit, used, exceeded}`. A capped escalation writes no event, so `exceeded` is false |
| `message` | ready plain text, at most 1000 characters, no `parse_mode` |
| `source_event_id` | the unanswered event |
| `break_command` | `rk9 lease break <resource> --reason "stuck >N min"`, N from `RK9_COORD_STUCK_S` |

Delivery: the delta (`GET /events/delta`) always includes type `escalated`
for kinds `rk9claude` and `operator`. The holder also sees the event through
its issue or held resource. `GET /escalations?status=reserved` is the
catch-up list.

The message names the resource, the holder (kind, host, issue), the phase,
the age, the waiters and the break command. Every client-written field goes
through the coord redaction (`toRk9CoordLine`). The message never holds a
fencing token or prompt text.

## Routes

| Route | Who | Answer |
|---|---|---|
| `GET /escalations?status=&limit=&nudges=` | any coord caller in the company | `{mode, config:{stuck_s, recheck_s, dedupe_s, day_max}, escalations:[…]}`, newest first. Nudge rows only with `nudges=true`. An unverified caller (remote host, Grok) gets no `message` or `error`. |
| `POST /escalations/:id/ack` `{status: sent\|failed, channel_message_id?, error?}` | kinds `rk9claude` and `operator` | 200 the row. 403 `rk9_coord_escalation_ack_forbidden`, 404 `rk9_coord_escalation_not_found`, 409 `rk9_coord_escalation_not_reserved` (already acked, or a shadow or suppressed row). Writes an activity row. |
| `POST /leases/break` `{resource, reason, lease_id?}` | kinds `operator` and `rk9claude` for a live holder (RK9-627) | `lease_id` is new and optional. A different active lease on the resource is 409 `rk9_coord_lease_changed`, and nothing is broken. A late button tap therefore cannot break a new holder. |

The break itself is the lease engine's: a `break` journal event, an
activity row, and promotion of the next waiter. A terminal session is kind
`cc` and gets 403 on a live holder, so the operator's low-effort path is the
Telegram button.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RK9_COORD_ESCALATE_MODE` | `shadow` | `off` starts no tick. `shadow` writes shadow rows and events. `enforce` writes reserved rows for rk9claude to send. Any other value means `shadow`. |
| `RK9_COORD_STUCK_S` | 1800 | Jam threshold. Falls back to `RK9_COORD_LEASE_STUCK_S`. |
| `RK9_COORD_ESCALATE_RECHECK_S` | 600 | Time from the nudge to the escalation. Capped at half the dedupe window. |
| `RK9_COORD_ESCALATE_DEDUPE_S` | 21600 | Quiet time per jam after an escalation. |
| `RK9_COORD_ESCALATE_DAY_MAX` | 6 | Daily cap (0 suppresses everything). |
| `RK9_COORD_ESCALATE_LOOKBACK_S` | 86400 | Older blocker and ask-operator events are ignored. At least 2 × `RK9_COORD_STUCK_S`, the threshold plus two rechecks, and the threshold plus the dedupe window plus two ticks (`RK9_COORD_ESCALATE_INTERVAL_MS`). |
| `RK9_COORD_ESCALATE_INTERVAL_MS` | 60000 | Tick interval. The first tick runs one interval after startup. |

No secret and no token is configured on the server.

## Rollout: shadow to enforce

1. Deploy with the default `shadow`. Nudges run, and shadow rows and events
   are written. rk9claude logs only.
2. Watch `GET /escalations?status=shadow` for a few days. The rate must stay
   well under 6 a day, and every row must be a real jam (operator decision
   2: escalation is the only path to more operator work). False positives,
   such as a legitimate 40-min deploy that holds `prod:<app>` with waiters,
   show up here. Tune `RK9_COORD_STUCK_S` before enforcing.
3. When rk9claude (RK9-634) is deployed with the button handler, set
   `RK9_COORD_ESCALATE_MODE=enforce` in the server environment and restart
   `paperclip.service`.
4. Rollback: `RK9_COORD_ESCALATE_MODE=shadow` or `off`, then restart.
