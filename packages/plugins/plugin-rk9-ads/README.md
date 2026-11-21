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
| `src/kit/` | Ads-agnostic code: local time, Telegram transport, the gate state machine, SDK harness helpers |
| `src/meta/` | The one Meta Graph client (G12): `graph.ts`, `methods.ts`, `errors.ts`, `redact.ts`, `types.ts` |
| `src/brand/` | Live preflight, launch gate, provisioning, token incident, UTM links (RK9-510) |
| `src/publish/` | Publishing pipeline: prevalidate, final URL, ad name, creative body, runner, hand-off hook (RK9-514) |
| `scripts/live-smoke-sunspot.ts` | Read-only live smoke against Sunspot's ad account; never run by tests or CI |
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

The generic host settings form cannot edit the `landing.urls` map. Until the
settings page of RK9-518 ships, save a brand config with
`POST /api/plugins/:pluginId/config` (`{ companyId, configJson }`, instance
admin).

Secret fields in the config accept only `{ type: "secret_ref", secretId }`. The
host refuses a raw token on save, so a token is never stored as plain config.

The schema name is `plugin_rk9_ads_6c2f16bb07`: the host derives it as
`plugin_` + `rk9_ads` + `_` + `sha256("rk9-ads")[0:10]`. The migration hardcodes
it, and `tests/manifest.spec.ts` recomputes it. Renaming `PLUGIN_ID` therefore
fails the tests instead of orphaning the data.

Migration 001 must not change once it is applied anywhere: the host stores a
checksum per file and refuses a changed file. A later child that really needs a
new table uses its reserved number: A7 = 002, A10 = 003, A11 = 004, A9 = 005.
Organic posting (RK9-832) takes 006. The host applies the files in name order,
so an unused reserved number leaves a harmless gap.

Do not put a quote character (`'` or `"`) in a migration comment. The host
validator removes quoted text before it removes comments, so an apostrophe in a
comment hides the next statement and the host refuses the whole migration.

`publications.idempotency_key` is unique across the whole table, so the code
that builds the key (A8) must hash `company_id` into it.

## Brand integration (creative manifest v1)

A brand repo makes the media, hosts it at a public HTTPS URL and hands the
plugin a creative manifest (RK9-513). The plugin never downloads the media:
Meta fetches a video by `file_url`, and an image goes to Meta by URL when the
ad creative is built. Why it works this way: `docs/adr/media-ingress.md`.

The schema is `schemas/creative-manifest.v1.schema.json`, exported as
`@paperclipai/plugin-rk9-ads/creative-manifest.v1.schema.json`. Its source is
the zod schema in `src/creative-manifest/schema.ts`. After a schema change, run
`pnpm --filter @paperclipai/plugin-rk9-ads schema:generate`; a test fails while
the committed file is stale.

Example manifest (a test validates this block against the schema):

<!-- creative-manifest-example -->
```json
{
  "schemaVersion": "1",
  "brand": "OLL",
  "kind": "video",
  "mediaUrl": "https://media.ololla.fi/reels/2026-11-mokki.mp4",
  "posterUrl": "https://media.ololla.fi/reels/2026-11-mokki.jpg",
  "sha256": "9f2c4be0a8d1c37e5b6f0a4d2e8c1b7a3f5d9e0c6b2a8f4d1e7c3b9a5f0d2e6c",
  "aspectRatio": "9:16",
  "copy": {
    "message": "Mökkiloma Forssan seudulla. Varaa marraskuun viikonloppu.",
    "title": "Mökit vapaana marraskuussa",
    "description": "Ololla"
  },
  "cta": "BOOK_TRAVEL",
  "landingUrlKey": "home",
  "utmCampaign": "oll-2026-11-mokki",
  "validUntil": "2026-11-30T23:59:00+02:00",
  "idempotencyKey": "oll-reel-2026-11-mokki-v1"
}
```

The JSON Schema also checks the URL authority (https, no credentials, no port
but 443, no IP address, no private-only name such as `localhost` or `*.ts.net`)
and refuses `posterUrl` on an image. Field rules the JSON Schema cannot check,
enforced at ingress:

- `brand` must equal the company's `brandCode`, and `landingUrlKey` must be a
  key of the company's `landing.urls`.
- `validUntil` must be in the future. `posterUrl` is allowed only for a video.
- Each URL must use a public host name on the default port, with no IP address
  and no credentials. Private-only names (`localhost`, `.local`, `.internal`,
  Tailscale `.ts.net` and similar) are refused. One HEAD request (through the host fetch and its SSRF
  guard) must answer 200 with `video/*` for a video, or `image/jpeg` or
  `image/png` for an image or poster. Redirects are not followed. Size limits
  from `content-length`: image 30 MB, video 1 GB.

CI validation in a brand repo: copy the schema file into the repo and run this
script on every manifest (`npm i -D ajv ajv-formats`):

```js
// scripts/validate-creatives.mjs: node scripts/validate-creatives.mjs creatives/*.json
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schema = JSON.parse(readFileSync(new URL("./creative-manifest.v1.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

let failed = false;
for (const file of process.argv.slice(2)) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (validate(manifest)) continue;
  failed = true;
  for (const error of validate.errors ?? []) console.error(`${file} ${error.instancePath || "/"}: ${error.message}`);
}
process.exit(failed ? 1 : 0);
```

Hand the manifest to the plugin in one of three ways. All call the same
`stageCreative()` and return the same body.

- An agent calls the tool `rk9ads_stage_creative` with `{ "manifest": { ... } }`.
  The company is the agent run's own company.
- A host-side run (RK9-910), such as rk9-motion `host-run.sh`, holds the
  company's agent key but no heartbeat run, so it cannot call the tool. It
  calls the action `stage-creative` with
  `POST /api/plugins/<pluginId>/actions/stage-creative` and
  `{ "companyId": "<uuid>", "params": { "manifest": { ... } } }`. A board user
  may call it too.
- A board user or an agent calls
  `POST /api/plugins/<pluginId>/api/creatives` with
  `{ "companyId": "<uuid>", "manifest": { ... } }`. The host checks that the
  caller may act for that company; an agent key reaches only its own company.

Responses:

| Status | Body | When |
|---|---|---|
| 201 | `{ "created": true, "creative": {...} }` | New creative. A video is now `uploading` with `metaVideoId`; an image is `ready`. |
| 200 | `{ "created": false, "creative": {...} }` | The same `idempotencyKey`, or the same media (`brand` + `sha256`), was staged before with the same text fields. Nothing is fetched or uploaded again. A `failed` video upload is retried, and so is an `uploading` row with no video id after 10 minutes (a worker died mid-upload). An `expired` or `rejected` creative is staged again: the media is checked, the row takes the new manifest (it keeps its id and `idempotencyKey`), and a video uploads again. |
| 400 | `{ "error": { "code", "message", "path" } }` | `invalid_manifest`, `url_not_https`, `url_forbidden`, `valid_until_past`, `invalid_request`. `path` is a JSON pointer into the manifest, e.g. `/copy/message`. |
| 409 | same, plus `creative` | `plugin_not_enabled` (no valid brand config), `idempotency_key_conflict` (the key names other media), `creative_text_conflict` (the media is staged with other `copy`, `cta`, `landingUrlKey` or `utmCampaign`; `error.fields` lists them). A creative is a media resource and its text fields are defaults: a text variant of the same media belongs to the publication. |
| 422 | same | `unknown_brand`, `unknown_landing_url_key`, `media_unreachable`, `media_type_mismatch`, `media_too_large` |
| 429 | `{ "error": {...} }` | `creative_limit_reached`: the company created 200 new creatives in the last 24 hours. Dedupe hits and restages still answer. |
| 502 | `{ "error": {...}, "creative": {...} }` | `meta_upload_failed`; the creative is `failed` and the next submit retries it |
| 503 | `{ "error": {...} }` | `config_unavailable` |

The tool returns the same body as `data`, and on an error also an `error` text
that starts with the code. The action returns `{ "status", "body" }` as
`data`: `status` is the status in the table above, `body` the same body.

| Key | Kind | What it does |
|---|---|---|
| `rk9ads_stage_creative` | tool | Stages a manifest for the agent run's company |
| `stage-creative` | action | The same for an agent key or a board user without a heartbeat run (RK9-910) |
| `stage-creative` | API route | `POST /creatives`, the same with `body.companyId` |

The action gives a caller nothing the tool does not: the same checks, the
same dry-run marker and the same idempotency. The company is the host's
`context.companyId`. The host checks the caller's access to that company (an
agent key reaches only its own) and writes it over `params.companyId`; a
differing `params.companyId` is refused all the same. A call without a
company, and a caller that is neither an agent nor a board user, is refused.
The initiator (agent or board user, with its id) comes from the host's actor
context and goes into the activity metadata (`initiator`), as it does for the
tool. A staged creative holds at most a Meta video id:
nothing in it can spend money. Publishing and activation belong to the publish
pipeline and the Telegram gate.

### Dry-run staging (`meta.stagingMode`, RK9-849)

`meta.stagingMode` is `live` (the default) or `dry_run`. In `dry_run` the
ingress runs every check above (manifest, brand config, landing key, media
HEAD, dedupe), but it sends no Meta call and resolves no token. A video goes
through a dry-run Meta client that returns the planned `advideos` call.

- The creative gets `payload.stagingMode = "dry_run"`, and a video also gets
  `payload.plannedCalls`. The creative view shows `stagingMode` and
  `plannedCalls`. A video stays `staged`, an image is `ready` as in live mode.
- Publication (`plan` and `publish`) refuses the creative with
  `creative_not_publishable`. The publication run reads the creative again
  before its first Meta write, so a dry-run stage that lands after the submit
  also fails the run (`creative_not_publishable`, or `creative_not_found` when
  the row is gone). Activation denies an ad whose publication uses it
  (`creative_dry_run`). A live organic card refuses it
  (`creative_unusable`), and so does the tap on a live card. An organic
  `dry_run` card accepts it.
- Staging the same media again with `stagingMode: live` stages it anew: the
  marker goes away and the video uploads for real. As with an `expired` or
  `rejected` row, the new manifest's text fields replace the old ones, and the
  row keeps its id and `idempotencyKey`.
- A dry-run stage of the same media marks an existing live video that has no
  Meta video id yet (`staged`, `failed`, stale `uploading`). An ad already
  made from that row is then denied at activation. This fails closed.
- Activation also denies an ad whose publication names a creative row that no
  longer exists (`creative_missing`). The foreign key prevents this in prod.
  A creative read that fails denies the activation too
  (`publication_unavailable`).
