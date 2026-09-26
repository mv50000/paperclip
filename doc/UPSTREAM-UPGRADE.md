# Upstream Upgrade — Toistettava prosessi

Tämä dokumentti kuvaa prosessin, jolla Paperclip-forkin (mv50000/paperclip) päivitetään
uuteen upstream-versioon (paperclipai/paperclip) ilman kustomointien rikkoutumista.

Forkin kyvyt, commitit ja konfliktitiedostot on lueteltu tiedostossa
[`doc/upgrade/regression-matrix.md`](upgrade/regression-matrix.md). Se on jokaisen portaan
hyväksyntäportti. Savutesti: `scripts/upgrade-smoke.sh`.

## Migraatiokonventio

Custom-migraatiot käyttävät **9000-sarjaa** (`9NNN_rk9_<feature>.sql`):

| Numero | Feature |
|--------|---------|
| 9001   | Risk Management (taulut, kategoriat, snapshotit) |
| 9002   | Resend Email (viestit, routet, rate limit, templates) |
| 9003   | Email Escalation (lisäsarakkeet) |
| 9004   | Vanhentuneiden incidenttien automaattinen ratkaisu (backfill) |
| 9005   | Email support desk (`classification`, reitin `approval_required`) |
| 9006   | Outreach: tietomalli (prospektit, sekvenssit, viestit) |
| 9007   | Outreach: rikastus (prospektin sähköposti nullable PRH-tuontia varten) |
| 9008   | Outreach: sekvenssimoottori (lähetyskirjanpito, unsubscribe) |
| 9009   | Outreach: metriikat ja auto-pause (`outreach_sender_pauses`) |
| 9010   | Outreach: CS-desk-sähköpostireitti jokaiselle lähettäjälle (RK9-234) |

Seuraava vapaa numero: **9011** (tarkistettu 2026-09-26: `packages/db/src/migrations/`
ei sisällä 9011+-tiedostoja).

Upstream käyttää 0000-sarjaa. Numerot eivät törmää (~17 vuoden marginaali).
Journalissa (`meta/_journal.json`) upstreamin 0xxx-rivit ovat aina ensin ja 9001–9010
niiden jälkeen numerojärjestyksessä. `scripts/upgrade-smoke.sh --offline` tarkistaa tämän.

## Hotspot-tiedostot

Nämä tiedostot muuttuvat sekä upstreamissa että meillä. Custom-osiot on merkitty
`// --- RK9 Custom ---` -kommentilla. Mergen aikana: pidä molemmat puolet,
upstream ylös ja custom-koodi merkin alle.

Koemerge `origin/master` + `v2026.916.1` (2026-09-26) tuotti 93 konfliktitiedostoa.
Täysi lista omistavine kykyineen ja ratkaisuohjeineen on regressiomatriisissa. Pahimmat
(konfliktilohkoja suluissa):

- `pnpm-lock.yaml` (57) — ota upstreamin versio, aja `pnpm install`
- `server/src/services/heartbeat.ts` (15) — system pause, company pause, concurrency limit, idle timer skip, recall-injektio
- `packages/db/src/migrations/meta/_journal.json` (10) — migraatiorekisteri, ks. yllä
- `ui/src/pages/Routines.tsx` (8) ja `ui/src/pages/Routines.test.tsx` (4) — quota pause -vartijat
- `server/src/routes/issues.ts` (8) — goalId-suodin, run-id-guard, outcome requirements
- `server/src/app.ts` (8) — route mount (risk, email, resend/SES inbound, outreach, unsubscribe, github-webhooks, knowledge)
- `server/src/services/recovery/service.ts` (7) — strictInProgressOnly, heartbeat disabled -ohitus, RK9-87
- `server/src/__tests__/heartbeat-process-recovery.test.ts` (7)
- `server/src/services/routines.ts` (6) — quota pause -vartijat
- `server/src/services/issues.ts` (6) — backlog→todo, sähköpostiketjut
- `server/src/index.ts` (6) — service init (risk, slack, email, outreach, webhook monitor, system pause)
- `packages/adapters/claude-local/src/server/execute.ts` (6) ja `test.ts` (6) — tool containment, API-avaimen pidätys (RK9-228), mallilista
- `server/src/routes/instance-settings.ts` (5), `server/src/services/instance-settings.ts` (3), `ui/src/pages/InstanceSettings.tsx` (modify/delete) — system pause, concurrency limit
- `server/src/routes/agents.ts` (5) — external-runs, human_proxy
- `server/src/services/issue-execution-policy.ts` (4) — outcome requirements (SEC-91)
- `skills/paperclip/SKILL.md` (3) ja `skills/paperclip-dev/SKILL.md` (modify/delete)
- `scripts/provision-worktree.sh`
- `server/src/services/index.ts`, `packages/db/src/schema/index.ts`, `packages/shared/src/index.ts`, `packages/shared/src/constants.ts` — exportit

## Porrastusmalli

Upstream päivitetään tagi kerrallaan, ei suoraan `upstream/master`iin. Vahvistettu
porrastus (tagit ja commitit: regressiomatriisi, osio "Lähtötila"):

`v2026.512.0` → `v2026.609.0` → `v2026.720.0` → `v2026.817.0` → `v2026.831.1` → `v2026.916.1`

Jokainen porras on oma branch (`upgrade/v2026.NNN.N`) ja oma PR. Porras mergetään
masteriin vasta, kun regressiomatriisin pakolliset tarkistukset ovat vihreitä
harjoitusinstanssissa. Seuraava porras aloitetaan edellisen mergetystä masterista.
Kirjaa jokainen porras osioon "Porrasloki".

