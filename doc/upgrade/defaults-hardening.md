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

Todennettu portaalla 817.0 (RK9-315, harjoitus prod-kopiolla): `0196` pudotti taulut, joissa oli 0 riviä.
Upstream poisti cloud syncin koodin, joten asetusta ei ole enää. Jäljelle jäävät cloud-polut (`routes/cloud.ts`,
`cloud-instance.ts`) aktivoituvat vain, kun `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` tai `PAPERCLIP_MANAGED_CONFIG`
on asetettu. Kumpaakaan ei ole prodin env-tiedostoissa (`/etc/paperclip/*.env`, tarkistettu avainten nimistä).

## Porras v2026.609.0 — oikeusmalli (`access.decide`)

Todennettu 2026-09-27 ([RK9-313](/RK9/issues/RK9-313)). Upstream siirsi agenttien ja board-käyttäjien
oikeustarkistukset palveluun `server/src/services/authorization.ts` (`access.decide`). Vertailukohta on
v2026.512.0 ja forkin master `69ae3ff5`, joissa tarkistukset olivat reiteissä.

| Oikeus | 512 / fork-master | 609 upstream | Päätös |
|---|---|---|---|
| `agents:create` (hire) | grantti, CEO tai `canCreateAgents` | sama; rooli nyt trimmataan ja pienennetään | Pidetään. Lukitsee `hire-authorization-rk9.test.ts` (oikea `authorizationService`). |
| `require_board_approval_for_new_agents` | forkin 0071: yrityskohtainen, oletus `false` | ei muutosta oletukseen | Pidetään. Forkin hyväksyntäportti ja `hire-approval-policy.test.ts` ennallaan. |
| `tasks:assign`, agentti | eksplisiittinen `tasks:assign`-grantti tai CEO/`canCreateAgents` | **jokainen aktiivinen saman yrityksen agentti** (`allow_simple_company_member`) | **Kovennettu.** RK9 Custom -lohko `authorization.ts`:ssä palauttaa 512:n säännön. Restricted- ja private-kohteet toimivat upstreamin tapaan (vain grantti). Lukitsevat `authorization-service.test.ts` ja `permissions-upgrade-boundary-routes.test.ts`. |
| `tasks:assign`, board-käyttäjä | `canUser(tasks:assign)` | aktiivinen jäsen (ei viewer); 0088 antaa member-käyttäjille operator-roolin ja `tasks:assign`-grantin | Pidetään. Käytännössä sama kuin ennen: jäsen sai grantin jo aiemmin. |
| `runtime:manage`, agentti | reittikohtainen `workspace-runtime-service-authz` | saman yrityksen agentti sallitaan | Pidetään. Uusi tarkistus on lisäportti vanhan reittitarkistuksen edessä, ei korvaa sitä. |
| `secrets:read`, agentti | ei vastinetta | saman yrityksen agentti sallitaan | Pidetään toistaiseksi. 609:ssä yksikään reitti ei kysy tätä oikeutta. **618 (RK9-314):** ensimmäiset kutsujat `routes/environments.ts` ja `services/secrets.ts`; lisäksi board-jäsen (ei viewer) saa `runtime:manage`n ja `secrets:read`in ilman granttia (`authorization.ts`, `allow_simple_company_member`). Aiemmin vain instance admin. Arvioidaan portaan 720 lopussa; tarkista (`git grep '"secrets:read"' server/src/routes`). |
| `agent_config:update`, oma agentti | sallittu (`assertCanUpdateAgent`, `actorAgent.id === targetAgent.id`) | sallittu (`allow_self`) | Pidetään. Ei muutosta. |
| Jäsenyydet (0087, 0088) | ei | 0088 antaa jokaiselle agentille aktiivisen jäsenyyden ilman grantteja; 0087 antaa owner/admin-käyttäjille `environments:manage`n | Pidetään. Agentit eivät saa grantteja, joten yllä oleva kovennus pätee. |

Uudet `experimental`-liput (`enableCloudSync` ym.) ovat oletuksena `false`.

Uusi egress: `claude_local` hakee mallilistan osoitteesta `https://api.anthropic.com/v1/models`, jos
palvelimen ympäristössä on `ANTHROPIC_API_KEY` (`packages/adapters/claude-local/src/server/models.ts`).
Kutsu ei laskuta, eikä avain päädy CLI:lle (RK9-228 pätee). Prodissa avainta ei ole: 2026-09-27
`/etc/paperclip/paperclip-server.env` ja palveluprosessin ympäristö eivät sisällä sitä. Pidetään näin.
Jos avain joskus lisätään, API:n mallit tulevat listan alkuun forkin Claude 5 -järjestyksen edelle.

