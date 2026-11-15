# Host-vahtien Telegram-hälytykset (RK9-710)

RK9-697 poisti forkin Slack-ilmoitukset 3.11.2026. Operaattori päätti samana päivänä,
että kaksi vahtia lähettää hälytyksensä Telegramiin. Agentin liveness ja system pause
jäävät lokiin ja UI:hin, eikä liveness watchdogia palauteta.

| Vahti | Lähettäjä | Loki |
|---|---|---|
| `server/scripts/check-github-webhook-health.ts` | `server/src/services/rk9-notify-alert.ts` (rk9claude-webhook) ja `ops-telegram-alert.ts` (Telegram), molemmat fetch | `/var/log/paperclip-webhook-monitor.log` |
| `server/scripts/io-watch.sh` | `tg_send` skriptissä (curl) | `/var/lib/paperclip/io-watch.log` |

## Säännöt

- Molemmat lukevat `TG_BOT_TOKEN`:n ja `TG_CHAT_ID`:n ympäristöstä. Nimet ovat samat kuin
  `/etc/paperclip/approval-telegram.env`:ssä.
- Puuttuva tai virheellinen arvo kirjoittaa yhden WARN-rivin. Vahti jatkaa ilman lähetystä.
  Webhook-monitori ajetaan tunneittain, joten WARN-rivi tulee kerran per ajo.
- Token ei näy argv:ssä eikä lokissa. io-watch antaa URL:n curlille stdinistä (`-K -`)
  ja poistaa tokenin lapsiprosessien ympäristöstä (`export -n`). TS-lähettäjä ei lokita
  URL:ia, ja se poistaa tokenin jokaisesta virhetekstistä.
- Telegram-viesti lähtee vain siellä, missä `ALERT:`-rivi kirjoitetaan. Throttle on siis
  sama kuin ennen: webhook-monitorissa `selectAlertableRepos` ja probe-ikkuna, io-watchissa
  WARN-vahvistus, hystereesi ja `IO_WATCH_REMIND`.
- Lähetysvirhe kirjoittaa WARN-rivin. Se ei muuta exit-koodia eikä pysäytä samplingia.
- `--dry-run` ei lähetä Telegramiin eikä rk9clauden webhookiin.

## Käyttöönotto (parent, mergen jälkeen)

Yksiköt eivät ole repossa. Lisää kumpaankin yksikköön rivi
`EnvironmentFile=-/etc/paperclip/approval-telegram.env`:

- `paperclip-webhook-monitor.service`
- `paperclip-io-watch.service`

Aja sitten `sudo systemctl daemon-reload` ja `sudo systemctl restart paperclip-io-watch`.
Webhook-monitori lukee uuden ympäristön seuraavalla ajastetulla ajolla. Ilman yksikkömuutosta
vahdit toimivat kuten ennen ja kirjoittavat yhden WARN-rivin.

Yksiköt ajavat käyttäjänä `paperclip`. `EnvironmentFile` luetaan systemd:n toimesta rootina,
joten tiedoston oikeuksia ei tarvitse muuttaa.

## Webhook-monitorin hälytys on rk9_notify-alert (RK9-827)

Webhook-monitori lähettää hälytyksensä rk9_notifyn alert-luokan sopimuksella. Sopimus on
claude-config-repossa: `docs/implementation-notes/rk9-notify.md`. TypeScript ei voi ladata
bash-kirjastoa, joten toteutus on `server/src/services/rk9-notify-alert.ts`. io-watch ei muutu.

- Hälytys lähtee rk9clauden webhookiin synteettisenä Alertmanager v4 -alerttina ja Telegramiin
  (tila `both`, oletus). Tilassa `webhook` Telegram on vain varareitti.
- Tila tulee muuttujasta `RK9_NOTIFY_ALERT_MODE` tai kytkintiedostosta
  `~/.config/rk9/notify-alert-mode`. Monitorin `HOME` on `/var/lib/paperclip`, joten
  operaattorin oma kytkin (`/home/rk9admin/...`) ei koske monitoria. Aseta tila yksikköön
  rivillä `Environment=RK9_NOTIFY_ALERT_MODE=webhook`.
- rk9claude on ottanut alertin vastaan vain, kun vastaus on HTTP 200 tyhjällä rungolla.
  Muu vastaus, verkkovirhe tai aikakatkaisu lähettää viestin Telegramiin, ja viestin loppuun
  tulee rivi `Varareitti: rk9claude-webhook ei vastannut (HTTP nnn)`.
