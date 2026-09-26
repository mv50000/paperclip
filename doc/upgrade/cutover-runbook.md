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

Aja skriptit masterin kloonista (esim. `/home/rk9admin/paperclip`), ei `/opt/paperclip`ista: tuotantopuu ei sisällä niitä ennen kuin tämä PR on deployattu.
Kaikki skriptit ovat vain luku -tilassa lähdekantaan; snapshot kirjoittaa vain omaan hakemistoonsa ja väliaikaiseen scratch-kantaan.

| Työkalu | Tehtävä |
|---|---|
| `scripts/outreach-window-report.sh snapshot\|compare` | Outreach-jono, viimeisin lähetys, käsittelemättömät vastaukset ennen ja jälkeen. `compare` löytää hävinneet ja kaksinkertaistuneet viestit. |
| `scripts/pre-upgrade-snapshot.sh --tag <porras>` | SHA:t, `pg_dump -Fc`, palautus scratch-kantaan ja rivimäärävertailu, paikallisten muutosten patch ja versioimattomien tiedostojen tar. |
| `scripts/prod-untracked-check.sh --repo /opt/paperclip --target <ref>` | Luokittelee versioimattomat tiedostot, löytää versioidut paikalliset muutokset ja törmäykset kohde-refin kanssa. Luokitus: `scripts/prod-untracked.manifest`. |
| `scripts/upgrade-smoke.sh` | Savutesti ([RK9-304](/RK9/issues/RK9-304)). |
| `/usr/local/bin/paperclip-preflight.sh` | `ExecStartPre`. Fork-ankkurit, migraatio 9010, host-env-suodatin, Node ≥ 24.11. Lähde: `~/.claude/hosts/paperclip/paperclip-service/`. |
| `/etc/paperclip/update-hold` | Tiedosto ohittaa 05:00Z-päivityksen. Lähde: `~/.claude/hosts/paperclip/paperclip-update/paperclip-update.sh`. |

Ympäristö kaikille komennoille (operaattorin shell, arvoja ei kirjata mihinkään):

```bash
export DATABASE_URL=...          # tuotantokannan URL; salaisuus, ei komentohistoriaan (käytä read -s)
export BOARD_TOKEN=...           # board-API-avain; vain vaiheiden 2 ja 6 API-kutsuihin
export API=http://127.0.0.1:3100
```

## Vaihe 0 — Kertaluonteiset esivaatimukset (ennen ensimmäistä ikkunaa)

Nämä ovat tuotantomuutoksia, ja **operaattori ajaa ne itse**. Tämä tiketti ei ajanut niitä.

| # | Komento | Tarkoitus | Todennus |
|---|---|---|---|
| 0.1 | `sudo ~/.claude/hosts/paperclip/paperclip-service/paperclip-safe-directory.sh` | `/opt/paperclip` `safe.directory`-listalle `/etc/gitconfig`iin. Palvelun käyttäjä `paperclip` omistaa repon eikä törmää virheeseen. Root törmää (todennettu 26.9.: `sudo git -C /opt/paperclip rev-parse HEAD` antaa `dubious ownership`). Skripti on idempotentti, ja `install.sh --apply` ajaa sen jatkossa. | `sudo git -C /opt/paperclip status --short` ei tulosta virhettä |
| 0.2 | `sudo ~/.claude/hosts/paperclip/paperclip-update/install.sh --apply <commit>` | Asentaa hold-tuen `paperclip-update.sh`:iin. Commit on `~/.claude`-repon commit `f39caba` tai myöhempi. | `grep -c update-hold /usr/local/bin/paperclip-update.sh` ≥ 1 |
| 0.3 | Node 24 asennetaan ([RK9-310](/RK9/issues/RK9-310)). | Uusi preflight estää palvelun käynnistyksen, jos Node < 24.11. paperclip-01 ajaa 26.9. Node 22.22.1:tä, joten **älä asenna preflightia ennen Node 24:ää**. | `sudo -u paperclip env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin node --version` |
| 0.4 | `sudo ~/.claude/hosts/paperclip/paperclip-service/install.sh` (tarkistus), sitten `sudo ./install.sh --apply <commit>` | Asentaa uuden `paperclip-preflight.sh`:n. Aja vain, kun 0.3 on tehty. Asennin ei restarttaa. | `sudo -u paperclip /usr/local/bin/paperclip-preflight.sh; echo $?` tulostaa `OK`-rivin ja `0` |
| 0.5 | `sudo mkdir -p /var/backups/paperclip-pre-upgrade && sudo chown rk9admin: /var/backups/paperclip-pre-upgrade` | Snapshotien kohde (hakemisto 0700, tiedostot 0600). Tarkista levytila: `df -h /var/backups` (dump + scratch-palautus vaativat 2 × kannan koon). | `df -BG --output=avail /var/backups` |
| 0.6 | Anna käyttäjälle, jolla `DATABASE_URL` yhdistää, `CREATEDB` (scratch-kantaa varten), tai aseta `SNAPSHOT_ADMIN_URL` toiselle käyttäjälle. | `pre-upgrade-snapshot.sh` luo ja pudottaa kannan `pcp_restore_check_*`. | `psql "$DATABASE_URL" -c "select rolcreatedb from pg_roles where rolname = current_user"` |

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
| `.gitignore` | paikallinen versio poistaa `dist/`-, `.env`- ja muita ignore-rivejä (siksi `dist/`-hakemistot näkyvät versioimattomina) | Tarkista `git -C /opt/paperclip diff .gitignore`. Hylkää oletuksena: master on oikea. |

