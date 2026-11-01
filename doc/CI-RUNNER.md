# CI-runner: siirto pois GitHub-hostatuilta runnereilta (RK9-350)

RK9:n CI-runner-policy kieltää buildit GitHub-hostatuilla runnereilla. Operaattori päätti
27.9.2026, että forkin `mv50000/paperclip` jobit siirretään omalle runnerille tai
Ubicloudiin. Poikkeusta ei kirjata.

Tämä dokumentti kuvaa vivun, turvamallin, käyttöönoton ja palautuksen. Workflow-muutokset
ovat valmiina masterissa. Runneria ei ole vielä rekisteröity, joten CI ajaa yhä
`ubuntu-latest`illa, kunnes operaattori tekee alla olevat vaiheet.

## Vipu: `vars.CI_RUNNER`

Jokainen jobi valitsee runnerinsa repo-muuttujasta `CI_RUNNER`:

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNNER || '["ubuntu-latest"]') }}
```

- Arvo on **JSON-taulukko** runner-labeleita, esim. `["self-hosted","paperclip-ci"]` tai
  `["ubicloud-standard-4"]`. Sama muoto kelpaa `mv50000/cicd`:n secret-scanin
  `runner_label`-inputille.
- Kun muuttujaa ei ole, kaikki jobit ajavat `ubuntu-latest`illa kuten ennenkin.
- Virheellinen JSON kaataa workflow'n käynnistyksen. Tarkista arvo ennen asetusta.
- Palautus on muuttujan poisto. Workflow-muutosta ei tarvita.

| Workflow | Jobit | Laukaisin |
|---|---|---|
| `pr.yml` | `secret-scan`, `policy`, `verify`, `e2e` | `pull_request` (fork-suoja, ks. alla) |
| `release.yml` | `verify_canary`, `publish_canary` (`if: false`), `verify_stable`, `preview_stable`, `publish_stable` | push masteriin, `workflow_dispatch` |
| `docker.yml` | `build-and-push` | push masteriin ja `v*`-tageihin |
| `refresh-lockfile.yml` | `refresh` | push masteriin, `workflow_dispatch` |
| `agent-runtime-images.yml` | `build-and-sign` (ajaa vain upstreamissa, `if: github.repository == 'paperclipai/paperclip'`) | push masteriin (polut `docker/agent-runtime/**`), `workflow_dispatch` |
| `ai-auto-merge.yml` | `auto-merge` | `workflow_run` (PR-workflow valmis) |
| `e2e.yml` | `e2e` | `workflow_dispatch` |
| `release-smoke.yml` | `smoke` | `workflow_dispatch`, `workflow_call` |
| `rust-cache-warm.yml` (vain forkissa, RK9-637) | `warm` | push masteriin (polut `packages/paperclip-runner/runner/**`, `rust-toolchain.toml`, `rust-cache-warm.yml`), `workflow_dispatch`, päivittäinen `schedule` |

`deploy-dev.yml` poistettiin, ks. [Poistettu: deploy-dev.yml](#poistettu-deploy-devyml).

### Fork-PR:t

Repo on julkinen. `pr.yml` käyttää vipua vain, kun PR tulee samasta reposta:

```yaml
runs-on: ${{ fromJSON(github.event.pull_request.head.repo.full_name == github.repository && vars.CI_RUNNER || '["ubuntu-latest"]') }}
```

Fork-PR ajaa aina GitHub-hostatulla runnerilla. Julkisen repon hostatut minuutit ovat
ilmaisia, eikä vieras koodi pääse omalle koneelle.

Huom: `github.event.pull_request.head.repo.fork` ei kelpaa ehdoksi. Myös `mv50000/paperclip`
on GitHubin mielestä fork, joten ehto olisi tosi myös omille PR:ille.

## Turvamalli

GitHub ei suosittele pysyviä self-hosted-runnereita julkisille repoille. Syy on fork-PR:t:
PR:n koodi ajaa runnerilla, ja pysyvällä runnerilla yksi jobi voi jättää jälkeensä
prosessin, joka näkee myöhempien jobien tokenit (esim. `release.yml`:n `GITHUB_TOKEN` ja
npm-julkaisun OIDC-token). Siksi suoja rakentuu siitä, ettei fork-koodi koskaan pääse
ajamaan yhtään riviä omalla runnerilla.

Workflow-ehto on vain ensimmäinen kerros. Fork-PR voi muuttaa `pr.yml`:ää ja kirjoittaa
`runs-on: [self-hosted, paperclip-ci]` suoraan. GitHub ajaa PR:n oman workflow-version,
joten ehto ei yksin riitä.

Varsinainen suoja on nämä viisi:

1. **Job-started-hook hylkää fork-koodin runnerin tasolla.** Asennusskripti asentaa
   root-omisteisen hookin `/usr/local/lib/paperclip-runner/job-started.sh` ja kytkee sen
   runnerin `.env`:iin (`ACTIONS_RUNNER_HOOK_JOB_STARTED`). Runneri ajaa hookin ennen jobin
   ensimmäistä askelta. Hook sallii vain repon `mv50000/paperclip` jobit ja niistä vain
   tapahtumat `push`, `workflow_dispatch`, `workflow_run`, `schedule` sekä `pull_request`,
   jonka head-repo on `mv50000/paperclip`. Kaikki muu (fork-PR, `pull_request_target`)
   hylätään. Pelkkä epäonnistunut hook ei riitä, koska runneri ajaa silti askeleet, joiden
   ehto on `always()` tai `failure()`. Siksi hook tappaa jobin `Runner.Worker`-prosessin
   (runnerilla on yksi slotti). Jobi ei voi muuttaa hookia, ja `.env`:iin se pääsisi vasta
   ajettuaan koodia.
2. **Fork-PR:n ajo vaatii hyväksynnän jokaiselta ulkopuoliselta.** Asetus on 27.9.2026
   `first_time_contributors` (todennettu: `gh api repos/mv50000/paperclip/actions/permissions/fork-pr-contributor-approval`).
   Se päästää kerran hyväksytyt kontribuuttorit läpi ilman hyväksyntää. Vaihda asetus
   arvoon `all_external_contributors` ennen runnerin rekisteröintiä (vaihe 1). Vaiheen 3
   token-komento tarkistaa asetuksen ja kieltäytyy muuten. Hyväksyjä lukee `.github/`-diffin
   ennen kuin hyväksyy ajon.
3. **Runneri ajaa omana käyttäjänään** (`ghrunner-pc`). Käyttäjällä ei ole sudoa, docker-ryhmää
   eikä kirjoitusoikeutta org-runnerien (`ghrunner`) kotiin ja cacheihin. Asennusskripti
   tarkistaa tämän ja varoittaa, jos cache on luettavissa. Docker on rootless.
4. **Root ei aja eikä kirjoita mitään runner-hakemistossa asennuksen jälkeen.** Hakemisto
   on runner-käyttäjän kirjoitettavissa. Skripti kirjoittaa systemd-unitin suoraan
   (`svc.sh`ää ei ajeta rootina), päivittää `.env`:n runner-käyttäjänä, ja poisto tehdään
   GitHubin API:lla ja `systemctl`illä.
5. **Runneri ei aja paperclip-01:llä.** Prod ajaa siellä, ja `CONSTITUTION.md` kieltää
   CI-buildit sille hostille. Asennusskripti kieltäytyy, jos host ajaa `paperclip.service`ä.

### Jäännösriskit

- **Saman repon PR:t ja master-push jakavat käyttäjän julkaisujobien kanssa.** Kirjoitusoikeus
  repoon riittää kaappaamaan runnerin. Sama oikeus riittää jo nyt pushiin masteriin, joten
  luottamusraja ei muutu.
- **Verkko.** Jobit näkevät builder-02:n lähiverkon kuten org-runneritkin. Egress-rajausta ei ole.
- **Orpoprosessit.** Runneri tappaa jobin prosessit jobin lopussa (`RUNNER_TRACKING_ID`), mutta
  tarkoituksella irrotettu prosessi, user-unit tai kontti voi jäädä (linger on päällä). Tämä
  koskee luotettua koodia, koska hook tappaa fork-jobin ennen sen ensimmäistä askelta.
  Poisto-ohje siivoaa käyttäjän kokonaan.
- **Uusi `workflow_run`-workflow.** Hook sallii `workflow_run`in, koska se ajaa masterin koodia.
  Jos tällainen workflow hakee PR:n koodin tai artefaktit, fork-koodi ajaisi runnerilla.
  `scripts/upgrade-smoke.sh --offline` kieltää `workflow_run`-workflowssa checkoutin,
  `gh pr checkout`in, `refs/pull/`-haun ja `actions/download-artifact`in.

Jos jäännösriskit eivät kelpaa, valitse Ubicloud (ks. alla). Sen runnerit ovat
kertakäyttöisiä VM:iä, joten pysyvyysriskiä ei ole.

Suositus, ei pakollinen: vaihda repon `default_workflow_permissions` arvosta `write` arvoon
`read` (27.9.2026: `write`). Jobit, jotka kirjoittavat (`release.yml`, `docker.yml`,
`refresh-lockfile.yml`, `ai-auto-merge.yml`), julistavat oikeutensa itse. `pr.yml`, `e2e.yml`
ja `release-smoke.yml` tarvitsevat vain lukuoikeuden.

## Käyttöönotto (operaattori)

Tee siirto masterin jäädytyksen ulkopuolella. Älä tee sitä kesken upstream-portaan mergeä.

### Vaihe 1: fork-PR-hyväksyntä

```sh
gh api -X PUT repos/mv50000/paperclip/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
gh api repos/mv50000/paperclip/actions/permissions/fork-pr-contributor-approval
```

### Vaihe 2: hostin valmistelu (suositus builder-02)

Org-runnerit `builder`/`builder-fast` kuuluvat orgille `rk9-ai`. Henkilökohtaisen tilin
repo ei näe niitä, joten tarvitaan repo-tason runneri. builder-02 on luonteva paikka:
siellä on jo `ci-runners.slice`, rootless Docker -paketit ja Playwrightin kirjastot.
Uusi runneri on neljäs slotti samassa slicessa, joten runner-unitin muisti kuuluu slicen
yhteiseen kattoon. Rootless Docker ajaa käyttäjän user-sessiossa slicen ulkopuolella, joten
skripti antaa sille oman katon (`user-<uid>.slice`, 6 G).

Repoa ei ole kloonattu build-hosteille. Kopioi skripti hostille, esim.
`scp scripts/ci/install-paperclip-runner.sh <host>:`, ja aja se siellä.

Tarkista esivaatimukset ilman muutoksia:

```sh
sudo ./install-paperclip-runner.sh --check
```

Esitarkistus kertoo puuttuvat paketit. Tyypilliset korjaukset rootina:

```sh
apt install uidmap slirp4netns docker-ce-rootless-extras   # rootless Docker
apt install qemu-user-static binfmt-support                # docker.yml:n arm64-build
npx -y playwright install-deps chromium                    # Chromiumin kirjastot
```

### Vaihe 3: rekisteröinti ja asennus

Hae token koneella, jolla `gh` on kirjautunut. Komento hakee tokenin vain, jos vaiheen 1
asetus on voimassa:

```sh
policy="$(gh api repos/mv50000/paperclip/actions/permissions/fork-pr-contributor-approval --jq .approval_policy)"
if [ "$policy" = "all_external_contributors" ]; then
  gh api -X POST repos/mv50000/paperclip/actions/runners/registration-token --jq .token
else
  echo "Pysähdy: fork-PR-hyväksyntä on '$policy'. Tee vaihe 1 ensin." >&2
fi
```

Aja asennus kohdehostilla. Liitä token kehotteeseen, jotta se ei jää shellin historiaan:

```sh
read -rs RUNNER_TOKEN && export RUNNER_TOKEN
sudo --preserve-env=RUNNER_TOKEN ./install-paperclip-runner.sh
unset RUNNER_TOKEN
```

Skripti tekee nämä:

- luo järjestelmäkäyttäjän `ghrunner-pc` (koti `/srv/ci/ghrunner-pc`, lukittu salasana, ei ryhmiä)
- asentaa root-omisteisen job-started-hookin (ks. [Turvamalli](#turvamalli)); vaatii `jq`:n ja `pkill`in
- lataa actions/runnerin kiinnitetyllä versiolla ja tarkistaa SHA256:n
- rekisteröi runnerin labeleilla `self-hosted, Linux, X64, paperclip-ci`
- kirjoittaa `.env`:iin hookin, `NODE_OPTIONS=--max-old-space-size=4096`,
  `PAPERCLIP_CI_NO_SUDO=1` ja rootless-`DOCKER_HOST`in
- asentaa rootless Dockerin käyttäjän user-sessioon (linger päällä)
- rajaa rootless Dockerin muistin: `user-<uid>.slice` saa `MemoryHigh=5G`, `MemoryMax=6G`
  (dockerd ja kontit ajavat user-sessiossa, eivät runner-unitissa)
- kirjoittaa systemd-unitin `actions.runner.mv50000-paperclip.<nimi>.service` (`KillMode=mixed`) drop-inillä
  `Slice=ci-runners.slice`, `MemoryHigh=6G`, `MemoryMax=7G`, `Restart=on-failure`,
  `OOMPolicy=continue`

Skripti on idempotentti. Uusi ajo ohittaa rekisteröinnin, jos runneri on jo rekisteröity,
ja päivittää hookin, `.env`:n ja unitin. Keskeneräinen asennus (hakemisto ilman `.runner`ia)
pysäyttää skriptin: poista hakemisto ja aja uudelleen.

### Vaihe 4: runneri näkyy GitHubissa

```sh
gh api repos/mv50000/paperclip/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

Odotettu tulos: `status: "online"` ja label `paperclip-ci`.

### Vaihe 5: vivun käännös

```sh
gh variable set CI_RUNNER -R mv50000/paperclip --body '["self-hosted","paperclip-ci"]'
```

### Vaihe 6: todennus

Aja jokin avoin PR uudelleen tai avaa kokeilu-PR. Tarkista, millä runnerilla jobit ajoivat:

```sh
gh api repos/mv50000/paperclip/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | {name, runner_name, conclusion}'
```

`runner_name` on runnerin nimi eikä `GitHub Actions N`. Jobin lokissa näkyy erillinen
job-started-hookin askel ennen checkoutia. Seuraava master-push todentaa
`Release`-, `Docker`- ja `Refresh Lockfile` -workflowt.

## Vaihtoehto: Ubicloud

Ubicloudin GitHub-appin asennusta tilille `mv50000` ei ole todennettu. Tarkista se
GitHubin asetuksista (Settings → Applications) ennen valintaa. Jos appi on asennettu:

```sh
gh variable set CI_RUNNER -R mv50000/paperclip --body '["ubicloud-standard-4"]'
```

Ubicloud-runnerilla on sudo, joten Playwright asentaa kirjastonsa itse. Fork-PR:t
pysyvät silti GitHub-hostatulla.

## Palautus

Vipu takaisin GitHub-hostatulle (vaikutus heti seuraavasta ajosta):

```sh
gh variable delete CI_RUNNER -R mv50000/paperclip
```

Runnerin poisto hostilta. Aja lohko alikuoressa (`bash -eu`) tai skriptinä, jotta `set -eu`
ei sulje omaa shelliäsi. Runner-hakemistosta ei ajeta mitään rootina, koska jobi voi
muokata sen tiedostoja. `${NAME:?}` pysäyttää komennon, jos nimi jäi asettamatta, jottei
`rm -rf` osu koko `/srv/ci/actions-runners/`-hakemistoon (org-runnerit asuvat samassa).

```sh
set -eu                  # keskeytä koko lohko ensimmäiseen virheeseen
NAME='<nimi>'            # esim. builder-02-paperclip
RUSER=ghrunner-pc
RUID="$(id -u "$RUSER")"
UNIT="actions.runner.mv50000-paperclip.${NAME:?}.service"
sudo systemctl disable --now "$UNIT"
sudo rm -f "/etc/systemd/system/$UNIT"
sudo rm -rf "/etc/systemd/system/$UNIT.d"
sudo systemctl daemon-reload
# Käyttäjän kaikki prosessit, user-unitit ja rootless-kontit pois.
sudo loginctl disable-linger "$RUSER"
sudo systemctl stop "user@${RUID:?}.service"
sudo pkill -KILL -u "$RUSER" || true
sudo rm -rf "/srv/ci/actions-runners/${NAME:?}"
sudo find /tmp -maxdepth 1 -uid "${RUID:?}" -exec rm -rf {} +
sudo userdel -r "$RUSER"   # poistaa kodin /srv/ci/ghrunner-pc
sudo sed -i "/^${RUSER}:/d" /etc/subuid /etc/subgid
sudo rm -rf "/etc/systemd/system/user-${RUID:?}.slice.d" /usr/local/lib/paperclip-runner
sudo systemctl daemon-reload
```

Poista rekisteröinti GitHubista koneella, jolla `gh` on kirjautunut:

```sh
ID="$(gh api repos/mv50000/paperclip/actions/runners --jq ".runners[] | select(.name == \"${NAME:?}\") | .id")"
gh api -X DELETE "repos/mv50000/paperclip/actions/runners/${ID:?}"
```

## Tunnetut rajat

- **Yksi slotti.** `verify` ja `e2e` ajavat rinnakkain vain, jos runnereita on kaksi. Yhdellä
  slotilla ne ajavat peräkkäin. PR-checkit hidastuvat, mutta mikään ei kaadu.
- **Runnerin katkos pysäyttää CI:n.** Jobit jäävät jonoon, eikä `ai-auto-merge` merge mitään.
  Ohitus on vivun palautus (`gh variable delete CI_RUNNER`).
- **Playwright ilman sudoa.** Workflow ajaa `playwright install --with-deps` vain, jos
  `PAPERCLIP_CI_NO_SUDO` ei ole `1` ja `sudo -n true` onnistuu. Muuten se asentaa pelkän
  selaimen, ja kirjastot tulevat hostilta.
- **E2E-kotihakemistot.** `tests/e2e/playwright.config.ts` luo jokaiselle ajolle
  `paperclip-e2e-home-*`-hakemiston `os.tmpdir()`iin. Pysyvällä runnerilla ne kertyvät
  `/tmp`iin. Siivoa tarvittaessa: `find /tmp -maxdepth 1 -user ghrunner-pc -name 'paperclip-e2e-home-*' -mtime +2 -exec rm -rf {} +`.
- **arm64-image.** `docker.yml` rakentaa `linux/amd64,linux/arm64`. Rootless Docker ei voi
  rekisteröidä QEMU-binfmt:tä, joten hostilla pitää olla `qemu-user-static`.

## Poistettu: deploy-dev.yml

`deploy-dev.yml` (`[self-hosted, paperclip-dev]`) poistettiin samassa muutoksessa. Syyt:

- Runneria `paperclip-dev` ei ole ollut toukokuusta. Viimeiset ajot 14.–15.5.2026 peruuntuivat
  24 tunnin jonotuksen jälkeen.
- Workflow deployasi hakemistoon `/opt/paperclip` ja ajoi `sudo systemctl restart paperclip`.
  Prod ajaa nykyään työhakemistosta `/home/rk9admin/paperclip` (`CONSTITUTION.md`), ja
  restart on operaattorin käsityötä.
- Herätys vaatisi sudo-oikeudellisen runnerin prod-hostille. Se on ristiriidassa
  RK9-200:n (runnerit ilman sudoa) ja `CONSTITUTION.md`:n (ei CI:tä paperclip-01:llä) kanssa.

`ai-auto-merge.yml` dispatchasi `deploy-dev.yml`:n jokaisen mergen jälkeen. Dispatch poistettiin,
ja jobin `actions`-oikeus laskettiin arvosta `write` arvoon `read`.

## Rust-build-cache (RK9-637)

PR-workflow'n `Build`-jobi ajaa askeleen `Verify Paperclip Runner`
(`pnpm --filter @paperclipai/paperclip-runner check:all`). Askel kääntää
`packages/paperclip-runner/runner`-workspacen: `cargo check`, debug-binäärit,
`cargo test --release` ja `pnpm build`in release-daemonin. Ennen RK9-637:ää jobissa ei
ollut Rust-cachea, joten jokainen PR käänsi riippuvuudet alusta.

### Mekanismi

- `pr.yml`:n `Build`-jobi asentaa ensin kiinnitetyn toolchainin
  (`packages/paperclip-runner/rust-toolchain.toml`) ja palauttaa sitten cachen
  `Swatinem/rust-cache`illa. Action on kiinnitetty commit-SHA:han, versio on kommentissa.
- PR-ajot vain palauttavat (`save-if: false`). Syy: `pull_request`-ajon tallentama cache
  näkyy vain samalle PR:lle, ja jokainen PR täyttäisi 10 G:n repo-cachea omalla kopiollaan.
- `rust-cache-warm.yml` tallentaa cachen masterin scopeen. Kaikki PR:t, myös fork-PR:t,
  voivat lukea masterin cachea. Workflow ajaa vain luotettua koodia: push masteriin,
  `workflow_dispatch` ja päivittäinen `schedule`. Se tallentaa vain, kun ref on master.
  Oikeudet ovat `contents: read`, ja checkout ei jätä tokenia levylle.
- Täsmäosumalla warm-ajo vain palauttaa cachen ja ohittaa käännöksen. Palautus pitää
  entryn elossa (GitHub poistaa 7 päivää lukemattoman cachen). Päivittäinen ajo korjaa myös
  avaimen muutoksen, kun runner-imagen oletus-rustc vaihtuu.
- Cachessa ovat riippuvuudet, ei workspace-crateja (`cache-workspace-crates: false`,
  `cache-all-crates: false`, `cache-bin: false`). Varmennus ei muutu: samat komennot,
  sama `--release` ja samat testit.

### Avain

`rust-cache` muodostaa avaimen näistä: `shared-key` (`paperclip-runner`), runnerin OS ja
arkkitehtuuri, asennettujen toolchainien `rustc -vV` (myös runner-imagen oletus-`stable`),
`CARGO*`-, `CC*`-, `CFLAGS*`-, `CXX*`-, `CMAKE*`- ja `RUST*`-ympäristömuuttujat sekä workspacen
`Cargo.toml`-tiedostojen (`runner/` ja `runner/crates/*`) ja `Cargo.lock`in hash. Toolchain-askel ennen cachea tuo
kiinnitetyn version avaimeen, koska `rust-toolchain.toml` on workspacen ulkopuolella.

Pidä `pr.yml`:n RK9-637-lohko ja `rust-cache-warm.yml` samanlaisina. Eroava syöte tai
ympäristömuuttuja vaihtaa avaimen, ja jokainen PR kääntää taas alusta. Kylmä polku
(ensimmäinen ajo tai avaimen muutos) toimii kuten ennen, vain hitaammin.

Tunnetut rajat:

- Kun GitHub vaihtaa runner-imagen oletus-rustc:n, osa PR:istä voi ohittaa cachen, kunnes
  päivittäinen warm-ajo on tallentanut uuden avaimen. Tämä hidastaa, mutta ei kaada mitään.
- Jos `vars.CI_RUNNER` asetetaan omaan runneriin, warm-ajo tallentaa sen runnerin avaimella.
  Fork-PR:t ajavat yhä `ubuntu-latest`illa, joten ne eivät silloin osu cacheen.
- `rust-cache` v2.9.2 karsii vanhoja riippuvuusversioita vain osittain (korjattu v2.9.3:ssa,
  upstreamin PR #377). Jokainen `Cargo.lock`-muutos masterissa voi kasvattaa entryä, kunnes
  avain vaihtuu. Seuraa kokoa alla olevalla komennolla. Kiinnitys on sama kuin upstreamin
  `release-verify.yml`:ssä.
- Restore-askel asettaa `CARGO_INCREMENTAL=0` jobin myöhemmille askelille. Mikään tarkistus ei
  lue sitä.

### Mittaukset

Ennen (PR-ajo 27.10.2026 22:12Z, run 40592946827, vihreä): PR:n seinäkello 17,5 min,
`Build`-jobi 16,9 min, josta `Verify Paperclip Runner` 878 s. Repo-cache 2,1 G (pnpm).

Warm-ajo masterissa (1.11.2026, run 41353449384, merge `afcc4b9`): 6,0 min, josta käännös
5,6 min. Tallennettu cache `v0-rust-paperclip-runner-Linux-x64-4d0ce471-a95b0328` on 710 M
(scope `refs/heads/master`).

Lämmin cache, kaksi PR-ajoa (#242, run 41354017904, yritykset 1 ja 2, 1.11.2026). Molemmissa
`Restored from cache key "v0-rust-paperclip-runner-Linux-x64-4d0ce471-a95b0328" full match: true`.

| Mittari | Ennen (run 40592946827) | Lämmin 1 | Lämmin 2 |
|---|---|---|---|
| `Verify Paperclip Runner` | 878 s | 553 s | 505 s |
| `Build`-jobi | 16,9 min | 12,5 min | 11,1 min |
| `Restore Rust build cache` -askel | – | 13 s | 11 s |
| PR:n seinäkello | 17,5 min | 15,3 min | 24,6 min |

- `Build`-jobi lyheni 4,4–5,8 min (26–34 %). Tavoite ≤ 8 min ei täyttynyt. Jäljellä ovat
  workspace-craten käännös, TypeScript ja vitest, joita cache ei poista.
- Seinäkello riippuu jonosta. Yrityksessä 2 `Build` alkoi vasta 10 min ajon alun jälkeen,
  joten seinäkello ei kerro cachen vaikutusta.
- Kylmä polku (#240, ei cachea) meni läpi: `Build` 15,6–17,9 min, `Verify Paperclip Runner` 902 s.
  Jobin `timeout-minutes: 20` on lähellä.
- Repo-cache mittausten jälkeen: 6,39 G, 9 entryä. Rust-cache on 0,71 G. Loppu on pnpm-storea,
  jonka jokainen PR tallentaa omaan scopeensa (noin 710 M per PR).

Tarkista cachen koko:

```sh
gh api 'repos/mv50000/paperclip/actions/caches?key=v0-rust-paperclip-runner' \
  --jq '.actions_caches[] | {key, ref, size_in_bytes, last_accessed_at}'
gh api repos/mv50000/paperclip/actions/cache/usage
```

Palautus: poista RK9-637-lohko `pr.yml`:stä ja tiedosto `rust-cache-warm.yml`. Vanha cache
vanhenee itsestään 7 päivässä. Heti poisto id:llä:

```sh
gh api 'repos/mv50000/paperclip/actions/caches?key=v0-rust-paperclip-runner' --jq '.actions_caches[].id' \
  | xargs -r -n1 gh cache delete -R mv50000/paperclip
```

## Upstream-merge

Workflow-muutokset on merkitty `# --- RK9 Custom (RK9-350) ---` -kommentilla ja listattu
`doc/UPSTREAM-UPGRADE.md`:n hotspoteissa. `scripts/upgrade-smoke.sh --offline` epäonnistuu,
jos jokin `runs-on`- tai `runner_label`-rivi ei käytä `vars.CI_RUNNER`ia.
