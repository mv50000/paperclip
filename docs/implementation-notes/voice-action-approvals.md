# `voice_action`-hyväksynnät (RK9-479)

Grok-connectorin vaihe 2, taso B. Ääniavustaja ehdottaa sisäistä tikettitoimea. Board hyväksyy sen, ja palvelin toteuttaa tallennetun payloadin.

## Payload

```json
{ "action": "issue_comment", "issueId": "<uuid>", "identifier": "RK9-469", "body": "…", "source": "grok" }
{ "action": "issue_status",  "issueId": "<uuid>", "identifier": "RK9-469", "status": "done", "source": "grok" }
```

- Skeema: `voiceActionApprovalPayloadSchema` (`packages/shared/src/validators/approval.ts`). Tuntematon kenttä pudotetaan pois, koska Slack-forwarder kirjoittaa payloadiin `slackMessageRef`in luonnin jälkeen.
- `body` on 1–1000 merkkiä. `status` on `todo`, `backlog`, `blocked`, `done` tai `cancelled`.
- `identifier` näkyy hyväksyntäkortissa, joten sen täytyy nimetä sama tiketti kuin `issueId`.

## Tarkistukset

- Luonti ja resubmit: vain board-actor (connector käyttää board-tokenia). Agentti saa 403:n. Palvelin validoi payloadin ja tarkistaa, että tiketti kuuluu hyväksynnän yritykselle. Virhe palauttaa 422.
- Hyväksyntä: palvelin tarkistaa saman uudelleen, koska tiketti voi muuttua välissä. Tilamuutos ajetaan `companyGuard`illa.
- Puuttuva ja toisen yrityksen tiketti antavat saman viestin ("issue not found in this company"), jotta ehdotuksella ei voi kartoittaa muiden yritysten tikettejä.

## Missä hyväksytään

- Vain HTTP-reitti `POST /approvals/:id/approve` toteuttaa toimen. Web-UI ja Telegram-kuuntelija käyttävät sitä.
- Slack-kortti ja plugin-chat-bridge kieltäytyvät hyväksymästä `voice_action`ia, koska ne eivät näytä tarkkaa tekstiä eivätkä kutsu toteutusta.

## Tilamuutoksen rajat

Palvelin ei yritä tilamuutosta, jonka `PATCH /issues/:id` hylkäisi tai joka vaatisi reitin omia vaiheita. Syy kirjataan hyväksynnän kommenttiin:

- `blocked` vaatii avoimen blokkerin.
- `done` ja `cancelled` hylätään, kun tiketillä on execution policy tai -state tai kun agentin ajo pitää tikettiä (`executionRunId`, `checkoutRunId`).
- Conversation-tikettien tilaa ei muuteta.

## Toteutus

- Koodi: `server/src/services/rk9-voice-action.ts`, kutsu `approvals.ts`:n approve-käsittelijästä.
- Toimi tehdään issue-palvelun kautta hyväksyjän nimissä (`addComment` tai `update`). Reitin sivuvaikutukset, kuten assigneen herätys kommentista, eivät laukea.
- Lopputulos kirjataan hyväksynnän kommentiksi ja activity logiin (`voice_action.executed` / `voice_action.failed`, tiketille `issue.comment_added` / `issue.updated` ja `details.source: "voice_action"`).
- Virhe ei kaada hyväksyntää: hyväksyntä pysyy `approved`-tilassa, ja virhe näkyy kommentissa. Kommenttiin menee vain 4xx-sääntövirheen teksti; muu virhe jää palvelinlokiin.
- Done-tilamuutos ei herätä riippuvia tikettejä eikä parentia heti. Liveness-backstop hoitaa ne myöhemmin.
- Hylkäys ei tee tiketille mitään.