`prod-untracked-check.sh` palauttaa exit 1, kunnes kaikki kolme on ratkaistu. Tarkistus on vaiheen 1 go/no-go.

## Vaihe 1 — Ikkunan valinta ja esitarkistus (T-2 vrk … T-0)

Aikaraja: valmis ennen ikkunan alkua. Ei prod-muutoksia paitsi update-holdi.

1. Valitse ikkuna RK9-198:n lähetyserien ulkopuolelta. Katso lähetyserien aikataulu tiketistä [RK9-198](/RK9/issues/RK9-198) ja jonon tila: `scripts/outreach-window-report.sh snapshot --label t-1 --out /tmp/window-t-1.json`. Ikkuna alkaa, kun `jono (queued)` on 0 ja seuraava erä on vähintään ikkunan pituuden päässä.
2. Tarkista, ettei käynnissä ole yhtäjaksoisuutta vaativaa ajoa (QUA-1007 paper-forward, QUA-1207 pariteettiajo). Ikkuna on aikaisintaan 4.10.
3. **Aseta update-holdi** ennen kuin merge-haara avataan: `sudo install -m 644 /dev/null /etc/paperclip/update-hold`. Kirjaa syy: `echo "cutover <porras> <päivämäärä>" | sudo tee /etc/paperclip/update-hold`. Ilman holdia 05:00Z-päivitys deployaa mergen.
4. Jäädytä masterin merge-liikenne (sääntö 3): ilmoita kanavalla ja lisää PR:ään otsikko `[FREEZE]` kunnes vaihe 6 on valmis.
5. Tarkista puun tila: `scripts/prod-untracked-check.sh --repo /opt/paperclip --target origin/master` (kohteena on porras-branch mergen jälkeen `origin/master`).
6. Aja preflight kuivana: `sudo -u paperclip /usr/local/bin/paperclip-preflight.sh`.
7. Aja savutesti nykytilaa vasten: `scripts/upgrade-smoke.sh --offline --fork-tests`.

**Go**, kun: (a) `jono` on 0 tai seuraava erä on ikkunan ulkopuolella, (b) `prod-untracked-check.sh` exit 0, (c) preflight exit 0, (d) update-holdi on paikallaan, (e) porras-PR:n kaikki checkit ovat vihreitä ja harjoitusinstanssin tarkistukset on kirjattu Porraslokiin.
**No-go**: mikä tahansa yllä oleva puuttuu. Siirrä ikkunaa. Mitään ei ole vielä muutettu, joten rollbackia ei tarvita.

## Vaihe 2 — Outreach ja heartbeatit pysäytetään (T+0, aikaraja 15 min)

Tämä vaihe käynnistää ikkunan. Kello alkaa tästä.

