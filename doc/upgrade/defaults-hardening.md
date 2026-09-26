# Oletusten kovennus — tarkistuslista porrasta kohden

Päivitetty 2026-09-26 ([RK9-309](/RK9/issues/RK9-309), epic [RK9-303](/RK9/issues/RK9-303)).
Tämä on `doc/UPSTREAM-UPGRADE.md`:n osion "Oletusten kovennus" yksityiskohtainen sisältö.
Osion taulukko "RK9-oletukset" on tiivistelmä, tämä tiedosto kertoo, mitä kukin porras tekee.

Lähteet on todennettu paikallisista upstream-tageista (`git show <tag>:<polku>` ja
`git grep <kuvio> <tag>` hakemistossa `/home/rk9admin/paperclip`, remote `upstream`) sekä
komennolla `gh pr view <N> --repo paperclipai/paperclip`. Forkin `origin/master` perustuu
tagia v2026.512.0 vanhempaan upstreamiin, joten yhtäkään alla olevista upstream-asetuksista
ei vielä ole forkissa.

## Periaatteet

- Tämä tiketti ei muuta ajonaikaista käytöstä. Paperclip-master deployautuu prodiin
  automaattisesti. Jokainen asetus otetaan käyttöön siinä portaassa, jossa se tulee mukaan.
- Asetus kirjataan env-muuttujana tai versioituna instanssiasetuksena, ei pelkkänä
  UI-kytkimenä. Env-muuttujat, jotka eivät ole salaisuuksia, menevät systemd-drop-iniin
  `~/.claude/hosts/paperclip/paperclip-service/systemd/paperclip.service.d/` (versioitu
  `~/.claude`-repoon, asennus `install.sh`:lla). Salaisuudet pysyvät tiedostossa
  `/etc/paperclip/paperclip-server.env` (RK9-150).
- Instanssiasetus (`instance_settings.experimental`, jsonb) ei ole gitissä. Siksi preflight
  lukee sen käynnistyksessä ja pysäyttää palvelun, jos arvo on väärä (ks. "Preflight").
- Kun upstreamin oletus on turvaton eikä sille ole asetusta, oletus pinnataan koodissa
  `// --- RK9 Custom ---` -merkinnällä ja lukitaan testillä.

## Porras v2026.512.0

Ei uusia kovennettavia oletuksia. Tarkista vain, että alla olevat forkin testit ovat vihreitä
(ne ovat listassa `doc/upgrade/fork-tests.txt`).

## Portaat v2026.609.0 ja v2026.720.0 — cloud sync

| Kohta | Arvo |
|---|---|
| Asetus | `enableCloudSync` instanssiasetuksissa (`experimental`) |
| Upstream-oletus | `false` (`packages/shared/src/validators/instance.ts:43` @ v2026.609.0) |
| RK9-arvo | Ei konfiguroida. Arvo pysyy `false`. |
| Poistuu | v2026.817.0: migraatio `0196_drop_cloud_upstream_tables.sql` pudottaa taulut `cloud_upstream_runs` ja `cloud_upstream_connections`. Asetus, reitit ja palvelu poistuvat samalla. |

Todennus portailla 609.0 ja 720.0: `GET /api/instance/settings/experimental` palauttaa
`enableCloudSync: false`, ja taulussa `cloud_upstream_connections` on 0 riviä. Harjoitusinstanssin
egress on estetty (ks. osio "Harjoitusinstanssi"), joten lokissa ei saa näkyä yhteysyritystä.
Portaalla 817.0: migraatio 0196 ajetaan, ja taulut ovat poissa (`\dt cloud_upstream_*` palauttaa
tyhjän).

## Porras v2026.720.0 — `TRUST_PROXY` tulee mukaan

`server/src/middleware/trust-proxy.ts` ja `applyTrustProxy(app, parseTrustProxyEnv(process.env.TRUST_PROXY))`
tulevat tässä tagissa. Oletus on asettamaton: Express ei luota yhteenkään proxyyn.

- Aseta `TRUST_PROXY=192.168.1.17` (nginx-edge). Älä käytä arvoa `true` äläkä hop-lukua.
  Älä lisää `loopback`-arvoa: paikalliset agentit kutsuvat suoraan `localhost:3100`:aa eivätkä
  kulje proxyn kautta.
