# io-watch: lähde, ajo ja käyttöönotto

Tausta: RK9-151 (parent RK9-148). `server/scripts/io-watch.sh` ja
`server/scripts/io-watch-alert.ts` ajoivat tuotannossa paperclip-01:llä ilman
versionhallintaa 11.9.2026 asti.

## Mikä ajaa mitä

| Repon polku | Ajaja | Huomio |
|---|---|---|
| `server/scripts/io-watch.sh` | `paperclip-io-watch.service` (ExecStart ajaa tiedoston suoraan, User=paperclip) | Tila `100755` on pakollinen. Ilman sitä restart kaatuu 203/EXEC-virheeseen. |
| `server/scripts/io-watch-alert.ts` | `io-watch.sh` jokaisella hälytyksellä: `pnpm tsx scripts/io-watch-alert.ts` | Ei kuulu server-tsconfigin includeen. Importtaa `server/src/services/slack/client.ts`:n ja `@paperclipai/db`:n. |

Unit (`server/scripts/paperclip-io-watch.service`) ja logrotate-sääntö
(`server/scripts/paperclip-io-watch.logrotate`) ovat repossa (RK9-158). Unit asettaa
kynnysarvot. `DATABASE_URL` tulee tiedostosta `/etc/paperclip/io-watch.env` (root, 0600),
ei enää unitista, joka oli luettavissa kaikille. Asennuskomennot ovat unit-tiedoston
otsikossa. Repon kopio ei päivity hostille itsestään: `sudo cp` ja `daemon-reload` tehdään käsin.
Lokit: `/var/lib/paperclip/io-watch.log` ja `/var/lib/paperclip/io-watch.log.slack`.

## Lokin kasvu

Aiemmin skripti kirjoitti rivin joka 15. sekunti, ja loki kasvoi 57 MB:iin. Nyt skripti
kirjoittaa vain liputetut näytteet (paine, WARN, toipuminen), Slack-tapahtumat ja yhden
`[heartbeat]`-rivin tunnissa (`IO_WATCH_HEARTBEAT`, oletus 3600 s). Terve näyte ei kirjoita mitään.
Hälytys ei lue lokia, joten hälytys toimii kuten ennen. Vika "ei iostat-dataa" kirjataan kerran
jakson alussa. Logrotate kiertää molemmat lokit viikoittain tai 20 MB:n ylittyessä ja säilyttää
4 kierrosta. Skripti avaa lokin polulla jokaista kirjoitusta varten, joten `copytruncate` ja restart eivät ole tarpeen.
Testi: `server/scripts/io-watch.test.mjs`.

## Kohderepo ja kanoninen kopio

- `/opt/paperclip` on tämän forkin checkout. Host-updater päivittää sen päivittäin
  komennolla `git pull --ff-only fork master` (`fork` = `mv50000/paperclip`).
  Palvelu ajaa skriptin suoraan checkoutista, joten repon polku on ajettava polku.
- `/opt/paperclip`- ja `~/paperclip`-kopiot olivat sisällöltään bitilleen
  identtiset. `io-watch.sh`:n tila erosi: `/opt` 775, `~/paperclip` 664.
  `io-watch-alert.ts` on 664 molemmissa. Omistaja ja mtime erosivat.
  Kanoninen on `/opt`-kopio tiloineen, koska palvelu ajaa sen.

## Muutoksen käyttöönotto

- `io-watch.sh`: pullattu muutos ei vaikuta ajossa olevaan prosessiin. Muutos tulee
  voimaan `sudo systemctl restart paperclip-io-watch` -komennolla tai kun systemd
  käynnistää palvelun uudelleen (kaatuminen, reboot).
- `io-watch-alert.ts` ja sen importit: muutos tulee voimaan seuraavassa hälytyksessä
  pullin jälkeen ilman restarttia. Virhe näkyy vain `io-watch.log.slack`-lokissa,
  joten Slack-hälytykset voivat lakata hiljaa.
- Älä poista, siirrä tai revertoi näitä polkuja ennen kuin unit on päivitetty.
  Seuraava pull poistaisi ajettavan tiedoston.

## Versionhallitsemattoman tiedoston adoptointi

Tilanne: polku on jo versionhallitsemattomana checkoutissa, ja sama polku tulee
masteriin. Silloin `git pull --ff-only` kaatuu virheeseen "untracked working tree
files would be overwritten by merge", ja päivitys pysähtyy.

Neutraloi konflikti heti mergen jälkeen, ennen seuraavaa updater-ajoa. Pidä
tiedostot masterissa identtisinä ajettavan kopion kanssa, kunnes updater on
pullannut ne. Jos sisältö muuttuu masterissa sitä ennen, vahti 1 pysäyttää.
Päätä silloin erikseen, miten ajettava kopio päivitetään.

```bash
# /opt/paperclip: cd /opt/paperclip; R=fork;   G="sudo -u paperclip git"
# ~/paperclip:    cd ~/paperclip;    R=origin; G=git
P="server/scripts/io-watch-alert.ts server/scripts/io-watch.sh"   # aakkosjärjestyksessä
$G fetch "$R" master
# Vahti 1, ennen stagetusta: tiedoston tila+blob = $R/master. Tyhjä diff = ok.
diff <(for f in $P; do m=100644; [ "$(stat -c %A "$f" | cut -c4)" = x ] && m=100755
         echo "$m $($G hash-object "$f") $f"; done) \
     <($G ls-tree -r "$R/master" -- $P | awk '{print $1, $3, $4}')
# Vain index. Tiedostoihin ei kirjoiteta.
$G add -- $P
# Vahti 2, stagetuksen jälkeen: index = $R/master. Tyhjä diff = ok.
diff <($G ls-files -s -- $P | awk '{print $1, $2, $4}') \
     <($G ls-tree -r "$R/master" -- $P | awk '{print $1, $3, $4}')
```

- Jos vahti 1 näyttää eron sisällössä, pysähdy ja selvitä ero.
- Jos ero on vain tilassa, aja `chmod +x` tiedoston omistajana (`/opt`:ssa
  `sudo -u paperclip chmod +x`). Aja sitten koko lohko uudelleen. Pelkkä vahti 1
  ei riitä, koska index voi yhä sisältää vanhan tilan.
- Vahti 2:n on oltava tyhjä ennen kuin lopetat.
- Älä aja pullia käsin. Updater asentaa riippuvuudet ja restarttaa paperclip.servicen.
- Älä käytä `git stash`-, `reset --hard`- tai `clean`-komentoa. Ne voivat hävittää
  checkoutin muita paikallisia tiedostoja.

Menetelmä harjoiteltiin scratch-kloonissa 11.9.2026 samalla untracked-tilalla.
Pull kaatui ennen neutralointia ja fast-forwardasi sen jälkeen. Tiedostojen inodet,
tilat ja mtimet pysyivät ennallaan.

## Tunnettu riski

`.github/workflows/deploy-dev.yml` hakee `/opt/paperclip`:iin `origin`-remoten ja
ajaa `reset --hard`- ja `clean -fd`-komennot. Siellä `origin` on upstream, jossa
näitä tiedostoja ei ole. Runneria ei ole, joten riski on piilevä. Seuranta: RK9-157.
