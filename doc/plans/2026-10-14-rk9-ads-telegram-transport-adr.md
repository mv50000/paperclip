# ADR: RK9 Ads Telegram transport and gate state machine

Date: 2026-10-14. Issue: RK9-509 (A5 of epic RK9-505). Status: accepted.

## Context

The RK9 Ads plugin activates an ad only after an approver taps a button in
Telegram (G1). The tap goes through the plugin's own state machine in
`gate_requests`, not through core approvals. The code is in
`packages/plugins/plugin-rk9-ads/src/kit/` (G16), so a later plugin can lift it
into a shared package. The ads side (`src/features/telegram/`) maps brand
configs to bots.

## Decision 1: long-poll is the default and the proven mode

Each distinct bot token gets one `getUpdates` loop in the worker. The loop
starts when the worker sets up, is re-planned on a config change, and stops on
shutdown.

- Requests go through `ctx.http.fetch`. That keeps the host's SSRF checks and
  outbound audit. The host has a 30 s RPC timeout and a 30 s fetch timeout, so
  the long-poll timeout is 20 s by default and at most 25 s.
- `allowed_updates` is `["callback_query", "message"]`.
- The SDK does not forward an `AbortSignal` to the host. On shutdown the loop
  therefore drops the in-flight request locally and returns at once. The host
  request ends by itself within the timeout, and the loop ignores its result.
  Telegram confirms an update only through a later `offset`, so a dropped
  batch is delivered again after the restart.
- The offset is stored in plugin state (instance scope, namespace `telegram`,
  key `offset:<botKey>`). `botKey` is a sha256 hash of the token. The loop
  saves the offset after each batch.
- A redelivered update is absorbed by `processed_updates`
  (`UNIQUE (company_id, bot_key, update_id)`, `INSERT ... ON CONFLICT DO
  NOTHING`) and by the compare-and-set on the card.

**Evidence: worker-restart tests** in
`packages/plugins/plugin-rk9-ads/tests/telegram-gate.spec.ts`:

- "saves the offset under the bot-token hash and resumes at last update_id + 1
  after a restart": after a restart, the first `getUpdates` asks for offset
  `last + 1`, and no handler runs again.
- "does not handle an update again when the offset save was lost": the offset
  is reset and Telegram delivers the tap again. The handler still runs once.
- "worker end to end" (real Postgres): the same restart runs through
  `plugin.setup`/`onShutdown` and the host's SQL validators.
  `processed_updates` holds one row for the update.
- "stops within a few seconds on shutdown and calls getUpdates no more".

A live check against the real Bot API was not run. Ololla has no plugin bot
yet (operator TODO below). No public reachability test was run for webhook
mode, which is off (decision 2).

## Decision 2: webhook mode is implemented but off

The independent security review found a high-severity problem. The host's
public webhook route (`server/src/routes/plugins.ts`) writes every delivery
into `plugin_webhook_deliveries` in plain text. The `headers` column holds
`X-Telegram-Bot-Api-Secret-Token`. The `payload` column holds the update,
and a callback update includes `message.reply_markup` with both card tokens.
Someone who reads the database could therefore send a forged, correctly
signed tap and approve spend. The plugin cannot fix this without a core
change, and G1 does not allow core changes. So:

- The worker runs with `webhookMode: "disabled"`. A brand in webhook mode
  gets an error log ("webhook mode is disabled"), and its bot is not
  started. Every delivery to the `telegram` endpoint is refused.
- The code stays and is tested with `webhookMode: "enabled"`:
  - `setWebhook` with `secret_token` (32-256 chars).
  - A constant-time check of `X-Telegram-Bot-Api-Secret-Token`: sha256
    digests are compared with `timingSafeEqual` against every candidate. A
    missing, empty or repeated header is refused and logged.
  - Two bots with the same secret are refused.
  - A token in poll mode for one brand and webhook mode for another is not
    started.
- Webhook mode can be turned on after one of two things exists: a core
  change that stops storing the secret header and the callback payload, or
  an operator decision to accept that risk.

Poll mode never goes through that route. The database then holds only the
token hash, the offset and the update ids.

## Decision 3: never take a bot from another consumer

`setWebhook` silently turns off `getUpdates` for a token (409), and
`deleteWebhook` silently turns off someone else's webhook. Core chat-channels
(`server/src/services/chat-channels.ts`) uses `setWebhook`.
`server/scripts/approval-telegram-listener.mjs` and the Sunspot listener poll
their own tokens. So:

- In poll mode, the plugin calls `deleteWebhook` only for a webhook that it
  set itself. The plugin records the URL as `webhook-owner:<botKey>` in state.
  When some other consumer set the webhook, the plugin logs an error and does
  not start polling.
- In webhook mode, the plugin does not overwrite a webhook that another
  consumer set.
