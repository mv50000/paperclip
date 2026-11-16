# Aavan lähetyspyynnön Telegram-kortti (RK9-894)

`server/scripts/approval-telegram-listener.mjs` postaa Aavan portin pidättämän viestin korttina samaan chattiin kuin `email_send`- ja `voice_action`-hyväksynnät. Prosessi, botti ja `state.json` ovat samat. Suunnitelma: RK9-873 (vaihe 2). Relay, joka luo approvalit ja vie päätöksen portille: RK9-903.

## Mikä saa kortin

Kortin saa approval, jonka tyyppi on `request_board_approval`, `payload.kind` on `aava_send` ja yhtiön `issuePrefix` on `AAVA_TG_COMPANY_PREFIX` (oletus `RK9`). Tyhjä arvo sulkee lähteen.

- Muut `request_board_approval`it (esim. tool-gatewayn formaali approval) ohitetaan. Niiden napautus (väärennetty callback tai tilasta kadonnut rivi) torjutaan, eikä approve- tai reject-reittiä kutsuta.
- Payloadin pitää täyttää RK9-894:n sopimus: `version: 1`, `gateId` muotoa `g-<16 heksaa>`, `op` on `reply` tai `new`, `from` ja jokainen `to` ovat osoitteita, `to` ei ole tyhjä, ja `subject`, `body` ja `reasons` ovat merkkijonoja. Rikkova payload ei saa korttia. Kuuntelija lokittaa sen kerran per prosessi.
- Peitetty sisältö tai virheellinen `sha256` tuottaa ❌-kortin, ks. alla.

## Kortti

```
📨 Aava: lähetys odottaa — RK9
From: aava@rk9.fi
To: vastaanottaja@example.com
Aihe: Re: aihe
Tyyppi: vastaus ketjuun
Syyt: uusi vastaanottaja, seulasana "hinta"
Tunniste: g-0123456789abcdef · sha256 0123456789ab…
──────────
│ <runko, rivi 1>
│ <rivi 2>
```

- Napit: `✅ Lähetä` (`pa:a:<id>`) ja `❌ Hylkää` (`pa:r:<id>`). ✏️-nappia ei ole, koska portti pitää yhtä kiinteää viestiä.
- Syykoodit näytetään selkokielellä (`new-recipient` → uusi vastaanottaja, `screen:<sana>` → seulasana). Tuntematon koodi näytetään sellaisenaan.
- Useamman vastaanottajan rivi kertoo määrän (`To (3): …`). Kortti näyttää 20 ensimmäistä osoitetta ja kertoo loppujen määrän.

### Epäluotettava sisältö

From, To, aihe ja runko voivat tulla ulkopuoliselta lähettäjältä. Kuuntelija käsittelee ne näin:

- Viesti lähtee ilman `parse_mode`a, joten teksti ei voi muotoilla korttia. Linkkien esikatselu on pois päältä (`link_preview_options.is_disabled`).
- Merkkien `/`, `@`, `#` ja `$` jälkeen lisätään WORD JOINER (U+2060), kun niitä seuraa kirjain, numero tai alaviiva. Telegram ei silloin tee tekstistä napautettavaa komentoa (`/start`), mainintaa (`@botti`), hashtagia tai cashtagia. Teksti näyttää samalta. Kopioitu osoite sisältää näkymättömän merkin.
- Bidi-ohjausmerkit (U+202A–U+202E, U+2066–U+2069) ja C0-ohjausmerkit poistetaan, jotta osoite ei näy väärässä järjestyksessä.
- Otsakkeet kirjoitetaan yhdelle riville. Rivinvaihdoksi lasketaan sama joukko kuin `voice_action`-kortissa (`\n`, `\r`, `\v`, `\f`, U+0085, U+2028, U+2029).
- Rungon jokainen rivi alkaa merkeillä `│ `. Runko ei siksi voi näyttää kortin omalta riviltä, kuten väärennetyltä `To:`- tai `✅ Hyväksytty`-riviltä.
- Runko katkaistaan niin, että kortti pysyy Telegramin 4096 merkin rajan alla. Katkaistun kortin lopussa on rivi `✂️ Runko katkaistu: näytetty N / M merkkiä`.

### Peitetty sisältö: vain ❌

Approvalien lukureitit ajavat payloadin `redactEventPayload`in läpi (`server/src/redaction.ts`). Ne korvaavat salaisuudelta näyttävät arvot merkkijonolla `***REDACTED***` (`REDACTED_EVENT_VALUE`, sama kuin adapter-utilsin `REDACTED_COMMAND_TEXT_VALUE`). Esimerkiksi `token=abc` → `token=***REDACTED***`, `Authorization: Bearer …` → `Authorization: ***REDACTED***`. Portti lähettäisi silti alkuperäisen viestin.

Operaattori ei saa hyväksyä viestiä, jota hän ei nähnyt kokonaan (orkestroijan päätös 16.11.2026). Kortti on siksi ❌-kortti, kun jokin näistä pätee:

