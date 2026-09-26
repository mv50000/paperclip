# Cutover-runbook — tuotantodeploy per upstream-porras

Päivitetty 2026-09-26 ([RK9-307](/RK9/issues/RK9-307), epic [RK9-303](/RK9/issues/RK9-303)).
Tämä runbook on `doc/UPSTREAM-UPGRADE.md`:n osion "Deploy ja rollback" sisältö. Jokainen
tuotantoon menevä porras ajetaan tämän mukaan: `v2026.512.0`, `v2026.609.0`, `v2026.720.0`,
`v2026.817.0`, `v2026.831.1` ja `v2026.916.1` ([RK9-310](/RK9/issues/RK9-310), [RK9-312](/RK9/issues/RK9-312)…[RK9-317](/RK9/issues/RK9-317)).

Runbook suojaa kahta asiaa: outreachin lähetyseriä ([RK9-198](/RK9/issues/RK9-198)) ja saapuvia
vastauksia. Kaksi tosiasiaa ohjaa koko järjestystä:

- **Merge masteriin deployaa.** `paperclip-update.sh` vetää masterin joka päivä klo 05:00Z, ajaa
  `pnpm install` ja restarttaa palvelun. Ilman holdia portaan merge deployaa itsensä ilman pysäytystä
  ja ilman ihmistä paikalla.
- **SYSTEM_PAUSE ei pysäytä outreach-lähetystä.** SYSTEM_PAUSE ja yrityksen pause estävät uudet
  agenttiajot (`heartbeat.ts`, `routines`). Outreach-schedulerin lähetyssilmukka
  (`server/src/services/outreach/scheduler.ts`) lukee vain lähettäjäpysäytykset
  (`outreach_sender_pauses`). Lähetys pysäytetään erikseen, ja pysäytys todennetaan raportilla.

## Säännöt (operaattorin päätökset 26.9.)

1. Instanssi pysäytetään vain tuotantoon meneviin portaisiin ([RK9-310](/RK9/issues/RK9-310), [RK9-312](/RK9/issues/RK9-312)…[RK9-317](/RK9/issues/RK9-317)) ja vain ikkunan ajaksi. Aallot, jotka eivät koske prodiin, eivät pysäytä mitään.
2. Globaalia keskeytystä ei tehdä epicin ajaksi. Muiden yritysten rutiinit ja issuet jatkavat ikkunoiden välillä.
3. `mv50000/paperclip`in master jäädytetään merge-haaran avaamisesta tuotantodeployn valmistumiseen. Siihen ei mergetä muita PR:iä. Jäädytys ei koske muiden yritysten repoja.
4. Ensimmäinen tuotantoikkuna on aikaisintaan **4.10.2026**. Syy: QUA-1007:n paper-forward kerää dataa 3.10. asti, ja QUA-1207:n pariteettiajo vaatii vähintään 14 vuorokauden yhtäjaksoisen ajon.
5. Ikkuna valitaan RK9-198:n lähetyserien ulkopuolelta. Ikkunan pituus mitoitetaan Node 24 -dry-runin mittauksesta ([RK9-310](/RK9/issues/RK9-310)); alla olevat aikarajat ovat alustavia.
6. **Rollback on sallittu vain ennen outreachin jatkamista** (vaihe 6). Sen jälkeen korjataan eteenpäin, ellei ikkunan dataa exportata ja replayata (ks. "Rollback").

## Työkalut

Aja skriptit masterin kloonista (operaattorin masterin klooni), ei `/opt/paperclip`ista: tuotantopuu ei sisällä niitä ennen kuin tämä PR on deployattu.
Kaikki skriptit ovat vain luku -tilassa lähdekantaan; snapshot kirjoittaa vain omaan hakemistoonsa ja väliaikaiseen scratch-kantaan.

| Työkalu | Tehtävä |
|---|---|
| `scripts/outreach-window-report.sh snapshot\|compare\|export` | Outreach-jono, viimeisin lähetys, käsittelemättömät vastaukset ennen ja jälkeen. `compare` vertaa viestejä id:llä ja löytää hävinneet ja kaksinkertaistuneet. `export` tallentaa ikkunan rivit rollbackia varten. |
| `scripts/pre-upgrade-snapshot.sh --tag <porras>` / `--verify <hakemisto>` | SHA:t, `pg_dump -Fc`, palautus scratch-kantaan ja rivimäärävertailu, paikallisten muutosten patch ja versioimattomien tiedostojen tar. `--verify` todentaa kannan rollbackin jälkeen. |
| `scripts/prod-untracked-check.sh --repo /opt/paperclip --target <ref>` | Luokittelee versioimattomat tiedostot, löytää versioidut paikalliset muutokset ja törmäykset kohde-refin kanssa. Luokitus: `scripts/prod-untracked.manifest`. |
| `scripts/upgrade-smoke.sh` | Savutesti ([RK9-304](/RK9/issues/RK9-304)). |
| `/usr/local/bin/paperclip-preflight.sh` | `ExecStartPre`. Fork-ankkurit, migraatio 9010, host-env-suodatin, Node ≥ 24.11. Lähde: `~/.claude/hosts/paperclip/paperclip-service/`. |
| `/etc/paperclip/update-hold` | Tiedosto ohittaa 05:00Z-päivityksen. Lähde: `~/.claude/hosts/paperclip/paperclip-update/paperclip-update.sh`. |

Ympäristö kaikille komennoille (operaattorin shell, arvoja ei kirjata mihinkään):

