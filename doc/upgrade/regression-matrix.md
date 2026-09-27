# Regressiomatriisi — forkin commitit ja upstream-konfliktit

Lähtötila upstream-päivitykselle (epic [RK9-303](/RK9/issues/RK9-303), lapsi RK9-304).
Tämä dokumentti on hyväksyntäportti: jokainen porras (ks. `doc/UPSTREAM-UPGRADE.md`, osio
"Porrastusmalli") ajaa tämän matriisin tarkistukset ennen mergeä masteriin.

## Lähtötila (jäädytetty 2026-09-26)

| Asia | Arvo |
|---|---|
| Pre-upgrade-SHA (`origin/master`) | `9ed8e7704bd49da4064499de8477ae0a42e593e7` |
| Freeze päivitetty (porras 512, RK9-312) | `3e7ff932008e8feb99e45553ab0ba74945417c9e` (2026-09-27), commitit 143–159 alla |
| Freeze päivitetty (porras 609, RK9-313) | `e3aa869c6334993bc13e72c0dcf17c5f61ec356b` (2026-09-27), commitit 160–165 alla |
| Freeze päivitetty (porras 618, RK9-314) | `06b877ab7f687028e205021df6a5216e8cfa9a1b` (2026-09-27), commitit 166–174 alla |
| Freeze päivitetty (porras 707, RK9-314) | `a0ae4d43b` (2026-09-27, PR #128 merge), commitit 175–180 alla |
| Freeze päivitetty (porras 720, RK9-314) | `7a2ceba55` (2026-09-27, PR #129 merge), commitit 181–190 alla |
| Freeze päivitetty (porras 817→831, RK9-316) | `917ae45d8` (2026-09-27, portaan 831 pre-SHA). Välissä vain 817:n seitsemän sovituscommittia (`c38f350c`…`13a76a70`, RK9-315); niitä ei lisätty taulukkoon, koska ne kuuluvat 817:n konfliktilokiin. |
| Forkin haarautumiskohta upstreamista | `d0bdbe11a9624435b6dca3968389bd59c6a559a2` (`canary/v2026.428.0-canary.1`) |
| Ei-merge-committeja `d0bdbe11a..origin/master` | 142 (9ed8e7704), 159 (3e7ff9320) |
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
Portaassa tämä tiedosto tulkitaan CI:n tuloksen mukaan. `fork-tests.txt` merkitsee sen
`# ci-only`, joten `upgrade-smoke.sh` ohittaa sen paikallisesti ja ajaa sen, kun `CI` on asetettu.

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

## Commitit (165, vanhin ensin)

Kyky on commitin pääkyky; sulkeissa oleva "+" nimeää toissijaisen kyvyn. Tiedostoista näytetään
neljä ensimmäistä. Verifiointi on joko commitin oma yhä olemassa oleva testi tai manuaalinen
tarkistus.

| # | Commit | Otsikko | Kyky | Tiedostot | Verifiointi |
|---|---|---|---|---|---|
| 1 | `0c086c9fc` | ci: add AI auto-merge and deploy-dev workflows | ci/tooling | `.github/workflows/ai-auto-merge.yml`, `.github/workflows/deploy-dev.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 2 | `a9fa058f9` | fix: ensure --max-turns is always passed to Claude Code | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/test.ts` | _manuaalinen:_ yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 3 | `b818a0892` | perf: proactive session rotation to avoid Haiku compaction costs | claude-local | `packages/adapter-utils/src/session-compaction.ts`, `server/src/__tests__/heartbeat-workspace-session.test.ts`, `ui/src/components/agent-config-defaults.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 4 | `74e882eea` | test: add unit test for concurrent checkout 409 race condition | core api | `server/src/__tests__/issues-checkout-race.test.ts` | `npx vitest run server/src/__tests__/issues-checkout-race.test.ts` |
| 5 | `7520ce9d8` | test: add budget boundary unit tests for exact 100% threshold crossing | core api | `server/src/__tests__/budgets-service.test.ts` | `npx vitest run server/src/__tests__/budgets-service.test.ts` |
| 6 | `29788b183` | feat: add git hooks to prevent broken PRs in CI | ci/tooling | `.githooks/pre-commit`, `.githooks/pre-push`, `package.json` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 7 | `443047f32` | fix: scope pre-push hook to typecheck only | ci/tooling | `.githooks/pre-push` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 8 | `2da398f1c` | ci: add unified Docker-based CI/CD foundation for Paperclip companies | ci/tooling | `.agents/skills/deploy/SKILL.md`, `doc/CICD.md`, `doc/INFRA-TODO.md`, `scripts/audit-runners.sh` (+1) | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 9 | `3a03be57d` | docs(cicd): document PostgreSQL standard + per-environment data-stack split | docs | `doc/CICD.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 10 | `36ce66b0d` | docs(infra): port allocation map + quantimodo unblocker | docs | `doc/INFRA-TODO.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 11 | `86ebac29c` | Revert "perf: proactive session rotation to avoid Haiku compaction costs" | claude-local | `packages/adapter-utils/src/session-compaction.ts`, `server/src/__tests__/heartbeat-workspace-session.test.ts`, `ui/src/components/agent-config-defaults.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 12 | `69ea6e9f1` | Revert "fix: ensure --max-turns is always passed to Claude Code" | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/test.ts` | _manuaalinen:_ yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 13 | `e6c6e8ec5` | docs: remove sensitive infra todo and redact internal references | docs | `doc/CICD.md`, `doc/INFRA-TODO.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 14 | `bd087457a` | scripts: pin migrate-company templates to immutable cicd commit SHA | ci/tooling | `scripts/migrate-company.sh` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 15 | `4c88cff7b` | ci: gate auto-merge on explicit ai-auto-merge label | ci/tooling | `.github/workflows/ai-auto-merge.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 16 | `76c10038c` | perf: proactive session rotation to avoid Haiku compaction costs | claude-local | `packages/adapter-utils/src/session-compaction.ts`, `server/src/__tests__/heartbeat-workspace-session.test.ts`, `ui/src/components/agent-config-defaults.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-session.test.ts` |
| 17 | `7fd9c19d5` | fix: ensure --max-turns is always passed to Claude Code | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/test.ts` | _manuaalinen:_ yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
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
| 37 | `5f4a94021` | feat(rk9): add prh-prospector skill — open-data B2B lead enrichment | skills | `.gitignore`, `skills/prh-prospector/SKILL.md`, `skills/prh-prospector/references/ai-enrichment-prompts.md`, `skills/prh-prospector/references/baseline-2026-04-29.md` (+8) | _manuaalinen:_ skill näkyy company skills -listassa |
| 38 | `7f02e02c5` | feat(rk9): GitHub webhook delivery health monitor | github-webhooks | `server/scripts/check-github-webhook-health.ts` | _manuaalinen:_ smoke: `/api/github/webhooks` (401 ilman allekirjoitusta); manuaalinen: webhook-monitorin ajo (`scripts/`-cron) |
| 39 | `c583f5503` | feat(issues): add goalId filter to company issues list endpoint (#15) | core api | `server/src/__tests__/issues-service.test.ts`, `server/src/routes/issues.ts`, `server/src/services/issues.ts`, `skills/paperclip/references/api-reference.md` | `npx vitest run server/src/__tests__/issues-service.test.ts` |
| 40 | `ccad0d780` | feat(rk9): global system-pause to guard Anthropic quota | heartbeat | `packages/shared/src/index.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/index.ts` (+16) | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 41 | `e81a467e7` | fix(rk9): system pause silent skip for background heartbeat sources | heartbeat | `server/src/services/heartbeat.ts` | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 42 | `56f618bd9` | fix(rk9): system pause notifies Slack only on real transitions | heartbeat (+ slack) | `server/src/services/system-pause.ts` | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 43 | `b0cfb98f9` | fix(rk9): auto-pause uses latest blocking-window reset, not earliest | heartbeat | `server/src/index.ts`, `server/src/services/system-pause.ts` | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 44 | `5005d4b74` | fix(rk9): harden custom integrations (#16) | core api | `cli/esbuild.config.mjs`, `cli/src/__tests__/network-bind.test.ts`, `cli/src/__tests__/onboard.test.ts`, `doc/RESEND-SETUP.md` (+12) | `npx vitest run cli/src/__tests__/network-bind.test.ts cli/src/__tests__/onboard.test.ts server/src/__tests__/email-routes.test.ts …` |
| 45 | `5c3b89ae9` | Add quota pause guardrails for routines | heartbeat | `doc/DEVELOPING.md`, `server/src/__tests__/routines-service.test.ts`, `server/src/app.ts`, `server/src/routes/routines.ts` (+3) | `npx vitest run server/src/__tests__/routines-service.test.ts ui/src/pages/Routines.test.tsx` |
| 46 | `3e3626288` | Stabilize heartbeat test cleanup | heartbeat | `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`, `server/src/__tests__/heartbeat-dependency-scheduling.test.ts` | `npx vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/heartbeat-dependency-scheduling.test.ts` |
| 47 | `a2949a3c0` | Add quota pause guardrails for routines (#17) | heartbeat | `doc/DEVELOPING.md`, `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`, `server/src/__tests__/heartbeat-dependency-scheduling.test.ts`, `server/src/__tests__/routines-service.test.ts` (+5) | `npx vitest run server/src/__tests__/heartbeat-comment-wake-batching.test.ts server/src/__tests__/heartbeat-dependency-scheduling.test.ts server/src/__tests__/routines-service.test.ts …` |
| 48 | `086fd02fb` | feat(rk9): add instance-level global concurrency limit for heartbeat runs | heartbeat | `packages/shared/src/constants.ts`, `packages/shared/src/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts` (+9) | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 49 | `df7787457` | fix(rk9): add incident cooldown to prevent flapping risk incidents | risk | `server/src/__tests__/risk-monitors.test.ts`, `server/src/services/risk-incidents.ts`, `server/src/services/risk-monitors.ts` | `npx vitest run server/src/__tests__/risk-monitors.test.ts` |
| 50 | `550631402` | fix(adapters): trust Claude success result over SIGTERM exit code (#20) | claude-local | `packages/adapters/claude-local/src/server/execute.ts`, `server/src/__tests__/claude-local-execute.test.ts` | `npx vitest run server/src/__tests__/claude-local-execute.test.ts` |
| 51 | `acf2da1bb` | fix(slack): emit approval.created for risk-incident & budget approvals | slack (+ risk) | `server/src/__tests__/emit-approval-created.test.ts`, `server/src/services/approvals.ts`, `server/src/services/budgets.ts`, `server/src/services/risk-incidents.ts` | `npx vitest run server/src/__tests__/emit-approval-created.test.ts` |
| 52 | `f9bf66479` | fix(slack,risk): prefix-based URLs, redirect old links, fix Date bind | risk (+ slack) | `server/src/__tests__/slack-formatters.test.ts`, `server/src/services/risk-incidents.ts`, `server/src/services/slack/event-forwarder.ts`, `server/src/services/slack/formatters.ts` (+1) | `npx vitest run server/src/__tests__/slack-formatters.test.ts` |
| 53 | `324ec7d5b` | feat: company-level pause/resume with heartbeat enforcement and Slack notifications | heartbeat (+ slack) | `server/src/routes/companies.ts`, `server/src/services/companies.ts`, `server/src/services/heartbeat.ts`, `ui/src/api/companies.ts` (+2) | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 54 | `1a81f807a` | docs(multi-user): add board-operator guide for multi-user access (SEC-90) | docs | `docs/guides/board-operator/multi-user-access.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 55 | `b57c96771` | feat(metrics): add agent task success rate endpoint (SEC-88) (#23) | core api | `server/src/app.ts`, `server/src/routes/agent-metrics.ts`, `server/src/services/agent-metrics.ts` | _manuaalinen:_ kyseinen API-kutsu harjoitusinstanssia vasten |
| 56 | `2059926c0` | feat(execution-policy): enforced outcome requirements before done (SEC-91) (#25) | core api | `docs/guides/execution-policy.md`, `packages/shared/src/index.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/types/issue.ts` (+6) | `npx vitest run server/src/__tests__/issue-outcome-requirements.test.ts ui/src/components/IssueProperties.test.tsx` |
| 57 | `2e0533b96` | fix: cancel queued runs when company is paused instead of leaving them stuck | heartbeat | `server/src/services/heartbeat.ts` | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 58 | `ce6f93d19` | fix: auto-promote backlog→todo when issue is created with an assignee | core api | `server/src/services/issues.ts` | _manuaalinen:_ kyseinen API-kutsu harjoitusinstanssia vasten |
| 59 | `3892b27f8` | fix(email): skip auto-reply when sender domain matches own route domain | email/support/escalation | `server/src/services/email/inbound-router.ts` | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 60 | `257417abc` | fix(email): skip auto-reply when sender domain matches own route domain (#26) | email/support/escalation | `server/src/routes/companies.ts`, `server/src/services/companies.ts`, `server/src/services/email/inbound-router.ts`, `server/src/services/heartbeat.ts` (+4) | _manuaalinen:_ smoke: SES/Resend inbound -tarkistus; manuaalinen: yksi testiviesti harjoitusinstanssin SES-reitille |
| 61 | `6c3dc8931` | feat: Sunspot rebrand (ent. Aurinko Terassit) + process-adapter -skriptit (#28) | cicd-failure-watch (+ skills) | `server/scripts/check-github-webhook-health.ts`, `server/scripts/process-adapters/cicd-failure-watch.sh`, `server/scripts/process-adapters/cost-summary.sh`, `server/scripts/process-adapters/deploy-validate.sh` (+6) | _manuaalinen:_ `bash -n server/scripts/process-adapters/cicd-failure-watch.sh` + yksi process-adapter-ajo |
| 62 | `2249948ea` | docs(ololla): manuaalinen E2E-testaussuunnitelma | docs | `ololla-e2e-testplan.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 63 | `f56ef4e90` | test: add unit tests for claude-local, cursor-local, gemini-local adapters | claude-local | `packages/adapters/claude-local/src/server/parse.test.ts`, `packages/adapters/cursor-local/src/server/parse.test.ts`, `packages/adapters/cursor-local/vitest.config.ts`, `packages/adapters/gemini-local/src/server/parse.test.ts` (+1) | `npx vitest run packages/adapters/claude-local/src/server/parse.test.ts packages/adapters/cursor-local/src/server/parse.test.ts packages/adapters/gemini-local/src/server/parse.test.ts` |
| 64 | `52b995085` | feat(agents): AI board member + paused/terminated assignment validation | core api | `scripts/e2e-companies-report.ts`, `server/src/onboarding-assets/ceo/AGENTS.md`, `server/src/onboarding-assets/cto/AGENTS.md`, `server/src/onboarding-assets/cto/HEARTBEAT.md` (+3) | _manuaalinen:_ kyseinen API-kutsu harjoitusinstanssia vasten |
| 65 | `60e3e0aa7` | ci(deploy-dev): drop push trigger (no runner registered, deploy is manual) | ci/tooling | `.github/workflows/deploy-dev.yml` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista että workflow/skripti on yhä olemassa ja PR-checkit ajautuvat |
| 66 | `7d4a81961` | fix(recovery): skip auto-recovery for agents with heartbeat disabled | heartbeat | `server/src/services/recovery/service.ts` | _manuaalinen:_ yksi claude_local-heartbeat per aktiivinen yritys; system pause päälle/pois |
| 67 | `a17aa8ca5` | fix(claude-local): kill quota probe process group to prevent orphaned claude CLIs | claude-local | `packages/adapters/claude-local/src/server/quota.ts` | _manuaalinen:_ yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 68 | `ca1d63842` | feat(agents): add human_proxy adapter type for AI board members (SEC-100) (#30) | core api | `packages/shared/src/constants.ts`, `scripts/migrate-ai-agents-to-human-proxy.ts`, `server/src/__tests__/human-proxy.test.ts`, `server/src/adapters/builtin-adapter-types.ts` (+13) | `npx vitest run server/src/__tests__/human-proxy.test.ts` |
| 69 | `f109affee` | fix(ui): pass adapterType to StatusBadge on agents list (SEC-100 follow-up) (#31) | core api | `ui/src/pages/Agents.tsx` | _manuaalinen:_ kyseinen API-kutsu harjoitusinstanssia vasten |
| 70 | `47e7fe249` | feat(recovery): add strictInProgressOnly flag + per-candidate decision logging (RK9-5 phase 1) (#32) | heartbeat | `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, `server/src/__tests__/heartbeat-process-recovery.test.ts`, `server/src/__tests__/instance-settings-routes.test.ts` (+2) | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/instance-settings-routes.test.ts` |
| 71 | `aba28b775` | fix(server): widen issue identifier regex to accept alphanumeric prefixes (#33) | core api | `packages/shared/src/issue-references.ts`, `server/src/routes/activity.ts`, `server/src/routes/agents.ts`, `server/src/routes/issues.ts` (+1) | _manuaalinen:_ kyseinen API-kutsu harjoitusinstanssia vasten |
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
| 83 | `29454e3b6` | feat(cli): add --body-file to `issue comment` (#44) | core api | `cli/src/commands/client/issue.ts` | _manuaalinen:_ kyseinen API-kutsu harjoitusinstanssia vasten |
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
| 111 | `b66f2e461` | chore(prompts): prompt audit — drop dated patterns, refresh model pins, describe MCP tools (#75) | skills | `cli/src/checks/llm-check.ts`, `cli/src/commands/onboard.ts`, `packages/adapters/claude-local/src/index.ts`, `packages/mcp-server/src/tools.ts` (+10) | _manuaalinen:_ skill näkyy company skills -listassa |
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
| 142 | `9ed8e7704` | feat(claude-local): add Claude Opus 5.5 to the model list and drift allow-list (#106) | claude-local | `packages/adapters/claude-local/src/index.ts`, `server/src/services/risk-monitors.ts` | _manuaalinen:_ yksi claude_local-heartbeat; tarkista ettei ANTHROPIC_API_KEY periydy (RK9-228) |
| 143 | `623789953` | test(claude-local): lock RK9-228 billing-key guard for the ACPX upgrade steps (RK9-305) (#107) | claude-local | `doc/upgrade/acpx-claude-local.md`, `packages/adapter-utils/src/server-utils.ts`, `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/server/host-env.ts` (+5) | `npx vitest run server/src/__tests__/claude-local-adapter-environment.test.ts server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/risk-monitors.test.ts` |
| 144 | `f4ce112a8` | chore(upgrade): add RK9 Custom markers to upstream-merge hotspots (RK9-304) (#109) | ci/tooling | `server/src/app.ts`, `server/src/index.ts`, `server/src/routes/issues.ts`, `server/src/services/heartbeat.ts` (+3) | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista, että merkit säilyvät mergessä |
| 145 | `b847acd30` | docs(upgrade): baseline regression matrix, upgrade smoke script and runbook refresh (RK9-304) (#108) | docs (+ ci/tooling) | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/fork-tests.txt`, `doc/upgrade/regression-matrix.md`, `scripts/upgrade-smoke.sh` | `scripts/upgrade-smoke.sh --offline` |
| 146 | `c6f22bd0d` | docs(upgrade): defaults-hardening checklist and hire/webhook guard tests (RK9-309) (#110) | core api (+ email) | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/defaults-hardening.md`, `doc/upgrade/fork-tests.txt`, `server/src/__tests__/hire-approval-policy.test.ts` (+1) | `npx vitest run server/src/__tests__/hire-approval-policy.test.ts server/src/__tests__/resend-inbound-route.test.ts` |
| 147 | `b15ca00de` | docs(upgrade): heartbeat/recovery fork-fix decision table and system-pause threshold test (RK9-308) (#113) | heartbeat | `doc/UPSTREAM-UPGRADE.md`, `doc/regression/heartbeat-recovery-fork-inventory.md`, `doc/upgrade/fork-tests.txt`, `server/src/__tests__/system-pause-threshold.test.ts` | `npx vitest run server/src/__tests__/system-pause-threshold.test.ts` |
| 148 | `35adb45d9` | feat(upgrade): rehearsal instance with netns egress isolation and rollback drill (RK9-306) (#111) | ci/tooling | `doc/UPSTREAM-UPGRADE.md`, `scripts/upgrade-rehearsal.sh` | _manuaalinen:_ `scripts/upgrade-rehearsal.sh <ref>` + `smoke` + `rollback` |
| 149 | `460a637d4` | fix(upgrade): rehearsal server starts — TMPDIR and plugin-sdk build (RK9-306) (#114) | ci/tooling | `scripts/upgrade-rehearsal.sh` | _manuaalinen:_ harjoituspalvelin käynnistyy (`scripts/upgrade-rehearsal.sh <ref>`) |
| 150 | `d86511d1c` | feat(upgrade): deploy/rollback-työkalut, outreach-ikkunaraportti ja cutover-runbook (RK9-307) (#112) | ci/tooling (+ outreach) | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/cutover-runbook.md`, `scripts/lib-pg-url-test.sh`, `scripts/lib-pg-url.sh` (+8) | `bash scripts/lib-pg-url-test.sh` |
| 151 | `b968359a3` | docs(upgrade): upstream refs per row and missing commits in heartbeat fork inventory (RK9-336) (#115) | docs | `doc/regression/heartbeat-recovery-fork-inventory.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 152 | `24f1f07b1` | docs(upgrade): heartbeat fork inventory — explicit file list, repro command, 10 missing commits (RK9-337) (#116) | docs | `doc/regression/heartbeat-recovery-fork-inventory.md` | _manuaalinen:_ ei ajonaikaista käytöstä — tarkista linkit |
| 153 | `32f03a868` | feat(db): migration dry-run tool, fork hash pinning, 916.1 trial-merge findings (RK9-311) (#117) | migrations 9001-9010 | `doc/UPSTREAM-UPGRADE.md`, `package.json`, `packages/db/package.json`, `packages/db/scripts/migration-dry-run.ts` (+6) | `npx vitest run packages/db/src/migration-dry-run-lib.test.ts packages/db/src/migration-fallback.test.ts` + `pnpm --filter @paperclipai/db check:migrations` |
| 154 | `d80243681` | RK9-310: Node 24 -valmistelu — CI, dokumentaatio ja harjoitustodiste (#118) | ci/tooling | `.github/workflows/e2e.yml`, `.github/workflows/refresh-lockfile.yml`, `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/cutover-runbook.md` (+1) | _manuaalinen:_ PR-checkit ajautuvat Node 24:llä |
| 155 | `57881ed99` | fix(db): migration driver throws when no hash resolves (RK9-348) (#119) | migrations 9001-9010 | `doc/UPSTREAM-UPGRADE.md`, `packages/db/src/client.ts`, `packages/db/src/migration-fallback.test.ts` | `npx vitest run packages/db/src/migration-fallback.test.ts` |
| 156 | `1db844938` | feat(outreach): RK9 template — per-template link host and user message (RK9-349) (#120) | outreach | `docs/implementation-notes/outreach-enrichment.md`, `docs/outreach/templates/rk9.md`, `packages/shared/src/constants.ts`, `server/src/__tests__/outreach-draft-logic.test.ts` (+3) | `npx vitest run server/src/__tests__/outreach-draft-logic.test.ts server/src/__tests__/outreach-quality-gate.test.ts` |
| 157 | `b50a83d24` | outreach: AI-luonnokset Opus 5.5:llä (effort medium) (#121) | outreach | `server/src/__tests__/outreach-draft-logic.test.ts`, `server/src/services/outreach/draft.ts` | `npx vitest run server/src/__tests__/outreach-draft-logic.test.ts` |
| 158 | `b73e6611b` | fix(outreach): rk9 template B — sell maintenance, never claim the site is broken (RK9-349) (#122) | outreach (docs) | `docs/outreach/templates/rk9.md` | _manuaalinen:_ ei ajonaikaista käytöstä — pohjateksti |
| 159 | `3e7ff9320` | ci: move fork CI behind vars.CI_RUNNER lever (RK9-350) (#123) | ci/tooling | `.github/workflows/ai-auto-merge.yml`, `.github/workflows/deploy-dev.yml`, `.github/workflows/docker.yml`, `.github/workflows/e2e.yml` (+8) | `scripts/upgrade-smoke.sh --offline` (runner-vipu-tarkistus) |
| 160 | `0d20d9704` | docs(upgrade): regressiomatriisin freeze 3e7ff9320, porras-512:n konfliktit ja lockfile-ohje (RK9-312) | docs | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/fork-tests.txt`, `doc/upgrade/regression-matrix.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 161 | `e2b601228` | fix(upgrade): fork concurrency default in route test, idle-timer cleanup race, gitleaks false positives (RK9-312) | ci/tooling (+ heartbeat) | `.gitleaksignore`, `server/src/__tests__/agent-permissions-routes.test.ts`, `server/src/__tests__/heartbeat-idle-timer-skip.test.ts` | `npx vitest run server/src/__tests__/agent-permissions-routes.test.ts server/src/__tests__/heartbeat-idle-timer-skip.test.ts` |
| 162 | `2f85242ed` | fix(upgrade): runner lever for upstream's new PR jobs, gemini turn-limit test, step-512 logs (RK9-312) | ci/tooling | `.github/workflows/pr.yml`, `doc/UPSTREAM-UPGRADE.md`, `packages/adapters/gemini-local/src/server/parse.test.ts` | `scripts/upgrade-smoke.sh --offline` |
| 163 | `6610d0e76` | fix(upgrade): guard acpx_local against the host API key, keep SEC-91 outcomes on monitor edits (RK9-312) | claude-local (+ SEC-91) | `.github/workflows/pr.yml`, `doc/upgrade/acpx-claude-local.md`, `doc/upgrade/fork-tests.txt`, `server/src/__tests__/acpx-host-key-guard.test.ts` (+2) | `npx vitest run server/src/__tests__/acpx-host-key-guard.test.ts` |
| 164 | `4a2f21f71` | fix: cicd-failure-watch repos after org transfer, firecrawl hint in prh-prospector (#126) | ci/tooling | `server/scripts/process-adapters/cicd-failure-watch.sh`, `skills/prh-prospector/SKILL.md` | _manuaalinen:_ `cicd-failure-watch.sh` löytää repot |
| 165 | `e3aa869c6` | docs(upgrade): Node 24 prod cutover notes and native-module rebuild step (RK9-347) (#124) | docs | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/cutover-runbook.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 166 | `c411b346f` | fix(upgrade): runner lever for upstream's split verify jobs, drop commitperclip-review workflow, Chrome-or-Playwright e2e step (RK9-313) | ci/tooling | `.github/workflows/commitperclip-review.yml`, `.github/workflows/pr.yml` | `scripts/upgrade-smoke.sh --offline` |
| 167 | `c000a2f07` | test(upgrade): fork tests on v2026.609.0 — hire authz via access.decide, RK9-87 in the new classifier test (RK9-313) | heartbeat/recovery (+ hire) | `doc/upgrade/fork-tests.txt`, `server/src/__tests__/heartbeat-process-recovery.test.ts`, `server/src/__tests__/hire-authorization-rk9.test.ts` (+5) | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts server/src/__tests__/hire-authorization-rk9.test.ts` |
| 168 | `7ab149048` | test(upgrade): upstream's run-id-required upload test follows RK9-76 (optional agent run id) (RK9-313) | issues (RK9-76) | `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` | `npx vitest run server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` |
| 169 | `b0c544f4d` | test(upgrade): wait for the workspace-validation recovery comment instead of one read (RK9-313) | heartbeat/recovery | `server/src/__tests__/heartbeat-process-recovery.test.ts` | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts` |
| 170 | `d87137790` | test(upgrade): keep fork routes out of upstream's exact OpenAPI coverage check (RK9-313) | ci/tooling | `server/src/__tests__/openapi-routes.test.ts` | `npx vitest run server/src/__tests__/openapi-routes.test.ts` |
| 171 | `79b57ef48` | fix(upgrade): keep the fork tasks:assign rule for agents on v2026.609.0 (RK9-313) | authz | `server/src/services/authorization.ts`, `server/src/__tests__/authorization-service.test.ts`, `server/src/__tests__/permissions-upgrade-boundary-routes.test.ts` (+1) | `npx vitest run server/src/__tests__/authorization-service.test.ts server/src/__tests__/permissions-upgrade-boundary-routes.test.ts` |
| 172 | `c23fcd163` | docs(upgrade): stage 609 log, conflict log and defaults review (RK9-313) | docs | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/defaults-hardening.md`, `doc/upgrade/regression-matrix.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 173 | `4328c3ffa` | chore(upgrade): gitleaks false positives from v2026.609.0 upstream commits (RK9-313) | ci/tooling | `.gitleaksignore` | PR-checkin gitleaks-ajo |
| 174 | `8b71bf803` | docs(upgrade): verifier notes for stage 609 — claude-local model listing egress, assignability, dependabot (RK9-313) | docs | `doc/upgrade/defaults-hardening.md`, `doc/upgrade/regression-matrix.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 175 | `5035179e9` | test(upgrade): fork gemini session tests target upstream's renamed isGeminiSessionUnrecoverableError (RK9-314) | gemini-local | `packages/adapters/gemini-local/src/server/parse.test.ts` | `npx vitest run packages/adapters/gemini-local/src/server/parse.test.ts` |
| 176 | `417d48068` | test(upgrade): upstream GGU-809 stranded-recovery tests follow RK9-87 on v2026.618.0 (RK9-314) | heartbeat/recovery | `server/src/__tests__/heartbeat-process-recovery.test.ts` | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts` |
| 177 | `31bd1ac41` | docs(upgrade): stage 618 log, conflict log, TRUST_PROXY loopback test (RK9-314) | docs (+ proxy) | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/regression-matrix.md`, `server/src/__tests__/trust-proxy-rk9.test.ts` (+3) | `npx vitest run server/src/__tests__/trust-proxy-rk9.test.ts` |
| 178 | `7a70d90b5` | chore(upgrade): gitleaks false positive from v2026.618.0 upstream redaction test (RK9-314) | ci/tooling | `.gitleaksignore` | PR-checkin gitleaks-ajo |
| 179 | `ea8ffec40` | test(upgrade): warm the email route import before the first email-routes test (RK9-314) | email | `server/src/__tests__/email-routes.test.ts` | `npx vitest run server/src/__tests__/email-routes.test.ts` |
| 180 | `7d5f268ad` | docs(upgrade): secrets:read gets its first callers in v2026.618.0 (RK9-314) | docs | `doc/upgrade/defaults-hardening.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 181 | `ce84785d3` | fix(upgrade): typecheck after the v2026.707.0 merge (RK9-314) | heartbeat/recovery (+ UI-testit) | `server/src/services/recovery/service.ts`, `packages/adapters/claude-local/src/server/parse.test.ts` (+2) | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts` |
| 182 | `1194e0254` | fix(upgrade): unique journal idx for fork migrations after upstream gaps (RK9-314) | db/migraatiot | `packages/db/src/migrations/meta/_journal.json`, `scripts/upgrade-smoke.sh` | `scripts/upgrade-smoke.sh --offline` (journal-tarkistus) |
| 183 | `bd0411dd0` | fix(upgrade): general suite after v2026.707.0 (RK9-314) | heartbeat (+ UI) | `ui/src/lib/new-agent-runtime-config.ts` (+5 testiä) | `npx vitest run ui/src/lib/new-agent-runtime-config.test.ts server/src/__tests__/heartbeat-idle-timer-skip.test.ts` |
| 184 | `9534b279b` | chore(upgrade): gitleaks false positives from v2026.707.0 upstream tests (RK9-314) | ci/tooling | `.gitleaksignore` | PR-checkin gitleaks-ajo |
| 185 | `10aea5fae` | test(upgrade): upstream idle-timer recovery test runs with the fork gate off (RK9-314) | heartbeat/recovery | `server/src/__tests__/heartbeat-process-recovery.test.ts` | `npx vitest run server/src/__tests__/heartbeat-process-recovery.test.ts` |
| 186 | `a2a82796f` | docs(upgrade): stage 707 conflict log and freeze rows (RK9-314) | docs | `doc/upgrade/regression-matrix.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 187 | `8fc7db049` | docs(upgrade): stage 707 log, rehearsal results and defaults review (RK9-314) | docs | `doc/UPSTREAM-UPGRADE.md`, `doc/upgrade/defaults-hardening.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 188 | `c3337709e` | test(upgrade): restore the fork SEC-91 expectation in the monitor-clear UI test (RK9-314) | SEC-91 (UI) | `ui/src/components/IssueProperties.test.tsx` | `npx vitest run ui/src/components/IssueProperties.test.tsx` |
| 189 | `9ff918377` | docs(upgrade): agent keys and runs without a valid responsible user on the prod copy (RK9-314) | docs | `doc/upgrade/defaults-hardening.md` | _manuaalinen:_ ei ajonaikaista käytöstä |
| 190 | `ddaf75727` | test(upgrade): retry run cleanup in the branch-containment test on late activity rows (RK9-314) | heartbeat (testi) | `server/src/__tests__/heartbeat-workspace-branch-containment.test.ts` | `npx vitest run server/src/__tests__/heartbeat-workspace-branch-containment.test.ts` |

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

## Konfliktit portaassa 512 (`origin/master` `3e7ff9320` + `v2026.512.0`, RK9-312)

Todellinen merge 2026-09-27: 31 konfliktitiedostoa (koemerge 916.1:een antoi 93). `server/src/app.ts` ja
`server/src/index.ts` automergautuivat, ja niiden RK9 Custom -merkit säilyivät (15 ja 9). Tiedostokohtainen
ratkaisu on porras-PR:n kuvauksessa. Upstream siirsi `RoutineListRow`n komponenttiin
`ui/src/components/RoutineList.tsx`, joten forkin system pause -vartija on nyt siellä.

| Tiedosto | Lohkoja | Ratkaisu |
|---|---|---|
| `pnpm-lock.yaml` | 27 | upstream + `pnpm install`; forkin riippuvuudet masterin versioissa |
| `packages/db/src/migrations/meta/_journal.json` | 10 | upstream 0000–0083, sitten 9001–9010 (idx 84–93) |
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | 7 | forkin RK9-87-testit; upstreamin productive-continuation-testit pois (recoveryn RK9-87-ohitus varjostaa requeuen). Huom.: upstreamin `heartbeat.ts` jonoaa silti yhden korjaavan ajon onnistuneen ajon jälkeen, jos issue jää `in_progress`-tilaan (successful-run handoff, `DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1`), ja recovery eskaloi sen jälkeen `blocked`-tilaan. Kustannus on rajattu, ja system/company pause koskee ajoa. |
| `server/src/routes/agents.ts` | 5 | upstreamin `normalizeIssueIdentifier` ja `normalizedRuntimeConfig`; `human_proxy`-adapterityyppi välitetään |
| `server/src/services/issue-execution-policy.ts` | 4 | outcome requirements + upstreamin monitor |
| `packages/adapters/claude-local/src/server/test.ts` | 3 | upstreamin sandbox-asennus + `considerHostEnv`; RK9-228-haarat säilyvät |
| `server/src/services/heartbeat.ts` | 3 | molemmat (importit, idle-timer-funktio + retry-now) |
| `server/src/services/recovery/service.ts` | 3 | handoff-eskalointi, sitten RK9-87-ohitus, sitten upstreamin continuation |
| `ui/src/pages/Routines.tsx`, `Routines.test.tsx` | 3 + 3 | upstream; system pause -vartija `RoutineList.tsx`:ään |
| muut 21 tiedostoa | 1–2 | ks. PR-kuvaus |

Porras-512:n muut fork-sovitukset (ei konfliktia, verifierin löydökset):

- `acpx_local` (uusi upstream-adapteri) käynnistää agentin koko `process.env`:llä. `server/src/adapters/registry.ts`
  estää ajon ja ympäristötestin, kun palvelimen envissä on `ANTHROPIC_API_KEY` ilman opt-iniä (RK9-228).
  Testi: `acpx-host-key-guard.test.ts`.
- `ui/src/components/IssueProperties.tsx` `updateMonitor` säilyttää SEC-91-vaatimukset. Testi:
  `IssueProperties.test.tsx` ("keeps outcome requirements when clearing a monitor").

## Konfliktit portaassa 609 (`origin/master` `69ae3ff5` + `v2026.609.0`, RK9-313)

Todellinen merge 2026-09-27: 34 konfliktitiedostoa, 203 upstream-committia, migraatiot 0084–0098.
`server/src/app.ts`, `server/src/index.ts`, `packages/db/src/schema/index.ts` ja
`packages/shared/src/constants.ts` automergautuivat. Upstream toi kaksi uutta keskitettyä tarkistusta,
joihin forkin säännöt nyt nojaavat: `agent-invokability.ts` (kuka voi ajaa) ja `agent-assignability.ts`
(kenelle voi antaa työtä), sekä `authorization.ts` (`access.decide`), joka hoitaa nyt myös hire-oikeuden.

| Tiedosto | Lohkoja | Ratkaisu |
|---|---|---|
| `pnpm-lock.yaml` | 14 | upstream + `pnpm install`; forkin riippuvuudet (`tsx`, `@aws-sdk/client-sesv2`, `@slack/web-api`, `mailparser`, `@types/mailparser`) masterin versioissa. Importerit = upstream + nämä viisi. |
| `packages/db/src/migrations/meta/_journal.json` | 10 | upstream 0000–0098, sitten 9001–9010 (idx 99–108), rivit muuten tavu tavulta ennallaan |
| `server/src/services/heartbeat.ts` | 5 | upstreamin invokability + forkin company pause, system pause, concurrency cap (`effectiveSlots`) ja human proxy -ohitus. Forkin toinen `writeSkippedRequest` poistettiin (upstream siirsi sen ylemmäs). |
| `ui/src/pages/Agents.tsx` | 4 | upstreamin `AgentStatusBadge`; forkin human proxy -merkki siirrettiin sen `adapterType`-propiksi (`StatusBadge.tsx`, `AgentProperties.tsx`, `AgentActionButtons.tsx`) |
| `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` | 3 | molemmat mockit ja testit; upstreamin uusi "run id required" -testi mukautettiin RK9-76:een (ajo-id valinnainen) |
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | 3 | forkin RK9-87-testit; upstreamin kaksi productive-continuation-testiä pois ja uusi classifier-testi RK9-87:n mukaiseksi |
| `.github/workflows/pr.yml` | 3 | lockfile-poikkeus + upstreamin dependabot-ehto; Playwright-askel: Chrome jos löytyy, muuten Playwrightin chromium (RK9-350/313); `upload-artifact@v7` |
| `server/src/services/recovery/service.ts` | 2 | forkin human proxy- ja heartbeat-disabled-poikkeus upstreamin async `isAgentInvokable`in eteen; upstreamin continuation-classifier + forkin `logCandidate`-kirjaus |
| `server/src/services/routines.ts` | 2 | upstreamin jaettu `assertAssignableAgent`; forkin human proxy -esto siirrettiin sinne (`kind: "routine"`), dispatch-vartija säilyi |
| `ui/src/pages/CompanySettings.tsx` | 2 | upstream + forkin company pause/resume |
| `cli/src/__tests__/network-bind.test.ts` | 2 | molemmat (forkin `execFileSync`-mock + upstreamin tyhjä `PATH`) |
| `server/src/routes/issues.ts` | 1 | human proxy ensin, sitten `pending_approval`, forkin paused/terminated-viesti ja upstreamin org chain -tarkistus |
| `server/src/routes/approvals.ts` | 1 | molemmat (RK9-82 `wakeRequesterOnDecision` + upstreamin `assertApprovalAccessAllowed`) |
| `ui/src/App.tsx` | 1 | upstream (instanssiasetukset yritysasetusten alle); forkin `/companies/:uuid`-uudelleenohjaus säilyi |
| `packages/adapters/claude-local/src/*` | 3 × 1 | molemmat mallilistat (Claude 5 ensin), RK9-228-exportit ja `doNotInheritEnvKeys` |
| muut 17 tiedostoa | 1 | molemmat puolet (importit, exportit, riippuvuudet) |

Porras-609:n muut fork-sovitukset (ei konfliktia):

- Upstream lisäsi workflow'n `commitperclip-review.yml` (`pull_request_target`, upstreamin botin salaisuudet). Se poistettiin
  forkista: `pull_request_target` on kielletty (`doc/CI-RUNNER.md`), eikä botti toimi forkissa. Älä palauta mergessä.
- Upstream jakoi `pr.yml`:n `verify`-jobin neljään (`typecheck_release_registry`, `general_tests`, `build`, `verify`).
  Kaikki saivat runner-vivun.
- Upstreamin OpenAPI-kattavuustesti (`openapi-routes.test.ts`) ei tunne forkin reittejä. Testiin lisättiin
  RK9-poikkeuslista (13 reittitiedostoa, 7 reittiä). Forkin reittien dokumentointi `routes/openapi.ts`:ään on seurantatyö.
- `hire-approval-policy.test.ts` mockaa nyt `access.decide`n. Uusi `hire-authorization-rk9.test.ts` ajaa oikean
  `authorizationService`n embedded Postgresia vasten ja lukitsee hire-säännön.
- Upstreamin `access.decide("tasks:assign")` antaa jokaisen aktiivisen agentin antaa tehtäviä simple modessa.
  Forkin sääntö palautettiin RK9 Custom -lohkolla (`authorization.ts`): grantti tai CEO/`canCreateAgents`.
  Upstreamin kaksi testiä mukautettiin (`authorization-service.test.ts`, `permissions-upgrade-boundary-routes.test.ts`),
  ja molemmat lisättiin `fork-tests.txt`:hen. Perustelu: `defaults-hardening.md`, osio "Porras v2026.609.0 — oikeusmalli".
- Upstreamin `assertAssignableAgent(kind: "work")` hylkää agentin, jonka raportointiketju on rikki (#7663).
  Tämä koskee myös human proxy -agentteja, vaikka reitin kommentti sanoo niiden olevan aina assignattavissa.
  Merkitystä on vain, jos human proxy raportoi lopetetulle tai puuttuvalle esihenkilölle. Ei muutettu.
- Upstream lisäsi `.github/dependabot.yml`:n. Se on forkissa inertti (automaattiset tietoturvakorjaukset pois
  päältä), ja `pr.yml`:n dependabot-poikkeus on vaaraton.

## Konfliktit portaassa 618 (`origin/master` `06b877ab7` + `v2026.618.0`, RK9-314)

Porras 720 pilkottiin: suora koemerge `v2026.720.0` antoi 60 konfliktitiedostoa ja 83 migraatiota
(0099–0181), mikä ylittää operaattorin rajan (yli ~40 konfliktia tai yli ~60 migraatiota). Välitagit
koemergellä masteria vasten: 618 → 18 konfliktia ja 4 migraatiota, 626 → 33 ja 26, 707 → 44 ja 37.
Todellinen merge 2026-09-27: 18 konfliktitiedostoa, 76 upstream-committia, migraatiot 0099–0102.
`pnpm-lock.yaml` automergautui (upstreamin uusi `novita`-sandbox-plugin). `recovery/service.ts`,
`routines.ts` (palvelu ja reitti) automergautuivat.

| Tiedosto | Lohkoja | Ratkaisu |
|---|---|---|
| `packages/db/src/migrations/meta/_journal.json` | 4 | upstream 0000–0102, sitten 9001–9010 (idx 103–112), rivit muuten tavu tavulta ennallaan |
| `server/src/index.ts` | 3 | upstreamin `await`attu käynnistyksen reap (2 yritystä) ennen ajastimia + forkin `systemPause`- ja `maxGlobalConcurrentRunsDefault`-optiot; forkin importit; sammutuksessa sekä `closeQmdMcpSession` että upstreamin `shutdownInstrumentation` |
| `server/src/__tests__/claude-local-execute.test.ts` | 2 | upstreamin versio + forkin lisäykset tiedoston loppuun (SIGTERM-success-testi, RK9-228-describe) |
| `packages/adapters/gemini-local/src/server/parse.test.ts` | 2 | molemmat; upstream nimesi `isGeminiUnknownSessionError`in muotoon `isGeminiSessionUnrecoverableError`, forkin testit kohdistettiin uuteen nimeen |
| `packages/shared/src/types/instance.ts` | 2 | molemmat (forkin system pause + concurrency cap, upstreamin `executionMode`) |
| `server/src/services/issues.ts` | 2 | upstreamin `clearCheckoutRunIfTerminal` + `loadCurrent`; forkin `companyId` lisättiin selectiin (RK9-76 `assertKnownActorRunId`) |
| `server/src/services/heartbeat.ts` | 1 | molemmat (forkin company pause -välimuisti ja concurrency cap, upstreamin `liveRunExecutions`) |
| `ui/src/pages/Routines.tsx` | 1 | upstreamin uusi ryhmärakenne + forkin `systemPaused`-propi riville |
| `ui/src/components/StatusBadge.tsx` | 1 | forkin `adapterType`-propi ja human proxy -haara + upstreamin Conference Room Chat -paletti |
| `packages/adapters/claude-local/src/server/execute.ts` | 1 | upstreamin järjestys (poisoned message id -vartija); forkin SIGTERM-success-ehto (`parsedReportedSuccess`) siirrettiin upstreamin `failed`-riville RK9 Custom -merkin alle |
| `server/src/app.ts` | 1 | upstreamin `fileResourceRoutes` + forkin `routineRoutes(..., systemPause)` |
| `.github/workflows/commitperclip-review.yml` | modify/delete | pysyy poistettuna (RK9-313) |
| muut 6 tiedostoa | 1 | molemmat puolet (importit, exportit, validaattorit, instanssiasetukset) |

Porras-618:n muut fork-sovitukset (ei konfliktia):

- Upstream lisäsi `agent-runtime-images.yml`:n (push masteriin, julkaisee `ghcr.io/paperclipai`-kuviin). Jobi sai
  runner-vivun ja ehdon `github.repository == 'paperclipai/paperclip'`, joten se ei aja forkissa.
- Upstreamin GGU-809 (`hasRecentVisibleProgress`) lisäsi kaksi recovery-testiä, joissa onnistuneen ajon jälkeen
  toistuva continuation joko vapautetaan tuoreen kommentin takia tai eskaloidaan. RK9-87 ohittaa jokaisen
  `in_progress`-issuen, jonka viimeisin ajo onnistui, ennen tätä haaraa. Testit mukautettiin: ei jatkoajoa,
  ei eskalointia, issue pysyy `in_progress`-tilassa.
- `TRUST_PROXY` (`middleware/trust-proxy.ts`) tulee jo tässä tagissa, ei 720:ssä. Uusi `trust-proxy-rk9.test.ts`
  todentaa `loopback`-arvon (ks. `defaults-hardening.md`).
- `bootstrapExecutionPolicyFromEnv` (upstream) lukee pakotetun suorituspolitiikan envistä ja kaatuu äänekkäästi
  virheellisellä arvolla. Prodissa muuttujaa ei ole asetettu, joten käytös ei muutu.
- RK9-231 (idle timer -ohitus, `heartbeat.ts`) ja RK9-87 (`recovery/service.ts`) säilyivät ennallaan; kumpikaan ei
  ollut konfliktissa.

## Konfliktit portaassa 707 (`origin/master` `a0ae4d43b` + `v2026.707.0`, RK9-314)

Porras 720:n osa 2. Koemerge 618:n päälle: 626 → 23 konfliktia ja 22 migraatiota, 707 → 39 ja 31,
720 → 57 ja 77. 707 valittiin, koska se jää rajojen alle ja jättää 720:lle 46 migraatiota.
Todellinen merge 2026-09-27: 39 konfliktitiedostoa, migraatiot 0103–0135 (31 tiedostoa; upstreamista
puuttuvat 0126 ja 0130, ks. alla).

| Tiedosto | Ratkaisu |
|---|---|
| `packages/db/src/migrations/meta/_journal.json` | upstream 0000–0135 tavu tavulta, sitten 9001–9010 idx:llä 136–145. Upstreamin idx on sama kuin migraation numero, joten 0126:n ja 0130:n kohdalla on aukko. Paikkaan perustuva numerointi olisi antanut 9001:lle ja 9002:lle saman idx:n kuin 0134:lle ja 0135:lle; `client.ts` järjestää idx:n mukaan. `upgrade-smoke.sh` vaatii nyt tiukasti kasvavan idx:n. |
| `server/src/services/heartbeat.ts` (5 lohkoa) | molemmat. Forkin `systemPause`- ja `maxGlobalConcurrentRunsDefault`-optiot + upstreamin `runtimeEnv` ja `resolveHeartbeatSchedulingSuppression`. Upstream siirsi `activeRunExecutions`in moduulitasolle; forkin instanssikohtainen kopio poistettiin, joten globaali concurrency cap laskee nyt kaikkien `heartbeatService`-instanssien ajot. Käynnistyspolulla ensin upstreamin suppression-tarkistus, sitten forkin cap. Timer-tickissä ensin forkin system pause, sitten suppression. Knowledge recall (RK9-18) + upstreamin `requestedExecutionWorkspaceId`. |
| `server/src/index.ts` | forkin risk-palvelut ja system pause + upstreamin DB-backup-hälytys ja `resolveHeartbeatSchedulingSuppression`; heartbeat- ja routine-palvelu saavat forkin optiot |
| `server/src/services/agents.ts` | upstreamin transaktio ja secret binding -luonti; human proxy -agentin budjetti pysyy nollana (RK9 Custom) |
| `server/src/services/recovery/service.ts` | `LatestIssueRun` pitää forkin kentät (`issueCommentStatus`, `scheduledRetryReason`); upstreamin uusi `getLatestIssueRunForAgent` valitsee ne myös (RK9-87) |
| `server/src/services/approvals.ts`, `budgets.ts` | upstreamin `findOpenHireApprovalForAgent` + forkin `emitApprovalCreated` |
| `packages/adapters/claude-local/src/server/test.ts` | upstreamin rakenne; hello-probe ajetaan RK9-228:n `inheritableHostEnv()`-ympäristöllä |
| `packages/adapter-utils/src/execution-target.ts`, `claude-local/src/server/execute.ts` | molemmat (`doNotInheritEnvKeys` + upstreamin `runLogTail`) |
| `ui/src/components/IssueProperties.tsx` | upstream pilkkoi komponentin hakemistoon `issue-properties/`. Forkin ainoa muutos (SEC-91: monitorin muutos säilyttää `outcomeRequirements`in) siirrettiin tiedostoon `issue-properties/IssueProperties.tsx`. Testi siirrettiin upstreamin testitiedoston loppuun. |
| `ui/src/components/StatusBadge.tsx` | upstreamin `--sc`-värijärjestelmä; forkin `adapterType`-propi ja human proxy -haara `StatusBadge`- ja `AgentStatusBadge`-komponenteissa. Upstream poisti Conference Room Chat -paletin. |
| `ui/src/pages/Agents.tsx` | upstreamin `renderAgentRow`; `AgentStatusBadge` saa `adapterType`in |
| `ui/src/components/Sidebar.tsx` | upstream siirsi Skillsin Work-osioon; Company-osioon jäivät forkin Risks ja upstreamin Timeline |
| `ui/src/lib/new-agent-runtime-config.ts` | vain forkin `skipWhenIdle: true` (ks. alla) |
| `pnpm-lock.yaml` | upstreamin lockfile + `pnpm install --lockfile-only` (forkin sesv2, Slack, mailparser, `@types/node` 24) |
| `skills/paperclip-dev/SKILL.md` | upstream poisti (#7029); forkin versio pidettiin |
| `.github/workflows/commitperclip-review.yml` | pysyy poistettuna (RK9-313) |
| muut 21 tiedostoa | molemmat puolet (importit, validaattorit, instanssiasetukset, testit, dokumentaatio) |

Porras-707:n fork-päätökset ja testisovitukset:

- **RK9-231 vs. upstreamin `skipTimerWhenNoActionableWork`.** Molemmat ohittavat ajastetun heartbeatin, kun
  agentilla ei ole työtä. Forkin `skipWhenIdle` (oletus päällä, UI-kytkin) laskee työksi myös routine-ajot ja
  blokatut issuet, joiden blokkerit ovat ratkenneet. Upstreamin tarkistus (oletus pois, ei UI-kytkintä) katsoo vain
  `todo`- ja `in_progress`-issuet. Forkin portti pidettiin ensisijaisena, joten prodin käytös ei muutu. Upstreamin
  portti toimii lisänä, kun agentin konfiguraatiossa on `skipTimerWhenNoActionableWork: true`. Uuden agentin
  oletuksiin ei kirjoiteta upstreamin avainta, koska silloin forkin kytkimen kääntäminen pois ei palauttaisi ajoja.
  Upstreamin timer-testit (`heartbeat-stale-queue-invalidation`, `heartbeat-process-recovery`) ajavat
  `skipWhenIdle: false` -asetuksella.
- **Vastuukäyttäjä.** 707 kieltäytyy käynnistämästä ajoa, jos vastuukäyttäjää ei löydy (`responsible_user_unresolved`).
  Ketju: konteksti → routine → issue → yläissue → yrityksen `defaultResponsibleUserId` → omistaja → ensimmäinen
  aktiivinen käyttäjäjäsen. Forkin `heartbeat-idle-timer-skip.test.ts`:n yritys sai `defaultResponsibleUserId`n.
- **`tasks:assign`.** Upstreamin vastuukäyttäjätesti antaa agentille grantin, koska RK9-313-sääntö hylkää ilman grantia
  ennen vastuukäyttäjätarkistusta. Päätös on kummassakin tapauksessa "ei sallittu".
- **Ajastuksen esto.** `resolveHeartbeatSchedulingSuppression` estää ajastuksen, kun `PAPERCLIP_IN_WORKTREE`,
  `PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS` tai `PAPERCLIP_RESTORE_IN_PROGRESS` on tosi. Prodin prosessissa ja
  env-tiedostoissa näitä ei ole.
- `heartbeat-worktree-suppression.test.ts`: siivous yrittää uudelleen, kun valmis ajo kirjoittaa myöhäisen run-eventin
  (flake 1/3 builder-02:lla, korjauksen jälkeen 5/5).
- RK9-313:n `waitForValue`-korjauksen markkeri poistui `heartbeat-process-recovery.test.ts`:stä, koska upstream korjasi
  saman kohdan. GGU-809-sovitus (RK9-314) säilyi.

## Konfliktit portaassa 720 (`origin/master` `7a2ceba55` + `v2026.720.0`, RK9-314)

Porras 720:n osa 3, viimeinen. 42 konfliktitiedostoa ja 46 migraatiota (0136–0181). Konfliktimäärä on
pilkkomisrajan (~40) kohdalla. Porrasta ei pilkottu, koska 707 ja 720 ovat vierekkäiset tagit: välissä ei ole
tagia, jolla pilkkoa.

| Tiedosto | Ratkaisu |
|---|---|
| `packages/db/src/migrations/meta/_journal.json` | upstream 0000–0181 tavu tavulta, sitten 9001–9010 idx:llä 182–191 |
| `packages/adapters/claude-local/src/server/acp.ts` | upstreamin moottorivalitsin; asettamaton `engine` palauttaa `{ engine: "cli", explicit: false }` (RK9-228, RK9-305). Upstreamin oletus on ACP. |
| `packages/adapters/claude-local/src/server/execute.ts` | upstreamin versio. Forkin SIGTERM-onnistumissääntö on upstreamissa (`parsedSucceeded`), joten sen markkeri poistui. `doNotInheritEnvKeys` säilyi. |
| `packages/adapters/claude-local/src/server/index.ts`, `server/src/adapters/registry.ts` | forkin RK9-228-exportit + upstreamin `acp.js` ja `getConfigSchema`. Upstream poisti `acpx_local`-adapterin (hautakivi, ajo epäonnistuu `acpx_local_retired`). Forkin acpx-avainvartija (RK9-312) siirtyi claude_localin ACP-haaraan, ks. alla. |
| `packages/adapter-utils/src/server-utils.ts` | molemmat (`doNotInheritEnvKeys` + upstreamin `localProcessSandbox`) |
| `server/src/index.ts` | forkin palvelut + `toolAccessService`; heartbeat- ja routine-palvelu saavat forkin optiot. Upstreamin ajastuksen esto on nyt `heartbeat.resolveSchedulingSuppression()` ja `resolveWorktreeRunExecutionActivationState`. |
| `server/src/services/heartbeat.ts` | käynnistyspolulla ensin upstreamin suppression, sitten forkin globaali cap, sitten upstreamin worktree-cutoff. Timer-tickissä ensin forkin system pause, sitten suppression. |
| `server/src/services/routines.ts` | forkin `systemPause` + upstreamin `runtimeEnv` ja worktree-aktivointi; forkin try/catch-dispatch sai upstreamin `nextRunAtOverride`n |
| `server/src/services/recovery/service.ts` | upstreamin provider quota -funktiot + forkin `strictInProgressOnly`. `getLatestIssueRunSince` valitsee forkin kentät (RK9-87), provider quota -politiikan fallback saa `outcomeRequirements: []` (SEC-91). |
| `server/src/services/companies.ts` | forkin `seedDefaultTemplates` + upstreamin `autoProvisionBundledAgents` (fork-portti, ks. alla) |
| `server/src/routes/issues.ts`, `server/src/app.ts`, `server/src/services/instance-settings.ts`, `packages/shared/src/validators/*.ts` | molemmat |
| `server/package.json`, `pnpm-lock.yaml` | forkin sesv2 + upstream; `@paperclipai/adapter-acpx-local` poistui upstreamin mukana. Lockfile: upstreamin + `pnpm install --lockfile-only`. |
| `.github/workflows/release.yml`, uusi `release-verify.yml`, uusi `storybook-visual.yml` | runner-vipu, ks. `doc/UPSTREAM-UPGRADE.md` "CI-runner-vipu" |
| `ui/src/components/StatusBadge.tsx` | upstreamin `{ status, label }` + forkin `adapterType` ja human proxy -haara |
| `ui/src/components/Sidebar.tsx`, `ui/src/lib/status-colors.ts` | molemmat (forkin Risks + upstreamin Apps; riskitilat + tool access -tilat) |
| `ui/src/pages/Routines.tsx`, `Routines.test.tsx` | forkin system pause -kysely ja `systemPaused`-propi + upstreamin jaettu pollaus ja kansiot |
| `ui/src/pages/InstanceGeneralSettings.tsx`, `ClaudeSubscriptionPanel.tsx` | forkin globaali concurrency-osio ja Pause/Resume-napit upstreamin `Card`- ja token-luokilla |
| `ui/src/components/IssueProperties.test.tsx` | upstreamin arkistotestit + forkin SEC-91-testi |
| `ui/src/components/IssueMonitorActivityCard.test.tsx` | upstream poisti komponentin, testi poistettiin |
| `heartbeat-workspace-branch-containment.test.ts`, `heartbeat-worktree-suppression.test.ts` | upstreamin versio; upstreamilla on omat siivousapurit, forkin retry-markkerit poistuivat |
| `heartbeat-process-recovery.test.ts` | molemmat; upstreamin uudet testit + RK9-87-testit |
| muut | molemmat puolet (importit, validaattorit, testit, dokumentaatio) |

Porras-720:n fork-päätökset:

- **ACP ja host-avain.** Migraatio `0136` muuntaa `acpx_local`-agentit muotoon `claude_local` + `engine: "acp"`
  (eksplisiittinen). ACP-polku antaa agentille koko palvelimen envin, joten eksplisiittinen ACP ohittaisi RK9-228:n.
  Vartija siirtyi `claude_local`in `execute`- ja `testEnvironment`-funktioihin: eksplisiittinen ACP-ajo epäonnistuu
  koodilla `claude_acp_host_key_blocked`, kun palvelimen envissä on `ANTHROPIC_API_KEY` ilman opt-iniä. Testi:
  `packages/adapters/claude-local/src/server/execute.acp-host-key-guard.test.ts`. Prod-kopiossa ei ole
  `acpx_local`-agentteja eikä yhtään agenttia, jolla on `engine`-asetus.
- **Built-in-agentit.** Upstream luo Reflection Coachin ja Summarizerin jokaiseen yritykseen joka käynnistyksessä.
  Prod-kopiossa ensimmäinen käynnistys loi 16 agenttia 8 yritykseen, joista 8 odotti palkkaushyväksyntää.
  Hylätty tai terminoitu agentti syntyy uudelleen seuraavassa käynnistyksessä. Fork luo ne vain, kun
  `enableBuiltInAgents` on päällä (oletus pois). Oletusgrantit ajetaan silti. Testi:
  `companies-service.test.ts` ("does not auto-provision bundled agents while built-in agents are disabled").
- **Upstreamin punaiset testit.** `test.probe.test.ts` ja `execute.remote.test.ts` kaatuvat myös puhtaalla
  v2026.720.0:lla; niihin tuotiin v2026.817.0:n odotukset. `parse.test.ts`: max turns tunnistetaan vain
  rakenteisista kentistä.

## Konfliktit portaassa 817 (`origin/master` `d27bd45d` + `v2026.817.0`, RK9-315)

Porras 4/6. 39 konfliktitiedostoa ja 30 migraatiota (0182–0211), molemmat pilkkomisrajojen alla.

| Tiedosto | Ratkaisu |
|---|---|
| `packages/db/src/migrations/meta/_journal.json` | upstream 0000–0211 tavu tavulta, sitten 9001–9010 idx:llä 212–221. Upstream muutti `0177`:n idx:n 178:ksi, joten `0177` ja `0178` jakavat idx:n; `client.ts` ratkaisee tasapelin tiedostonimellä. |
| `packages/adapter-utils/src/acpx-engine/execute.ts`, `execute.test.ts` | upstreamin versio + forkin POSIX-wrapper ilman env-tiedostoa ja `sanitizeInheritedPaperclipEnv` sandbox-kaistalla (ks. `acpx-claude-local.md`). Upstreamin neljä odotusta sovitettiin wrapperiin. |
| `packages/adapters/claude-local/src/server/execute.ts` | upstreamin `selectPaperclipTaskMarkdown`-pohjainen tehtäväkonteksti + forkin knowledge-konteksti (RK9-18) ja turn budget -huomautus RK9 Custom -lohkossa |
| `packages/adapters/claude-local/src/server/test.ts` | järjestys: konfigin avain, perityn host-avaimen varoitus (RK9-228), upstreamin `CLAUDE_CODE_OAUTH_TOKEN`, ei-perityn host-avaimen info (RK9-228), tilaus |
| `packages/adapters/claude-local/src/server/execute.remote.test.ts` | upstreamin versio; forkin backport on upstreamissa, joten sen markkeri poistui |
| `packages/adapters/claude-local/src/index.ts` (ei konfliktia) | upstreamin `claude-sonnet-5`- ja `claude-opus-5`-rivit olisivat tulleet kahdesti; duplikaatit poistettu, Opus 5.5 pysyy ensimmäisenä |
| `server/src/services/authorization.ts`, `authorization-service.test.ts` | forkin `tasks:assign`-sääntö (RK9-313) + upstreamin default-open-kommentit ja -muutokset (#10804). Low-trust-testin rajan sisäinen assign odottaa `deny_missing_grant`. |
| `server/src/routes/issues.ts` | forkin paused/terminated-assignee-vartija, SEC-91-outcomes ja RK9-76:n valinnainen run id checkoutissa ja interaktion luonnissa. Upstreamin `unblockDescriptor`, blocked-syyn validointi ja checkoutin unique violation -409. `requireAgentRunId` palautettiin upstreamin interaktioiden resolve- ja withdraw-reiteille. |
| `server/src/routes/approvals.ts` | reject kutsuu sekä forkin `wakeRequesterOnDecision`ia (RK9-82) että upstreamin `queueAdditionalApprovalReviewPathWakes`ia |
| `server/src/index.ts`, `server/src/app.ts` | molemmat; heartbeat-palvelu luodaan upstreamin tapaan aikaisin (`heartbeatSchedulerEnabled`) forkin optioilla (`systemPause`, `maxGlobalConcurrentRunsDefault`) |
| `server/src/services/heartbeat.ts` | upstreamin compact/redaction, sitten forkin knowledge-injektio |
| `server/src/services/recovery/service.ts` | `LatestIssueRun` sisältää forkin kentät (RK9-87) |
| `packages/shared/src/feature-catalog.ts` (ei konfliktia) | forkin liput `knowledgeRecallInjectionEnabled` ja `recoveryStrictInProgressOnly` lisätty katalogiin (muuten typecheck kaatuu) |
| `.github/workflows/pr.yml`, `release.yml`, `docker.yml`, `release-smoke.yml` | runner-vipu uusille jobeille (`e2e`-aggregaatti, `build-and-push-cloud`, stable-jobit); `release-smoke.yml` sai `runner_label`-inputin. `commitperclip-review.yml` poistettiin taas. |
| `package.json`, `server/package.json`, `pnpm-lock.yaml` | molemmat; lockfile upstreamista + `pnpm install`. `@types/node` pysyy masterin versiossa 24.13.3. |
| `heartbeat-process-recovery.test.ts` | forkin versio (RK9-87 korvasi upstreamin kaksi testiä) |
| `heartbeat-retry-scheduling.test.ts` | forkin retry-silmukka kutsuu upstreamin `cleanupHeartbeatRunDependents()`ia |
| `scripts/provision-worktree.sh` | upstreamin versio (seed-argumentit poistuivat) |
| `skills/paperclip/SKILL.md` | upstreamin "Bounded write retry" + forkin blocked-rivi; lisäksi RK9 Custom -lohko blocked-syyn säännöstä |
| muut | molemmat puolet (importit, exportit, testit, dokumentaatio) |

CI:n löytämät sovitukset (RK9-315):

| Tiedosto | Ratkaisu |
|---|---|
| `server/src/services/issues.ts` (`addComment`, `assertKnownActorRunId`) | forkin RK9-76-tarkistus pidettiin: tuntematon run id on 422 ennen tallennusta. Ilman sitä board-kommentti tallentuisi ja reitti palauttaisi 500:n `activity_log`in FK:sta. Tarkistus hylkää nyt myös ei-UUID-arvon 422:lla (ennen Postgres-virhe). Upstreamin kaksi "nulls out" -testiä odottavat 422:ta. |
| `server/src/routes/issues.ts` (`assertCrossIssueInfluenceWithinRunCap`) | runiton human proxy -agentti ohittaa 817:n run-vaatimuksen (operaattorin interaktiiviset sessiot, RK9-76). Testit: `issue-comment-reopen-routes.test.ts` (RK9 Custom -lohko). |
| `issue-assignee-invokability-routes.test.ts` | upstream (#10837) sallii boardin asettaa paussatun agentin assigneeksi. Forkin vartija estää paussatut ja terminoidut kaikilta; testi odottaa 409:ää. |
| `status-cards.test.ts` | status cardit käyttävät `tasks:assign`-oikeutta. Forkin RK9-313-sääntö vaatii agentilta grantin, joten testiagentti saa jäsenyyden ja grantin. |
| `agent-permissions-routes.test.ts`, `heartbeat-stale-queue-invalidation.test.ts` | forkin oletukset: `AGENT_DEFAULT_MAX_CONCURRENT_RUNS` = 5, ja RK9-231-idle-portti pois testistä |
| `server-startup-feedback-export.test.ts` | forkin `risk-event-listeners.js` mockattiin: sen riippuvuusketju lataa 817:ssä `services/issues.ts`:n, joka lukee db-tauluja moduulin latauksessa |
| `cli/src/__tests__/onboard.test.ts` | `node:child_process`-mock osittaiseksi (817:n `service-manager.ts` tuo `execFile`n) |
| `claude-local/src/server/test.probe.test.ts` | upstreamin usage-limit-syöte palautettiin; 720:n backport-markkeri poistui tarpeettomana |
| `.github/workflows/release.yml`, `docker.yml` | upstreamin nightly-npm-kaista (`select_nightly`, ajastettu) ja `build-and-push-cloud` saivat ehdon `github.repository == 'paperclipai/paperclip'` |

Poistetut tiedostot: upstream poisti cloud upstream -koodin (16 tiedostoa), `Activity.tsx`:n ja tool app galleryn.
Fork ei ollut muuttanut niistä yhtään.

## Konfliktit portaassa 831 (`origin/master` `917ae45d` + `v2026.831.1`, RK9-316)

Porras 5/6. 32 konfliktitiedostoa ja 19 migraatiota (0212–0230), molemmat pilkkomisrajojen alla.
Lista on tarkistettavissa: `git merge-tree --write-tree --name-only 917ae45d v2026.831.1`.

| Tiedosto | Ratkaisu |
|---|---|
| `packages/db/src/migrations/meta/_journal.json` | upstream 0000–0230 tavu tavulta, sitten 9001–9010 muuttamattomina idx:llä 231–240 |
| `.github/workflows/release.yml`, `release-smoke.yml` (ei konfliktia) | upstreamin versio; jokainen `runs-on: ubuntu-latest` sai RK9-350-runner-vivun, `verify_beta_candidate` sai `runner_label`-inputin ja uusi `smoke_service` vivun. `commitperclip-review.yml` pysyy poistettuna. |
| `.github/scripts/check-pr-migration-order.mjs` (ei konfliktia) | upstreamin uusi CI-tarkistus (#12433) vertaa kaikkia migraationumeroita yhteen maksimiin, jolloin jokainen 02xx näyttäisi olevan 9010:n "takana". RK9 Custom: vertailu tehdään sarjoittain (upstream < 9000, fork ≥ 9000). Neljä testiä lisätty. |
| `scripts/check-node-version-policy.mjs` (ei konfliktia) | RK9 Custom: `infra/ses-forwarder/package.json` ohitetaan, koska se on AWS Lambda (`nodejs20.x`) eikä ajeta palvelimen Nodella |
| `.env.example`, `.gitignore`, `package.json`, `packages/db/package.json`, `server/package.json`, `pnpm-lock.yaml` | molemmat; lockfile upstreamista + `pnpm install`. Forkin riippuvuudet (`tsx`, AWS SDK, `jsdom`, `mailparser` ja tyypit) säilyivät. |
| `packages/adapters/claude-local/src/server/test.ts` | upstreamin `buildLocalAdapterTestProbeEnv` ja `prepareSandboxClaudeProbeRuntime` + forkin RK9-228-host-env: `runtimeEnv` rakennetaan `inheritableHostEnv()`:stä ja probe saa `doNotInheritEnvKeys: hostEnvKeysNotInherited()`. `ANTHROPIC_API_KEY` ei siis periydy probelle. |
| `packages/adapters/claude-local/src/server/acp.test.ts` | forkin pin-testin nimi, Node-versio `v24.11.0` (831:n engines-alaraja) |
| `server/src/__tests__/claude-local-adapter-environment.test.ts` (ei konfliktia) | upstreamin probe käyttää luotettua PATHia eikä konfigin `command`ia. Testin väärennetty `claude` laitetaan PATHin alkuun, ja kaappauspolku kulkee ei-`PAPERCLIP_*`-muuttujassa. |
| `packages/mcp-server/src/tools.ts` | molemmat työkalut (`paperclipRecallKnowledge`, `paperclipListSkills`); forkin heartbeat-context-kuvaus, id-validointi `z.string().guid()` kuten upstreamissa |
| `packages/shared/src/validators/*.ts` (ei konfliktia) | zod 4: `z.record` sai avainskeeman, `sendWindow` käyttää `.prefault({})`:tä ja outreachin id:t `.guid()`:ta (zod 4:n `.uuid()` hylkää ei-RFC-arvot) |
| `packages/shared/src/validators/instance.ts` | upstreamin tyyppi + forkin `ManualPauseRequest` |
| `server/src/index.ts`, `server/src/app.ts` | molemmat; heartbeat-palvelu forkin optioilla (`systemPause`, `maxGlobalConcurrentRunsDefault`), forkin Slack/risk/email/outreach-käynnistys ennen upstreamin `reconcileStaleRuntimeControlOperations`ia, `closeQmdMcpSession()` ennen `finalizeServerShutdown`ia |
| `server/src/routes/issues.ts` | forkin RK9-76: `assertKnownActorRunId` ennen transaktionaalista päätöspäivitystä ja valinnainen run id checkoutissa (`getAgentRunId`). Upstreamin workspace-reopen säilyi. Interaktioiden resolve/withdraw vaativat yhä run id:n (upstream). |
| `server/src/services/recovery/service.ts` | upstream toi not-invokable-eskalaation. RK9 Custom -lohko ohittaa sitä ennen human proxy- ja heartbeat-disabled-agentit (`isRk9RecoveryExcludedAgent`); paussatut ja terminoidut agentit saavat upstreamin eskalaation. Forkin `unwrapDatabaseConflictError` poistui käyttämättömänä. |
| `server/src/services/built-in-agents.ts`, `companies.ts`, `heartbeat.ts`, `routes/companies.ts` | forkin RK9-314-portti (`enableBuiltInAgents`) ensin; upstreamin `wakeOnDemand` + forkin `skipWhenIdle`; importit molemmista |
| `heartbeat-process-recovery.test.ts` | forkin versio. Testinimien vertailu: yksikään upstreamin tai forkin testi ei kadonnut. |
| `built-in-agents.test.ts`, `companies-service.test.ts`, `openapi-routes.test.ts`, `server-startup-feedback-export.test.ts` | molemmat; openapi-suodatin yhdistää `RK9_FORK_ROUTES`in ja upstreamin `specOnlyContractFirstRoutes`in |
| `hire-approval-policy.test.ts` (ei konfliktia) | 831 antaa agentin luonnille kolmannen argumentin (create options), joten odotukset saivat `expect.anything()`:n |
| `skills/paperclip/SKILL.md` | upstreamin teksti + RK9-315:n blocked-syyn lohko |
| `ui/src/pages/InstanceSettings.tsx` | upstream poisti sivun (#12282). Forkin globaali ajolaskuri ("X / Y running") siirtyi `InstanceGeneralSettings.tsx`:n concurrency-osioon RK9 Custom -markkerien sisään. |
| `ui/src/pages/InstanceGeneralSettings.tsx`, `CompanySettings.tsx`, `Companies.tsx`, `components/ApprovalPayload.tsx` | molemmat; forkin concurrency-kortti muuttui upstreamin tyyliseksi `<section>`iksi |
| `.gitleaksignore` (ei konfliktia) | upstreamin RFC 6455 -esimerkkiavain `durable-prp-control-plane.test.ts`:ssä on väärä positiivinen |

RK9 Custom -markkerit: 294 → 309 (`git grep -c 'RK9 Custom' -- . ':!doc'`). Yksi markkeri katosi:
`companies-service.test.ts`:n Reflection Coach -testin RK9-314-rivi. Upstream korvasi koko testin testillä,
joka odottaa, ettei bundled-agentteja luoda lainkaan, joten forkin lippurivillä ei ole enää kohdetta.
`InstanceSettings.tsx`:n laskurilla ei ollut markkeria; siirretty koodi on nyt markkerien sisällä.

Tunnettu CI-rajoite: `paperclip-runner` (Rust) tarvitsee `cargo`n typecheckiin ja serverin
`prepare:runner-vendor`iin. builder-02:lla ei ole cargoa, joten serverin typecheck ajettiin sieltä
TypeScript-buildin kautta (`build:typescript` + `tsc --noEmit`). Tuotanto ajaa TS-lähdettä `tsx`:llä,
eikä natiivia runneria käytetä (`enableNativeRunner` = false).

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
