# src/kit

Brand- and ads-agnostic building blocks (epic RK9-505, G16): Telegram transport,
gate state machine, local-time tick and test helpers. Code here must not import
anything outside `src/kit/`, so a later plugin (for example Outreach) can lift
the directory into a shared package mechanically. `tests/kit-boundary.spec.ts`
enforces the rule.

- `local-time.ts`: UTC-cron jobs compute local (Europe/Helsinki) time here.
- `testing/harness.ts`: per-company config and secrets for the SDK test harness.

The real-Postgres test helper is in `tests/helpers/embedded-pg.ts`, not here,
because it loads host source by a path that only works inside this monorepo.