```bash
read -rs DATABASE_URL && export DATABASE_URL   # tuotantokannan URL; salaisuus, ei komentohistoriaan
read -rs BOARD_TOKEN                            # board-API-avain; vain API-kutsuihin
export API=http://127.0.0.1:3100
. scripts/lib-pg-url.sh                         # masterin kloonin juuresta
# Salasana ja token eivät saa näkyä prosessilistassa (/proc/<pid>/cmdline): psql saa yhteyden
# ympäristömuuttujilla ja curl otsikon tiedostokuvaajasta.
dbpsql() { pg_with "$DATABASE_URL" psql "$@"; }
api() { curl -fsS --config <(printf 'header = "Authorization: Bearer %s"\n' "$BOARD_TOKEN") "$@"; }
```

## Vaihe 0 — Kertaluonteiset esivaatimukset (ennen ensimmäistä ikkunaa)

Nämä ovat tuotantomuutoksia, ja **operaattori ajaa ne itse**. Tämä tiketti ei ajanut niitä.

| # | Komento | Tarkoitus | Todennus |
|---|---|---|---|
| 0.1 | Ei toimenpidettä: **älä lisää `safe.directory`-riviä.** Todenna: `sudo -u paperclip git -C /opt/paperclip status --short` toimii ilman virhettä. | `/opt/paperclip` on käyttäjän `paperclip` omistuksessa, ja palvelu ajaa git-komennot (`paperclip-preflight.sh`, `paperclip-update.sh`) sinä. "Dubious ownership" koskee vain muita käyttäjiä (todennettu 26.9.: `sudo git -C /opt/paperclip rev-parse HEAD` rootina kieltäytyy). Järjestelmätason `safe.directory` olisi vaarallinen: `/opt/paperclip/.git/config` on agenttien (`paperclip`) kirjoitettavissa, ja repon konfiguraatio voi ajaa koodia (`core.fsmonitor`, `diff.external`, hookit) sen kutsujana. Operaattorin päätös 12.9.2026 (`hosts/paperclip/README.md`): operaattorin käyttäjä ei luota paperclip-omisteisiin repoihin. Siksi tämän runbookin skriptit ajavat gitin repon omistajana (`sudo -n -u paperclip git`, `scripts/lib-repo-git.sh`), ja käsin ajettavat komennot kulkevat `sudo -u paperclip git -C /opt/paperclip ...`. | `sudo -u paperclip git -C /opt/paperclip status --short`; lisäksi `git config --global --get-all safe.directory` ja `git config --system --get-all safe.directory` eivät saa listata paperclip-omisteisia repoja (26.9. listassa oli `/opt/paperclip`, ristiriidassa 12.9. päätöksen kanssa: poista `git config --global --unset-all safe.directory` tai rivit käsin, päätös operaattorilla) |
| 0.2 | `sudo ~/.claude/hosts/paperclip/paperclip-update/install.sh --apply <commit>` | Asentaa hold-tuen `paperclip-update.sh`:iin. Käytä `~/.claude`-repon commitia `9c66c3e` tai myöhempää (`06e1c6d` ja aiemmat asentavat vielä järjestelmätason `safe.directory`n). | `grep -c update-hold /usr/local/bin/paperclip-update.sh` ≥ 1 |
| 0.3 | Node 24 asennetaan ([RK9-310](/RK9/issues/RK9-310)). | Uusi preflight estää palvelun käynnistyksen, jos Node < 24.11. paperclip-01 ajaa 26.9. Node 22.22.1:tä, joten **älä asenna preflightia ennen Node 24:ää**. | `sudo -u paperclip env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin node --version` |
| 0.4 | `sudo ~/.claude/hosts/paperclip/paperclip-service/install.sh` (tarkistus), sitten `sudo ./install.sh --apply <commit>` (`9c66c3e` tai myöhempi) | Asentaa uuden `paperclip-preflight.sh`:n. Aja vain, kun 0.3 on tehty: `install.sh` hylkää uuden preflightin, jos palvelun PATHin Node on alle 24.11 (todennettu `install-test.sh`:lla). Asennin ei restarttaa. | `sudo -u paperclip /usr/local/bin/paperclip-preflight.sh; echo $?` tulostaa `OK`-rivin ja `0` |
| 0.5 | `sudo install -d -m 700 -o "$USER" /var/backups/paperclip-pre-upgrade` | Snapshotien kohde (hakemisto 0700, tiedostot 0600). Tarkista levytila: `df -h /var/backups` (dump + scratch-palautus vaativat 2 × kannan koon). | `df -BG --output=avail /var/backups` |
| 0.6 | Anna käyttäjälle, jolla `DATABASE_URL` yhdistää, `CREATEDB` (scratch-kantaa varten), tai aseta `SNAPSHOT_ADMIN_URL` toiselle käyttäjälle. | `pre-upgrade-snapshot.sh` luo ja pudottaa kannan `pcp_restore_check_*`. | `dbpsql -c "select rolcreatedb from pg_roles where rolname = current_user"` |

**Versioimattomat ja paikalliset tiedostot** (`/opt/paperclip`, tarkistettu 26.9.). `git fetch && git reset --hard` ei poista versioimattomia tiedostoja, koska vain `git clean` poistaa. Se **hävittää versioidut paikalliset muutokset** ja ylikirjoittaa polun, joka on kohde-refissä versioituna. Luokitus on tiedostossa `scripts/prod-untracked.manifest`; yhteenveto:

| Tiedosto | Luokka | Toimi |
|---|---|---|
| `voice-gateway/` | preserve | Ei repoa. Varmuuskopioidaan snapshotissa. Seurantatiketti: siirto omaan repoon. |
| `decrypt-secret.cjs` | secret | Salaisuuksiin liittyvä. **Ei commitoida mihinkään repoon.** Varmuuskopio 0600. |
| `wh.psd1.template` | preserve | Ei repoa. Varmuuskopioidaan. |
| `aur-kattoterassit-prod.csv`, `aur-homev2-snapshot.md`, `sunspot-snapshot.md` | preserve | Sunspotin dataa. Kuuluu Sunspot-repoon tai vaulttiin; seurantatiketti. |
| `qua-*.png`, `sunspot-*.png` | artifact | Kertaluonteisia kuvia. Voivat hävitä. |
| `data/`, `server/data/`, `.paperclip/`, `cli/.paperclip/` | runtime | Ajonaikainen tila. Varmuuskopioidaan. |
| `*/dist/`, `ui/tsconfig.tsbuildinfo`, Playwright-tulokset | generated | Rakennetaan uudelleen. |
| `infra/` | — | Versioitu (`infra/ses-forwarder`); ei versioimatonta sisältöä. |
| `.claude/scheduled_tasks.lock` | tolerated | Versioitu lukkotiedosto; reset saa hävittää sen. |

