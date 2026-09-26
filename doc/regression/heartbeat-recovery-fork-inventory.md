# Heartbeat/recovery/routines/execution-policy — forkin korjaukset ja päätöstaulukko

Osa epiciä [RK9-303](/RK9/issues/RK9-303), lapsi [RK9-308](/RK9/issues/RK9-308).
Tämä dokumentti kertoo, mitä jokaiselle forkin korjaukselle tehdään tagiportaissa,
jotta konflikteja ei ratkaista sokkona. Se ei tee mergeä eikä muuta ajonaikaista koodia.

## Menetelmä ja rajaus

- Merge-base: `d0bdbe11a`. Forkin commitit: `git log --oneline d0bdbe11a..HEAD -- <tiedosto>`.
- Upstream-vertailu: tagi `v2026.916.1` (`d554c4789`), haettu `upstream`-remotesta
  tuotantohakemistossa `/home/rk9admin/paperclip` (tämä worktree ei sisällä upstream-remotea).
- Rajaus: taulukko kattaa vain ne korjaukset, jotka issue nimeää (RK9-231, RK9-87, RK9-5,
  RK9-18, RK9-76, system pause / auto-pause, knowledge-injection) sekä niiden kanssa samoissa
  tiedostoissa olevat forkin ominaisuudet.
- Upstream-viitteet on haettu 26.9. komennoilla `git log d0bdbe11a..v2026.916.1 -S<tunniste> -- <tiedosto>`
  ja `git show v2026.916.1:<tiedosto>` tuotantohakemistossa. Tagi oli jo haettu (`git fetch upstream --tags`
  ei tuonut uutta). Sarake "Upstream" kertoo SHA:n ja PR:n tai "ei upstream-vastinetta" ja perustelun.
  SHA on **ensimmäinen** commit, joka toi tunnisteen tiedostoon (`-S`). Se osoittaa vastinetta, ei todista
  semantiikan yhtäläisyyttä: todenna semantiikka portaan harjoitusmergessä.
- Inventaari kattaa kaikki commitit komennosta `git log d0bdbe11a..HEAD -- <tiedostot>` (41 kpl):
  taulukon rivit 1–17 ja luku "Muut commitit" alla.
- Tiedostot `routines.ts` ja `issue-execution-policy.ts` eivät sisällä RK9-tunnisteella
  merkittyjä committeja. Forkin muutokset niissä ovat tunnisteettomia (`ccad0d78`, `a2949a3c`,
  `2059926c` tai `ca1d6384`), joten ne on listattu commitin, ei tiketin mukaan.

## Päätökset

Päätökset: **drop** (upstream korjasi jo), **re-port** (sovita uuteen koodiin), **redesign**
(uusi semantiikka on ristiriidassa, päätä uudelleen).

