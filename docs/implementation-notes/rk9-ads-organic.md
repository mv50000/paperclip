# RK9 Ads: organic posting (RK9-832)

The user-facing description is in `packages/plugins/plugin-rk9-ads/README.md`, section
"Organic posting (RK9-832)". This note records the decisions and the traps.

## Decisions

- **One gate, a new kind.** Organic cards reuse the `gate_requests` table and
  the kit router with the kind `organic_publish`. Migration 006 replaces the
  kind CHECK of migration 001 with `ALTER TABLE ... DROP/ADD CONSTRAINT`.
  The host validator accepts ALTER TABLE. Migration 001 stays unchanged
  because the host stores a checksum for each file.
- **The reason goes on the same card.** A rejection edits the card to the
  reason buttons (`g:r<i>:<token>`). A typed reason is a reply to the card.
  The bot sends no new message (RK9-815). The kit stores the reason in
  `gate_requests.outcome` with a compare-and-set on `outcome IS NULL`, so the
  first reason wins. The organic service copies the reason to
  `organic_posts.reject_reason_*`.
- **Dry run is the default.** `organic.mode` is `dry_run` until the operator
  grants the permissions and sets `live`. The acceptance run of RK9-832 is a
  dry run on a mocked Meta client: there is no test IG account.
- **A separate Page token.** FB channels use `organic.pageAccessTokenRef`.
  The ads system-user token cannot post as the Page.
- **FB video uses the legacy edge.** `POST {page}/videos` with `file_url` is
  on the Graph host. The resumable Reels upload is on another host, and
  `tests/no-graph-literals` allows only one Graph base.
- **No halt check.** The kill switch and the cap pause stop spend. An organic
  post does not spend money, so the halts do not block it. A disabled brand
  (`monthlyCapEur` null) still cannot approve, because the router's
  `freshBrandFor` needs an enabled config.
- **Notices go to the digest.** `digest/run.ts` reads `organic_posts` of the
  last 24 hours. The organic code uses no `alert_dedupe` row and sends no
  Telegram message.

## Traps

- **A quote in a migration comment breaks the migration.** The host's
  `stripSqlForKeywordScan` (`server/src/services/plugin-database.ts`) removes
  quoted strings before it removes `--` comments. An apostrophe in a comment
  ("host's") opens a string that swallows the next statements. The host then
  refuses the file with "Plugin migrations may contain DDL or namespace-scoped
  backfill statements only". Keep migration comments free of `'` and `"`.
- **Test harness actors.** `harness.performAction` defaults the actor to
  `system`. A board-only action needs `{ actor: { type: "user" } }` in the
  test options.
- **The harness database is empty.** `createTestHarness` answers every query
  with no rows. The full-worker sole-path test therefore reaches no creative.
  The feature-level sole-path test uses memory stores and drives the gate
  handler with forged requests.
