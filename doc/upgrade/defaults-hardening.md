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
  UI-kytkimenä. Env-muuttujat, jotka eivät ole salaisuuksia, lisätään `export`-riveinä
  käynnistysskriptiin `~/.claude/hosts/paperclip/paperclip-service/paperclip-start.sh`
  (versioitu `~/.claude`-repoon, asennus `install.sh`:lla `/usr/local/bin/`-hakemistoon).
  Skripti asettaa jo `PAPERCLIP_ALLOWED_HOSTNAMES`:n ja `PAPERCLIP_PUBLIC_URL`:n, ja sen `export`
  voittaa systemd:n `EnvironmentFile`- ja drop-in-arvot. Salaisuudet pysyvät tiedostossa
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

Proxyketju paperclip-01:llä (todennettu 2026-09-26, `/etc/nginx/sites-enabled/paperclip`):

1. Edge-nginx `192.168.1.17` terminoi TLS:n ja välittää pyynnön paperclip-01:n porttiin 80.
2. Paikallinen nginx (portti 80, `server_name _`) luottaa vain edgeen: `set_real_ip_from 192.168.1.17`
   ja `set_real_ip_from 127.0.0.1`. Se kirjoittaa `X-Forwarded-Host $host` -otsakkeen aina yli
   ja lisää asiakkaan osoitteen `X-Forwarded-For`-ketjuun.
3. Paikallinen nginx välittää pyynnön osoitteeseen `127.0.0.1:3100`. Express näkee siis vertaisena
   aina `127.0.0.1`:n, ei edgen osoitetta.

Operaattorin päätös "luotetaan vain edgeen 192.168.1.17" toteutuu siksi kahdessa kerroksessa:
paikallinen nginx luottaa edgeen, ja Express luottaa vain paikalliseen nginxiin.

- Aseta `TRUST_PROXY=loopback`. Arvo `192.168.1.17` ei toimi, koska edge ei ole Expressin
  välitön vertainen. Älä käytä arvoa `true` äläkä hop-lukua.
- Suorat LAN-pyynnöt porttiin 3100 (`0.0.0.0:3100`) tulevat muusta kuin loopback-osoitteesta.
  Express ei luota niiden `X-Forwarded-*`-otsakkeisiin.
- Paikalliset prosessit (agentit samalla koneella) tulevat loopbackista. Ne voivat asettaa
  `X-Forwarded-*`-otsakkeet itse. Tämä hyväksytään: niillä ei ole board-istuntoa, ja ne ajavat
  jo samalla koneella.
- Vaikutus tässä portaassa: `req.ip`, `req.protocol` ja `req.hostname` alkavat lukea
  `X-Forwarded-*`-otsakkeita paikalliselta nginxiltä. Board-mutation-guard ei vielä käytä asetusta
  (ks. 916.1).
- Todennus: kirjaudu `https://paperclip.rk9.fi`:hin ja tee yksi board-mutaatio (esim. kommentti).
  Tarkista pyyntölokista, että `req.ip` on asiakkaan osoite eikä `127.0.0.1` tai `192.168.1.17`.
- Paikallinen nginx kuuntelee porttia 80 kaikissa liitännöissä. LAN-asiakas voi siis ohittaa edgen.
  `set_real_ip_from` estää sitä väärentämästä osoitettaan, mutta `Host`-otsakkeen se voi asettaa
  vapaasti. Porttien 80 ja 3100 rajaaminen (esim. `allow 192.168.1.17; deny all;` tai bindaus
  127.0.0.1:een) on operaattorin päätös. Tailscale-kuuntelija `100.120.245.107:443` ei koske
  Paperclipia: `tailscale serve status` näyttää vain polut `/qmd`, `/vault` ja `/vault-personal`.
- Paikallinen nginx välittää asiakkaan oman `X-Forwarded-Proto`-otsakkeen sellaisenaan
  (`$http_x_forwarded_proto`). Kun `loopback` on luotettu, LAN-asiakas voi porttiin 80 tullessaan
  asettaa `req.protocol`- ja `req.secure`-arvot. Upstream käyttää niitä ainakin tiedostoissa
  `server/src/routes/access.ts`, `smoke-lab.ts` ja `tool-access.ts`. Portin 80 rajaaminen edgeen
  sulkee tämänkin reitin.

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
| Merge-commit | `fdb9a4880db3641079402a3c08bddc3fb71a6aa7`, ensimmäinen tagi v2026.824.0. Porrastus ohittaa 824:n, joten korjaus tulee portaassa 831.1. |
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
| Upstream-oletus | päällä: `process.env.PAPERCLIP_ANNOUNCEMENTS_ENABLED !== "false"` (`server/src/config.ts:369` @ v2026.916.0 ja 916.1). Syöte `https://pages.paperclip.ing/announcements/v1/current.json`. |
| RK9-arvo | `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` (opt-out) |
| Sijainti | `export` käynnistysskriptissä `paperclip-start.sh`, ei salaisuus |