- A dry-run video sets its marker in the same write that claims the upload,
  so a worker that dies mid-stage leaves a marked row, never an unmarked
  `uploading` one.
- An empty value (`null`) of `meta.stagingMode` counts as `live`, as in the
  other enum fields of the config.

`meta.dryRunMediaCheck` is `head` (the default) or `skip` (RK9-853). With
`skip` a dry-run stage sends no media HEAD, and the creative gets
`payload.mediaCheck = "skipped"`, which the creative view shows as
`mediaCheck`. The config refuses `skip` unless `meta.stagingMode` is
`dry_run`, and live staging always sends the HEAD. Use `skip` only on a dev
instance whose media host the plugin's host fetch cannot reach: the host fetch
refuses private addresses, and on paperclip-01 every `*.rk9.fi` dev host
resolves to a LAN address. A dev run must not host its media on a brand's
prod media host.

**What `dry_run` does not cover.** `meta.stagingMode` governs creative
staging only. It is not a brand-wide dry run. In a `dry_run` brand:

- A publication of a creative without the marker (one staged live earlier)
  still uses the live write client and creates PAUSED Meta objects.
- A live organic post of such a creative still posts.
- The plugin jobs (`insights-hourly`, `insights-daily-close`,
  `scheduled-pause`, `rules-evaluate`, the smoke job, `digest-tick`,
  `organic-reconcile`) still run and can call Meta with the brand's token.

So a dev acceptance run keeps those paths off by setup, not by this field:
the brand's token is a fake secret, the plugin jobs are paused, there is no
`telegram` block, and nobody publishes
(`docs/implementation-notes/rk9-ads-dev-acceptance.md` at the repo root).

Use `dry_run` only on a dev instance for an acceptance run. The prod configs
keep the default.

The read-only tools `rk9ads_list_ads` (optional `status` filter) and
`rk9ads_get_insights` (optional `since`, `until`, `adId`; default the last
seven full days, at most 90) read the company's own ad account with a client
in `readOnly` mode. `tests/tool-safety.spec.ts` drives every tool in the
manifest against a fake Graph and fails on any write that activates, changes a
budget or cap, or creates a campaign, ad set or ad.

The live media smoke `scripts/live-media-smoke.ts` uploads a reel by URL and a
PNG by bytes to Sunspot's account and checks that no campaign, ad set or ad
appeared. The operator runs it; tests and CI never do.

## Telegram transport and gate

`src/features/telegram/` runs one Telegram consumer per distinct bot token
(long-poll by default, webhook optional) and routes taps to the gate state
machine in `src/kit/gate/`. A later feature adds its gate handler with
`registerGateHandler(kind, fn)` from `src/features/telegram/gates.ts`. It posts
a card with `getTelegramController().sendGateCard(...)`. The digest reuses
`botFor(companyId)` and the helpers in `src/kit/telegram/bot-api.ts`. The bot
token must belong to this plugin alone: dev and prod use different bots, and
the core chat-channels bot is never shared. See
`doc/plans/2026-10-14-rk9-ads-telegram-transport-adr.md`.

## Spend guard and kill switch (RK9-511)

`src/features/spend-guard/` holds the money-critical layer.

- **Guard** (`guard.ts`). Every brand Meta client gets its `guardedWrite` hook
  from `createSpendGuardHook()`. Pauses, renames, media and PAUSED creates pass
  as with the default hook. Every other write must be a status or budget write
  the guard understands. `authorizeSpend` must allow it first: this feature
  allows none, and the activation gate (A9) passes its own. Then `checkSpend()`
  re-reads Meta with no cache: `spend_cap`, `amount_spent`, currency, the
  insights spend of the local calendar month and every campaign and ad set
  budget. It refuses when the currency is not EUR, when there is no
  `spend_cap`, when Meta's headroom (`spend_cap - amount_spent`) is 0 or less
  (Meta would not deliver), when the headroom is above the rest of the monthly
  cap (G2), when the projection exceeds `monthlyCapEur`, when any read fails or
  takes over 60 s, and when the ad account's time zone is not `timeZone` (MTD
  would be off). Projection = MTD + what each counted daily budget still
  allows today (budget minus its own spend today, read per ad set) + daily
  budgets x the remaining local days after today + lifetime budgets. Today
  counts once, and spend today of an object that no longer counts is never
  credited to another, so a provisioned budget on pace passes its own guard
  (G3, RK9-523). The guard adds no margin for the insights lag of earlier days
  or for Meta's day-level overdelivery; Meta's `spend_cap` (at most the
  monthly cap, G2) is the real-time backstop. The cap itself never blocks a budget cut, but
  `authorizeSpend` is asked first, and its default refuses every budget write.
  Fields that modify a budget in ways the projection does not model (e.g.
  `budget_schedule_specs`) are refused on every write.
- **Pause side on a broken config** (`pause-config.ts`, ADR 3). Every
  successful read stores the brand's last valid config (secret refs only). When
  the config turns `invalid` or `unavailable`, the scheduled pause, the data
  gate, the rule engine's cap rule, the UI action and the agent tool pause
  with that config, always on the
  whole ad account (a stored `campaignId` may be stale). Results, the audit
  reason and the notice say so, and the job run fails so the broken config is
  seen. The Telegram `pause_all` card works this way only for `unavailable`:
  the controller drops the bot of an `invalid` brand, so use the UI or the
  tool. With no stored config the run fails and nothing is paused. An absent
  config never falls back.
- **Kill switch** (`killswitch.ts`). `pauseAll()` pauses every ACTIVE
  campaign (that alone stops delivery) and then every ACTIVE ad. The kill
  switch covers the brand's whole ad account, also campaigns made by hand in
  Meta's UI and also when `meta.campaignId` is set (operator decision
  15.10.2026, RK9-523). The scheduled pause and the data gate keep the
  `meta.campaignId` scope when it is set. Nothing touches `spend_cap`. The
  audit row lists every paused campaign and ad; the Telegram notice lists the
  campaigns first and counts what does not fit, on every trigger.
  Triggers: the UI action `pause-all`
  (`dryRun` defaults to true; a live run needs `confirm: true`), the agent tool
  `rk9ads_pause_all`, and the `pause_all` gate card's "⏸ Pysäytä kaikki"
  button (allowlisted user in the brand chat, no second step).
- **Open cards and the halts** (RK9-557, RK9-561, `halt.ts`). Before its
  first Meta call a live kill switch, 90 % cap pause or scheduled pause
  leaves its halt in the plugin state (`spend-guard` namespace, one key per
  rule, no migration) and closes every open `activate_ad` card row of the
  company (`expired`), so a tap cannot undo the pause. The cards are edited
  with the reason after the Meta pauses, so a slow Telegram does not delay
  them. A row whose close fails does not stop the others. The data gate
  leaves the cards open and sets no halt: an activation approved while its
  predicate does not hold is paused again on the next tick, at most 5 min
  later (RK9-565). While a halt is in force,
  `activate_ad` refuses (also a card sent later, which says so), and it reads
  the halt again before every ACTIVE write and after the last write; a halt
  seen during or after the writes pauses again what the run set ACTIVE. So an
  activation approved just before a pause cannot undo it. The kill switch's
  halt has no expiry; the scheduled pause's lasts until 06:00 local time the
  next morning; the cap pause's until the next local month. A live kill
  switch stores its halt and closes the cards also when no brand config can
  be loaded, then fails with nothing paused in Meta.
  Only a board user clears a halt early, with the action `clear-halt`
  (`dryRun` defaults to true; a real clear needs `confirm: true` and the
  preview's `since`; an agent or the system may only preview it). The clear
  lifts only the halt with that `since`: it stores a marker with that halt's
  id, so a newer kill switch or pause that set the halt again stays. There is
  no Telegram button for it. A failed halt write or card close does not stop
  the pause: the result (`haltError`, `cardsError`) and the audit row name
  it.
  Every halt covers the whole company, also a scheduled pause's that
  `meta.campaignId` limits to one campaign; a daytime `at` (07:00) gives a
  halt of about 23 hours (RK9-565). The cap pause's halt also ends when the
  rules job reads the month under the 90 % cap on two consecutive runs at
  least 30 min apart (e.g. after `monthlyCapEur` was raised); a run at or over
  the cap, or without a reading, starts the count again.
- **Re-check and failed undos** (RK9-565, `recheck.ts`, `pending-undo.ts`).
  A live kill switch or scheduled pause stores a re-check: the first
  `scheduled-pause` tick at least 60 s later lists the ACTIVE objects again
  and pauses what Meta's listing showed late. It runs only while that pause's
  halt is in force and within 15 min of its due time. When an activation
  that lost the race to a pause cannot pause again what it set ACTIVE (Meta
  refuses the PAUSED write), it stores the objects, fails the card and sends
  one Telegram alert (`alert_dedupe`). Each `scheduled-pause` tick pauses them
  again and fails its run until Meta confirms, whether a halt is still in
  force or not: a scheduled halt that ends at 06:00 or a cap halt that ends
  with the month must not leave the object spending. An entry ends only when
  Meta confirms (one audit row), when no halt is in force and a newer card
  of the same object or publication was approved and activated after the
  failure (one audit row, one alert), or when a board user acknowledges it.
  A halt or newer-card lookup that cannot be read pauses anyway; while a
  newer card's handler still runs, the tick leaves the entry alone. A
  company whose config was removed with entries open fails the run and
  names them (no Meta client to retry with). The `clear-halt` preview
  lists the entries with their keys, and a real call with
  `acknowledgeUndos` (no `since` needed) removes those (activity log). The
  Ads page shows them with a typed "KUITTAA" confirmation; clearing a halt
  does not acknowledge them.
- **Failed pauses during a halt** (RK9-568, same list). When Meta refuses the
  PAUSED write of an ACTIVE object in a live kill switch, scheduled pause,
  cap pause or re-check (an error, or a reply without `success`), pauseAll
  stores the object with origin `pause` and sends one Telegram alert, with
  one `alert_dedupe` marker per object (`pause-failed:<brand>:<rule>:<halt
  id>:<object id>`); a failed send gives the marker back and the next tick
  sends it. The tick retries it like a failed undo and ends it by the same
  rules. A re-check whose objects went to the retry is done: its listing
  ran. Only when the retry cannot be stored does the re-check stay, and its
  drop at the end of the window says how often it ran and Meta's last
  error instead of "no tick ran". Every entry counts its failed PAUSED
  writes and keeps the last error (redacted); the run's failure line, the
  alert and the Ads page show them. A re-check that finds the object no
  longer ACTIVE still drops silently. The data gate and dry runs store
  nothing.
- **Retry edge cases** (RK9-567, same list). After each confirmed PAUSED
  write with no halt in force, the tick looks for a newer card again: one
  approved during the tick's reads may have just been paused, and one alert
  per object and card (`undo-overlap:` / `pause-overlap:`) says so; the
  entry still ends. A newer card with no recorded end past 30 min has an
  unknown result (its worker died, or its outcome was not stored): it does
  not end the retry, the tick pauses and sends the same alert. One still
  marked running after 5 min fails the run while the retry waits. A PAUSED
  write that Meta refuses for good (token invalid or unresolved, code 10 or
  200-299, code 100 subcode 33, code 803, a refused write) fails the run once
  and sends one alert (`undo-permanent:` / `pause-permanent:`); the tick
  keeps trying the write quietly, and the Ads page marks the entry until a
  board user acknowledges it. A transient error makes it loud again. Drop
  alerts have one marker per object. The newer-card lookup moves the
  failure's time from the worker's clock to the database's, which
  `decided_at` uses. For a campaign it also counts a running card of the
  failed card's ad set (a swap card's binding names no campaign); an ad or
  ad set never waits for a sibling's card. A config that cannot be
  loaded names the open entries. activate_ad reads every halt as of its own
  start, so a run that stalls past the 30-minute pause-ad halt still sees
  it. The callback router tries the handler's final outcome write twice more
  (250 ms, 1 s) before it logs the failure. The in-memory lock over the
  list holds because the host runs one worker per plugin per server, stops
  the old worker before it starts a new one, and a server restart kills its
  workers (systemd `KillMode=control-group`, worker exits on stdin close);
  two servers on one database are not supported.
