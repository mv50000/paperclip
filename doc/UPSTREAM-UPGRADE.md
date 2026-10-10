# Upstream Upgrade — Toistettava prosessi

Tämä dokumentti kuvaa prosessin, jolla Paperclip-forkin (mv50000/paperclip) päivitetään
uuteen upstream-versioon (paperclipai/paperclip) ilman kustomointien rikkoutumista.

Forkin kyvyt, commitit ja konfliktitiedostot on lueteltu tiedostossa
[`doc/upgrade/regression-matrix.md`](upgrade/regression-matrix.md). Se on jokaisen portaan
hyväksyntäportti. Savutesti: `scripts/upgrade-smoke.sh`.

## Migraatiokonventio

Custom-migraatiot käyttävät **9000-sarjaa** (`9NNN_rk9_<feature>.sql`):

| Numero | Feature |
|--------|---------|
| 9001   | Risk Management (taulut, kategoriat, snapshotit) |
| 9002   | Resend Email (viestit, routet, rate limit, templates) |
| 9003   | Email Escalation (lisäsarakkeet) |
| 9004   | Vanhentuneiden incidenttien automaattinen ratkaisu (backfill) |
| 9005   | Email support desk (`classification`, reitin `approval_required`) |
| 9006   | Outreach: tietomalli (prospektit, sekvenssit, viestit) |
| 9007   | Outreach: rikastus (prospektin sähköposti nullable PRH-tuontia varten) |
| 9008   | Outreach: sekvenssimoottori (lähetyskirjanpito, unsubscribe) |
| 9009   | Outreach: metriikat ja auto-pause (`outreach_sender_pauses`) |
| 9010   | Outreach: CS-desk-sähköpostireitti jokaiselle lähettäjälle (RK9-234) |
| 9000   | `email_messages`-jako, tuore kanta: upstreamin AgentMail-taulu parkkiin ennen 9002:ta (RK9-317) |
| 9011   | `email_messages`-jako, tuore kanta: forkin taulu → `rk9_email_messages`, upstreamin taulu takaisin (RK9-317) |
| 0126 (slot) | `email_messages`-jako, päivityspolku: forkin taulu → `rk9_email_messages` ennen upstreamin 0272:ta (RK9-317) |
| 9012   | Outreach: lähettäjien vastausreittien backfill |
| 9013   | Outreach: hyväksytyn sisällön tiiviste `approved_content_hash` (RK9-475) |

Seuraava vapaa numero: **9014** (tarkistettu 2026-10-10: `packages/db/src/migrations/`
ei sisällä 9014+-tiedostoja).

### `email_messages`-törmäys (RK9-317, porras 916.1)

Upstream v2026.916.1 luo oman `email_messages`-taulunsa (AgentMail, `0272`). Forkin Resend-taulu
(9002) on samanniminen. Forkin taulu on nyt `rk9_email_messages` (Drizzle `rk9EmailMessages`,
`packages/db/src/schema/rk9_email.ts`), ja upstreamin taulu pitää nimensä. Kaikki taulun
indeksit ja rajoitteet saavat `rk9_`-etuliitteen. Muut forkin sähköpostitaulut pitävät nimensä.

- **Päivityspolku (prod):** slot-migraatio `0126_rk9_email_messages_rename.sql` käyttää upstreamin
  vapaata numeroa 0126 (idx 126). Migraattori tunnistaa ajetut migraatiot hashista ja ajaa
  odottavat idx-järjestyksessä, joten 0126 ajetaan ennen 0272:ta. Se nimeää forkin taulun
  uudelleen vain, jos `email_messages` on olemassa ilman `endpoint_id`-saraketta.
- **Tuore kanta:** 0126 on no-op. 0272 luo upstreamin taulun, 9000 parkkeeraa sen nimelle
  `rk9tmp_email_messages`, 9002 luo forkin taulun ja 9011 vaihtaa molemmat lopullisiin nimiinsä.
  Prodissa 9000 ja 9011 ovat no-opeja.
- 9001–9010 pysyvät tavu tavulta ennallaan. Uudet tiedostot on pinnattu
  `fork-migration-hashes.json`:iin, ja `check-pr-migration-order.mjs` hyväksyy pinnatun
  tiedoston vapaassa numerossa (RK9 Custom).
- Reitti `POST /api/companies/:companyId/email/send` on kummassakin reitittimessä. Forkin
  `routes/rk9-email.ts` mountataan ennen upstreamin `routes/email.ts`:ää, joten fork omistaa reitin.
- Suora SQL ja skriptit (`outreach-window-report.sh`, `upgrade-rehearsal.sh`) lukevat
  forkin postia taulusta `rk9_email_messages`.

Upstream käyttää 0000-sarjaa. Numerot eivät törmää (~17 vuoden marginaali).
Journalissa (`meta/_journal.json`) upstreamin 0xxx-rivit ovat aina ensin ja forkin 9xxx-rivit
niiden jälkeen numerojärjestyksessä. Poikkeus on pinnattu slot-tiedosto upstreamin vapaassa
numerossa (0126, RK9-317), joka on journalissa numeronsa kohdalla. `scripts/upgrade-smoke.sh --offline` tarkistaa tämän.

## Hotspot-tiedostot

Nämä tiedostot muuttuvat sekä upstreamissa että meillä. Custom-osiot on merkitty
`// --- RK9 Custom ---` -kommentilla. Mergen aikana: pidä molemmat puolet,
upstream ylös ja custom-koodi merkin alle.

Koemerge `origin/master` + `v2026.916.1` (2026-09-26) tuotti 93 konfliktitiedostoa.
Täysi lista omistavine kykyineen ja ratkaisuohjeineen on regressiomatriisissa. Pahimmat
(konfliktilohkoja suluissa):

- `pnpm-lock.yaml` (57) — ota upstreamin versio, aja `pnpm install`
- `server/src/services/heartbeat.ts` (15) — system pause, company pause, concurrency limit, idle timer skip, recall-injektio
- `packages/db/src/migrations/meta/_journal.json` (10) — migraatiorekisteri, ks. yllä
- `ui/src/pages/Routines.tsx` (8) ja `ui/src/pages/Routines.test.tsx` (4) — quota pause -vartijat
- `server/src/routes/issues.ts` (8) — goalId-suodin, run-id-guard, outcome requirements
- `server/src/app.ts` (8) — route mount (risk, email, resend/SES inbound, outreach, unsubscribe, github-webhooks, knowledge)
- `server/src/services/recovery/service.ts` (7) — strictInProgressOnly, heartbeat disabled -ohitus, RK9-87
- `server/src/__tests__/heartbeat-process-recovery.test.ts` (7)
- `server/src/services/routines.ts` (6) — quota pause -vartijat
- `server/src/services/issues.ts` (6) — backlog→todo, sähköpostiketjut
- `server/src/index.ts` (6) — service init (risk, slack, email, outreach, webhook monitor, system pause)
- `packages/adapters/claude-local/src/server/execute.ts` (6) ja `test.ts` (6) — tool containment, API-avaimen pidätys (RK9-228), mallilista
- `server/src/routes/instance-settings.ts` (5), `server/src/services/instance-settings.ts` (3), `ui/src/pages/InstanceSettings.tsx` (modify/delete) — system pause, concurrency limit
- `server/src/routes/agents.ts` (5) — external-runs, human_proxy
- `server/src/services/issue-execution-policy.ts` (4) — outcome requirements (SEC-91)
- `server/src/__tests__/claude-local-execute.test.ts` ja `packages/adapters/gemini-local/src/server/parse.test.ts` —
  forkin testit tiedostojen lopussa; porras 618 (RK9-314) konfliktoi molemmissa. Ota upstream ja lisää forkin lohkot perään.
- `skills/paperclip/SKILL.md` (3) ja `skills/paperclip-dev/SKILL.md` (modify/delete)
- `ui/src/components/IssueProperties.tsx` — upstream pilkkoi komponentin hakemistoon `issue-properties/` portaassa 707
  (RK9-314). Juuritiedosto on pelkkä re-export; forkin SEC-91-rivi on `issue-properties/IssueProperties.tsx`:ssä.
- `packages/adapters/claude-local/src/server/acp.ts` (`normalizeEngine`), `execute.ts` ja `test.ts` (ACP-haara) —
  forkin CLI-pinnaus ja ACP-avainvartija (RK9-305, RK9-228; v2026.720.0, RK9-314). Ks. `doc/upgrade/acpx-claude-local.md`.
- `server/src/services/built-in-agents.ts` (`autoProvisionBundledAgents`) — forkin `enableBuiltInAgents`-portti (RK9-314).
- `ui/src/components/StatusBadge.tsx` — forkin `adapterType`-propi ja human proxy -haara; upstream muuttaa tiedostoa usein.
- `packages/db/src/migrations/meta/_journal.json` — 707:stä alkaen upstreamin idx on sama kuin migraation numero, ja
  numeroissa on aukkoja (0126, 0130). Anna 9001–9010:lle idx:t upstreamin suurimmasta idx:stä + 1 alkaen, älä paikan
  mukaan. `client.ts` järjestää idx:n mukaan; `upgrade-smoke.sh` vaatii tiukasti kasvavan idx:n.
  Poikkeus 817:stä alkaen: upstream antoi `0177`:lle ja `0178`:lle saman idx:n 178. `client.ts` ratkaisee
  tasapelin tiedostonimellä, ja `upgrade-smoke.sh` sallii tasapelin, kun tagi kasvaa (RK9-315).
- `packages/adapter-utils/src/acpx-engine/execute.ts` — upstream poisti paikallisen kaistan agentti-wrapperin 817:ssä
  ja antaa ajon envin `sessionOptions.env`illä. acpx 0.12 yhdistää sen kuitenkin palvelimen `process.env`iin, joten
  fork pitää POSIX-wrapperin, joka poistaa palvelimen omat `PAPERCLIP_*`-muuttujat. Wrapper ei kirjoita envia
  levylle (upstreamin "no credential files" -testi pätee). Ks. `doc/upgrade/acpx-claude-local.md` (RK9-315).