Arvon on oltava täsmälleen `false`. Mikä tahansa muu arvo (myös `0` tai `no`) jättää syötteen päälle.
Todennus harjoitusinstanssissa: injektoi fetch-mock (tai verkkokaappaus) ja tarkista, että
`pages.paperclip.ing`-osoitteeseen ei lähde yhtään pyyntöä käynnistyksessä eikä
`/api/announcements`-kutsussa. Lisää samalla forkin testi, joka asettaa envin arvoon `false` ja
toteaa, ettei `announcement-feed.ts` kutsu fetchiä.

### Standard-trust-agenttien hire-oikeus

| Kohta | Arvo |
|---|---|
| Muutos | `defaultAgentPermissions` antaa `canCreateAgents: true` jokaiselle hire/create-polulla luodulle standard-trust-agentille (`server/src/services/agent-permissions.ts:46` @ v2026.916.0 ja 916.1). Ennen tätä oletus oli `role === "ceo"`. |
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
- `defaultPermissionsForRole` ja `normalizeAgentPermissions` antavat `canCreateAgents`-oikeuden
  oletuksena vain CEO:lle. Tämä testi on laukaisin: se hajoaa 916.1-portaassa, koska upstream
  nimeää funktion uudelleen ja muuttaa oletuksen. Älä poista testiä, vaan siirrä sama väite
  upstreamin `defaultAgentPermissions({ context: "create" })`-kutsuun.

Rajaus: reittitestien standard-trust-agentilla on eksplisiittinen `canCreateAgents: false`, ja
agenttipalvelu on mockattu. Reittitestit eivät siis huomaa, jos upstream tallentaa uudelle
agentille eri oikeudet. Oletuksen muutoksen huomaa vain yllä oleva laukaisintesti. Lisää
916.1-portaassa reittitesti, joka tarkistaa `svc.create`-kutsun `permissions`-kentän.

### Proxy trust ja `X-Forwarded-Host`

| Kohta | Arvo |
|---|---|
| Muutos | v2026.916.0:sta alkaen `board-mutation-guard.ts` lukee `X-Forwarded-Host`-otsakkeen vain, kun välitön vertaisosoite läpäisee Expressin `trust proxy fn`:n. Muuten guard käyttää `Host`-otsaketta. |
| Upstream-oletus | `TRUST_PROXY` asettamatta, joten `X-Forwarded-Host` ohitetaan kaikilta |
| RK9-arvo | `TRUST_PROXY=loopback` (asetettu jo portaassa 720.0, ks. proxyketju), `PAPERCLIP_ALLOWED_HOSTNAMES` sisältää `paperclip.rk9.fi`:n, `PAPERCLIP_PUBLIC_URL=https://paperclip.rk9.fi` |
| Sijainti | kaikki kolme `export`-riveinä käynnistysskriptissä `paperclip-start.sh` |

Nykytila 2026-09-26:

- Forkin `board-mutation-guard.ts` luottaa `X-Forwarded-Host`-otsakkeeseen lähdeosoitteesta
  riippumatta.
- Palvelin kuuntelee osoitteessa `0.0.0.0:3100`, ja paikallinen nginx porttia 80 kaikissa
  liitännöissä (`ss -ltnp`). Edge ei siis ole ainoa reitti palvelimelle.
- Paikallinen nginx kirjoittaa `X-Forwarded-Host`-otsakkeen aina yli (`$host`). Edgen kautta
  tulevassa pyynnössä otsake on siis sama kuin `Host`.
- Riski on pieni, koska selain ei voi asettaa `X-Forwarded-Host`-otsaketta CSRF-hyökkäyksessä.
  Upstreamin korjaus sulkee reiän 916.1-portaassa, joten tässä tiketissä ajonaikaista muutosta ei tehdä.
- `paperclip-start.sh` asettaa `PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.rk9.fi,paperclip-01.rk9.fi,paperclip,192.168.1.54,100.81.228.64`
  ja `PAPERCLIP_PUBLIC_URL=https://paperclip.rk9.fi`. Nämä arvot ovat voimassa ajossa.
