# Outreach drafts approved from Telegram (RK9-222)

`server/scripts/approval-telegram-listener.mjs` (RK9-85, the `email_send`
approval gate) also posts **outreach drafts** (`outreach_messages.status =
draft`, RK9-196) to the operator's Telegram chat as cards with inline buttons.
Same process, same bot, same `state.json` — one bot token allows exactly one
`getUpdates` consumer, so a second script was never an option.

## Flow

1. Every scan (≥ 20 s apart, paced by the long-poll) lists
   `GET /api/companies/:id/outreach/messages?status=draft` for every company and
   posts the oldest unposted drafts until `OUTREACH_TG_MAX_OPEN` (default 5)
   cards are open. A 20-draft batch therefore shows 5 cards; each decision
   frees a slot and the next card appears on the following scan. The card's
   footer says how many are still queued.
2. Card: company, prospect (`orgName <email>`), subject, body (cut at 3000
   chars), buttons `✅ Hyväksy` / `❌ Hylkää`. `callback_data` is
   `po:a:<messageId>` / `po:r:<messageId>` — the company and prospect ids live
   in `state.postedOutreach[messageId]` (64-byte callback cap). A tap whose
   state entry is gone (state.json lost) is answered with "use the CLI"; the
   listener never guesses a company.
3. `✅` → `POST …/messages/:id/approve`. A `409 prospect_not_contactable`
   means the prospect is still `new`; approving the draft *is* the human
   decision to contact them, so the listener does
   `PATCH …/prospects/:prospectId {status:"approved"}` and retries once —
   the same rule `paperclipai outreach review` applies. The approved message
   is then picked up by the scheduler like any CLI-approved one.
4. `❌` → ForceReply prompt; the reply text becomes `reject_reason`
   (feeds prompt iteration, see `docs/outreach/templates/*.md`).
5. A draft decided elsewhere (CLI review, UI) is closed on Telegram at the
   next scan ("☑️ Käsitelty muualla"). A decision that fails (HTTP error,
   un-promotable prospect) edits the card to ⚠️ and **parks** it: it stays in
   state so it is not re-posted every 20 s, but no longer holds a slot.
6. No `✏️` for outreach: editing a body on a phone is clumsy; use the CLI
   review's `e` action. `pa:` (email_send) handling is untouched.

Only taps from `TG_CHAT_ID` are honoured (existing rule). `OUTREACH_TG_ENABLED=0`
turns the outreach source off without touching email_send approvals.

## Test

`server/src/__tests__/approval-telegram-listener-outreach.test.ts` runs the
real script with `--once` against one mock HTTP server that plays both the
Paperclip API and the Telegram Bot API (`TG_API_BASE` override, test-only).
It covers: cap + ordering + legacy `state.json`, foreign-chat tap, 409 →
promote → approve, ForceReply reject → `reject_reason`, decided-elsewhere
close, parked failure, stale card.

## Deploy

The script has zero repo imports; no server restart is needed:

```
git -C <repo-checkout> pull --ff-only origin master
sudo cp -r <repo-checkout>/. /opt/paperclip/
sudo systemctl restart paperclip-approval-telegram.service
sudo tail -f /var/log/paperclip-approval-telegram.log   # "posted outreach draft …"
```
