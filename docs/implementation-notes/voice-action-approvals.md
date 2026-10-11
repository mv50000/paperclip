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

- Kommentti:
  - Palvelin tarkistaa tauotetun puun samalla tavalla kuin `assertBoardCommentNotPaused`.
  - Palvelin synkronoi viittaukset ja vanhentaa korvatut vahvistuspyynnöt.
  - Palvelin herättää assigneen (`issue_commented`) ja @-mainitut agentit (`issue_comment_mentioned`).
- Tilamuutos, kirjoituksen jälkeen:
  - unblock-omistajan herätys, kun tiketti siirtyy `blocked`-tilaan
  - routine-synkronointi
  - assigneen herätys (`issue_status_changed`), kun tiketti siirtyy backlogista tai blocked-, done- tai cancelled-tilasta todo-tilaan
  - riippuvien tikettien herätys (`issue_blockers_resolved`), kun tila on `done`
  - terminaalisiivous: odottavien interaktioiden vanhennus ja sandbox-leasejen purku
  - parentin herätys (`issue_children_completed`)
- Kirjoituksen jälkeiset vaiheet ajetaan toisistaan riippumatta. Sivuvaikutusvirhe ei muuta tulosta. Kommenttiin lisätään "sivuvaikutukset epäonnistuivat", ja virhe jää palvelinlokiin.
- Herätteiden muoto (reason, payload, contextSnapshot) on sama kuin reiteillä. `voice-action-wake-parity.test.ts` ajaa reitin ja voice-polun samoja mockeja vasten ja vertaa herätekutsuja.

### Poikkeama: hylkää, ei pysäytä

UI:n `PATCH /issues/:id` pysäyttää `done`/`cancelled`-siirrossa assigneen runner goalin ja aktiivisen ajon sekä ratkaisee recovery actionin. Voice-polku ei tee näitä. Se hylkää toimen selkeällä syyllä, ja operaattori tekee muutoksen Paperclipissa:

- `done`/`cancelled`, kun assigneella on tällä tiketillä aktiivinen tai odottava runner goal
- `done`/`cancelled`, kun tiketillä on käynnissä oleva ajo
- mikä tahansa tilamuutos, kun tiketillä on aktiivinen recovery action
- `blocked`/`cancelled` tiketille, jolla on parent, koska PATCH voi lähettää parentille stop-raportin
- skill test -tiketin tilamuutos, koska reitti päättää testiajon
- kommentti, jonka kommenttireitti muuttaisi muuksi kuin kommentiksi:
  - tiketin avaus uudelleen todo-tilaan (`shouldImplicitlyMoveCommentedIssueToTodo`); blocked-tiketti, jolla on avoin blokkeri, pysyy blocked-tilassa, joten kommentti sallitaan
  - ajastetun uusinnan jatko
  - suljetun isolated workspacen avaus
  - reviewn hyväksyntä (`isApprovalReviewComment`)

Syy on forkin hygienia. Upstream muuttaa `server/src/routes/issues.ts`:ää jatkuvasti, ja reitin sulkeumien jakaminen olisi tehnyt jokaisesta upstream-mergestä konfliktin. Siksi `issues.ts`:ään lisätään vain kaksi `export`-sanaa (`isApprovalReviewComment`, `shouldImplicitlyMoveCommentedIssueToTodo`). `rk9-voice-action.ts` kutsuu palveluja suoraan (`rk9-voice-action-deps.ts`). Hylkäys korvaa myös goalin pysäytyksen 30 s odotuksen, joten approve-pyyntö ei enää veny yli Telegram-kuuntelijan aikakatkaisun (RK9-502).

Kun upstream muuttaa reitin sivuvaikutuksia, päivitä `rk9-voice-action.ts`. Parity-testi kaatuu, jos herätteiden muoto eroaa.

## Toteutus

- Koodi: `server/src/services/rk9-voice-action.ts` ja palvelut `rk9-voice-action-deps.ts`. Kutsu tulee `approvals.ts`:n approve-käsittelijästä.
- Toimi tehdään issue-palvelun kautta hyväksyjän nimissä (`addComment` tai `update`). Sivuvaikutukset ks. yllä.
- Lopputulos kirjataan hyväksynnän kommentiksi ja activity logiin (`voice_action.executed` / `voice_action.failed`, tiketille `issue.comment_added` / `issue.updated` ja `details.source: "voice_action"`).
- Virhe ei kaada hyväksyntää: hyväksyntä pysyy `approved`-tilassa, ja virhe näkyy kommentissa. Kommenttiin menee vain 4xx-sääntövirheen teksti; muu virhe jää palvelinlokiin.
- Hylkäys ei tee tiketille mitään.
