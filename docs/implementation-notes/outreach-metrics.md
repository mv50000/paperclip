# Outreach metrics, auto-pause, DNSBL, digest (RK9-197)

Builds on [outreach-sender.md](./outreach-sender.md) (RK9-194) and
[outreach-inbound.md](./outreach-inbound.md) (RK9-195), both already deployed
to prod. This ticket is explicitly blocked from touching ENGINE (the send
scheduler's decision logic) and INBOUND (the reply/bounce classifier) — the
only ENGINE change here is the one line the auto-pause gate needs in
`scheduler.ts`'s `runQueueDueMessages` loop.

## Why no `prom-client`

CONSTITUTION.md blocks a `pnpm-lock.yaml` change on a feature branch — same
reasoning `outreach-sender.md` gives for hand-rolling the SMTP client instead
of pulling in nodemailer. `services/outreach/metrics.ts` builds the
Prometheus text exposition format by hand (a handful of `# HELP`/`# TYPE`
lines); there's no dependency to add.

## `GET /metrics`

Root path (not under `/api`) — the conventional path a Prometheus scrape
target lives at, same reasoning `unsubscribeRoutes` gives for `/u/:token`
living outside `/api`. Bearer-gated with `OUTREACH_METRICS_API_KEY`, same
fail-closed convention as `outreach-sender.ts`'s `OUTREACH_SENDER_API_KEY`
(401 on every call when unset). Prometheus's `bearer_token_file` scrape
config option supplies the header.

Gauges/counters exposed:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `outreach_sent_total` | counter | `company`, `sender` | Messages with `status='sent'`. |
| `outreach_bounce_total` | counter | `type` (`bounce_hard`/`bounce_soft`) | Bounce events recorded. |
| `outreach_reply_total` | counter | — | Reply events recorded. |
| `outreach_unsubscribe_total` | counter | — | Unsubscribe events recorded. |
| `outreach_queue_depth` | gauge | — | Messages currently `status='queued'`. |
| `outreach_sender_paused` | gauge | `sender` | 1 if that identity is currently auto/manually paused. |
| `outreach_approved_without_sequence` | gauge | `company` | RK9-224: `approved` messages with `sequence_id IS NULL` — the scheduler (`outreach-sender.md`) can never promote these. Should always read 0; drafting resolves a sequence at creation time now, so a nonzero value means a direct `POST .../messages` call bypassed that. |
| `outreach_inbound_unrouted` | gauge | — | RK9-234: inbound mail stored with no `route_key` and no issue — the body is safe, but nobody owns it. Read it in `email_messages`; a nonzero value means an `email_routes` row is missing for that recipient. |
| `outreach_inbound_reply_unmatched` | counter | — | RK9-235: replies that could not be threaded back to a message we sent, so they were dropped. Counted from `activity_log` (action `outreach.reply_unmatched`), never from process memory — a restart must not be able to report a clean zero. Metadata only; the body is not kept in phase 1. Deliberately **not** alerted on yet: this is measurement, and the daily digest carries the same number for the day. |
| `outreach_ip_listed` | gauge | `list` | 1 if the configured sending IP is listed on that DNSBL. **Only exported for a list we can currently query** (RK9-225) — a blind list exports nothing here. |
| `outreach_dnsbl_list_ok` | gauge | `list` | 1 if that list answered both the canary self-test and the reputation lookup; 0 = we are blind to it, so its `outreach_ip_listed` is absent by design. |
| `outreach_dnsbl_selftest_ok` | gauge | — | 1 if the daily canary self-test (127.0.0.2) succeeded on **every** configured list; omitted entirely until the first check has run. |

### PromQL examples (AC: "vähintään PromQL-esimerkit runbookissa")

```promql
# Hard bounce rate over the last 7 days, per sender (mirrors the auto-pause rule)
sum(increase(outreach_bounce_total{type="bounce_hard"}[7d])) by (sender)
  / sum(increase(outreach_sent_total[7d])) by (sender)

# Any sender currently paused
outreach_sender_paused == 1

# Any sending IP currently on a DNSBL
outreach_ip_listed == 1

# The DNSBL checker itself has stopped working (canary should always be listed)
outreach_dnsbl_selftest_ok == 0

# We are blind to a specific list (refused query, DNS failure) — unknown, not clean
outreach_dnsbl_list_ok == 0

# Queue backing up (nothing is draining it — sender daemon down, or everything paused)
outreach_queue_depth > 50

# An approved draft the scheduler can never send (RK9-224 — should never fire)
outreach_approved_without_sequence > 0
```

A Grafana panel is one query away from any of the above — no dashboard JSON
is checked into this repo (Grafana provisioning lives outside it); building
one from these queries is an operator follow-up, not blocked on this PR.

## Auto-pause

Rules (`services/outreach/auto-pause-logic.ts`, pure, unit-tested):

1. **≥1 spam complaint** in a rolling 7 days → pause (`spam_complaint`).
2. **Hard bounce rate >2%** in a rolling 7 days, once ≥10 sent → pause
   (`hard_bounce_rate`).
3. **SMTP 4xx delivery-error rate >20%** in the last 24h, once ≥10 attempts →
   pause (`delivery_error_rate`).

Checked in that order (a single complaint is a compliance signal
regardless of volume; the two rate rules need a minimum sample so 1/1 or 1/3
doesn't read as "100% bounced"). `OUTREACH_AUTO_PAUSE_MIN_SAMPLE = 10`, well
below the AC's own test scenario (3 hard bounces / 100 sent = 3%).

**Scope note on the spam-complaint rule.** The issue text also describes a
reply-body heuristic ("vastauksessa 'spam'/'älä lähetä'"). That can't be
implemented in this PR: a `reply` event's `payload` is deliberately empty
(PII minimization — see outreach-inbound.md), so no reply body text is ever
persisted for this job to scan, and adding that would mean touching
`inbound.ts`/`inbound-classify.ts` (INBOUND), which RK9-197 is blocked from
doing. The rule instead fires on the `complaint` event type, which is
already first-class (`OUTREACH_EVENT_TYPES`) and already wired to suppress
via `applyEventToProspect` — a future inbound ticket that adds the body
heuristic only needs to call `recordEvent(..., { type: "complaint" })`; this
job needs no change when it does.

**4xx delivery-error rate is an approximation, not an exact per-attempt
log.** `markMessageFailed` doesn't record an event for a transient SMTP 4xx
(it just bumps `outreach_messages.attempts`/`lastError` — see
outreach-sender.md). `auto-pause.ts#countDeliveryErrors` counts messages with
`attempts > 0` and a recent `updatedAt` as a proxy for "took a 4xx in the
window", and the rate's denominator is that count plus messages sent in the
same window. This undercounts a message retried more than once in-window
(counted once, not per-retry) and could theoretically misclassify a message
touched for an unrelated reason within the window — accepted precision loss
given the AC only requires the *pause*, not an exact rate.

**Cadence:** `startOutreachAutoPauseCron`, default every 60s
(`OUTREACH_AUTO_PAUSE_INTERVAL_MS`), same interval as the send scheduler —
comfortably inside the AC's "<5 min" requirement. Runs whenever
`OUTREACH_AUTO_PAUSE_ENABLED` isn't explicitly `"false"` (default **on**,
unlike `OUTREACH_SENDER_ENABLED` which defaults off — a read-mostly safety
check is harmless to run even before sending is turned on).

**Gate — two places, not one.** `runQueueDueMessages` fetches all active
pauses once per tick (`listActivePauses`) and skips any sequence whose
`senderIdentity` is currently paused — before the send-window/cap checks, so
a paused identity never even counts against its own daily cap while paused.
That alone isn't enough: a message can already be `status='queued'` (from a
tick *before* the pause tripped) when the pause lands, and `listSendQueue` —
what `GET /outreach/send-queue` hands the rk9-prod sender daemon — is a
separate query with its own gate, excluding any paused identity's rows in
the `WHERE` clause (not filtered after the `LIMIT`, which would otherwise let
one paused identity's backlog starve every other identity's newer messages
out of the daemon's next poll). A message caught mid-queue by a pause simply
waits there — it's still valid, not rejected — and gets served again once
the identity is resumed.

**Resume is always an explicit human action.** `outreach_sender_pauses` has
no expiry column and nothing in this codebase ever sets `resumedAt` except
`POST /api/companies/:companyId/outreach/senders/:senderIdentity/resume`,
which is `assertBoard`-gated (agent keys cannot call it). This holds for
*all three* auto-pause reasons, including `delivery_error_rate` — the issue
text's "pause 24h" for that rule is read as "evaluate the rate over a 24h
window" (see `OUTREACH_DELIVERY_ERROR_WINDOW_HOURS`), not "auto-resume after
24h": a later, more specific instruction from the operator confirmed "resume
vaatii ihmisen eksplisiittisen komennon (API/CLI), ei aikakatkaisua" as the
binding reading.

**Telegram alerting for pauses goes through Alertmanager, not a new Node
integration.** `outreach_sender_paused`/`outreach_bounce_total` are the
signal; an Alertmanager rule (in `rk9-infra`, a separate repo — not this
one, same as `CIWorkflowFailed`) fires `OutreachSenderPaused`/
`OutreachBounceHigh` into the existing rk9claude → Telegram pipeline.
Reference rule (apply as a follow-up in rk9-infra, not part of this PR):

```yaml
groups:
  - name: outreach
    rules:
      - alert: OutreachSenderPaused
        expr: outreach_sender_paused == 1
        for: 1m
        labels: { severity: warning }
        annotations:
          summary: "Outreach sender {{ $labels.sender }} is auto-paused"
      - alert: OutreachBounceHigh
        expr: |
          sum(increase(outreach_bounce_total{type="bounce_hard"}[7d])) by (sender)
            / sum(increase(outreach_sent_total[7d])) by (sender) > 0.02
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Outreach hard-bounce rate for {{ $labels.sender }} exceeds 2% (7d)"
      - alert: OutreachIpListed
        expr: outreach_ip_listed == 1
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Outreach sending IP is listed on {{ $labels.list }}"
      - alert: OutreachDnsblSelfTestFailing
        expr: outreach_dnsbl_selftest_ok == 0
        for: 1h
        labels: { severity: warning }
        annotations:
          summary: "Outreach DNSBL checker's canary self-test is failing — results below are not trustworthy"
      - alert: OutreachDnsblListBlind
        expr: outreach_dnsbl_list_ok == 0
        for: 6h
        labels: { severity: warning }
        annotations:
          summary: "Outreach DNSBL {{ $labels.list }} cannot be queried — that list's reputation is unknown, not clean"
```

`OutreachIpListed` stays a bare `outreach_ip_listed == 1` because the exporter
already refuses to publish an untrustworthy verdict (see below) — the alert
rule needs no gating expression.

## Side-fix: the scheduler's advisory lock never actually locked

While building the first real-Postgres test this codebase has had for
`queueDueMessages`/`listSendQueue`
(`server/src/__tests__/outreach-scheduler-pause-gate.test.ts`), the pause
gate appeared to work — but so did a fully-unpaused control case, which it
shouldn't have. Root cause, pre-dating this PR (RK9-194):
`tryAcquireSchedulerLock` read `(result as { rows? }).rows?.[0]?.locked`, but
`@paperclipai/db`'s client is `drizzle-orm/postgres-js`, whose `execute()`
returns the row array directly — there is no `.rows` wrapper (that shape is
node-postgres's, a different driver). `rows` was always `undefined`, so the
lock check always returned `false`, and every tick logged "already holds the
lock" and skipped — the scheduler has never promoted a single message to
`queued` in this environment. Fixed as a one-line result-parsing correction
(`server/src/services/outreach/scheduler.ts`, `tryAcquireSchedulerLock`); no
send-decision policy (window/cap/ramp/retry) changed. Flagged prominently
here and in the PR because it means RK9-194's scheduler has been silently
non-functional since it shipped, invisible until now because
`OUTREACH_SENDER_ENABLED` defaults off and no prior test exercised it
against a real database.

## DNSBL check

`services/outreach/dnsbl.ts`. Pure `node:dns/promises` — no dependency.
Queries `<reversed-octets>.<list>` (e.g. `2.0.0.127.zen.spamhaus.org`); an
A-record **inside `127.0.0.0/8` but outside `127.255.255.0/24`** means
"listed" (see "Error codes are not listings" below). Runs daily
(`OUTREACH_DNSBL_ENABLED`, default on) plus once ~60s after boot so the
gauges aren't empty for up to a day after a fresh deploy.

**The AC's "hälyttää testilistauksella (127.0.0.2)" is a self-test, not a
reputation check.** `127.0.0.2` is the industry-standard canary address
every real DNSBL is required to list. The checker queries it daily
regardless of whether a production IP is configured; a `false` result means
the check mechanism itself is broken (DNS egress, wrong query construction),
surfaced as `outreach_dnsbl_selftest_ok`. The real reputation check
(`outreach_ip_listed`) only runs when `OUTREACH_DNSBL_CHECK_IP` (rk9-prod's
outbound address) is configured.

### Error codes are not listings (RK9-225)

A DNSBL answers *query errors* with an A-record too, in the reserved
`127.255.255.0/24` range: `127.255.255.254` = "open resolver",
`127.255.255.255` = rate-limited, `127.255.255.252/.253` = malformed query or
missing DQS key. paperclip-01 resolves through a public resolver, so **every**
Spamhaus query — including the `127.0.0.2` canary — came back
`127.255.255.254`. The original code read any A-record as a listing, so the
daily check fired the critical `OutreachIpListed` alert every day from 14.9. to
16.9.2026 while the authoritative answer was "not listed", and
`outreach_dnsbl_selftest_ok` read `1` because the canary "was listed" too. The
self-test was structurally unable to catch the failure it exists to catch.

Three rules now hold:

1. **Classification.** `127.255.255.x` → `error: "query_refused:<code>"`,
   `listed: false`. Anything outside `127.0.0.0/8` (captive portal, wildcard
   DNS) → `error: "unexpected_answer:<codes>"`. Only a genuine `127.0.0.x`
   answer is a listing.
2. **Authoritative retry.** A refused query is retried once against the list's
   own nameservers (`resolveNs` → `Resolver.setServers`), resolved once per
   process. Spamhaus answers us directly there, so zen works again today
   without a DQS key. If that path is ever blocked too, the documented fix is a
   free Spamhaus DQS key and querying `<key>.zen.dq.spamhaus.net` — the list
   names are already env-configurable (`OUTREACH_DNSBL_LISTS`).
3. **Blind is not clean.** The canary runs against **every** configured list,
   not just the first. A list whose canary failed, or whose reputation lookup
   was refused, exports no `outreach_ip_listed` at all and exports
   `outreach_dnsbl_list_ok 0`. An unanswerable list can therefore never look
   healthy and can never fire a listing alert; it fires `OutreachDnsblListBlind`
   instead.

The daily digest reports listings and blind lists on separate parts of one
`DNSBL …` line, and the line is omitted entirely when everything is clean.

State is **in-process, not persisted** — a server restart means the gauges
read as momentarily stale/unknown until the next tick (≤24h), which is an
acceptable gap for a reputation signal that changes on the order of hours to
days, not the auto-pause path (which does persist, because it gates real
sending).

## Daily digest

`GET /api/outreach/digest` (bearer-gated, same `OUTREACH_METRICS_API_KEY` as
`/metrics`) returns per-sender-identity counts for the current Europe/Helsinki
calendar day (sent/bounce/replies/unsubscribes/effective ramp cap/paused) plus
a ready-to-send Finnish `text` field. RK9-224: also `approvedWithoutSequenceTotal`
(the same count as `outreach_approved_without_sequence`, summed across
companies) — nonzero adds a `⚠️ N hyväksyttyä viestiä ilman sekvenssiä` line
to `text`, omitted entirely on a quiet day.

**This repo does not call the Telegram API.** The issue text explicitly names
`rk9_telegram_send`/`bin/rk9-telegram.lib.sh` — a host-level bash helper that
lives in the operator's `~/.claude` config (`rk9-ai/claude-config`), not this
repo, same "ops step, not a repo change" precedent RK9-194/195 set for
deploying the sender daemon / turning on inbound. The follow-up host script
(paperclip-01, per `hosts/paperclip/README.md`'s convention for scheduled
host scripts) is a two-liner:

```bash
#!/usr/bin/env bash
set -euo pipefail
. "$HOME/.claude/bin/rk9-telegram.lib.sh"
text=$(curl -sf -H "Authorization: Bearer ${OUTREACH_METRICS_API_KEY}" \
  http://localhost:3100/api/outreach/digest | jq -r .text)
rk9_telegram_send "$text"
```

...scheduled at 08:00 Europe/Helsinki (systemd timer or cron with `TZ` set).
Writing and installing that script/timer is a follow-up in
`~/.claude/hosts/paperclip/` — out of scope for this repo PR, same as
RK9-194's sender-daemon systemd unit.

## Live verification (operator, after merge)

Scheduler/sender are off in dev (`OUTREACH_SENDER_ENABLED` unset) — simulate
via the existing events API, not real sends:

```bash
# 3 hard bounces against a real message id, from a sequence with a real senderIdentity
for i in 1 2 3; do
  curl -X POST http://localhost:3100/api/companies/$CID/outreach/events \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"prospectId":"'$PID'","messageId":"'$MID'","type":"bounce_hard"}'
done
# then, within ~1 auto-pause tick (≤60s):
curl -H "Authorization: Bearer $METRICS_KEY" http://localhost:3100/metrics | grep outreach_sender_paused
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/companies/$CID/outreach/senders/pauses
```

Note: 3 events against the *same* message id/prospect only produces one
`sent` count in the denominator (a real 3-hard-bounce/100-sent test needs 100
distinct sent messages and 3 distinct hard-bounce events — the AC's number,
not a shortcut this smoke test takes).
