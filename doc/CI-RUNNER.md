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

## Upstream-merge

Workflow-muutokset on merkitty `# --- RK9 Custom (RK9-350) ---` -kommentilla ja listattu
`doc/UPSTREAM-UPGRADE.md`:n hotspoteissa. `scripts/upgrade-smoke.sh --offline` epäonnistuu,
jos jokin `runs-on`- tai `runner_label`-rivi ei käytä `vars.CI_RUNNER`ia.