- `packages/shared/src/feature-catalog.ts` — 817:stä alkaen jokaisella `experimental`-lipulla on oltava
  katalogirivi, muuten typecheck kaatuu. Forkin liput (`knowledgeRecallInjectionEnabled`,
  `recoveryStrictInProgressOnly`) ovat RK9 Custom -lohkossa (RK9-315).
- `server/src/routes/issues.ts` — forkin RK9-76 tekee run id:stä valinnaisen checkoutissa ja interaktion
  luonnissa. Upstreamin interaktioiden resolve- ja withdraw-reitit vaativat sen yhä (`requireAgentRunId`, RK9-315).
  817:n `assertCrossIssueInfluenceWithinRunCap` vaatii run id:n jokaiselta agentin kommentilta ja muutokselta;
  fork päästää runittoman human proxy -agentin läpi oman yrityksensä issueihin. `services/issues.ts`:n
  `assertKnownActorRunId` pysyy `addComment`issa (422 ennen tallennusta, RK9-76, RK9-315).
- `server/src/services/recovery/service.ts` — 831 toi not-invokable-eskalaation. Forkin RK9 Custom -lohko ohittaa
  human proxy- ja heartbeat-disabled-agentit ennen sitä (`isRk9RecoveryExcludedAgent`, RK9-316).
  Sama ohitus on `reconcileDispositionRepair`issa. Tarkista jokainen uusi upstream-polku, joka kutsuu
  `isAgentInvokable`a ja eskaloi tai siirtää issuen `blocked`-tilaan.
  `packages/db/src/migration-snapshot-drift.test.ts` (upstream, 831) ohittaa 9xxx-taulut (RK9 Custom).
- `packages/adapters/claude-local/src/server/test.ts` — 831:n probe rakentaa oman envinsä
  (`buildLocalAdapterTestProbeEnv`) ja ajaa luotetusta PATHista. Forkin `inheritableHostEnv()` ja
  `doNotInheritEnvKeys: hostEnvKeysNotInherited()` pitävät `ANTHROPIC_API_KEY`n poissa (RK9-228, RK9-316).
- `.github/scripts/check-pr-migration-order.mjs` (upstream, 831) — RK9 Custom: vertailu sarjoittain, koska
  forkin 9001–9010 ovat numeroltaan upstreamin edellä. Älä palauta upstreamin yhden maksimin vertailua (RK9-316).
- `scripts/check-node-version-policy.mjs` (upstream, 831) — RK9 Custom ohittaa `infra/ses-forwarder`in (Lambda `nodejs20.x`).
- `ui/src/pages/InstanceSettings.tsx` — upstream poisti sivun 831:ssä. Forkin ajolaskuri on nyt
  `InstanceGeneralSettings.tsx`:ssä (RK9-316).
- `packages/paperclip-runner` (upstream, 831) — typecheck ja serverin `prepare:runner-vendor` tarvitsevat `cargo`n.
  Tuotanto ajaa TS-lähdettä `tsx`:llä, joten cargoa ei tarvita ajossa.
- `packages/db/src/schema/email.ts` ja `server/src/routes/email.ts` (916.1) — upstreamin AgentMail. Forkin
  Resend-skeema on `schema/rk9_email.ts` ja reitit `routes/rk9-email.ts` (RK9-317, ks. "`email_messages`-törmäys").
  Uusi upstream-koodi, joka viittaa `emailMessages`iin, tarkoittaa AgentMail-taulua, ei forkin postia.
- `server/src/services/agent-permissions.ts` (916.1) — upstream antaa `canCreateAgents`-oletuksen jokaiselle
  standard-trust-agentille. RK9 Custom pinnaa `create`-oletuksen CEO-rooliin (RK9-317,
  `hire-approval-policy.test.ts`, `hire-permission-default-rk9.test.ts`).