**Versioidut paikalliset muutokset** (`git diff HEAD` 26.9.), jotka `reset --hard` hävittäisi ja jotka pitää ratkaista ennen ensimmäistä ikkunaa:

| Tiedosto | Muutos | Ratkaisu |
|---|---|---|
| `server/scripts/process-adapters/cicd-failure-watch.sh` | repolista `mv50000/*` → `rk9-ai/*` (10.9. org-siirto) | Vie muutos masteriin PR:llä. Muuten reset palauttaa vanhat repot. |
| `skills/prh-prospector/SKILL.md` | lisäys: firecrawl-ohje SPA-sivuille | Vie masteriin PR:llä tai hylkää tietoisesti. |
| `.gitignore` | paikallinen versio poistaa `dist/`-, `.env`- ja muita ignore-rivejä (siksi `dist/`-hakemistot näkyvät versioimattomina) | Tarkista `sudo -u paperclip git -C /opt/paperclip diff .gitignore`. Hylkää oletuksena: master on oikea. |

`prod-untracked-check.sh` palauttaa exit 1, kunnes kaikki löydökset on ratkaistu (26.9. ajossa neljä: kolme paikallista muutosta ja luokittelematon `.claude/settings.local.json`, joka katoaa, kun paikallinen `.gitignore` palautetaan). Tarkistus on vaiheen 1 go/no-go.

## Vaihe 1 — Ikkunan valinta ja esitarkistus (T-2 vrk … T-0)

Aikaraja: valmis ennen ikkunan alkua. Ei prod-muutoksia paitsi update-holdi.

1. Valitse ikkuna RK9-198:n lähetyserien ulkopuolelta. Katso lähetyserien aikataulu tiketistä [RK9-198](/RK9/issues/RK9-198) ja jonon tila: `scripts/outreach-window-report.sh snapshot --label t-1 --out /tmp/window-t-1.json`. Ikkuna alkaa, kun `jono (queued)` on 0 ja seuraava erä on vähintään ikkunan pituuden päässä. Jono ei saa olla ei-tyhjä: `send-queue` ei lukitse viestiä, joten jonoon jäänyt viesti voi lähteä uudelleen palautuksen jälkeen.
2. Tarkista, ettei käynnissä ole yhtäjaksoisuutta vaativaa ajoa (QUA-1007 paper-forward, QUA-1207 pariteettiajo). Ikkuna on aikaisintaan 4.10.
3. **Aseta update-holdi** ennen kuin merge-haara avataan: `sudo install -m 644 /dev/null /etc/paperclip/update-hold`. Kirjaa syy: `echo "cutover <porras> <päivämäärä>" | sudo tee /etc/paperclip/update-hold`. Ilman holdia 05:00Z-päivitys deployaa mergen.
4. Jäädytä masterin merge-liikenne (sääntö 3): ilmoita kanavalla ja lisää PR:ään otsikko `[FREEZE]` kunnes vaihe 6 on valmis.
5. Tarkista puun tila: `scripts/prod-untracked-check.sh --repo /opt/paperclip --target origin/master` (kohteena on porras-branch mergen jälkeen `origin/master`).
6. Aja preflight kuivana: `sudo -u paperclip /usr/local/bin/paperclip-preflight.sh`.
7. Aja savutesti nykytilaa vasten: `scripts/upgrade-smoke.sh --offline --fork-tests`.

**Go**, kun: (a) `jono (queued)` on 0 ja seuraava erä on ikkunan ulkopuolella, (b) `prod-untracked-check.sh` exit 0, (c) preflight exit 0, (d) update-holdi on paikallaan, (e) porras-PR:n kaikki checkit ovat vihreitä ja harjoitusinstanssin tarkistukset on kirjattu Porraslokiin.
**No-go**: mikä tahansa yllä oleva puuttuu. Siirrä ikkunaa. Mitään ei ole vielä muutettu, joten rollbackia ei tarvita.

## Vaihe 2 — Outreach ja heartbeatit pysäytetään (T+0, aikaraja 15 min)

Tämä vaihe käynnistää ikkunan. Kello alkaa tästä.

1. **Ennen-tila:** `scripts/outreach-window-report.sh snapshot --label before --out /var/backups/paperclip-pre-upgrade/<porras>-before.json`. Kirjaa erityisesti `aktiiviset lähettäjäpysäytykset`: ne ovat jo ennen ikkunaa pysäytettyjä lähettäjiä, joita **ei saa jatkaa** vaiheessa 6 (automaattinen pause = todellinen ongelma).
2. **Lähettäjät pauselle.** Hae lähettäjät: `dbpsql -Atc "select distinct sender_identity from outreach_sequences"`. Jokaiselle, jolla ei ole aktiivista pausea:
   ```bash
   api -X POST -H "Content-Type: application/json" \
     -d '{"reason":"manual","note":"cutover <porras> <päivämäärä>"}' \
     "$API/api/companies/<companyId>/outreach/senders/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "<sender>")/pause"
   ```
   Pause on globaali lähettäjää kohden, ja vain board voi asettaa ja jatkaa sen (`routes/outreach.ts`). Kirjaa lista jatkoa varten.
