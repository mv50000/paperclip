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
| 1 | `systemPause?: SystemPauseService` ja `maxGlobalConcurrentRunsDefault?: number` `HeartbeatServiceOptions`-rajapintaan (`ccad0d78`, `086fd02f`) | `heartbeat.ts:9189–9194` (importit 619, 79) | `heartbeat.ts:831` `HeartbeatServiceOptions`. `queue.ts` lukee `options` riippuvuutena (`queue.ts:342–351`) | olemassa: `heartbeat-system-pause-db.test.ts` (rajapinta ei kompiloidu ilman) | Matala. Tyyppi kulkee `options`-olion läpi. Todentamatta: `HeartbeatQueueDependencies` vaatii `systemPause`n erikseen, jos `queue.ts` ei lue `options`-oliota kaikkialla |
| 2 | `createReadOnlySystemPause` + 10 s välimuisti, jotta reittien omat `heartbeatService`-instanssit kunnioittavat pausea (`8eab1b4b`, RK9-356; `ebd2def7`, RK9-459) | `heartbeat.ts:9333–9360` | Sama export `heartbeat.ts`:ään tai uusi `heartbeat/system-pause-gate.ts`. Suositus: oma tiedosto, jotta `heartbeat.ts` pysyy ohuena | olemassa: `heartbeat-system-pause-fallback.test.ts` (4 testiä, välimuisti ja vanhentunut auto-pause) | Matala. Puhdas funktio ilman `heartbeat.ts`:n sisäistä tilaa |
| 3 | Service-initin fallback: `options.systemPause ?? createReadOnlySystemPause(instanceSettings)` (RK9-356) | `heartbeat.ts:9369–9373` | `heartbeat.ts:935` `heartbeatService()` alku. Anna `systemPause` riippuvuutena `createHeartbeatQueue`lle ja `createHeartbeatScheduling`ille (todentamatta: scheduling-factoryn nimi) | olemassa: `heartbeat-system-pause-db.test.ts` ("refuses wakeups from a route-built instance") | Keskitaso. Jos riippuvuus unohtuu yhdestä moduulista, pause ei estä sen polkua hiljaa |
| 4 | Pause-portti `enqueueWakeup`issa: taustalähteet (`timer`, `automation`) ohitetaan hiljaa `system.paused`, muut saavat 409 (`e81a467e`) | `heartbeat.ts:26309–26319` | `queue.ts` `enqueueWakeup` (`:2083`), `writeSkippedRequest`in (`:2275`) määrittelyn jälkeen, ennen `budgets.getInvocationBlock`ia (budjettiportti `:2542`) | olemassa: `heartbeat-system-pause-db.test.ts` (reittiinstanssi, kommentti jää toimittamatta) | Keskitaso. Portin järjestys vaikuttaa skipped-syyn kirjaukseen: pidä pause ennen budjettia |
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
| 9 | Yrityksen pause `enqueueWakeup`issa: `company.paused`, 409 muille kuin taustalähteille | `heartbeat.ts:26321–26327` | `queue.ts:2359–2372` (natiivi `company.inactive`) | **puuttuu** | Matala. Syykoodi muuttuu `company.paused` → `company.inactive`; tarkista dashboardit, jotka suodattavat syytä |
| 10 | Yrityksen pause `claimQueuedRun`issa: `cancelRunInternal("...company is paused")` | `heartbeat.ts:17180–17183` | `queue.ts` `claimQueuedRun` (`:936`) uutena portina, koska upstreamissa ei ole sitä (todentamatta) | **puuttuu** | Keskitaso. Ajo cancelloidaan, ei jätetä jonoon; säilytä käytös |
| 11 | Yrityksen pause `startNextQueuedRunForAgent`issa ja `tickTimers`issa | `heartbeat.ts:19588–19590`, `:29362–29363` | `queue.ts:1899` (uusi portti) ja `scheduling.ts:1155` (natiivi `companies.status = "active"` -join kattaa) | **puuttuu** | Matala `tickTimers`issa (natiivi kattaa), keskitaso `startNext`issä |

