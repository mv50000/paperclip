# Inbound outreach mail: replies, DSN bounces, `unsub@` (RK9-195)

Builds on [outreach-data-model.md](./outreach-data-model.md) (RK9-193) and
[outreach-sender.md](./outreach-sender.md) (RK9-194), which explicitly left
this out: *"`outreach@<domain>` inbound processing — a reply/bounce arriving
at that mailbox is RK9-195's stop-on-reply work."*

## Scope: this ticket is Paperclip-side only

The issue text blocks both MTA and DB work for this ticket. Concretely:

- **No migration.** `outreach_events`/`outreach_suppressions`/
  `outreach_prospects.status` (9006) already model reply/bounce/unsubscribe;
  `outreach_messages.message_id` (9006, indexed) already stores the RFC 5322
  `Message-ID` assigned at send time. This ticket adds one lookup function
  (`getMessageByRfc822Id`) and calls the existing `recordEvent` orchestration
  (`events.ts`) — the same function `unsubscribe.ts` already calls.
- **No rk9-prod changes are made by this PR.** Postfix on rk9-prod
  (`~/.claude/hosts/rk9-prod/outreach-mta/`, RK9-192) is currently an
  outbound-only, loopback-only relay. Turning on inbound is an ops step for a
  follow-up ticket — see "rk9-prod side (not done here)" below.

## What the code does

`server/src/routes/outreach-inbound.ts` — `POST /api/outreach/inbound`,
mounted under `/api` next to `outreach-sender.ts`. Raw MIME body (any
content-type, `express.raw` with a 5 MB cap that returns 413), HMAC-signed
with a single shared secret (`OUTREACH_INBOUND_HMAC_SECRET`) — unlike
`resend-inbound.ts`'s per-tenant Svix secrets, this relay speaks for the whole
outreach domain, not one company, so there's no tenant to pick a secret by.
Signature scheme (`inbound-verify.ts`) mirrors `svix-verify.ts`:
`HMAC-SHA256("${timestamp}.${rawBody}")`, hex, header
`X-Outreach-Signature: sha256=<hex>` + `X-Outreach-Timestamp`, 5-minute replay
window, timing-safe compare. Fails closed (401) when the secret is unset,
same as `outreach-sender.ts`'s bearer key. Never lets a parse/processing
failure retry-loop the relay — 200 on everything except a bad signature or an
oversized body, same rule as `ses-inbound.ts`/`resend-inbound.ts`.

`server/src/services/outreach/`:

- `inbound-mime.ts` — parses raw MIME with `mailparser`'s `simpleParser`
  (same tool as `ses-inbound-adapter.ts`; a hand-rolled parser is a footgun),
  extracting the same allowlisted headers (never the full header set — size +
  PII) plus the DSN-relevant bits: the top-level `Content-Type` value/params,
  and the raw content of the first `message/rfc822` attachment, if any.