3. **Pysäytä ulkoinen lähetysdaemoni** (rk9-prod, `outreach-sender.service`). Lähettäjäpause estää uudet viestit `send-queue`sta, mutta daemonilla voi olla viesti kesken (satunnaisviive 30–180 s viestien välillä). Odota 3 min pausen jälkeen ja pysäytä: `ssh <käyttäjä>@100.103.149.19 'sudo journalctl -u outreach-sender.service --since "-5 min" --no-pager | tail -5; sudo systemctl stop outreach-sender.service'`. Käynnistys on vaiheessa 6. Käyttäjä ja ohje: `~/.claude/hosts/rk9-prod/outreach-sender/README.md`.
4. **SYSTEM_PAUSE päälle:** `api -X POST -H "Content-Type: application/json" -d '{"reason":"cutover <porras>"}' "$API/api/instance/system-pause"`. Uudet agenttiajot ja rutiinit estyvät. Käynnissä olevat ajot päättyvät itsestään.
5. **Odota tyhjenemistä:** `dbpsql -Atc "select count(*) from heartbeat_runs where status = 'running'"` on 0 (aikaraja 10 min). Jos ajo jää roikkumaan yli 10 min, kirjaa sen id ja jatka: restart katkaisee sen, ja ajo palautuu paluujonoon.
6. **Todenna pysäytys:** ota toinen snapshot (`--label paused`) ja aja `compare before paused --expect-paused`. Lähetyksiä ei saa tulla lainkaan. Tarkista lisäksi jono uudelleen daemonin pysäytyksen jälkeen: `dbpsql -Atc "select count(*) from outreach_messages where status = 'queued'"` on 0. Jos rivi jäi `queued`-tilaan, daemon ehti ehkä lähettää sen ennen pysäytystä: selvitä `outreach_events` ja lähettäjän loki ennen jatkoa, sillä resume lähettäisi sen toiseen kertaan.

**Go**, kun `compare ... --expect-paused` antaa "ei löydöksiä", kaikki lähettäjät ovat pausella, daemon on pysäytetty ja `heartbeat_runs` `running` = 0.
**No-go**: lähetyksiä tulee pauseista huolimatta tai pause epäonnistuu. Älä jatka. Tutki: `GET /api/companies/<companyId>/outreach/senders/pauses`. Purku: `POST /api/instance/system-resume` ja jatka vain omat cutover-pausesi (vaihe 6, kohta 2). Ikkuna siirtyy.

## Vaihe 3 — Dump ja pre-upgrade-SHA (aikaraja 20 min)

```bash
SNAPSHOT_TAR_AS=root scripts/pre-upgrade-snapshot.sh --tag <porras> --repo /opt/paperclip
```

`SNAPSHOT_TAR_AS=root` pakkaa versioimattomat tiedostot `sudo -n -u root tar`illa, koska osa tiedostoista on root-omisteisia 0600-tiedostoja (`cli/.paperclip/.env`, `cli/.paperclip/config.json`, `server/data/secrets/master.key`) eikä edes käyttäjä `paperclip` lue niitä (todennettu 26.9. `sudo ls -l` ja kuiva `tar -cf /dev/null` rootilla). Polut tulevat manifestista, eivät git-listauksesta: masterin `.gitignore` ohittaa `data/`, `.paperclip/` ja `.env`, joten `git ls-files --others` ei listaisi niitä. Ilman `SNAPSHOT_TAR_AS`-arvoa lukematon tiedosto katkaisee snapshotin (exit 1). Snapshot ei hyväksy osittaista tariä. `DATABASE_URL` ei näy prosessilistassa.

Skripti kirjaa `pre-upgrade-sha.txt`-tiedostoon `HEAD`, `origin/master`, `fork/master` ja `upstream/master`, ajaa `pg_dump -Fc`, palauttaa dumpin kertakäyttöiseen scratch-kantaan, vertaa taulumäärää, migraatiomäärää ja avaintaulujen rivimääriä, pudottaa scratch-kannan ja tulostaa `SNAPSHOT_OK dir=...`. Se tallentaa myös `local/local-changes.patch` (versioidut paikalliset muutokset) ja `local/untracked-preserved.tar` (luokat preserve, secret, runtime).

Pysyvä SHA-kirjaus (ei `/tmp`): lisää rivi osioon "Porrasloki" tiedostossa `doc/UPSTREAM-UPGRADE.md` ja luo tagi operaattorin masterin kloonissa (`/opt/paperclip` on käyttäjän `paperclip` omistuksessa, eikä operaattori pushaa sieltä): `git -C <klooni> fetch origin && git -C <klooni> tag rk9/pre-upgrade-<porras> $(sed -n 's/^HEAD=//p' <snapshot-hakemisto>/pre-upgrade-sha.txt) && git -C <klooni> push origin rk9/pre-upgrade-<porras>`.

**Go**, kun tulostuu `SNAPSHOT_OK`, dump on yli 0 tavua, `SHA256SUMS` täsmää (`sha256sum -c`) ja SHA-rivi on Porraslokissa.
**Säilytys ja salaisuudet.** Snapshot-hakemisto sisältää koko kannan ja salaisuudet (`master.key`, `.env`) yhdessä: kuka tahansa, joka lukee sen, purkaa kaikkien yritysten salaisuudet. Hakemisto on 0700 ja tiedostot 0600 eikä sitä synkata mihinkään. **Poista snapshot, kun porras on ollut tuotannossa 30 vrk ilman rollbackia** (`sudo rm -rf /var/backups/paperclip-pre-upgrade/<porras>-*`) ja säilytä enintään kaksi viimeisintä. Automaattinen siivous puuttuu: `paperclip-secret-backup-cleanup` (RK9-177) kattaa vain muut hakemistot, ja laajennus on seurantatiketissä. Vain manifestin luettelemat polut varmuuskopioidaan; muut ignoratut tiedostot (esim. `.claude/settings.local.json`) jäävät ennalleen, koska `reset --hard` ei kosketa niihin.