- Vaikutus tässä portaassa: `req.ip`, `req.protocol` ja `req.hostname` alkavat lukea
  `X-Forwarded-*`-otsakkeita vain edgeltä. Board-mutation-guard ei vielä käytä asetusta (ks. 916.1).
- Todennus: kirjaudu `https://paperclip.rk9.fi`:hin ja tee yksi board-mutaatio (esim. kommentti).
  Tarkista pyyntölokista, että `req.ip` on asiakkaan osoite eikä `192.168.1.17`.

## Porras v2026.831.1

### `enableNativeRunner` tulee mukaan

| Kohta | Arvo |
|---|---|
| Asetus | `enableNativeRunner` instanssiasetuksissa (`experimental`), UI-nimi "Paperclip Runner" |
| Upstream-oletus | `false` (`packages/shared/src/feature-catalog.ts:53`, `server/src/services/instance-settings.ts:263`) |
| RK9-arvo | `false`, kirjoitettuna eksplisiittisesti instanssiasetusriville |

Kirjoita arvo riville jo tässä portaassa, vaikka oletus on sama. Syy: v2026.916.0 kääntää oletuksen
(`parsed.data.enableNativeRunner ?? true`), ja puuttuva avain tulkitaan silloin päälle.
Päätös ja perustelu: `doc/upgrade/acpx-claude-local.md` (RK9-305). `claude_local` pysyy
pinnattuna CLI-moottoriin samassa dokumentissa kuvatulla tavalla.

### Tietoturvakorjaus #11400