- A 409 from `getUpdates` is logged as an error ("another consumer uses this
  bot token"), and the loop waits 60 s. After two 409s within 10 minutes,
  the loop stops, so two consumers do not keep taking each other's updates.
  A success between the two 409s does not reset the count, because two
  consumers that alternate also get successes. The retry
  timer does not restart that loop. The next config save or worker restart
  does.
- A callback that is not a gate button is left unanswered.

This deviates from the literal acceptance criterion "startup calls
deleteWebhook in poll mode". An unconditional `deleteWebhook` could
disconnect the core bot or the other instance's bot.

**The plugin bot needs its own token.** That token must be separate from the
core chat-channels bot, the approval listener and the Sunspot IG listener. Dev
and prod must use different bots (G17). Brands may share one plugin bot. A
shared token runs one loop, and each tap is checked against the brand of the
card's company.

## Decision 4: the gate state machine

- Statuses (migration 001): `pending` changes to `approved` or `denied` on a
  tap while `valid_until > now()`. `pending` changes to `expired` on a tap
  past `valid_until`. `pending` changes to `failed` when the card cannot be
  sent. `approved` changes to `failed` when the kind handler throws.
- Each transition is one conditional `UPDATE ... WHERE company_id = $1 AND
  token = $2 AND status = 'pending' AND valid_until > now()`. Only the caller
  with `rowCount === 1` continues. Tests cover N parallel taps and one update
  delivered N times, both on the in-memory compare-and-set store and on real
  Postgres.
- The card token is 144 random bits. It travels as `g:a:<token>` or
  `g:d:<token>` in `callback_data` (at most 64 bytes). `gate_requests.token`
  stores only `sha256(token)`, so a database reader cannot forge a tap.
- A tap is checked before anything is written. The bot must serve the card's
  company, the chat must be the brand's chat, and the user must be in
  `allowedUserIds`. A refused tap gets "ei oikeutta", a warning and an
  activity entry. The database stays unchanged.
- The fast path runs first: the plugin answers the callback query and edits
  the card to ⏳ (`editMessageCaption` for photo or video,
  `editMessageText` for text). The plugin also removes the buttons. Then
  the kind handler runs off the poll loop, and the final outcome is edited
  into the card.
- Only an approval runs the kind handler. A denial is final: the card shows
  "❌ Hylätty", and nothing else runs.
- The handler runs at most once. Before it runs, the outcome is set to
  `{ "handler": "started" }`. When that write fails, the handler does not
  run, and the card moves to `failed`. If the worker dies during the handler, the card
  stays `approved` with that outcome, so the handler may or may not have
  acted. The activation item (RK9-517) must make its handler idempotent
  against Meta, and a reconciler must check the ad's real state instead of
  re-running the handler.
- A handler error moves the card to `failed`. The chat sees only
  "⚠️ Epäonnistui". The redacted message (token shapes,
  `access_token=...`, bearer values) goes to the log and the `error` column.
- A brand whose config the host refuses ("unavailable") stays on its bot for
  `pause_all` cards only. Its allowlist may be stale, so it cannot approve
  spend.
- The same hold applies to every brand when a config change arrives and
  when a plan fails. A successful plan lifts the hold.
- The list in memory is not enough for spend. A plan may still run on an
  older read, and the host does not retry a `configChanged` call that failed
  (`server/src/routes/plugins.ts`). So an approval of a kind other than
  `pause_all` re-reads the company's saved config and bot token before
  anything is written. The tap goes on only when both the list in memory and
  the saved config allow it. A failed read refuses the tap (reason `stale`).
  A denial and a `pause_all` approval use the list in memory. A config saved
  in the few milliseconds between that read and the compare-and-set is not
  seen; that gap is accepted.
- One bot can serve several companies in one chat. A tap is checked against
  the brand of the card's company, so an approver of company B cannot decide
  a card of company A.
- Handlers are registered per kind (`registerGateHandler`). The allowed kinds
  are `activate_ad` and `pause_all`. `scale_budget` is refused (G9). A card of
  a kind without a handler is refused, and its state does not change.
- The plugin never calls `ctx.approvals`, and it declares no `approvals.*`
  capability.

## Host facts found on a dev instance

- The host refuses a proactive worker call without an invocation id while any
  invocation is open (`server/src/services/plugin-worker-manager.ts`). Inside
  `onConfigChanged`, `ctx.companies.list` therefore fails with "missing,
  expired, or unknown invocation scope". The plugin plans 500 ms after the
  hook returns, and the retry timer covers a plan that still fails.
- On a dev instance (embedded database, own `PAPERCLIP_HOME`) the worker
  reached `api.telegram.org` through `ctx.http.fetch`. A fake token got 401.
  The loop logged the error without the token and backed off. A config save
  re-planned the bot, and a POST to the webhook route got 502 ("webhook mode
  is disabled").

## Operator TODO

- Create a BotFather bot for the RK9 Ads plugin (prod) and a separate one for
  dev. Store each token as a company secret and bind it in
  `telegram.botTokenRef`.