**No-go**: `SNAPSHOT_OK` puuttuu, vertailu antaa eroja tai scratch-palautus epäonnistuu. **Älä jatka.** Dumpia ei voi käyttää rollbackiin. Korjaa syy (levytila, `CREATEDB`, pysäyttämätön kirjoittaja: skripti varoittaa, jos rivimäärät muuttuivat dumpin aikana) ja aja uudelleen. Purkuvaihe 2:n mukaan, jos ikkuna venyy yli 45 min.

## Vaihe 4 — Fetch, reset, install, restart (aikaraja 30 min)

Edellytys: porras-PR on mergetty masteriin, ja update-holdi on yhä paikallaan.

```bash
sudo -u paperclip git -C /opt/paperclip fetch origin
scripts/prod-untracked-check.sh --repo /opt/paperclip --target origin/master   # exit 0, muuten älä jatka
sudo -u paperclip git -C /opt/paperclip reset --hard origin/master
sudo -u paperclip bash -c 'cd /opt/paperclip && pnpm install --frozen-lockfile'
sudo -u paperclip /usr/local/bin/paperclip-preflight.sh          # kuivana ennen restarttia
sudo systemctl restart paperclip.service
```

`fetch` hakee remotesta `origin` (tuotannossa `mv50000/paperclip`; `paperclip-update.sh` tunnistaa remoten URL:llä). Palvelin ajaa odottavat migraatiot käynnistyksessä (`applyPendingMigrations`, `server/src/index.ts`). Seuraa lokia: `sudo tail -f /var/log/paperclip.log`.

`ExecStartPre` ajaa preflightin jokaisella käynnistyksellä. Jos se epäonnistuu, palvelu ei käynnisty, ja `journalctl -u paperclip.service` näyttää rivin `[paperclip-preflight] FAIL <tunniste>`. Tunnisteet ja poistumiskoodit: 11 branch, 12 ankkuritiedosto puuttuu, 13 migraatio 9010 puuttuu, 14 host-env-suodatin puuttuu, 15 Node < 24.11, 16 git ei lue repoa.

**Go**, kun `systemctl is-active paperclip.service` on `active` ja `curl -fsS $API/api/health` palauttaa 200 viimeistään 5 min restartin jälkeen.
**No-go**: preflight epäonnistuu (älä kiertä sitä, korjaa syy tai tee rollback), palvelu ei nouse 5 min sisällä, tai lokissa on migraatiovirhe. Siirry osioon "Rollback".

## Vaihe 5 — Migraatiot, preflight ja smoke (aikaraja 30 min)

1. **Migraatiot:** `dbpsql -Atc "select count(*) from drizzle.__drizzle_migrations"` pitäisi olla sama kuin `packages/db/src/migrations/meta/_journal.json`in `entries`-määrä (`jq '.entries | length' packages/db/src/migrations/meta/_journal.json`). Tarkista, ettei lokissa ole `migration`-virhettä: `sudo grep -i 'migrat' /var/log/paperclip.log | tail`.
2. **Preflight:** `sudo -u paperclip /usr/local/bin/paperclip-preflight.sh` tulostaa `OK`-rivin. Kirjaa rivin SHA:t Porraslokiin.
3. **Smoke:** `scripts/upgrade-smoke.sh $API` (`OUTREACH_METRICS_API_KEY` asetettuna, jolloin digest ja `/metrics` vaaditaan 200:ksi). Jokaisessa portaassa ajetaan lisäksi yksi `claude_local`-heartbeat per aktiivinen yritys, kun SYSTEM_PAUSE on poistettu vaiheessa 6 (katso vaihe 6 kohta 1).
4. **Outreach-tila:** `scripts/outreach-window-report.sh snapshot --label after-restart --out ...` ja `compare before after-restart --expect-paused`.
5. **Regressiomatriisi:** portaan pakolliset tarkistukset `doc/upgrade/regression-matrix.md`:stä ovat vihreitä.

**Go**, kun kaikki viisi täyttyvät.
**No-go**: mikä tahansa epäonnistuu. Älä jatka outreachia. Rollback on vielä sallittu: siirry osioon "Rollback".

## Vaihe 6 — Jatko ja 24 h seuranta

Tähän vaiheeseen mennään vain, kun vaiheen 5 go on annettu. **Tämän jälkeen rollback ei ole enää sallittu ilman datan exportia.**

1. **SYSTEM_PAUSE pois:** `api -X POST "$API/api/instance/system-resume"`. Odota yksi heartbeat-kierros ja tarkista, että ajot käynnistyvät.
2. **Outreach jatkuu:** jatka vain ne lähettäjät, jotka pausetit vaiheessa 2 (`POST .../outreach/senders/<sender>/resume`). Älä jatka lähettäjiä, jotka olivat pausella jo ennen ikkunaa. Käynnistä sen jälkeen daemon: `ssh <käyttäjä>@100.103.149.19 'sudo systemctl start outreach-sender.service'`, ja tarkista sen loki.
3. **Update-holdi pois** vasta, kun 24 h seuranta on vihreä ja `sudo -u paperclip git -C /opt/paperclip rev-parse HEAD` on sama kuin `origin/master` (haun jälkeen): `sudo rm /etc/paperclip/update-hold`. Hold ilmoittaa Telegramiin 72 h:n jälkeen. Poista holdi vasta, kun seuraavan portaan merge-haara ei ole auki.
4. **Master vapautetaan** (sääntö 3) kirjaamalla Porraslokiin, että porras on tuotannossa.
5. **Jälkeen-raportti:** heti jatkon jälkeen ja 1 h, 6 h ja 24 h kohdalla: `scripts/outreach-window-report.sh snapshot --label after-resume --out ...` ja `compare before after-resume`. Tulos "ei löydöksiä" tarkoittaa, ettei viestejä ole hävinnyt eikä kaksinkertaistunut, ja että saapuneet vastaukset ovat säilyneet ([RK9-234](/RK9/issues/RK9-234): vastaus talletetaan ennen reititystä).
6. **24 h seuranta:** tarkista `/metrics` kohta `outreach_inbound_unrouted` (pitää pysyä ennallaan tai laskea), `outreach_inbound_reply_unmatched` (ei uusia rivejä), `journalctl -u paperclip.service --since <ikkuna>` (ei `[paperclip-preflight] FAIL`-rivejä eikä toistuvia restarteja), yön digest (`outreach-digest.sh`, 05:00Z) ja `sudo tail /var/log/paperclip-update.log`.

