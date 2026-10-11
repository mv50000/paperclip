# `voice_action`-hyväksynnät (RK9-479)

Grok-connectorin vaihe 2, taso B. Ääniavustaja ehdottaa sisäistä tikettitoimea. Board hyväksyy sen, ja palvelin toteuttaa tallennetun payloadin.

## Payload

```json
{ "action": "issue_comment", "issueId": "<uuid>", "identifier": "RK9-469", "body": "…", "source": "grok" }
{ "action": "issue_status",  "issueId": "<uuid>", "identifier": "RK9-469", "status": "done", "source": "grok" }
```

Palvelin lisää tallennettuun payloadiin kentät `issueStatusAtProposal` ja `assigneeAgentIdAtProposal` tiketin nykytilasta (RK9-490). Ehdotuksen lähettämät arvot ohitetaan.

- Skeema: `voiceActionApprovalPayloadSchema` (`packages/shared/src/validators/approval.ts`). Tuntematon kenttä pudotetaan pois, koska Slack-forwarder kirjoittaa payloadiin `slackMessageRef`in luonnin jälkeen.
- `body` on 1–1000 merkkiä. `status` on `todo`, `backlog`, `blocked`, `done` tai `cancelled`.
- `identifier` näkyy hyväksyntäkortissa, joten sen täytyy nimetä sama tiketti kuin `issueId`.
- `body` hylätään, jos `redactEventPayload` muuttaisi sitä (esim. JWT tai credential-tyyppinen teksti). Hyväksyntänäkymä näyttää payloadin redaktoituna, joten operaattori ei muuten näkisi tarkkaa tekstiä.

## Tarkistukset

- Luonti ja resubmit: vain board-actor (connector käyttää board-tokenia). Agentti saa 403:n. Palvelin validoi payloadin ja tarkistaa, että tiketti kuuluu hyväksynnän yritykselle. Virhe palauttaa 422. Palvelin tallentaa parsitun payloadin, joten esim. `title` ei voi saada inbox-riviä kuvaamaan eri toimea. Inbox- ja attention-rivi näyttävät tiketin ja uuden tilan tai tekstin alun.
- Hyväksyntä: palvelin tarkistaa saman uudelleen, koska tiketti voi muuttua välissä. Tilamuutos ajetaan `companyGuard`illa.
- Staleness (RK9-490): hyväksyntä hylätään, jos tiketin tila tai assignee-agentti on muuttunut ehdotuksen jälkeen. Hylätään myös ehdotus, jolta snapshot puuttuu (luotu ennen RK9-490:tä). Tämä koskee kommenttia ja tilamuutosta.
- Puuttuva ja toisen yrityksen tiketti antavat saman viestin ("issue not found in this company"), jotta ehdotuksella ei voi kartoittaa muiden yritysten tikettejä.

## Missä hyväksytään

- Vain HTTP-reitti `POST /approvals/:id/approve` toteuttaa toimen. Web-UI ja Telegram-kuuntelija käyttävät sitä.
- Slack-kortti ja plugin-chat-bridge kieltäytyvät hyväksymästä `voice_action`ia, koska ne eivät näytä tarkkaa tekstiä eivätkä kutsu toteutusta.

## Tilamuutoksen rajat

Palvelin ei yritä tilamuutosta, jonka `PATCH /issues/:id` hylkäisi tai joka vaatisi reitin omia vaiheita. Syy kirjataan hyväksynnän kommenttiin:

- Tilaa ei muuteta, kun tiketillä on execution policy tai -state tai kun tiketti on `in_review`-tilassa (review-säännöt elävät PATCH-reitissä).
- `blocked` vaatii avoimen blokkerin.
- Conversation-tikettiin ei kommentoida eikä sen tilaa muuteta: vain keskustelun omistaja kirjoittaa agentti-chattiin.

## Sivuvaikutukset (RK9-490)

Operaattorin päätös 11.10.2026: hyväksytty `voice_action` toimii kuin sama toimi UI:ssa.

- Kommentti: tauotetun puun tarkistus (`assertBoardCommentNotPaused`-logiikka), viittausten synkronointi, aktiivisen goalin ohjaus, korvattujen vahvistusten vanhentaminen sekä assigneen ja @-mainittujen herätys.
- `done`/`cancelled`: assigneen runner goal pysäytetään ennen kirjoitusta, ja goalin ajo perutaan. `cancelled` peruu lisäksi tiketin aktiivisen ajon.
- Kirjoituksen jälkeen: unblock-omistajan herätys, routine-synkronointi, assigneen herätys backlog/blocked/suljettu → todo -siirrossa, riippuvien tikettien ja parentin herätys sekä terminaalisiivous.
- Logiikka on `issueRoutes`in sulkeumissa, joita `PATCH /issues/:id` ja `POST /issues/:id/comments` kutsuvat. `issueRoutes` antaa ne `VoiceActionIssueEffectsSlot`in kautta approve-reitille (`app.ts`). Jos slotti on tyhjä, toimi hylätään.
- Goalin pysäytyksen 409 hylkää toimen ennen kirjoitusta. Kirjoituksen jälkeinen sivuvaikutusvirhe ei muuta tulosta: kommenttiin lisätään "sivuvaikutukset epäonnistuivat" ja virhe jää palvelinlokiin.
- Ei mukana: kommentilla tehtävä uudelleenavaus suljettuun tikettiin (staleness-tarkistus ja `shouldWakeAssigneeForIssueComment` hoitavat suljetun tiketin), suljetun isolated workspacen uudelleenavaus (PATCH tekee sen vain agentille tai kommentilla) ja blocked-tilan `issue.blockers_restored`-herätys (voice-`blocked` vaatii avoimen blokkerin).

## Toteutus

- Koodi: `server/src/services/rk9-voice-action.ts`, kutsu `approvals.ts`:n approve-käsittelijästä.
- Toimi tehdään issue-palvelun kautta hyväksyjän nimissä (`addComment` tai `update`). Sivuvaikutukset ks. yllä.
- Lopputulos kirjataan hyväksynnän kommentiksi ja activity logiin (`voice_action.executed` / `voice_action.failed`, tiketille `issue.comment_added` / `issue.updated` ja `details.source: "voice_action"`).
- Virhe ei kaada hyväksyntää: hyväksyntä pysyy `approved`-tilassa, ja virhe näkyy kommentissa. Kommenttiin menee vain 4xx-sääntövirheen teksti; muu virhe jää palvelinlokiin.
- Hylkäys ei tee tiketille mitään.
