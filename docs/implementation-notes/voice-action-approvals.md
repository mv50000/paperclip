# `voice_action`-hyväksynnät (RK9-479)

Grok-connectorin vaihe 2, taso B. Ääniavustaja ehdottaa sisäistä tikettitoimea. Board hyväksyy sen, ja palvelin toteuttaa tallennetun payloadin.

## Payload

```json
{ "action": "issue_comment", "issueId": "<uuid>", "identifier": "RK9-469", "body": "…", "source": "grok" }
{ "action": "issue_status",  "issueId": "<uuid>", "identifier": "RK9-469", "status": "done", "source": "grok" }
```

- Skeema: `voiceActionApprovalPayloadSchema` (`packages/shared/src/validators/approval.ts`). Tuntematon kenttä hylätään.
- `body` on 1–1000 merkkiä. `status` on `todo`, `backlog`, `blocked`, `done` tai `cancelled`.
- `identifier` näkyy hyväksyntäkortissa, joten sen täytyy nimetä sama tiketti kuin `issueId`.

## Tarkistukset

- Luonti ja resubmit: palvelin validoi payloadin ja tarkistaa, että tiketti kuuluu hyväksynnän yritykselle. Virhe palauttaa 422.
- Hyväksyntä: palvelin tarkistaa saman uudelleen, koska tiketti voi muuttua välissä. Tilamuutos ajetaan `companyGuard`illa.
- Puuttuva ja toisen yrityksen tiketti antavat saman viestin ("issue not found in this company"), jotta ehdotuksella ei voi kartoittaa muiden yritysten tikettejä.

## Toteutus

- Koodi: `server/src/routes/rk9-voice-action.ts`, kutsu `approvals.ts`:n approve-käsittelijästä.
- Toimi tehdään issue-palvelun kautta hyväksyjän nimissä (`addComment` tai `update`). Reitin sivuvaikutukset, kuten assigneen herätys kommentista, eivät laukea.
- Lopputulos kirjataan hyväksynnän kommentiksi ja activity logiin (`voice_action.executed` / `voice_action.failed`, tiketille `issue.comment_added` / `issue.updated` ja `details.source: "voice_action"`).
- Virhe ei kaada hyväksyntää: hyväksyntä pysyy `approved`-tilassa, ja virhe näkyy kommentissa.
- Hylkäys ei tee tiketille mitään.
