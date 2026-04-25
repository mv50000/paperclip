# CI/CD putki Paperclip-yrityksille

Yhtenäinen, Docker-pohjainen, multi-host CI/CD-putki kaikille Paperclip-yrityksille. Korvaa per-yritys räätälöidyt deploy-tavat (Makefile+systemd, cargo+systemd, mixed Docker/SSH) yhdellä mv50000/cicd-reusable-workflowilla.

> **Pipeline-repo:** https://github.com/mv50000/cicd (julkinen, v1 tag)
> **Plan-dokumentti:** `/home/rk9admin/.claude/plans/suunnittele-k-yt-nn-llinen-tehokas-mahdo-pure-stream.md`

## Tavoite

- **Stack-agnostinen** (Rust/Node/mikä tahansa) → kaikki Dockerin kautta
- **Host-agnostinen** (paperclip-01, docker.rk9.fi, mahdolliset cloud VPS:t) → SSH-pohjainen deploy
- Minimoi virheet: terveystarkistukset, atominen `pull && up`, image-tag-rollback
- Skaalautuu uusilla yrityksillä — uusi yritys tuotannossa < 1 päivä

## Arkkitehtuuri

```
Yritysrepo (mv50000/<co>)              mv50000/cicd                Deploy host
──────────────────────────             ───────────────             ──────────────────
.github/workflows/deploy.yml ──uses──► build-and-deploy.yml
                                            │
                                       docker-build-push  ──push──► ghcr.io/mv50000/<co>:sha-XXX
                                            │
                                       ssh-deploy        ──rsync──► /srv/<co>/<env>/
                                                         ──ssh────► docker compose pull && up -d
                                            │
                                       wait-for-health   ──curl───► health endpoint
```

## Yritysrepon `.github/workflows/deploy.yml` (cookie-cutter)

```yaml
name: Deploy
on:
  push: { branches: [main] }
  workflow_dispatch:
    inputs:
      environment: { type: choice, options: [dev, prod] }
      action: { type: choice, options: [deploy, rollback] }

permissions:
  contents: read
  packages: write

jobs:
  deploy:
    if: github.event.inputs.action != 'rollback'
    uses: mv50000/cicd/.github/workflows/build-and-deploy.yml@v1
    with:
      company: <co>
      environment: ${{ github.event.inputs.environment || 'prod' }}
      image_name: ghcr.io/mv50000/<co>
      deploy_host: paperclip-01.rk9.fi  # tai docker.rk9.fi (dev), erillinen prod-host
      deploy_path: /srv/<co>/${{ github.event.inputs.environment || 'prod' }}
      health_url: http://localhost:3000/api/health
    secrets:
      DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
```

## Sopimukset

| Asia | Konventio |
|------|-----------|
| Image namespace | `ghcr.io/mv50000/{company}` |
| Tagit | `:sha-<7>`, `:env-prod`, `:env-dev`, `:branch-<slug>`, `:pr-<n>`, `:vX.Y.Z` |
| Concurrency | `deploy-{company}-{env}` (estää race-deployt) |
| Deploy-juuri | `/srv/{company}/{env}/` |
| Auth | `${{ secrets.GITHUB_TOKEN }}` riittää (sama org), `DEPLOY_SSH_KEY` repo-secret |
| Restart | `restart: unless-stopped` + Docker `live-restore`, ei systemd-wrapperia |
| Health-check | Pakollinen URL, oletustimeout 60 s, fail → automaattinen tag-pointer-rollback |

## Kuka deployaa?

**Engineering-agentit** (CTO, Koodari, Teknikko per yritys) saavat `deploy`-skillin. Ei globaalia DevOps-agenttia — yritysten itsenäisyys säilyy. Skill on dokumentoitu `.agents/skills/deploy/SKILL.md`:ssa.

Skill **ei** rollbackaa automaattisesti. Workflow tekee auto-rollbackin health-failin yhteydessä; manuaalinen rollback vaatii ihmisen tai senior-agentin hyväksynnän.

Skill ei käynnisty ennen merge'ä — käytä `prcheckloop` PR-tarkistuksiin ennen merge'ä, sitten `deploy`.

## Onboarding

Uusi yritys 5 askeleessa: https://github.com/mv50000/cicd/blob/main/docs/onboarding.md

Migraatio vanhasta systemd-mallista: https://github.com/mv50000/cicd/blob/main/docs/migration-from-systemd.md

Migraatio-helper:

```bash
bash /home/rk9admin/paperclip/scripts/migrate-company.sh <company> [rust|node]
```

## Operointi

| Tarve | Komento |
|-------|---------|
| Tarkista runner-orvot | `bash /home/rk9admin/paperclip/scripts/audit-runners.sh` |
| Bootstrap deploy host | `sudo bash <(curl -L https://raw.githubusercontent.com/mv50000/cicd/v1/scripts/server-bootstrap.sh) <co> <env>` |
| Manuaalinen rollback | `gh workflow run deploy.yml --repo mv50000/<co> -f action=rollback -f environment=<env>` |
| Health-check (host-puoli) | `bash /srv/<co>/<env>/healthcheck.sh <url>` |

## Migraatiojärjestys

Vanhat yritykset migrataan helpoimmasta vaikeimpaan:

1. **saatavilla** (jo Dockerissa, vaihdetaan host-build → GHCR-pull) — ~2 h
2. **quantimodo** (Rust+systemd → Docker) — ~3 h
3. **alli-audit** (osittain composessa, Chromium + LUKS-mount) — ~6 h
4. **bk/ololla** (Rust+Next, dev/prod) — ~8 h
5. **optimi** (CI rikki, ei deploy-vaihetta) — ~4–6 h

Cutover per yritys: vanha + uusi rinnakkain (eri portti) yhden vrk, sitten DNS/portin vaihto, vanha alas viikon kuluttua.