- **Retry keys, counts and alert length** (RK9-570, same list). An entry's
  key (`<object>|<gate request or pause>|<failedAt ?? since>`) names its
  latest failure, so an acknowledgement from an older preview takes neither
  a new entry of the same object and pause nor a failure merged after the
  preview; two merges in one tick get keys 1 ms apart. A failed retry
  changes no key and counts on the entry it read even when a pause failure
  was merged into it during the tick. The Ads page shows an
  acknowledgement that took fewer entries than the preview listed as an
  error and asks for a new one; its prompt names activation undos and
  pause retries apart. Alerts stay under 3900 characters with the heading
  and the instruction whole; the object and error lines are cut with a
  note. A re-check counts a failed listing or halt read as a failed run
  too, and when a re-check whose runs all failed is dropped at the end of
  its window it sends one Telegram alert (`recheck-dropped:<brand>:<rule>:<due
  time>`); a failed send keeps the re-check for the next tick, at most
  24 h past its window (RK9-580). Only a board user's clear of its halt
  skips the alert; a halt that ran out still alerts. A drop ends only
  the re-check the tick read, not a newer one. A halt that ends within the
  window after failed runs (a scheduled pause shortly before 06:00, or a
  replaced halt) alerts at once, like the drop at the window's end
  (RK9-584). A re-check has an id: a drop stores a marker with it
  (`recheck-done:`) and a failed run's count goes to its own key
  (`recheck-attempts:`), so a pause that stores a new re-check during the
  tick keeps it. A damaged due time whose alert failed is dropped with a
  line that says so. A halt replaced within the window by a newer pause of
  the same rule after the re-check's due time (a kill switch fired during
  the tick) keeps the re-check for one tick, uncounted and without the
  alert: the newer pause stores its own re-check, which replaces it. When
  it stored none (its config or re-check store failed), the next tick
  alerts. At the window's end a replaced halt still alerts (RK9-606).
  Rollback note: a drop keeps the record, and code from before RK9-584
  ignores the `recheck-done:` marker and the `recheck-attempts:` count.
  After a rollback to it, a dropped re-check runs again: one past its
  window fails one run with "dropped unrun", one within its window whose
  halt is still in force runs one extra pause (harmless). A re-check stored
  before RK9-584 carries its count inline: with failed runs it can fail
  again and send the drop alert once more. The drop does not delete the
  record, because a delete would again lose a newer pause's re-check
  (RK9-606).