### C. Rinnakkaisuusraja (globaali)

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 12 | `INSTANCE_DEFAULT_MAX_GLOBAL_CONCURRENT_RUNS`-import ja `getGlobalMaxConcurrentRuns()` 10 s välimuistilla, lukee `instanceSettings.getGeneral().maxGlobalConcurrentRuns` (`086fd02f`) | `heartbeat.ts:79`, `:9471–9484` | `queue.ts`:n sisäinen apufunktio `createHeartbeatQueue`n alkuun, `instanceSettings` riippuvuutena. `packages/shared`-vakio ja instanssiasetus pysyvät (todentamatta: 1023 ei muuta niitä) | **puuttuu** (`instance-settings-routes.test.ts` kattaa vain asetusreitin) | Keskitaso |
| 13 | `resumeQueuedRuns`: ylärajan tarkistus alussa ja round-robin-järjestys agenttien kesken (`resumeRoundRobinOffset`, `086fd02f`) | `heartbeat.ts:19160–19165`, `:19257–19268` | `queue.ts` `resumeQueuedRuns` (`:1749`): alkuun `activeRunExecutions.size >= globalMax`, loppuun agenttisilmukka. Todentamatta: 1023:n `resumeQueuedRuns` voi käyttää eri silmukkarakennetta kuin 916.1 | **puuttuu**. Testi: 3 agenttia, raja 2, kaksi `resumeQueuedRuns`-kutsua → eri agentit saavat vuoron | Korkea. Round-robin-tila (`resumeRoundRobinOffset`) on service-instanssin sulkeuma, ja `queue.ts` omistaa nyt silmukan |
| 14 | `startNextQueuedRunForAgent`: `effectiveSlots = min(availableSlots, globalAvailable)` | `heartbeat.ts:19610–19614`, `:19704–19706` | `queue.ts:1920` (`availableSlots`) ja `:2014` (`claimedRuns.length >= availableSlots`) | **puuttuu** | Korkea. Kaksi kohtaa samassa funktiossa; jos vain toinen siirtyy, raja ei päde |
| 15 | Julkiset `getGlobalRunningCount` ja `getGlobalMaxConcurrentRuns` | `heartbeat.ts:29285–29287` | `heartbeat.ts:5290` palautusolio (`tickTimers` on siellä jo); `getGlobalRunningCount` = `activeRunExecutions.size` (`heartbeat.ts:626`). Kuluttaja: `routes/instance-settings.ts:436–437` | **puuttuu** (`instance-settings-routes.test.ts` mockaa luvut, todentamatta) | Matala. Tyyppivirhe kertoo, jos jäsen puuttuu |

