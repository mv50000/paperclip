# src/kit

Brand- and ads-agnostic building blocks (epic RK9-505, G16): Telegram transport,
gate state machine, local-time tick and test helpers. Code here must not import
anything outside `src/kit/`, so a later plugin (for example Outreach) can lift
the directory into a shared package mechanically. `tests/kit-boundary.spec.ts`
enforces the rule.

- `local-time.ts`: UTC-cron jobs compute local (Europe/Helsinki) time here.
- `telegram/bot-api.ts`: thin Bot API client (send, edit, answer, getUpdates,
  webhooks) and the card send/edit helpers. Errors never carry the token.
- `telegram/poll-loop.ts`: one long-poll loop per bot token, offset in plugin state.
- `telegram/webhook.ts`: constant-time `X-Telegram-Bot-Api-Secret-Token` check.
- `gate/state-machine.ts`: gate cards, token hashing and the compare-and-set
  SQL store on `gate_requests` and `processed_updates`.
- `gate/registry.ts`: handlers per gate kind.
- `gate/callback-router.ts`: allowlist, hourglass edit before the handler,
  "ei oikeutta" and "vanhentunut" paths.
- `testing/harness.ts`: per-company config and secrets for the SDK test harness.
- `testing/memory-gate-store.ts`: in-memory store with the same compare-and-set rules.

Design and evidence: `doc/plans/2026-10-14-rk9-ads-telegram-transport-adr.md`.

The real-Postgres test helper is in `tests/helpers/embedded-pg.ts`, not here,
because it loads host source by a path that only works inside this monorepo.