- Tiedostossa `/etc/paperclip/paperclip-server.env` on lisäksi rivi
  `PAPERCLIP_ALLOWED_HOSTNAMES=100.120.245.107`. Se ei vaikuta, koska käynnistysskriptin `export`
  kirjoittaa sen yli. Poista rivi, jotta arvo on yhdessä paikassa.
- Osoite `100.81.228.64` ei ole koneen nykyinen Tailscale-osoite (`tailscale ip -4` palauttaa
  `100.120.245.107`). Se on todennäköisesti vanhentunut. Poista se, jos sitä ei tarvita.

Mergessä: ota upstreamin `board-mutation-guard.ts` ja sen testi sellaisenaan. Lisää forkin testiin
kolme tapausta upstreamin `app.set("trust proxy", ...)`-mallilla:

Guard luottaa aina `PAPERCLIP_PUBLIC_URL`-originiin (`trustedOriginsForRequest`, sekä forkissa
että upstreamissa). Siksi `Origin: https://paperclip.rk9.fi` menee läpi `X-Forwarded-Host`-otsakkeesta
riippumatta, eikä sillä voi testata proxy trustia. Jätä `PAPERCLIP_PUBLIC_URL` asettamatta testissä
ja käytä väärennykseen hyökkääjän originia:

1. `trust proxy` = `loopback`, vertaisosoite `127.0.0.1`, `Host: 127.0.0.1:3100`,
   `X-Forwarded-Host: paperclip.rk9.fi` ja `Origin: https://paperclip.rk9.fi` → sallitaan
   (luotettu vertainen saa nostaa `X-Forwarded-Host`-arvon).
2. `trust proxy` = `loopback`, vertaisosoite `10.90.10.20`, `Host: 127.0.0.1:3100`,
   `X-Forwarded-Host: evil.example` ja `Origin: https://evil.example` → 403 (epäluotettavan vertaisen
   `X-Forwarded-Host` ohitetaan). Supertest yhdistää aina loopbackista, joten tee tämä tapaus
   mock-pyynnöllä, jossa on `socket.remoteAddress` ja `app.get("trust proxy fn")`.
3. Sama kuin tapaus 2, mutta ilman `trust proxy` -asetusta ja vertaisena `127.0.0.1` → 403.
   Upstreamin testi "ignores x-forwarded-host from an untrusted direct client" kattaa tämän jo.

Todennus harjoitusinstanssissa: kirjautuminen ja yksi board-mutaatio `paperclip.rk9.fi`:n kautta
onnistuvat. Tee sitten suora board-mutaatio (esim. kommentti) `curl`illa toiselta koneelta
osoitteeseen `http://192.168.1.54:3100` voimassa olevalla istuntoevästeellä. Käytä hostnimeä, joka
on `PAPERCLIP_ALLOWED_HOSTNAMES`-listalla mutta eri kuin `Host`:
`X-Forwarded-Host: paperclip-01.rk9.fi` ja `Origin: https://paperclip-01.rk9.fi`.

- Korjattu guard: 403 ja virhe "Board mutation requires trusted browser origin".
- Vanha guard (nykyfork): mutaatio menee läpi.
- Älä käytä vierasta nimeä kuten `evil.example`. `private-hostname-guard.ts` lukee
  `X-Forwarded-Host`-otsakkeen ilman proxy trustia (myös v2026.916.1:ssä) ja palauttaa 403
  "This hostname is not allowed for this Paperclip instance" ennen board-guardia. Tällainen 403
  ei todista board-guardista mitään.
- Ilman evästettä pyyntö kaatuu jo autentikointiin, eikä tulos todista mitään.

Jäännösriski: `private-hostname-guard.ts` luottaa `X-Forwarded-Host`-otsakkeeseen lähteestä
riippumatta myös 916.1:ssä. Suora asiakas voi siis ohittaa hostname-tarkistuksen sallitulla
nimellä. Selain ei voi asettaa otsaketta, joten DNS-rebinding-suoja pysyy. Korjaus kuuluu
upstreamiin tai erilliseen forkin tikettiin, ei tähän.