### D. Idle-skip

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 16 | `skipWhenIdle`-kenttä heartbeat-policyyn, oletus `true` (`ead6c2b9`, #76) | `heartbeat.ts:16594–16600` | `queue.ts:391` `parseHeartbeatPolicy`. Upstreamin vastine `skipTimerWhenNoActionableWork` (`queue.ts:404`), oletus `false`, ei UI-kytkintä. Ks. `doc/upgrade/defaults-hardening.md:171–172` | olemassa: `heartbeat-idle-timer-skip.test.ts` ("does not gate timer wakes when skipWhenIdle is false") | Keskitaso. Päätös tehtävä: ota upstreamin kenttä ja kytke oletus `true`, tai pidä `skipWhenIdle` rinnalla. Suositus: yksi kenttä (upstreamin), forkin oletus asetuksena |
| 17 | `agentHasPendingTimerWork`: routine-ajot lasketaan työksi, `blocked` lasketaan vain jos blokkerit ratkenneet ja ne on kirjattu (RK9-231, `672d71a9`) | `heartbeat.ts:16332–16367` | `queue.ts:572` `hasActionableTimerWork`, laajenna. Upstream laskee vain `TIMER_ACTIONABLE_ISSUE_STATUSES` (`todo`, `in_progress`), joten `blocked` ja routine-ajot putoavat pois ja forkin semantiikka on laajempi | olemassa: `heartbeat-idle-timer-skip.test.ts` (6 testiä: tyhjä, aktiivinen issue, käsin blokattu, avoin blokkeri, ratkennut blokkeri, lippu pois) | Keskitaso. Upstreamin ehto `nonIdleSlackIssueCondition()` ja `conversationAgentId` -rajaus lisää suodattimia, joita forkin versio ei tunne; ota ne mukaan |
| 18 | Idle-ohituksen kutsu `enqueueWakeup`issa: `source === "timer" && policy.skipWhenIdle && !issueId`, päivittää `lastHeartbeatAt`, kirjaa `heartbeat.idle` | `heartbeat.ts:26373–26386` | `queue.ts:2585–2596`: sama paikka kuin upstreamin `skipTimerWhenNoActionableWork`. Upstream käyttää apuna `markTimerHeartbeatChecked` (`queue.ts:~590`) ja syytä `heartbeat.timer.no_actionable_work` | olemassa: `heartbeat-idle-timer-skip.test.ts` (kirjattu syy ja `lastHeartbeatAt`) | Keskitaso. Syykoodi vaihtuu (`heartbeat.idle` → `heartbeat.timer.no_actionable_work`); päivitä testin odotus ja mahdolliset dashboard-suodattimet |

### E. Recall-injektio

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 19 | `buildKnowledgeContext`-kutsu ajon kontekstiin: `paperclipKnowledgeContext`, kill-switch `knowledgeRecallInjectionEnabled` + agenttikohtainen portti, ei koskaan estä heartbeatia (`9394a2f3`, RK9-18) | `heartbeat.ts:20723–20742` (import `:468`) | `executeRun` (`heartbeat.ts:1934`), kontekstin muokkauskohta `heartbeat.ts:2741` (`delete context.paperclipSkillTest`) tai `run-preparation.ts`. Todentamatta: tarkka funktio, koska 1023 jakaa `executeRun`in `run-preparation.ts`:n ja `runtime-execution.ts`:n kesken (`paperclipKnowledgeContext` ei esiinny 1023:ssa) | osittain olemassa: `services/knowledge-injection.test.ts` (18 testiä, vain `buildKnowledgeContext`). **Puuttuu** integraatiotesti, joka todentaa että konteksti päätyy adapterin `context`-olioon ja että virhe ei kaada ajoa | Korkea. Siirto hiljaa pois päältä -riski: kutsu putoaa pois, eikä mikään testi huomaa |

### F. Human proxy

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 20 | `isHumanProxyAgent`-ohitus `enqueueWakeup`issa: `agent.human_proxy` (`ca1d6384`, SEC-100) | `heartbeat.ts:26200–26204` (import `:534`) | `queue.ts` `enqueueWakeup` (`:2083`), `writeSkippedRequest`in jälkeen, ennen yritys- ja budjettiporttia. Upstream ei tunne `human_proxy`-adapteria (`git grep human_proxy v2026.1023.0` tyhjä, todentamatta täsmällisemmällä haulla) | osittain: `human-proxy.test.ts` (adapteri ja tyyppivartija). **Puuttuu** testi, joka todentaa `enqueueWakeup`in ohituksen | Keskitaso |
| 21 | `isHumanProxyAgent`-ohitus `tickTimers`issa | `heartbeat.ts:29355–29356` | `scheduling.ts:1155`, `invokability`-tarkistuksen edelle | **puuttuu** | Matala |

### G. Taint-hook

| # | Forkin muutos | Nykyinen rivi | 1023-kohde | Testi | Riski |
|---|---|---|---|---|---|
| 22 | `markRunIfTaintingContext(db, claimed)` ennen adapterin käynnistystä: sähköpostiherätteen, sähköpostia sisältävän issuen ja tainted-ajon herättämä ajo merkitään tainted. Ei koskaan heitä (`a4244df0`, RK9-319) | `heartbeat.ts:17700–17704` (import `:167`) | `queue.ts` `claimQueuedRun`, claimin jälkeen heti `publishRunLifecyclePluginEvent(claimed)`:n perään (`queue.ts:1578`), ennen `setWakeupStatus(...,"claimed")` (`:1581`). Huomaa uusi `nativeReviewContext`-haara `:1580`: taint pitää ajaa myös sille | olemassa: `rk9-run-taint-e2e.test.ts` (T1 sähköpostiheräte, T3 laiska portti, ketjutettu heräte) ja `rk9-run-taint-tool-gate.test.ts` | Korkea. Turvaominaisuus: jos hook jää pois, ulos lähtevät viestit eivät pysähdy hyväksyntään. Siirron jälkeen aja e2e-testi ja tarkista, että se ajaa oikean claim-polun, ei mockia. Kuuluu herkkään diffiin (verifier ennen mergeä) |

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
- Olemassa olevalla testillä katetut kohdat: 1, 2, 3, 4, 16, 17, 18, 22, 23.
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

- Kartta kattaa `heartbeat.ts`:n. Muut heartbeat-polun fork-tiedostot (`recovery/service.ts`, `routines.ts`, `issue-execution-policy.ts`, `knowledge-injection.ts`, `system-pause.ts`) ovat jo omissa tiedostoissaan; niiden päätökset ovat `doc/regression/heartbeat-recovery-fork-inventory.md`:ssä. `recovery/service.ts` vastaa 1023:ssa kohdetta `heartbeat/recovery.ts` (todentamatta; 1023 jakaa myös recoveryn).
- Kartta ei todista, että 1023:n käytös vastaa forkin käytöstä. Se osoittaa paikan ja testin. Käytöksen vertailu tehdään portaassa.