**Go (portaan päätös)**: 24 h ilman löydöksiä. Seuraava porras saa alkaa.
**No-go**: `compare` löytää häviön tai kaksoiskappaleen, `outreach_inbound_unrouted` kasvaa ilman selitystä, tai palvelu restarttaa itsestään. Pysäytä lähettäjät uudelleen (vaihe 2, kohta 2) ja korjaa eteenpäin (ks. "Rollback").

## Rollback

Päätös tehdään ennen outreachin jatkamista (vaiheet 4–5). Aikaraja päätökselle: 30 min vaiheen 4 alusta. Kriteerit:

| Tilanne | Päätös |
|---|---|
| Preflight epäonnistuu eikä syytä saa korjattua 15 min:ssä | Rollback |
| Palvelu ei nouse 5 min:ssä restartista | Rollback |
| Migraatio epäonnistui kesken (kanta osittain migroitu) | Rollback koodi **ja** kanta |
| Smoke-tarkistus punainen fork-kyvyssä (outreach, resend/ses-inbound, webhookit) | Rollback |
| Smoke-tarkistus punainen upstream-kyvyssä, joka ei kosketa forkin toimintaa | Ei rollbackia; korjaa eteenpäin tai jatka operaattorin päätöksellä |
| Löydös vasta vaiheen 6 jälkeen | **Ei rollbackia.** Korjaa eteenpäin. Poikkeus: ikkunan data exportataan ja replayataan (alla) |

**Rollback ennen jatkoa.** Vaiheet ajetaan tässä järjestyksessä. Palvelu pysyy pysäytettynä vaiheeseen R10 asti, jotta kantaan ei tule uusia kirjoituksia viennin, todennuksen ja tuonnin välissä. **Update-holdi pysyy paikallaan koko rollbackin ajan** (R11).

```bash
SNAP=/var/backups/paperclip-pre-upgrade/<porras>-<aikaleima>     # vaiheen 3 tuloste
WINDOW_START=<vaiheen 2 alkuaika, ISO, esim. 2026-10-04T05:00:00Z>
```

