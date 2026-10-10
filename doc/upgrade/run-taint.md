# Tainted-ajon portti ulospäin näkyville toimille (RK9-319)

RK9 Custom. Upstreamissa ei ole vastinetta. Upgrade-portaassa säilytä `rk9-run-taint.ts`, `rk9-run-taint-tool-gate.ts` ja niiden kutsut.

## Miksi

Inbound-sähköposti ja outreach-vastaukset päätyvät agentille, jolla on yrityksen API-avain ja lähetysoikeus.
Prompt injection voi saada agentin lähettämään sähköpostia hyökkääjän osoitteeseen.
Mallia ei voi opettaa kieltäytymään, joten palvelin pitää valtuudet (confused deputy, Buzzin arvio 26.9.2026).

## Miten

- Taulu `rk9_run_taints` (migraatio 9014): yksi rivi per ajo, `tainted_at` ja `sources` (vain viittaukset, ei sisältöä).
  Oma taulu, ei sarakkeita upstreamin `heartbeat_runs`iin: upstream-tiedosto pysyy ennallaan ja snapshot-drift-testi ohittaa fork-taulut.
- Merkintä on monotoninen. Mikään reitti ei kirjoita taulua agentin syötteestä, eikä mikään koodipolku poista riviä.
- Palvelin merkitsee ajon kolmessa kohdassa:
  - **Claim** (`heartbeat.ts`, `claimQueuedRun`): ajo on herätetty inbound-sähköpostista, sen issuella on inbound-viesti, sen herätti tainted-ajo tai se jatkaa tainted-ajon Claude-sessiota.
  - **Rungon luku** (`GET /companies/:id/email/messages/:id/body`): lukeva ajo merkitään ennen kuin runko lähtee palvelimelta.
  - **Portti** (laiska tarkistus): jos claim-merkintä jäi tekemättä, portti laskee saman ehdon ja merkitsee ajon.
- Portit käyttävät olemassa olevia hyväksyntöjä:
  - **Sähköposti** (`/email/send`, `/email/reply`): tainted-ajon lähetys menee aina `email_send`-hyväksyntään, myös graduoidulla reitillä (`approval_required = false`).
    Hyväksynnän payloadissa on `taint`, activityssä `gate: route | taint | route+taint`, ja Telegram-kortissa on ⚠️-rivi.
    Eskalaatio CEO:lle sallitaan, koska vastaanottaja on kiinteä.
  - **GitHub-tunnukset** (`resolveGitHubOperationCredentials`): tainted-ajo saa `status: "unavailable"` kuten low-trust-ajo.
  - **Tool gateway** (`tool-access-policy.ts`, `decide`): sallittu kutsu, jonka riski ei ole `read` tai `low`, muuttuu `require_approval`-päätökseksi (`requires_approval_tainted_run`).
    Tuntematon riskitaso pysäköidään. Portti ei koskaan löysää upstreamin päätöstä.
- Tunnisteet: run-JWT sitoo yhden ajon. Pitkäikäinen agent key ei sido ajoa, joten agentin kaikki `queued`- ja `running`-ajot lasketaan (fail closed).
- Näkyvyys: run-näkymä (`GET /heartbeat-runs/:id` palauttaa `rk9Taint`, UI näyttää `RunTaintNotice`n), `activity_log` (`heartbeat_run.tainted`) ja run log (`rk9.run.tainted`, ks. `doc/run-log-events.md`).

## Rajat

- Bash-kykyinen agentti voi lähettää dataa ulos `curl`illa (RK9-156). Portti kattaa vain Paperclipin API:n kautta tehdyt toimet.
- Toisen asteen injektio ilman herätystä: puhdas ajo voi lukea tainted-ajon kommentin myöhemmin. Kommenttitason taint on jatkotiketti.
- Agent key ilman aktiivista ajoa: rungon luku ei merkitse mitään ajoa, joten seuraava lähetys samalla avaimella ajon ulkopuolella ei pysäköidy.
- Plugin-työkalut (`/plugins/tools/execute`) ja upstreamin chat-kanavat jäävät ilman taint-porttia.
- Hyväksyjä näkee merkinnän, mutta voi silti hyväksyä viestin.

## Testit

`doc/upgrade/fork-tests.txt`, rivi `# RK9-319`. AC-testi on `server/src/__tests__/rk9-run-taint-e2e.test.ts`.