Todennus: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/authorization-service.test.ts
src/__tests__/permissions-upgrade-boundary-routes.test.ts src/__tests__/hire-authorization-rk9.test.ts`.
Prodissa: standard-agentti ilman granttia saa 403 `Missing permission: tasks:assign`, kun se luo issuen
toiselle agentille. CEO-agentti saa 201.

## Porras v2026.720.0 — `TRUST_PROXY` tulee mukaan

`server/src/middleware/trust-proxy.ts` ja `applyTrustProxy(app, parseTrustProxyEnv(process.env.TRUST_PROXY))`
tulevat jo välitagissa `v2026.618.0`, joka on portaan 720 ensimmäinen osa (RK9-314). Supertest-todennus alla on
tiedostossa `server/src/__tests__/trust-proxy-rk9.test.ts`. Oletus on asettamaton: Express ei luota yhteenkään proxyyn.

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
- Todennus ennen mergeä: lisää portaan testiin supertest-sovellus, jossa
  `applyTrustProxy(app, parseTrustProxyEnv("loopback"))` ja reitti, joka palauttaa `req.ip`:n.
  Pyyntö otsakkeella `X-Forwarded-For: 203.0.113.7` palauttaa `203.0.113.7`. Ilman asetusta
  sama pyyntö palauttaa loopback-osoitteen (Express 5 + dual-stack: `::ffff:127.0.0.1`), joten
  testaa `not.toBe("203.0.113.7")` eikä tarkkaa arvoa. Supertest yhdistää loopbackista, joten ero
  todistaa asetuksen.
- Älä todenna pyyntölokista, vaikka upstreamin `trust-proxy.ts`:n kommentti neuvoo niin. Lokin
  `remoteAddress` on pino-http:n socket-osoite eikä `req.ip`, joten se näyttää nginxin kautta
  tulleille pyynnöille aina loopback-osoitteen asetuksesta riippumatta.
- Todennus deployn jälkeen: kirjautuminen ja yksi board-mutaatio `https://paperclip.rk9.fi`:n
  kautta onnistuvat.
- Paikallinen nginx kuuntelee porttia 80 kaikissa liitännöissä. LAN-asiakas voi siis ohittaa edgen.
  `set_real_ip_from` estää sitä väärentämästä osoitettaan, mutta `Host`-otsakkeen se voi asettaa
  vapaasti. Porttien 80 ja 3100 rajaaminen (esim. `allow 192.168.1.17; deny all;` tai bindaus
  127.0.0.1:een) on operaattorin päätös. Tailscale serve (`100.120.245.107:443`) ei välitä
  Paperclipiin: `tailscale serve status` näyttää vain polut `/qmd`, `/vault` ja `/vault-personal`.
- Porttiin 3100 tulee kuitenkin suoria asiakkaita. Verifierin haku palvelinlokista (2026-09-26,
  kenttä `remoteAddress`) löysi osoitteet `100.103.149.19` ja `100.66.76.115` (tailnet),
  `192.168.1.42` (LAN) ja `100.81.228.64`. Selvitä nämä asiakkaat ennen kuin rajaat portteja tai
  poistat hostnimiä `PAPERCLIP_ALLOWED_HOSTNAMES`-listalta, muuten ne lukitaan ulos. Suora asiakas
  ei kulje nginxin kautta, joten `TRUST_PROXY=loopback` ei luota sen `X-Forwarded-*`-otsakkeisiin.
- Paikallinen nginx välittää asiakkaan oman `X-Forwarded-Proto`-otsakkeen sellaisenaan
  (`$http_x_forwarded_proto`). Kun `loopback` on luotettu, LAN-asiakas voi porttiin 80 tullessaan
  asettaa `req.protocol`- ja `req.secure`-arvot. Upstream käyttää niitä ainakin tiedostoissa
  `server/src/routes/access.ts`, `smoke-lab.ts` ja `tool-access.ts`. Portin 80 rajaaminen edgeen
  sulkee tämänkin reitin.

## Porras v2026.707.0 — vastuukäyttäjä, ajastuksen esto ja idle-portti

### Vastuukäyttäjä (responsible user)

