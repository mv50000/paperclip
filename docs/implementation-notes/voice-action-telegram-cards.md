# `voice_action`-kortit Telegramissa (RK9-481)

`server/scripts/approval-telegram-listener.mjs` postaa `voice_action`-hyväksynnät (RK9-479) samaan chattiin kuin `email_send`-hyväksynnät. Prosessi, botti ja `state.json` ovat samat.

## Kortti

```
🚗 Grok-ehdotus — <yritys>
Tiketti: <identifier> — <otsikko>
Toimi: kommentti
──────────
<tarkka teksti>
──────────
🔔 herättää: <agentin nimi>
```

- Tilamuutoksessa toimirivi on `Toimi: tilamuutos <nykyinen> → <uusi>`.
- Kuuntelija lukee tiketin (`GET /issues/:id`) ja assigneen nimen (`GET /agents/:id`) kortin postaushetkellä. Kortti ei päivity, jos assignee vaihtuu myöhemmin.
- `🔔`-rivi näkyy, kun tiketillä on assignee-agentti (operaattorin päätös 11.10.2026, RK9-490). Ilman assigneeta riviä ei ole. Kun tiketti ei aukea, rivi kertoo, että herätettävä agentti ei ole tiedossa.
- Kommenttia ei lyhennetä, koska operaattori hyväksyy tarkan tekstin. Skeema rajaa sen 1000 merkkiin.
- Viesti lähtee ilman `parse_mode`a, joten teksti ei voi muotoilla korttia.

## Painikkeet

- `✅ Hyväksy` (`pa:a:<id>`) kutsuu `POST /approvals/:id/approve`. Palvelin toteuttaa toimen, ja kortti näyttää palvelimen lopputuloskommentin (`✅ Toteutettu: …` tai `⚠️ Hyväksytty, mutta …`).
- `❌ Hylkää` (`pa:r:<id>`) pyytää perustelun ForceReplyllä ja kutsuu `POST /approvals/:id/reject`. Tikettiin ei tehdä muutosta.
- `✏️ Revisiota` ei ole. Kuuntelija ohittaa `pa:v`-napautuksen `voice_action`-kortilla, jotta muokattu callback ei pääse `request-revision`-reitille.
- Muualla päätetty kortti suljetaan seuraavassa skannauksessa (`☑️ Käsitelty muualla`), kuten `email_send`issä.

## Tila

`state.posted[approvalId].type` kertoo kortin tyypin, ja ForceReply-kehote kantaa sen kentässä `approvalType`. Tyyppi valitsee hylkäyksen tekstit. Ennen RK9-481:tä tallennetuissa riveissä kenttä puuttuu, ja ne käsitellään `email_send`inä.

## Käyttöönotto

Kopioi skripti hakemistoon `/opt/paperclip/` ja aja `systemctl restart paperclip-approval-telegram`. Paperclip-palvelin ei tarvitse restarttia.

Testi: `server/src/__tests__/approval-telegram-listener-voice-action.test.ts`.
