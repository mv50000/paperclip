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
- Upstream-commit-SHA:ta ei ole tunnistettu yhdellekään riville. Päätökset perustuvat siihen,
  mitä tagin `v2026.916.1` koodi sisältää (`git grep`). Tunnistus commit-tasolla on todentamatta;
  tee se portaan harjoitusmergessä (`git log -S<tunniste> d0bdbe11a..<tagi>`).
- Tiedostot `routines.ts` ja `issue-execution-policy.ts` eivät sisällä RK9-tunnisteella
  merkittyjä committeja. Forkin muutokset niissä ovat tunnisteettomia (`ccad0d78`, `a2949a3c`,
  `2059926c` tai `ca1d6384`), joten ne on listattu commitin, ei tiketin mukaan.

## Päätökset

Päätökset: **drop** (upstream korjasi jo), **re-port** (sovita uuteen koodiin), **redesign**
(uusi semantiikka on ristiriidassa, päätä uudelleen).

| # | Korjaus | Fork-commit | Tiedostot | Upstream `v2026.916.1` | Päätös | Regressiotesti (vihreä ennen mergeä) |
|---|---|---|---|---|---|---|
| 1 | RK9-231: käsin `blocked`-tilaan asetettu issue ei ole odottavaa timer-työtä | `672d71a9` | `heartbeat.ts` | Ei vastinetta: upstream-`heartbeat.ts` (29 235 riviä) ei sisällä timer-esitarkistusta | re-port | `heartbeat-idle-timer-skip.test.ts` |
| 2 | Idle timer -ajojen ohitus ja vuoro-budjetin kertominen agentille (#76) | `ead6c2b9` | `heartbeat.ts`, `claude-local/execute.ts` | Ei vastinetta | re-port | `heartbeat-idle-timer-skip.test.ts` |
| 3 | RK9-87: ei uutta continuationia jo onnistuneelle in_progress-ajolle | `b05d1c1f` | `recovery/service.ts` | Upstream on kirjoittanut recoveryn natiiviajojen ympärille (`latestRun?.status === "succeeded"` -haarat, `nativeBlockedUnblockAction`, `recovery/service.ts` 5 913 riviä). Vastaavuus todentamatta | redesign | `heartbeat-process-recovery.test.ts` (päätös `skipped_latest_run_succeeded`) |
| 4 | RK9-5 vaihe 1: `strictInProgressOnly` + päätösloki per ehdokas | `47e7fe24` | `recovery/service.ts`, `instance-settings` | Ei vastinetta (`git grep strictInProgressOnly` on tyhjä) | re-port | `heartbeat-process-recovery.test.ts` (`skipped_strict_in_progress_only`), `instance-settings-routes.test.ts` |
| 5 | Recovery ohittaa agentit, joilla heartbeat pois päältä tai jotka ovat `human_proxy` | `7d4a8196`, `ca1d6384` | `recovery/service.ts`, `routines.ts`, `heartbeat.ts` | Ei vastinetta (`human_proxy` puuttuu) | re-port | `human-proxy.test.ts`, `heartbeat-process-recovery.test.ts` (`skipped_agent_not_invokable`) |
| 6 | RK9-76: tuntematon `actorRunId` ei kaada checkoutia, status-päivitystä tai kommenttia (500) | `e1ae4898` | `routes/issues.ts`, `services/issues.ts` | Upstream lukee `actorRunId`:n `heartbeatRuns`-taulusta (`issues.ts` rivit 418–425) ja käyttää `sameRunLock`ia. Ei vahvistettua FK-suojausta | redesign | `issues-checkout-race.test.ts`, `issue-agent-mutation-ownership-routes.test.ts` |
| 7 | RK9-18 (C6): knowledge-recall-injektio heartbeat-promptiin, kill-switch + per-agent-portti | `9394a2f3` | `heartbeat.ts`, `knowledge-injection.ts` | Ei vastinetta (`git grep -i recall` osuu vain muihin ominaisuuksiin) | re-port | `services/knowledge-injection.test.ts`, `knowledge-routes.test.ts` |
| 8 | System pause (globaali kiintiövartija) + hiljainen ohitus taustalähteille | `ccad0d78`, `e81a467e` | `heartbeat.ts`, `routines.ts`, `index.ts`, `config.ts`, `services/system-pause.ts` | Ei vastinetta (`git grep -i systemPause` on tyhjä) | re-port | `system-pause-threshold.test.ts` (uusi), `routines-service.test.ts` (`System paused`) |
| 9 | Auto-pause-monitori: `evaluateAutoPause`, `SYSTEM_PAUSE_THRESHOLD_PCT` | `ccad0d78` | `index.ts`, `config.ts` | Ei vastinetta | re-port | `system-pause-threshold.test.ts` (uusi) |
| 10 | Globaali samanaikaisuusraja heartbeat-ajoille | `086fd02f` | `heartbeat.ts`, `instance-settings` | Ei vastinetta | re-port | `instance-settings-routes.test.ts` |
| 11 | Quota pause -vartijat routineille | `a2949a3c` | `routines.ts`, `ui/src/pages/Routines.tsx` | Ei vastinetta | re-port | `routines-service.test.ts` |
| 12 | Enforced outcome requirements ennen `done` (SEC-91) | `2059926c` | `issue-execution-policy.ts`, `routes/issues.ts`, shared | Ei vastinetta (`git grep outcome_requirement` on tyhjä) | re-port | `issue-execution-policy.test.ts`, `issue-outcome-requirements.test.ts` |
| 13 | Outreach-auto-pause (`auto-pause-logic.ts`, `auto-pause.ts`) | fork-lisäys | `services/outreach/` | Puhdas fork-lisäys, ei päällekkäisyyttä. Ainoa kosketuspinta on service-init `index.ts`:ssä | re-port (vain `index.ts`-liitos) | `outreach-auto-pause-logic.test.ts` |
| 14 | Sähköpostin auto-reply-ohitus omalle reittidomainille | `257417ab` | `heartbeat.ts`, `issues.ts` | Ei tutkittu tässä rajauksessa | re-port | tarkista `fork-tests.txt`:n email-testit |
| 15 | Issue-tunnisteen regex hyväksyy aakkosnumeeriset etuliitteet | `aba28b77` | `issues.ts` | Ei tutkittu tässä rajauksessa | re-port | `doc/upgrade/regression-matrix.md` |

Rivit 14–15 on otettu mukaan, koska ne osuvat samoihin tiedostoihin. Niiden upstream-vertailu
tehdään portaassa.

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

## Verifiointi (2026-09-26, worktree RK9-308)

Ajettu `npx vitest run` kaikille taulukon riveille: 11 tiedostoa, kaikki läpi
(`system-pause-threshold` 5, `outreach-auto-pause-logic` 11, `heartbeat-idle-timer-skip` 6,
`knowledge-injection` 18, `issue-execution-policy` 45, `recovery-classifiers` 4,
`heartbeat-process-recovery` 32, `issues-checkout-race` 7, `routines-service` 23,
`heartbeat-issue-liveness-escalation` 9, `heartbeat-active-run-output-watchdog` 8).
Ajamatta tässä: `instance-settings-routes`, `human-proxy`, `knowledge-routes`,
`issue-agent-mutation-ownership-routes`, `issue-outcome-requirements`.