| Kohta | Arvo |
|---|---|
| Muutos | Jokaisella ajolla on vastuukäyttäjä. `heartbeat.ts` kieltäytyy käynnistämästä ajoa (`422 responsible_user_unresolved`), jos ketju konteksti → routine → issue → yläissue → `companies.default_responsible_user_id` → omistaja → ensimmäinen aktiivinen käyttäjäjäsen ei tuota käyttäjää. Agentin JWT kantaa ajon vastuukäyttäjän (`responsible_user_id`), ja `authorization.ts` leikkaa agentin oikeudet vastuukäyttäjän oikeuksilla. |
| Upstream-oletus | leikkaus pakotetaan. Varjotila: `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE=shadow` tai `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW=true` (`authorization.ts:438`). Välimuisti `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_CACHE_TTL_MS`, oletus 5000. |
| RK9-arvo | pakotettu (ei env-muuttujaa). |
| Prod-kopio (2026-09-27) | 0134 täytti `default_responsible_user_id`:n kaikille 11 yhtiölle; jokainen osoittaa omistajaan. Avoimia issueita, joilla vastuukäyttäjä on `NULL`: 0. Routineja: 0. |
| Löydös | 43 issuella (6 avointa: AUR-230, AUR-231, AUR-233, AUR-239, QUA-288, QUA-289) ja 75 ajolla vastuukäyttäjä on merkkijono, jota ei ole `user`-taulussa (4 eri arvoa, sähköpostiosoitteita). 26 issueta vastaa oikeaa käyttäjää sähköpostin perusteella. Koodin perusteella agentin kommentti tai muutos näihin issueihin hylätään (`RESPONSIBLE_USER_UNAVAILABLE`); harjoituksessa tätä ei ajettu (todentamatta). |
| Agenttiavaimet | 707 hylkää agentin API-avaimen (403 `RESPONSIBLE_USER_UNAVAILABLE`), jos avaimelta puuttuu vastuukäyttäjä (`middleware/auth.ts`). `0129` täyttää kentän `agent.key_created`-lokista. Prod-kopiossa 2 182 aktiivista avainta: 4 ilman vastuukäyttäjää (CTO `heartbeat-session` ja `ci-close-issue`, terminoitu Ololla Integration, E2E Smoke Tarkkailija `systemd-timer`), yhtäkään ei ole käytetty 30 päivään (viimeksi 2026-06-18). Olemattomia arvoja: 0. Uudet board-avaimet saavat luojan vastuukäyttäjäksi. Jos jokin näistä neljästä otetaan käyttöön, luo avain uudelleen. |
| Ajot | 75 ajolla on olematon vastuukäyttäjä; kaikki ovat päättyneitä (`succeeded`, `failed`, `cancelled`, `timed_out`). Olemattomat arvot ovat issueilta, jotka on luotu 2026-04-27…2026-05-28; uusia ei ole syntynyt sen jälkeen. |
| Korjaus | operaattorin päätös cutoverissa, migraatioiden jälkeen ja ennen agenttien käynnistystä: kohdista sähköposti oikeaan käyttäjä-id:hen ja muut yhtiön `default_responsible_user_id`:hen (SQL MERGE-READY-viestissä ja PR:ssä). |

`0111` antaa `skills:create`-grantin aktiivisille owner- ja admin-käyttäjille. Laajennus koskee vain board-käyttäjiä,
joilla on jo laaja oikeus. `0110` vaihtaa `documents`- ja `document_revisions`-taulujen yhtiö-FK:t muotoon
`ON DELETE CASCADE`.

### Ajastuksen esto (scheduling suppression)

| Kohta | Arvo |
|---|---|
| Asetus | `PAPERCLIP_IN_WORKTREE`, `PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS`, `PAPERCLIP_RESTORE_IN_PROGRESS` (`resolveHeartbeatSchedulingSuppression`) |
| Upstream-oletus | asettamatta: ajastus käynnissä |
| RK9-arvo | asettamatta. Prodin prosessin env ja env-tiedostot tarkistettu 2026-09-27: yhtäkään ei ole. |
| Huomio | Tosi-arvo pysäyttää timer-tickit ja jonon uudelleenkäynnistyksen. Forkin system pause toimii ennallaan ja tarkistetaan ensin. |

### Idle-timer-portti (RK9-231) ja `skipTimerWhenNoActionableWork`

