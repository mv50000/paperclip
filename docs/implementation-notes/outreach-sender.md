# Sequence engine: scheduler, warm-up ramp, SMTP send, unsubscribe (RK9-194)

Builds on [outreach-data-model.md](./outreach-data-model.md) (RK9-193) and
[outreach-enrichment.md](./outreach-enrichment.md) (RK9-196). This ticket adds
the piece those two explicitly left out: **dispatch**. An `approved` message
now actually leaves the building.

## Why two processes, not one

Paperclip's server runs on paperclip-01. Postfix (RK9-192) runs on rk9-prod
and is **loopback-only** — it never accepts a relay connection from another
host, on purpose (no path from a compromised paperclip-01 to the real MTA
except through code we control). So sending splits into two pieces:

1. **Scheduler** (`server/src/services/outreach/scheduler.ts`, in the main
   Paperclip process, gated by `OUTREACH_SENDER_ENABLED`) — the "when and how
   many" decision. Once a minute it promotes `approved` → `queued` for every
   active sequence whose send window is open, up to the sender identity's
   ramp-adjusted daily cap. It has the DB, so it also composes the full raw
   RFC 5322 message (`message-format.ts`) and does the final
   suppression/contactability re-check right before a message leaves the
   queue — "tarkistus lähetyshetkellä, ei vain importissa" per the AC.
2. **`outreach-sender` daemon** (`server/scripts/outreach-sender.ts`, runs on
   rk9-prod) — the "how" of actually talking to Postfix. No DB access at all:
   it polls `GET /api/outreach/send-queue` (bearer `OUTREACH_SENDER_API_KEY`),
   dials `localhost:25` with a hand-rolled SMTP client
   (`services/outreach/smtp-client.ts`, `node:net` only), sleeps a random
   30–180s jitter between messages, and reports the outcome to
   `POST /api/outreach/messages/:id/report`.

Deploying the daemon itself (systemd unit, env file, the
`OUTREACH_SENDER_API_KEY` secret) is an rk9-prod host operation, not a repo
change — document those steps in `~/.claude/hosts/rk9-prod/` per the
CLAUDE.md convention, not here.

## Why no nodemailer

CONSTITUTION.md: a pre-commit hook blocks any `pnpm-lock.yaml` change on a
feature branch (verified: RK9-196's Claude-drafting commit added zero
dependencies and used raw `fetch` for the same reason — see `draft.ts`). The
SMTP dialog needed here is small (EHLO/MAIL FROM/RCPT TO/DATA/QUIT, no
auth, no TLS — Postfix is loopback-only) so `smtp-client.ts` implements it
directly over `node:net`.

## Daily cap is per sender identity, not per sequence