1. **Ennen-tila:** `scripts/outreach-window-report.sh snapshot --label before --out /var/backups/paperclip-pre-upgrade/<porras>-before.json`. Kirjaa erityisesti `aktiiviset lähettäjäpysäytykset`: ne ovat jo ennen ikkunaa pysäytettyjä lähettäjiä, joita **ei saa jatkaa** vaiheessa 6 (automaattinen pause = todellinen ongelma).
2. **Lähettäjät pauselle.** Hae lähettäjät: `psql "$DATABASE_URL" -Atc "select distinct sender_identity from outreach_sequences"`. Jokaiselle, jolla ei ole aktiivista pausea:
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $BOARD_TOKEN" -H "Content-Type: application/json" \
     -d '{"reason":"manual","note":"cutover <porras> <päivämäärä>"}' \
     "$API/api/companies/<companyId>/outreach/senders/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "<sender>")/pause"
   ```
   Pause on globaali lähettäjää kohden, ja vain board voi asettaa ja jatkaa sen (`routes/outreach.ts`). Kirjaa lista jatkoa varten.
3. **SYSTEM_PAUSE päälle:** `curl -fsS -X POST -H "Authorization: Bearer $BOARD_TOKEN" -H "Content-Type: application/json" -d '{"reason":"cutover <porras>"}' "$API/api/instance/system-pause"`. Uudet agenttiajot ja rutiinit estyvät. Käynnissä olevat ajot päättyvät itsestään.
4. **Odota tyhjenemistä:** `psql "$DATABASE_URL" -Atc "select count(*) from heartbeat_runs where status = 'running'"` on 0 (aikaraja 10 min). Jos ajo jää roikkumaan yli 10 min, kirjaa sen id ja jatka: restart katkaisee sen, ja ajo palautuu paluujonoon.
5. **Todenna pysäytys:** ota toinen snapshot (`--label paused`) ja aja `compare before paused --expect-paused`. Lähetyksiä ei saa tulla lainkaan.

**Go**, kun `compare ... --expect-paused` antaa "ei löydöksiä", ja kaikki lähettäjät ovat pausella, ja `heartbeat_runs` `running` = 0.
**No-go**: lähetyksiä tulee pauseista huolimatta tai pause epäonnistuu. Älä jatka. Tutki: `GET /api/companies/<companyId>/outreach/senders/pauses`. Purku: `POST /api/instance/system-resume` ja jatka vain omat cutover-pausesi (vaihe 6, kohta 2). Ikkuna siirtyy.

## Vaihe 3 — Dump ja pre-upgrade-SHA (aikaraja 20 min)

```bash
scripts/pre-upgrade-snapshot.sh --tag <porras> --repo /opt/paperclip
```

Skripti kirjaa `pre-upgrade-sha.txt`-tiedostoon `HEAD`, `origin/master`, `fork/master` ja `upstream/master`, ajaa `pg_dump -Fc`, palauttaa dumpin kertakäyttöiseen scratch-kantaan, vertaa taulumäärää, migraatiomäärää ja avaintaulujen rivimääriä, pudottaa scratch-kannan ja tulostaa `SNAPSHOT_OK dir=...`. Se tallentaa myös `local/local-changes.patch` (versioidut paikalliset muutokset) ja `local/untracked-preserved.tar` (luokat preserve, secret, runtime).

Pysyvä SHA-kirjaus (ei `/tmp`): lisää rivi osioon "Porrasloki" tiedostossa `doc/UPSTREAM-UPGRADE.md` ja luo tagi: `git -C /opt/paperclip tag rk9/pre-upgrade-<porras> $(sed -n 's/^HEAD=//p' <snapshot-hakemisto>/pre-upgrade-sha.txt) && git -C /opt/paperclip push origin rk9/pre-upgrade-<porras>`.

**Go**, kun tulostuu `SNAPSHOT_OK`, dump on yli 0 tavua, `SHA256SUMS` täsmää (`sha256sum -c`) ja SHA-rivi on Porraslokissa.
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

1. **Migraatiot:** `psql "$DATABASE_URL" -Atc "select count(*) from drizzle.__drizzle_migrations"` pitäisi olla sama kuin `packages/db/src/migrations/meta/_journal.json`in `entries`-määrä (`jq '.entries | length' packages/db/src/migrations/meta/_journal.json`). Tarkista, ettei lokissa ole `migration`-virhettä: `sudo grep -i 'migrat' /var/log/paperclip.log | tail`.
2. **Preflight:** `sudo -u paperclip /usr/local/bin/paperclip-preflight.sh` tulostaa `OK`-rivin. Kirjaa rivin SHA:t Porraslokiin.
3. **Smoke:** `scripts/upgrade-smoke.sh $API` (`OUTREACH_METRICS_API_KEY` asetettuna, jolloin digest ja `/metrics` vaaditaan 200:ksi). Jokaisessa portaassa ajetaan lisäksi yksi `claude_local`-heartbeat per aktiivinen yritys, kun SYSTEM_PAUSE on poistettu vaiheessa 6 (katso vaihe 6 kohta 1).
4. **Outreach-tila:** `scripts/outreach-window-report.sh snapshot --label after-restart --out ...` ja `compare before after-restart --expect-paused`.
5. **Regressiomatriisi:** portaan pakolliset tarkistukset `doc/upgrade/regression-matrix.md`:stä ovat vihreitä.

**Go**, kun kaikki viisi täyttyvät.
**No-go**: mikä tahansa epäonnistuu. Älä jatka outreachia. Rollback on vielä sallittu: siirry osioon "Rollback".

## Vaihe 6 — Jatko ja 24 h seuranta

Tähän vaiheeseen mennään vain, kun vaiheen 5 go on annettu. **Tämän jälkeen rollback ei ole enää sallittu ilman datan exportia.**

1. **SYSTEM_PAUSE pois:** `curl -fsS -X POST -H "Authorization: Bearer $BOARD_TOKEN" "$API/api/instance/system-resume"`. Odota yksi heartbeat-kierros ja tarkista, että ajot käynnistyvät.
2. **Outreach jatkuu:** jatka vain ne lähettäjät, jotka pausetit vaiheessa 2 (`POST .../outreach/senders/<sender>/resume`). Älä jatka lähettäjiä, jotka olivat pausella jo ennen ikkunaa.
3. **Update-holdi pois** vasta, kun 24 h seuranta on vihreä: `sudo rm /etc/paperclip/update-hold`. Hold ilmoittaa Telegramiin 72 h:n jälkeen. Poista holdi vasta, kun seuraavan portaan merge-haara ei ole auki.
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

**Rollback ennen jatkoa** (vaihe 6 ei ole alkanut, joten ikkunan aikana ei ole tullut uutta dataa muualle kuin saapuviin vastauksiin, ks. alla):

```bash
SNAP=/var/backups/paperclip-pre-upgrade/<porras>-<aikaleima>
sudo systemctl stop paperclip.service
sudo -u paperclip git -C /opt/paperclip reset --hard "$(sed -n 's/^HEAD=//p' $SNAP/pre-upgrade-sha.txt)"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" $SNAP/paperclip.dump
sudo -u paperclip bash -c 'cd /opt/paperclip && pnpm install --frozen-lockfile'
tar -C /opt/paperclip -xf $SNAP/local/untracked-preserved.tar      # vain jos tiedostoja katosi
# paikalliset muutokset: git -C /opt/paperclip apply $SNAP/local/local-changes.patch
sudo systemctl start paperclip.service
```

**Node ja preflight rollbackissa.** Uusi preflight vaatii Node ≥ 24.11 myös vanhalle koodille. Jos vanha koodi ei toimi Node 24:llä, rollback vaatii Noden palautuksen ja vanhan preflightin (`git -C ~/.claude show f39caba~1:hosts/paperclip/paperclip-service/paperclip-preflight.sh`). Siitä päätetään RK9-310:ssä.

Rollbackin jälkeen tee sama todennus kuin vaiheessa 5 (health, migraatiomäärä = dumpin `counts-scratch.txt`, `compare before after`).

**Ikkunan aikana saapuneet vastaukset.** Palvelu on ylhäällä vaiheen 2 pauseissa, joten inbound-reitit tallentavat vastauksia (talleta ennen reititystä, RK9-234). `pg_restore --clean` pyyhkii ne pois dumpin ottohetken tilaan. Vie ne siksi **ennen palautusta**:

```bash
psql "$DATABASE_URL" -c "\copy (select * from email_messages where direction = 'inbound' and created_at >= '<ikkunan alku>') to '$SNAP/inbound-window.csv' csv header"
```

Palautuksen jälkeen operaattori tuo rivit käsin (`\copy ... from`) ja ajaa `compare`-raportin. Ilman vientiä ikkunan vastaukset katoavat. Jos palvelu ei ole ollut ylhäällä (restart kesken), lähettäjä yrittää toimitusta uudelleen, eikä vientiä tarvita.

## Preflightin todennus rikkinäisellä puulla

Automaattitesti: `~/.claude/hosts/paperclip/paperclip-service/paperclip-preflight-test.sh` (50 tarkistusta). Se rakentaa väliaikaisen git-puun ja todentaa jokaisen vian: poistettu ankkuritiedosto (jokainen seitsemästä) → exit 12 ja `FAIL anchor-missing: <tiedosto>`, puuttuva migraatio 9010 → 13, host-env-suodatin pois → 14, Node 22.22.1, 24.10.9 ja 24.9.0 → 15, feature-branch → 11, ei git-repo → 16.

Käsin (kuiva, vain luku): `PAPERCLIP_PREFLIGHT_REPO=<kopio> ~/.claude/hosts/paperclip/paperclip-service/paperclip-preflight.sh`. Kopio: `git worktree add /tmp/pf-broken origin/master && rm /tmp/pf-broken/server/src/routes/outreach.ts`. Node-vika: `PAPERCLIP_PREFLIGHT_NODE=<skripti, joka tulostaa v22.22.1>`.

## Harjoitus (dry-run) ja hyväksyntä

| Päivämäärä | Operaattori | Ympäristö | Tulos |
|---|---|---|---|
| — | — | Node 24 -dry-run | **Ei vielä ajettu.** Siirretty tikettiin [RK9-310](/RK9/issues/RK9-310). Runbookia ei käytetä ensimmäiseen oikeaan cutoveriin (`v2026.512.0`), ennen kuin tähän on kirjattu aikaleima, operaattori ja tulos. |

Dry-runissa mitataan vaiheiden todelliset kestot, ja tämän perusteella tämän dokumentin aikarajat ja ikkunan pituus tarkennetaan. Rehearsal-ajon "nolla nettohäviötä ja -kaksoiskappaletta" -todiste on `compare`-raportin tuloste (`ei löydöksiä`) sekä saapuvan vastauksen säilyminen ennen reititystä (RK9-234).
