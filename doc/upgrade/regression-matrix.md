# Regressiomatriisi — forkin commitit ja upstream-konfliktit

Lähtötila upstream-päivitykselle (epic [RK9-303](/RK9/issues/RK9-303), lapsi RK9-304).
Tämä dokumentti on hyväksyntäportti: jokainen porras (ks. `doc/UPSTREAM-UPGRADE.md`, osio
"Porrastusmalli") ajaa tämän matriisin tarkistukset ennen mergeä masteriin.

## Lähtötila (jäädytetty 2026-09-26)

| Asia | Arvo |
|---|---|
| Pre-upgrade-SHA (`origin/master`) | `9ed8e7704bd49da4064499de8477ae0a42e593e7` |
| Forkin haarautumiskohta upstreamista | `d0bdbe11a9624435b6dca3968389bd59c6a559a2` (`canary/v2026.428.0-canary.1`) |
| Ei-merge-committeja `d0bdbe11a..origin/master` | 142 |
| Upstream `upstream/master` fetch-hetkellä | `7f3c06dac` (2026-09-25) |
| Koemerge `origin/master` + `v2026.916.1` | 93 konfliktitiedostoa (ks. alla) |
| Forkin omat vitest-tiedostot | 69 tiedostoa, 752 testiä — lista `doc/upgrade/fork-tests.txt` |
| Tuotantohakemisto `/home/rk9admin/paperclip` | HEAD `486ac30ee`, 2 committia jäljessä `origin/master`ista |

Tuotantohakemiston likaiset tiedostot (`server/scripts/process-adapters/cicd-failure-watch.sh`,
`skills/prh-prospector/SKILL.md`, `wh.psd1.template`) ovat operaattorin keskeneräistä
rinnakkaistyötä. Niitä ei committoida tässä muutoksessa eikä stashata sokkona. Niiden
omistaja päättää niistä ennen ensimmäistä porrasta; pre-upgrade-SHA on silti yllä oleva
`origin/master`, koska harjoitus- ja porrasbranchit tehdään siitä, ei tuotantohakemistosta.

Vahvistetut upstream-tagit (`git fetch upstream --tags`, 2026-09-26):

| Porras | Tag | Commit | Päiväys |
|---|---|---|---|
| 1 | `v2026.512.0` | `c445e5925628` | 2026-05-12 |
| 2 | `v2026.609.0` | `a0f7d3dabaf5` | 2026-06-09 |
| 3 | `v2026.720.0` | `903bd157c22a` | 2026-07-20 |
| 4 | `v2026.817.0` | `213dabab4f8e` | 2026-08-17 |
| 5 | `v2026.831.1` | `65ec059bde30` | 2026-09-01 |
| 6 | `v2026.916.1` | `d554c4789ed3` | 2026-09-21 |

`v2026.916.1` ja `upstream/master` vaativat `engines.node >=24.11.0`.

## Pakollisesti vihreät tarkistukset jokaisessa portaassa

1. `scripts/upgrade-smoke.sh --offline --fork-tests` — migraatiojournal 9001–9010 ja kaikki
   `doc/upgrade/fork-tests.txt`:n tiedostot.
2. `scripts/upgrade-smoke.sh <harjoitusinstanssin URL>` — reitit: health, github-webhooks,
   Resend- ja SES-inbound, outreach digest ja `/metrics`, unsubscribe, risk.
3. `pnpm -r typecheck && pnpm test:run && pnpm build`.
4. Yksi `claude_local`-heartbeat per aktiivinen yritys harjoitusinstanssissa (egress estetty).

Tunnettu poikkeus: `server/src/__tests__/email-routes.test.ts` on vihreä CI:n `verify`-jobissa
(2,3 s), mutta sen 3 testiä aikakatkaistuvat (5 s) paikallisesti paperclip-01:llä.
Syy on todentamatta. Tarkista se ajamalla tiedosto yksin CI:ssä tai toisella koneella.
Portaassa tämä tiedosto tulkitaan CI:n tuloksen mukaan.

## Kyvyt

| Kyky | Committeja | Joista automaattinen testi | Oletustarkistus ilman testiä |
|---|---|---|---|
| ci/tooling | 18 | 0 | ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| email/support/escalation | 16 | 8 | smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| core api | 15 | 9 | manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| github-webhooks | 15 | 3 | smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| heartbeat | 15 | 7 | manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| outreach | 15 | 15 | smoke: `scripts/upgrade-smoke.sh` (outreach digest, /metrics, /u/:token) + manuaalinen digest-luku |
| claude-local | 14 | 9 | manuaalinen: yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| knowledge/qmd | 11 | 11 | manuaalinen: recall-kutsu agentin heartbeatissa |
| docs | 7 | 0 | ei ajonaikaista käytöstä — tarkista linkit |
| risk | 6 | 4 | smoke: risk-reitit; manuaalinen: /<prefix>/risks-näkymä avautuu |
| slack | 5 | 5 | manuaalinen: Slack-notifikaatio harjoitusinstanssissa (egress estetty → tarkista lokista yritys) |
| migrations 9001-9010 | 2 | 0 | smoke: journal-järjestystarkistus (`scripts/upgrade-smoke.sh --offline`) |
| skills | 2 | 0 | manuaalinen: skill näkyy company skills -listassa |
| cicd-failure-watch | 1 | 0 | manuaalinen: `bash -n server/scripts/process-adapters/cicd-failure-watch.sh` + yksi process-adapter-ajo |

Kyky "core api" kattaa forkin muutokset issue-, agentti- ja execution-policy-reitteihin
(checkout-race, outcome requirements, human_proxy, run-id-guard). "ci/tooling" ja "docs"
eivät muuta ajonaikaista käytöstä.

## Migraatiot 9001–9010

| Numero | Tiedosto | Lisännyt commit | Kyky |
|---|---|---|---|
| 9001 | `9001_rk9_risk_management.sql` | `3565fb3a5` (renumerointi, alk. `35509fab7`) | risk |
| 9002 | `9002_rk9_resend_email.sql` | `3565fb3a5` (renumerointi, alk. `8b14dce0d`) | email |
| 9003 | `9003_rk9_email_escalation.sql` | `3565fb3a5` (renumerointi, alk. `8b14dce0d`) | email |
| 9004 | `9004_rk9_resolve_stale_incidents.sql` | `9b15735a4` | risk |
| 9005 | `9005_rk9_email_support_desk.sql` | `4da5e90bc` | email |
| 9006 | `9006_rk9_outreach.sql` | `c2213d8e6` | outreach |
| 9007 | `9007_rk9_outreach_enrichment.sql` | `e50ef06d0` | outreach |
| 9008 | `9008_rk9_outreach_sender.sql` | `e9f2ff5f3` | outreach |
| 9009 | `9009_rk9_outreach_metrics.sql` | `ec28513d9` | outreach |
| 9010 | `9010_rk9_outreach_inbound_routes.sql` | `ba63697af` | outreach, email |

Tarkistus: `scripts/upgrade-smoke.sh --offline` (järjestys, `idx`, tiedostot, ei upstream-rivejä 9xxx:n jälkeen).

## Commitit (142, vanhin ensin)

Kyky on commitin pääkyky; sulkeissa oleva "+" nimeää toissijaisen kyvyn. Tiedostoista näytetään
neljä ensimmäistä. Verifiointi on joko commitin oma yhä olemassa oleva testi tai manuaalinen
tarkistus.