- `server/src/services/productivity-review.ts` — upstream poisti productivity reviewt 916.1:ssä (#13263).
  Forkissa ei ollut sille RK9 Custom -lohkoa.
- `scripts/provision-worktree.sh`
- `server/src/services/index.ts`, `packages/db/src/schema/index.ts`, `packages/shared/src/index.ts`, `packages/shared/src/constants.ts` — exportit

### CI-runner-vipu (RK9-350)

Forkin jobit valitsevat runnerinsa repo-muuttujasta `vars.CI_RUNNER` (ks.
[`doc/CI-RUNNER.md`](CI-RUNNER.md)). Upstream käyttää `runs-on: ubuntu-latest`, joten
jokainen porras tuo rivit takaisin, jos upstream muuttaa niitä. Muutokset on merkitty YAMLissa
`# --- RK9 Custom (RK9-350) ---` -kommentilla.

- `.github/workflows/pr.yml` — `runs-on` neljässä jobissa fork-suojalla ja secret-scanin
  `runner_label`. Playwright-askel ajaa `--with-deps` vain, jos sudo toimii.
- `.github/workflows/release.yml` — `runs-on` viidessä jobissa. v2026.720.0:sta alkaen verify-jobit ovat
  uudelleenkäytettävässä `release-verify.yml`:ssä; kutsu antaa `runner_label: ${{ vars.CI_RUNNER || '["ubuntu-latest"]' }}`
  (2 kohtaa, RK9-314).
- `.github/workflows/release-verify.yml` (upstream, v2026.720.0) — input `runner_label`, neljä jobia
  `fromJSON(inputs.runner_label || vars.CI_RUNNER || '["ubuntu-latest"]')`.
- `.github/workflows/storybook-visual.yml` (upstream, v2026.720.0) — `pull_request`-jobi: vipu fork-suojalla,
  `workflow_dispatch`illa vipu ilman suojaa.
- `.github/workflows/docker.yml`, `refresh-lockfile.yml` — `runs-on`.
- `.github/workflows/e2e.yml`, `release-smoke.yml` — `runs-on` ja Playwright-askel.
- `.github/workflows/ai-auto-merge.yml` (vain forkissa) — `runs-on`, deploy-dev-dispatch pois,
  `actions: read`.
- `.github/workflows/deploy-dev.yml` (vain forkissa) — poistettu. Älä palauta mergessä.
- `.github/workflows/commitperclip-review.yml` (upstream, v2026.609.0) — poistettu forkista (RK9-313).
  Se ajaa `pull_request_target`illa upstreamin botin salaisuuksilla, ja `pull_request_target` on kielletty. Älä palauta mergessä.
- `.github/workflows/agent-runtime-images.yml` (upstream, v2026.618.0) — runner-vipu ja ehto
  `github.repository == 'paperclipai/paperclip'` (RK9-314). Jobi julkaisee `ghcr.io/paperclipai`-kuvia, joten forkissa se ei aja.
- `e2e`-askeleet (`pr.yml`, `e2e.yml`, `release-smoke.yml`): upstream käyttää runnerin Chromea
  (`PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome`). Fork käyttää Chromea, jos se löytyy, muuten Playwrightin chromiumia (RK9-313).

Ratkaisu: ota upstreamin muutos ja palauta `runs-on`-rivi vivun muotoon. Uusi upstream-jobi
saa saman vivun: `pull_request`-jobit fork-suojalla, muut ilman. Tarkistus:
`scripts/upgrade-smoke.sh --offline` epäonnistuu, jos jokin `runs-on`- tai
`runner_label`-rivi ei käytä `vars.CI_RUNNER`ia.

### Heartbeat/Recovery/Routines/Execution-Policy hotspot resolution

Päätöstaulukko (drop / re-port / redesign per forkin korjaus, upstream-vertailu tagia
`v2026.916.1` vasten ja regressiotestit) on tiedostossa
[`doc/regression/heartbeat-recovery-fork-inventory.md`](regression/heartbeat-recovery-fork-inventory.md).
Konsultoi sitä ennen kuin ratkaiset konflikteja tiedostoissa `heartbeat.ts`,
`recovery/service.ts`, `routines.ts`, `issues.ts`, `issue-execution-policy.ts` ja `index.ts`.

## Porrastusmalli

Upstream päivitetään tagi kerrallaan, ei suoraan `upstream/master`iin. Vahvistettu
porrastus (tagit ja commitit: regressiomatriisi, osio "Lähtötila"):

`v2026.512.0` → `v2026.609.0` → `v2026.720.0` → `v2026.817.0` → `v2026.831.1` → `v2026.916.1`

Porras 720 pilkotaan välitageihin (RK9-314, operaattorin sääntö: yli ~40 konfliktitiedostoa tai yli ~60
migraatiota). Suora koemerge 720 antoi 60 konfliktia ja 83 migraatiota, joten järjestys on
`v2026.618.0` → `v2026.707.0` → `v2026.720.0` (626 ohitettiin: 707 jäi 618:n päälle rajojen alle, 39 konfliktia ja
31 migraatiota). Jokainen välitagi on oma branch, PR ja cutover.

Jokainen porras on oma branch (`upgrade/v2026.NNN.N`) ja oma PR. Porras mergetään
masteriin vasta, kun regressiomatriisin pakolliset tarkistukset ovat vihreitä
harjoitusinstanssissa. Seuraava porras aloitetaan edellisen mergetystä masterista.
Kirjaa jokainen porras osioon "Porrasloki".

## Node 24

Päivitetty 2026-09-26 ([RK9-310](/RK9/issues/RK9-310)). Upstream vaatii `engines.node >=24.11.0` (tarkistettu tageista
`v2026.916.1` ja `upstream/master`). Fork vaatii `>=20`, ja paperclip-01 ajaa Node 22.22.1:tä. Node 24 tuodaan
tuotantoon nykyisellä forkilla **ennen yhtäkään upstream-mergeä**, jotta runtime-regressiot erottuvat merge-regressioista.

### Päätökset

- **`engines.node` jää arvoon `>=20`.** Upstream nostaa sen arvoon `>=24.11.0` tagissa `v2026.831.1`. Etukäteen tehty fork-bumppi tuottaisi turhan konfliktin, joten arvo tulee portaan 831.1 mergessä. (Poikkeama tiketin hyväksymisehdosta.)
- **Porras 831.1 (RK9-316):** `engines.node` on nyt upstreamin `>=24.11.0`. Palvelin vain varoittaa vanhasta Nodesta; preflightin gate on varsinainen este. CI:n `pnpm check:node-version` tarkistaa pakettien engines-kentät.
- **CI:** `e2e.yml` ja `refresh-lockfile.yml` käyttävät `node-version: 24` kuten `pr.yml`, `release.yml` ja `release-smoke.yml`. `runs-on`-arvot eivät muutu (ei GitHub-hosted-buildeja).
- **Preflightin Node-gate** on jo `~/.claude`-lähteessä ([RK9-307](/RK9/issues/RK9-307)): `hosts/paperclip/paperclip-service/paperclip-preflight.sh`. Tämä tiketti ei muokkaa sitä.
- **`paperclip-start.sh`:n PATH** on `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. `/usr/local/bin/node` ei ole olemassa, joten `node` resolvoituu polkuun `/usr/bin/node`, jonka `nodejs`-paketti omistaa. apt-päivitys vaihtaa siis palvelun Noden ilman muutoksia käynnistysskriptiin.
- **Rollback-kysymys:** nykyinen fork-koodi toimii Node 24.21.0:lla (todiste alla). Koodin rollback (`git reset` + `pnpm install`) ei siis vaadi Noden palautusta, ja uusi preflight (Node ≥ 24.11) pysyy paikallaan. Node palautetaan vain, jos vika on Node 24:ssä itsessään; silloin tarvitaan myös vanha preflight (ks. `doc/upgrade/cutover-runbook.md`, "Node ja preflight rollbackissa").

### Todiste (26.9.2026, Node v24.21.0, nykyinen master `24f1f07b`)

Node ladattiin virallisena tarballina (`nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz`, `SHASUMS256.txt` täsmäsi) `/tmp`-hakemistoon. Koneen Nodeen ei koskettu.

| Tarkistus | Tulos |
|---|---|
| `pnpm install --frozen-lockfile` | OK, 1 min. Ei natiivimoduulien rebuild- eikä prebuild-latausvirheitä (`embedded-postgres` + patch, `sharp`). |
| `pnpm -r typecheck` | OK, 7 min. |
| `pnpm test:run` | 189 / 190 tiedostoa, 1478 / 1480 testiä läpi. Yksi virhe: `workspace-runtime.test.ts` "writes an isolated repo-local Paperclip config…". **Sama virhe Node 22.22.1:llä**, joten se ei johdu Node 24:stä (ympäristöriippuva; ajettu agentin worktreessä). Kesto 15 min. |
| Harjoitusinstanssi (`scripts/upgrade-rehearsal.sh`, master `24f1f07b`) | Putki (dump, restore, worktree, install, palvelin) 130 s. Eristystarkistukset OK. HTTP-savutesti 10/10. |
| Fork-testit harjoituksessa | 768 / 769 läpi. `heartbeat-idle-timer-skip.test.ts` epäonnistui kerran (FK-virhe siivouksessa, kuormaflake); erikseen ajettuna 2 / 2 läpi Node 24:llä, ja koko suitessa läpi. |
| Rollback-harjoitus | 49 s, rivimäärät ja skeemasormenjälki täsmäsivät. |
| `claude` CLI Node 24:n `child_process`-spawnista | `claude --version` → 2.1.283, exit 0. `claude` on natiivi binääri, joten Node-versio ei vaikuta siihen. `claude-local`-testit (5 tiedostoa) läpi. |
| `cicd-failure-watch.sh` Node 24:n spawnista | exit 0 (`gh` korvattu tynkällä; ei verkkoa). |
| `qmd-mcp-client`, `email-inbound`, outreach, heartbeat-testit | läpi (1 / 1 / 33 / 35 tiedostoa). |

Ei todennettu (todentamatta): oikea `claude_local`-heartbeat autentikoituna ja oikea outreach-lähetys eivät kuulu harjoitukseen
(ajastimet ja verkko estetty tarkoituksella). Ne tarkistetaan tuotannossa 48 h seurannassa.

### Host-apt-päivitys (operaattorin ikkunassa, runbookin vaiheet 0.3–0.4)

Lähde on `/etc/apt/sources.list.d/nodesource.sources` (deb822, ei `.list`), nykyinen `URIs: https://deb.nodesource.com/node_22.x`.
Komennot on kirjoitettu mutta **ei ajettu** (todentamatta; agentilla ei ole `apt`-oikeutta). Tarkista versiomerkkijono ennen ajoa: `apt-cache policy nodejs` päivityksen jälkeen.

```bash
# 1. Varmista rollback-lähtötila ja säästä vanha lähde.
dpkg -l nodejs | tail -1                      # odotus: 22.22.1-1nodesource1
sudo cp -a /etc/apt/sources.list.d/nodesource.sources /root/nodesource.sources.node22
# 2. Vaihda lähde node_22.x → node_24.x.
sudo sed -i 's#/node_22\.x#/node_24.x#' /etc/apt/sources.list.d/nodesource.sources
sudo apt-get update
apt-cache policy nodejs                       # Candidate: 24.x.y-1nodesource1, x ≥ 11
# 3. Pysäytä palvelu vain jos runbook on jo vaiheessa 4; muuten asenna ja restarttaa erikseen.
sudo apt-get install -y nodejs                # päivittää /usr/bin/node
# 4. Todenna.
/usr/bin/node --version                       # ≥ v24.11.0
sudo -u paperclip env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin node --version
pnpm --version                                # 9.15.4 (asennettu erikseen /usr/lib/node_modules/pnpm)
# 5. Estä tahaton nousu seuraavaan major-versioon.
sudo apt-mark hold nodejs                     # vapauta: apt-mark unhold nodejs
```

Rollback Node 22:een (vain jos vika on Node 24:ssä):

```bash
sudo apt-mark unhold nodejs
sudo cp -a /root/nodesource.sources.node22 /etc/apt/sources.list.d/nodesource.sources
sudo apt-get update
sudo apt-get install -y --allow-downgrades nodejs=22.22.1-1nodesource1
/usr/bin/node --version                       # v22.22.1
# Asenna vanha preflight, koska uusi vaatii Node ≥ 24.11 (ks. cutover-runbook, "Node ja preflight rollbackissa").
```

**Hostin globaalit natiivimoduulit (27.9.2026, [RK9-347](/RK9/issues/RK9-347)).** Node-majorin vaihto rikkoo moduulit, jotka on käännetty lähteestä (`build/Release/*.node`, ei N-API-prebuildia). paperclip-01:llä niitä oli kaksi: qmd:n ja obsidian-headlessin `better-sqlite3`. Etsi ne ennen vaihtoa ja käännä vaihdon jälkeen uudelleen:

```bash
sudo find /usr/lib/node_modules /var/lib/paperclip/.npm-global/lib/node_modules -name "*.node" -path "*build/Release*"
cd /usr/lib/node_modules/@tobilu/qmd && sudo npm rebuild better-sqlite3 && sudo systemctl restart qmd-mcp mvvault-qmd-mcp
sudo -u paperclip env HOME=/var/lib/paperclip bash -c 'cd ~/.npm-global/lib/node_modules/obsidian-headless && npm rebuild better-sqlite3'
```

Pitkäikäiset palvelut jäävät vanhalle Nodelle restarttiin asti: `for p in $(pgrep -x node); do sudo readlink /proc/$p/exe | grep -q deleted && sed "s#.*/##" /proc/$p/cgroup; done | sort -u`.

Tuotannon 48 h seuranta Node 24:llä ilman muita fork-koodimuutoksia: heartbeat-ajot, outreach-lähetys ja saapuva posti
(`resend-inbound`, `ses-inbound`) ilman regressioita. Toteutus on seurantatiketissä (RK9-303:n lapsi).

## Oletusten kovennus

Upstream tuo portaissa uusia oletuksia, jotka avaavat ulkoisia yhteyksiä tai laajentavat
oikeuksia. Alla oleva taulukko kertoo RK9:n arvon ja portaan, jossa arvo asetetaan.
Tarkistuslista porrasta kohden, todennuskomennot, webhook-reittien tarkistus ja preflightin
lisäykset (omistaja RK9-307) ovat tiedostossa
[`doc/upgrade/defaults-hardening.md`](upgrade/defaults-hardening.md) (RK9-309).

Mikään näistä ei muuta nykyforkin käytöstä. Asetus otetaan käyttöön siinä portaassa, jossa
upstream tuo sen.

### RK9-oletukset

| Asetus | RK9-arvo | Upstream-oletus | Tulee tagissa | Sijainti |
|---|---|---|---|---|
| Announcement feed | `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` (opt-out) | päällä, hakee `pages.paperclip.ing` | v2026.916.0 (porras 916.1) | env, `export` tiedostossa `paperclip-start.sh` |
| Cloud sync | ei konfiguroida (`enableCloudSync` pysyy `false`) | `false` | v2026.609.0, poistuu v2026.817.0:ssa (migraatio 0196) | instanssiasetus `experimental`, ei kirjoiteta |
| Standard-trust-agentin hire-oikeus | vain board, CEO tai eksplisiittinen grantti; `requireBoardApprovalForNewAgents` yrityskohtaisesti (0071) | `canCreateAgents` päällä standard-trust-agenteille | v2026.916.1 | koodi: RK9 Custom -pinnaus `agent-permissions.ts`:ään, lukitsee `hire-approval-policy.test.ts` |
| Agentin tehtävänanto (`tasks:assign`) | vain eksplisiittinen grantti tai CEO/`canCreateAgents` | jokainen aktiivinen saman yrityksen agentti (simple mode) | v2026.609.0 | koodi: RK9 Custom -lohko `authorization.ts`:ään (RK9-313), lukitsevat `authorization-service.test.ts` ja `permissions-upgrade-boundary-routes.test.ts` |
| Proxy trust | `TRUST_PROXY=loopback`: Express luottaa vain paikalliseen nginxiin, joka luottaa vain edgeen `192.168.1.17` (`set_real_ip_from`); `PAPERCLIP_ALLOWED_HOSTNAMES` ja `PAPERCLIP_PUBLIC_URL` kattavat `paperclip.rk9.fi`:n (asetettu jo nyt) | `TRUST_PROXY` asettamatta | `TRUST_PROXY` v2026.618.0 (porras 720, RK9-314), guardin `X-Forwarded-Host`-rajaus v2026.916.0 (porras 916.1) | env, `export` tiedostossa `paperclip-start.sh` |
| Cloud tenant -actor | `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` jää asettamatta: kun se on asetettu, `middleware/auth.ts` (`resolveCloudTenantActor`) luo `instance_admin`-actorin luotetuista headereista | asettamatta | v2026.512.0 | env, ei `paperclip-start.sh`:ssä |
| Native runner | `enableNativeRunner=false`, `claude_local` pinnattu CLI-moottoriin (RK9-305) | `false` 831.1:ssä, `true` 916.0:sta alkaen | v2026.831.1 | instanssiasetus `experimental`, kirjoitetaan eksplisiittisesti |

Tietoturvakorjaukset: #11400 (CWE-78, CLI-ohjeet, ensimmäinen tagi v2026.824.0) tulee portaassa v2026.831.1 ja #12776
(etuoikeutetut rajapinnat, SSRF) portaassa v2026.916.1. Forkin webhook-reittien tarkistus
korjauksia vasten on tiedostossa `doc/upgrade/defaults-hardening.md`.

## Harjoitusinstanssi

`scripts/upgrade-rehearsal.sh <git-ref>` (RK9-306) ajaa jokaisen portaan prod-kannan kopiota
vasten. Aja se ennen jokaista porrasta (512 → 609 → 720 → 817 → 831.1 → 916.1) ja kirjaa tulos
Porraslokiin. Komento tekee yhdellä ajolla:

1. `pg_dump -Fc` prod-kannasta tiedostoon `/var/backups/paperclip/rehearsal-<aika>.dump` (vain luku).
   Skripti tarkistaa ensin levytilan (vapaata vähintään 3 × kannan koko) ja säilyttää 5 viimeisintä dumpia.
2. Palautus kantaan `paperclip_rehearsal`. Nimi on lukittu muotoon `paperclip_rehearsal[_x]`, eikä se voi olla prod-kanta.
3. Worktree `/tmp/paperclip-worktrees/rehearsal/RK9` refistä (guard sallii vain `rehearsal/`-alihakemiston) ja `pnpm install --frozen-lockfile`.
4. Palvelin porttiin 3199 omalla `PAPERCLIP_HOME`lla (`~/.paperclip-rehearsal`), joka ei saa osua prodin kotiin.

Tuloste: dumpin polku, pre-upgrade-SHA (`git rev-parse HEAD` ennen checkoutia) ja kokonaiskesto.

### Eristys

Operaattorin päätös (2026-09-26): eristä ensisijaisesti verkkotasolla ja pidä salaisuudet poissa envistä.
Koodiin ei lisätty kill-switchiä. Heartbeat-, routine- ja outreach-ajastimet sammuvat olemassa olevilla
lipuilla, joten `heartbeat.ts` ja `routines.ts` pysyvät koskemattomina (konfliktipinta ei kasva).

| Kerros | Toteutus | Mitä estää |
|---|---|---|
| Verkko ja pid | palvelin ajetaan `unshare -r -n -p -f` -nimiavaruudessa (vain `lo`, ei reittejä; nimet voivat resolvoitua hostin resolverin socketin kautta, yhteys ei avaudu). Oma pid-avaruus estää palvelinta signaloimasta prodin agenttiprosesseja kannan kopion `process_pid`-arvoilla | SES/Resend, Slack, GitHub, outreach-lähetys, DNSBL, announcement feed |
| Kanta | nimiavaruuden sisäinen silta `127.0.0.1:5432` → hostin PG:n unix-socket (postgres.js ei tue `?host=`-muotoa) | ei tarvitse egressiä paikalliseen PG:hen |
| Env | `env -i` + allowlist; ei `ses.env`iä eikä tokeneita, `PAPERCLIP_SECRETS_*`-muuttujista vain `master.key`-polku | salaisuudet eivät päädy palvelimeen |
| Salaisuudet kannassa | oma `PAPERCLIP_HOME`; `PAPERCLIP_CONFIG` ja `PAPERCLIP_SECRETS_MASTER_KEY_FILE` lukittu sen alle, joten `master.key` on uusi | kantaan tallennetut salaisuudet eivät pura |
| Ajastimet | `HEARTBEAT_SCHEDULER_ENABLED=false`, `OUTREACH_SENDER_ENABLED=false`, `OUTREACH_AUTO_PAUSE_ENABLED=false`, `OUTREACH_DNSBL_ENABLED=false`, `PAPERCLIP_DB_BACKUP_ENABLED=false` | agenttiajot (ne kirjoittaisivat oikeisiin repoihin), routinet, outreach-cronit |

Skripti epäonnistuu suljetusti (`die`), jos jokin näistä ei päde: nimiavaruudessa on muu liitäntä kuin `lo`,
reittejä on, egress-koetin pääsee ulos (1.1.1.1, 8.8.8.8, metadata, SES, Resend, Slack, GitHub),
jonkin nimiavaruuden prosessin (init, silta, palvelin) env sisältää salaisuudennäköisen muuttujan tai ulos lähtevien taulujen
(`email_messages`, `email_outbound_audit`, `outreach_messages`, `outreach_events`, `outreach_sender_pauses`)
rivimäärä kasvaa käynnistyksessä. Egress-tarkistus ajetaan ennen palvelimen käynnistystä ja sen jälkeen; env- ja rivimääräntarkistus käynnistyksen jälkeen.

Palvelin kuuntelee vain nimiavaruuden loopbackissa. Hostilta se ei ole tavoitettavissa, joten
savutesti ajetaan komennolla `scripts/upgrade-rehearsal.sh smoke [--fork-tests]`. Se käyttää **refin omaa**
`scripts/upgrade-smoke.sh`ia harjoitus-worktreestä (ei ajokopiota): offline- ja fork-testit ajetaan
nimiavaruuden ulkopuolella (embedded PG ei käynnisty root-uidilla), HTTP-tarkistukset sen sisällä.

Yksi `claude_local`-heartbeat per yritys (regressiomatriisin kohta 4) ei ole automatisoitu. Ajastin on pois päältä,
koska agentti voisi kirjoittaa kannan osoittamiin oikeisiin työhakemistoihin. Ajo vaatii erillisen päätöksen
(heartbeat-päätökset -osion lapsi) ja työhakemistojen uudelleenohjauksen.

### Ajo tällä koneella

Kanta hyväksyy socketissa vain peer-tunnistuksen, joten aja palvelun käyttäjänä:

```bash
sudo -u paperclip scripts/upgrade-rehearsal.sh v2026.512.0    # tai porrasbranch
sudo -u paperclip scripts/upgrade-rehearsal.sh smoke --fork-tests
sudo -u paperclip scripts/upgrade-rehearsal.sh rollback
sudo -u paperclip scripts/upgrade-rehearsal.sh stop
sudo -u paperclip scripts/upgrade-rehearsal.sh clean          # pudottaa paperclip_rehearsal-kannan (sisältää prod-dataa) ja worktreen
```

`sudo` nollaa ympäristön. Anna ylikirjoitukset näin: `sudo -u paperclip env REHEARSAL_PORT=3198 scripts/upgrade-rehearsal.sh <ref>`.
Aja `clean` jokaisen portaan jälkeen: harjoituskanta sisältää prospektien henkilötietoja. Dumpit poistuvat komennolla `clean --dumps`
tai retentiolla (5 viimeisintä).

Aja skripti paperclip-omisteisesta checkoutista (tällä koneella `/opt/paperclip`, joten worktree-metadata kirjoitetaan prodin `.git`-hakemistoon; se on harmiton), sillä `git` kieltäytyy toisen käyttäjän repoista ja
`/home/rk9admin` on 700. Worktree lisätään sen `.git`-hakemistoon.

Kertaluonteinen valmistelu (operaattori, root). Sitä ei voitu tehdä agenttisessiosta, koska sessiolla ei ole sudoa.
Älä koske hakemistoon `/tmp/paperclip-worktrees/RK9`: se on operaattorin worktreejä varten.

```bash
sudo install -d -o paperclip -m 700 /var/backups/paperclip
sudo -u postgres psql -c 'ALTER ROLE paperclip CREATEDB'
sudo install -d -o paperclip -m 755 /tmp/paperclip-worktrees/rehearsal
sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0   # vain jos unshare -rn estetty
```

### Rollback-harjoitus

`rollback` pysäyttää nimiavaruuden, luo `paperclip_rehearsal`in tyhjäksi, ajaa `pg_restore --clean` dumpista ja
tekee `git reset --hard <pre-SHA>` worktreessä. Rivimäärät (companies, agents, issues, heartbeat_runs,
activity_log ja ulos lähtevät taulut), julkisten taulujen ja sarakkeiden määrä sekä skeeman sormenjälki
(`pg_dump -s` ilman `\restrict`-riviä, md5) on vastattava restore-hetkeä, muuten skripti epäonnistuu. Skripti kertoo, muuttuiko
skeema ajon aikana (migraatiot ajettu). Jos ei muuttunut, rollback ei todista skeeman palautusta. Kanta luodaan tyhjäksi, koska `--clean` yksin ei poista tauluja, jotka portti lisäsi.
Kirjaa rollbackin kesto Porraslokiin.

### Tunnetut rajat

- Putki (dump, restore, worktree, nimiavaruus, silta, eristystarkistukset, smoke `--offline`, rollback, virhepolun siivous)
  on ajettu tilapäistä PG-klusteria vasten. Tynkäpalvelin avasi kantayhteyden postgres.js:llä sillan kautta.
  Ajoa oikeaa prod-kantaa ja oikeaa palvelinta (pnpm, migraatiot käynnistyksessä) vasten ei ole tehty.
- Nimiavaruus eristää verkon ja pid-avaruuden, ei tiedostojärjestelmää eikä käyttäjää. `--mount-proc` ei onnistu
  LXC-kontissa, joten `/proc` on hostin. Palvelin ajaa samalla käyttäjällä kuin prod, näkee prodin
  `PAPERCLIP_HOME`n ja agenttien työhakemistot, ja socketin peer-tunnistus päästäisi sen prod-kantaan, jos
  `DATABASE_URL` osoittaisi sinne (skripti asettaa sen harjoituskantaan). Heartbeat-ajastin on pois päältä, mutta
  API:n kautta herätetty ajo voisi käynnistää agentin oikeassa työhakemistossa. Älä herätä agentteja harjoitusinstanssissa.
  Jatkokehitys: oma käyttäjä ja mount-nimiavaruus.
- Käynnistyksessä ajavat cronit (sähköpostin eskalointi, deliverability monitor, liveness watchdog, riskimonitorit,
  Slack forwarder) eivät päädy ulos verkkoon, mutta kirjoittavat harjoituskantaan.
- `pg_dump` ottaa prodissa jaetut lukot koko ajaksi. Aja se hiljaisena hetkenä; `--lock-wait-timeout=60s`
  katkaisee odotuksen, mutta ei lyhennä dumpin kestoa.
- `pnpm install` ajetaan nimiavaruuden ulkopuolella (tarvitsee verkon) ja ajaa testattavan refin
  lifecycle-skriptit palvelun käyttäjällä. Aja vain omia porrasbrancheja ja upstream-tageja.
  pnpm-store on jaettu prodin kanssa (hardlinkit samalla levyllä), joten lifecycle-skripti voisi muuttaa prodin riippuvuuksia paikan päällä.
- Nimiavaruuden filesystem-socketit (esim. `/run/ssh-unix-local/socket`) ovat palvelimen ulottuvilla; palvelinkoodi ei käytä niitä.
- Jos vain holder-prosessi kuolee, orpo nimiavaruus jää eikä `stop` löydä sitä; `clean` epäonnistuu silloin (avoimet yhteydet). Tapa init käsin (`pgrep -f "sleep infinity"`).
- Offline- ja fork-testit ajetaan verkon ollessa auki mutta `env -i`-siivotulla ympäristöllä ja rehearsal-`PAPERCLIP_HOME`lla.
- Yksi ajo kerrallaan (`flock`). Toinen ajo tapettaisiin muuten EXIT-trapissa.
- Rollback palauttaa saman dumpin tuoreeseen kantaan ja resetoi worktreen pre-SHA:han. Se todistaa palautusmekanismin,
  rivimäärät ja skeeman, ei sitä, että palvelin käynnistyy pre-SHA:lla. Käynnistä palvelin pre-SHA:lla käsin tarvittaessa.

## Migraatioiden dry-run prod-kopioon (RK9-311)

`packages/db/scripts/migration-dry-run.ts` ajaa puun migraatiot prod-dumpin kopiota vasten ja kirjoittaa
raportin, jossa on vain rivimääriä, tunnisteita ja muutama asetusarvo (dump sisältää prospektien henkilötietoja;
tietokannan virheilmoitukset siistitään raporttiin, ja raporttitiedosto kirjoitetaan oikeuksilla 0600). Jokainen
porras (RK9-312…317) ajaa sen omassa portaassaan. Työkalu käyttää **ajettavan puun omaa** `client.ts`:ää,
joten aja se portaan worktreessä, ei masterissa.

```bash
# paperclip-käyttäjänä (kanta hyväksyy socketissa vain peer-tunnistuksen), paperclip-omisteisesta checkoutista
sudo -u paperclip env PGHOST=/var/run/postgresql PGUSER=paperclip \
  pnpm db:migration-dry-run --dump /var/backups/paperclip/rehearsal-<aika>.dump \
  --schema-diff --report /tmp/migration-dry-run-<porras>.md
```

Työkalu palauttaa dumpin kantaan `paperclip_migdryrun`, ajaa `applyPendingMigrations`in ja pudottaa kannan
lopuksi (`--keep-db` jättää sen; pudota käsin, kanta sisältää prod-dataa). Fail closed: kannan nimi on
`paperclip_migdryrun[_x]`, se ei voi olla `paperclip`, yhteys menee vain unix-socketin kautta, ja työkalu kieltäytyy,
jos `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGDATABASE` tai `PGPORT` on asetettu.
RK9-310:n harness käyttää omaa kantaansa `paperclip_rehearsal`, joten ajot eivät törmää.

Raportti tarkistaa ja kirjaa:

- journalin ja tiedostojen määrän, journalin `when`-järjestyksen ja prod-historian hashien tunnistuksen
  (rivit, joiden hash ei vastaa yhtäkään tiedostoa, ja fork-hashit, jotka puuttuvat historiasta);
- datavaikutuksen migraatiokohtaisesti ennen ajoa (0196, 0218, 0229, 0230, 0236) sekä kaikki `DROP TABLE` ja
  `DROP COLUMN` -lauseet, joiden kohteessa on rivejä;
- upstream-DDL:n, joka koskee fork-taulua tai luo olemassa olevan nimen (taulu, indeksi, constraint);
- assertit: historiarivien määrä on yhtä suuri kuin journalin entryjen määrä, jokaisella tiedostolla on
  historiarivi hashilla, 9001–9010-taulujen rivimäärät ovat ennen ja jälkeen samat;
- keston ja pisimmän `AccessExclusiveLock`-pidon (`pg_locks`-näytteenotto 20 ms välein) sekä vertailun
  ikkunaan (`--deploy-window-seconds`, oletus 300);
- `--schema-diff`: migratun prod-kopion rakenne (sarakkeet, indeksit, constraintit) vs. tuore kanta samasta puusta.

Poistumiskoodi 1, jos jokin assert kaatuu.

**Hash-pinnaus.** `check:migrations` (ja siten `build`, `typecheck`, `migrate`) vertaa jokaisen 9xxx-tiedoston
sha256:tta tiedostoon `packages/db/src/fork-migration-hashes.json`. `client.ts` tunnistaa ajetut migraatiot
tiedoston hashilla, joten muutettu 9xxx-tiedosto ajettaisiin prodia vasten uudelleen. Älä muokkaa 9xxx-tiedostoa;
uusi tiedosto lisätään kirjoittamalla sen hash pinnaustiedostoon. Testi: `migration-dry-run-lib.test.ts`.

### Koemergen tulokset 26.9.2026

Heitettävä koemerge: `origin/master` (`24f1f07b`) + upstream `v2026.916.1` (`d554c478`), 93 konfliktia, ratkaistu
vain sen verran, että `packages/db` ajaa (journal: upstream-entryt ensin, 9001–9010 perässä; muut konfliktit
upstreamin puolelta). Ei pushattu. Prod-kopio: `rehearsal-20260926-142518.dump`. Ajuri on merge-puun `client.ts`
(+380 riviä forkiin verrattuna).

**Journalin järjestys.** Merge-journalissa on 288 entryä ja tiedostoa; idx 126 ja 130 puuttuvat upstreamista
(numeroissa on aukko, ei tiedostoa). `check-migration-numbering.ts` hyväksyy aukot: se vaatii vain, että tiedostonimet ja
journalin tagit ovat samat, lajitellussa järjestyksessä ja ilman kaksoisnumeroita. Ajo merge-puussa läpäisi. Sama vaatimus
tarkoittaa, että 9xxx-migraatiot ovat aina journalin lopussa: fork-migraatiota ei voi sijoittaa upstream-migraation
väliin. Slotit 0126 ja 0130 ovat vapaat, jos fork-migraatio pitää ajaa ennen 0272:ta. Slotin tiedosto ei ole 9xxx, mutta
hash-pinnaus kattaa sen, kun sen nimi kirjataan `fork-migration-hashes.json`iin (pinnaus ja dry-runin fork-assertit käsittelevät
pinnatut nimet fork-tiedostoina).

**Hash-identiteetti.** Prod-historiassa on 85 riviä. Kaikki 85 hashia tunnistuvat merge-puun tiedostoihin, ja kaikki
kymmenen pinnattua 9xxx-hashia ovat historiassa. Prodissa on jo 0073 ja 0074 (forkin puu päättyy 0072:een), joten
pending on 203 migraatiota (0075…0279).

Osittainen tunnistus: kun yksikin hash tunnistuu, `loadAppliedMigrations` palauttaa osittaisen tunnistuksen. Kun **yksikään** hash ei tunnistu
(ja rivejä on), se heittää virheen (RK9-348; ei enää `created_at`-arvausta). Testit `migration-fallback.test.ts`
(kanta: embedded Postgres tai `PAPERCLIP_TEST_PGHOST` hostin socketilla):

- muutettu 9001-hash → 9001 näkyy pendinginä, upstream-migraatiot ajetaan, ja 9001:n uudelleenajo kaatuu äänekkäästi
  (`CREATE TABLE` ilman `IF NOT EXISTS`); fork-taulun rivit säilyvät. Rivin `IF NOT EXISTS` sisältävät 9xxx-migraatiot
  ajettaisiin hiljaa uudelleen, siksi pinnaus on tarpeen.
- nolla tunnistettua hashia, kun historiassa on rivejä → `loadAppliedMigrations` heittää virheen (RK9-348, korjattu).
  Aiemmin `inspectMigrations` otti `journal.slice(0, rivimäärä)` ja raportoi upstream-migraatiot (testissä 0071 ja 0072)
  ajetuiksi, vaikka ne eivät olleet ajettu. Merge-puussa 85 historiarivillä `slice(0, 85)` olisi kuitannut 0000…0084
  ajetuiksi (0075…0084 ei ole ajettu), ajuri olisi ajanut 0085 ja kaatunut 0086:ssa. Virheviesti kertoo rivimäärän,
  ensimmäisen tuntemattoman hashin ja ohjeen tarkistaa rivinvaihdot ja checkoutattu commit. `applyPendingMigrations`
  hylkää ajon ennen kuin mitään ajetaan. Osittainen tunnistus (vähintään yksi hash) toimii ennallaan. Tyhjä historia
  (0 riviä) on tuore kanta eikä heitä virhettä. Muutos on `client.ts`:ssä `// --- RK9 Custom (RK9-348) ---`
  -markerin sisällä, koska upstream muuttaa tiedostoa 916.1:een mennessä: tarkista marker trial-mergessä.
  Realistinen laukaisija: kaikkien tiedostojen sisältö muuttuu kerralla (esim. rivinvaihtojen muunnos checkoutissa).
  Testit: `it("throws when history has rows but no hash resolves")`, tyhjän historian testi ja
  `applyPendingMigrations`-hylkäystesti. PR: [#119](https://github.com/mv50000/paperclip/pull/119).

**Nimitörmäys (estää portaan 916.1).** Upstreamin `0272_light_kate_bishop.sql` tekee `CREATE TABLE IF NOT EXISTS
"email_messages"`. Forkin 9002 loi jo samannimisen taulun (50 528 riviä prodissa), joten `IF NOT EXISTS` ohittaa luonnin
ja seuraava lause kaatuu: `column "endpoint_id" referenced in foreign key constraint does not exist`. Seuraukset:

- Prod-kopio: 0075…0271 ajetaan, 0272 kaatuu ja rollbackaa oman transaktionsa; historiassa on 280 riviä 288:sta,
  kahdeksan migraatiota jää pendingiksi.
- Tuore kanta: upstream ajetaan ensin, ja 9002:n `CREATE TABLE "email_messages"` kaatuu. Tämä rikkoaa myös tuoreeseen
  kantaan perustuvat testit ja CI:n.
- Muita fork-taulujen törmäyksiä ei löytynyt. Muut samannimiset indeksit ja constraintit (0093, 0128, 0217, 0222)
  ovat drop-and-recreate-rakennuksia.

Kokeiltu korjaus: migraatio slotissa 0126 nimeää forkin taulun `rk9_email_messages`iksi ennen 0272:ta. Prod-polku menee
läpi (289/289 historiariviä, 50 528 riviä säilyy uudessa taulussa), mutta tuore kanta kaatuu edelleen 9002:ssa. 9011:tä
ei lisätty, koska rivejä ei häviä ja korjaus vaatii koodimuutoksen (`schema/email.ts` ja kuusi `server/src`-tiedostoa
käyttävät `email_messages`ia). Ratkaisu kuuluu merge-tikettiin (RK9-312…317), ennen porrasta 916.1. Vaihtoehdot:

1. Nimeä fork-taulu koodissa ja uudessa 9xxx-tiedostossa, ja tee tuoreen kannan 9002 nimikonfliktittomaksi
   korvaamalla se tietoisesti (uusi pin; prodissa uusi hash ajetaan kerran, joten sen pitää olla idempotentti). Suositus.
2. Patchaa upstreamin 0272 forkissa. Se ei ole vielä ajettu prodissa, mutta upstreamin chat-koodi käyttää samaa taulua,
   joten jokainen tuleva merge konfliktoituu.

**Datavaikutus (prod-kopio, rivimääriä).**

| Migraatio | Vaikutus |
|---|---|
| 0196 cloud sync | `cloud_upstream_*`-tauluja ei ole prodissa: ei menetystä |
| 0218 resolver-policy | saraketta `requested_resolver_policy` ei ole ennen ajoa: ei vanhoja rivejä uudelleenkirjoitettavana |
| 0229 | 1 yrityksellä `brand_color` (menetetään); `attachment_max_bytes` on 11 yrityksellä, kaikilla oletus 10485760 |
| 0230 better_auth issuer | 1 `account`-riviä, `credential` → `local:credential` |
| 0236 cheap modelProfiles | 0 agenttia (120:sta) ja 0 revisiota: ei muutettavaa |
| 0105 ympäristöt | `environments` 11 → 1 rivi (singleton-yhdistäminen), `company_id` poistuu |
| taustatäytöt | `principal_permission_grants` 134 → 374, `company_memberships` 59 → 75, `documents` 3 225 → 3 290, `document_revisions` 6 904 → 6 969, uusia rivejä `folders` 72, `routine_documents` 65, `routine_revisions` 65 |

Päätös 9011:stä: pre-migraatiota ei tarvita datamenetyksen takia. `brand_color` on yhden yrityksen ikonin sävy, jonka
upstream on poistanut käytöstä; arvo säilyy dumpissa. Fork-taulujen (9001–9010) rivimäärät pysyivät samoina 17 taulussa;
poikkeus on `email_messages`, jonka rivit siirtyivät kokeiltuun uuteen nimeen.

**Kesto ja lukot** (idle-kopio; rinnakkaisajo RK9-310:n kanssa lisäsi kohinaa). Kolme ajoa: 67 s ja 68 s (kaatuivat 0272:een, joten ne kattavat 0075…0271) ja 133 s (kokeiltu korjaus, kaikki 203).
Hitain migraatio oli `0205_narrow_shiva` (6–56 s), toiseksi `0134_run_responsible_user_invariant` (27–38 s, lukitsee
`companies`-taulun) ja `0227_modern_pandemic` (7–9 s). Pisin havaittu `AccessExclusiveLock` oli 29–56 s. Jokainen migraatio
ajetaan omassa transaktiossaan, joten lukko kestää siihen asti kun se päättyy. `dev:once` ajaa migraatiot käynnistyksessä,
joten palvelin ei vastaa ennen kuin kaikki 203 ovat valmiit. Runbookin ikkunan pituus on vielä auki (RK9-310:n mittaus);
300 sekunnin oletusikkunaan ajo mahtuu (22–44 %), mutta kuormitetun prodin lukkojonot eivät sisälly lukuun.
Varaa ikkunaan vähintään kaksinkertainen marginaali mitattuun kestoon nähden.

**Ei todennettu:** ajoa ei tehty muilla portailla (512…831.1) eikä prod-kuormitettuna; koemergen konfliktiratkaisu
on karkea, joten todellisen merge-puun `client.ts`:n ja journalin pitää ajaa työkalu uudelleen.

## Deploy ja rollback

Jokaisen tuotantoon menevän portaan deploy ja rollback ajetaan tiedoston
[`doc/upgrade/cutover-runbook.md`](upgrade/cutover-runbook.md) mukaan (RK9-307): ikkuna
outreach-erien ulkopuolelta, outreachin ja heartbeatien pysäytys, `scripts/pre-upgrade-snapshot.sh`,
fetch ja reset, preflight ja smoke, jatko ja 24 h seuranta. Merge masteriin deployaa 05:00Z-päivityksellä,
joten runbook asettaa `/etc/paperclip/update-hold`-tiedoston ennen mergeä. Perusrunko on osioissa
"Upgrade-prosessi" 1 ja 7; runbook ohittaa ne tuotannossa.

## Heartbeat-päätökset

Varattu heartbeat.ts:n konfliktien ratkaisupäätöksille (15 konfliktilohkoa 916.1:ssä).
Jokaisessa portaassa ajetaan yksi `claude_local`-heartbeat per aktiivinen yritys
harjoitusinstanssissa egress estettynä.

## ACPX

Varattu upstreamin ACPX-muutosten arvioinnille ja päätöksille. `claude_local`-moottorin
kiinnitys ja RK9-228-avainvartijan portaat kirjataan tiedostoon `doc/upgrade/acpx-claude-local.md`
(RK9-305; tiedosto tulee masteriin sen PR:n mukana).

Porras v2026.720.0 (RK9-314) teki pinnauksen: asettamaton `engine` ajaa CLI:llä. `acpx_local` poistui upstreamista,
joten RK9-312:n avainvartija siirtyi `claude_local`in ACP-haaraan.

## Upgrade-prosessi

### 1. Pre-flight

```bash
git status  # varmista puhdas working tree
pg_dump -Fc paperclip > /var/backups/paperclip-pre-upgrade-$(date +%Y%m%d).dump
```

Kirjaa pre-upgrade-SHA pysyvään paikkaan, ei `/tmp`:hen: lisää rivi osioon
"Porrasloki" (SHA, päiväys, tag) ja luo lisäksi git-tagi, joka säilyy uudelleenkäynnistysten yli:

```bash
git fetch origin
PRE=$(git rev-parse origin/master)
git tag "rk9/pre-upgrade-v2026.NNN.N" "$PRE"
git push origin "rk9/pre-upgrade-v2026.NNN.N"
```

Päivitä regressiomatriisi ennen mergeä (RK9-312). Lisää `doc/upgrade/regression-matrix.md`:n
committaulukkoon kaikki fork-commitit edellisen jäädytyksen jälkeen:

```bash
git log --no-merges --reverse --format='%h %s' <edellinen-freeze>..origin/master
```

Päivitä samalla Lähtötila-taulukon freeze-SHA ja lisää portaan todellinen konfliktilista.
Lisää uudet forkin testitiedostot `doc/upgrade/fork-tests.txt`:hen.

Aja lähtötilan savutesti: `scripts/upgrade-smoke.sh --offline --fork-tests`.
Aja harjoitusinstanssi porrasrefillä (osio "Harjoitusinstanssi") ennen mergeä:
`sudo -u paperclip scripts/upgrade-rehearsal.sh <ref>`, sen jälkeen `smoke` ja kerran `rollback`.

### 2. Fetch & inspect

```bash
git fetch upstream --tags
git log --oneline HEAD..v2026.NNN.N
git log --oneline HEAD..v2026.NNN.N -- packages/db/src/migrations/
```

### 3. Merge

```bash
git checkout -b upgrade/v2026.NNN.N origin/master
git merge v2026.NNN.N --no-commit
```

### 4. Ratkaise konfliktit

- Journal (`_journal.json`): upstream-migraatiot ensin, custom 9001+ jälkeen
- Hotspot-tiedostot: pidä molemmat puolet, upstream ylös, custom merkin alle
- `pnpm-lock.yaml`: hyväksy upstream, aja `pnpm install`. Pidä forkin omat riippuvuudet masterin
  versioissa: pinnaa ne hetkeksi tarkkaan versioon, aja `pnpm install`, palauta `^`-specifier ja aja
  `pnpm install` uudelleen. Lockfile saa muuttua vain `upgrade/v*`-branchissa: pre-commit-hook ja
  `pr.yml`:n "Block manual lockfile edits" sallivat sen niissä (`# --- RK9 Custom (RK9-312) ---`).
- Muut: regressiomatriisin konfliktitaulukon ratkaisusarake

### 5. Validoi

```bash
pnpm --filter @paperclipai/db check:migrations
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/shared build
pnpm -r typecheck
pnpm test:run
pnpm build
scripts/upgrade-smoke.sh --offline --fork-tests
scripts/upgrade-smoke.sh http://<harjoitusinstanssi>:<portti>
```

### 6. Commit & deploy

Porras-PR mergetään **merge-commitilla** (`gh pr merge --merge`), ei squashilla. Squash hävittää
upstream-historian, jolloin seuraava porras konfliktoi samoista muutoksista uudelleen ja
`git merge-base --is-ancestor v2026.NNN.N origin/master` on epätosi.

```bash
git commit -m "Merge upstream v2026.NNN.N"
git push origin upgrade/v2026.NNN.N
gh pr create --repo mv50000/paperclip --draft
```

PR mergetään masteriin vasta, kun kaikki PR-checkit ovat vihreitä ja harjoitusinstanssin
tarkistukset on kirjattu Porraslokiin.

### 7. Rollback

> **Älä käytä alla olevia komentoja.** `pg_restore --clean` jättää uuden version lisäämät sarakkeet ja taulut, eikä `git reset --hard` yksin kata versioimattomia tiedostoja. Käytä [cutover-runbookin](upgrade/cutover-runbook.md) osiota Rollback R1–R11.

```bash
# Koodi: git reset --hard rk9/pre-upgrade-v2026.NNN.N   (tai Porraslokin SHA)
# DB: pg_restore -d paperclip --clean /var/backups/paperclip-pre-upgrade-XXXXXXXX.dump
```

## Porrasloki

| Päivämäärä | Porras / tag | Pre-upgrade-SHA | Konflikteja | Smoke | Huomiot |
|-----------|--------------|-----------------|-------------|-------|---------|
| 2026-09-26 | lähtötila (ennen 512.0) | `9ed8e7704bd49da4064499de8477ae0a42e593e7` | 93 (koemerge 916.1) | 10/10 ok, fork-testit 68/69 paikallisesti | RK9-304; email-routes.test.ts vihreä vain CI:ssä |
| 2026-09-27 | v2026.512.0 | `3e7ff932008e8feb99e45553ab0ba74945417c9e` (tagi `rk9/pre-upgrade-v2026.512.0`) | 31 | HTTP 10/10, offline 2/2, fork-testit 73/75 harjoituksessa (2 korjattu, ks. huomiot) | RK9-312. Harjoitus prod-kopiolla (`rehearsal-20260927-054907.dump`): putki 154 s, käynnistyksen migraatiot 0075–0083 noin 4 s. Dry-run: 9 pendingiä 2,46 s, pisin AccessExclusiveLock 1,90 s, journal- ja hash-assertit OK; schema-diffin 3 FAILia ovat jaetun kannan vieraita tauluja (`_sqlx_migrations`, bookings, tenants…), tuoreesta kannasta ei puutu mitään. Rollback 60 s, rivimäärät ja skeemasormenjälki täsmäsivät. Korjatut fork-testit: gemini `isGeminiTurnLimitResult` (upstream tunnistaa vain rakenteiset syyt) ja outreach-draft-sequence (hook-aikakatkaisu kuormassa, yksin 8/8). |
| 2026-09-27 | v2026.609.0 | `e3aa869c6334993bc13e72c0dcf17c5f61ec356b` (tagi `rk9/pre-upgrade-v2026.609.0`) | 34 | HTTP 11/11, offline 3/3, fork-testit 77/77 harjoituksessa ja 78/78 builder-02:lla | RK9-313. Harjoitus prod-kopiolla (`rehearsal-20260927-080758.dump`, ref `d8713779`): putki 152 s, käynnistyksen migraatiot 0084–0098 (historia 94 → 109). Dry-run: 15 pendingiä 0,49 s, pisin AccessExclusiveLock 0,02 s (hitain `0085` 0,28 s), journal-, hash- ja fork-rivimääräassertit OK; schema-diffin 3 FAILia ovat taas jaetun kannan vieraita tauluja (`ai_conversations`, `bookings`, `_sqlx_migrations`…). Rollback 49 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean` ajettu. Koko vitest-sarja builder-02:lla (`pcp-remote-verify.sh`): general 245/246 → korjattu, serialized vihreä. Korjatut testit: ks. regressiomatriisi, osio "Konfliktit portaassa 609". Upstreamin `tasks:assign`-laajennus kovennettiin (ks. `defaults-hardening.md`). |
| 2026-09-27 | v2026.618.0 (porras 720, osa 1) | `06b877ab7f687028e205021df6a5216e8cfa9a1b` (tagi `rk9/pre-upgrade-v2026.618.0`) | 18 | HTTP 11/11, offline 3/3, fork-testit 79/79 harjoituksessa (ennen `trust-proxy-rk9.test.ts`:tä) ja 81/81 builder-02:lla | RK9-314. Koko vitest-sarja builder-02:lla: general-server 266/266, workspaces-a 272/272, workspaces-b vihreä (`ssh-fixture.test.ts` flakkasi kerran, yksin 3/3), serialized 106/106 tiedostoa GGU-809-sovituksen jälkeen. Harjoitus prod-kopiolla (`rehearsal-20260927-093718.dump`, ref `5035179e9`): putki 144 s, käynnistyksen migraatiot 0099–0102 (historia 109 → 113). Routine-API prod-kopiolla: list (12 routinea), create, edit ja run-now; paussatun agentin run-now epäonnistui oikein ("Agent is not invokable"), `process`-no-op-agentin run-now loi yhden routine runin, yhden issuen ja yhden assignment-ajon (lisäksi upstreamin `missing_issue_comment`-jatkoajo, joka on jo masterissa), ei kaksoisajoja 30 s seurannassa. Dry-run: 4 pendingiä 0,35 s, pisin AccessExclusiveLock 0,02 s (hitain `0100` 0,30 s), journal-, hash- ja fork-rivimääräassertit OK; schema-diffin 3 FAILia ovat jaetun kannan vieraita tauluja. Rollback 50 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean` ajettu. Korjatut testit: ks. regressiomatriisi, osio "Konfliktit portaassa 618". |
| 2026-09-27 | v2026.707.0 (porras 720, osa 2) | `a0ae4d43beff8a403ce97e1cd76bbd14793e138e` (tagi `rk9/pre-upgrade-v2026.707.0`) | 39 | HTTP 11/11, offline 3/3, fork-testit 80/80 harjoituksessa ja 81/81 builder-02:lla | RK9-314. Koko vitest-sarja builder-02:lla: general 288/292 tiedostoa ensimmäisellä ajolla, 4 failaavaa tiedostoa korjattu ja ajettu erikseen vihreiksi; serialized 116/116. Harjoitus prod-kopiolla (`rehearsal-20260927-111616.dump`, ref `a2a82796f`): putki 194 s, käynnistyksen migraatiot 0103–0135 (historia 113 → 144). Routine-API: `process`-no-op-agentin run-now loi yhden routine runin, yhden issuen ja yhden assignment-ajon (lisäksi upstreamin `missing_issue_comment`-jatkoajo), ei kaksoisajoja 30 s seurannassa. Dry-run: 31 pendingiä 24,1 s, hitain `0134` 19,6 s ja samalla pisin AccessExclusiveLock (`companies`), toiseksi hitain `0131` 2,6 s; journal-, hash- ja fork-assertit OK; schema-diffin 3 FAILia ovat jaetun kannan vieraita tauluja. Rollback 53 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean` ajettu. Vastuukäyttäjädata: ks. `defaults-hardening.md`, "Porras v2026.707.0". |
| 2026-09-27 | v2026.720.0 (porras 720, osa 3) | `7a2ceba556621ed2dbb6270ad788f5e203f2b082` (tagi `rk9/pre-upgrade-v2026.720.0`) | 42 | HTTP 11/11, offline 3/3, fork-testit 79/79 harjoituksessa ja 82/82 builder-02:lla | RK9-314. Koko vitest-sarja builder-02:lla: general-server 327/327, workspaces-a 370/370 + 44/44, workspaces-b 42/42 + 4/5 (skill-kuvausten pituusraja, korjattu), serialized 128/128. CI löysi lisäksi forkin SEC-91-UI-testin, upstreamin local-background-recovery-testit (RK9-87) ja kaksi teardown-flakea; korjattu. Harjoitus prod-kopiolla (`rehearsal-20260927-123935.dump`, ref `4db8db584`): putki 135 s, käynnistyksen migraatiot 0136–0181 (historia 144 → 190), 0 uutta built-in-agenttia. Routine-API: yksi routine run, yksi issue, yksi assignment-ajo ja upstreamin jatkoajo, ei kaksoisajoja 30 s seurannassa. Dry-run: 46 pendingiä 1,41 s, pisin lukko 0,24 s (`activity_log`); schema-diffin 3 FAILia ovat jaetun kannan vieraita tauluja. Rollback 52 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean` ajettu. |
| 2026-09-27 | v2026.817.0 (porras 4) | `d27bd45d3e77d3ae6883739c29423bd62a077f45` (tagi `rk9/pre-upgrade-v2026.817.0`) | 39 | HTTP 11/11, offline 3/3, fork-testit 84/84 (1121 testiä) harjoituksessa | RK9-315. Typecheck builder-02:lla (`pnpm -r typecheck`, cli tarvitsee `NODE_OPTIONS=--max-old-space-size=6144`). Harjoitus prod-kopiolla (`rehearsal-20260927-143012.dump`, ref `01856fe0`): putki 259 s, käynnistyksen migraatiot 0182–0211 (historia 190 → 220). Reititys ennen ja jälkeen (email_routes 11, issues 30 844 statuksineen, assigneineen ja execution policyineen, interaktiot 62, outreach, agentit 120): identtinen. `experimental`-työtilaliput pysyivät `false`. Dry-run: 30 pendingiä 11,2 s, hitain `0205_narrow_shiva` 7,4 s ja samalla pisin AccessExclusiveLock 7,35 s (`issue_comments`); journal-, hash- ja fork-rivimääräassertit OK; `0196`:n tauluissa 0 riviä; schema-diffin 3 FAILia ovat jaetun kannan vieraita tauluja. Rollback 91 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean` ajettu, dumppi poistettu. |
| 2026-09-27 | v2026.831.1 (porras 5) | `917ae45d85605e3a622e6c0da4ff170728b7d062` (tagi `rk9/pre-upgrade-v2026.831.1`) | 32 | HTTP 11/11, offline 2/2, fork-testit 85/85 (1172 testiä) builder-02:lla | RK9-316. Typecheck builder-02:lla: 32 pakettia vihreänä, `server` ja `paperclip-runner` ilman cargoa TS-buildin kautta (ks. regressiomatriisi, "Konfliktit portaassa 831"). Harjoitus prod-kopiolla (`rehearsal-20260927-162340.dump`, ref `654410a6`): putki 272 s, käynnistyksen migraatiot 0212–0230 noin 15 s (historia 220 → 239). `experimental`-työtilaliput pysyivät `false`, `enableNativeRunner`-avainta ei ole (oletus `false`). `account.issuer` täytetty (0 NULLia) ja uniikki-indeksi luotu. Dry-run: 19 pendingiä 9,03 s, hitain `0227` 7,11 s ja pisin AccessExclusiveLock 7,09 s; journal-, hash- ja fork-rivimääräassertit OK (18 taulua). Vaikutukset: `0212`, `0226` ja `0230` 0 duplikaattia, `0218` muuttaa 62 interaktiota `board_only` → `human_only`, `0227` koskee 58 164 run-eventtiä ja 19 283 runia. 0229-auditointi: `brand_color` vain RK9:llä (kosmeettinen), `attachment_max_bytes` 10 MiB kaikilla 11 yhtiöllä = deploymentin oletus, ei siirrettävää dataa. Schema-diffin FAILit ovat jaetun kannan vieraita tauluja. Rollback 87 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean --dumps` ajettu. |
| 2026-09-27 | v2026.916.1 (porras 6) | `9ebd60b333c3a743ffa1faa7c29ca3cb862f8d74` (tagi `rk9/pre-upgrade-v2026.916.1`) | 56 | HTTP 12/12 (uusi `outreach-send-queue`-tarkistus sender-avaimella), offline 2/2, koko vitest builder-02:lla (kaikki ryhmät) | RK9-317. Typecheck builder-02:lla vihreä (`server` ja `paperclip-runner` ilman cargoa TS-buildin kautta, `packages/db` myös skriptit). Vitestissä jäljelle jäävät vain `cargo`a vaativa `native-codex-runner.integration` ja kaksi ajoituksesta riippuvaa upstream-testiä (`adapter-utils`), joihin fork ei koske; muut 38 kaatunutta testiä sovitettiin (regressiomatriisi, "Konfliktit portaassa 916"). Harjoitus prod-kopiolla (`rehearsal-20260927-214724.dump`): putki 293 s, käynnistys ajoi 52 pendingiä (0126, 0231–0279, 9000, 9011) noin 16 s:ssa (historia 239 → 291). `email_messages`-jako: 50 528 forkin riviä taulussa `rk9_email_messages`, upstreamin AgentMail-taulu `email_messages` (sarake `endpoint_id`) tyhjänä, `rk9tmp_email_messages` puuttuu. `experimental`-liput ennallaan; `enableNativeRunner`-avainta ei ole, joten pre-deploy-SQL tarvitaan (testattu kopiolla: `UPDATE 1`, arvo `false`). 0236 ei koskenut yhteenkään agenttiin, ja kaikilla 26 elävällä `claude_local`-agentilla on eksplisiittinen malli. Dry-run: 52 pendingiä 14,55 s, hitain `0235` 11,03 s, pisin AccessExclusiveLock 0,30 s; journal-, hash-, pending-fork- (`--expect-pending-fork`) ja fork-rivimääräassertit OK (18 taulua). Schema-diffin 3 FAILia ovat jaetun kannan vieraita tauluja. Rollback 84 s, rivimäärät ja skeemasormenjälki täsmäsivät. `clean --dumps` ajettu. |

## Upgrade-loki

| Päivämäärä | Versio | Huomiot |
|-----------|--------|---------|
| 2026-04-28 | v2026.427.0 | Ensimmäinen upgrade; 9000-renumbering; 2 konflikti (journal, test) |
| 2026-09-27 | v2026.512.0 | Porras 1/6 (RK9-312). 31 konfliktia, migraatiot 0075–0083 (prodissa jo 0073–0074), migraatioiden kesto prod-kopiolla 2,5–4 s. Upstream toi `pr.yml`:ään jobit `verify_serialized_server` ja `canary_dry_run` rivillä `runs-on: ubuntu-latest` (automerge ohitti vivun, `upgrade-smoke.sh --offline` löysi). Gitleaks skannaa porras-PR:n upstream-commitit: väärät positiiviset `.gitleaksignore`en sormenjäljellä. PR mergetään merge-commitilla, ei squashilla. |
| 2026-09-27 | v2026.609.0 | Porras 2/6 (RK9-313). 34 konfliktia, migraatiot 0084–0098, kesto prod-kopiolla 0,49 s (pisin lukko 0,02 s). Upstream toi `commitperclip-review.yml`:n (`pull_request_target`), joka poistettiin, ja jakoi `verify`-jobin neljään; kaikki saivat runner-vivun. Oikeusmalli siirtyi `access.decide`en: hire-sääntö ennallaan, agenttien `tasks:assign`-laajennus kovennettiin RK9 Custom -lohkolla. Pre-push-hookin koko typecheck ajettiin builder-02:lla (`pcp-remote-verify.sh`) ja push `--no-verify`. PR mergetään merge-commitilla. |
| 2026-09-27 | v2026.618.0 | Porras 3/6, osa 1 (RK9-314). Suora 720-merge olisi antanut 60 konfliktia ja 83 migraatiota, joten porras pilkottiin (618 → 626/707 → 720). 18 konfliktia, migraatiot 0099–0102, kesto prod-kopiolla 0,35 s. Upstream toi `agent-runtime-images.yml`:n (runner-vipu + upstream-only-ehto) ja `TRUST_PROXY`n (asetus `loopback`, testi `trust-proxy-rk9.test.ts`). GGU-809-recovery-testit mukautettiin RK9-87:ään. PR mergetään merge-commitilla. |
| 2026-09-27 | v2026.707.0 | Porras 3/6, osa 2 (RK9-314). 39 konfliktia, migraatiot 0103–0135 (upstreamista puuttuvat 0126 ja 0130; forkin journal-idx 136–145), kesto prod-kopiolla 24 s. Upstream toi vastuukäyttäjämallin (ajo vaatii vastuukäyttäjän, agentin oikeudet leikataan vastuukäyttäjän oikeuksilla) ja ajastuksen eston env-lipuilla. Forkin RK9-231-idle-portti pidettiin upstreamin `skipTimerWhenNoActionableWork`in edellä. `IssueProperties` pilkottiin hakemistoksi; SEC-91-rivi siirrettiin. PR mergetään merge-commitilla. |
| 2026-09-27 | v2026.720.0 | Porras 3/6, osa 3 (RK9-314). 42 konfliktia, migraatiot 0136–0181 (forkin journal-idx 182–191), kesto prod-kopiolla 1,4 s. Porrasta ei pilkottu, koska 707 ja 720 ovat vierekkäiset tagit. Upstream teki ACP:stä `claude_local`in oletusmoottorin ja poisti `acpx_local`in: fork pinnaa asettamattoman moottorin CLI:hin ja siirsi RK9-312:n avainvartijan ACP-haaraan. Built-in-agenttien automaattiluonti on forkissa `enableBuiltInAgents`-lipun takana, oletusgrantit vain lisäävät puuttuvia rivejä, ja ACP-lapsi ei peri palvelimen `PAPERCLIP_*`-asetuksia. Cutoverissa kirjoitetaan työtilan korjauslippujen arvoksi `false` (ks. `defaults-hardening.md`). PR mergetään merge-commitilla. |
| 2026-09-27 | v2026.817.0 | Porras 4/6 (RK9-315). 39 konfliktia, migraatiot 0182–0211 (forkin journal-idx 212–221), kesto prod-kopiolla 11 s. Upstream poisti cloud syncin (`0196`), toi resolver-politiikan (`0203`, oletus `board_only`), managed configin (`PAPERCLIP_MANAGED_CONFIG`, asettamatta) ja default-open-issue-kirjoitukset näkyville vertaisissueille. Forkin `tasks:assign`-kovennus (RK9-313) pidettiin. Blocked-tilaan siirto vaatii nyt syyn (blocker, odottava interaktio tai `unblockDescriptor`), muuten 422. ACP-wrapper pidettiin ilman env-tiedostoa. PR mergetään merge-commitilla. |
| 2026-09-27 | v2026.831.1 | Porras 5/6 (RK9-316). 32 konfliktia, migraatiot 0212–0230 (forkin journal-idx 231–240), kesto prod-kopiolla 9 s. Upstream toi Node `>=24.11.0`:n, zod 4:n, TypeScript 7:n, better-auth 1.7:n (`account.issuer`, `0230`), Rust-runnerin (`@paperclipai/paperclip-runner`, oletus pois) ja agentin JWT:n oletus-TTL:n 48 h (ennen 1 h). Uusi CI-tarkistus `check-pr-migration-order.mjs` tehtiin sarjatietoiseksi (fork 9xxx erikseen), Node-politiikka ohittaa SES-Lambdan. Upstream poisti Heartbeats-asetussivun; forkin ajolaskuri siirtyi yleisiin instanssiasetuksiin. PR mergetään merge-commitilla. |
| 2026-09-27 | v2026.916.1 | Porras 6/6 (RK9-317). 56 konfliktia (kaksi add/add: `schema/email.ts`, `routes/email.ts`), migraatiot 0231–0279 (forkin journal-idx 280–291), kesto prod-kopiolla 15 s. Upstreamin AgentMail-taulu `email_messages` törmäsi forkin Resend-tauluun: forkin taulu on nyt `rk9_email_messages` (slot-migraatio `0126`, tuoreen kannan polku `9000` + `9011`). Upstream poisti productivity reviewt ja halvat model profilet (`0236`), toi `DEFAULT_CLAUDE_LOCAL_MODEL = "claude-opus-5"` (hyväksytty), `enableNativeRunner`- ja `enableStreamlinedUi`-oletukset `true`, announcements-feedin (fork: `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`) ja `canCreateAgents`-oletuksen kaikille (fork: vain CEO). PR mergetään merge-commitilla. |
