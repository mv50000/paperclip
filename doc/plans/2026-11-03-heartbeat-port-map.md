# Heartbeat-siirtokartta: forkin muutokset upstream v2026.1023.0:n moduulijakoon

Tiketti: [RK9-694](/RK9/issues/RK9-694), osa [RK9-675](/RK9/issues/RK9-675)-arvion vaihtoehtoa C
(operaattorin valinta 3.11.2026) ja porrasta 3 ([RK9-701](/RK9/issues/RK9-701)).
Tämä dokumentti on kartta. Se ei muuta ajonaikaista koodia eikä mergeä upstreamia.

## Miksi kartta tarvitaan

Upstream 1023 pilkkoo `server/src/services/heartbeat.ts`:n. Tiedosto kutistuu 5 314 riviin
(`git show v2026.1023.0:server/src/services/heartbeat.ts | wc -l`), kun forkin tiedostossa on 29 478 riviä.
Forkin `heartbeat.ts` poikkeaa merge-basesta (`dffc2b3ca1`) 245 lisätyllä ja 2 poistetulla rivillä,
yhteensä 25 erillistä kohtaa. Tekstimerge ei kanna niitä uusiin moduuleihin. Jokainen kohta kirjoitetaan
uudelleen kohdemoduuliin käsin. Taulukko kertoo minne ja millä testillä siirto todennetaan.

## Menetelmä ja lähteet

- Forkin diff: `git diff dffc2b3ca1 HEAD -- server/src/services/heartbeat.ts`. Rivit ovat HEADin rivejä (`f17dab5f3`).
  Jokainen kohta on merkitty tiedostossa `// --- RK9 Custom ---`-kommentilla: `grep -n "RK9 Custom" server/src/services/heartbeat.ts`.
- Upstream: tagi `v2026.1023.0`, luettu `git show` ja `git grep` -komennoilla. Rivit ovat 1023:n rivejä.
- Aiempi inventaario: `doc/regression/heartbeat-recovery-fork-inventory.md` (RK9-308, RK9-336) kattaa
  päätökset tagiportaille 916.1:een asti. Tämä kartta täydentää sen kohdemoduuleilla.
- Kohdemoduulit 1023:ssa (`server/src/services/heartbeat/`): `queue.ts` (jonon hyväksyntä, claim, resume, `enqueueWakeup`),
  `scheduling.ts` (`tickTimers`), `run-preparation.ts`, `run-lifecycle.ts`, `run-control.ts`, `recovery.ts`.
  `heartbeat.ts` jää ohueksi kokoajaksi (`heartbeatService`, rivi 935), joka antaa riippuvuudet `createHeartbeatQueue(db, dependencies)`:lle
  (`queue.ts:342`).
- "Todentamatta" tarkoittaa, että kohdetta ei ole luettu rivi riviltä 1023:sta. Tarkista se portaassa ennen koodausta.

## Moduulijaon yleiskuva (1023)

| Vastuu | Funktio | 1023-moduuli ja rivi |
|---|---|---|
| Heartbeat-policyn jäsennys | `parseHeartbeatPolicy` | `heartbeat/queue.ts:391` |
| Timer-työn tarkistus | `hasActionableTimerWork` | `heartbeat/queue.ts:572` |
| Claim | `claimQueuedRun` | `heartbeat/queue.ts:936` |
| Claimin jälkeinen tila | `publishRunLifecyclePluginEvent(claimed)`, `setWakeupStatus(..."claimed")` | `heartbeat/queue.ts:1578`, `:1581` |
| Jonon jatko | `resumeQueuedRuns` | `heartbeat/queue.ts:1749` |
| Agentin seuraava ajo | `startNextQueuedRunForAgent` (`availableSlots` rivillä 1920, silmukka 2014) | `heartbeat/queue.ts:1899` |
| Herätteen hyväksyntä | `enqueueWakeup`, `writeSkippedRequest` | `heartbeat/queue.ts:2083`, `:2275` |
| Yrityksen tilatarkistus | `company.status !== "active"` → `company.inactive` | `heartbeat/queue.ts:2359–2372` |
| Timer-ohitus (upstream) | `skipTimerWhenNoActionableWork` | `heartbeat/queue.ts:2585` |
| Issue-rewake-throttle | `evaluateIssueRewakeThrottle`-kutsu | `heartbeat/queue.ts:3830` |
| Ajastimen tick | `tickTimers` | `heartbeat/scheduling.ts:1155` |
| Ajon suoritus | `executeRun` | `heartbeat.ts:1934` (todentamatta: osa siirtyy `run-preparation.ts`:ään ja `runtime-execution.ts`:ään) |