| Kohta | Arvo |
|---|---|
| Upstream | `heartbeat.skipTimerWhenNoActionableWork`, oletus `false`, ei UI-kytkintä. Työksi lasketaan agentille osoitettu `todo`- tai `in_progress`-issue. |
| Fork | `heartbeat.skipWhenIdle`, oletus `true`, UI-kytkin. Työksi lasketaan myös routine-ajot ja blokatut issuet, joiden blokkerit ovat ratkenneet. Tarkistetaan ensin; ohitus kirjataan syyllä `heartbeat.idle`. |
| RK9-arvo | forkin portti päällä. Uuden agentin oletuksiin ei kirjoiteta upstreamin avainta. |

### Globaali concurrency cap

Upstream siirsi `activeRunExecutions`in moduulitasolle. Forkin cap (`maxGlobalConcurrentRunsDefault`) laskee nyt kaikkien
`heartbeatService`-instanssien ajot, myös reittien luomien. Aiemmin reitin oma instanssi näki vain omat ajonsa.

## Porras v2026.720.0 — ACP-oletus, built-in-agentit, työtilan korjaukset ja tool access

### ACP-moottori

| Kohta | Arvo |
|---|---|
| Muutos | `claude_local`, `codex_local` ja `gemini_local` saavat `engine`-kentän. Upstreamin oletus asettamattomalle kentälle on ACP. ACP käynnistää agentin koko palvelimen envillä. `acpx_local` poistui (hautakivi, ajo epäonnistuu `acpx_local_retired`). `0136` muuntaa `acpx_local`-rivit muotoon `claude_local`/`codex_local` + `engine: "acp"` ja poistaa niiden sessiot. |
| RK9-arvo, `claude_local` | asettamaton `engine` ajaa CLI:llä (RK9-305, `acp.ts`). Eksplisiittinen `engine: "acp"` epäonnistuu koodilla `claude_acp_host_key_blocked`, kun palvelimen envissä on `ANTHROPIC_API_KEY` ilman `PAPERCLIP_CLAUDE_INHERIT_ANTHROPIC_API_KEY`-opt-iniä (RK9-228, RK9-312). |
| RK9-arvo, `codex_local`, `gemini_local` | upstreamin oletus (ACP, CLI-fallback). Kumpikaan polku ei suodata `OPENAI_API_KEY`:tä, `GEMINI_API_KEY`:tä tai `ANTHROPIC_API_KEY`:tä (sama kuin 707:n CLI-polulla). Upstreamin ACP-moottori antoi lapselle myös palvelimen omat `PAPERCLIP_*`-asetukset, esimerkiksi `PAPERCLIP_AGENT_JWT_SECRET`in; fork poistaa ne kuten CLI-polku molemmilla kaistoilla: sandbox-kaistalla `runtimeEnv`istä ja paikallisella kaistalla wrapper-skriptissä ennen env-tiedoston lukemista (`acpx-engine/execute.ts`, RK9-314). |
| Prod-kopio (2026-09-27) | `acpx_local`-agentteja 0. Yhdelläkään agentilla ei ole `engine`-asetusta. `codex_local`: 2, molemmat terminoituja. `gemini_local`: 0. `0136` on prodissa no-op. |

### Built-in-agentit

| Kohta | Arvo |
|---|---|
| Muutos | `reconcileBuiltInAgentsOnStartup` luo Reflection Coachin ja Summarizerin (`claude_local`, paused, routinet pois) jokaiseen yritykseen joka käynnistyksessä ja yrityksen luonnissa. Jos yritys vaatii hyväksynnän uusille agenteille, syntyy palkkaushyväksyntä. |
| Löydös | prod-kopiossa ensimmäinen käynnistys loi 16 agenttia 8 yritykseen; 8 odotti hyväksyntää. Hylätty tai terminoitu agentti syntyy uudelleen seuraavassa käynnistyksessä, koska haku ohittaa terminoidut rivit. |
| RK9-arvo | luodaan vain, kun `enableBuiltInAgents` on päällä (oletus pois; sama lippu portittaa built-in-agenttien reitit). Fork-harjoituksessa (ref `4db8db584`): 0 uutta agenttia, 0 hyväksyntää. |
| Oletusgrantit | ajetaan silti joka käynnistyksessä ja agentin palkkauksessa: yrityksen ainoa juuri-CEO-agentti saa `agents:configure`n ja `skills:create`n. Prod-kopiossa 7 agenttia. 720:ssä `agent_config:update` vaatii `agents:configure`-grantin (707:ssä `agents:create` tai CEO-rooli), joten grantit pidetään. Fork lisää vain puuttuvat rivit: upstream aktivoisi jäädytetyn jäsenyyden ja nollaisi grantin rajauksen joka käynnistyksessä. Poistettu grantti palaa seuraavassa käynnistyksessä. Agentin oikeudet leikataan vastuukäyttäjän oikeuksilla (707). |