| # | Commit | Otsikko | Kyky | Tiedostot | Verifiointi |
|---|---|---|---|---|---|
| 1 | `0c086c9fc` | ci: add AI auto-merge and deploy-dev workflows | ci/tooling | `.github/workflows/ai-auto-merge.yml`, `.github/workflows/deploy-dev.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 2 | `a9fa058f9` | fix: ensure --max-turns is always passed to Claude Code | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/test.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 3 | `b818a0892` | perf: proactive session rotation to avoid Haiku compaction costs | claude-local | `packages/adapter-utils/src/session-compaction.ts`, `server/src/__tests__/heartbeat-workspace-session.test.ts`, `ui/src/components/agent-config-defaults.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 4 | `74e882eea` | test: add unit test for concurrent checkout 409 race condition | core api | `server/src/__tests__/issues-checkout-race.test.ts` | `npx vitest run server/src/__tests__/issues-checkout-race.test.ts` |
| 5 | `7520ce9d8` | test: add budget boundary unit tests for exact 100% threshold crossing | core api | `server/src/__tests__/budgets-service.test.ts` | `npx vitest run server/src/__tests__/budgets-service.test.ts` |
| 6 | `29788b183` | feat: add git hooks to prevent broken PRs in CI | ci/tooling | `.githooks/pre-commit`, `.githooks/pre-push`, `package.json` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 7 | `443047f32` | fix: scope pre-push hook to typecheck only | ci/tooling | `.githooks/pre-push` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 8 | `2da398f1c` | ci: add unified Docker-based CI/CD foundation for Paperclip companies | ci/tooling | `.agents/skills/deploy/SKILL.md`, `doc/CICD.md`, `doc/INFRA-TODO.md`, `scripts/audit-runners.sh` (+1) | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 9 | `3a03be57d` | docs(cicd): document PostgreSQL standard + per-environment data-stack split | docs | `doc/CICD.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 10 | `36ce66b0d` | docs(infra): port allocation map + quantimodo unblocker | docs | `doc/INFRA-TODO.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 11 | `86ebac29c` | Revert "perf: proactive session rotation to avoid Haiku compaction costs" | claude-local | `packages/adapter-utils/src/session-compaction.ts`, `server/src/__tests__/heartbeat-workspace-session.test.ts`, `ui/src/components/agent-config-defaults.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 12 | `69ea6e9f1` | Revert "fix: ensure --max-turns is always passed to Claude Code" | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/test.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 13 | `e6c6e8ec5` | docs: remove sensitive infra todo and redact internal references | docs | `doc/CICD.md`, `doc/INFRA-TODO.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 14 | `bd087457a` | scripts: pin migrate-company templates to immutable cicd commit SHA | ci/tooling | `scripts/migrate-company.sh` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 15 | `4c88cff7b` | ci: gate auto-merge on explicit ai-auto-merge label | ci/tooling | `.github/workflows/ai-auto-merge.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 16 | `76c10038c` | perf: proactive session rotation to avoid Haiku compaction costs | claude-local | `packages/adapter-utils/src/session-compaction.ts`, `server/src/__tests__/heartbeat-workspace-session.test.ts`, `ui/src/components/agent-config-defaults.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 17 | `7fd9c19d5` | fix: ensure --max-turns is always passed to Claude Code | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/test.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 18 | `01f9956b4` | test: cover hermes_local in proactive rotation threshold assertion | claude-local | `server/src/__tests__/heartbeat-workspace-session.test.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 19 | `2c59cb433` | feat(slack): Vaihe 1 outbound notifications (#5) | slack | `doc/SLACK-SETUP.md`, `server/package.json`, `server/src/__tests__/slack-event-classifier.test.ts`, `server/src/__tests__/slack-formatters.test.ts` (+8) | `npx vitest run server/src/__tests__/slack-event-classifier.test.ts server/src/__tests__/slack-formatters.test.ts` |
| 20 | `b1359a6b7` | chore(lockfile): refresh pnpm-lock.yaml (#6) | ci/tooling | `pnpm-lock.yaml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 21 | `35509fab7` | feat(risk): Risk Management system (#7) | risk (+ migraatio (alk. 0xxx, renumeroitu 9001)) | `packages/db/src/migrations/0071_mean_alex_power.sql`, `packages/db/src/migrations/meta/0071_snapshot.json`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/index.ts` (+23) | `npx vitest run server/src/__tests__/server-startup-feedback-export.test.ts` |
| 22 | `91a03d46f` | feat(slack): Vaihe 2 interaktiiviset approval-napit (#8) | slack | `.env.example`, `doc/SLACK-SETUP.md`, `packages/shared/src/constants.ts`, `server/src/__tests__/slack-event-classifier.test.ts` (+13) | `npx vitest run server/src/__tests__/slack-event-classifier.test.ts server/src/__tests__/slack-formatters.test.ts server/src/__tests__/slack-interactions.test.ts …` |
| 23 | `87e81c2fb` | fix(ui): redirect /risks to /<company>/risks like other unprefixed routes (#9) | risk | `ui/src/App.tsx` | _manuaalinen:_ smoke: risk-reitit; manuaalinen: /<prefix>/risks-näkymä avautuu |
| 24 | `fbdc0b0de` | test: e2e webhook auto-close trial (SEC-61) | github-webhooks | `AGENTS.md` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 25 | `8bd9ff89f` | test: e2e webhook auto-close trial (SEC-61) (#10) | github-webhooks | `AGENTS.md` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 26 | `def410ed0` | fix(risk): prevent duplicate AGENT_SILENT incidents for idle-by-design agents (#11) | risk | `server/src/__tests__/risk-monitors.test.ts`, `server/src/services/risk-incidents.ts`, `server/src/services/risk-monitors.ts` | `npx vitest run server/src/__tests__/risk-monitors.test.ts` |
| 27 | `8a0ef669d` | feat: auto-close issues when linked PR merges via GitHub webhook (#12) | github-webhooks | `.env.example`, `server/src/__tests__/github-webhook-routes.test.ts`, `server/src/app.ts`, `server/src/routes/github-webhooks.ts` (+1) | `npx vitest run server/src/__tests__/github-webhook-routes.test.ts` |
| 28 | `8b14dce0d` | feat(email): Resend email integration — outbound, inbound, auto-reply, escalation | email/support/escalation (+ migraatiot (alk. 0xxx, renumeroitu 9002/9003)) | `doc/RESEND-SETUP.md`, `packages/db/src/migrations/0072_resend_email.sql`, `packages/db/src/migrations/0073_email_escalation_columns.sql`, `packages/db/src/migrations/meta/0072_snapshot.json` (+34) | `npx vitest run server/src/__tests__/email-deliverability.test.ts server/src/__tests__/email-inbound-router.test.ts server/src/__tests__/email-render.test.ts …` |
| 29 | `3565fb3a5` | chore: prepare for upstream upgrades — renumber custom migrations to 9001+ and add RK9 markers | migrations 9001-9010 (+ migraatiot 9001–9003) | `packages/db/src/migrations/9001_rk9_risk_management.sql`, `packages/db/src/migrations/9002_rk9_resend_email.sql`, `packages/db/src/migrations/9003_rk9_email_escalation.sql`, `packages/db/src/migrations/meta/9001_snapshot.json` (+9) | _manuaalinen:_ smoke: journal-järjestystarkistus (`scripts/upgrade-smoke.sh --offline`) |
| 30 | `87a5168fb` | docs: add upstream upgrade runbook | docs | `doc/UPSTREAM-UPGRADE.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 31 | `c0348f42b` | feat(rk9): agent external-runs endpoint + e2e-companies smoke harness (#13) | ci/tooling | `.gitignore`, `package.json`, `packages/shared/src/index.ts`, `packages/shared/src/validators/agent.ts` (+17) | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 32 | `5cc685d47` | chore(lockfile): refresh pnpm-lock.yaml (#14) | ci/tooling | `pnpm-lock.yaml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 33 | `83fa07c23` | docs: route RK9-internal PRs to mv50000 fork for webhook auto-close | github-webhooks | `AGENTS.md`, `skills/paperclip-dev/SKILL.md` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 34 | `a985c477b` | feat(rk9): smart GitHub webhook → Slack routing for all event types | github-webhooks (+ slack) | `scripts/test-github-webhook.ts`, `server/src/__tests__/github-webhook-routes.test.ts`, `server/src/routes/github-webhooks.ts`, `server/src/services/slack/formatters-github.ts` (+2) | `npx vitest run server/src/__tests__/github-webhook-routes.test.ts` |
| 35 | `9b15735a4` | feat(rk9): auto-resolve incidents when risk entry closes + backfill | risk (+ migraatio 9004) | `packages/db/src/migrations/9004_rk9_resolve_stale_incidents.sql`, `server/src/services/risk-incidents.ts`, `server/src/services/risk-monitors.ts`, `server/src/services/risk-registry.ts` (+1) | _manuaalinen:_ smoke: risk-reitit; manuaalinen: /<prefix>/risks-näkymä avautuu |
| 36 | `cb29049a6` | chore(db): add 9004 to migration journal | migrations 9001-9010 | `packages/db/src/migrations/meta/_journal.json` | _manuaalinen:_ smoke: journal-järjestystarkistus (`scripts/upgrade-smoke.sh --offline`) |
| 37 | `5f4a94021` | feat(rk9): add prh-prospector skill — open-data B2B lead enrichment | skills | `.gitignore`, `skills/prh-prospector/SKILL.md`, `skills/prh-prospector/references/ai-enrichment-prompts.md`, `skills/prh-prospector/references/baseline-2026-04-29.md` (+8) | _manuaalinen:_ manuaalinen: skill näkyy company skills -listassa |
| 38 | `7f02e02c5` | feat(rk9): GitHub webhook delivery health monitor | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 39 | `c583f5503` | feat(issues): add goalId filter to company issues list endpoint (#15) | core api | `server/src/__tests__/issues-service.test.ts`, `server/src/routes/issues.ts`, `server/src/services/issues.ts`, `skills/paperclip/references/api-reference.md` | `npx vitest run server/src/__tests__/issues-service.test.ts` |
| 40 | `ccad0d780` | feat(rk9): global system-pause to guard Anthropic quota | heartbeat | `packages/shared/src/index.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/index.ts` (+16) | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 41 | `e81a467e7` | fix(rk9): system pause silent skip for background heartbeat sources | heartbeat | `server/src/services/heartbeat.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 42 | `56f618bd9` | fix(rk9): system pause notifies Slack only on real transitions | heartbeat (+ slack) | `server/src/services/system-pause.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 43 | `b0cfb98f9` | fix(rk9): auto-pause uses latest blocking-window reset, not earliest | heartbeat | `server/src/index.ts`, `server/src/services/system-pause.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 44 | `5005d4b74` | fix(rk9): harden custom integrations (#16) | core api | `cli/esbuild.config.mjs`, `cli/src/__tests__/network-bind.test.ts`, `cli/src/__tests__/onboard.test.ts`, `doc/RESEND-SETUP.md` (+12) | `npx vitest run cli/src/__tests__/network-bind.test.ts cli/src/__tests__/onboard.test.ts server/src/__tests__/email-routes.test.ts …` |
| 45 | `5c3b89ae9` | Add quota pause guardrails for routines | heartbeat | `doc/DEVELOPING.md`, `server/src/__tests__/routines-service.test.ts`, `server/src/app.ts`, `server/src/routes/routines.ts` (+3) | `npx vitest run server/src/__tests__/routines-service.test.ts ui/src/pages/Routines.test.tsx` |
| 46 | `3e3626288` | Stabilize heartbeat test cleanup | heartbeat | `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`, `server/src/__tests__/heartbeat-dependency-scheduling.test.ts` | `npx vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/heartbeat-dependency-scheduling.test.ts` |
| 47 | `a2949a3c0` | Add quota pause guardrails for routines (#17) | heartbeat | `doc/DEVELOPING.md`, `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`, `server/src/__tests__/heartbeat-dependency-scheduling.test.ts`, `server/src/__tests__/routines-service.test.ts` (+5) | `npx vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/heartbeat-dependency-scheduling.test.ts server/src/__tests__/routines-service.test.ts …` |
| 48 | `086fd02fb` | feat(rk9): add instance-level global concurrency limit for heartbeat runs | heartbeat | `packages/shared/src/constants.ts`, `packages/shared/src/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts` (+9) | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 49 | `df7787457` | fix(rk9): add incident cooldown to prevent flapping risk incidents | risk | `server/src/__tests__/risk-monitors.test.ts`, `server/src/services/risk-incidents.ts`, `server/src/services/risk-monitors.ts` | `npx vitest run server/src/__tests__/risk-monitors.test.ts` |
| 50 | `550631402` | fix(adapters): trust Claude success result over SIGTERM exit code (#20) | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `server/src/__tests__/claude-local-execute.test.ts` | `npx vitest run server/src/__tests__/claude-local-execute.test.ts` |
| 51 | `acf2da1bb` | fix(slack): emit approval.created for risk-incident & budget approvals | slack (+ risk) | `server/src/__tests__/emit-approval-created.test.ts`, `server/src/services/approvals.ts`, `server/src/services/budgets.ts`, `server/src/services/risk-incidents.ts` | `npx vitest run server/src/__tests__/emit-approval-created.test.ts` |
| 52 | `f9bf66479` | fix(slack,risk): prefix-based URLs, redirect old links, fix Date bind | risk (+ slack) | `server/src/__tests__/slack-formatters.test.ts`, `server/src/services/risk-incidents.ts`, `server/src/services/slack/event-forwarder.ts`, `server/src/services/slack/formatters.ts` (+1) | `npx vitest run server/src/__tests__/slack-formatters.test.ts` |
| 53 | `324ec7d5b` | feat: company-level pause/resume with heartbeat enforcement and Slack notifications | heartbeat (+ slack) | `server/src/routes/companies.ts`, `server/src/services/companies.ts`, `server/src/services/heartbeat.ts`, `ui/src/api/companies.ts` (+2) | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 54 | `1a81f807a` | docs(multi-user): add board-operator guide for multi-user access (SEC-90) | docs | `docs/guides/board-operator/multi-user-access.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 55 | `b57c96771` | feat(metrics): add agent task success rate endpoint (SEC-88) (#23) | core api | `server/src/app.ts`, `server/src/routes/agent-metrics.ts`, `server/src/services/agent-metrics.ts` | _manuaalinen:_ manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| 56 | `2059926c0` | feat(execution-policy): enforced outcome requirements before done (SEC-91) (#25) | core api | `docs/guides/execution-policy.md`, `packages/shared/src/index.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/types/issue.ts` (+6) | `npx vitest run server/src/__tests__/issue-outcome-requirements.test.ts ui/src/components/IssueProperties.test.tsx` |
| 57 | `2e0533b96` | fix: cancel queued runs when company is paused instead of leaving them stuck | heartbeat | `server/src/services/heartbeat.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 58 | `ce6f93d19` | fix: auto-promote backlog→todo when issue is created with an assignee | core api | `server/src/services/issues.ts` | _manuaalinen:_ manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| 59 | `3892b27f8` | fix(email): skip auto-reply when sender domain matches own route domain | email/support/escalation | `server/src/services/email/inbound-router.ts` | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 60 | `257417abc` | fix(email): skip auto-reply when sender domain matches own route domain (#26) | email/support/escalation | `server/src/routes/companies.ts`, `server/src/services/companies.ts`, `server/src/services/email/inbound-router.ts`, `server/src/services/heartbeat.ts` (+4) | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 61 | `6c3dc8931` | feat: Sunspot rebrand (ent. Aurinko Terassit) + process-adapter -skriptit (#28) | cicd-failure-watch (+ skills) | `server/scripts/check-github-webhook-health.ts`, `server/scripts/process-adapters/cicd-failure-watch.sh`, `server/scripts/process-adapters/cost-summary.sh`, `server/scripts/process-adapters/deploy-validate.sh` (+6) | _manuaalinen:_ manuaalinen: `bash -n server/scripts/process-adapters/cicd-failure-watch.sh` + yksi process-adapter-ajo |
| 62 | `2249948ea` | docs(ololla): manuaalinen E2E-testaussuunnitelma | docs | `ololla-e2e-testplan.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 63 | `f56ef4e90` | test: add unit tests for claude-local, cursor-local, gemini-local adapters | claude-local | `packages/adapters/claude-local/src/server/parse.test.ts`, `packages/adapters/cursor-local/src/server/parse.test.ts`, `packages/adapters/cursor-local/vitest.config.ts`, `packages/adapters/gemini-local/src/server/parse.test.ts` (+1) | `npx vitest run packages/adapters/claude-local/src/server/parse.test.ts packages/adapters/cursor-local/src/server/parse.test.ts packages/adapters/gemini-local/src/server/parse.test.ts` |
| 64 | `52b995085` | feat(agents): AI board member + paused/terminated assignment validation | core api | `scripts/e2e-companies-report.ts`, `server/src/onboarding-assets/ceo/AGENTS.md`, `server/src/onboarding-assets/cto/AGENTS.md`, `server/src/onboarding-assets/cto/HEARTBEAT.md` (+3) | _manuaalinen:_ manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| 65 | `60e3e0aa7` | ci(deploy-dev): drop push trigger (no runner registered, deploy is manual) | ci/tooling | `.github/workflows/deploy-dev.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 66 | `7d4a81961` | fix(recovery): skip auto-recovery for agents with heartbeat disabled | heartbeat | `server/src/services/recovery/service.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 67 | `a17aa8ca5` | fix(claude-local): kill quota probe process group to prevent orphaned claude CLIs | claude-local | `packages/adapters/claude-local/src/server/quota.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 68 | `ca1d63842` | feat(agents): add human_proxy adapter type for AI board members (SEC-100) (#30) | core api | `packages/shared/src/constants.ts`, `scripts/migrate-ai-agents-to-human-proxy.ts`, `server/src/__tests__/human-proxy.test.ts`, `server/src/adapters/builtin-adapter-types.ts` (+13) | `npx vitest run server/src/__tests__/human-proxy.test.ts` |
| 69 | `f109affee` | fix(ui): pass adapterType to StatusBadge on agents list (SEC-100 follow-up) (#31) | core api | `ui/src/pages/Agents.tsx` | _manuaalinen:_ manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| 70 | `47e7fe249` | feat(recovery): add strictInProgressOnly flag + per-candidate decision logging (RK9-5 phase 1) (#32) | heartbeat | `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, `server/src/__tests__/heartbeat-process-recovery.test.ts`, `server/src/__tests__/instance-settings-routes.test.ts` (+2) | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/instance-settings-routes.test.ts` |
| 71 | `aba28b775` | fix(server): widen issue identifier regex to accept alphanumeric prefixes (#33) | core api | `packages/shared/src/issue-references.ts`, `server/src/routes/activity.ts`, `server/src/routes/agents.ts`, `server/src/routes/issues.ts` (+1) | _manuaalinen:_ manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| 72 | `a2b61c5c1` | feat(email): introduce MailProvider abstraction, wrap Resend behind it (SEC-104) (#34) | email/support/escalation | `server/src/services/email/index.ts`, `server/src/services/email/provider.ts` | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 73 | `956f55379` | feat(email): add SES provider (SesProvider + raw MIME builder) (SEC-105) (#35) | email/support/escalation | `server/package.json`, `server/src/__tests__/email-mime.test.ts`, `server/src/__tests__/email-ses-provider.test.ts`, `server/src/services/email/index.ts` (+3) | `npx vitest run server/src/__tests__/email-mime.test.ts server/src/__tests__/email-ses-provider.test.ts` |
| 74 | `b6bb542ee` | chore(lockfile): refresh pnpm-lock.yaml (#36) | ci/tooling | `pnpm-lock.yaml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 75 | `2f63ebd4d` | feat(email): add SNS signature verification for SES webhooks (SEC-106) (#37) | email/support/escalation | `server/src/__tests__/email-sns-verify.test.ts`, `server/src/services/email/sns-verify.ts` | `npx vitest run server/src/__tests__/email-sns-verify.test.ts` |
| 76 | `7f1fc93ae` | feat(email): add install-ses setup/verify script (SEC-107) (#38) | email/support/escalation | `scripts/install-ses.ts` | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 77 | `c61831d5d` | feat(email): SES inbound — S3 + MIME parsing + SNS routing (SEC-108) (#39) | email/support/escalation | `server/package.json`, `server/src/__tests__/email-ses-inbound-route.test.ts`, `server/src/__tests__/email-ses-inbound.test.ts`, `server/src/app.ts` (+3) | `npx vitest run server/src/__tests__/email-ses-inbound-route.test.ts server/src/__tests__/email-ses-inbound.test.ts` |
| 78 | `d93e029c6` | chore(lockfile): refresh pnpm-lock.yaml (#40) | ci/tooling | `pnpm-lock.yaml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 79 | `5ac1aee9d` | docs(email): add SES setup guide + provider-neutral notes (SEC-110) (#41) | email/support/escalation | `doc/RESEND-SETUP.md`, `doc/SES-SETUP.md`, `skills/resend/SKILL.md` | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 80 | `7b5d68f96` | fix(email): unwrap display-name addresses in SES tenant resolution (SEC-108) (#42) | email/support/escalation | `server/src/__tests__/email-ses-inbound.test.ts`, `server/src/services/email/ses-inbound-adapter.ts` | `npx vitest run server/src/__tests__/email-ses-inbound.test.ts` |
| 81 | `177c2ba9a` | fix(scripts): make install-ses/install-resend-skill/resend-status runnable (SEC-102 tech debt) (#43) | email/support/escalation | `doc/RESEND-SETUP.md`, `doc/SES-SETUP.md`, `packages/db/src/index.ts`, `scripts/install-resend-skill.ts` (+3) | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 82 | `d7200faa7` | feat(knowledge): company-scoped recall service + MCP tool (RK9-17 / C5) (#45) | knowledge/qmd | `packages/mcp-server/src/tools.ts`, `server/src/app.ts`, `server/src/routes/knowledge.ts`, `server/src/services/knowledge-recall.test.ts` (+1) | `npx vitest run server/src/services/knowledge-recall.test.ts` |
| 83 | `29454e3b6` | feat(cli): add --body-file to `issue comment` (#44) | core api | `cli/src/commands/client/issue.ts` | _manuaalinen:_ manuaalinen: kyseinen API-kutsu harjoitusinstanssia vasten |
| 84 | `9394a2f3e` | feat(knowledge): heartbeat recall injection + token-savings harness (RK9-18 / C6) (#46) | knowledge/qmd | `packages/adapters/claude-local/src/server/execute.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, `server/scripts/rk9-knowledge-savings-methodology.md` (+6) | `npx vitest run server/src/__tests__/instance-settings-routes.test.ts server/src/services/knowledge-injection.test.ts` |
| 85 | `d0c08832d` | feat(knowledge): cross-host semantic recall — vsearch + existing-collection scope (RK9-12) (#47) | knowledge/qmd | `scripts/qmd-recall-remote.sh`, `server/src/services/knowledge-recall.test.ts`, `server/src/services/knowledge-recall.ts` | `npx vitest run server/src/services/knowledge-recall.test.ts` |
| 86 | `9dcaa05f1` | feat(knowledge): operator-mode recall (all collections for instance-admins) (RK9-12) (#48) | knowledge/qmd | `scripts/qmd-recall-remote.sh`, `server/src/routes/authz.ts`, `server/src/routes/knowledge.ts`, `server/src/services/knowledge-recall.test.ts` (+1) | `npx vitest run server/src/services/knowledge-recall.test.ts` |
| 87 | `60bb87631` | fix(knowledge): concurrency guard for recall + auto-load remote client config (RK9-12) (#49) | knowledge/qmd | `scripts/qmd-recall-remote.sh`, `server/src/services/knowledge-recall.test.ts`, `server/src/services/knowledge-recall.ts` | `npx vitest run server/src/services/knowledge-recall.test.ts` |
| 88 | `88489468d` | feat(knowledge): hybrid recall — fuse vsearch + BM25 (RRF) (RK9-12) (#50) | knowledge/qmd | `server/src/services/knowledge-recall.test.ts`, `server/src/services/knowledge-recall.ts` | `npx vitest run server/src/services/knowledge-recall.test.ts` |
| 89 | `3baa6b98d` | chore(monitoring): drop archived optimi from webhook health monitor (RK9-28) (#52) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 90 | `96ed37049` | chore(monitoring): re-own transferred repos to rk9-ai in webhook monitor (RK9-26) (#53) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 91 | `55657c163` | chore(monitoring): re-own bk + alli-audit to rk9-ai in webhook monitor (RK9-29) (#54) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 92 | `f7587c3bb` | fix(api): guard non-UUID X-Paperclip-Run-Id header → 400, not 500 (RK9-24) (#55) | core api | `server/src/__tests__/auth-run-id-guard.test.ts`, `server/src/middleware/auth.ts` | `npx vitest run server/src/__tests__/auth-run-id-guard.test.ts` |
| 93 | `59e844a3e` | ci: add gitleaks secret-scan gate to PR checks (P2) (#57) | ci/tooling | `.github/workflows/pr.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 94 | `2e0686b9c` | ci(e2e): upload playwright report only on failure, 1-day retention (artifact-quota) (#58) | ci/tooling | `.github/workflows/pr.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 95 | `3bf44c8d6` | fix(slack): stop agent-error alert spam; make failure-burst catch slow-agent outages (#59) | slack | `server/src/__tests__/slack-event-classifier.test.ts`, `server/src/services/slack/event-forwarder.ts`, `server/src/services/slack/formatters.ts` | `npx vitest run server/src/__tests__/slack-event-classifier.test.ts` |
| 96 | `9c9fd1648` | feat(slack): pull-based agent liveness watchdog for de-scheduled fleets (RK9-43) (#60) | slack | `doc/SLACK-SETUP.md`, `server/src/__tests__/slack-liveness-watchdog.test.ts`, `server/src/config.ts`, `server/src/index.ts` (+3) | `npx vitest run server/src/__tests__/slack-liveness-watchdog.test.ts` |
| 97 | `b4dafc859` | chore(cicd): uutisvertailu CICD-onboarding — webhook-monitor + e2e-smoke (UUT-14) (#61) | github-webhooks | `server/scripts/check-github-webhook-health.ts`, `tests/e2e-companies/README.md`, `tests/e2e-companies/fixtures/companies.ts`, `tests/e2e-companies/uutisvertailu/smoke.spec.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 98 | `e1ae48984` | fix(api): stop checkout/status-update/comment 500ing on unknown actorRunId (RK9-76) (#62) | core api | `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts`, `server/src/__tests__/issue-comment-reopen-routes.test.ts`, `server/src/__tests__/issues-checkout-race.test.ts`, `server/src/routes/issues.ts` (+1) | `npx vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts server/src/__tests__/issue-comment-reopen-routes.test.ts server/src/__tests__/issues-checkout-race.test.ts` |
| 99 | `8589064fe` | feat(email): wake assigned agent on inbound mail + thread replies onto existing issues (RK9-80) (#63) | email/support/escalation | `server/src/__tests__/email-inbound-wakeup.test.ts`, `server/src/__tests__/email-ses-inbound.test.ts`, `server/src/routes/resend-inbound.ts`, `server/src/routes/ses-inbound.ts` (+3) | `npx vitest run server/src/__tests__/email-inbound-wakeup.test.ts server/src/__tests__/email-ses-inbound.test.ts` |
| 100 | `4da5e90bc` | feat(email): junk guard for automated senders + escalation filters (RK9-81) (#64) | email/support/escalation (+ migraatio 9005) | `packages/db/src/migrations/9005_rk9_email_support_desk.sql`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/email.ts`, `server/src/__tests__/email-escalation.test.ts` (+7) | `npx vitest run server/src/__tests__/email-escalation.test.ts server/src/__tests__/email-inbound-wakeup.test.ts server/src/__tests__/email-junk-guard.test.ts …` |
| 101 | `a557ad5a3` | feat(email): approval-gated agent sending (email_send approval) (RK9-82) (#65) | email/support/escalation | `packages/shared/src/constants.ts`, `server/src/__tests__/email-approval-gate.test.ts`, `server/src/routes/approvals.ts`, `server/src/routes/email.ts` (+1) | `npx vitest run server/src/__tests__/email-approval-gate.test.ts` |
| 102 | `b62943576` | feat(adapters): first-class tool containment for claude-local + email skill refresh (RK9-83) (#66) | claude-local (+ email) | `packages/adapters/claude-local/src/server/execute.tools.test.ts`, `packages/adapters/claude-local/src/server/execute.ts`, `skills/resend/SKILL.md`, `skills/resend/references/api-reference.md` | `npx vitest run packages/adapters/claude-local/src/server/execute.tools.test.ts` |
| 103 | `d620ec7c9` | feat(scripts): Telegram inline-button gate for email_send approvals (RK9-85) (#67) | email/support/escalation (+ claude-local (Telegram-gate)) | `server/scripts/approval-telegram-listener.mjs`, `server/scripts/paperclip-approval-telegram.service` | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 104 | `10368f9bc` | chore(scripts): monitor last-shadow GitHub webhook (TLN onboarding) (#68) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 105 | `082aff916` | test(e2e-companies): onboard last-shadow (TLN) smoke checks (#69) | ci/tooling | `tests/e2e-companies/README.md`, `tests/e2e-companies/fixtures/companies.ts`, `tests/e2e-companies/last-shadow/smoke.spec.ts` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 106 | `b05d1c1ff` | fix(recovery): stop re-spawning continuation for already-succeeded in-progress runs (RK9-87) (#70) | heartbeat | `server/src/__tests__/heartbeat-process-recovery.test.ts`, `server/src/services/recovery/service.ts` | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts` |
| 107 | `5e13f7a48` | feat(monitor): synthetic large-body probes for github webhook endpoint (#71) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 108 | `1d7dfa171` | feat(monitor): per-repo alert throttle for persistent webhook outages (#72) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 109 | `a132d1d8c` | feat(knowledge): exclude the operator's personal vault from recall (#73) | knowledge/qmd | `server/src/routes/knowledge.ts`, `server/src/services/knowledge-injection.ts`, `server/src/services/knowledge-recall.test.ts`, `server/src/services/knowledge-recall.ts` | `npx vitest run server/src/services/knowledge-recall.test.ts` |
| 110 | `4f02491b7` | docs: lisää CONSTITUTION.md — pakolliset repo-säännöt agenteille (RK9-107) (#74) | docs | `CONSTITUTION.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 111 | `b66f2e461` | chore(prompts): prompt audit — drop dated patterns, refresh model pins, describe MCP tools (#75) | skills | `cli/src/checks/llm-check.ts`, `cli/src/commands/onboard.ts`, `packages/adapters/claude-local/src/index.ts`, `packages/mcp-server/src/tools.ts` (+10) | _manuaalinen:_ manuaalinen: skill näkyy company skills -listassa |
| 112 | `ead6c2b94` | feat(heartbeat): skip idle timer runs; tell agents their turn budget (#76) | heartbeat | `docs/agents-runtime.md`, `packages/adapters/claude-local/src/server/execute.ts`, `server/src/__tests__/heartbeat-idle-timer-skip.test.ts`, `server/src/services/heartbeat.ts` (+4) | `npx vitest run server/src/__tests__/heartbeat-idle-timer-skip.test.ts ui/src/lib/new-agent-runtime-config.test.ts` |
| 113 | `22df38fb8` | fix(e2e): update Quantimodo smoke spec for webui-fronted dev (QUA-676, QUA-677) (#78) | ci/tooling | `tests/e2e-companies/quantimodo/smoke.spec.ts` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 114 | `ac7b81c06` | chore(monitor): add rk9-ai/onni-ja-alma webhook to health check (ONA) (#77) | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 115 | `52a3e2726` | ci: älä julkaise npm-canaryä forkista (#79) | ci/tooling | `.github/workflows/release.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 116 | `1d6cffe37` | chore(ops): io-watch versionhallintaan (RK9-151) (#80) | ci/tooling | `docs/implementation-notes/io-watch.md`, `server/scripts/io-watch-alert.ts`, `server/scripts/io-watch.sh` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 117 | `051ca3cc7` | fix(server): detect tailnet bind host lazily and memoize per process (RK9-184) (#81) | core api | `server/src/__tests__/config.test.ts`, `server/src/config.ts` | `npx vitest run server/src/__tests__/config.test.ts` |
| 118 | `ae5658576` | fix(knowledge-recall): kill qmd's whole process group, not just the launcher (RK9-181) (#82) | knowledge/qmd | `server/src/__tests__/knowledge-routes.test.ts`, `server/src/index.ts`, `server/src/routes/knowledge.ts`, `server/src/services/__fixtures__/fake-qmd-launcher.mjs` (+4) | `npx vitest run server/src/__tests__/knowledge-routes.test.ts server/src/services/knowledge-recall.test.ts server/src/services/qmd-orphan-watchdog.test.ts` |
| 119 | `455a3b384` | feat(knowledge-recall): use the warm qmd-mcp daemon for vsearch (RK9-186) (#83) | knowledge/qmd | `docs/implementation-notes/qmd-mcp-daemon-recall.md`, `server/src/index.ts`, `server/src/services/knowledge-recall.test.ts`, `server/src/services/knowledge-recall.ts` (+2) | `npx vitest run server/src/services/knowledge-recall.test.ts server/src/services/qmd-mcp-client.test.ts` |
| 120 | `209369884` | fix(knowledge-recall): normalize daemon's prefix-less file field (RK9-186 production regression) (#84) | knowledge/qmd | `server/src/services/knowledge-recall.test.ts`, `server/src/services/knowledge-recall.ts`, `server/src/services/qmd-mcp-client.test.ts` | `npx vitest run server/src/services/knowledge-recall.test.ts server/src/services/qmd-mcp-client.test.ts` |
| 121 | `bda8b67cb` | fix(knowledge-recall): don't log WARN+stack for a client-cancelled qmd-mcp query (RK9-199) (#86) | knowledge/qmd | `server/src/services/knowledge-recall.test.ts`, `server/src/services/qmd-mcp-client.test.ts`, `server/src/services/qmd-mcp-client.ts` | `npx vitest run server/src/services/knowledge-recall.test.ts server/src/services/qmd-mcp-client.test.ts` |
| 122 | `c2213d8e6` | feat(outreach): data model, migration 9006, validators and API (RK9-193) (#85) | outreach (+ migraatio 9006) | `docs/implementation-notes/outreach-data-model.md`, `packages/db/src/migrations/9006_rk9_outreach.sql`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/index.ts` (+17) | `npx vitest run packages/shared/src/validators/outreach.test.ts server/src/__tests__/outreach-logic.test.ts server/src/__tests__/outreach-routes.test.ts` |
| 123 | `e50ef06d0` | feat(outreach): PRH import, Firecrawl enrichment, Claude drafting and CLI review gate (RK9-196) (#87) | outreach (+ migraatio 9007) | `cli/src/__tests__/outreach.test.ts`, `cli/src/commands/client/outreach.ts`, `cli/src/index.ts`, `docs/implementation-notes/outreach-enrichment.md` (+25) | `npx vitest run cli/src/__tests__/outreach.test.ts packages/shared/src/validators/outreach.test.ts server/src/__tests__/outreach-draft-logic.test.ts …` |
| 124 | `e9f2ff5f3` | feat(outreach): sequence engine — scheduler, warm-up ramp, SMTP sender daemon API, one-click unsubscribe (RK9-194) (#88) | outreach (+ migraatio 9008) | `docs/implementation-notes/outreach-sender.md`, `packages/db/src/migrations/9008_rk9_outreach_sender.sql`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/outreach.ts` (+22) | `npx vitest run server/src/__tests__/outreach-message-format.test.ts server/src/__tests__/outreach-scheduler-logic.test.ts server/src/__tests__/outreach-sender-routes.test.ts …` |
| 125 | `5db305a71` | feat(outreach): inbound relay — replies, DSN bounces, unsub@ (RK9-195) (#89) | outreach | `docs/implementation-notes/outreach-inbound.md`, `server/src/__tests__/outreach-inbound-classify.test.ts`, `server/src/__tests__/outreach-inbound-logic.test.ts`, `server/src/__tests__/outreach-inbound-route.test.ts` (+11) | `npx vitest run server/src/__tests__/outreach-inbound-classify.test.ts server/src/__tests__/outreach-inbound-logic.test.ts server/src/__tests__/outreach-inbound-route.test.ts …` |
| 126 | `ec28513d9` | feat(outreach): metrics, auto-pause, DNSBL check and digest API (RK9-197) (#90) | outreach (+ migraatio 9009) | `docs/implementation-notes/outreach-metrics.md`, `packages/db/src/migrations/9009_rk9_outreach_metrics.sql`, `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/schema/index.ts` (+22) | `npx vitest run server/src/__tests__/outreach-auto-pause-logic.test.ts server/src/__tests__/outreach-dnsbl.test.ts server/src/__tests__/outreach-metrics-routes.test.ts …` |
| 127 | `32ca6b890` | fix(outreach-sender): constant-time bearer key comparison (RK9-205) (#91) | outreach | `docs/implementation-notes/outreach-sender.md`, `server/src/__tests__/outreach-sender-routes.test.ts`, `server/src/routes/outreach-sender.ts` | `npx vitest run server/src/__tests__/outreach-sender-routes.test.ts` |
| 128 | `2f79195b7` | feat(outreach-inbound): require SPF+DKIM pass for address-based unsub@ suppression (RK9-206) (#92) | outreach | `docs/implementation-notes/outreach-inbound.md`, `server/src/__tests__/outreach-inbound-classify.test.ts`, `server/src/__tests__/outreach-inbound-logic.test.ts`, `server/src/services/outreach/inbound-classify.ts` (+2) | `npx vitest run server/src/__tests__/outreach-inbound-classify.test.ts server/src/__tests__/outreach-inbound-logic.test.ts` |
| 129 | `3941d8c30` | feat(outreach): compose-time compliance footer — one-click unsubscribe URL + privacy link in body (RK9-198) (#93) | outreach | `docs/implementation-notes/outreach-sender.md`, `docs/outreach/templates/saatavilla.md`, `server/src/__tests__/outreach-message-format.test.ts`, `server/src/app.ts` (+5) | `npx vitest run server/src/__tests__/outreach-message-format.test.ts` |
| 130 | `eb8d0b779` | feat(outreach): approve/reject outreach drafts from Telegram inline buttons (RK9-222) (#94) | outreach (+ email (Telegram-gate)) | `docs/implementation-notes/outreach-enrichment.md`, `docs/implementation-notes/outreach-telegram-approvals.md`, `server/scripts/approval-telegram-listener.mjs`, `server/scripts/paperclip-approval-telegram.service` (+1) | `npx vitest run server/src/__tests__/approval-telegram-listener-outreach.test.ts` |
| 131 | `e654e6aea` | feat(outreach): providers-aware drafting — switch vs start message, verified price + one demo link, disallowed_link gate (RK9-223) (#95) | outreach | `docs/implementation-notes/outreach-enrichment.md`, `docs/outreach/templates/saatavilla.md`, `server/src/__tests__/outreach-draft-logic.test.ts`, `server/src/__tests__/outreach-quality-gate.test.ts` (+2) | `npx vitest run server/src/__tests__/outreach-draft-logic.test.ts server/src/__tests__/outreach-quality-gate.test.ts` |
| 132 | `f5cbe9f50` | fix(webhook-monitor): per-owner tokens, blind vs degraded, throttle errors (RK9-226) (#96) | github-webhooks | `server/scripts/check-github-webhook-health.ts`, `server/src/services/webhook-monitor-alerting.test.ts`, `server/src/services/webhook-monitor-alerting.ts` | `npx vitest run server/src/services/webhook-monitor-alerting.test.ts` |
| 133 | `59b053e2c` | fix(outreach): DNSBL error codes are not listings (RK9-225) (#97) | outreach | `docs/implementation-notes/outreach-metrics.md`, `server/src/__tests__/outreach-dnsbl.test.ts`, `server/src/__tests__/outreach-metrics-dnsbl-render.test.ts`, `server/src/services/outreach/dnsbl.ts` (+1) | `npx vitest run server/src/__tests__/outreach-dnsbl.test.ts server/src/__tests__/outreach-metrics-dnsbl-render.test.ts` |
| 134 | `630e30cf3` | fix(claude-local): a server-wide ANTHROPIC_API_KEY no longer bills every agent (RK9-228) (#99) | claude-local | `doc/DOCKER.md`, `docs/adapters/claude-local.md`, `docs/agents-runtime.md`, `docs/deploy/docker.md` (+11) | `npx vitest run server/src/__tests__/claude-local-adapter-billing-inheritance.test.ts server/src/__tests__/claude-local-adapter-environment.test.ts server/src/__tests__/outreach-draft-api-key.test.ts` |
| 135 | `db58da48a` | feat(outreach): attach a draft to a sequence at creation time (RK9-224) (#98) | outreach | `cli/src/__tests__/outreach.test.ts`, `cli/src/commands/client/outreach.ts`, `docs/implementation-notes/outreach-data-model.md`, `docs/implementation-notes/outreach-enrichment.md` (+15) | `npx vitest run cli/src/__tests__/outreach.test.ts packages/shared/src/validators/outreach.test.ts server/src/__tests__/approval-telegram-listener-outreach.test.ts …` |
| 136 | `11e4e82ec` | fix(claude-local): withhold the host key where the child is actually spawned (RK9-228) (#100) | claude-local | `packages/adapter-utils/src/execution-target.ts`, `packages/adapter-utils/src/server-utils.ts`, `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/host-env.ts` (+3) | `npx vitest run server/src/__tests__/child-process-env-inheritance.test.ts` |
| 137 | `672d71a96` | fix(heartbeat): a hand-blocked issue is not pending timer work (RK9-231) (#101) | heartbeat | `server/src/__tests__/heartbeat-idle-timer-skip.test.ts`, `server/src/services/heartbeat.ts` | `npx vitest run server/src/__tests__/heartbeat-idle-timer-skip.test.ts` |
| 138 | `5bd1ab1c5` | fix(outreach): digest 500 — bind the day range with lt(), not a raw sql template (RK9-233) (#102) | outreach (+ email) | `server/src/__tests__/outreach-digest-db.test.ts`, `server/src/services/outreach/metrics.ts` | `npx vitest run server/src/__tests__/outreach-digest-db.test.ts` |
| 139 | `ba63697af` | fix(outreach): a prospect reply is never dropped — persist before routing (RK9-234) (#103) | outreach (+ email, migraatio 9010) | `docs/implementation-notes/outreach-inbound.md`, `packages/db/src/migrations/9010_rk9_outreach_inbound_routes.sql`, `packages/db/src/migrations/meta/_journal.json`, `server/src/__tests__/outreach-inbound-reply-persistence.test.ts` (+3) | `npx vitest run server/src/__tests__/outreach-inbound-reply-persistence.test.ts` |
| 140 | `486ac30ee` | feat(outreach): count an unthreadable reply instead of losing it silently (RK9-235) (#104) | outreach (+ email) | `docs/implementation-notes/outreach-inbound.md`, `docs/implementation-notes/outreach-metrics.md`, `server/src/__tests__/outreach-inbound-logic.test.ts`, `server/src/__tests__/outreach-inbound-unmatched-reply.test.ts` (+2) | `npx vitest run server/src/__tests__/outreach-inbound-logic.test.ts server/src/__tests__/outreach-inbound-unmatched-reply.test.ts` |
| 141 | `82a394fb6` | fix(infra): stop dropping SES bounce DSNs on a dangling nested MIME boundary (RK9-236) (#105) | email/support/escalation (+ outreach) | `infra/ses-forwarder/.gitignore`, `infra/ses-forwarder/README.md`, `infra/ses-forwarder/deploy.sh`, `infra/ses-forwarder/fixtures/virus-quarantine-dsn.eml` (+3) | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 142 | `9ed8e7704` | feat(claude-local): add Claude Opus 5.5 to the model list and drift allow-list (#106) | claude-local | `packages/adapters/claude-local/src/index.ts`, `server/src/services/risk-monitors.ts` | _manuaalinen:_ manuaalinen: yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |

## Konfliktitiedostot (koemerge `origin/master` + `v2026.916.1`, 93 tiedostoa)

Koemerge: `git merge --no-commit --no-ff v2026.916.1` puhtaassa worktreessä `origin/master`in päällä
2026-09-26. Issuen luku 94 oli 24.9. tilanne. Luku elää upstreamin mukana, joten aja koemerge
uudelleen jokaisen portaan alussa. "Konfliktilohkoja" on `<<<<<<<`-merkkien määrä.
Omistava kyky on johdettu forkin committeista, jotka koskivat tiedostoa.

Yleissääntö: upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle.

| # | Tiedosto | Konfliktilohkoja | Omistava kyky | Ratkaisu |
|---|---|---|---|---|
| 1 | `pnpm-lock.yaml` | 57 | ci/tooling | Ota upstreamin versio, aja `pnpm install`, committaa lukko uudelleen. |
| 2 | `server/src/services/heartbeat.ts` | 15 | heartbeat, knowledge/qmd | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 3 | `packages/db/src/migrations/meta/_journal.json` | 10 | migrations 9001-9010 | Upstreamin 0xxx-rivit ensin, sitten 9001–9010 samassa järjestyksessä; `idx` juoksevaksi. Tarkista `scripts/upgrade-smoke.sh --offline`. |
| 4 | `ui/src/pages/Routines.tsx` | 8 | heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 5 | `server/src/routes/issues.ts` | 8 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 6 | `server/src/app.ts` | 8 | outreach, email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 7 | `server/src/services/recovery/service.ts` | 7 | heartbeat, core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 8 | `server/src/__tests__/heartbeat-process-recovery.test.ts` | 7 | heartbeat | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 9 | `server/src/services/routines.ts` | 6 | heartbeat, core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 10 | `server/src/services/issues.ts` | 6 | core api, email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 11 | `server/src/index.ts` | 6 | outreach, slack | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 12 | `packages/adapters/claude-local/src/server/test.ts` | 6 | claude-local | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 13 | `packages/adapters/claude-local/src/server/execute.ts` | 6 | claude-local, heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 14 | `server/src/routes/instance-settings.ts` | 5 | heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 15 | `server/src/routes/agents.ts` | 5 | core api, ci/tooling | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 16 | `ui/src/pages/Routines.test.tsx` | 4 | heartbeat | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 17 | `ui/src/App.tsx` | 4 | risk | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 18 | `server/src/services/issue-execution-policy.ts` | 4 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 19 | `server/src/__tests__/issues-service.test.ts` | 4 | core api | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 20 | `server/package.json` | 4 | email/support/escalation, outreach | Upstreamin versiot ja skriptit ensin; lisää forkin riippuvuudet/skriptit perään. Aja `pnpm install`. |
| 21 | `packages/shared/src/index.ts` | 4 | outreach, heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 22 | `cli/src/commands/client/issue.ts` | 4 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 23 | `ui/src/pages/Companies.tsx` | 3 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 24 | `ui/src/pages/Agents.tsx` | 3 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 25 | `skills/paperclip/SKILL.md` | 3 | skills, risk | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 26 | `server/src/services/instance-settings.ts` | 3 | heartbeat, knowledge/qmd | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 27 | `server/src/routes/approvals.ts` | 3 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 28 | `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` | 3 | core api | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 29 | `server/src/__tests__/instance-settings-routes.test.ts` | 3 | knowledge/qmd, heartbeat | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 30 | `scripts/provision-worktree.sh` | 3 | core api | Upstreamin versio ensin; forkin rivit `# --- RK9 Custom ---` -merkin alle. |
| 31 | `packages/shared/src/validators/instance.ts` | 3 | heartbeat, knowledge/qmd | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 32 | `packages/shared/src/types/instance.ts` | 3 | heartbeat, knowledge/qmd | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 33 | `packages/db/src/schema/email.ts` | 3 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 34 | `ui/src/pages/InstanceGeneralSettings.tsx` | 2 | heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 35 | `ui/src/pages/CompanySettings.tsx` | 2 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 36 | `ui/src/lib/new-agent-runtime-config.test.ts` | 2 | heartbeat | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 37 | `ui/src/lib/issue-execution-policy.ts` | 2 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 38 | `ui/src/components/Sidebar.tsx` | 2 | risk | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 39 | `ui/src/api/instanceSettings.ts` | 2 | heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 40 | `server/src/services/live-events.ts` | 2 | slack | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 41 | `server/src/services/index.ts` | 2 | heartbeat, migrations 9001-9010 | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 42 | `server/src/services/companies.ts` | 2 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 43 | `server/src/services/agents.ts` | 2 | core api, ci/tooling | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 44 | `server/src/config.ts` | 2 | outreach, slack | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 45 | `server/src/__tests__/routines-service.test.ts` | 2 | heartbeat | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 46 | `server/src/__tests__/claude-local-execute.test.ts` | 2 | claude-local | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 47 | `server/src/__tests__/claude-local-adapter-environment.test.ts` | 2 | claude-local | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 48 | `packages/shared/src/validators/issue.ts` | 2 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 49 | `packages/shared/src/validators/index.ts` | 2 | outreach, heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 50 | `packages/shared/src/types/issue.ts` | 2 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 51 | `packages/shared/src/types/index.ts` | 2 | core api, heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 52 | `packages/mcp-server/src/tools.ts` | 2 | skills, knowledge/qmd | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 53 | `packages/adapters/gemini-local/src/server/parse.test.ts` | 2 | claude-local | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 54 | `packages/adapters/claude-local/src/server/parse.test.ts` | 2 | claude-local | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 55 | `package.json` | 2 | ci/tooling | Upstreamin versiot ja skriptit ensin; lisää forkin riippuvuudet/skriptit perään. Aja `pnpm install`. |
| 56 | `docs/adapters/claude-local.md` | 2 | claude-local | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 57 | `cli/src/index.ts` | 2 | outreach | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 58 | `cli/src/__tests__/onboard.test.ts` | 2 | core api | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 59 | `cli/src/__tests__/network-bind.test.ts` | 2 | core api | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 60 | `.gitignore` | 2 | skills, ci/tooling | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 61 | `ui/src/pages/AgentDetail.tsx` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 62 | `ui/src/lib/status-colors.ts` | 1 | core api, risk | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 63 | `ui/src/lib/new-agent-runtime-config.ts` | 1 | heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 64 | `ui/src/components/StatusBadge.tsx` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 65 | `ui/src/components/ClaudeSubscriptionPanel.tsx` | 1 | heartbeat | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 66 | `ui/src/components/ApprovalPayload.tsx` | 1 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 67 | `ui/src/components/AgentProperties.tsx` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 68 | `skills/paperclip-create-agent/references/api-reference.md` | 1 | skills | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 69 | `server/src/services/budgets.ts` | 1 | slack | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 70 | `server/src/services/approvals.ts` | 1 | slack | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 71 | `server/src/routes/email.ts` | 1 | email/support/escalation, core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 72 | `server/src/routes/companies.ts` | 1 | email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 73 | `server/src/routes/activity.ts` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 74 | `server/src/onboarding-assets/default/AGENTS.md` | 1 | skills | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 75 | `server/src/middleware/auth.ts` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 76 | `server/src/adapters/registry.ts` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 77 | `server/src/__tests__/issue-comment-reopen-routes.test.ts` | 1 | core api | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 78 | `server/src/__tests__/heartbeat-comment-wake-batching.test.ts` | 1 | heartbeat | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 79 | `server/src/__tests__/environment-live-ssh.test.ts` | 1 | core api | Ota upstreamin testi; lisää forkin tapaukset omaan `describe`-lohkoon `// --- RK9 Custom ---` -merkin alle. |
| 80 | `packages/shared/src/constants.ts` | 1 | outreach, email/support/escalation | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 81 | `packages/db/src/schema/index.ts` | 1 | outreach, migrations 9001-9010 | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 82 | `packages/adapters/claude-local/src/server/index.ts` | 1 | claude-local | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 83 | `packages/adapters/claude-local/src/index.ts` | 1 | claude-local, skills | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 84 | `packages/adapter-utils/src/server-utils.ts` | 1 | claude-local | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 85 | `packages/adapter-utils/src/execution-target.ts` | 1 | claude-local | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 86 | `docs/deploy/environment-variables.md` | 1 | claude-local | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 87 | `doc/DOCKER.md` | 1 | claude-local | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 88 | `doc/DEVELOPING.md` | 1 | heartbeat | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 89 | `cli/esbuild.config.mjs` | 1 | core api | Upstreamin koodi ensin, sitten forkin lohko `// --- RK9 Custom ---` -merkin alle. |
| 90 | `AGENTS.md` | 1 | github-webhooks | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |
| 91 | `.github/workflows/pr.yml` | 1 | ci/tooling | Upstreamin versio ensin; forkin rivit `# --- RK9 Custom ---` -merkin alle. |
| 92 | `ui/src/pages/InstanceSettings.tsx` | 0 (modify/delete) | heartbeat | Upstream poisti tai siirsi tiedoston. Siirrä forkin system pause- ja concurrency-asetukset upstreamin uuteen asetusnäkymään `// --- RK9 Custom ---` -merkin alle. |
| 93 | `skills/paperclip-dev/SKILL.md` | 0 (modify/delete) | skills, github-webhooks | Upstreamin teksti ensin; forkin lisäykset omaan osioon `<!-- RK9 Custom -->` -merkin alle. |

## Seuranta: ajonaikaiset commitit ilman automaattista testiä

Näille commiteille ei ole masterilla omaa testiä. Ne tarkistetaan manuaalisesti yllä olevan
kykykohtaisen tarkistuksen mukaan, kunnes testi on kirjoitettu. "ci/tooling" ja "docs" on jätetty pois.

- `a9fa058f9` fix: ensure --max-turns is always passed to Claude Code — claude-local
- `69ea6e9f1` Revert "fix: ensure --max-turns is always passed to Claude Code" — claude-local
- `7fd9c19d5` fix: ensure --max-turns is always passed to Claude Code — claude-local
- `87e81c2fb` fix(ui): redirect /risks to /<company>/risks like other unprefixed routes (#9) — risk
- `fbdc0b0de` test: e2e webhook auto-close trial (SEC-61) — github-webhooks
- `8bd9ff89f` test: e2e webhook auto-close trial (SEC-61) (#10) — github-webhooks
- `3565fb3a5` chore: prepare for upstream upgrades — renumber custom migrations to 9001+ and add RK9 markers — migrations 9001-9010
- `83fa07c23` docs: route RK9-internal PRs to mv50000 fork for webhook auto-close — github-webhooks
- `9b15735a4` feat(rk9): auto-resolve incidents when risk entry closes + backfill — risk
- `cb29049a6` chore(db): add 9004 to migration journal — migrations 9001-9010
- `5f4a94021` feat(rk9): add prh-prospector skill — open-data B2B lead enrichment — skills
- `7f02e02c5` feat(rk9): GitHub webhook delivery health monitor — github-webhooks
- `ccad0d780` feat(rk9): global system-pause to guard Anthropic quota — heartbeat
- `e81a467e7` fix(rk9): system pause silent skip for background heartbeat sources — heartbeat
- `56f618bd9` fix(rk9): system pause notifies Slack only on real transitions — heartbeat
- `b0cfb98f9` fix(rk9): auto-pause uses latest blocking-window reset, not earliest — heartbeat
- `086fd02fb` feat(rk9): add instance-level global concurrency limit for heartbeat runs — heartbeat
- `324ec7d5b` feat: company-level pause/resume with heartbeat enforcement and Slack notifications — heartbeat
- `b57c96771` feat(metrics): add agent task success rate endpoint (SEC-88) (#23) — core api
- `2e0533b96` fix: cancel queued runs when company is paused instead of leaving them stuck — heartbeat
- `ce6f93d19` fix: auto-promote backlog→todo when issue is created with an assignee — core api
- `3892b27f8` fix(email): skip auto-reply when sender domain matches own route domain — email/support/escalation
- `257417abc` fix(email): skip auto-reply when sender domain matches own route domain (#26) — email/support/escalation
- `6c3dc8931` feat: Sunspot rebrand (ent. Aurinko Terassit) + process-adapter -skriptit (#28) — cicd-failure-watch
- `52b995085` feat(agents): AI board member + paused/terminated assignment validation — core api
- `7d4a81961` fix(recovery): skip auto-recovery for agents with heartbeat disabled — heartbeat
- `a17aa8ca5` fix(claude-local): kill quota probe process group to prevent orphaned claude CLIs — claude-local
- `f109affee` fix(ui): pass adapterType to StatusBadge on agents list (SEC-100 follow-up) (#31) — core api
- `aba28b775` fix(server): widen issue identifier regex to accept alphanumeric prefixes (#33) — core api
- `a2b61c5c1` feat(email): introduce MailProvider abstraction, wrap Resend behind it (SEC-104) (#34) — email/support/escalation
- `7f1fc93ae` feat(email): add install-ses setup/verify script (SEC-107) (#38) — email/support/escalation
- `5ac1aee9d` docs(email): add SES setup guide + provider-neutral notes (SEC-110) (#41) — email/support/escalation
- `177c2ba9a` fix(scripts): make install-ses/install-resend-skill/resend-status runnable (SEC-102 tech debt) (#43) — email/support/escalation
- `29454e3b6` feat(cli): add --body-file to `issue comment` (#44) — core api
- `3baa6b98d` chore(monitoring): drop archived optimi from webhook health monitor (RK9-28) (#52) — github-webhooks
- `96ed37049` chore(monitoring): re-own transferred repos to rk9-ai in webhook monitor (RK9-26) (#53) — github-webhooks
- `55657c163` chore(monitoring): re-own bk + alli-audit to rk9-ai in webhook monitor (RK9-29) (#54) — github-webhooks
- `b4dafc859` chore(cicd): uutisvertailu CICD-onboarding — webhook-monitor + e2e-smoke (UUT-14) (#61) — github-webhooks
- `d620ec7c9` feat(scripts): Telegram inline-button gate for email_send approvals (RK9-85) (#67) — email/support/escalation
- `10368f9bc` chore(scripts): monitor last-shadow GitHub webhook (TLN onboarding) (#68) — github-webhooks
- `5e13f7a48` feat(monitor): synthetic large-body probes for github webhook endpoint (#71) — github-webhooks
- `1d7dfa171` feat(monitor): per-repo alert throttle for persistent webhook outages (#72) — github-webhooks
- `b66f2e461` chore(prompts): prompt audit — drop dated patterns, refresh model pins, describe MCP tools (#75) — skills
- `ac7b81c06` chore(monitor): add rk9-ai/onni-ja-alma webhook to health check (ONA) (#77) — github-webhooks
- `82a394fb6` fix(infra): stop dropping SES bounce DSNs on a dangling nested MIME boundary (RK9-236) (#105) — email/support/escalation
- `9ed8e7704` feat(claude-local): add Claude Opus 5.5 to the model list and drift allow-list (#106) — claude-local
