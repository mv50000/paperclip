# Infra-asiantuntijan toimeksianto: Paperclip-yritysten CI/CD-cutover

> **Tausta:** Olemme migrating Paperclip-yrityksiä yhtenäiseen Docker-pohjaiseen CI/CD-putkeen (`mv50000/cicd@v1`). Build + deploy tapahtuu `docker.rk9.fi`-VM:llä (jo pystyssä). Tarvitsemme infra-toimia DNS:lle, vanhojen palvelinten siivoukselle ja prod-cutoverille.
>
> Kaikki yritysrepot ovat `mv50000`-tunnuksen alla GitHubissa (private). CI/CD-pipeline-repo: https://github.com/mv50000/cicd
>
> Plan-dokumentti: `/home/rk9admin/.claude/plans/suunnittele-k-yt-nn-llinen-tehokas-mahdo-pure-stream.md`

## Yleiskatsaus uudesta arkkitehtuurista

```
GitHub mv50000/<co>  →  paperclip-01 (kontroliplane, EI Docker)
                    →  docker.rk9.fi (build + deploy host, Docker 29.4.1)
                            ├─ /srv/saatavilla/dev/   ← cutover tehty 2026-04-25
                            ├─ /srv/saatavilla/prod/  ← TODO
                            ├─ /srv/quantimodo/...    ← TODO
                            ├─ /srv/alli-audit/...    ← TODO
                            ├─ /srv/bk/...            ← TODO
                            └─ /srv/optimi/...        ← TODO

Image namespace: ghcr.io/mv50000/<company>:sha-XXXXXXX
SSH-deploy: deploy@docker.rk9.fi (ed25519 -avain on jo asennettu)
```

## 1. DNS-cutover saatavilla-deville (matala prioriteetti, ~viikon kuluttua)

**Nykytila:**
- `saatavilla-dev.rk9.fi` → `192.168.1.58` (vanha palvelin, jolla nykyinen dev pyöri)
- Uusi dev pyörii nyt `docker.rk9.fi`:n portissa 3000 (`/srv/saatavilla/dev`, image `ghcr.io/mv50000/saatavilla:sha-XXX`, healthy)

**Tarvittava toimi:**
1. Anna uudelle dev:lle viikon "soak-aika" → seuraa että ei regressioita (julkinen URL ei vielä uudella hostilla)
2. Soak-ajan jälkeen vaihda DNS: `saatavilla-dev.rk9.fi` → `docker.rk9.fi`
3. Disabloi vanha 192.168.1.58:n saatavilla-stack: pysäytä container/systemd, mutta säilytä se vielä 2 vk käynnistettävissä rollback-tarpeisiin
4. 2 vk vakauden jälkeen: poista vanha klooni `/opt/saatavilla` ja systemd-yksiköt 192.168.1.58:lta

**Reverse proxy / SSL:** docker.rk9.fi:llä ei ole vielä nginx-proxia eikä SSL:ää. Jos `saatavilla-dev.rk9.fi`-URL on https, tarvitaan:
- Joko nginx + Let's Encrypt docker.rk9.fi:llä (ks. kohta 4 alla)
- Tai keskitetty reverse proxy (`nginx.rk9.fi`?) joka päättää TLS:n ja ohjaa docker.rk9.fi:n portteihin

## 2. Saatavilla-prod -selvitys + cutover (korkea prioriteetti, ~1–2 päivää)

**Nykytila tuntematon:**
- Repon `deploy-prod.yml`-workflow käytti SSH:ta `${{ secrets.DEPLOY_HOST }}`-secretiin (arvoa emme näe ulkoa) ja teki `cd /opt/saatavilla && git pull` + `docker compose build`
- Cutoverin yhteydessä deploy-prod.yml ajautui kerran ja **failasi `Pull latest code` -vaiheessa** (build-vaihe ei ajautunut → tuotantoa ei rikottu, mutta host ei ehkä reachable)
- DNS: missä `saatavilla.fi` tai vastaava julkinen URL osoittaa nyt?

**Tarvittava selvitys:**
1. Mihin saatavilla:n julkinen tuotanto-URL osoittaa? (`dig +short saatavilla.fi` tai vastaava)
2. Onko nykyinen tuotantopalvelin yhä käynnissä? (SSH `${{ secrets.DEPLOY_HOST }}`)
3. Mistä tarkistetaan secret `DEPLOY_HOST`-arvo (GitHub repo Settings → Secrets, vaatii admin-oikeudet)?
4. Tarvitseeko prod oma host vai voiko olla docker.rk9.fi:n eri portissa? (Esim. dev = 3000, prod = 3001) — turvallisempi suosittelen **erillistä prod-VM:ää**, esim. `docker-prod.rk9.fi`