### Työtilan haarakorjaukset

| Kohta | Arvo |
|---|---|
| Asetukset | `enableWorkspaceBranchReconcileForward`, `enableWorkspaceDirtyQuarantineRepair` (`experimental`) |
| Upstream-oletus | molemmat `true`. 707:ssä forward-reconcile oli `false` ja quarantine-korjausta ei ollut. |
| Käytös | kun git worktree -työtila on eri haarassa kuin kirjattu haara, ajo ei enää kaadu validointiin. Puhdas työtila siirretään eteenpäin, jos kirjattu haara on esi-isä. Likainen työtila commitoidaan rescue-haaraan ja kirjattu haara palautetaan (`workspace-runtime.ts:1695`). |
| RK9-arvo | molemmat `false`, kirjoitettuna eksplisiittisesti instanssiasetusriville cutoverissa (sama malli kuin `enableNativeRunner`). Syy: tällä koneella interaktiiviset sessiot ja agentit käyttävät samoja worktreeitä, eikä automaattista haaranvaihtoa haluta ennen kuin se on katselmoitu. |
| Tarkistus | `select strategy_type, status, count(*) from execution_workspaces group by 1,2;` Jos aktiivisia `git_worktree`-rivejä ei ole, asetuksella ei ole prodissa vaikutusta (todentamatta). |

### Tool access ja oikeudet

| Kohta | Arvo |
|---|---|
| Muutos | uusi tool access -järjestelmä (MCP-gateway, tool-profiilit, audit). Uudet avaimet `tools:admin`, `tools:manage_connections`, `tools:manage_profiles`, `tools:view_audit`, `tools:manage_runtime`, `tools:use`, `agents:configure`, `inbox:manage`. |
| Migraatio | `0149` antaa viisi `tools:*`-grantia aktiivisille owner- ja admin-käyttäjille ja CEO- ja CTO-agenteille. Prod-kopiossa 14 käyttäjäjäsenyyttä ja 14 agenttia (140 riviä). |
| Käynnistys | owner- ja admin-roolin oletusoikeudet kirjoitetaan grant-riveiksi. Prod-kopiossa 6 jäsenyyttä sai koko roolijoukon ja 20 jäsenyyttä uuden `agents:configure`n. Lähde: `company-member-roles.ts` `grantsForHumanRole` (todentamatta, mikä käynnistysvaihe kirjoittaa rivit). |
| Env | valinnaiset: `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` (fallback `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST`), `PAPERCLIP_MCP_GATEWAY_*_LIMIT`/`*_WINDOW_MS`, `PAPERCLIP_TOOL_OAUTH_CLIENT_ID`/`_SECRET`, `RUN_LOG_S3_*`, `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED`. RK9-arvo: asettamatta. |

### Migraatiot

46 migraatiota (0136–0181) prod-kopiolla 1,41 s. Pisin AccessExclusiveLock 0,24 s (`activity_log`,
`0177`:n indeksit). `0141` ja `0142` rakentavat indeksit `heartbeat_runs`- ja `issues`-tauluihin ilman
CONCURRENTLY-optiota; prodin koolla (heartbeat_runs 19 280, activity_log 71 633 riviä) tämä on alle sekunnin.

## Porras v2026.817.0 — default-open-kirjoitukset, blocked-syy, resolver-politiikka ja managed config

### Issue-kirjoitukset vertaisten issueihin