| # | Korjaus | Fork-commit | Tiedostot | Upstream `v2026.916.1` | Päätös | Regressiotesti (vihreä ennen mergeä) |
|---|---|---|---|---|---|---|
| 1 | RK9-231: käsin `blocked`-tilaan asetettu issue ei ole odottavaa timer-työtä | `672d71a9` | `heartbeat.ts` | `631b7806e` (#8347): `skipTimerWhenNoActionableWork` + `hasActionableTimerWork`; sallitut tilat vain `todo`, `in_progress`, joten käsin `blocked`-issue ei laukaise timeria. Semantiikka todennettu vain koodista | drop (ehdollinen: todenna testillä portaassa; muuten re-port) | `heartbeat-idle-timer-skip.test.ts` |
| 2 | Idle timer -ajojen ohitus ja vuoro-budjetin kertominen agentille (#76) | `ead6c2b9` | `heartbeat.ts`, `claude-local/execute.ts` | Idle-ohitus: sama `631b7806e` (#8347), ks. rivi 1. Vuoro-budjetti agentille (`claude-local/execute.ts`): ei upstream-vastinetta | drop (idle-ohitus), re-port (vuoro-budjetti) | `heartbeat-idle-timer-skip.test.ts` |
| 3 | RK9-87: ei uutta continuationia jo onnistuneelle in_progress-ajolle | `b05d1c1f` | `recovery/service.ts` | Upstream on kirjoittanut recoveryn natiiviajojen ympärille (`latestRun?.status === "succeeded"` -haarat, `nativeBlockedUnblockAction`, `recovery/service.ts` 5 913 riviä). Lähimmät commitit: `1fe89eb8f` (#9373, durable external-wait liveness) ja `35fdc0c66` (#13075, durable task recovery). Tarkkaa vastinetta ei löytynyt: rivin `skipped_latest_run_succeeded`-päätöstä ei ole upstreamissa. Semantiikan vastaavuus todentamatta | redesign | `heartbeat-process-recovery.test.ts` (päätös `skipped_latest_run_succeeded`) |
| 4 | RK9-5 vaihe 1: `strictInProgressOnly` + päätösloki per ehdokas | `47e7fe24` | `recovery/service.ts`, `instance-settings` | Ei upstream-vastinetta (`git log -S strictInProgressOnly` ja `git grep` tyhjiä; forkin oma vartija) | re-port | `heartbeat-process-recovery.test.ts` (`skipped_strict_in_progress_only`), `instance-settings-routes.test.ts` |
| 5 | Recovery ohittaa agentit, joilla heartbeat pois päältä tai jotka ovat `human_proxy` | `7d4a8196`, `ca1d6384` | `recovery/service.ts`, `routines.ts`, `heartbeat.ts` | Osittainen: `71a8464fe` (#7663, agent-eligibility/invokability) ja `cb0009b09` (#11817, `isHeartbeatWakeOnDemandEnabled` recoveryn omistajatarkistuksessa) kattavat ohituksen "agentti ei ole invokable / wake-on-demand pois". `human_proxy`: ei upstream-vastinetta (`git log -S human_proxy` tyhjä) | re-port (`human_proxy`), redesign-tarkistus heartbeat-pois-osalle |  `human-proxy.test.ts`, `heartbeat-process-recovery.test.ts` (`skipped_agent_not_invokable`) |
| 6 | RK9-76: tuntematon `actorRunId` ei kaada checkoutia, status-päivitystä tai kommenttia (500) | `e1ae4898` | `routes/issues.ts`, `services/issues.ts` | Upstream lukee `actorRunId`:n `heartbeatRuns`-taulusta (`services/issues.ts` rivit 418–425, vain `responsibleUserId`:n haku) ja `d7049e0ca` (#5413) adoptoi vanhentuneen checkout-ajon. Ei `assertKnownActorRunId`-vastinetta eikä 422-suojausta tuntemattomalle run-id:lle: ei upstream-vastinetta tälle osalle | redesign | `issues-checkout-race.test.ts`, `issue-agent-mutation-ownership-routes.test.ts` |
| 7 | RK9-18 (C6): knowledge-recall-injektio heartbeat-promptiin, kill-switch + per-agent-portti | `9394a2f3` | `heartbeat.ts`, `knowledge-injection.ts` | Ei upstream-vastinetta (`git log -S knowledge-injection` tyhjä; `git grep -i recall` osuu vain muihin ominaisuuksiin) | re-port | `services/knowledge-injection.test.ts`, `knowledge-routes.test.ts` |
| 8 | System pause (globaali kiintiövartija) + hiljainen ohitus taustalähteille | `ccad0d78`, `e81a467e` | `heartbeat.ts`, `routines.ts`, `index.ts`, `config.ts`, `services/system-pause.ts` | Ei upstream-vastinetta (`git log -S systemPause` tyhjä) | re-port | `system-pause-threshold.test.ts` (uusi), `routines-service.test.ts` (`System paused`) |
| 9 | Auto-pause-monitori: `evaluateAutoPause`, `SYSTEM_PAUSE_THRESHOLD_PCT` | `ccad0d78`, `b0cfb98f`, `56f618bd` | `index.ts`, `config.ts`, `services/system-pause.ts` | Ei upstream-vastinetta (sama tyhjä `-S systemPause`) | re-port | `system-pause-threshold.test.ts` (uusi) |
| 10 | Globaali samanaikaisuusraja heartbeat-ajoille | `086fd02f` | `heartbeat.ts`, `instance-settings` | Ei upstream-vastinetta globaalille rajalle. Upstreamin `maxConcurrentRuns` (`heartbeat.ts`, `631b7806e`-aikakauden policy) on agenttikohtainen, ei instanssitasoinen | re-port | `instance-settings-routes.test.ts` |
| 11 | Quota pause -vartijat routineille | `a2949a3c` | `routines.ts`, `ui/src/pages/Routines.tsx` | Ei upstream-vastinetta kiintiövartijalle (`git log -S quota -- routines.ts` tyhjä). Lähin: `d60f50e4a` (#7502) vaimentaa ajastetut tickit projektin ollessa paused, eri ehto | re-port | `routines-service.test.ts` |
| 12 | Enforced outcome requirements ennen `done` (SEC-91) | `2059926c` | `issue-execution-policy.ts`, `routes/issues.ts`, shared | Ei upstream-vastinetta (`git log -S outcome_requirement` tyhjä). Upstream `issue-execution-policy.ts` on muuttunut muuten (esim. `3e1dc90bf` #7936, `27f8c8dbc` #10650), joten konfliktin odotetaan | re-port | `issue-execution-policy.test.ts`, `issue-outcome-requirements.test.ts` |
| 13 | Outreach-auto-pause (`auto-pause-logic.ts`, `auto-pause.ts`) | fork-lisäys | `services/outreach/` | Ei upstream-vastinetta: puhdas fork-lisäys, ei päällekkäisyyttä. Ainoa kosketuspinta on service-init `index.ts`:ssä | re-port (vain `index.ts`-liitos) | `outreach-auto-pause-logic.test.ts` |
| 14 | Sähköpostin auto-reply-ohitus omalle reittidomainille | `257417ab` | `heartbeat.ts`, `issues.ts` | Ei upstream-vastinetta: upstreamissa ei ole Resend-sähköpostiintegraatiota (`git log -S 'own route domain'` tyhjä; todentamatta täsmällisellä hakulausekkeella, tarkista portaassa) | re-port | tarkista `fork-tests.txt`:n email-testit |
| 15 | Issue-tunnisteen regex hyväksyy aakkosnumeeriset etuliitteet | `aba28b77` | `issues.ts` | Vastine mahdollinen: `d6bee62f0` (#5196, Cloud tenant issue identifier routes) koskee tunnisteiden reititystä. Regexin sisältö todentamatta | re-port (tarkista `d6bee62f0` ensin) | `doc/upgrade/regression-matrix.md` |
| 16 | Assignee-vartija: 409, kun assignee on `paused` tai `terminated` (`normalizeIssueAssigneeAgentReference`) | `52b99508` | `routes/issues.ts`, `services/agents.ts`, onboarding-assets | Osittainen vastine: `ada47be76` (#10648, agentti ei voi assignoida paused-agentille) ja `71a8464fe` (#7663). Upstream heittää `conflict("Cannot assign work to terminated agents")`, forkin viesti ohjaa "AI"-jäsenelle. Ero: upstream rajaa paused-estoon agentti-aloitteiset assignmentit, fork estää kaikki | redesign (upstream rajaa suppeammin; päätä, tarvitaanko board-käyttäjän estoa) | `issue-assigned-backlog-contract-routes.test.ts` (todentamatta: ei ajettu) |
| 17 | `goalId`-suodatin company issues -listaukseen | `c583f550` | `routes/issues.ts`, `services/issues.ts`, `skills/paperclip/references/api-reference.md` | Ei upstream-vastinetta (`git show v2026.916.1:server/src/services/issues.ts` ei sisällä `filters.goalId`) | re-port | `issues-service.test.ts` (goalId-testit, ajamatta) |

Rivit 14–15 on otettu mukaan, koska ne osuvat samoihin tiedostoihin. Rivit 16–17 lisättiin
RK9-336:ssa: `52b99508` ja `c583f550` puuttuivat taulukosta.

## Muut commitit (ei omaa riviä)

Kaikki `git log d0bdbe11a..HEAD` -commitit näissä tiedostoissa, joita taulukon rivit 1–17 eivät
kata. Päätös on aina **re-port** ja upstream-vastine "ei upstream-vastinetta" (fork-ominaisuus),
ellei toisin mainita. Konflikti näissä tiedostoissa ratkaistaan `// --- RK9 Custom ---`-lohkeen
mukaan.

| Commitit | Aihe | Tiedostot |
|---|---|---|
| `f4ce112a` | RK9 Custom -merkit (ei toiminnallista muutosta) | `heartbeat.ts`, `recovery/service.ts`, `routines.ts`, `issue-execution-policy.ts`, `routes/issues.ts`, `index.ts` |
| `62378995`, `11e4e82e`, `630e30cf` | RK9-228: `ANTHROPIC_API_KEY` ei laskuta kaikkia agentteja | `claude-local/execute.ts` |
| `b6294357`, `55063140`, `7fd9c19d` | claude-local: tool containment, SIGTERM-tulkinta, `--max-turns` | `claude-local/execute.ts` |
| `3941d8c3`, `ec28513d`, `5db305a7`, `e9f2ff5f` | Outreach (RK9-194/195/197/198), service-init | `index.ts`, `config.ts` |
| `455a3b38`, `ae565857`, `a132d1d8` | knowledge-recall: qmd-daemon, prosessiryhmän tappo, henkilökohtaisen vaultin poisto | `services/knowledge-injection.ts`, `index.ts` |
| `051ca3cc` | tailnet-bind-host laiskasti | `config.ts` |
| `9c9fd164` | Slack-liveness-watchdog (RK9-43) | `index.ts`, `config.ts` |
| `91a03d46`, `2c59cb43` | Slack-ilmoitukset ja approval-napit | `index.ts`, `config.ts` |
| `35509fab` | Risk Management | `index.ts` |
| `8b14dce0` | Resend-sähköposti | `index.ts` |
| `63255454`, `3565fb3a` | Merge upstream v2026.427.0; migraatioiden uudelleennumerointi | `index.ts`, `claude-local/execute.ts` |
| `5c3b89ae` | Quota pause -vartijat (rivin 11 alkuperäinen commit) | `routines.ts` |

## Auto-pause-kynnys: 75 vs 90

Issuen alkuperäinen väite "oletus 75" oli väärä: `server/src/config.ts` asettaa oletukseksi 90
(`Math.min(100, Math.max(50, Number(process.env.SYSTEM_PAUSE_THRESHOLD_PCT) || 90))`).
Operaattori päätti 26.9.: **75 asetetaan prodin envissä** (`SYSTEM_PAUSE_THRESHOLD_PCT=75`).
Koodin oletus pysyy 90:ssä. `server/src/__tests__/system-pause-threshold.test.ts` todentaa
konfiguroidun polun (75), oletuksen (90), virheelliset arvot (→ 90) ja rajauksen 50–100.

Rajaus: `evaluateAutoPause` (`server/src/index.ts`) on sisäkkäinen sulkeuma, eikä sitä voi
testata suoraan ilman ajonaikaista refaktorointia, jota tämä issue ei sisällä. Testi kattaa
kynnyksen jäsennyksen. Vertailulogiikka (`maxPct >= threshold`) on todentamatta yksikkötestillä.
Jatkotyö: erota `evaluateAutoPause` puhtaaksi funktioksi, kun `index.ts` on ratkaistu portaassa.

## Portaan käyttöohje

1. Ennen jokaista porrasta aja rivien 1–13 testit: `scripts/upgrade-smoke.sh --offline --fork-tests`.
2. Konfliktissa hae rivi tästä taulukosta. **re-port**: pidä upstreamin rakenne, siirrä forkin
   `// --- RK9 Custom ---` -lohko sen alle. **redesign**: lue upstreamin uusi semantiikka ja
   päätä uudelleen. Älä ota kumpaakaan puolta sokkona.
3. Kun rivi ratkeaa `drop`iksi, kirjaa upstream-commit tähän taulukkoon.

## Verifiointi (2026-09-26)

RK9-308:ssa ajettu `npx vitest run` riveille 1–13: 11 tiedostoa, kaikki läpi
(`system-pause-threshold` 5, `outreach-auto-pause-logic` 11, `heartbeat-idle-timer-skip` 6,
`knowledge-injection` 18, `issue-execution-policy` 45, `recovery-classifiers` 4,
`heartbeat-process-recovery` 32, `issues-checkout-race` 7, `routines-service` 23,
`heartbeat-issue-liveness-escalation` 9, `heartbeat-active-run-output-watchdog` 8).

RK9-336:ssa ajettu lisäksi viisi aiemmin ajamatonta tiedostoa (`npx vitest run` worktreessä):
`instance-settings-routes` 11, `human-proxy` 7, `knowledge-routes` 2,
`issue-agent-mutation-ownership-routes` 13, `issue-outcome-requirements` 11. Yhteensä 44 testiä läpi.

Ajamatta: rivien 16–17 testit (`issue-assigned-backlog-contract-routes`, `issues-service`)
sekä upstream-vastineiden semantiikan vertailu (vain `git log -S`/`git show`).
