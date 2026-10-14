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
yet (operator TODO below). Webhook mode has unit tests only. No public
reachability test was run.

## Decision 2: webhook mode is optional and mutually exclusive per token

`telegram.mode: "webhook"` needs `webhookSecretRef` and an https `webhookUrl`
(the plugin route `/api/plugins/<pluginId>/webhooks/telegram`). On startup
the plugin calls `setWebhook` with `secret_token`. A delivery is accepted only
when `X-Telegram-Bot-Api-Secret-Token` matches. The check compares sha256
digests with `timingSafeEqual` against every candidate. A missing, empty or
repeated header is refused and logged. A token that one brand uses in poll
mode and another in webhook mode is not started. The plugin logs an error.

The host stores every webhook request's headers in
`plugin_webhook_deliveries`, including the secret header. That is one more
reason to prefer poll mode.

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
  bot token"), and the loop waits 60 s before the next try.

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
- Handlers are registered per kind (`registerGateHandler`). The allowed kinds
  are `activate_ad` and `pause_all`. `scale_budget` is refused (G9). A card of
  a kind without a handler is refused, and its state does not change.
- The plugin never calls `ctx.approvals`, and it declares no `approvals.*`
  capability.

## Operator TODO

- Create a BotFather bot for the RK9 Ads plugin (prod) and a separate one for
  dev. Store each token as a company secret and bind it in
  `telegram.botTokenRef`.