## Siirtokartta

Sarakkeet: nro, forkin muutos (commit ja tiketti), nykyinen funktio ja rivi, 1023-kohdemoduuli ja funktio,
testi joka todentaa siirron, riski. Testisarakkeessa **puuttuu** tarkoittaa, että testi pitää kirjoittaa ennen siirtoa.

### A. System pause

| # | Forkin muutos | Nykyinen rivi (HEAD) | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 1 | `systemPause?: SystemPauseService` ja `maxGlobalConcurrentRunsDefault?: number` `HeartbeatServiceOptions`-rajapintaan (`ccad0d78`, `086fd02f`) | `heartbeat.ts:9189–9194` (importit 619, 79) | `heartbeat.ts:831` `HeartbeatServiceOptions`. `queue.ts` lukee `options` riippuvuutena (`queue.ts:342–351`) | olemassa: `heartbeat-system-pause-db.test.ts` (rajapinta ei kompiloidu ilman). Enqueue-polku on katettu (testi ajaa `wakeup` → `enqueueWakeup`). **Puuttuu** testi reittiinstanssin pausesta `claimQueuedRun`-, `startNextQueuedRunForAgent`- ja `tickTimers`-poluilla (kohdat 5–7), joihin `systemPause` pitää myös välittää | Keskitaso. Korjattu RK9-708: `options` ei kulje `queue.ts`:ään kokonaisena. `HeartbeatQueueDependencies` (`queue.ts:183–187`) välittää vain `options: Pick<HeartbeatServiceOptions, "beforeChatControlRecoveryCheck">`. Laajenna riippuvuustyyppi `systemPause`-kentällä (sama koskee `maxGlobalConcurrentRunsDefault`ia, kohta 12). **Varoitus:** jos kenttä tyypitetään valinnaiseksi eikä sitä välitetä, taukoportti sammuu hiljaa. Tee kentästä pakollinen tai kirjoita testi, joka ajaa reittiinstanssin pause-tilassa `queue.ts`:n kautta |
| 2 | `createReadOnlySystemPause` + 10 s välimuisti, jotta reittien omat `heartbeatService`-instanssit kunnioittavat pausea (`8eab1b4b`, RK9-356; `ebd2def7`, RK9-459) | `heartbeat.ts:9333–9360` | Sama export `heartbeat.ts`:ään tai uusi `heartbeat/system-pause-gate.ts`. Suositus: oma tiedosto, jotta `heartbeat.ts` pysyy ohuena. Jos funktio siirtyy omaan tiedostoon, `heartbeat.ts` re-exporttaa sen: `heartbeat-system-pause-fallback.test.ts` tuo sen `../services/heartbeat.js`:stä | olemassa: `heartbeat-system-pause-fallback.test.ts` (4 testiä, välimuisti ja vanhentunut auto-pause) | Matala. Puhdas funktio ilman `heartbeat.ts`:n sisäistä tilaa. Ilman re-exportia testi kaatuu importtiin, ei hiljaa |
| 3 | Service-initin fallback: `options.systemPause ?? createReadOnlySystemPause(instanceSettings)` (RK9-356) | `heartbeat.ts:9369–9373` | `heartbeat.ts:935` `heartbeatService()` alku. Anna `systemPause` riippuvuutena `createHeartbeatQueue`lle ja `createHeartbeatScheduling`ille (todentamatta: scheduling-factoryn nimi) | olemassa: `heartbeat-system-pause-db.test.ts` ("refuses wakeups from a route-built instance") | Keskitaso. Jos riippuvuus unohtuu yhdestä moduulista, pause ei estä sen polkua hiljaa |
| 4 | Pause-portti `enqueueWakeup`issa: taustalähteet (`timer`, `automation`) ohitetaan hiljaa `system.paused`, muut saavat 409 (`e81a467e`) | `heartbeat.ts:26309–26319` | `queue.ts` `enqueueWakeup` (`:2083`), `writeSkippedRequest`in (`:2275`) määrittelyn jälkeen, ennen `budgets.getInvocationBlock`ia (budjettiportti `:2533`) | olemassa: `heartbeat-system-pause-db.test.ts` (reittiinstanssi, kommentti jää toimittamatta; RK9-708 lukitsee 409-viestin alun `System paused: `) | Keskitaso. Portin järjestys vaikuttaa skipped-syyn kirjaukseen: pidä pause ennen budjettia. **Kytkös:** `isSystemPausedConflict` (`errors.ts:49`) tunnistaa konfliktin viestin alusta `"System paused"`. Sitä käyttävät `recovery/service.ts:4309` ja `routes/issues.ts:17271` (forkin HEAD-rivit), jotka nielevät pause-konfliktin. Viestin alku ei saa muuttua siirrossa; muuten nämä polut alkavat heittää 409:n eteenpäin |
| 5 | Pause-portti `claimQueuedRun`issa: jonossa oleva ajo pysyy jonossa (`ccad0d78`) | `heartbeat.ts:17176–17179` | `queue.ts` `claimQueuedRun` (`:936`), `run.status !== "queued"` -tarkistuksen jälkeen, ennen `getAgent`ia. Huomaa upstreamin Slack-mention-portti heti sen jälkeen (`:942`) | **puuttuu** (olemassa oleva DB-testi kattaa vain enqueue-polun) | Keskitaso. Palautus `null` jättää ajon jonoon; väärä paikka voi aiheuttaa cancelin |
| 6 | Pause-portti `startNextQueuedRunForAgent`issa (`ccad0d78`) | `heartbeat.ts:19582–19585` | `queue.ts` `startNextQueuedRunForAgent` (`:1899`), `withAgentStartLock`in sisällä ennen `getAgent`ia | **puuttuu** | Matala |
| 7 | Pause-portti `tickTimers`issa: palauttaa `{checked:0, enqueued:0, skipped:0}` (`ccad0d78`) | `heartbeat.ts:29329–29332` | `scheduling.ts` `tickTimers` (`:1155`), ennen `getSchedulingSuppression`ia | **puuttuu** | Matala |