## Node 24

Upstream vaatii `engines.node >=24.11.0` (tarkistettu tageista `v2026.916.1` ja
`upstream/master`). Fork vaatii nyt `>=20`, ja paperclip-01 ajaa Node 22:ta. Node pitää
päivittää 24.11:een tai uudempaan viimeistään ennen portaan, jonka `package.json`
nostaa vaatimuksen, mergeä. Päivitä samalla CI-runnerit (builder, builder-fast) ja
tuotannon systemd-palvelun Node. Toteutus ja tarkka porras: kirjataan tähän osioon.

## Oletusten kovennus

Varattu lapselle, joka tarkistaa upstreamin muuttuneet oletusarvot (esim. hire approval,
auth-tila, heartbeat-ajastimet) ja kiinnittää forkin tarvitsemat arvot eksplisiittisiksi.

## Harjoitusinstanssi

Varattu harjoitusinstanssin lapselle. Operaattorin päätös (2026-09-26): instanssi eristetään
ensisijaisesti verkkotasolla (oma käyttäjä tai netns, egress vain loopback ja paikallinen PG)
ja salaisuudet pidetään poissa envistä. Koodiin lisätään gate vain sinne, mitä verkkotaso ei
kata. Savutesti ajetaan: `scripts/upgrade-smoke.sh http://<harjoitusinstanssi>:<portti>`.

## Deploy ja rollback

Varattu deploy- ja rollback-lapselle. Perusrunko on osioissa "Upgrade-prosessi" 1 ja 7.

## Heartbeat-päätökset

Varattu heartbeat.ts:n konfliktien ratkaisupäätöksille (15 konfliktilohkoa 916.1:ssä).
Jokaisessa portaassa ajetaan yksi `claude_local`-heartbeat per aktiivinen yritys
harjoitusinstanssissa egress estettynä.

## ACPX

Varattu upstreamin ACPX-muutosten arvioinnille ja päätöksille. `claude_local`-moottorin
kiinnitys ja RK9-228-avainvartijan portaat: [`doc/upgrade/acpx-claude-local.md`](upgrade/acpx-claude-local.md)
(RK9-305).

## Upgrade-prosessi

### 1. Pre-flight

```bash
git status  # varmista puhdas working tree
pg_dump -Fc paperclip > /var/backups/paperclip-pre-upgrade-$(date +%Y%m%d).dump
```

Kirjaa pre-upgrade-SHA pysyvään paikkaan, ei `/tmp`:hen: lisää rivi osioon
"Porrasloki" (SHA, päiväys, tag) ja luo lisäksi git-tagi, joka säilyy uudelleenkäynnistysten yli:

```bash
PRE=$(git rev-parse origin/master)
git tag "rk9/pre-upgrade-v2026.NNN.N" "$PRE"
git push origin "rk9/pre-upgrade-v2026.NNN.N"
```

Aja lähtötilan savutesti: `scripts/upgrade-smoke.sh --offline --fork-tests`.

### 2. Fetch & inspect

```bash
git fetch upstream --tags
git log --oneline HEAD..v2026.NNN.N
git log --oneline HEAD..v2026.NNN.N -- packages/db/src/migrations/
```

### 3. Merge

```bash
git checkout -b upgrade/v2026.NNN.N origin/master
git merge v2026.NNN.N --no-commit
```

### 4. Ratkaise konfliktit

- Journal (`_journal.json`): upstream-migraatiot ensin, custom 9001+ jälkeen
- Hotspot-tiedostot: pidä molemmat puolet, upstream ylös, custom merkin alle
- `pnpm-lock.yaml`: hyväksy upstream, aja `pnpm install`
- Muut: regressiomatriisin konfliktitaulukon ratkaisusarake

### 5. Validoi

```bash
pnpm --filter @paperclipai/db check:migrations
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/shared build
pnpm -r typecheck
pnpm test:run
pnpm build
scripts/upgrade-smoke.sh --offline --fork-tests
scripts/upgrade-smoke.sh http://<harjoitusinstanssi>:<portti>
```

### 6. Commit & deploy

```bash
git commit -m "Merge upstream v2026.NNN.N"
git push origin upgrade/v2026.NNN.N
gh pr create --repo mv50000/paperclip --draft
```

PR mergetään masteriin vasta, kun kaikki PR-checkit ovat vihreitä ja harjoitusinstanssin
tarkistukset on kirjattu Porraslokiin.

### 7. Rollback

```bash
# Koodi: git reset --hard rk9/pre-upgrade-v2026.NNN.N   (tai Porraslokin SHA)
# DB: pg_restore -d paperclip --clean /var/backups/paperclip-pre-upgrade-XXXXXXXX.dump
```

## Porrasloki

| Päivämäärä | Porras / tag | Pre-upgrade-SHA | Konflikteja | Smoke | Huomiot |
|-----------|--------------|-----------------|-------------|-------|---------|
| 2026-09-26 | lähtötila (ennen 512.0) | `9ed8e7704bd49da4064499de8477ae0a42e593e7` | 93 (koemerge 916.1) | 10/10 ok, fork-testit 68/69 paikallisesti | RK9-304; email-routes.test.ts vihreä vain CI:ssä |

## Upgrade-loki

| Päivämäärä | Versio | Huomiot |
|-----------|--------|---------|
| 2026-04-28 | v2026.427.0 | Ensimmäinen upgrade; 9000-renumbering; 2 konflikti (journal, test) |