| # | Askel | Komento |
|---|---|---|
| R1 | Pysäytä palvelu. Lähettäjäpausejen ja daemonin pysäytyksen (vaihe 2) pitää yhä olla voimassa. | `sudo systemctl stop paperclip.service` |
| R2 | Vie ikkunan data. Palvelu on ollut ylhäällä pauseissa, joten inbound-reitit ovat tallentaneet vastauksia ja `/u/:token` unsubscribeja, ja bounce- ja unsub-postit ovat lisänneet suppressioita. Palautus pyyhkii ne. | `scripts/outreach-window-report.sh export --since "$WINDOW_START" --out "$SNAP/window-export"` |
| R3 | Ota turvakopio nykyisestä (rikkinäisestä) kannasta. | `. scripts/lib-pg-url.sh; pg_with "$DATABASE_URL" pg_dump -Fc --no-owner --file="$SNAP/failed-upgrade.dump"` |
| R4 | **Luo kanta tyhjänä uudelleen.** `pg_restore --clean` ei riitä: se jättää uuden version lisäämät sarakkeet ja taulut, ja migraatiomäärä täsmäisi silti (todennettu 26.9. kokeessa). Tuhoava askel: R3:n kopion pitää olla olemassa. | `read -rs SNAPSHOT_ADMIN_URL` (admin-URL ilman kantanimeä, esim. `.../postgres`), `DBN=$(dbpsql -Atc 'select current_database()')` (kantanimi luetaan sovelluksen URL:stä, ei arvata), sitten `pg_with "$SNAPSHOT_ADMIN_URL" psql -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$DBN\" WITH (FORCE)" -c "CREATE DATABASE \"$DBN\" OWNER <sovelluksen rooli> TEMPLATE template0 ENCODING '<encoding>' LC_COLLATE '<collate>' LC_CTYPE '<ctype>'"` (arvot tiedostosta `$SNAP/db-level.txt`; ilman TEMPLATE-määrettä kanta perii `template1`:n merkistön, ja se voi olla SQL_ASCII: todennettu 26.9., rollback vaihtoi UTF8:n SQL_ASCII:ksi hiljaa) (admin-yhteys, ei sovelluksen rooli). Dump ei kanna tietokantatason käyttöoikeuksia eikä `ALTER DATABASE ... SET` -asetuksia: ne ovat tiedostossa `$SNAP/db-level.txt` (omistaja, `datacl`, roolikohtaiset asetukset). Aseta omistaja, ACL ja asetukset käsin CREATE-komennon jälkeen (todentamatta). `--verify` vertaa merkistön |
| R5 | Palauta dump kaikki tai ei mitään. | `pg_with "$DATABASE_URL" bash -c 'exec pg_restore --exit-on-error --single-transaction --no-owner --dbname="$PGDATABASE" "$1"' _ "$SNAP/paperclip.dump"` (sovelluksen roolilla, jotta oliot päätyvät sen omistukseen) |
| R6 | Palauta koodi. | `sudo -u paperclip git -C /opt/paperclip reset --hard "$(sed -n 's/^HEAD=//p' "$SNAP/pre-upgrade-sha.txt")"` ja `sudo -u paperclip bash -c 'cd /opt/paperclip && pnpm install --frozen-lockfile'` |
| R7 | Palauta versioimattomat tiedostot ja paikalliset muutokset, jos niitä katosi. | `sudo tar -C /opt/paperclip -xpf "$SNAP/local/untracked-preserved.tar"` (root: osa tiedostoista on root-omisteisia; `-p` säilyttää omistajat) ja vain jos patch ei ole tyhjä (`[ -s "$SNAP/local/local-changes.patch" ]`; tyhjä patch on normaali, koska vaihe 1 vaatii ei-paikallisia muutoksia): `P=$(sudo -u paperclip mktemp) && sudo cat "$SNAP/local/local-changes.patch" | sudo -u paperclip tee "$P" >/dev/null && sudo -u paperclip git -C /opt/paperclip apply "$P"; sudo -u paperclip rm -f "$P"` |
| R8 | Todenna palautus ennen palvelun käynnistystä. | `scripts/pre-upgrade-snapshot.sh --verify "$SNAP"` tulostaa `VERIFY_OK` tai erot (taulumäärä, migraatiomäärä, avaintaulujen rivit). Tarkistus ei näe yksittäistä saraketta: R4 (tyhjä kanta) takaa, ettei vanhaa skeemaa jää sekaan. |
| R9 | Tuo ikkunan data takaisin **ennen palvelun käynnistystä ja ennen kuin yhtään lähettäjää jatketaan**. Suppressiot ensin: palautettu kanta ei tiedä ikkunan aikana kirjautuneista unsubscribeista, ja jatko lähettäisi niille viestejä. | Ks. alla |
| R10 | Käynnistä palvelu ja todenna. | `sudo systemctl start paperclip.service`, `scripts/upgrade-smoke.sh $API`, sitten `scripts/outreach-window-report.sh snapshot --label after-rollback --out "$SNAP/after-rollback.json"` ja `scripts/outreach-window-report.sh compare /var/backups/paperclip-pre-upgrade/<porras>-before.json "$SNAP/after-rollback.json" --expect-paused` (lähettäjät ovat vielä pausella) |
| R11 | **Estä hylätyn portaan paluu.** R6 asetti `/opt/paperclip`in vanhaan SHA:han, joka on masterin esi-isä. Seuraava 05:00Z-päivitys vetäisi masterin (hylätyn portaan) takaisin ja käynnistäisi sen migraatioineen. Holdi estää tämän vain niin kauan kuin se on paikallaan. | 1) Holdi pysyy. 2) Revertaa porras masterista PR:llä: merge-commit-mergelle `git revert -m 1 <porras-merge-sha>`, squash-mergelle `git revert <squash-sha>` (ilman `-m`). 3) Mergeä revert. 4) Vie prod samaan tilaan: `sudo -u paperclip git -C /opt/paperclip remote get-url origin` sisältää `mv50000/paperclip` (muuten älä jatka), sitten `sudo -u paperclip git -C /opt/paperclip fetch origin && sudo -u paperclip git -C /opt/paperclip reset --hard origin/master`, `pnpm install --frozen-lockfile` paperclipina ja `sudo systemctl restart paperclip.service`, sitten preflight ja smoke. 5) Poista holdi vasta, kun `sudo -u paperclip git -C /opt/paperclip rev-parse HEAD` on sama kuin `origin/master`. 6) **Ennen saman portaan uutta yritystä** revertaa revert (`git revert <revert-sha>`) tai luo porras uudelleen tuoreesta masterista: muuten `git merge <tagi>` sanoo "Already up to date" ja porras jää hiljaa pois. |

R9, suppressiot (idempotentti; `ON CONFLICT DO NOTHING`; keskeytyy ensimmäiseen virheeseen):

```bash
[ "$(wc -l <"$SNAP/window-export/outreach_suppressions.csv")" -gt 1 ] || echo "ei suppressioita ikkunassa (tai vienti puuttuu: tarkista R2)"
dbpsql -v ON_ERROR_STOP=1 --single-transaction <<SQL
CREATE TEMP TABLE s (LIKE outreach_suppressions INCLUDING DEFAULTS);
\copy s FROM '$SNAP/window-export/outreach_suppressions.csv' CSV HEADER
INSERT INTO outreach_suppressions SELECT * FROM s ON CONFLICT (email) DO NOTHING;
CREATE TEMP TABLE e (LIKE email_suppression_list INCLUDING DEFAULTS);
\copy e FROM '$SNAP/window-export/email_suppression_list.csv' CSV HEADER
INSERT INTO email_suppression_list SELECT * FROM e ON CONFLICT (company_id, address) DO NOTHING;
SQL
echo "psql exit $? (0 = tuotu; muu = suppressioita EI tuotu, älä jatka lähettäjiä)"
```

`ON_ERROR_STOP` estää hiljaisen nolla-rivin tuonnin, jos `\\copy` epäonnistuu (väärä polku tai sarakeero uuden skeeman CSV:n ja vanhan taulun välillä). Jos sarakkeet eroavat, tuo suppressioista vain `email`, `reason`, `note` ja `created_at`.

R9, muut viennin taulut (`email_messages`, `outreach_events`, `outreach_prospects`, `outreach_messages`, `outreach_sender_pauses`): tarkista CSV:t käsin ja tuo tarvittavat rivit. Vastausrivit viittaavat issueihin (`issue_id`), joita palautettu kanta ei välttämättä tunne, joten niiden tuonti voi rikkoa viiteavaimen ja vaatii tapauskohtaisen käsittelyn. **Tätä tuontia ei ole harjoiteltu** (todentamatta): se harjoitellaan Node 24 -dry-runissa ([RK9-310](/RK9/issues/RK9-310)). Ilman R2:ta ikkunan vastaukset ja unsubscribet katoavat.