- `from`, jokin `to`-osoite, `subject` tai `body` sisältää merkkijonon `***REDACTED***`
- `sha256` puuttuu tai ei ole 64 pientä heksaa.

Kortti näyttää silloin rivin `⚠️ Sisältöä on peitetty, viesti ei vastaa lähtevää. Tätä ei voi hyväksyä.` ja vain napin `❌ Hylkää`. Väärennetty tai vanha ✅ torjutaan, koska ✅ lukee approvalin ja vaatii peittämättömän payloadin. Relay (RK9-903) tarkistaa saman omalla puolellaan: se vertaa approvalista takaisin luettua runkoa lähettämäänsä eikä kutsu `decide approve`a, jos ne eroavat.

Kentät `sha256` ja `gateId` eivät peity: avaimet eivät osu salaisuusavainten kaavaan, eikä arvoskanneri peitä heksaa. Tarkistettu 16.11.2026 ajamalla `redactEventPayload` 5000 satunnaiselle tiivisteelle ja tunnisteelle, ja yksikään ei peittynyt. Kenttämuotoa ei siksi tarvitse vaihtaa.

## Päätös

- ✅ lukee ensin approvalin (`GET /approvals/:id`). Kuuntelija hyväksyy vain, kun approval on yhä `pending`, payload täyttää sopimuksen ja sen allekirjoitus on sama kuin kortilla. Muuten napautus torjutaan, ja seuraava skannaus postaa uuden kortin. Tilasta kadonneella rivillä ei ole allekirjoitusta, joten sen ✅ torjutaan aina. Tämä kaventaa `voice_action`-muistion rajaa (revisio skannausten välissä), mutta ei poista sitä: GET:n ja POST:n väliin jää alle sekunnin ikkuna.
- ✅ kutsuu `POST /approvals/:id/approve` kerran. Palvelin ei lähetä tälle tyypille mitään, joten hyväksyntä on lopputulos. Kortiksi päivittyy `✅ Hyväksytty. Relay vie päätöksen Aavan portille…` ja vastaanottaja ja aihe.
- ❌ pyytää perustelun ForceReplyllä ja kutsuu `POST /approvals/:id/reject` kerran. Perustelu tallentuu `decisionNote`ksi.
- Jos approve aikakatkaistaan tai saa 5xx:n, kuuntelija ei hyväksy uudelleen (RK9-502). Kun approval näkyy `approved`-tilassa, kortti päivittyy samaan lopputulokseen ilman 30 minuutin odotusta palvelimen kommentille.
- Muualla päätetty kortti suljetaan seuraavassa skannauksessa (`☑️ Käsitelty muualla`).

## Muuttunut payload

Kortin rivi tallentaa allekirjoituksen kentistä `gateId`, `op`, `from`, `to`, `subject`, `body`, `reasons` ja `sha256` (malli `voiceSignature`). Kun allekirjoitus muuttuu, vanha kortti suljetaan (`♻️ Lähetyspyyntö muuttui`) ja uusi postataan. Vanhan kortin ✅ torjutaan, koska viestin id ei ole enää tilan `messageId`.

## Sivuvaikutukset hyväksynnässä (tarkistettu 16.11.2026)

`request_board_approval`in hyväksyntä ei lähetä sähköpostia eikä aja työkalua. `POST /approvals/:id/approve` (`server/src/routes/approvals.ts`) tekee tälle tyypille vain seuraavat asiat:

- `svc.approve` → `resolveApproval`. Vain `hire_agent` saa oman polun.
- Live-tapahtuma `approval.decided`.
- Aktiviteettirivi `approval.approved`.
- Pyytäjäagentin herätys, jos `requestedByAgentId` on asetettu. Relay luo approvalin board-avaimella, joten agenttia ei ole.
- Linkitettyjen tikettien review-polun herätykset. Relay ei linkitä tikettejä.

`email_send`- ja `voice_action`-haarat ajetaan vain omalle tyypilleen. Tool-gateway (`server/src/services/tool-gateway.ts`) lukee formaalin approvalin tilan vain oman `actionRequest.approvalId`:nsä kautta. Relayn luoma approval ei ole minkään action requestin approval, joten sen hyväksyntä ei aja työkalua.

## Käyttöönotto

Palvelu ajaa skriptin polusta `/opt/paperclip/server/scripts/approval-telegram-listener.mjs` (`paperclip-approval-telegram.service`). Päivitä `/opt/paperclip` mergetyn masterin tasolle ja aja `sudo systemctl restart paperclip-approval-telegram`. Paperclip-palvelin ei tarvitse restarttia. Ympäristömuuttujaa ei tarvitse lisätä, koska `AAVA_TG_COMPANY_PREFIX` on oletuksena `RK9`.

Testi: `server/src/__tests__/approval-telegram-listener-aava-send.test.ts`.