`CLAUDE_LOGIN_TRUSTED_PROXIES` ja `CLAUDE_LOGIN_EDGE_TLS_TERMINATED` (setup-token-kirjautuminen,
SR-7, `server/src/app.ts:654` @ v2026.916.1) jätetään asettamatta. Tarkistus vertaa välittömään
vertaiseen, joka on `127.0.0.1`. Arvo `192.168.1.17` ei siksi koskaan täsmää. Jos
setup-token-kirjautumista tarvitaan edgen kautta, se vaatii operaattorin päätöksen: edgen ja
paperclip-01:n välinen yhteys on salaamaton HTTP, joten SR-7:n luottamuksellisuusvaatimus ei
täyty pelkällä `127.0.0.1`-allowlistilla.

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
| `resend-inbound.ts` | Svix, yrityskohtainen salaisuus | `resend-inbound-route.test.ts` (uusi, reititin yksinään), `email-svix-verify.test.ts` | Tarkistus lukee raakatavut: globaali body parser tämän reitin edellä rikkoo sen. Uusi testi ei kata `app.ts`:n mount-järjestystä, joten aja lisäksi savutestin Resend-tarkistus. |
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
| 720.0 | `TRUST_PROXY` on täsmälleen `loopback` (luetaan `paperclip-start.sh`:n `export`-riviltä, ks. seuraava rivi). Arvo ei saa olla `true` eikä hop-luku. | virhe (palvelu ei käynnisty) |
| 720.0 | Paikallisen nginxin `set_real_ip_from` sisältää vain osoitteet `192.168.1.17` ja `127.0.0.1`, ja `location /` asettaa `X-Forwarded-Host $host` | varoitus |
| 720.0 | Käynnistysskriptin `paperclip-start.sh` tehokkaat arvot: `PAPERCLIP_ALLOWED_HOSTNAMES` sisältää `paperclip.rk9.fi`:n, ja `PAPERCLIP_PUBLIC_URL` on `https://paperclip.rk9.fi`. Preflight ajetaan `ExecStartPre`nä eikä näe skriptin exportteja. Se jäsentää skriptin `export`-rivit (esim. `grep '^export NIMI='`), ei lue systemd:n ympäristöä. Älä aja skriptiä preflightista: se päättyy `exec pnpm dev:once` -kutsuun ja käynnistäisi palvelimen. | virhe |
| 831.1 | `instance_settings.experimental ->> 'enableNativeRunner'` on `false` (avain olemassa) | varoitus 831.1:ssä, virhe 916.1:stä alkaen |
| 609.0–720.0 | `instance_settings.experimental ->> 'enableCloudSync'` ei ole `true` | virhe |
| 916.1 | `PAPERCLIP_ANNOUNCEMENTS_ENABLED` on täsmälleen `false` (käynnistysskriptin tehokas arvo) | virhe |
| 916.1 | `agent-permissions.ts` sisältää RK9 Custom -pinnauksen (grep-ankkuri kuten nykyinen `github-webhooks.ts`-tarkistus) | virhe |
| 916.1 | `CLAUDE_LOGIN_TRUSTED_PROXIES` ja `CLAUDE_LOGIN_EDGE_TLS_TERMINATED` ovat tyhjiä, ellei operaattori ole päättänyt toisin | varoitus |

## Hyväksyntäehtojen tila (RK9-309)

| Ehto | Tila |
|---|---|
| RK9-oletukset-taulukko `UPSTREAM-UPGRADE.md`:ssä | Tehty tässä tiketissä |
| Nolla announcement- ja cloud sync -kutsua harjoitusinstanssissa | Siirtyy portaisiin 609.0–720.0 (cloud sync) ja 916.1 (announcements). Asetuksia ei ole nykyforkissa. |
| Testi: standard-trust-agentin hire hylätään tai menee hyväksyntään | Tehty: `hire-approval-policy.test.ts` |
| Proxy trust vain `192.168.1.17`:lle ja väärennystesti | Siirtyy portaisiin 720.0 (`TRUST_PROXY=loopback`) ja 916.1 (upstreamin guard). Edge-luottamus on paikallisessa nginxissä, koska Express näkee vertaisena `127.0.0.1`:n. Testitapaukset on kuvattu yllä. |
| Webhook-reittien allekirjoitustestit | Kattavuus todennettu reiteittäin. Puuttuva resend-inbound-reittitesti lisätty. |
| Preflight varoittaa puuttuvasta kovennuksesta | Tarkistuslista RK9-307:lle yllä |
| Asetukset env- tai instanssiasetuksina | Sijainti määritetty jokaiselle asetukselle. Hire-oikeus pinnataan koodissa, koska upstream ei tarjoa asetusta. |