**Rajaukset.** Ikkunaviennin `email_messages` rajataan `created_at`-ajalla, ja taulussa ei ole `updated_at`-saraketta: vanhojen rivien bounce- ja complaint-tilamuutokset eivät siirry. Yleinen `email_suppression_list` viedään ja tuodaan (R9), mutta tilamuutokset tarkistetaan käsin. R5 palauttaa sovelluksen roolilla yhdessä transaktiossa, mutta snapshotin scratch-tarkistus ajetaan admin-tunnuksella: laajennukset (esim. `pg_trgm`) ja omistajuudet todennetaan vasta kuivaharjoituksessa, joka ajetaan sovelluksen roolilla (todentamatta). Outreach-lähetys, heartbeatit ja lähettäjädaemoni on pysäytetty, mutta muu lähtevä posti (CS-desk-automaattivastaukset ja eskalaatiot, `services/email/auto-reply.ts`) ei pysähdy pauseista. Rollback nollaa `auto_replied_at`- ja `escalated_at`-merkinnät, joten samaan ikkunan aikana saapuneeseen viestiin voi lähteä automaattivastaus kahdesti (todentamatta; tarkista ikkunan `email_messages` ennen jatkoa).

Vaiheen 6 kohdat 1–2 (jatko) sallitaan vasta, kun R8 antaa `VERIFY_OK`, R9:n suppressiot on tuotu ja R10:n smoke on vihreä. Jos palvelu ei ehtinyt kirjoittaa mitään, R2 tuottaa nolla riviä.

**Node ja preflight rollbackissa.** Uusi preflight vaatii Node ≥ 24.11 myös vanhalle koodille. Jos vanha koodi ei toimi Node 24:llä, rollback vaatii Noden palautuksen ja vanhan preflightin (`git -C ~/.claude show f39caba~1:hosts/paperclip/paperclip-service/paperclip-preflight.sh`). `install.sh` hylkää vain uuden, Node-portilla varustetun preflightin, joten vanhan asennus onnistuu. **Päätös (RK9-310, 26.9.):** nykyinen fork-koodi toimii Node 24.21.0:lla (`doc/UPSTREAM-UPGRADE.md`, "Node 24"), joten koodin rollback ei palauta Nodea. Node palautetaan vain, jos vika on Node 24:ssä, ja silloin asennetaan myös vanha preflight. Apt-komennot ovat `doc/UPSTREAM-UPGRADE.md`:ssä.

## Preflightin todennus rikkinäisellä puulla

Automaattitesti: `~/.claude/hosts/paperclip/paperclip-service/paperclip-preflight-test.sh` (52 tarkistusta). Se rakentaa väliaikaisen git-puun ja todentaa jokaisen vian: poistettu ankkuritiedosto (jokainen seitsemästä) → exit 12 ja `FAIL anchor-missing: <tiedosto>`, puuttuva migraatio 9010 → 13, host-env-suodatin pois → 14, Node 22.22.1, 24.10.9 ja 24.9.0 → 15, feature-branch → 11, ei git-repo → 16.

Käsin (kuiva, vain luku), kaikki paperclipina, koska kopio on paperclipin omistama: `PF=$(sudo -u paperclip mktemp -d)`, `sudo -u paperclip git clone -q /opt/paperclip "$PF/r"`, `sudo -u paperclip rm "$PF/r/server/src/routes/outreach.ts"`, sitten `sudo -u paperclip env PAPERCLIP_PREFLIGHT_TEST=1 PAPERCLIP_PREFLIGHT_REPO="$PF/r" /usr/local/bin/paperclip-preflight.sh` (tai `~/.claude/hosts/paperclip/paperclip-service/paperclip-preflight.sh`, jos paperclip lukee sen). Node-vika: sama komento ja `PAPERCLIP_PREFLIGHT_NODE=<skripti, joka tulostaa v22.22.1>`. Siivoa: `sudo -u paperclip rm -rf "$PF"`.

## Harjoitus (dry-run) ja hyväksyntä

| Päivämäärä | Operaattori | Ympäristö | Tulos |
|---|---|---|---|
| 26.9.2026 klo 19:49–20:04 (paperclip-01, UTC) | RK9-310-agentti (ei operaattori) | Harjoitusinstanssi (`upgrade-rehearsal.sh`, master `24f1f07b`, Node v24.21.0 tarballista, portti 3199) | **Läpi.** Putki 130 s, HTTP-smoke 10/10, fork-testit 768/769 (1 kuormaflake, läpi erikseen), rollback 49 s, `clean` ajettu. `pnpm install` 1 min, `pnpm -r typecheck` 7 min, `pnpm test:run` 15 min (1 ympäristöriippuva virhe, sama Node 22:lla). **Host-apt-vaihetta ei ajettu** (ei sudoa aptille): sen kesto on mittaamatta (todentamatta). Ikkunan mitoitukseen: varaa vaiheelle 0.3 (apt update + install + todennus) 10 min ja palvelun restartille vähintään preflightin + savutestin ajan (harjoitusputki 130 s + smoke ~3 min). Toteutus: [RK9-310](/RK9/issues/RK9-310). Operaattorin oma dry-run (apt + preflight) kirjataan tähän ikkunassa. |

Dry-runissa mitataan vaiheiden todelliset kestot, ja tämän perusteella tämän dokumentin aikarajat ja ikkunan pituus tarkennetaan. Rehearsal-ajon "nolla nettohäviötä ja -kaksoiskappaletta" -todiste on `compare`-raportin tuloste (`ei löydöksiä`) sekä saapuvan vastauksen säilyminen ennen reititystä (RK9-234).
