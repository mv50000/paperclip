# RK9 Ads (`@paperclipai/plugin-rk9-ads`)

A brand-agnostic Meta ads engine as a Paperclip plugin (epic RK9-505). Each
company holds one brand config. The plugin publishes creatives as PAUSED ads,
and an ad goes live only after an approver taps a button in Telegram. The plugin
also runs a spend guard, collects insights, sends a daily digest and applies
pause-only rules.

This package is the scaffold (RK9-507). It fixes the capability set, the config
schema, migration 001 and the feature layout. Later children of RK9-505 fill in
the features.

## Layout

| Path | Contents |
|---|---|
| `src/manifest.ts` | Plugin id, frozen capability set, manifest assembled from the feature list |
| `src/worker.ts` | Worker entry: registers the features, dispatches webhooks and API routes |
| `src/config.ts` | The whole `BrandConfig`: types, JSON schema for the host form, `parseBrandConfig()` |
| `src/db.ts` | Company-scoped ledger helpers (`createLedger`) and the column allowlist |
| `src/company-configs.ts` | Lists companies and their parsed config for jobs (jobs carry no company) |
| `src/features/<name>/declarations.ts` | Manifest entries of a feature (pure data) |
| `src/features/<name>/register.ts` | Worker handlers of a feature |
| `src/kit/` | Ads-agnostic code: local time, SDK harness helpers, later Telegram and the gate state machine |
| `tests/helpers/embedded-pg.ts` | Real Postgres with the host migration and runtime SQL validators |
| `src/ui/` | UI placeholders; RK9-518 owns this directory |
| `migrations/001_rk9_ads_ledger.sql` | All ledger tables with their final columns and status sets |

Add a feature like this:

1. Put its manifest entries in `src/features/<name>/declarations.ts` and list it
   in `src/features/declarations.ts`.
2. Put its handlers in `src/features/<name>/register.ts` and list it in
   `src/features/index.ts`.
3. Declared jobs, routes, webhooks and tools without real code use
   `registerPlaceholders()`, so the host never calls a missing handler.

## Commands

```sh
pnpm --filter @paperclipai/plugin-rk9-ads build
pnpm --filter @paperclipai/plugin-rk9-ads typecheck
pnpm --filter @paperclipai/plugin-rk9-ads test
```

The tests include a real Postgres suite (`tests/tenant-isolation.spec.ts`). It
starts the repo's embedded Postgres, applies migration 001 with the host's own
`pluginDatabaseService` and runs the ledger helpers through the host's runtime
SQL validators. It is skipped where embedded Postgres cannot start.

Install on an instance from the local path (see ADR 5):

```sh
paperclipai plugin install /abs/path/to/packages/plugins/plugin-rk9-ads
```

The `smoke` job has no schedule. Trigger it from the plugin page or with
`POST /api/plugins/:pluginId/jobs/:jobId/trigger`. For each company with a valid
config it resolves that company's secret refs, counts its ledger rows and
writes one activity entry. It records only whether a secret resolved.

## Data

Every ledger table has `company_id uuid NOT NULL REFERENCES public.companies(id)`.
Every helper in `src/db.ts` takes `companyId` first and binds it as `$1` in
`WHERE company_id = $1`. Table and column names come from an allowlist, never
from caller strings. A link between ledger rows (for example
`publications.creative_id`) is a composite `(company_id, id)` foreign key, so a
row can never point at a row of another company.

Secret fields in the config accept only `{ type: "secret_ref", secretId }`. The
host refuses a raw token on save, so a token is never stored as plain config.

The schema name is `plugin_rk9_ads_6c2f16bb07`: the host derives it as
`plugin_` + `rk9_ads` + `_` + `sha256("rk9-ads")[0:10]`. The migration hardcodes
it, and `tests/manifest.spec.ts` recomputes it. Renaming `PLUGIN_ID` therefore
fails the tests instead of orphaning the data.

Migration 001 must not change once it is applied anywhere: the host stores a
checksum per file and refuses a changed file. A later child that really needs a
new table uses its reserved number: A7 = 002, A10 = 003, A11 = 004, A9 = 005.

`publications.idempotency_key` is unique across the whole table, so the code
that builds the key (A8) must hash `company_id` into it.

## Architecture decisions

### ADR 1: The core/plugin boundary

The plugin declares no `approvals.*` capability and no budget capability, and it
never calls `ctx.approvals`. The spend gate belongs to the plugin: its state is
in `gate_requests` (statuses `pending`, `approved`, `denied`, `skipped`,
`expired`, `failed`), and an ad is activated only from a Telegram tap through
the plugin's own state machine (G1). No agent tool and no UI action can set an
ad ACTIVE. Paperclip budgets stay untouched, and no child changes
`server/src/**` or `server/scripts/approval-telegram-listener.mjs`.

The capability set is final at install. Adding a capability later moves the
installed plugin to `upgrade_pending`, and the operator must approve it again
(PLUGIN_SPEC 15.3). The scaffold therefore declares what every later child
needs, including `ui.sidebar.register` for the sidebar link (RK9-518).
`tests/manifest.spec.ts` asserts the exact set and that no capability matches
`/approv|budget/`.

### ADR 2: One GRAPH_VERSION

The Meta Graph API version is one constant, `GRAPH_VERSION`, in
`src/meta/graph.ts` (RK9-508). No other file builds a Graph URL or names a
version. A version upgrade is then a one-line change with one review.

### ADR 3: No per-company enable switch

An absent or empty company config means the plugin is off for that company. A
valid config means it is on. An invalid config is reported (`onValidateConfig`,
smoke activity) and treated as off. There is no `enabled` flag to forget in the
wrong state. Removing the config turns a brand off. The emergency stop is the
kill switch (RK9-511), not a config flag.

### ADR 4: UTC host, Europe/Helsinki jobs

The host runs UTC, and the plugin job scheduler only understands UTC cron
(`server/src/services/cron.ts` has no time zone support). Every job schedule in
the manifest is therefore UTC cron. A job that must act at a local time runs
often (every 5 or 15 minutes, or hourly) and computes the local time itself
with `src/kit/local-time.ts` (`localDate`, `localMonth`,
`isLocalTimeAtOrAfter`, `daysInLocalMonth`). It dedupes on the local date, so it
acts once per local day across both DST changes. The zone comes from the brand
config (`timeZone`, default `Europe/Helsinki`). The monthly cap and the daily
budget (G3) use the local calendar month.

### ADR 5: Install from the local path

The default install is `paperclipai plugin install <abs path>` from a pinned
checkout. The plugin is not in the bundled list, so the nightly master
auto-update cannot change code that moves money (G10). An update means: build,
reinstall, and approve the capabilities again if they changed.

Adding the package to `EXPERIMENTAL_BUNDLED_PLUGIN_PACKAGE_NAMES` in
`server/src/routes/plugins.ts` is a one-line change, but it is a separate,
explicit decision. This scaffold does not make it.