- `inbound-classify.ts` — pure classification, no DB, no network (same shape
  as `logic.ts`). Order matters:
  1. **DSN** (`Content-Type: multipart/report; report-type=delivery-status`)
     — checked *first*. A real bounce is `From: mailer-daemon@<our domain>`
     `To: <our own sender identity>@<our domain>` by construction (Postfix
     bounces to the envelope sender, an address on our own domain) — checking
     self-loop before DSN would misclassify every real bounce as a loop. This
     was caught by `outreach-inbound-classify.test.ts`'s DSN fixture during
     development, not assumed.
  2. **Self-loop** — sender domain is one of `OUTREACH_INBOUND_OWN_DOMAINS`
     on a *non-DSN* message (see "Adversarial verification" below for why
     this checks the sender's domain directly rather than any recipient
     header — an earlier version that compared against `To`+`Cc` broke on a
     prospect CCing a colleague at their own, unrelated company). Anything
     genuinely from our own domain here is a misconfiguration or a genuine
     loop (the [Ololla mail-loop incident](../../RK9/issues/RK9-190),
     2026-05-12: `info@ololla.fi` → itself → auto-reply → new inbound → ∞,
     22k+ loop messages before the 24h escalation flood). Dropped and logged,
     nothing written to the DB.
  3. **Unsubscribe** — a `To`/`Cc` local-part is `unsub` **and** its domain is
     in `OUTREACH_INBOUND_OWN_DOMAINS` (matches `mailto:unsub@${domain}` from
     `message-format.ts#buildUnsubscribeHeaders`). Fails closed: an
     unconfigured/empty allowlist means this branch never fires — see
     "Adversarial verification" below for why the domain check exists at all.
  4. **Auto-reply/OOO** — reuses `classifyInbound` from
     `../email/junk-guard.ts` verbatim (RFC 3834 `Auto-Submitted`,
     `Precedence`, `List-*`) rather than inventing a second heuristic.
  5. Otherwise: **reply**.

  Also home to the DSN field parser: `mailparser` doesn't recognize
  `message/delivery-status` as an attachment — it folds straight into the
  parsed `text` alongside the human-readable explanation (verified
  empirically, not assumed) — so `parseDeliveryStatusFields` just regexes
  `Action`/`Status`/`Diagnostic-Code` back out of `text`, and
  `classifyDsnSeverity` maps `5.x.x`/`failed` → `bounce_hard`, `4.x.x`/
  `delayed` → `bounce_soft`, everything else (`delivered`/`relayed`) → not a
  bounce at all. `extractOriginalMessageId` prefers the embedded
  `message/rfc822` attachment's `Message-ID` over the DSN's own `References`
  (MTAs generally don't thread the bounce notification itself onto the
  original message).