### B. Yrityksen pause

Upstream 1023 ohittaa jo kaikki yritykset, joiden `status` ei ole `active`: `enqueueWakeup` (`queue.ts:2359–2372`, syy `company.inactive`),
`tickTimers` (`innerJoin companies ... status = "active"`) ja `resumeQueuedRuns` (`queue.ts:1756`, `:1833`, `:1849`).
Forkin `paused`-tila lienee tämän joukon sisällä. Päätös: **drop** niille kohdille, joille upstreamin portti riittää, ja pidä vain eroavat.
Todentamatta: `claimQueuedRun` ja `startNextQueuedRunForAgent` eivät tarkista yrityksen tilaa 1023:ssa (haku `companies.status` queue.ts:ssä osuu vain rivit 1756–2364).

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 8 | `isCompanyPaused` + 10 s välimuisti (`companyPauseCache`) | `heartbeat.ts:9454–9469` | Ei tarvita, jos kohdat 9–11 hoituvat upstreamin `company.status`-tarkistuksilla. Muuten funktio `queue.ts`:n yläosaan | **puuttuu**. Kirjoita testi: yritys `paused` → `enqueueWakeup` ei luo ajoa | Keskitaso. Eroaa upstreamista: upstream heittää 409 `Company is not active` vain `requestedByActorType === "user"`, fork heittää kaikille paitsi `timer`/`automation` |
| 9 | Yrityksen pause `enqueueWakeup`issa: `company.paused`, 409 muille kuin taustalähteille | `heartbeat.ts:26321–26327` | `queue.ts:2359–2372` (natiivi `company.inactive`) | **puuttuu** | Keskitaso (arvioitu uudelleen RK9-708). Syykoodi muuttuu `company.paused` → `company.inactive`; tarkista dashboardit, jotka suodattavat syytä. Lisäksi käytös muuttuu: natiivi tarkistus heittää 409:n vain, kun `requestedByActorType === "user"` (ks. kohta 8). Agentin ja järjestelmän herätteet saavat 409:n sijaan hiljaisen ohituksen (`null`). Agentti, joka herättää toisen agentin pysäytetyssä yrityksessä, ei enää saa virhettä. Päätä, hyväksytäänkö tämä, vai pidetäänkö forkin 409 muille kuin taustalähteille |
| 10 | Yrityksen pause `claimQueuedRun`issa: `cancelRunInternal("...company is paused")` | `heartbeat.ts:17180–17183` | `queue.ts` `claimQueuedRun` (`:936`) uutena portina, koska upstreamissa ei ole sitä. **Ei** Slack-mention-portin viereen (`:942–961`): sen kommentti (`queue.ts:948`) kieltää `cancelRunInternal`-kutsun agentin käynnistyslukon alla, koska `cancelRunInternal` käynnistää seuraavan ajon ja ottaa saman lukon uudelleen, eikä `withAgentStartLock` ole uudelleenkutsuttava (seuraus: jopa 30 s:n jumi). Vaihtoehdot: (a) portti `getAgent`in jälkeen upstreamin omien `cancelRunInternal`-kutsujen rinnalle (`:969` agentti puuttuu, `:981` ei invokoitavissa, `:998` budjetti), tai (b) Slack-portin malli: `setRunStatus("cancelled")` + `setWakeupStatus("skipped")` + `releaseIssueExecutionAndPromote` ilman `cancelRunInternal`ia. Todentamatta: miksi upstreamin kutsut riveillä 969, 981 ja 998 eivät jumita lukkoa. Selvitä ennen kuin valitset (a):n; (b) on turvallinen | **puuttuu** | Keskitaso. Ajo cancelloidaan, ei jätetä jonoon; säilytä käytös. Väärä paikka voi jumittaa agentin jonon |
| 11 | Yrityksen pause `startNextQueuedRunForAgent`issa ja `tickTimers`issa | `heartbeat.ts:19588–19590`, `:29362–29363` | `queue.ts:1899` (uusi portti) ja `scheduling.ts:1155` (natiivi `companies.status = "active"` -join kattaa) | **puuttuu** | Matala `tickTimers`issa (natiivi kattaa), keskitaso `startNext`issä |