`outreach_sequences.sender_identity` is free text (e.g. `outreach@saatavilla.fi`);
nothing stops two sequences — same or different company — from sharing one.
The scheduler counts today's `sent`/`queued` messages **joined across all
sequences with that identity** (`countSentOrQueuedToday` in `scheduler.ts`),
so the cap is enforced against the identity, matching the AC ("päiväkatto per
lähettäjäidentiteetti"), not against whichever sequence happens to ask first.
A single scheduler tick also tracks what it has already reserved for an
identity in `reservedThisTick`, so two active sequences sharing an identity
can't jointly blow past the cap within one tick.

"Today" is computed in the **sequence's own send-window timezone**
(`zonedDayRange` in `scheduler-logic.ts`), not the server's local day —
otherwise a send near local midnight could double- or under-count depending
on where paperclip-01 happens to live.

## Warm-up ramp epoch

`outreach_sequences.activated_at` (migration `9008`) is set the moment
`active` flips `false → true` (`updateSequence` in `sequences.ts`, guarded in
the same SQL statement so it's race-free) and is **reset**, not preserved, on
every reactivation — pausing a sequence and resuming it later restarts the
ramp from week 1 rather than continuing where it left off. `effectiveDailyCap`
picks the ramp step with the largest `fromDay` that has already elapsed,
falling back to the sequence's own `dailyCap` once the ramp is exhausted (or
if there is no ramp / the sequence was never activated).

## Message state machine — no changes needed

RK9-193's `approved → queued → sent/failed`, `failed → queued` transitions
(`logic.ts#MESSAGE_TRANSITIONS`) already cover everything this ticket needs.
A transient SMTP 4xx does **not** move a message out of `queued` at all — it
just bumps `attempts`/`next_retry_at` (`markMessageFailed` in `scheduler.ts`)
so the send-queue query skips it until the backoff elapses. Only a genuine
5xx (`bounce_hard` event, global suppression via the existing `recordEvent`
path) or exhausting `MAX_SEND_ATTEMPTS` (3) makes it terminal `failed`.

## One-click unsubscribe

`unsubscribe_token` (migration `9008`, nullable + partial unique index) is
assigned lazily — at queue time if missing, so messages drafted before this
ticket shipped still get one the first time they're queued. `GET/POST
/u/:token` (`routes/unsubscribe.ts`) is mounted directly on `app`, not under
`/api`, and never calls `assertCompanyAccess`/`assertBoard` — same pattern as
`resend-inbound.ts`/`ses-inbound.ts`. An unknown or already-used token still
returns the same 200 confirmation page (no token-guessing oracle), and a DB
failure is logged, never surfaced to the prospect. `List-Unsubscribe` /
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) are always set
(`message-format.ts#buildUnsubscribeHeaders`) so a compliant mail client can
unsubscribe without ever visiting the link.

## What's out of scope here

- Actually installing the daemon + Postfix relay on rk9-prod (ops step, not
  code — see the host doc pointer above).
- `outreach@<domain>` inbound processing — a reply/bounce arriving at that
  mailbox is [RK9-195](../../RK9/issues/RK9-195)'s stop-on-reply work, not
  this ticket's.
- Metrics/auto-pause dashboards — [RK9-197](../../RK9/issues/RK9-197).

## Tests

- `server/src/__tests__/outreach-scheduler-logic.test.ts` — send window
  (weekday/hour, tz-aware), warm-up ramp lookup, SMTP code classification,
  retry backoff, jitter bounds, and the local-midnight day-range math. Pure,
  no DB.
- `server/src/__tests__/outreach-message-format.test.ts` — Message-ID/token
  generation, List-Unsubscribe header shape, References threading, and the
  raw RFC 5322 builder (plain vs. multipart/alternative, CRLF-injection
  stripping, no tracking pixels). Pure.
- `server/src/__tests__/outreach-smtp-client.test.ts` — drives the real
  client against a small scripted fake SMTP server (`node:net`) covering the
  full EHLO…QUIT dialog, dot-stuffing, a 5xx RCPT rejection, a 4xx DATA
  rejection, and a refused connection. No real Postfix in CI (CONSTITUTION.md:
  no CI builds on paperclip-01, and there is no Postfix on the CI builders
  either) — the fake server is a faithful enough stand-in for the wire
  protocol; the AC's "3 messages through the real Postfix" is meant to be
  verified live by the operator after merge, using only the operator's own
  test addresses (Postfix isn't warmed up yet).
- `server/src/__tests__/outreach-unsubscribe-route.test.ts`,
  `outreach-sender-routes.test.ts` — routes with the service layer mocked,
  same convention as `outreach-routes.test.ts`.

No test exercises a live Postfix, a live rk9-prod daemon, or sends a real
e-mail.

## RK9-205 addendum: constant-time key check + rk9-prod deployment

`requireSenderKey` originally compared the bearer header with plain `!==`,
a non-constant-time string comparison. Fixed to use `node:crypto`'s
`timingSafeEqual` (length-checked first, since it throws on mismatched
buffer lengths) — see `routes/outreach-sender.ts`. Same fail-closed behavior
when `OUTREACH_SENDER_API_KEY` is unset.

The daemon is now actually deployed on rk9-prod: bundled with esbuild
(`--bundle --platform=node --format=esm --target=node22`) into one dependency-free
`.mjs` file — no new dependency was added here since `esbuild` is already a
root devDependency and the daemon's own dependency chain (`smtp-client.ts`,
`scheduler-logic.ts`) has no native modules or dynamic `require`. Deployment
scripts, the systemd unit, and the env-file convention live in
`~/.claude/hosts/rk9-prod/outreach-sender/` per the pointer above.

## RK9-198 addendum: compliance footer at compose time

Every queued message now gets a footer appended to `bodyText` (and to
`bodyHtml` before `</body>` when there is one) in `listSendQueue`:
the per-message one-click URL (`/u/<token>` — same target as the
`List-Unsubscribe` header, via `buildUnsubscribeUrl`), the "vastaa 'ei kiitos'"
reply opt-out, and a link to the privacy notice (`OUTREACH_PRIVACY_URL`,
default `https://rk9.fi/tietosuoja#outreach`). Done here rather than in the
drafting template because the template forbids links and the token does not
exist before queueing. The sender's identity block (name, company, business
id, town — SVPL 200 §) stays in the template as reviewed prose. Pure helpers
`buildComplianceFooter` / `appendComplianceFooter` in `message-format.ts`, tests
in `outreach-message-format.test.ts`.