**Cutover-vaiheet (kun selvitys tehty):**
1. Bootstrap kohdehostille: `sudo bash <(curl -L https://raw.githubusercontent.com/mv50000/cicd/v1/scripts/server-bootstrap.sh) saatavilla prod`
2. Kopioi nykyiset env-arvot, mahdolliset SQLite-/datafilet bind-mountille
3. Lisää `DEPLOY_SSH_KEY`-secretti repolle (sama kuin dev:llä toimii, jos sama kohdehost; eri jos erillinen prod-VM)
4. Päivitä `deploy-prod.yml`: korvaa `appleboy/ssh-action` → kutsu `mv50000/cicd@v1` (sama malli kuin nykyinen `deploy-dev.yml`)
5. Palauta `ai-auto-merge.yml`:n dispatch-lista → `['deploy-dev.yml', 'deploy-prod.yml']`
6. Push → seuraa run-vihreänä → tarkista health
7. Vanha tuotanto disabloidaan **vasta DNS-cutoverin jälkeen** (erillinen päätös)

## 3. Tulevat yritykset: per-yritys hostit vai keskitys?

Jokaisella yrityksellä on memorin mukaan oma dev-server:
- alli-audit-01: 192.168.1.55
- quantimodo-01: 192.168.1.56
- saatavilla-01: 192.168.1.57 (== 58?)
- ololla: erillinen (ei IP tiedossa)

**Kysymys:** Pidetäänkö per-yritys dev-VM:t vai keskitetään kaikki `docker.rk9.fi`:lle?

**Suosittelisin:** Keskitetään dev-ympäristöt `docker.rk9.fi`:lle (yksi VM, eri portit yritystä kohti tai eri sub-domain). Etu: yksi runner-VM rakennukselle, helpompi backup, helpompi seurata. Haitta: yksi vikapiste devin osalta. Mutta dev:n vikatilanne ei ole kriittinen → keskitys ok.

**Prod-puolelle suosittelisin:** Erillinen `docker-prod.rk9.fi` VM (ei sama kuin dev) → eristys, blue/green-mahdollisuus, ei dev-aktiviteetti vaikuta prodiin. Resurssit pienemmät kuin dev koska prod:lla ei buildata.

**Päätös tarvitaan ennen kuin migraatio jatkuu** — vaikuttaa muiden yritysten cutover-suunnitelmaan.

## 4. Reverse proxy + SSL `docker.rk9.fi`:lle

Tällä hetkellä yritykset pyörivät raw-portissa (3000, 3001, ...) `docker.rk9.fi`:llä, ei SSL:ää.

**Vaihtoehdot:**

**A) Caddy host-tasolla `docker.rk9.fi`:llä** — yksinkertaisin, automaattinen Let's Encrypt:
```
saatavilla-dev.rk9.fi { reverse_proxy localhost:3000 }
quantimodo-dev.rk9.fi { reverse_proxy localhost:3001 }
...
```

**B) Nginx + Certbot** — manuaalinen mutta tunnetumpi. Tarvitsee per-yritys-vhosti.

**C) Traefik konttina** — Docker-natiivi, automaattinen routing labeleilla. Toimii hyvin compose-pohjaisten yritysten kanssa.

**D) Keskitetty `nginx.rk9.fi`** — jos sellainen on jo (memorin perusteella on), se voi toimia reverse proxina docker.rk9.fi:n porteille.

**Suositukseni:** **A (Caddy)** koska se on triviaali pystyttää (yksi tiedosto Caddyfile), automaattinen SSL, ja konfigurointi voidaan generoida automaattisesti per-yritys cutoverin yhteydessä.

**Toimi:** asenna Caddy `docker.rk9.fi`:lle, lisää Caddyfile saatavilla-devin osalta:
```
saatavilla-dev.rk9.fi {
    reverse_proxy localhost:3000
}
```
DNS: `saatavilla-dev.rk9.fi` → `<docker.rk9.fi public IP>` (kohta 1).

## 5. Self-hosted runner -strategiset päätökset

**Nykytila:**
- 5 per-yritys-runneria `paperclip-01`:llä (alli-audit, bk, optimi, quantimodo-rust, saatavilla)
- 1 uusi runner `docker.rk9.fi`:llä (saatavilla, asennettu cutoverin yhteydessä)

**Suunniteltu lopputila (faasi 2:n jälkeen):**
- 5 vanhaa paperclip-01-runneria → 1 jaettu pooli `docker.rk9.fi`:llä
- TAI 5 per-yritys-runneria docker.rk9.fi:llä, jos resource-eristys halutaan

