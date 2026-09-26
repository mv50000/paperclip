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

Seuraava vapaa numero: **9011** (tarkistettu 2026-09-26: `packages/db/src/migrations/`
ei sisällä 9011+-tiedostoja).

Upstream käyttää 0000-sarjaa. Numerot eivät törmää (~17 vuoden marginaali).
Journalissa (`meta/_journal.json`) upstreamin 0xxx-rivit ovat aina ensin ja 9001–9010
niiden jälkeen numerojärjestyksessä. `scripts/upgrade-smoke.sh --offline` tarkistaa tämän.

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
- `skills/paperclip/SKILL.md` (3) ja `skills/paperclip-dev/SKILL.md` (modify/delete)
- `scripts/provision-worktree.sh`
- `server/src/services/index.ts`, `packages/db/src/schema/index.ts`, `packages/shared/src/index.ts`, `packages/shared/src/constants.ts` — exportit

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
| Proxy trust | `TRUST_PROXY=loopback`: Express luottaa vain paikalliseen nginxiin, joka luottaa vain edgeen `192.168.1.17` (`set_real_ip_from`); `PAPERCLIP_ALLOWED_HOSTNAMES` ja `PAPERCLIP_PUBLIC_URL` kattavat `paperclip.rk9.fi`:n (asetettu jo nyt) | `TRUST_PROXY` asettamatta | `TRUST_PROXY` v2026.720.0, guardin `X-Forwarded-Host`-rajaus v2026.916.0 (porras 916.1) | env, `export` tiedostossa `paperclip-start.sh` |
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

`created_at`-fallback ei laukea, kun yksikin hash tunnistuu: `loadAppliedMigrations` palauttaa silloin osittaisen
tunnistuksen. Fallback laukeaa vain, kun **yksikään** hash ei tunnistu. Testit `migration-fallback.test.ts`
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
  `applyPendingMigrations`-hylkäystesti. PR: RK9-348 (linkki lisätään PR:n avauksen jälkeen).

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
- `pnpm-lock.yaml`: hyväksy upstream, aja `pnpm install`
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

## Upgrade-loki

| Päivämäärä | Versio | Huomiot |
|-----------|--------|---------|
| 2026-04-28 | v2026.427.0 | Ensimmäinen upgrade; 9000-renumbering; 2 konflikti (journal, test) |