| Kohta | Arvo |
|---|---|
| PR | [paperclipai/paperclip#11400](https://github.com/paperclipai/paperclip/pull/11400) "fix(security): route paperclipai CLI guidance through safe npx form (CWE-78)" |
| Merge-commit | `fdb9a4880db3641079402a3c08bddc3fb71a6aa7`, ensimmäinen tagi v2026.831.0 |
| Koskee | `server/src/middleware/private-hostname-guard.ts`, `server/src/routes/access.ts`, `server/src/adapters/hermes-gateway-doc.ts` ja CLI-ohjeet dokumenteissa ja skilleissä (`pnpm paperclipai` → `npx paperclipai`) |

Mergessä: ota upstreamin `npx paperclipai`-muoto myös forkin hotspot-skilleihin
(`skills/paperclip/SKILL.md`, `skills/paperclip-dev/SKILL.md`). Älä palauta `pnpm paperclipai`
-muotoa konfliktinratkaisussa.

Forkin omat webhook-reitit (github-webhooks, resend-inbound, ses-inbound, slack-interactions,
outreach-inbound, unsubscribe) eivät tuota CLI-ohjeita, joten #11400 ei muuta niitä.
`private-hostname-guard.ts` kuitenkin muuttuu. Aja siksi portaan jälkeen reittitestit (lista
alla) ja savutesti `scripts/upgrade-smoke.sh` `paperclip.rk9.fi`-hostnimellä.

## Porras v2026.916.1

### Announcement feed

| Kohta | Arvo |
|---|---|
| Asetus | env `PAPERCLIP_ANNOUNCEMENTS_ENABLED` (config-avain `announcementsEnabled`), syöte `PAPERCLIP_ANNOUNCEMENTS_FEED_URL` |
| Upstream-oletus | päällä: `process.env.PAPERCLIP_ANNOUNCEMENTS_ENABLED !== "false"` (`server/src/config.ts:369`). Syöte `https://pages.paperclip.ing/announcements/v1/current.json`. |
| RK9-arvo | `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` (opt-out) |
| Sijainti | systemd-drop-in `paperclip.service.d/` (`Environment=`), ei salaisuus |

Arvon on oltava täsmälleen `false`. Mikä tahansa muu arvo (myös `0` tai `no`) jättää syötteen päälle.
Todennus harjoitusinstanssissa: injektoi fetch-mock (tai verkkokaappaus) ja tarkista, että
`pages.paperclip.ing`-osoitteeseen ei lähde yhtään pyyntöä käynnistyksessä eikä
`/api/announcements`-kutsussa. Lisää samalla forkin testi, joka asettaa envin arvoon `false` ja
toteaa, ettei `announcement-feed.ts` kutsu fetchiä.

### Standard-trust-agenttien hire-oikeus

| Kohta | Arvo |
|---|---|
| Muutos | `defaultAgentPermissions` antaa `canCreateAgents: true` jokaiselle hire/create-polulla luodulle standard-trust-agentille (`server/src/services/agent-permissions.ts:46` @ v2026.916.1). Ennen tätä oletus oli `role === "ceo"`. |
| Upstream-oletus | päällä standard-trust-agenteille, pois low-trust-agenteille |
| RK9-arvo | Hire-oikeus on vain boardilla, CEO:lla ja eksplisiittisellä `canCreateAgents`- tai `agents:create`-grantilla. Hyväksyntäportti `requireBoardApprovalForNewAgents` (companies-taulu, 0071) pysyy yrityskohtaisena. |
| Sijainti | koodi: `// --- RK9 Custom ---` -pinnaus `agent-permissions.ts`:ään. Ei env-muuttujaa, koska upstream ei tarjoa asetusta. |

Mergessä: pidä `defaultAgentPermissions` fail-closed forkin linjalla (vain CEO saa oletuksena
`canCreateAgents: true`). Vaihtoehto on asettaa `requireBoardApprovalForNewAgents=true` kaikille
yrityksille, mutta se on datamuutos ja vaatii operaattorin päätöksen. Nykytila 2026-09-26:
RK9-yrityksellä `requireBoardApprovalForNewAgents=false` (todennettu API:sta). Muiden
yritysten arvot ovat todentamatta; tarkista ne ennen porrasta kyselyllä
`select issue_prefix, require_board_approval_for_new_agents from companies`.

Lukitsevat testit (`server/src/__tests__/hire-approval-policy.test.ts`):

- Standard-trust-agentin `POST /companies/:id/agent-hires` ja `POST /companies/:id/agents` palauttavat 403.
- CEO:n hire menee tilaan `pending_approval` ja luo `hire_agent`-hyväksynnän, kun yritys vaatii hyväksynnän.
- Eksplisiittinen `agents:create`-grantti ei ohita hyväksyntäporttia.
- Agentti ei voi hyväksyä odottavaa hirea (`POST /agents/:id/approve` → 403).
- `defaultPermissionsForRole` antaa `canCreateAgents`-oikeuden oletuksena vain CEO:lle. Tämä
  testi on laukaisin: se hajoaa 916.1-portaassa, koska upstream muuttaa funktion. Älä poista
  testiä, vaan siirrä sama väite upstreamin uuteen `defaultAgentPermissions`-rajapintaan.

### Proxy trust ja `X-Forwarded-Host`

| Kohta | Arvo |
|---|---|
| Muutos | `board-mutation-guard.ts` lukee `X-Forwarded-Host`-otsakkeen vain, kun välitön vertaisosoite läpäisee Expressin `trust proxy fn`:n. Muuten guard käyttää `Host`-otsaketta. |
| Upstream-oletus | `TRUST_PROXY` asettamatta, joten `X-Forwarded-Host` ohitetaan kaikilta |
| RK9-arvo | `TRUST_PROXY=192.168.1.17` (asetettu jo portaassa 720.0), `PAPERCLIP_ALLOWED_HOSTNAMES` sisältää `paperclip.rk9.fi`:n, `PAPERCLIP_PUBLIC_URL=https://paperclip.rk9.fi` |
| Sijainti | `TRUST_PROXY` ja `PAPERCLIP_PUBLIC_URL`: systemd-drop-in. `PAPERCLIP_ALLOWED_HOSTNAMES` on nyt tiedostossa `/etc/paperclip/paperclip-server.env`. |

Nykytila 2026-09-26:

- Forkin `board-mutation-guard.ts` luottaa `X-Forwarded-Host`-otsakkeeseen lähdeosoitteesta
  riippumatta.
- Palvelin kuuntelee osoitteessa `0.0.0.0:3100` (`ss -ltnp`). Edge ei siis ole ainoa reitti palvelimelle.
- Riski on pieni, koska selain ei voi asettaa `X-Forwarded-Host`-otsaketta CSRF-hyökkäyksessä.
  Upstreamin korjaus sulkee reiän 916.1-portaassa, joten tässä tiketissä ajonaikaista muutosta ei tehdä.
- `PAPERCLIP_ALLOWED_HOSTNAMES` sisältää nyt vain osoitteen `100.120.245.107`.
  `PAPERCLIP_PUBLIC_URL`:ia ei löytynyt systemd-yksiköstä eikä env-tiedostoista (todentamatta,
  voi olla instanssin `config.json`:ssa). Tarkista molemmat ennen tätä porrasta.

Mergessä: ota upstreamin `board-mutation-guard.ts` ja sen testi sellaisenaan. Lisää forkin testiin
kaksi tapausta upstreamin `app.set("trust proxy", ...)`-mallilla:

1. Pyyntö vertaisosoitteesta `192.168.1.17`, `X-Forwarded-Host: paperclip.rk9.fi` ja
   `Origin: https://paperclip.rk9.fi` → sallitaan.
2. Sama pyyntö mistä tahansa muusta osoitteesta (esim. `10.90.10.20`) → 403.

Todennus harjoitusinstanssissa: kirjautuminen ja yksi board-mutaatio `paperclip.rk9.fi`:n kautta
onnistuvat. Suora `curl` portin 3100 kautta väärennetyllä `X-Forwarded-Host`-otsakkeella ja
samalla `Origin`illa saa vastauksen 403.

`CLAUDE_LOGIN_TRUSTED_PROXIES` ja `CLAUDE_LOGIN_EDGE_TLS_TERMINATED` (setup-token-kirjautuminen,
SR-7, `server/src/app.ts:654` @ v2026.916.1) jätetään asettamatta. Jos setup-token-kirjautumista
tarvitaan edgen kautta, arvo on `CLAUDE_LOGIN_TRUSTED_PROXIES=192.168.1.17`.

### `enableNativeRunner`-oletus kääntyy

Oletus muuttuu arvoon `true` (`server/src/services/instance-settings.ts:227,270` @ v2026.916.1).
Varmista ennen deployta, että instanssiasetusrivillä on `experimental.enableNativeRunner = false`
(kirjoitettu portaassa 831.1).

### Tietoturvakorjaus #12776

| Kohta | Arvo |
|---|---|
| PR | [paperclipai/paperclip#12776](https://github.com/paperclipai/paperclip/pull/12776) "fix(security): harden privileged server boundaries" |
| Merge-commit | `9dd6526b47f3ca3a228e5eb7378de055e1622d8a`, ensimmäinen tagi v2026.916.0 |
| Koskee | uusi `server/src/adapters/http/remote-fetch.ts` (SSRF, DNS-pinnaus), `server/src/middleware/redact-sensitive.ts`, reitit `agents`, `assets`, `companies`, `projects`, `secrets`, `workspace-command-authz`, palvelut `agent-instructions`, `company-portability`, `feedback`, `plugin-managed-agents` |

Mergessä: `server/src/routes/agents.ts` on hotspot (5 konfliktilohkoa). Pidä upstreamin
tarkistukset ja forkin `external-runs`- ja `human_proxy`-lisäykset molemmat. Aja
`hire-approval-policy.test.ts` ja `agent-permissions-routes.test.ts` heti ratkaisun jälkeen.

Forkin reittien tarkistus #12776:ta vasten:

| Reitti | Allekirjoitus | Forkin testi (väärennys → hylätään, oikea → läpi) | Huomio 916.1-portaaseen |
|---|---|---|---|
| `github-webhooks.ts` | HMAC `GITHUB_WEBHOOK_SECRET` | `github-webhook-routes.test.ts` | Ei ulkoista fetchiä |
| `resend-inbound.ts` | Svix, yrityskohtainen salaisuus | `resend-inbound-route.test.ts` (uusi), `email-svix-verify.test.ts` | Tarkistus lukee raakatavut: globaali body parser tämän reitin edellä rikkoo sen |
| `ses-inbound.ts` | SNS-allekirjoitus, sertifikaatti vain `sns.*.amazonaws.com` | `email-ses-inbound-route.test.ts` | `SubscribeURL` haetaan vasta allekirjoituksen jälkeen. Harkitse sen reitittämistä `remote-fetch.ts`:n kautta. |
| `slack-interactions.ts` | Slack v0 -allekirjoitus, 5 min ikkuna | `slack-signature-verify.test.ts`, `slack-interactions.test.ts` | Ei muutosta |
| `outreach-inbound.ts` | HMAC `OUTREACH_INBOUND_HMAC_SECRET`, 5 min ikkuna | `outreach-inbound-verify.test.ts`, `outreach-inbound-route.test.ts` | Ei muutosta |
| `unsubscribe.ts` | tokeni, ei oraakkelia | `outreach-unsubscribe-route.test.ts` | Julkinen GET, ei saa jäädä board-guardin tai hostname-guardin taakse |

`redact-sensitive.ts` muuttuu. Tarkista, ettei se peitä webhook-reittien raakarunkoa ennen
allekirjoituksen tarkistusta.

## Preflight — tarkistuslista RK9-307:lle

Tämä tiketti ei muokkaa preflightia. Kanoninen lähde on
`~/.claude/hosts/paperclip/paperclip-service/paperclip-preflight.sh`, ja muutokset omistaa
[RK9-307](/RK9/issues/RK9-307). Lisää preflightiin seuraavat tarkistukset siinä portaassa, jossa
asetus tulee mukaan:

| Porras | Tarkistus | Tulos, jos arvo on väärä |
|---|---|---|
| 720.0 | `TRUST_PROXY` on täsmälleen `192.168.1.17`. Arvo ei saa olla `true`, hop-luku eikä sisältää `loopback`-arvoa. | virhe (palvelu ei käynnisty) |
| 720.0 | `PAPERCLIP_ALLOWED_HOSTNAMES` sisältää `paperclip.rk9.fi`:n, ja `PAPERCLIP_PUBLIC_URL` on `https://paperclip.rk9.fi` | virhe |
| 831.1 | `instance_settings.experimental ->> 'enableNativeRunner'` on `false` (avain olemassa) | varoitus 831.1:ssä, virhe 916.1:stä alkaen |
| 609.0–720.0 | `instance_settings.experimental ->> 'enableCloudSync'` ei ole `true` | virhe |
| 916.1 | `PAPERCLIP_ANNOUNCEMENTS_ENABLED` on täsmälleen `false` | virhe |
| 916.1 | `agent-permissions.ts` sisältää RK9 Custom -pinnauksen (grep-ankkuri kuten nykyinen `github-webhooks.ts`-tarkistus) | virhe |
| kaikki | `CLAUDE_LOGIN_TRUSTED_PROXIES` on tyhjä tai `192.168.1.17` | varoitus |

## Hyväksyntäehtojen tila (RK9-309)

| Ehto | Tila |
|---|---|
| RK9-oletukset-taulukko `UPSTREAM-UPGRADE.md`:ssä | Tehty tässä tiketissä |
| Nolla announcement- ja cloud sync -kutsua harjoitusinstanssissa | Siirtyy portaisiin 609.0–720.0 (cloud sync) ja 916.1 (announcements). Asetuksia ei ole nykyforkissa. |
| Testi: standard-trust-agentin hire hylätään tai menee hyväksyntään | Tehty: `hire-approval-policy.test.ts` |
| Proxy trust vain `192.168.1.17`:lle ja väärennystesti | Siirtyy portaaseen 916.1 (upstreamin guard + `TRUST_PROXY`). Testitapaukset on kuvattu yllä. |
| Webhook-reittien allekirjoitustestit | Kattavuus todennettu reiteittäin. Puuttuva resend-inbound-reittitesti lisätty. |
| Preflight varoittaa puuttuvasta kovennuksesta | Tarkistuslista RK9-307:lle yllä |
| Asetukset env- tai instanssiasetuksina | Sijainti määritetty jokaiselle asetukselle. Hire-oikeus pinnataan koodissa, koska upstream ei tarjoa asetusta. |
