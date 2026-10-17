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

Hand the manifest to the plugin in one of two ways. Both call the same
`stageCreative()` and return the same body.

- An agent calls the tool `rk9ads_stage_creative` with `{ "manifest": { ... } }`.
  The company is the agent run's own company.
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
that starts with the code. A staged creative holds at most a Meta video id:
nothing in it can spend money. Publishing and activation belong to the publish
pipeline and the Telegram gate.

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
  gate, the UI action and the agent tool pause with that config, always on the
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
- **Job** `scheduled-pause` (every 5 min UTC). It sends the 80 % and 100 % MTD
  alerts (once per brand, local month and threshold) and the risk alerts
  (once per brand, local day and risk): no `spend_cap`, Meta's headroom above
  the rest of the monthly cap, or a projection above the cap. One pause card
  carries every new alert (`alert_dedupe`); a failed send gives its markers
  back, fails the run and is sent on the next check. There is no automatic
  pause at 100 %: the A6 spec asks for an alert, and Meta's `spend_cap` is the
  hard stop (RK9-523). The job runs the scheduled pause once per local day at
  or after `schedule.scheduledPause.at` (off by default). It also runs the
  data gate when `schedule.dataGate` is set. The gate's predicate `value
  <operator> threshold` is the condition for the ads to keep running. A JSON
  pointer to an array counts its items. An unreadable feed pauses nothing
  (fail-open), but it fails the run so the broken feed is seen. A Telegram
  failure after a pause fails the run, and the pauses stay.
- **Data** `spend-guard` (`getData`) and the tool `rk9ads_get_pacing` return
  the guard figures and the alerted thresholds. They never return a token.
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
  union in `schema.ts` (config.ts calls `parseRules()`). Rule types:
  - `threshold_pause`: `metric` (`cpc`, `ctr`, `cpm`, `frequency`, `spend`)
    `operator` `threshold` on `days` consecutive completed Helsinki days,
    behind `minImpressions` and `minClicks` (window totals, both required;
    equal fires). CPC and CTR are link metrics (G18). A day with spend and no
    link click counts as an infinite CPC.
  - `pause_all_cap`: built in. Pauses the whole ad account (A6's `pauseAll`)
    when month-to-date spend is at 90 % of `monthlyCapEur` or more. MTD is the
    spend guard's (RK9-526) and must be in EUR. A list entry
    `{ type: "pause_all_cap", mode }` only sets its mode and cooldown (at most
    24 h); it cannot be disabled or removed.
  - `pause_valid_until`: pauses an ad whose creative `validUntil` has passed.
  - `pause_fatigued`: opt-in; pauses an ad that A10 calls `fatigued`.
  - `propose_scale`: schema only, must stay `enabled: false` (G9).
- **Defaults:** without `rules.list` the brand gets `cpc-ceiling` (CPC > 0.50
  EUR on 2 days, ≥ 500 impressions, ≥ 10 link clicks) and the built-in cap
  rule. Every rule starts in `mode: "shadow"`. A Meta write needs the rule's
  `mode: "live"` and the brand's `rules.liveMode: true`.
- **Job** `rules-evaluate` (`0 * * * *`): reads ad and campaign status, the
  guard's MTD, `insights_daily`, creative `validUntil` and earlier
  `rule_actions`, then calls the pure `evaluateRules()`. Today's partial day
  never counts, and threshold rules wait until `insights-daily-close` has
  finalised yesterday. Only ACTIVE ads get a decision, account-wide like the
  kill switch (RK9-523: the ad account belongs to the brand). A failed status read pauses
  nothing (fail-open) and fails the run; one brand's failure does not stop
  the others.
- **Cooldown** `cooldownHours` (default 24, 1–720): a rule does not decide on
  the same object again inside the window. Shadow counts shadow decisions;
  live counts only applied live pauses, so a failed pause is retried.
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
   POSTs only `{ creative: { creative_id } }` to an existing ad of the same
   ad account.
6. **Hand-off**: after `published`, `onPublished(publication)` in
   `src/publish/handoff.ts` runs exactly once per publication. It is a no-op
   until the activation gate (A9, RK9-517) implements it. Nothing here
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
creative made for an ad that was never created is deleted; if Meta refuses
the delete, `payload.cleanup` names it and the re-run reuses it.

**Async.** The action records the row, starts the run as a background
promise of short Graph calls (each well inside the host's 30 s RPC limit),
and waits at most `waitMs` (default 10 s, at most 20 s). A longer run
returns `pending`; poll the `publication` data key. A worker restart cuts a
run off; publish again with the same input to resume it.

Every Meta write writes an activity entry: `entityType: "rk9_ads_publication"`,
`entityId` the publication id, `metadata.metaObjectId` and `metadata.step`.
No token or secret goes into it.

| Key | Kind | What it does |
|---|---|---|
| `publish` | action | `{ creativeId \| manifest, text?, placement?, sizeBytes?, durationSec?, idempotencyKey?, dryRun?, confirm?, waitMs? }`. Dry run (the full planned payloads, no Meta call) unless `dryRun: false, confirm: true`. A real run needs `creativeId` and a launch-ready preflight |
| `swap-creative` | action | The same plus `adId`: a new creative on an existing ad; its status is never touched |
| `publication` | data | `{ publicationId }`: status, Meta ids, error and cleanup of one publication |

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
| `preflight-status` | data | The cached preflight and `fresh`; no Meta call |

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

A disabled brand that was never enabled is skipped by `scheduled-pause`. A
brand that was enabled before and is then saved disabled keeps the ADR 3
fallback: the pause side runs on its last valid config and the run fails.

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
version automatically. Bumping `GRAPH_VERSION` is a one-line change, made as a
separate, reviewed step.

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