- `inbound-verify.ts` — the HMAC scheme above, pure.
- `inbound.ts` — DB orchestration. Resolves the specific prospect/message via
  `extractReferencedMessageIds` (reused from `../email/inbound-router.ts` —
  same `In-Reply-To`/`References` parsing the CS-desk pipeline already uses),
  capped to the first 20 candidates, against a single batched
  `getMessagesByRfc822Ids` lookup (`messages.ts`, `inArray`) — see
  "Adversarial verification" for why this isn't one query per candidate. Then
  calls `recordEvent` — exactly what `unsubscribe.ts` already does, and what
  actually stops the sequence: `recordEvent`'s `applyEventToProspect` flips
  the prospect to `replied`/`bounced`/`unsubscribed` (terminal or sticky per
  `logic.ts`), and every future scheduler tick skips a prospect that's no
  longer `approved`/`in_sequence` (`isProspectContactable`) — there is no
  separate "stop the sequence" call to make.
  - A **reply** with no resolvable thread is dropped (`reply_unmatched`) —
    there is no cross-company fallback-by-email lookup; the tested path is a
    threaded reply, and guessing a prospect from an unthreaded sender address
    risks misrouting across companies.
  - **Unsubscribe** tries threading first (precise: a specific
    prospect/company + an event row for audit), and falls back to a direct
    global `addOutreachSuppression(email)` when there's no threading header
    at all — the typical shape for a bare `mailto:unsub@` send from a mail
    client's one-click UI, which usually carries no `In-Reply-To`. The global
    suppression table needs no company/prospect resolution by design (see
    outreach-data-model.md's "why a separate, global suppression table").
  - A genuine **reply** is handed to the existing CS-desk pipeline
    (`createInboundRouter(db).handleEvent(companyId, event, { tenantResolvedBy: "thread" })`
    from `../email/inbound-router.ts`), which is what durably stores the body.
    The `outreach_events` row records only THAT a reply arrived — its payload
    is `{}` and always was.

    > **Correction (RK9-234, 17.9.2026).** This section used to call the
    > handoff "intentionally a no-op" and claim the reply was "fully recorded
    > via `recordEvent` regardless of whether the handoff finds a route". Both
    > halves were wrong, and together they cost us the RK9-198 pilot's first
    > prospect reply. `recordEvent` records the event, not the message: the
    > sender's actual words had no home. And the handoff was not a no-op
    > waiting on data — it could never have succeeded, because
    > `handleReceived` re-checked the recipient domain against the company's
    > own `primary_domain` and outreach replies always arrive at the shared
    > `outreach.rk9.fi`. The reply was classified, counted and discarded, and
    > the digest reported it as `vastauksia 1`.

    Two things changed:

    1. **The tenant is proven by threading, not by domain.**
       `tenantResolvedBy: "thread"` tells the router that `companyId` came
       from matching the reply's `In-Reply-To` to an outreach message we sent,
       which carries its own `company_id` — a stronger binding than a domain
       comparison. The SES/Resend callers keep the default
       (`recipient_domain`), where the check is genuine tenant defence.
    2. **Storage no longer depends on configuration.** `handleReceived`
       persists the `email_messages` row first and routes second. A missing
       route now costs the issue, the assignee and the auto-reply — never the
       body. The result is `stored_unrouted`, counted by
       `outreach_inbound_unrouted` in `/metrics` and called out in the daily
       digest, so an unowned reply is visible instead of silent.

    Migration `9010_rk9_outreach_inbound_routes.sql` seeds one `email_routes`
    row per outreach sender identity, with a NULL agent and a NULL auto-reply
    template on purpose: a warm reply to a cold outreach mail is the one thing
    a human must answer, so no robot ever answers it and no agent run is
    burned. `escalate_after_hours` 24 emails the operator if it sits unanswered.

    Still wrapped in try/catch so a handoff failure never loses the
    `recordEvent` write.

## Config

| Env var | Purpose | Unset behavior |
|---|---|---|
| `OUTREACH_INBOUND_HMAC_SECRET` | Shared HMAC secret for the rk9-prod relay | Route 401s every request (fail closed) |
| `OUTREACH_INBOUND_OWN_DOMAINS` | Comma-separated, lower-cased domains treated as "ours" — drives BOTH the `unsub@` classifier and the mail-loop guard (e.g. `outreach.rk9.fi`) | `hasUnsubscribeRecipient` never matches (fail closed); `isSelfLoop` falls back to a weaker `To`-only proxy (fail open on an unlisted domain) |

Plain server env vars, same as `OUTREACH_SENDER_API_KEY` — **not** a
Paperclip `company_secrets` row (there's no per-company secret model here;
one secret speaks for the whole outreach domain), so the DB-level
`encrypt-secret` helper (`feedback_encrypt_secret_helper` in the operator's
vault) doesn't apply. Generate the HMAC secret with `openssl rand -base64 32`
and set it identically in Paperclip's server env (paperclip-01) and the
rk9-prod receiver script's env — same two-host deployment shape as
`OUTREACH_SENDER_API_KEY`. `OUTREACH_INBOUND_OWN_DOMAINS` only needs to exist
on paperclip-01 (it's not part of the signed request). **Operational
requirement**: list every domain and subdomain outreach mail can legitimately
be sent from (not just the primary one) — an unlisted own domain makes the
mail-loop guard fall back to a weaker `To`-only heuristic for messages
claiming that domain (see "Adversarial verification" below).

## rk9-prod side (RK9-206, done)

RK9-206 turned on inbound for `outreach.rk9.fi` on rk9-prod. Summary (full
detail in `~/.claude/hosts/rk9-prod/outreach-mta/README.md`):

1. **Hetzner Cloud Firewall `rk9-prod-edge`**: `25/tcp` inbound allowed.
2. **Postfix**: `inet_interfaces = all`, `mydestination` widened to include
   `outreach.rk9.fi`, `transport_maps` routes that domain to a `pipe`
   transport invoking `outreach-inbound-receiver.sh`, which reads the piped
   raw MIME from stdin and does:
   ```
   POST http://paperclip-01.rk9.fi:3100/api/outreach/inbound
   Content-Type: message/rfc822
   X-Outreach-Timestamp: <unix seconds>
   X-Outreach-Signature: sha256=<hex hmac-sha256("$timestamp.$rawBody", secret)>

   <raw MIME bytes>
   ```
   (`paperclip-01.rk9.fi`, not `paperclip.rk9.fi` or a bare tailnet IP — see
   `outreach-sender/README.md`'s routing note, same host, same constraint.)
   `smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination`
   stays in place unchanged — it blocks open-relay abuse, not inbound delivery
   to `mydestination`, so accepting inbound for `outreach.rk9.fi` doesn't
   reopen the relay.
3. The shared secret (`OUTREACH_INBOUND_HMAC_SECRET`) exists in both places:
   the receiver script's environment on rk9-prod, and Paperclip's server env
   on paperclip-01.
4. **SPF + DKIM verification**: OpenDKIM runs in `Mode sv` (sign outbound,
   verify inbound) and `postfix-policyd-spf-python` runs as an
   `smtpd_recipient_restrictions` policy service — each prepends its own
   `Authentication-Results:` header. A `smtpd_header_checks` rule strips any
   `Authentication-Results:` header already present on an incoming message
   *before* those two run, so only our own trusted rk9-prod filters can ever
   write one — an attacker can't forge a pre-baked `spf=pass dkim=pass` header
   into the raw MIME to fake authentication. This closes H1 below.

## Adversarial verification (RK9-195, sensitive-diff gate)

This route accepts raw, unauthenticated (from the mail sender's point of
view) internet content and can trigger a *global, permanent, cross-tenant*
side effect (`outreach_suppressions` has no DELETE by design), so it was
pre-classified sensitive and run through an independent adversarial verifier
before merge. Findings and disposition:

- **H1 (fixed)** — the HMAC only authenticates the Postfix-relay hop, not the
  mail's claimed sender; nothing checked DKIM/DMARC/SPF/`Authentication-Results`
  (none of that plumbing existed on the loopback-only rk9-prod Postfix at the
  time — MTA-side, blocked for RK9-195). The verifier also found
  `hasUnsubscribeRecipient` matched `unsub@` on **any** domain, not just our
  own, letting a forged `To:` header suppress an arbitrary address regardless
  of what Postfix actually accepted. **Fixed (RK9-195)**:
  `hasUnsubscribeRecipient` now takes an `ownDomains` allowlist
  (`OUTREACH_INBOUND_OWN_DOMAINS`) and fails closed when unconfigured.
  **Fixed (RK9-206)**: the other half — a forged `From:` on a message
  addressed to a real `unsub@outreach.rk9.fi` could still trigger a
  suppression-by-email for whatever address it claims — is now closed by
  `hasVerifiedAuthentication` (`inbound-classify.ts`), which requires both
  `spf=pass` and `dkim=pass` in the `Authentication-Results` header rk9-prod's
  Postfix now adds (see "rk9-prod side" above), gating the address-based
  (no-threading) `unsub@` fallback in `inbound.ts` and failing closed
  (`unsubscribe_skipped_unauthenticated`) when the header is missing or either
  check fails. The threaded `unsub@` path isn't gated the same way — it never
  derives its suppression target from the forgeable `From:` header, it
  requires guessing a real Message-ID already sent to that specific prospect.
- **H2 (fixed)** — an attacker-controlled `References` header with tens of
  thousands of ids drove `extractReferencedMessageIds`'s O(n²) dedup, then one
  sequential DB query per id — measured at 14.6s of event-loop blocking and
  60,000 queries for a 769KB body, under the 5MB cap, with the route
  otherwise unrate-limited. Fixed with two independent caps plus a batch:
  the raw `References` header is truncated to 2000 chars before it ever
  reaches `extractReferencedMessageIds` (`inbound-mime.ts`), the resulting
  candidate list is capped to 20 (`inbound.ts`), and the lookup is one
  batched `inArray` query (`getMessagesByRfc822Ids`) instead of N sequential
  ones.
- **M2 (fixed)** — the self-loop and unsub guards only inspected `To`,
  missing a `Cc`-only bypass. The unsub guard now checks `To`+`Cc`.
- **H3 (new — introduced by the first M2 fix attempt, caught on
  re-verification, now fixed)** — the first attempt at M2 also extended the
  *self-loop* guard to `To`+`Cc`, which broke on a prospect who reply-alls
  and CCs a colleague at their own company: the sender and that Cc share a
  domain unrelated to us, but the old recipient-domain-matching proxy
  matched anyway and silently dropped the reply (and, worse, a genuine
  `unsub@` opt-out CC'd the same way). Fixed by giving `isSelfLoop` direct
  access to `ownDomains` and checking the sender's domain against it
  directly — no recipient header involved at all — with the pre-M2
  `to`-only proxy kept as a fallback for when `ownDomains` is unconfigured.
- **L1 (fixed)** — `recordEvent`'s `{ok:false}` result was discarded at all
  3 call sites, silently masking a dropped write. Now logged via
  `logIfEventNotRecorded`.
- **L2 (fixed)** — the 401 response body echoed the specific rejection
  reason to an unauthenticated caller. Now a generic `{error:"unauthorized"}`;
  the reason is logged server-side only.
- **Third-round Medium (documented, not fixed)** — with `ownDomains`
  configured but incomplete, the loop guard's fallback proxy is gone for
  listed domains, so a genuine loop between two addresses on an own domain
  that ISN'T listed slips through as a normal reply. Not fixable by
  restoring the old `To`-domain-matching proxy alongside the `ownDomains`
  check (that reintroduces H3 on listed domains) — the correct fix is
  operational: `OUTREACH_INBOUND_OWN_DOMAINS` must enumerate every domain and
  subdomain outreach mail can be sent from. Documented above and in
  `config.ts`'s JSDoc.
- **M1** (forged-sender DSNs honored as real bounces if the attacker already
  knows a real Message-ID), **M3** (a DSN whose original message is quoted
  only in `text/plain`, with no `message/rfc822` attachment, is dropped as
  unmatched rather than extracted), **L3** (the rk9-prod receiver script
  built in RK9-206 treats any non-2xx response, including a 413, as
  `EX_TEMPFAIL` and lets Postfix's own queue retry/backoff handle it — this
  wasn't re-verified against a live Postfix queue), and **L4** (no
  replay/idempotency window beyond the 5-minute HMAC check) are **not** fixed.
  Each is a genuine defense-in-depth nice-to-have with no immediate exploit
  path once H1/H2 are closed — tracked as follow-up work, not blocking.

## Tests

- `outreach-inbound-classify.test.ts` — classification order (including the
  DSN-vs-self-loop fixture above), the `ownDomains`-scoped/fail-closed
  `hasUnsubscribeRecipient` (H1), `Cc`-only self-loop/unsub matches (M2), the
  `References`-header truncation (H2), DSN field parsing/severity,
  original-Message-ID extraction, `hasVerifiedAuthentication`'s pass/fail/
  missing-header cases and its two-separate-headers join (RK9-206), and
  `parseInboundMime`'s `Authentication-Results` extraction (RK9-206). Real
  MIME fed through `mailparser`, not mocked.
- `outreach-inbound-verify.test.ts` — HMAC accept/reject paths, fail-closed
  on missing secret, replay-window rejection.
- `outreach-inbound-logic.test.ts` — DB orchestration with `messages.ts`/
  `events.ts`/`suppressions.ts`/`inbound-router.ts` mocked at the module
  boundary (same convention as `outreach-sender-routes.test.ts`): every
  classification branch, the CS-desk handoff failing without losing the
  primary write, the mail-loop guard never touching the DB, the threading
  candidate cap collapsing to one batched query (H2), unsub@ on a
  foreign/unconfigured domain never reaching `addOutreachSuppression` (H1),
  a discarded `recordEvent` failure getting logged (L1), and the
  address-based unsub@ fallback skipping `addOutreachSuppression` when
  `Authentication-Results` is missing or SPF/DKIM don't both pass (RK9-206).
- `outreach-inbound-route.test.ts` — HTTP layer: 401 on bad signature (before
  any parsing) with a generic body (L2), 413 over 5 MB, 200 that echoes the
  classifier outcome, 200 (never a retry-triggering 5xx) when processing
  throws.

No test exercises a live Postfix or a live rk9-prod relay — same limitation
`outreach-sender.md` documents for the outbound side, for the same reason
(CONSTITUTION.md: no CI builds on paperclip-01, no Postfix on the CI
builders). The AC's "vastaus testiviestiin päätyy Paperclipiin oikean
prospektin alle <2 min" end-to-end check is for the operator to verify live,
after the rk9-prod side above is actually installed.