| Kohta | Arvo |
|---|---|
| Muutos | upstream `dfcda676` (#10804): standard-trust-agentti saa kommentoida ja muuttaa näkyvää, toisen agentin omistamaa issueta (`allow_visible_issue_write`). Low-trust-agentti ja yritysrajan ylitys estetään yhä. |
| RK9-arvo | upstreamin oletus kommentille ja muutokselle. Forkin `tasks:assign`-kovennus (RK9-313, `authorization.ts`) pidettiin: agentti saa asettaa assigneen vain eksplisiittisellä grantilla tai legacy-luojana. Upstreamin low-trust-testi odottaa rajan sisäisen assignin sallituksi; fork odottaa `deny_missing_grant` (RK9 Custom -kommentti testissä). |

### Blocked-tilaan siirto vaatii syyn

| Kohta | Arvo |
|---|---|
| Muutos | `PATCH /api/issues/:id` palauttaa `422` ("Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor"), kun issue siirretään `blocked`-tilaan ilman ratkaisematonta blockeria, odottavaa interaktiota tai hyväksyntää tai `unblockDescriptor`ia. Sääntö koskee kaikkia toimijoita, myös boardia. Agentti saa nimetä `unblockDescriptor`in omistajaksi vain itsensä. |
| Vaikutus | agentit ja operaattorin skriptit, jotka asettavat `blocked`in pelkällä kommentilla, saavat 422:n. Prodin määrä on todentamatta (tarkista `activity_log`ista status-muutokset `blocked`-tilaan ilman blockeria). |
| RK9-toimi | `skills/paperclip/SKILL.md` kertoo säännön (RK9 Custom -lohko). Operaattorin `~/.claude`-skillit ja -skriptit päivitetään erikseen. |

### Kommentin tuntematon run id ja paussattu assignee

| Kohta | Arvo |
|---|---|
| Kommentti | 817 nollaa kommentin tuntemattoman tai virheellisen `X-Paperclip-Run-Id`:n ja tallentaa kommentin. Reitti kirjoittaa kuitenkin raa'an run id:n `activity_log`iin ja execution decisioneihin (FK), jolloin board-kommentti tallentuisi ja pyyntö palauttaisi 500:n. Fork pitää RK9-76:n 422:n ennen tallennusta, myös ei-UUID-arvolle. |
| Runiton agenttikirjoitus | 817 (#10837, #10843) vaatii run id:n jokaiselta agentin issue-kommentilta ja -muutokselta, muuten 403 `cross_issue_influence_run_context_required`. Operaattorin interaktiiviset sessiot, CI:n issue-sulkeminen (`bk-ci-close-issue`) ja smoke-ajastimet kirjoittavat yrityksen human proxy -agenttina ("AI") API-avaimella ilman runia. Prodin 30 päivän runittomat agenttikirjoitukset tulivat kaikki human proxy -agenteilta. Fork päästää runittoman human proxy -agentin kirjoitukset läpi saman yrityksen issueihin (RK9 Custom, `assertCrossIssueInfluenceWithinRunCap`). Muut runittomat agentit saavat 403:n. Avoin aukko: agentti voi vaihtaa oman adapterinsa `human_proxy`ksi (`allow_self`) ja ohittaa rajan vuotaneella avaimella; masterilla ja prodissa rajaa ei ollut lainkaan. |
| Paussattu assignee | upstream (#10837) estää vain agenttia asettamasta paussattua agenttia assigneeksi. Forkin vartija estää paussatut ja terminoidut kaikilta, myös boardilta (ennallaan). Human proxy -agentit ovat aina sallittuja. |

### Resolver-politiikka (`0203_interaction_resolver_governance`)

| Kohta | Arvo |
|---|---|
| Muutos | `issue_thread_interactions` saa sarakkeet `requested_resolver_policy` ja `effective_resolver_policy` (oletus `board_only`), `companies` saa `interaction_resolver_governance`n (oletus `{}`). |
| Prod-kopio | 62 interaktiota, kaikki `board_only`/`board_only`. 11 yritystä, kaikilla `{}`. |
| Reititys | outreach- ja support-desk-reititys ei muuttunut: `email_routes` (11), issuet statuksineen, assigneineen ja execution policyineen (30 844), interaktiot (62), outreach-taulut ja agentit (120) olivat identtiset ennen ja jälkeen migraatioiden. |

### Managed config ja feature-katalogi

| Kohta | Arvo |
|---|---|
| Muutos | valinnainen `PAPERCLIP_MANAGED_CONFIG` (JSON) lukitsee instanssiasetuksia ja pluginien asennusta. Virheellinen arvo estää käynnistyksen (fail closed). Jokaisella `experimental`-lipulla on oltava rivi `INSTANCE_FEATURE_CATALOG`issa. |
| RK9-arvo | asettamatta. Forkin liput `knowledgeRecallInjectionEnabled` ja `recoveryStrictInProgressOnly` ovat katalogissa tierillä `preference`, oletus `false`. |
| Uudet liput | `enableTaskChatRedesign`, `enableBetaSkills`, `enableStatusCards`, `enableSimplifiedEnglishInteractions`, `enableOwnerInstanceAdmin`: kaikki oletuksena `false`. |
| Uusi oikeus | `audit:view_agent_actions`. Mikään rooli ei saa sitä oletuksena; instanssiadmin ja `local_implicit` ohittavat tarkistuksen. |

### Työtilan haarakorjaukset

817:n skeemaoletus on yhä `true` lipuille `enableWorkspaceBranchReconcileForward` ja
`enableWorkspaceDirtyQuarantineRepair`. Prodin tallennetut arvot (`false`, kirjoitettu 720:n cutoverissa) säilyivät
migraatioiden yli prod-kopiolla. Cutoverissa ei tarvita uutta kirjoitusta.

### Migraatiot

30 migraatiota (0182–0211) prod-kopiolla 11,2 s. Hitain `0205_narrow_shiva` 7,4 s, ja sen AccessExclusiveLock
`issue_comments`-tauluun kesti 7,35 s. Palvelin ajaa migraatiot käynnistyksessä ennen kuuntelun alkua
(`applyPendingMigrations`, ks. `cutover-runbook.md` vaihe 5), joten sovellus ei kilpaile lukosta.

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


### Mergessä todetut oletusmuutokset (RK9-316)

| Kohta | 817 | 831.1 | RK9-päätös |
|---|---|---|---|
| Agentin JWT:n oletus-TTL (`PAPERCLIP_AGENT_JWT_TTL_SECONDS`, `server/src/agent-auth-jwt.ts:51`) | 1 h | 48 h (upstream #10176) | Operaattorin päätös. 817:n käytös säilyy asettamalla `PAPERCLIP_AGENT_JWT_TTL_SECONDS=3600` `paperclip-start.sh`:hon. Token ei sidu ajon tilaan, joten pidempi TTL pidentää vuotaneen tokenin ikää. |
| Uudet `experimental`-liput `enableNativeRunner`, `enableManagedSandboxOnly`, `enableClassicTaskInterface`, `enableSandboxDuplexBridge` | – | kaikki `false` | ei muutosta; `enableNativeRunner` kirjoitetaan riville ennen 916:ta (yllä) |
| `PAPERCLIP_SETTING_DEFAULTS` | – | valinnainen overlay, ei tallennu kantaan. Virheellinen arvo tunnetulle kentälle estää käynnistyksen (fail closed). | ei asetettu prodissa |
| `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` | – | oletus 7 vrk: reaper odottaa ennen työtilan siivousta | oletus käy |
| Migraatio `0218`: interaktioiden `board_only` | – | nimetään `human_only`:ksi (prod-kopiolla 62 riviä) | ei toimenpiteitä, nimenmuutos |
| Migraatio `0229`: `companies.brand_color`, `attachment_max_bytes` | sarakkeet | poistettu | prod-kopion auditointi: `brand_color` vain RK9:llä (kosmeettinen), `attachment_max_bytes` 10 MiB kaikilla 11 yhtiöllä = deploymentin oletus. Ei siirrettävää dataa. |
| Migraatio `0230`: `account.issuer` (better-auth 1.7) | – | täytetään (`local:credential`) ja uniikki-indeksi | prod-kopiolla 0 NULLia, 0 duplikaattia |

Uusia pakollisia env-avaimia tai instanssihakemiston tiedostoja ei tullut. `config.json` on yhä valinnainen,
eikä konfigskeemassa ole `.strict()`-validointia.

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
  `100.120.245.107`). Sama osoite näkyy kuitenkin lokissa suorana asiakkaana (ks. 720.0). Älä
  poista sitä listalta ennen kuin tiedät, mikä sitä käyttää.

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
   mock-pyynnöllä, jossa on `socket.remoteAddress` ja `app.get("trust proxy fn")`. Tarkista
   testissä, että `trust proxy fn` todella kutsuttiin. Ilman `app`-kenttää guard palaa
   `Host`-otsakkeeseen, ja tapaus menee läpi väärästä syystä.
3. Sama kuin tapaus 2, mutta ilman `trust proxy` -asetusta ja vertaisena `127.0.0.1` → 403.
   Upstreamin testi "ignores x-forwarded-host from an untrusted direct client" kattaa tämän jo.

Todennus ennen mergeä: yllä olevat kolme testitapausta ovat portti. Harjoitusinstanssi ei sovi
manuaaliseen väärennystarkistukseen. Se on eristetty (egress vain loopback), joten `curl` tulee
sinne loopbackista, ja `TRUST_PROXY=loopback` luottaa siihen tarkoituksella.

Todennus deployn jälkeen tuotannossa:

1. Kirjaudu `https://paperclip.rk9.fi`:hin ja tee yksi board-mutaatio. Sen pitää onnistua.
2. Luo kertakäyttöinen issue ilman assigneeta ja ilman execution policyä. Kirjoita kommenttiin
   ei yhtään `@`-mainintaa. Silloin kommentti ei herätä yhtään agenttia.
3. Lähetä sille kommentti `curl`illa toiselta LAN-koneelta osoitteeseen `http://192.168.1.54:3100`
   (paperclip-01:n oma `eth0`) voimassa olevalla istuntoevästeellä. Eväste kulkee salaamattomana,
   joten käytä luotettua konetta. Käytä hostnimeä, joka on
   `PAPERCLIP_ALLOWED_HOSTNAMES`-listalla mutta eri kuin `Host`:
   `X-Forwarded-Host: paperclip-01.rk9.fi` ja `Origin: https://paperclip-01.rk9.fi`.
4. Odotettu tulos on 403 ja virhe "Board mutation requires trusted browser origin".
5. Peruuta kertakäyttöinen issue tuloksesta riippumatta.

Jos kommentti syntyy, guard ei toimi. Korjaa eteenpäin, älä palauta porrasta: aiemmat portaat ja
nykyfork luottavat `X-Forwarded-Host`-otsakkeeseen joka tapauksessa, ja porrasrollback
(`pg_restore --clean`) hävittäisi deployn jälkeen kirjoitetun datan. Todennäköiset syyt ovat
`TRUST_PROXY`-arvo `paperclip-start.sh`:ssa tai guard, jota ei otettu upstreamista sellaisenaan.
Avaa korjaustiketti.

Huomiot:

- Ennen 916.1:tä (nykyfork) sama pyyntö menee läpi. Älä siis aja tarkistusta ennen deployta.
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

### Mergen tila (RK9-317)

| Kohta | Tila |
|---|---|
| Announcement feed | Koodin oletus on upstreamin (päällä). Forkin testi `announcements-opt-out-rk9.test.ts` lukitsee ketjun env → config → syöte: vain arvo `false` sulkee syötteen, eikä suljettu syöte kutsu fetchiä. Prodissa `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false` pitää lisätä `paperclip-start.sh`:hen ennen deployta. Harjoitusinstanssi asettaa arvon jo. |
| Standard-trust-agenttien hire-oikeus | Pinnattu: `defaultAgentPermissions` antaa `create`-oletuksen vain roolille `ceo` (RK9 Custom, `agent-permissions.ts`). Laukaisintesti siirtyi upstreamin funktioon (`hire-approval-policy.test.ts`). Uusi kantatesti `hire-permission-default-rk9.test.ts` tarkistaa tallennetut oikeudet, koska reittitestit mockaavat agenttipalvelun. |
| Proxy trust | `board-mutation-guard.ts` ja sen testi ovat upstreamin sellaisenaan. Kolme tapausta yllä on testissä `board-mutation-guard-proxy-rk9.test.ts`. Tuotantotodennus deployn jälkeen tehdään yllä kuvatulla tavalla. |
| `enableNativeRunner` | Prodin `experimental`-rivillä ei ollut avainta portaan 831.1 harjoituksessa. 916.1:n oletus `true` kytkisi natiivirunnerin päälle. Kirjoita avain arvoon `false` ennen deployta (SQL alla). |
| `enableStreamlinedUi` (uusi) | Oletus `true` (`packages/shared/src/validators/instance.ts`). Board saa upstreamin uuden sivupalkin ja routines-näkymän. Forkin Risks-navikohta on kummassakin sivupalkissa. Ei tietoturvavaikutusta. Vanhan näkymän saa pitämällä avaimen arvossa `false`. |
| #12776 | Forkin reittitiedostoja ei muutettu. `redact-sensitive.ts` tekee lokille kopion eikä muuta pyynnön runkoa, joten webhookien raakatavut säilyvät. Ulkoisten ohjeiden hallinta API:n kautta vaatii nyt instanssiadminin. |
| JWT-TTL | `agent-auth-jwt.ts` ei muuttunut 831.1:stä. Drop-inin `PAPERCLIP_AGENT_JWT_TTL_SECONDS=3600` toimii kuten ennen. |

Deployta edeltävä SQL (`experimental`-avaimet, jotka puuttuvat, kirjoitetaan eksplisiittisesti):

```sql
UPDATE instance_settings
SET experimental = experimental || '{"enableNativeRunner": false}'::jsonb
WHERE NOT (experimental ? 'enableNativeRunner');
```

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