### C. Rinnakkaisuusraja (globaali)

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 12 | `INSTANCE_DEFAULT_MAX_GLOBAL_CONCURRENT_RUNS`-import ja `getGlobalMaxConcurrentRuns()` 10 s välimuistilla, lukee `instanceSettings.getGeneral().maxGlobalConcurrentRuns` (`086fd02f`) | `heartbeat.ts:79`, `:9471–9484` | `queue.ts`:n sisäinen apufunktio `createHeartbeatQueue`n alkuun, `instanceSettings` riippuvuutena. `packages/shared`-vakio ja instanssiasetus pysyvät (todentamatta: 1023 ei muuta niitä). Korjattu RK9-708: 1023:n `HeartbeatQueueDependencies.instanceSettings` on vain `Pick<..., "getExperimental">` (`queue.ts:187`). Laajenna se `getGeneral`illa, ja välitä `maxGlobalConcurrentRunsDefault` (kohta 1) | **puuttuu** (`instance-settings-routes.test.ts` kattaa vain asetusreitin) | Keskitaso. Ilman `getGeneral`ia typecheck kaatuu, mutta jos raja luetaan valinnaisesta kentästä, se putoaa hiljaa oletukseen |
| 13 | `resumeQueuedRuns`: ylärajan tarkistus alussa ja round-robin-järjestys agenttien kesken (`resumeRoundRobinOffset`, `086fd02f`) | `heartbeat.ts:19160–19165`, `:19257–19268` | `queue.ts` `resumeQueuedRuns` (`:1749`): alkuun `activeRunExecutions.size >= globalMax`, loppuun agenttisilmukka. Todentamatta: 1023:n `resumeQueuedRuns` voi käyttää eri silmukkarakennetta kuin 916.1 | **puuttuu**. Testi: 3 agenttia, raja 2, kaksi `resumeQueuedRuns`-kutsua → eri agentit saavat vuoron | Korkea. Round-robin-tila (`resumeRoundRobinOffset`) on service-instanssin sulkeuma, ja `queue.ts` omistaa nyt silmukan |
| 14 | `startNextQueuedRunForAgent`: `effectiveSlots = min(availableSlots, globalAvailable)` | `heartbeat.ts:19610–19614`, `:19704–19706` | `queue.ts:1920` (`availableSlots`) ja `:2014` (`claimedRuns.length >= availableSlots`) | **puuttuu** | Korkea. Kaksi kohtaa samassa funktiossa; jos vain toinen siirtyy, raja ei päde |
| 15 | Julkiset `getGlobalRunningCount` ja `getGlobalMaxConcurrentRuns` | `heartbeat.ts:29285–29287` | `heartbeat.ts:5290` palautusolio (`tickTimers` on siellä jo); `getGlobalRunningCount` = `activeRunExecutions.size` (`heartbeat.ts:626`). Kuluttaja: `routes/instance-settings.ts:436–437` | **puuttuu** (`instance-settings-routes.test.ts` mockaa luvut, todentamatta) | Matala. Tyyppivirhe kertoo, jos jäsen puuttuu |