- **Job** `scheduled-pause` (every 5 min UTC). It sends the 80 % and 100 % MTD
  alerts (once per brand, local month and threshold) and the risk alerts
  (once per brand, local day and risk): no `spend_cap`, Meta's headroom above
  the rest of the monthly cap, or a projection above the cap. One pause card
  carries every new alert (`alert_dedupe`); a failed send gives its markers
  back, fails the run and is sent on the next check. There is no automatic
  pause at 100 %: the A6 spec asks for an alert, and Meta's `spend_cap` is the
  hard stop (RK9-523). The job runs the scheduled pause once per local day at
  or after `schedule.scheduledPause.at` (off by default). The day is marked
  once the Meta pauses succeeded; a failed card close or halt write fails the
  run once and is not retried, so ads activated on purpose later that evening
  stay on. A retry tick keeps the halt the day's first tick stored and closes
  no cards again, so a board user's clear stands; a run that has only a halt
  or card failure to report writes its audit row once per local day. It also
  runs the re-checks and the failed undos (above) and the
  data gate when `schedule.dataGate` is set. The gate's predicate `value
  <operator> threshold` is the condition for the ads to keep running. A JSON
  pointer to an array counts its items. An unreadable feed pauses nothing
  (fail-open), but it fails the run so the broken feed is seen. A Telegram
  failure after a pause fails the run, and the pauses stay.
- **Read action** `spend-guard` and the tool `rk9ads_get_pacing` return
  the guard figures, the alerted thresholds and `halt` (the halt in force or
  null; `haltError` when it cannot be read). They never return a token. It is
  an action, not a data handler, so the company comes from the host's
  `context.companyId` and never from params (RK9-603).
- Every pause, refusal and alert writes a `rule_actions` row and an activity
  entry. Refusals and alerts use `rule_type = pause_all_cap` with
  `action = none` (rule ids `spend-guard`, `spend-alert-80`,
  `spend-alert-100`, `spend-risk-<risk>`), because migration 001 has no other
  fitting type.

## Insights, digest and fatigue (RK9-512)

Code: `src/insights/`, `src/digest/`, `src/metrics/cpc.ts`, wired in
`src/features/insights/register.ts`. No new tables: it uses `insights_daily`,
`digest_runs`, `alert_dedupe`, `rule_actions` and `gate_requests` of
migration 001. All SQL is in `src/insights/store.ts` and binds `company_id` as
`$1`.

Metrics (`src/metrics/cpc.ts`, the one definition, G18): CPC is link CPC,
`spend / inline_link_clicks` (the Sunspot SOP definition, not Meta's `cpc`).
CTR is link CTR in percent. CPM is `spend / impressions × 1000`. Money is
integer cents; insights `spend` is parsed from Graph's decimal string exactly.

Jobs (UTC cron; local time is computed in the job):

| Job | Schedule | What it does |
|---|---|---|
| `insights-hourly` | `5 * * * *` | Yesterday's and today's ad-level rows (one `level=ad`, `time_increment=1` call per brand), so late reporting for yesterday is in before the digest. |
| `insights-daily-close` | `20 * * * *` | First run of a new local date (`timeZone`, default Europe/Helsinki): re-pulls the last 7 days to yesterday, marks days older than 3 days final, then files fatigue issues if enabled. Marker `insights-close:<date>` in `alert_dedupe`, keyed by the ad-account-local date the digest checks. |
| `digest-tick` | `*/15 * * * *` | Sends the digest once per local date at or after `digest.time`. |

Rows are upserted by `(company_id, ad_id, date)`, so a re-run gives the same
rows and values. Dates are ad-account-local (`timezone_name` from the account).
Each brand runs in its own try/catch: a Graph error, token 190 or rate limit is
logged and stored as an `insights_warning` marker (one per account-local day
and code), which the digest shows while it recurred in the last 24 h; a
warning that has recurred day after day says since when ("jatkunut … alkaen").
When
Meta rejects a field (code 100), the core fields are fetched alone and each
optional field (`reach`, `frequency`, `actions`) is tried on its own. `actions`
is fetched only when the brand has `meta.datasetId`.

Actions (company from the host context, no manifest entry): `digest.dryRun`
returns the digest text and writes nothing; `insights.backfill { days: 1-31 }`
re-pulls that many days.

Digest config (`digest` block): `enabled` (default true), `time` (default
`07:30`, brand time zone), `cpcWarnEur` (default 0.50, ⚠️ above it) and
`zeroSpendMode` (`message` sends "0 € kulutus, ei aktiivisia mainoksia";
`silent` sends nothing on such a day unless there is a warning, a gate card, a
fatigued ad or a rule action). A day's row in `digest_runs` is inserted before
the send and each attempt is claimed with a compare-and-set, so a day is sent
at most once. A failed send is retried after 10 minutes, at most 5 attempts.
A row left pending (a worker restart mid-send, or a send whose "sent" write
failed) is closed as failed after 10 minutes and never resent: its send state
is unknown, and a missed digest is better than a duplicate. The same holds for
a send that ends in a transport error or an HTTP 5xx: only a 4xx answer from
Telegram (the message was refused) or a request that never connected (DNS
failure, connection refused) is retried. A bot that is not ready yet
uses no attempt. The CPC warning (`cpcWarnEur`) applies to EUR accounts only.
Month figures (RK9-526): MTD, Meta's headroom (`spend_cap − amount_spent`),
what is left of the monthly cap and the projection come from a spend guard
snapshot (`checkSpend`, fresh Graph reads) through `monthPosition`
(`src/features/spend-guard/position.ts`), the same function the guard decides
on. So the digest and the guard show the same figures for the same day. The
Graph read is canonical: it is live and the guard is fail-closed on it.
`insights_daily` MTD cross-checks it; a gap above 2 € or 5 % (the larger) is
logged (`MTD sources differ`) and shown as a warning. When the guard cannot
read Meta (or the account time zone is not `timeZone`), the digest says so and
falls back to `insights_daily` MTD and the run rate of the complete days. The
projection line names its basis ("nykyisillä budjeteilla" or "toteutuneella
tahdilla"). The digest warns when `spend_cap` is missing or used up, when its
headroom is above what is left of the cap (guard rule 4), and when
`amount_spent` is well above MTD after the 1st (the monthly reset looks
missing, G2).

Fatigue (`computeFatigue(series, thresholds, asOf)`, pure): status
`insufficient-data` below `minImpressions` total, `fatigued` with two or more
signals, `watch` with one, else `ok`. Fatigue never pauses or changes an ad.

| Threshold | Default | Source |
|---|---|---|
| `minImpressions` | 1000 | config `fatigue.minImpressions` |
| `maxFrequency` | 2 (impressions-weighted **daily** frequency, last 3 days; 3.5 is a 7-day norm a daily figure never reaches) | config `fatigue.maxFrequency` |
| `ctrDropPct` | 30 % below baseline link CTR | config `fatigue.ctrDropPct` |
| `cpcRisePct` / `cpmRisePct` | 40 % above baseline | code default |
| `maxAgeDays` | 28 days since first delivery | code default |
| baseline | first 3 delivery days, extended to ≥ 300 impressions (max 7 days) | code default |
| recent window | last 3 days, ≥ 300 impressions | code default |

The baseline is derived from `insights_daily` on each run (no `ad_baselines`
table). With `fatigue.issuesEnabled=true` (default false) a fatigued ad gets
one Paperclip issue in its company (`originKind` `plugin:rk9-ads`), deduped by
the `fatigue-issue:<adId>` marker. The plugin cannot read issues, so the marker
stays after the issue closes: one issue per ad. A create the host refused
before it ran (capability or scope denial) removes the marker for a retry;
any other failure, also a timeout, keeps it, since the issue may exist.
The fatigue series is read in pages of 5000 rows, so a large account is not
cut short.

Parity: `RK9_ADS_LIVE_SMOKE=1 pnpm exec tsx scripts/parity-sunspot-insights.ts
[--date YYYY-MM-DD]` reads one Sunspot day both as the SOP does and through the
ingest, read-only, and compares spend, impressions, link clicks and CPC.

## Rule engine (RK9-515)

`src/features/rules/`: pause-only rules per brand, shadow mode first.

- **Config** `rules: { liveMode, list }`, validated by a zod discriminated
  union in `schema.ts` (config.ts calls `parseRules()`). The constants and
  the JSON Schema conditions are in the zod-free `constants.ts`, and
  `esbuild.config.mjs` keeps `schema.ts` out of the manifest bundle, so
  `dist/manifest.js` carries no zod (RK9-579: 566 KB to 17 KB). Rule types:
  - `threshold_pause`: `metric` (`cpc`, `ctr`, `cpm`, `frequency`, `spend`)
    `operator` `threshold` over the `days` completed Helsinki days that end
    yesterday. `aggregate: "each_day"` (default) needs every day to break the
    threshold; `"window_total"` computes the metric once from the window's
    summed spend, impressions and link clicks (not for `frequency`). Gates:
    `minImpressions` and `minClicks` (required) and `minSpendEur` (default 0),
    all window totals; equal fires. CPC and CTR are link metrics (G18). Spend
    with no link click counts as an infinite CPC; no spend is no CPC, so a
    `cpc lt` floor never fires on an ad that spent nothing (RK9-541).
  - `pause_all_cap`: built in. Pauses the whole ad account (A6's `pauseAll`)
    when month-to-date spend is at 90 % of `monthlyCapEur` or more. MTD is the
    spend guard's (RK9-526) and must be in EUR. A list entry
    `{ type: "pause_all_cap", mode }` only sets its mode and cooldown (at most
    24 h); it cannot be disabled or removed. The list takes one such entry.
    The rule editor refuses a second one, but the host's Ajv check on save
    does not (JSON Schema draft-07 cannot count matching items): a config
    saved past the editor with two entries is invalid, and the brand runs
    only the cap rule on its last valid config, failing every run, until
    the duplicate is removed (RK9-579).
  - `pause_valid_until`: pauses an ad whose creative `validUntil` has passed.
  - `pause_fatigued`: opt-in; pauses an ad that A10 calls `fatigued`.
  - `propose_scale`: schema only, must stay `enabled: false` (G9).
- **Defaults:** without `rules.list` the brand gets `cpc-ceiling` (CPC > 0.50
  EUR over a 7-day window total, ≥ 3 EUR spend, no click or impression gate)
  and the built-in cap rule. The gate is on spend because a click gate cannot
  be met on a small budget (RK9-536): at a 100 EUR cap the daily budget is
  3.22 EUR, so 10 clicks in 2 days are out of reach above about 0.64 EUR per
  click, and the worst ads escaped the rule. Every rule starts in `mode: "shadow"`. A Meta write needs the rule's
  `mode: "live"` and the brand's `rules.liveMode: true`.
- **Job** `rules-evaluate` (`0 * * * *`): reads ad and campaign status, the
  guard's MTD, `insights_daily`, creative `validUntil` and earlier
  `rule_actions`, then calls the pure `evaluateRules()`. Today's partial day
  never counts, and threshold rules wait until `insights-daily-close` has
  finalised yesterday; still waiting at 06:00 local time fails the run. The
  job runs at :00 and the close at :20, so a brand enabled (or the plugin
  installed) after 06:00 fails its first run once, before the first close
  (prod 18.10.2026 12:00Z, RK9-541). When the ad account reports in another
  time zone than `timeZone`, threshold rules do not run: the insights dates
  and the close marker are account-local days (the spend guard refuses that
  state too). Only ACTIVE ads get a decision, account-wide like the
  kill switch (RK9-523: the ad account belongs to the brand), not limited
  to `meta.campaignId`. So every brand needs an ad account of its own: on
  a shared one, its per-ad rules would pause the other brand's ads too.
  Checked 19.10.2026 against the operator's notes (RK9-579): Ololla and
  Sunspot have separate ad accounts; compare `meta.adAccountId` in the
  company configs before a new brand goes live. A failed status
  read fails the run and leaves only the cap rule, which decides on the month
  position alone (pauseAll lists its own targets, RK9-541). It waits when
  a board user cleared this month's cap halt and `monthlyCapEur` is the cap
  it paused at (or the halt has no cap figure), so an unread status does not
  override the clear every hour. After the headroom release, or under a
  `monthlyCapEur` raised or lowered since the clear, it runs, so spend at
  90 % of the cap still pauses (RK9-582: the clear marker names who
  cleared the halt; a marker from before it waits at the same cap). A halt
  without `until` ends with the local month of its `since` (RK9-579). One brand's failure does not stop the others.
- **Cap rule isolation (RK9-536):** every other input is read in its own
  `try`: a failed read fails the run and switches off only the rules that
  need it. Without the earlier `rule_actions` only the cap rule runs. Its
  cooldown then comes from a marker of its latest settled pause, while the
  halt that pause left is in force on the same ad account (RK9-541). A halt
  alone proves nothing, because `pauseAll` stores it before it pauses. A
  config that turns invalid, unavailable or disabled (`monthlyCapEur`
  cleared) runs only the cap rule, on the last valid config (ADR 3, A6's
  `loadPauseConfig`), with that config's `rules.liveMode` and ad account: a
  broken edit is not read, so an edit that moved the ad account or turned the
  brand live takes effect only once it is valid. An invalid or unavailable
  config fails every run; a disabled one is the operator's choice and fails
  only the first run of each local day (RK9-541). Delete the brand config to
  stop the fallback. A brand saved disabled and never enabled is skipped
  quietly.
- **Cooldown** `cooldownHours` (default 24, 1–720): a rule does not decide on
  the same object again inside the window. Shadow counts shadow decisions;
  live counts only applied live pauses without an error, so a failed pause,
  or a cap pause that left an object ACTIVE, is retried. A cap pause that
  `pauseAll` marks `settled` counts too (RK9-541): every target paused or
  handed to the pause retry, the halt stored and the cards closed. A failed
  Telegram notice then does not cut the cooldown to an hour, and the rules
  job does not repeat a pause the pause retry already repeats every tick.
- **Audit:** every decision writes `rule_actions` (shadow: `dry_run=true`) and
  an activity entry with the rule id and the metrics (spend, link clicks,
  impressions, CPC, CTR, days). Shadow hits reach Telegram through the morning
  digest. A live run sends one Telegram message when at least one ad changed
  state; the cap rule's `pauseAll` sends its own notice.
- **Save check:** the manifest schema carries the per-type rules
  (`RULE_ITEM_JSON_CONDITIONS`), so the host refuses on save what
  `parseRules()` would refuse. Duplicate rule ids are caught only by
  `parseRules()` (onValidateConfig).
- **Data** `rules` and **action** `rules.dryRun` (A12's editor, G13): the
  effective rules, and the decisions the rules would make now without any
  write.
- **Action** `rules.prepareSave` (A12, RK9-518): validates an edited
  `{ liveMode, list }` with `parseRules()`. It refuses `propose_scale` and
  keeps the stored `propose_scale` entries. It writes nothing: the UI saves
  the returned block through the host config route (instance admin). When
  the saved config has no `rules.list` and the draft is exactly the shipped
  defaults, the block leaves `list` out, so the defaults are not frozen into
  the config (RK9-563).
- A live cap pause whose card close or halt write failed fails the run
  (`cardsError`, `haltError`), the same as a failed audit row.

## Publishing pipeline (RK9-514)

A publication turns a staged creative into a PAUSED ad in the brand's bound
ad set (G8). The steps:

1. **Prevalidate** (`src/publish/prevalidate.ts`, pure, before any Meta
   call): aspect ratio 1:1, 4:5 or 9:16 (per placement: feed 1:1/4:5, story
   and reels 9:16), size and video length when the caller gives them, text
   limits (2000/255/255), the CTA enum (no NO_BUTTON on a video), the landing
   domain against `landing.allowedDomains`, and `utm_campaign`. Every problem
   comes back as `{ code, field, message }`.
2. **Final URL** (`final-url.ts`): `utm_source=meta&utm_medium=paid&utm_campaign=<campaign>`,
   plus the other parameters of `landing.utmTemplate` (`{brand}`,
   `{campaign}`, `{adset}`, `{ad}`). The fixed three win over the template.
   Existing parameters keep their bytes, the fragment stays last, and a
   second application changes nothing.
3. **Media** (G4, URL only): a video goes to `act_<id>/advideos` by
   `file_url` (or reuses the creative's uploaded video) and is polled until
   `video_status=ready`. Its thumbnail is the manifest poster, or Meta's
   preferred `/{video}/thumbnails` URI. An image goes in as
   `link_data.picture`. No ffmpeg, no child process, no adimages upload.
4. **Creative** (`creative.ts`): `video_data` (+ `instagram_user_id` when the
   brand has an IG actor) or `link_data` (never an IG actor). No
   `degrees_of_freedom_spec`.
5. **Ad**: `act_<id>/ads` with `status: "PAUSED"`, named
   `{BRAND}-{campaign}-{format}-{yyyymmdd}-{hash6}`. hash6 comes from the
   content hash (media, copy, CTA, final URL, ad set). Swap mode instead
   POSTs only `{ creative: { creative_id }, status: "PAUSED" }` to an
   existing ad. The ad must be one that a publication of this company made,
   in the brand's ad account, and its status must already be PAUSED. New
   content never goes live without the activation gate (G1).
6. **Hand-off**: after `published`, `onPublished(publication)` in
   `src/publish/handoff.ts` runs at most once per publication (a once-marker;
   a hook that throws gives the marker back and runs on the next publish).
   The activation gate (below) posts its card from it. A swap first calls
   `onCreativeSwap`, which closes the ad's open cards. Nothing here
   activates an ad.

Text variants belong to the publication (RK9-525): `text` overrides the
creative's copy, CTA, landing key or campaign, the result is stored in
`publications.payload`, and the content hash tells publications apart.

**Idempotency.** The row is written `pending` before the first Meta write,
and each Meta id is stored right after the write that made it. The stored
key is `pub:v1:sha256(company, mode, target ad, key)`, where `key` is the
caller's `idempotencyKey` or the content hash. A re-run returns a published
row, or resumes a pending or failed one from its stored ids. Before an ad
create the run looks for an ad with the same name and creative in the ad set
and adopts it, so a crash between create and save leaves no duplicate.

**Failures.** A video error, a poll timeout, or a failed creative, ad or
swap write sets `failed` with a one-line message and the fix
(`operatorMessage()` in `src/meta/errors.ts`, e.g. subcode 2859024). A
creative is deleted only when this run made it and no ad can use it: the ad
write was not sent, the guard refused it, or Meta answered it with a 4xx
error. After a lost response or a failed save the creative stays on the row,
and the re-run reuses it and adopts the ad. If Meta refuses the delete,
`payload.cleanup` names the creative; a later successful run clears it.

**Async.** The action records the row, starts the run as a background
promise of short Graph calls (each well inside the host's 30 s RPC limit),
and waits at most `waitMs` (default 10 s, at most 20 s). A longer run
returns `pending`; poll the `publication` read action. A worker restart cuts a
run off; publish again with the same input to resume it.

Every Meta write writes an activity entry: `entityType: "rk9_ads_publication"`,
`entityId` the publication id, `metadata.metaObjectId` and `metadata.step`.
No token or secret goes into it.

| Key | Kind | What it does |
|---|---|---|
| `publish` | action | `{ creativeId \| manifest, text?, placement?, sizeBytes?, durationSec?, idempotencyKey?, dryRun?, confirm?, waitMs? }`. Dry run (the full planned payloads, no Meta call) unless `dryRun: false, confirm: true`. A real run needs `creativeId` and a launch-ready preflight |
| `swap-creative` | action | The same plus `adId`: a new creative on a PAUSED ad that this company published; the ad stays PAUSED. A real swap is board-only (an agent gets the dry run only, RK9-540) |
| `publication` | action (read) | `{ publicationId }`: status, Meta ids, error and cleanup of one publication. The stored error goes through `sanitize()` again when it is read (RK9-563). The company comes from `context.companyId`, not from params (RK9-603) |

## Activation gate (RK9-517)

The plugin's own spend gate (G1): `src/gate/` and `src/features/gate/`. No
`ctx.approvals`, no core change, no scale_budget handler (G9).

1. **Card.** After publish the hand-off posts a card to the brand's chat: the
   photo or video preview, the copy, the ad name, the ad set, its daily budget
   and MTD spend against `monthlyCapEur`, with "📣 Aktivoi mainos" and
   "🗑 Ohita". The `gate_requests` row (kind `activate_ad`, `pending`) holds
   the chat id, the message id, `valid_until` = now + `telegram.gateTtlHours`
   (default 24) and the binding: publication, ad, ad set, campaign, Meta
   creative id and content hash. A newer card of the same ad closes the older.
2. **Tap.** The kit's router checks the chat and the approver list
   (`telegram.allowedUserIds`, re-read from the saved config) and moves the
   row pending -> approved with one conditional UPDATE, so a double tap acts
   once. The `activate_ad` handler (`src/gate/activate-ad.ts`) then re-runs
   the preflight, reads the ad set's ads, the ad set and the campaign, checks
   that the ad still carries the creative the card showed and that the
   publication owning the ad is still the card's (same content hash and
   creative, RK9-557), refuses ⚠ states
   (ARCHIVED, DELETED, effective_status such as DISAPPROVED or WITH_ISSUES),
   and runs the spend guard for each object it will activate. Last it reads
   the halt in force (kill switch, scheduled pause or cap pause). Any refusal ends the card `denied` with
   the reason and no Meta write.
3. **Writes.** The ad ACTIVE, every other ACTIVE ad of the ad set PAUSED
   (newest wins), then the ad set and the campaign ACTIVE only if PAUSED.
   Each write passes the spend guard hook again, and the hook lets ACTIVE
   through only on those objects. A last read checks the creative again; a
   swap that raced the activation pauses the ad. The card shows the ad id and
   the paused ad ids. A failure part way ends the card `failed` with the step
   reached and is not retried, except an undo after a halt that Meta refused
   (RK9-565, see the spend guard's failed undos). An ad that was ACTIVE
   before the run is not paused by that undo.
4. **Skip, expiry, swap, re-send.** "🗑 Ohita" ends the card `skipped`. The
   `gate-expiry` job (every 5 min) moves cards past `valid_until` to
   `expired`; a tap checks `valid_until` itself. A creative swap closes the
   ad's open cards and is refused while an approved activation of the ad is
   running (30 min window). The kill switch, the cap pause and the scheduled
   pause close every open card of the company; a stale tap on a closed card
   keeps the reason on the card. `resend_gate_card` re-posts a pending card
   with a new token; the old card's buttons stop working. The ad stays PAUSED
   in every case but an approval.

Every decision stores `decided_by_tg_user_id`, `decided_at`, `outcome` and
`paused_ad_ids`, and writes an activity entry (`entityType: "gate_request"`).
The Telegram user is not mapped to a company member: the plugin has no
pairing source (`outcome.decidedBy.memberUserId` is null).
`tests/activation-sole-path.spec.ts` asserts that only the handler can set
anything ACTIVE.

| Key | Kind | What it does |
|---|---|---|
| `resend_gate_card` | action | `{ gateRequestId \| publicationId }`: posts a pending, unexpired activation card again |
| `gate-expiry` | job | Expires pending cards past `valid_until` and removes their buttons |

## Organic posting (RK9-832)

An organic (unpaid) Instagram or Facebook Page post from a staged creative. It
uses the Meta client of the plugin, the plugin's own gate kit and the Ads
digest. No core change: none of the five plugin SDK limits in `AGENTS.md`
applies (no core action is intercepted, no core approval is created, no
non-JSON webhook, no core table and no `activity_log` read, no secret that the
plugin must not see).

| Channel | Creative | Meta calls |
|---|---|---|
| `ig_reel` | video 9:16 | `POST {ig}/media` (REELS, `video_url`), wait for `FINISHED`, `POST {ig}/media_publish` |
| `ig_feed` | image 1:1, 4:5 or 1.91:1 | `POST {ig}/media` (`image_url`), wait, `POST {ig}/media_publish` |
| `fb_photo` | image | `POST {page}/photos` (`url`, `caption`) with the Page token |
| `fb_video` | video | `POST {page}/videos` (`file_url`, `description`) with the Page token |

1. **Card.** `organic.request` (board) or the agent tool
   `rk9ads_request_organic_post` takes `{ creativeId, channel, caption?,
   brandLint, aiGenerated? }` (for `aiGenerated` see "AI info label"). The service checks the creative (ready, not expired, the
   right media kind and aspect ratio), the caption (at most 2 200 characters
   and 30 hashtags) and the brand-lint JSON of rk9-motion
   (`scripts/brand-lint.mjs --json`). A missing result is refused. It recomputes the result from the rows, so a
   `fail` row refuses even when `ok` is true. A `draft` result is refused. It
   then sends one card to the brand chat: the preview, the channel, the mode
   line ("Tila: 🔴 LIVE" or "Tila: 🧪 Kuivaharjoitus"), the lint summary,
   every `human` rule as a "☐" line, and last the caption, with each line
   quoted as "│ ". A caption therefore cannot pass for a line of the card.
   A caption line, a rule line or a warning longer than 20 columns goes on in
   chunks, so a phone never wraps agent text onto an unquoted screen line
   (RK9-852). No chunk starts or ends with a space: a chunk that continues
   after a space starts with "┆ " (the space itself is not shown), and a chunk
   that continues inside a word starts with "↳ ". Two captions that differ by
   one space therefore never give the same card, and the card explains the
   two marks in one line above the caption when it uses them. An empty
   caption shows "(ei tekstiä)" as the card's own line, without "│ ", so it
   differs from a caption with that text. Rule and warning text is cleaned
   like the caption, right-to-left characters are removed from it, and it is
   clipped by graphemes. The width estimate (`columns` in
   `src/organic/card.ts`) overestimates the known cases and sums every code
   point of a grapheme: printable ASCII, the Latin-1 letters and the Finnish,
   Swedish, Estonian and German letters count 1 (W, M, @, % and AE count 2),
   a nonspacing mark 1, a spacing mark 2, the ZWJ between two emoji 0, and
   any other Latin letter, a letter of another listed script, an emoji, a
   skin tone, a regional indicator or a listed symbol 2. Anything else (an
   enclosing mark, a digraph or ligature, a long arrow, a multi-line bracket,
   an unlisted symbol or script, a private-use or unassigned code point, a
   grapheme of more than 10 code points) fills a chunk alone. A very large phone
   font can still wrap a chunk; a Telegram blockquote entity would close that
   gap (follow-up). A media URL with whitespace or a control character is
   refused at staging and on the card, and the card shows only the parsed URL. The rule text is cleaned like the caption.
   When the card cannot show the video itself (it falls back to the poster or
   to a text card), its first line says so and links the media.
   The buttons are "📣 Julkaise" (live) or "🧪 Kuivaharjoita" (dry run) and
   "❌ Hylkää". The card writes nothing to Meta. The caption is cleaned by an
   allowlist (`cleanCaption` in `src/organic/text.ts`), and the card shows the
   same cleaned string that the publish sends, so no hidden text reaches Meta:
   line breaks (NEL, U+2028 and U+2029 included) become a line feed; every
   other control, format character (Cf), default-ignorable code point and
   lone surrogate is removed, except U+FE0F once right after an emoji and the
   ZWJ between two emoji; every space separator and the braille blank U+2800
   become U+0020, runs of spaces become one, spaces at a line end go and at
   most two line feeds stay in a row; a base character must be a letter,
   digit, punctuation or symbol (private-use, unassigned and noncharacter
   code points go); the text is normalised to NFC; a combining mark stays
   only on a letter or digit of its own script (or when it is Inherited or
   Common), two in a row at most; an enclosing mark is always removed.
   Variation selectors and tag characters therefore go, so a subdivision flag
   (England, Scotland, Wales) shows as the black flag and a keycap emoji as
   its digit. **Limit (open, RK9-860):** the card guarantees that the
   published text is, character for character, the text on the card; it does
   not stop a message hidden in the choice of visible characters (an emoji
   with or without U+FE0F or a ZWJ, rare Inherited marks, and invisible
   marks of the base's own script such as U+1039, U+17D2, U+2D7F and
   U+1BC9D). **Not supported:** a caption with right-to-left text (Hebrew,
   Arabic, Syriac, Thaana, N'Ko and the other RTL scripts) is refused before
   the card (`invalid_caption`), because the card cannot show the visual order
   a phone gives mixed-direction text; so is a caption with a character
   cluster of more than 10 code points. The card locks its media (see "Media lock"). The
   same content (company, creative sha256, channel, caption) gets one open
   card; a second request returns the open post.
2. **Publish.** The tap goes through the kit router (chat, approver list,
   pending -> approved compare-and-set, update dedupe). The handler
   (`publishApproved` in `src/organic/service.ts`) checks the binding, re-reads
   the config and the creative hash, publishes only the media URL that the
   card showed (a changed URL closes the card), checks the media lock again,
   moves the post pending -> publishing and posts. The IG container id is
   stored before `media_publish`. The client has a write allowlist (`organicWriteGuard` in
   `src/meta/organic.ts`): only the four shapes above and a delete of the one
   named object. No ad edge, status field or budget field can pass. An IG
   `media_publish` error is checked against the container: `PUBLISHED` counts
   as success. The media id is then stored only when exactly one recent media
   item of the same kind has the same non-empty caption and no other post
   holds that id; otherwise it stays empty. A board delete refuses such a
   caption-matched id too, because another publisher may have posted the same
   text. A change of `organic.mode` after the card closes the card without
   a Meta write: the approver saw the mode on the card.
   A publish whose answer never came (network error, a Graph 5xx, an
   unreadable body, a 4xx without a Graph error body, a Graph error with code 1
   or 2 or `is_transient: true`, or a 2xx without an id)
   may still be live, and so may an
   IG `media_publish` error while the container is not yet ERROR or EXPIRED. The post then stays in `publishing`
   with `error: "result unknown: …"`, so the same content gets no second card.
   The publish client sends each write once (`retry.writeMaxAttempts: 1`): a
   rate-limit answer to a POST is not retried, because the first POST may
   have gone live; reads such as the container poll keep their retries. The
   handler also runs the caption rules on the stored caption before the
   publish, and a refused caption closes the post (`caption_refused`) without
   a Meta call
   (see "Reconcile"). An error Meta answered closes the post as `failed`.
3. **Reject.** "❌ Hylkää" edits the same card to the reason buttons (visual,
   text, claim, brand, topic, repeat). A reply to the card stores a typed
   reason as `other`. The first reason wins. The typed text is cleaned of
   control characters and clipped to 500 characters; the activity log stores
   only the reason code.
4. **Notices.** No reminders and no new Telegram messages. The card is edited
   in place, and the morning digest lists the last 24 hours under
   "📣 Orgaaniset julkaisut": published with the link, dry run, failed with the
   reason, rejected with the reason, expired, deleted.
5. **Delete.** `organic.delete { postId }` previews the DELETE by default. A
   real delete needs `dryRun: false`, `confirm: true` and a board user
   (`actor.type = "user"`); an agent is refused. It writes an activity entry.

Dry run is the default (`organic.mode: "dry_run"`): an approved card records
the planned calls in `organic_posts.payload.planned` and sends nothing to Meta.
Set `organic.mode: "live"` only after the operator grants the permissions
below.

`tests/organic-sole-path.spec.ts` asserts that no action, job, tool or forged
gate call publishes. Only an approved card does.

### AI info label (RK9-954)

`organic.request` and the agent tool take an optional `aiGenerated`. Set it to
`true` when the imagery of the post is AI-generated. The post then gets
Instagram's "AI info" label.

- **Param.** Only a real boolean is valid. Any other value (`"true"`, `1`,
  `null`) is refused with `invalid_request`. The default is `false`.
- **Channels.** `ig_reel` and `ig_feed` only. `fb_video` and `fb_photo` with
  `aiGenerated: true` are refused with `ai_label_unsupported`: Meta has no
  verified label field for a Page post.
- **Storage.** The flag is `organic_posts.payload.aiGenerated` (stored only
  when true), so there is no migration. A post from before RK9-954 reads as
  false.
- **Answer.** Every answer carries `aiGenerated`: `{ status: "card_sent",
  postId, gateRequestId, channel, mode, validUntil, aiGenerated }` or
  `{ status: "exists", postId, postStatus, channel, aiGenerated }`. For
  `exists` it is the stored flag. A caller compares it with the value it
  sent: an answer without the field comes from a plugin that ignores the
  param. A request whose flag differs from the open post's flag is refused
  with `ai_flag_mismatch`, and the open post is not changed.
- **Card.** A post with the flag shows one more line after the mode line:
  "AI-merkintä: kyllä (Instagramin AI info)".
- **Publish.** The IG container carries `is_ai_generated: true`. The write
  allowlist accepts that key only on `{ig}/media` and only with the boolean
  `true`. A post without the flag sends the same request as before.
- **Read-back.** After the publish the plugin reads
  `GET {media}?fields=is_ai_generated` and stores `payload.aiLabel`:
  `confirmed` (true), `missing` (false) or `unknown` (the read failed or the
  answer has no such field). Meta's documents do not confirm the field for
  `media_type=REELS`, so this read is the proof. The post is never deleted or
  unpublished because of the label. A label that is not `confirmed` shows on
  the edited card, in the post's `error` note, in the activity log
  ("ai label not confirmed") and on the post's line in the morning digest.
  The reconcile does the same read when it closes a post as published.
  `organic.posts` lists `aiGenerated` and `aiLabel` for each post.
- **Dry run.** The stored plan (`payload.planned`) shows `is_ai_generated`
  when the live request would carry it. Nothing is read back.

### Media lock (RK9-852)

Meta fetches the media URL only after the tap, up to `cardTtlHours` after the
card. The plugin cannot hash the file: `ctx.http.fetch` is text based and the
host stops a plugin request after 30 s, so a video never reaches the worker
byte for byte. The lock is fail-closed instead (`src/organic/media-lock.ts`):

1. A live card takes media only from a host in `organic.mediaHosts` (exact
   hostname, https, default port). A dry-run card only warns on the card.
2. At card time one HEAD stores Content-Type, Content-Length, ETag and
   Last-Modified in `payload.mediaLock`. A live card needs Content-Length and
   an ETag or a Last-Modified; a dry-run card only warns.
3. Just before the publish the same HEAD runs again. A different value, a
   missing header or a non-200 answer closes the card (`media_changed`)
   without a Meta call. A card without a lock (older than RK9-852) is refused.
4. With `organic.mediaHostTtlHours` the file expires at Last-Modified + TTL.
   The card ends 10 min before that; a card shorter than 5 min is not sent
   (`media_expiring`), and a later publish is refused (`media_expired`).

**Limit (open, RK9-860): the lock compares HEAD headers, not bytes.** A host
that serves other bytes with the same length and validators, or swaps the file
in the seconds between the second HEAD and Meta's fetch, goes unseen. That is
why only a host the operator trusts qualifies. The manifest sha256 is still
not checked against the bytes. A live config without `organic.mediaHosts`
refuses every live card (`media_untrusted`).

Sunspot's media host (`/api/social/media/[slug]`, `src/lib/server/social/mediaStore.ts`
in rk9-ai/sunspot, read 15.11.2026) keeps a file 120 min
(`SOCIAL_MEDIA_TTL_MIN`) and answers with Content-Type and Content-Length
only. A live card on it is refused (`media_unlockable`) until the host sends
an ETag (ideally the sha256 of the body) or Last-Modified. Set
`mediaHostTtlHours: 2` for it.

### Reconcile (RK9-852)

A post stuck in `publishing` (the worker stopped, or the result was unknown)
blocks its content. The job `organic-reconcile` (every 15 min) and the board
action `organic.reconcile { postId, closeUnknown? }` read the result from
Meta and never write to it. They wait until the publisher is done: 30 min
without an update, or 5 min after an unknown result.

| Case | Result |
|---|---|
| Dry run | `failed`: nothing was sent to Meta |
| IG, no stored container (row written by this code) | `failed`: `media_publish` never ran |
| IG, no stored container (row from before RK9-852) | stays open: the old code stored the id only at the end |
| IG container `ERROR` or `EXPIRED` | `failed` |
| IG container `FINISHED`, `IN_PROGRESS`, no or another status | stays open: as in the publish path, `media_publish` may have run |
| IG container `PUBLISHED` | `published`; the media id only from a unique caption match |
| FB, exactly one Page photo or video with the text since the tap | `published` (caption-matched id) |
| Anything unclear | stays `publishing`; the board closes it with `closeUnknown: true` after checking the account (`failed`) |

An unclear check touches the row, so the job (at most 20 rows a run, oldest
first) looks at it again only after another 30 min and reaches the other
stuck rows first. The FB check uses a read-only client on the Page token.
A caption-matched media id cannot be deleted from the board. A pending post
that never got a card id (the worker stopped between the insert and the card)
reads as `expired` after 10 min, so its content can get a new card.

The FB lookup reads `{page}/photos?type=uploaded` and `{page}/videos` with the
Page token. Whether `pages_read_engagement` suffices for it is not verified
against a live Page.

### Meta permissions (operator decision)

Organic posting needs permissions that the current ads token does not have.
The plugin does not request them; a new permission is the operator's decision.

| Token | Config field | Permissions |
|---|---|---|
| System user token (IG) | `meta.accessTokenRef` | `instagram_basic`, `instagram_content_publish` |
| Page access token (FB) | `organic.pageAccessTokenRef` | `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` |
| Delete of an IG post | `meta.accessTokenRef` | open (M3, RK9-852): not verified whether `DELETE {ig-media-id}` works at all, nor which permission it needs (maybe `instagram_manage_contents`). Verify on a test account before relying on the board delete for IG; until then delete an IG post in the Instagram app |

In live mode the card request reads `me/permissions` and refuses an IG card
when a permission is missing. The IG user id goes to `meta.igUserId`.

### Config (`organic`)

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The tool and the actions refuse while false |
| `mode` | `dry_run` | `live` posts to Meta after the tap |
| `channels` | — | At least one of `ig_reel`, `ig_feed`, `fb_video`, `fb_photo` |
| `pageAccessTokenRef` | — | Secret ref; required for an `fb_*` channel |
| `cardTtlHours` | 24 | 1..168; an expired card does not publish |
| `mediaHosts` | `[]` | Exact hostnames a live post takes media from; empty = no live post |
| `mediaHostTtlHours` | — | How long the media host keeps a file from its Last-Modified; the card ends before that |

### Install and update

Migration 006 adds `organic_posts` and the gate kind `organic_publish`. The
capabilities do not change.

Before the first prod install, check the name of the gate kind CHECK that
migration 006 drops. It assumes the Postgres default name
`gate_requests_kind_check`. The check was not run (15.11.2026: no read access
to the prod database from the worktree). Run it read-only:

```sql
SELECT n.nspname, c.conname, pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE t.relname = 'gate_requests' AND c.contype = 'c';
```

If the name differs, 006 fails on `DROP CONSTRAINT` and the install stops
before any change (the host runs a migration in one transaction). Install as in ADR 5. In prod, update with a soft
uninstall, then `paperclipai plugin install --local <abs path>` from a pinned
checkout. Plugin jobs run in UTC.

| Key | Kind | What it does |
|---|---|---|
| `organic.request` | action | Opens one card for a staged creative |
| `organic.posts` | action | Lists the posts of the company (newest first) |
| `organic.delete` | action | Previews or deletes a published post (board only) |
| `organic.reconcile` | action | Closes a post stuck in `publishing` from Meta's answer (board only) |
| `organic-reconcile` | job | The same for every company, every 15 min |
| `rk9ads_request_organic_post` | tool | The agent path to `organic.request`; it cannot publish |

## Operator UI (RK9-518)

`src/ui/` (slots in the manifest) and `src/features/ui/` (worker views).

- **Mainonta page** (`/ads`): MTD spend against `monthlyCapEur` with the
  projection and the `spend_cap` status, the standing spend risks
  (`spend.risks`) as warnings (RK9-563), the standing halt (when, who, why)
  with a board-only clear, the kill switch, the publications with their Meta
  status, CTR, CPC and fatigue, the pending activation cards (resend), the
  rule log of 7 days, 14 days of spend, and a digest preview. Meta's
  `spend_cap` is lifetime: the status compares its headroom
  (`spend_cap - amount_spent`, `headroomEur`) with what is left of the month
  (`remainingEur`), not the cap itself with `monthlyCapEur` (RK9-563), and
  only on an EUR account, like the digest (RK9-581). The
  pending cards are read with `valid_until > now()` in SQL, soonest-expiring
  first, at most 50.
- **Settings** (company settings, `ads`): a redacted config summary with a
  link to the host config form, the preflight checks with a re-run, the
  provision dry run, and the rule editor (pause rules only).
- **Dashboard widget**: MTD against the cap, pending cards, and the halt.
- **Views** `ads-overview`, `ads-widget`, `ads-settings` (and `rules`,
  `preflight-status`): read-only actions that return allowlist DTOs
  (`dto.ts`). They never carry raw config, secret refs or tokens; every value
  goes through `sanitize()`. They are actions, not data handlers, so the
  company comes from the host's `context.companyId` (RK9-583). A data
  handler gets only params, and a bridge call without a company (instance
  admin only) kept the caller's own `params.companyId`. The pages load them
  with `ui/view-data.ts`, which has the shape of `usePluginData` (data,
  loading, error, refresh). The plugin registers no data handler at all:
  `spend-guard` and `publication` are read actions too (RK9-603).
- **Action** `pause-ad` `{ adId, dryRun?, confirm?, idempotencyKey? }`: pauses
  one ad of the brand's ad account. `dryRun` defaults to true. A real pause
  needs `confirm: true`, a board user and `idempotencyKey` (8-100 of
  `A-Za-z0-9_-`, the page sends one per confirmation, RK9-563). A repeat with
  the same key on an ad that is already PAUSED writes nothing and returns
  `duplicate: true`. The key's `alert_dedupe` marker is written only after a
  pause Meta confirmed (RK9-581), so any other repeat (the ad still runs,
  or a first call died before its halt and card close) pauses again, and a
  failed pause leaves no marker. Markers older than 24 h are deleted when a
  new one is written. A repeat that arrives while the same user's call with
  the same key still runs joins that call and returns its result with
  `duplicate: true` (RK9-583), so two quick clicks write one audit row. The
  page shows the joined result's `auditError` warning too (RK9-603). It writes a `rule_actions` row
  (`rule_type: kill_switch`, `object_type: ad`, `source: ui`) and an
  activity entry. Before the Meta write it stores a 30-minute halt for the
  ad (`adHalt`, RK9-566), then closes the ad's open activation cards
  (`closedCardIds`), also those whose ad column is empty, found by the
  card's binding. `activate_ad` reads the ad's halt with the company's
  halts, before every ACTIVE write and after the writes, so an activation
  approved just before the pause pauses the ad again, and a card of the ad
  tapped while the halt holds is refused. A board user lifts it early with
  `clear-halt` `{ adId, id }` (the page offers it after the pause).
  `cardsError` names cards that did not close; `activationRunning` an
  approved activation that may still run; `haltError` a halt that was not
  stored. An activation
  that stalls longer than the halt before its last halt check is not
  stopped by it. The page keeps these per ad. The closed cards say whether Meta
  confirmed the pause. There is no activate, resume or scale action (G1, G9).
- **Money actions in the UI** (the kill switch, pause-ad, the halt clear,
  provision, switching the rules to live) need a dry-run preview and a typed
  word before the live call.
- **Weakening rule saves** need the typed word `HEIKENNÄ` (RK9-562): live mode
  off, a live rule or the cap to shadow, an enabled rule removed or disabled,
  and a live rule's parameter changed so that it fires less (RK9-566): the
  metric, the operator's direction or gte -> gt / lte -> lt, the threshold
  in the operator's direction, any change of `days` or `aggregate`, a higher `minImpressions`,
  `minClicks`, `minSpendEur` or `cooldownHours` (also the cap's). A shadow
  rule's tuning is not checked. `rules.prepareSave` compares the draft with
  the config saved now and refuses an unconfirmed weakening or live-mode
  save, naming the changes (`confirm`); the page then asks `HEIKENNÄ`, and
  `LIVE` too when the save also turns live mode on, or, with live mode on,
  makes a rule live (from shadow, switched on, or new; `confirm.live`,
  RK9-563). `LIVE` covers only the listed live changes (`confirmedLive`): one
  that appears after it refuses the save (RK9-581). The page sends the rules
  its draft loaded (`loaded`); when the saved rules differ from them, the
  save is refused as `stale` and the page reloads the rules (RK9-581).
  Saved rules that no longer parse are compared as saved, so broken rules
  saved elsewhere refuse the old draft too. When the reload finds the
  brand invalid or disabled, the page says so and drops the draft instead
  of promising rules to edit (RK9-583). The browser's save checks both again against the config read
  right before the POST. That read must also show the `updatedAt` the editor
  loaded: a config saved since, on the host's form or in another tab,
  refuses the save, and the page does not save before that version was read
  (RK9-563). A config without `rules.list` counts as the
  default rules. These checks guard
  against an operator's mistake, not against an instance admin: the host's
  own config form saves any schema-valid config (also `liveMode: false`)
  without asking the plugin, and the host route has no compare-and-swap.
- The kill switch stays on the page when the config is invalid or
  unavailable; `pause-all` then runs on the last valid config.

## Brand config, preflight and provisioning (RK9-510)

### Config fields

The spec's field names map to the scaffold's `BrandConfig` (G11) like this:

| Spec | Config path |
|---|---|
| brandCode, namingPrefix, monthlyCapEur | same names at the top level |
| adAccountId, pageId, igUserId?, datasetId? | `meta.*` (`act_` prefix is stripped) |
| metaTokenRef | `meta.accessTokenRef` (secret_ref) |
| landingUrl | `landing.urls[landing.defaultUrlKey]` |
| allowedLandingDomains[], utmTemplate | `landing.allowedDomains`, `landing.utmTemplate` |
| telegram{chatId, approverUserIds[], botTokenRef} | `telegram.chatId`, `telegram.allowedUserIds`, `telegram.botTokenRef` |
| schedule{}, rules{}, fatigue{} | same names (run by their own features) |

`monthlyCapEur` defaults to null. A config without it is valid but
`disabled`: `onValidateConfig` warns, every feature treats the brand as off,
the preflight still runs and reports `launchReady: false`. Secrets are only
`{ type: "secret_ref", secretId, version? }` objects; a raw token fails the
host's save check.

Ololla (OLL company):

```json
{
  "brandCode": "OLL", "displayName": "Ololla", "monthlyCapEur": 100,
  "meta": {
    "adAccountId": "act_29231592883113369", "pageId": "1284777064729996", "datasetId": "1473972751305488",
    "accessTokenRef": { "type": "secret_ref", "secretId": "<OLL meta.ads_access_token>" }
  },
  "landing": { "allowedDomains": ["ololla.fi"], "urls": { "home": "https://www.ololla.fi/" } },
  "telegram": {
    "botTokenRef": { "type": "secret_ref", "secretId": "<OLL telegram.rk9ads_bot_token_prod>" },
    "chatId": "-5540940287", "allowedUserIds": ["440715827"]
  }
}
```

The two secret ids of the OLL company (secret references, not values; the
dev instance uses another bot, G17):

| OLL secret | Secret id |
|---|---|
| Meta system user (meta.ads_access_token) | f9567c7b-627c-4c7d-9781-745fb3eb448d |
| Telegram bot (telegram.rk9ads_bot_token_prod) | 370f0ce5-1333-4a64-a276-c5f86eb7f3cc |

`tests/fixtures/ololla-brand-config.json` is the same config with placeholder
secret ids.

### Actions and data (company from the host context)

| Key | Kind | What it does |
|---|---|---|
| `verify-connection` | action | "Tarkista yhteys": the live preflight, cached in plugin state |
| `provision` | action | `{ dryRun?, confirm?, dailyBudgetCents?, campaignId?, adSetId? }`; dry run unless `dryRun: false, confirm: true`; a real run is board-only (an agent gets the dry run only) |
| `preflight-status` | action (read) | The cached preflight and `fresh`; no Meta call |

The buttons belong to the operator UI (A12, G13). Until then an operator calls
the actions through the host's plugin action API.

### Preflight checks

Each check returns `pass`, `fail` or `skipped`, a typed `reason` and a
redacted `detail`:

| Check | Passes when | Fail reasons |
|---|---|---|
| `token_scopes` | `me/permissions` grants ads_management and ads_read | `missing_scopes`, `token_invalid`, `token_unresolved` |
| `ad_account` | EUR, `timezone_name` = config `timeZone`, `account_status` 1 | `currency_not_eur`, `timezone_mismatch`, `account_not_active`, `account_unreachable` |
| `spend_cap` | spend_cap set, headroom > 0 and at most the rest of the monthly cap (G2) | `monthly_cap_unset`, `no_spend_cap`, `spend_cap_reached`, `spend_cap_headroom_exceeds_remaining` |
| `page` | the page reads | `page_unreachable` |
| `ig_actor` | configured `igUserId` reads, or the page has `instagram_business_account` | `ig_unreachable`; skipped `ig_not_linked` (Facebook placements only) |
| `dataset` | `datasetId` is in `act_<id>/adspixels` | `dataset_not_attached`; skipped without a datasetId |
| `telegram` | getChat + getChatMember say the bot can post | `telegram_not_configured`, `telegram_token_unresolved`, `telegram_token_invalid`, `telegram_chat_unreachable`, `telegram_cannot_post` |

`launchReady` = every required check passed and `monthlyCapEur` is set. A
skipped check is never required; `ig_actor` is required only with a configured
`igUserId`, `dataset` only with a `datasetId`. The spend_cap rule is the
guard's month position (RK9-526), not "spend_cap <= monthlyCapEur".

`assertLaunchReady()` (`src/brand/preflight.ts`) is the gate of every
mutating path: provision here, activation in A9. It re-runs the preflight when
the cached result is older than 15 min, belongs to another config (sha256 of
the parsed config) or is not launch-ready, and throws `LaunchNotReadyError`
when the fresh result is not launch-ready.

The token check uses `me/permissions`, not `debug_token`: `debug_token` takes
the inspected token as a query parameter, and the Meta client sends a token
only as a Bearer header. The Telegram check sends no test message.

### Expired token (Graph 190)

The job or action fails at once; the Meta client never retries a 190, and the
preflight skips its later Meta checks. `reportTokenInvalid()`
(`src/brand/token-alert.ts`) sends one Telegram message and creates one issue
in the brand company with originKind `plugin:rk9-ads` and originId
`rk9-ads:<brand>:token_invalid`. alert_dedupe markers make both once per
incident. The next successful token check clears the Telegram marker, so a
later 190 is messaged again. The issue marker stays: the plugin has no
issues.read and cannot see whether the old issue is still open, so a brand
gets one token issue (RK9-538). Close it after rotating the token, and reopen
it for a later incident.

### Provision

Creates one OUTCOME_TRAFFIC campaign and one ad set, both PAUSED and named
`<namingPrefix>-traffic` (G8: permanent, no month in the name).

- daily_budget = floor(monthlyCapEur * 100 / 31) cents (G3; Ololla: 322).
  The ad set is permanent and provision sets its budget only when it creates
  it, so the budget fits the longest month: a budget sized to a 30-day month
  (333) would project above the cap on 1 December and the spend guard would
  refuse its activation (RK9-538). A larger request is refused before any API
  call; one below Meta's `min_daily_budget` before any write. An adopted or
  reused ad set with a larger budget is reported as `adSetBudgetAboveCap`.
- Ad set: LINK_CLICKS, IMPRESSIONS, LOWEST_COST_WITHOUT_CAP, destination
  WEBSITE, Finland, 18+, Advantage audience off. Campaign:
  `special_ad_categories` from the config (G6), no campaign budget and
  `is_adset_budget_sharing_enabled: false` (the spend guard lets only `false`
  through).
- Idempotent: an id given to the action or set in the config is verified
  (ad account, ad set under the campaign) and adopted; otherwise the
  brand_bindings row, then an exact name match, is reused. Only when nothing
  matches does it create. Two campaigns with the brand name are refused. A
  stored id falls back to the name match only when Graph says the object is
  gone (code 100) or it is in another account, dead or under another
  campaign; a 5xx or any other error fails the run, so a renamed object is
  never duplicated.
- A real run passes `assertLaunchReady`, writes through the spend-guarded
  brand client, logs one activity entry per created object and stores the ids
  in brand_bindings. One run per company at a time (in-process lock; one
  worker).

### Sunspot (AUR) config, read-only (G19)

For the parity and smoke tests only; Sunspot's ads stay paused in this epic.
Not installed in prod by RK9-510.

1. In the AUR company, add a secret with a read-only token (ads_read) of the
   Sunspot system user. Do not reuse or regenerate the token of the organic
   runner (G5).
2. Save a config with `brandCode` "AUR", `monthlyCapEur` null (disabled, so
   nothing can spend), `meta.adAccountId` "act_1336862981968191",
   `meta.pageId` "1216714361516949", `meta.campaignId` "120247250925830775"
   and `meta.adSetId` "120247250925850775" (Aurinkopulssi, adopted, never
   created), `landing.urls.get` "https://sunspot.fi/get".
3. Run `verify-connection`. Expect `launchReady: false`: `token_scopes`
   fails with `missing_scopes` (an ads_read token has no ads_management) and
   the cap is unset (`monthly_cap_unset`). The account, page and spend_cap
   checks should pass. Do not run `provision`.

A disabled brand that was never enabled is skipped by `scheduled-pause` and
`rules-evaluate`. A
brand that was enabled before and is then saved disabled keeps the ADR 3
fallback: the pause side runs on its last valid config, and `rules-evaluate`
fails its first run of each local day. Delete the config to remove the brand.

`tests/fixtures/sunspot-brand-config.json` is the same config with a cap, for
the mocked preflight test.

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

### The Meta client (RK9-508)

All Meta calls go through `src/meta/`. Other children import from there and
build no Graph helpers of their own (G12).

- `createMetaClient(ctx, { companyId, tokenRef: config.meta.accessTokenRef, mode })`
  returns a `MetaGraphClient`. It sends every request through `ctx.http.fetch`.
  It resolves the token with `ctx.secrets.resolve` on each call and sends it as
  an `Authorization: Bearer` header, never in the URL.
- Request bodies are form-encoded strings. The worker RPC turns any other body
  into `String(body)`, so FormData and Blob cannot cross it. Media therefore
  goes by URL (G4): a video with `uploadVideoByUrl` (`file_url`), an image with
  `uploadImageBytes` from base64 the brand repo already made.
- Modes: `live`; `readOnly`, where a write throws `ReadOnlyViolationError`
  before any fetch; and `dryRun`, where a write is logged (redacted) and returns
  `{ dryRun: true, planned }`.
- Every write passes the `guardedWrite` hook first, with the normalised path
  that is actually sent. The spend guard, the kill switch (RK9-511) and the
  activation gate plug in there. The default hook, `pausedOnlyWrites`, is an
  allowlist that fails closed on spend. It allows media and creative uploads,
  campaign, ad set and ad creates with `status: "PAUSED"`, a pause or rename of
  an object and a bare delete. It refuses everything else, for example
  activation, budget changes and the copies or async batch edges. `createAd`
  always sends PAUSED.
- List and insights methods throw when the page cap cuts the result short, so
  a spend sum is never built on partial data.
- A GET cannot carry a write: the client refuses the `method`, `batch` and
  `access_token` parameters and any parameter name that is not a plain
  identifier, also in a paging `next` URL.
- Errors are typed: `TokenInvalidError` (190), `RateLimitError` (4, 17, 613,
  80004), `InvalidParamError` (100), `PolicyAcceptanceRequiredError` (subcode
  2859024, with the fix in the message) and `MetaGraphError` for the rest.
  Rate limits are retried with exponential backoff, at most 5 attempts. The
  wall-clock time per request, fetches included and the slowest fetch so far
  reserved for the next attempt, stays under 25 s, because the host aborts a
  plugin fetch after 30 s. The budget is per request: a long paging walk
  belongs in a job, not in an action or API route. When
  Meta's own `estimated_time_to_regain_access` is longer than that, the client
  throws at once and sets `retryAfterMs`.
- `redact.ts` removes the token from error messages, logs, activity metadata and
  dry-run plans, as a known value and by shape (`access_token=`, `Bearer`,
  `EAA...`). Errors carry no `cause`.
- Version drift: when a paging `next` URL or the `facebook-api-version`
  response header shows a version other than `GRAPH_VERSION`, the client warns
  once (logger and one activity entry) and `onHealth()` reports `degraded`.
  Paging stays on the pinned version and on the edge being walked. A `next`
  URL on any other host or path is refused, because the client would send its
  token there. The activity entry is written once per worker and observed
  version.

The first live smoke (14.10.2026) showed `facebook-api-version: v25.0` on
answers to v23.0 requests: Meta upgrades calls to a deprecated Marketing API
version automatically. Marketing API v23.0 expired on 9.6.2026 and v24.0 on
6.10.2026, so `GRAPH_VERSION` was bumped to v25.0 on 26.10.2026. The bump did
not change behaviour, because Meta already answered every call as v25.0.
Bumping `GRAPH_VERSION` is a one-line change, made as a separate, reviewed
step. Check the expiry dates in Meta's
[versions table](https://developers.facebook.com/docs/graph-api/changelog/versions/)
before each bump.

Run the live smoke (read-only, Sunspot G19):

```sh
RK9_ADS_LIVE_SMOKE=1 pnpm exec tsx scripts/live-smoke-sunspot.ts [--record <dir>]
```

It reads `META_ADS_ACCESS_TOKEN` from the environment or from
`~/.config/sunspot/meta-ads.env`. `--record` writes each Graph answer,
token-scrubbed, as a fixture file. The fixtures in `tests/fixtures/meta/` name
their source: recorded live, or hand-written from the recorded shapes.

### ADR 3: No per-company enable switch

An absent or empty company config means the plugin is off for that company. A
valid config means it is on. An invalid config is reported (`onValidateConfig`,
smoke activity) and treated as off. A valid config without `monthlyCapEur` is
`disabled` (RK9-510): off for every feature, but the preflight can check it. There is no `enabled` flag to forget in the
wrong state. Removing the config turns a brand off. The emergency stop is the
kill switch (RK9-511), not a config flag.

The host checks a saved config only against the JSON schema, not with
`onValidateConfig`. A live brand can therefore end up `invalid` after an edit
(for example a mistyped time zone). A job that acts for safety (pause, spend
guard, scheduled pause) treats `invalid` and `unavailable` like a live brand it
cannot read: it warns and keeps the pause side working, it never skips silently.
`listCompanyConfigs()` returns `unavailable` when the host refuses a company that
has a saved config (an instance-scoped marker per company records that).

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
