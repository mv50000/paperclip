# Host-vahtien Telegram-hälytykset (RK9-710)

RK9-697 poisti forkin Slack-ilmoitukset 3.11.2026. Operaattori päätti samana päivänä,
että kaksi vahtia lähettää hälytyksensä Telegramiin. Agentin liveness ja system pause
jäävät lokiin ja UI:hin, eikä liveness watchdogia palauteta.

| Vahti | Lähettäjä | Loki |
|---|---|---|
| `server/scripts/check-github-webhook-health.ts` | `server/src/services/ops-telegram-alert.ts` (fetch) | `/var/log/paperclip-webhook-monitor.log` |
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
- `--dry-run` ei lähetä Telegramiin.

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

## Testit

- `server/src/services/ops-telegram-alert.test.ts`: mockattu fetch, token pois lokista, no-op.
- `server/src/services/webhook-monitor-alerting.test.ts`: viestin sisältö ja throttle.
- `server/src/__tests__/io-watch-telegram.test.ts`: skripti ajetaan väärennetyillä `iostat`-
  ja `curl`-binääreillä. Testi rajaa ajon muuttujalla `IO_WATCH_MAX_SAMPLES`.
