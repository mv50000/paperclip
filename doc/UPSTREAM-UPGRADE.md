# Upstream Upgrade — Toistettava prosessi

Tämä dokumentti kuvaa prosessin, jolla Paperclip-forkin (mv50000/paperclip) päivitetään
uuteen upstream-versioon (paperclipai/paperclip) ilman kustomointien rikkoutumista.

## Migraatiokonventio

Custom-migraatiot käyttävät **9000-sarjaa** (`9NNN_rk9_<feature>.sql`):

| Numero | Feature |
|--------|---------|
| 9001   | Risk Management (taulut, kategoriat, snapshotit) |
| 9002   | Resend Email (viestit, routet, rate limit, templates) |
| 9003   | Email Escalation (lisäsarakkeet) |

Seuraava vapaa numero: **9004**.

Upstream käyttää 0000-sarjaa. Numerot eivät törmää (~17 vuoden marginaali).

## Hotspot-tiedostot

Nämä tiedostot muuttuvat sekä upstreamissa että meillä. Custom-osiot on merkitty
`// --- RK9 Custom ---` -kommentilla. Mergen aikana: pidä molemmat puolet,
upstream ylös ja custom-koodi merkin alle.

- `server/src/index.ts` — service init (risk, slack, email startup)
- `server/src/app.ts` — route mount (risk, email, resend-inbound, slack)
- `server/src/services/index.ts` — exportit (slack, risk)
- `packages/db/src/schema/index.ts` — schema-exportit (risk, email)
- `packages/shared/src/constants.ts` — Risk Management -konstantit
- `packages/shared/src/index.ts` — Risk-tyyppien exportit
- `packages/db/src/migrations/meta/_journal.json` — migraatiorekisteri

## Upgrade-prosessi

### 1. Pre-flight

```bash
git status  # varmista puhdas working tree
pg_dump -Fc paperclip > /var/backups/paperclip-pre-upgrade-$(date +%Y%m%d).dump
git rev-parse HEAD > /tmp/paperclip-pre-upgrade-sha
```

### 2. Fetch & inspect

```bash
git fetch upstream --tags
git log --oneline HEAD..upstream/master
git log --oneline HEAD..upstream/master -- packages/db/src/migrations/
```

### 3. Merge

```bash
git checkout -b upgrade/vXXXX-XXX
git merge upstream/master --no-commit
```

### 4. Ratkaise konfliktit

- Journal (`_journal.json`): upstream-migraatiot ensin, custom 9001+ jälkeen
- Hotspot-tiedostot: pidä molemmat puolet, upstream ylös, custom merkin alle
- `pnpm-lock.yaml`: hyväksy upstream, aja `pnpm install`

### 5. Validoi

```bash
pnpm --filter @paperclipai/db check:migrations
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/server typecheck
pnpm test:run
```

### 6. Commit & deploy

```bash
git commit -m "Merge upstream vXXXX.XXX.X"
git checkout master && git merge upgrade/vXXXX-XXX
git push origin master
```

### 7. Rollback

```bash
# Koodi: git reset --hard $(cat /tmp/paperclip-pre-upgrade-sha)
# DB: pg_restore -d paperclip --clean /var/backups/paperclip-pre-upgrade-XXXXXXXX.dump
```

## Upgrade-loki

| Päivämäärä | Versio | Huomiot |
|-----------|--------|---------|
| 2026-04-28 | v2026.427.0 | Ensimmäinen upgrade; 9000-renumbering; 2 konflikti (journal, test) |
