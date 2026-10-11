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
- Kirjoituksen jälkeen: unblock-omistajan herätys, routine-synkronointi, recovery-actionin uudelleenarviointi (sama `revalidateActiveSourceRecoveryAfterCommittedWrite` kuin reitillä; kommentilla `trigger: "comment"`), handoff-kirjaus, assigneen herätys backlog/blocked/suljettu → todo -siirrossa, riippuvien tikettien ja parentin herätys sekä terminaalisiivous.
- Logiikka on `issueRoutes`in sulkeumissa, joita `PATCH /issues/:id` ja `POST /issues/:id/comments` kutsuvat. `issueRoutes` antaa ne `VoiceActionIssueEffectsSlot`in kautta approve-reitille (`app.ts`). Jos slotti on tyhjä, toimi hylätään.
- Goalin pysäytyksen 409 hylkää toimen ennen kirjoitusta. Kirjoituksen jälkeiset vaiheet ajetaan toisistaan riippumatta. Sivuvaikutusvirhe ei muuta tulosta: kommenttiin lisätään "sivuvaikutukset epäonnistuivat" ja virhe jää palvelinlokiin.
- Hylätään eikä toteuteta reitin erityispolkua:
  - Kommentti tikettiin, jonka isolated workspace on suljettu (kommenttireitti avaisi sen).
  - Kommentti, jonka kommenttireitti tulkitsisi odottavan reviewn hyväksynnäksi (`commentApprovesPendingReview`).
  - Kommentti, jonka UI:n kommenttireitti avaisi uudelleen todo-tilaan: suljettu tai blocked tiketti ilman avointa blokkeria, kun assignee on agentti, tai in_progress-tiketti, jolla on ajastettu uusinta. Ehto on `humanCommentMovesIssueToTodo`, joka käyttää reitin omia predikaatteja.
  - Skill test -tiketin tilamuutos (reitti päättää testiajon).
  - `blocked`/`cancelled` tiketille, jonka parent saa stop-raportin (`directParentReportDisabledForIssue`).
- Goalin pysäytys voi odottaa 30 s. Siksi palvelin lukee tiketin uudelleen ja toistaa staleness- ja tilatarkistukset ennen kirjoitusta. Jos tarkistus hylkää, jo pysäytetty goal ja ajo mainitaan kommentissa.
- Goalin pysäytys voi venyttää approve-pyynnön yli Telegram-kuuntelijan 30 s aikakatkaisun. Kuuntelijan korjaus on erillisessä seurantatiketissä.
- Ei mukana: blocked-tilan `issue.blockers_restored`-herätys, koska voice-`blocked` vaatii avoimen blokkerin.

## Toteutus

- Koodi: `server/src/services/rk9-voice-action.ts`, kutsu `approvals.ts`:n approve-käsittelijästä.
- Toimi tehdään issue-palvelun kautta hyväksyjän nimissä (`addComment` tai `update`). Sivuvaikutukset ks. yllä.
- Lopputulos kirjataan hyväksynnän kommentiksi ja activity logiin (`voice_action.executed` / `voice_action.failed`, tiketille `issue.comment_added` / `issue.updated` ja `details.source: "voice_action"`).
- Virhe ei kaada hyväksyntää: hyväksyntä pysyy `approved`-tilassa, ja virhe näkyy kommentissa. Kommenttiin menee vain 4xx-sääntövirheen teksti; muu virhe jää palvelinlokiin.
- Hylkäys ei tee tiketille mitään.
