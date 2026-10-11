# `voice_action`-kortit Telegramissa (RK9-481)

`server/scripts/approval-telegram-listener.mjs` postaa `voice_action`-hyväksynnät (RK9-479) samaan chattiin kuin `email_send`-hyväksynnät. Prosessi, botti ja `state.json` ovat samat.

## Kortti

```
🚗 Grok-ehdotus — <yritys>
Tiketti: <identifier> — <otsikko>
Toimi: kommentti
│ <tarkka teksti, rivi 1>
│ <rivi 2>
🔔 herättää: <agentin nimi>
```

- Tilamuutoksessa toimirivi on `Toimi: tilamuutos <nykyinen> → <uusi>`.
- Kuuntelija lukee tiketin (`GET /issues/:id`) ja assigneen nimen (`GET /agents/:id`) kortin postaushetkellä. Kortti ei päivity, jos assignee vaihtuu myöhemmin.
- `🔔`-rivi näkyy, kun tiketillä on assignee-agentti (operaattorin päätös 11.10.2026, RK9-490). Ilman assigneeta riviä ei ole. Kun tiketti ei aukea, rivi kertoo, että herätettävä agentti ei ole tiedossa.
- Rivi pitää paikkansa vasta, kun RK9-490 on käytössä: RK9-479:n palvelin ei vielä herätä assigneeta. Ota kuuntelija käyttöön RK9-490:n kanssa tai sen jälkeen.
- Kommenttia ei lyhennetä, koska operaattori hyväksyy tarkan tekstin. Skeema rajaa sen 1000 merkkiin.
- Jokainen kommenttirivi alkaa merkeillä `│ `. Teksti ei siksi voi näyttää kortin omalta riviltä, kuten väärennetyltä `🔔`- tai `Toimi:`-riviltä. Rivinvaihdoksi lasketaan `\n`:n lisäksi `\r`, `\v`, `\f`, U+0085, U+2028 ja U+2029.
- Otsikko ja agentin nimi kirjoitetaan yhdelle riville ja lyhennetään (200 ja 100 merkkiä). Kortti pysyy Telegramin 4096 merkin rajan alla.
- Viesti lähtee ilman `parse_mode`a, joten teksti ei voi muotoilla korttia.
- Jos tiketin tai agentin haku heittää virheen (yhteysvirhe, aikakatkaisu), kortti jää postaamatta ja yritetään seuraavassa skannauksessa. Muut kortit ja siivous ajetaan silti.

## Painikkeet

- `✅ Hyväksy` (`pa:a:<id>`) kutsuu `POST /approvals/:id/approve`. Palvelin toteuttaa toimen, ja kortti näyttää palvelimen lopputuloskommentin (`✅ Toteutettu: …` tai `⚠️ Hyväksytty, mutta …`).
- `❌ Hylkää` (`pa:r:<id>`) pyytää perustelun ForceReplyllä ja kutsuu `POST /approvals/:id/reject`. Tikettiin ei tehdä muutosta.
- `✏️ Revisiota` ei ole. Kuuntelija ohittaa `pa:v`-napautuksen `voice_action`-kortilla, jotta muokattu callback ei pääse `request-revision`-reitille. Palvelin sallii revision `voice_action`ille, joten tämä tarkistus on kuuntelijassa.
- Muualla päätetty kortti suljetaan seuraavassa skannauksessa (`☑️ Käsitelty muualla`), kuten `email_send`issä.
- Board voi pyytää revisiota ja lähettää uuden payloadin kahden skannauksen välissä. Hyväksyntä on silloin taas `pending`. Kortin rivi tallentaa siksi näytettyjen kenttien allekirjoituksen (`sig`). Kun allekirjoitus muuttuu, vanha kortti suljetaan (`♻️ Ehdotus muuttui`) ja uusi postataan. Payloadin muut kentät (esim. `slackMessageRef`) eivät postaa korttia uudelleen.

## Tila

`state.posted[approvalId].type` kertoo kortin tyypin, ja ForceReply-kehote kantaa sen kentässä `approvalType`. Tyyppi valitsee hylkäyksen tekstit. 
Jos napautetun kortin rivi puuttuu tilasta tai siltä puuttuu tyyppi, kuuntelija hakee tyypin palvelimelta (`GET /approvals/:id`). Ennen käyttöönottoa postatun `email_send`-kortin ✏️ toimii siksi edelleen. Jos haku epäonnistuu, `pa:v` hylätään ja operaattori ohjataan Paperclip-UI:hin.

## Käyttöönotto

Kopioi skripti hakemistoon `/opt/paperclip/` ja aja `systemctl restart paperclip-approval-telegram`. Paperclip-palvelin ei tarvitse restarttia.

Testi: `server/src/__tests__/approval-telegram-listener-voice-action.test.ts`.