**Toimi (per quantimodo-migraatio):** asenna runner `docker.rk9.fi`:lle quantimodo-repolle:
```bash
TOKEN=$(gh api -X POST /repos/mv50000/quantimodo-rust/actions/runners/registration-token --jq '.token')
ssh docker.rk9.fi 'mkdir -p ~/actions-runner-quantimodo && cd ~/actions-runner-quantimodo && \
  curl -fsSL -o actions-runner-linux-x64.tar.gz https://github.com/actions/runner/releases/download/v2.334.0/actions-runner-linux-x64-2.334.0.tar.gz && \
  tar xzf actions-runner-linux-x64.tar.gz && rm actions-runner-linux-x64.tar.gz && \
  ./config.sh --unattended --url https://github.com/mv50000/quantimodo-rust --token '$TOKEN' --labels self-hosted,docker,paperclip --name docker-rk9-quantimodo --replace && \
  sudo ./svc.sh install rk9admin && sudo ./svc.sh start'
```

Sama malli muille yrityksille (alli-audit, bk, optimi).

## 6. Tila ja "kuka tekee mitä"

**Mitä Claude tekee** (ohjelmointityö):
- ✅ saatavilla dev cutover (tehty)
- 🔄 quantimodo migraatio (käynnissä) — Dockerfile, workflow, /srv-bootstrap, runner-asennus, PR
- ⏳ alli-audit, bk, optimi migraatiot
- ⏳ Faasi 3: GHCR-cleanup-cron, deploy-history-DB, watchdog

**Mitä infra-asiantuntija tekee** (manuaaliset infra-toimet):
- ⏳ DNS-cutover `saatavilla-dev.rk9.fi` viikon soak-ajan jälkeen (kohta 1)
- ⏳ Saatavilla-prod selvitys + cutover (kohta 2)
- ⏳ Päätös: per-yritys vai keskitetty deploy-host (kohta 3)
- ⏳ Reverse proxy + SSL `docker.rk9.fi`:lle (kohta 4) — luultavasti Caddy
- ⏳ Vanhojen 192.168.1.55–58 -palvelinten siivous yritysten cutoverin jälkeen

## 7. Quantimodo: pg_hba.conf-päivitys 192.168.1.13:lla (KORKEA prioriteetti)

**Tila:** Quantimodo:n container pyörii `docker.rk9.fi:5000`:ssa, mutta DB-yhteys 192.168.1.13:n PostgreSQL:ään failaa:
```
Database connection failed: no pg_hba.conf entry for host "192.168.1.58", user "trading_user", database "trading_platform_db_prod"
```

`docker.rk9.fi`:n IP DB-palvelimen näkemänä on `192.168.1.58` (sama kuin vanha saatavilla-dev-host — virtuaalikoneen uudelleenrakennus tai DHCP-uudelleenkäyttö).

**Toimi 192.168.1.13:lla (PostgreSQL-host):**
1. Lisää tai muokkaa `/etc/postgresql/<ver>/main/pg_hba.conf`:
   ```
   host  trading_platform_db_prod  trading_user  192.168.1.58/32  md5
   ```
   (tai `hostssl` jos halutaan TLS)
2. `sudo systemctl reload postgresql`
3. Täytä **DB_PASSWORD** quantimodo:n env-tiedostoon docker.rk9.fi:llä:
   ```
   ssh docker.rk9.fi "sudo -u deploy sed -i 's|^DB_PASSWORD=__FILL_ME_IN__|DB_PASSWORD=<oikea>|' /srv/quantimodo/dev/.env"
   ssh -i /home/rk9admin/.ssh/paperclip-cicd/deploy_ed25519 deploy@docker.rk9.fi "cd /srv/quantimodo/dev && docker compose restart"
   ```
4. Validoi: `curl -sSf http://docker.rk9.fi:5000/api/v1/health` palauttaa 200

Vasta sen jälkeen quantimodo-pilotti voidaan promote:ta cutover-vaiheeseen (main-branch).

## 8. Yhteyshenkilöt ja hätä-rollback

**Hätä-rollback** (jos cutover rikkoo dev:n):
```bash
# Pysäytä uusi
ssh deploy@docker.rk9.fi 'docker compose -f /srv/saatavilla/dev/docker-compose.yml down'

# Aktivoi vanha 192.168.1.58
# (tarkista miten vanha startattiin, todennäköisesti systemctl tai docker compose)
```

**Hätä-rollback prod:lle** (kun cutover tehdään): käynnistä vanha `${{ secrets.DEPLOY_HOST }}`-palvelimen stack manuaalisesti. Vanhaa ei tuhota ennen 2 viikon vakauden vahvistusta.

**SSH-keypari** (sama jaettava deploy-userille kaikilla docker.rk9.fi:n /srv/-yrityksillä):
- Yksityinen: `/home/rk9admin/.ssh/paperclip-cicd/deploy_ed25519` (paperclip-01:llä, secrettinä jokaisen mv50000-repon GitHub-secrets:ssä)
- Julkinen: `/home/deploy/.ssh/authorized_keys` docker.rk9.fi:llä