- Token kulkee vain Authorization-otsakkeessa. Lähetys on `fetch`, joten tokenia ei ole
  minkään prosessin argv:ssä. URL ja token eivät päädy lokiin. Uudelleenohjausta ei seurata.
  Monitori poistaa tokenin ympäristöstään ennen probe-curlien käynnistystä.
- Tunnukset luetaan tässä järjestyksessä:
  1. `RK9CLAUDE_WEBHOOK_URL` ja `RK9CLAUDE_WEBHOOK_TOKEN` ympäristöstä (yksikön
     `EnvironmentFile`). Jos jompikumpi on asetettu, tiedostoa ei lueta.
  2. Tiedosto `${RK9_NOTIFY_WEBHOOK_ENV:-~/.config/rk9/rk9claude-webhook.env}`. Tiedosto
     jäsennetään `AVAIN=arvo`-riveinä, sitä ei suoriteta.
- Ilman tunnuksia monitori kirjoittaa yhden WARN-rivin per ajo, ja hälytys lähtee vain
  Telegramiin ilman varareittiriviä.
- Avain on `PaperclipWebhookMonitor:<luokat>`. Luokat ovat `delivery`, `blind` ja `probe`,
  ja ne yhdistetään `+`-merkillä. `alertname` on `PaperclipWebhookMonitor`, host-labeli
  `rk9-notify-<hostname>` ja `source` `rk9_notify`. Nimellä ei ole vielä runbookia
  rk9claudessa, joten rk9claude käsittelee sen tuntemattomana nimenä (NOTIFY).
- Webhookiin menee sama teksti kuin Telegramiin. Tekstissä on vain monitorin oman listan
  reponimiä, lukuja ja monitorin oma probe-kuvaus. GitHub-API:n virheteksti jää lokiin.
- Kill switch `RK9_NOTIFY_LEGACY=1` tai tiedosto `~/.config/rk9/notify-legacy` lähettää
  kaiken suoraan Telegramiin.
- Monitorilla on oma throttle, joten kirjaston dedup-leimaa ei ole (sama kuin
  `RK9_NOTIFY_COOLDOWN=0`). `notify-failed.log`ia ei kirjoiteta: epäonnistuminen näkyy
  monitorin lokissa WARN-rivinä.

### Toimitus ja throttle

- Tilassa `both` toimitus seuraa Telegramia. Webhookin kuittaus yksin ei riitä, koska
  rk9claude voi päättää olla näyttämättä alerttia. Poikkeus: jos Telegramia ei ole määritetty
  lainkaan, webhookin kuittaus riittää.
- Jos hälytys ei mennyt perille yhteenkään kanavaan, monitori ei tallenna throttle-tilaa.
  Seuraava tunnin ajo lähettää saman hälytyksen uudelleen. Ennen RK9-827:ää throttle käynnistyi
  myös epäonnistuneesta lähetyksestä, ja hälytys jäi 6 tunniksi pelkkään lokiin.
- Jos yhtään kanavaa ei ole määritetty, monitori toimii kuten ennen RK9-710:tä: `ALERT:`-rivit
  lokiin ja throttle normaalisti.

### Käyttöönotto (parent, mergen jälkeen)

Lisää yksikköön `paperclip-webhook-monitor.service` drop-in, esimerkiksi
`/etc/systemd/system/paperclip-webhook-monitor.service.d/30-rk9claude-webhook.conf`:

```ini
[Service]
EnvironmentFile=-/home/rk9admin/.config/rk9/rk9claude-webhook.env
```

systemd lukee tiedoston rootina, joten tokenia ei tarvitse kopioida eikä tiedoston oikeuksia
(600, rk9admin) muuttaa. Aja `sudo systemctl daemon-reload`. Monitori lukee uuden ympäristön
seuraavalla ajastetulla ajolla. Ilman drop-inia monitori toimii kuten ennen ja kirjoittaa
yhden WARN-rivin.

## Testit

- `server/src/services/rk9-notify-alert.test.ts`: tunnusten ja tilan luku, payload, kuittaus
  vain 200:sta tyhjällä rungolla, varareitti, toimituksen tila, token pois URL:sta, rungosta
  ja lokista. `fetch` on aina mockattu: testit eivät kutsu oikeaa webhookia eivätkä Telegramia.

- `server/src/services/ops-telegram-alert.test.ts`: mockattu fetch, token pois lokista, no-op.
- `server/src/services/webhook-monitor-alerting.test.ts`: viestin sisältö ja throttle.
- `server/src/__tests__/io-watch-telegram.test.ts`: skripti ajetaan väärennetyillä `iostat`-
  ja `curl`-binääreillä. Testi rajaa ajon muuttujalla `IO_WATCH_MAX_SAMPLES`.
