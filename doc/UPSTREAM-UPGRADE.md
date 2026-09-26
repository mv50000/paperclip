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

## Porrastusmalli

Upstream päivitetään tagi kerrallaan, ei suoraan `upstream/master`iin. Vahvistettu
porrastus (tagit ja commitit: regressiomatriisi, osio "Lähtötila"):

`v2026.512.0` → `v2026.609.0` → `v2026.720.0` → `v2026.817.0` → `v2026.831.1` → `v2026.916.1`

Jokainen porras on oma branch (`upgrade/v2026.NNN.N`) ja oma PR. Porras mergetään
masteriin vasta, kun regressiomatriisin pakolliset tarkistukset ovat vihreitä
harjoitusinstanssissa. Seuraava porras aloitetaan edellisen mergetystä masterista.
Kirjaa jokainen porras osioon "Porrasloki".

## Node 24

Upstream vaatii `engines.node >=24.11.0` (tarkistettu tageista `v2026.916.1` ja
`upstream/master`). Fork vaatii nyt `>=20`, ja paperclip-01 ajaa Node 22:ta. Node pitää
päivittää 24.11:een tai uudempaan viimeistään ennen portaan, jonka `package.json`
nostaa vaatimuksen, mergeä. Päivitä samalla CI-runnerit (builder, builder-fast) ja
tuotannon systemd-palvelun Node. Toteutus ja tarkka porras: kirjataan tähän osioon.

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

## Deploy ja rollback

Varattu deploy- ja rollback-lapselle. Perusrunko on osioissa "Upgrade-prosessi" 1 ja 7.

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