### D. Idle-skip

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 16 | `skipWhenIdle`-kenttä heartbeat-policyyn, oletus `true` (`ead6c2b9`, #76) | `heartbeat.ts:16594–16600` | `queue.ts:391` `parseHeartbeatPolicy`. Upstreamin vastine `skipTimerWhenNoActionableWork` (`queue.ts:404`), oletus `false`, ei UI-kytkintä. Ks. `doc/upgrade/defaults-hardening.md:171–172` | olemassa: `heartbeat-idle-timer-skip.test.ts` ("does not gate timer wakes when skipWhenIdle is false") | Keskitaso. Päätös tehtävä: ota upstreamin kenttä ja kytke oletus `true`, tai pidä `skipWhenIdle` rinnalla. Suositus: yksi kenttä (upstreamin), forkin oletus asetuksena |
| 17 | `agentHasPendingTimerWork`: routine-ajot lasketaan työksi, `blocked` lasketaan vain jos blokkerit ratkenneet ja ne on kirjattu (RK9-231, `672d71a9`) | `heartbeat.ts:16332–16367` | `queue.ts:572` `hasActionableTimerWork`, laajenna. Upstream laskee vain `TIMER_ACTIONABLE_ISSUE_STATUSES` (`todo`, `in_progress`), joten `blocked` ja routine-ajot putoavat pois ja forkin semantiikka on laajempi | olemassa: `heartbeat-idle-timer-skip.test.ts` (6 testiä: tyhjä, aktiivinen issue, käsin blokattu, avoin blokkeri, ratkennut blokkeri, lippu pois) | Keskitaso. Upstreamin ehto `nonIdleSlackIssueCondition()` ja `conversationAgentId` -rajaus lisää suodattimia, joita forkin versio ei tunne; ota ne mukaan. Korjattu RK9-708: forkin funktio kutsuu `issuesSvc.list` (HEAD `heartbeat.ts:16350`) ja `issuesSvc.listDependencyReadiness`, mutta 1023:n `HeartbeatQueueDependencies.issuesSvc` (`queue.ts:184`) on vain `getDependencyReadiness` ja `listDependencyReadiness`, ilman `list`-metodia. Laajenna riippuvuustyyppiä `list`-metodilla tai korvaa haku suoralla kyselyllä |
| 18 | Idle-ohituksen kutsu `enqueueWakeup`issa: `source === "timer" && policy.skipWhenIdle && !issueId`, päivittää `lastHeartbeatAt`, kirjaa `heartbeat.idle` | `heartbeat.ts:26373–26386` | `queue.ts:2585–2596`: sama paikka kuin upstreamin `skipTimerWhenNoActionableWork`. Upstream käyttää apuna `markTimerHeartbeatChecked` (`queue.ts:~590`) ja syytä `heartbeat.timer.no_actionable_work` | olemassa: `heartbeat-idle-timer-skip.test.ts` (kirjattu syy ja `lastHeartbeatAt`) | Keskitaso. Syykoodi vaihtuu (`heartbeat.idle` → `heartbeat.timer.no_actionable_work`); päivitä testin odotus ja mahdolliset dashboard-suodattimet |

### E. Recall-injektio

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 19 | `buildKnowledgeContext`-kutsu ajon kontekstiin: `paperclipKnowledgeContext`, kill-switch `knowledgeRecallInjectionEnabled` + agenttikohtainen portti, ei koskaan estä heartbeatia (`9394a2f3`, RK9-18) | `heartbeat.ts:20723–20742` (import `:468`) | Korjattu RK9-708: 1023:n `heartbeat.ts` `executeRun` (`:1934`), redaktiolohkon jälkeen (noin rivi 2986, `redactedWakeContext`-kopioinnin perään, ennen `if (issueRef)`-haaraa). Ei rivi 2741 eikä `run-preparation.ts` (`paperclipKnowledgeContext` ei esiinny 1023:ssa) | osittain olemassa: `services/knowledge-injection.test.ts` (18 testiä, vain `buildKnowledgeContext`). **Puuttuu** integraatiotesti, joka todentaa että konteksti päätyy adapterin `context`-olioon ja että virhe ei kaada ajoa | Korkea. Siirto hiljaa pois päältä -riski: kutsu putoaa pois, eikä mikään testi huomaa |

### F. Human proxy

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 20 | `isHumanProxyAgent`-ohitus `enqueueWakeup`issa: `agent.human_proxy` (`ca1d6384`, SEC-100) | `heartbeat.ts:26200–26204` (import `:534`) | `queue.ts` `enqueueWakeup` (`:2083`), `writeSkippedRequest`in jälkeen, ennen yritys- ja budjettiporttia. Upstream ei tunne `human_proxy`-adapteria (`git grep human_proxy v2026.1023.0` tyhjä, todentamatta täsmällisemmällä haulla) | osittain: `human-proxy.test.ts` (adapteri ja tyyppivartija). **Puuttuu** testi, joka todentaa `enqueueWakeup`in ohituksen | Keskitaso |
| 21 | `isHumanProxyAgent`-ohitus `tickTimers`issa | `heartbeat.ts:29355–29356` | `scheduling.ts:1155`, `invokability`-tarkistuksen edelle | **puuttuu** | Matala |

### G. Taint-hook

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 22 | `markRunIfTaintingContext(db, claimed)` ennen adapterin käynnistystä: sähköpostiherätteen, sähköpostia sisältävän issuen ja tainted-ajon herättämä ajo merkitään tainted. Ei koskaan heitä (`a4244df0`, RK9-319) | `heartbeat.ts:17700–17704` (import `:167`) | `queue.ts` `claimQueuedRun`, claimin jälkeen heti `publishRunLifecyclePluginEvent(claimed)`:n perään (`queue.ts:1578`), ennen `setWakeupStatus(...,"claimed")` (`:1581`). Huomaa uusi `nativeReviewContext`-haara `:1580`: taint pitää ajaa myös sille | olemassa (RK9-708): `rk9-run-taint-claim-path.test.ts` ajaa jonossa olevan ajon `resumeQueuedRuns` → `claimQueuedRun` → mock-adapteri -polun ja tarkistaa, että ajo on merkitty tainted jo adapterin käynnistyessä. Testi kaatuu, jos hook-kutsu poistetaan (mutaatiotarkistus tehty 3.11.2026). Siirrä sama testi 1023:n `queue.ts`:n claim-polulle muuttamatta. Forkissa ei ole `nativeReviewContext`-haaraa, joten 1023-portaassa lisää testiin tapaus, jossa ajolla on native review -konteksti. Hook kuuluu `if (!nativeReviewContext)`-lohkon **ulkopuolelle**. `rk9-run-taint-e2e.test.ts` kutsuu `markRunIfTaintingContext`ia suoraan (rivi 189), joten se **ei** todista claim-polkua | Korkea. Turvaominaisuus: jos hook jää pois, ulos lähtevät viestit eivät pysähdy hyväksyntään. Siirron jälkeen aja e2e-testi ja tarkista, että se ajaa oikean claim-polun, ei mockia. Kuuluu herkkään diffiin (verifier ennen mergeä) |

### H. Coord inbox ja rewake-throttle

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 23 | Coord inbox -viesti ei osta heartbeat-ajoa: SQL-ehto `activityLog.details @> ISSUE_REWAKE_COORD_INBOX_DETAILS` rewake-throttlen "uusi syöte" -kyselyssä (RK9-676, `9c6745e2`) | `heartbeat.ts:27558–27561` (import `:353`) | `queue.ts:~3815–3828`, sama kysely ennen `evaluateIssueRewakeThrottle`-kutsua (`:3830`). `issue-rewake-throttle.ts` on erillinen tiedosto jo nyt, joten vakio siirtyy mukana | olemassa: `heartbeat-issue-rewake-throttle.test.ts` ("keeps the throttle after a coord inbox comment but lifts it for an ordinary board comment", rivi 252) ja `issue-rewake-throttle.test.ts` | Matala–keskitaso. Todentamatta: upstreamin kyselyssä on uusi `origin <> 'fast_response'` -ehto; lisää forkin ehto sen perään |

### I. Rakenteelliset kohdat (ei omaa toimintoa)

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 24 | `// --- RK9 Custom ---` -tuontilohkot: `INSTANCE_DEFAULT_MAX_GLOBAL_CONCURRENT_RUNS`, `markRunIfTaintingContext`, `ISSUE_REWAKE_COORD_INBOX_DETAILS`, `buildKnowledgeContext`, `isHumanProxyAgent`, `SystemPauseService` | `heartbeat.ts:79`, `:167–169`, `:353`, `:468`, `:534`, `:619` | Jokainen tuonti siirtyy sen moduulin yläosaan, jossa kohta 1–23 elää | `pnpm -r typecheck` (ei erillistä testiä) | Matala |
| 25 | RK9 Custom -merkit itse (`f4ce112a`, RK9-304) | koko tiedosto | Säilytä merkit uusissa moduuleissa. Silloin `grep -rn "RK9 Custom" server/src/services/heartbeat/` toimii siirron tarkistuksena | tarkistus komennolla (alla) | Matala |

## Kattavuus

- Kohdat 1–25 kattavat `heartbeat.ts`:n forkin diffin: `grep -c "RK9 Custom" server/src/services/heartbeat.ts` antaa 31 osumaa, koska osa lohkoista avataan ja suljetaan erillisillä kommenteilla. Yksi osuma (`:27560`, RK9-676) käyttää kirjoitusasua `RK9 Custom (RK9-676)` ilman `---`-merkkiä.
- Olemassa olevalla testillä katetut kohdat: 1, 2, 3, 4, 16, 17, 18, 22, 23. Kohta 22 on katettu vasta RK9-708:n claim-polkutestillä; e2e-testi yksin ei riitä.
- Riippuvuustyyppi (RK9-708): kohdat 1, 3, 12 ja 17 vaativat, että 1023:n `HeartbeatQueueDependencies` laajenee (`options.systemPause`, `instanceSettings.getGeneral`, `issuesSvc`-metodit). Kohta 1 on katettu vain enqueue-polulla. Kirjoita portaassa testi, joka todentaa `systemPause`n välityksen myös claim-, startNext- ja scheduling-poluille (kohdat 5–7).
- Uusi testi tarvitaan ennen siirtoa kohdille 5–15, 19 (integraatio), 20 ja 21. Yrityksen pause (8–11) riippuu päätöksestä, tarvitaanko oma portti.
- Todentamatta 1023:ssa: kohtien 1, 8, 10, 11, 13, 19 ja 20 tarkka kohdefunktio tai käytös. Tarkista ne `git show v2026.1023.0:<tiedosto>` -komennolla portaan alussa.

### Tarkistuskomennot portaassa (RK9-701)

```sh
# 1. Forkin merkit kartalla vs. HEAD
grep -c "RK9 Custom" server/src/services/heartbeat.ts
# 2. Merkit uusissa moduuleissa siirron jälkeen
grep -rn "RK9 Custom" server/src/services/heartbeat/ server/src/services/heartbeat.ts | wc -l
# 3. Olemassa olevat testit (rivit 1–4, 16–18, 22, 23)
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-system-pause-db.test.ts \
  src/__tests__/heartbeat-system-pause-fallback.test.ts \
  src/__tests__/heartbeat-idle-timer-skip.test.ts \
  src/__tests__/heartbeat-issue-rewake-throttle.test.ts \
  src/__tests__/issue-rewake-throttle.test.ts \
  src/__tests__/rk9-run-taint-e2e.test.ts \
  src/__tests__/rk9-run-taint-claim-path.test.ts \
  src/__tests__/rk9-run-taint-tool-gate.test.ts \
  src/__tests__/human-proxy.test.ts \
  src/services/knowledge-injection.test.ts
```

## Suositeltu järjestys portaassa 3

1. **Kirjoita puuttuvat testit ensin** (kohdat 5–15, 19–21) vasten nykyistä forkin `heartbeat.ts`:ää. Testit ovat kuvaus nykykäytöksestä; ne ajetaan uudelleen siirron jälkeen.
2. **Siirrä pienet portit**: system pause (A), human proxy (F), coord-ehto (H). Ne ovat itsenäisiä riviä.
3. **Siirrä idle-skip** (D) yhtenä päätöksenä: yksi policy-kenttä, yksi syykoodi.
4. **Siirrä globaali raja** (C) kokonaisena: kohdat 12–15 yhdessä, koska round-robin-tila ja `effectiveSlots` jakavat saman laskurin.
5. **Siirrä taint-hook ja recall-injektio** (G, E) viimeisenä ja erillisessä commitissa. Ne ovat riskialtteimmat, koska virhe on hiljainen.
6. **Päätä yrityksen pause** (B) vasta kun upstreamin `company.status !== "active"` -kattavuus on todennettu `claimQueuedRun`issa.

## Rajaus

- Kartta kattaa `heartbeat.ts`:n. Muut heartbeat-polun fork-tiedostot (`recovery/service.ts`, `routines.ts`, `issue-execution-policy.ts`, `knowledge-injection.ts`, `system-pause.ts`) ovat jo omissa tiedostoissaan; niiden päätökset ovat `doc/regression/heartbeat-recovery-fork-inventory.md`:ssä. Korjattu RK9-708: `recovery/service.ts` on yhä olemassa 1023:ssa samalla polulla. `heartbeat/recovery.ts` on eri jako (heartbeatin oma recovery-moduuli), ei sen vastine.
- Kartta ei todista, että 1023:n käytös vastaa forkin käytöstä. Se osoittaa paikan ja testin. Käytöksen vertailu tehdään portaassa.

## Liite: heartbeatin ulkopuoliset siirrot (RK9-708)

- **`createReadOnlySystemPause`** (kohta 2): jos funktio siirtyy pois `heartbeat.ts`:stä, lisää re-export. `heartbeat-system-pause-fallback.test.ts` tuo sen `heartbeat.js`:stä.
- **CEO-pinni, `agent-permissions.ts`** (RK9-309, RK9-317): 1023 siirsi tiedoston `server/src/services/agent-permissions.ts` polkuun `server/src/lib/agent-permissions.ts` (`git ls-tree -r --name-only v2026.1023.0 server/src | grep agent-permissions`). Forkin pinni on `services/agent-permissions.ts:42–56` (`canCreateAgents` vain CEO-roolille, `&& isCeoRole(...)`). Tekstimerge ei välttämättä kanna sitä uuteen polkuun. Siirrä pinni käsin `lib/agent-permissions.ts`:ään ja aja `agent-permissions-service.test.ts` sekä `agent-permissions-routes.test.ts`.
- **`System paused` -viesti** (kohta 4): `errors.ts:49` `isSystemPausedConflict` on sopimus heartbeatin, `recovery/service.ts`:n ja `routes/issues.ts`:n välillä. `heartbeat-system-pause-db.test.ts` lukitsee viestin alun.
