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

Workflow-ehto on vain yksi kerros. Fork-PR voi muuttaa `pr.yml`:ää ja kirjoittaa
`runs-on: [self-hosted, paperclip-ci]` suoraan. GitHub ajaa PR:n oman workflow-version,
joten ehto ei yksin estä vierasta koodia omalla runnerilla.

Varsinainen suoja on nämä neljä:

1. **Fork-PR:n ajo vaatii hyväksynnän jokaiselta ulkopuoliselta.** Asetus on 27.9.2026
   `first_time_contributors` (todennettu: `gh api repos/mv50000/paperclip/actions/permissions/fork-pr-contributor-approval`).
   Se päästää kaikki kerran hyväksytyt kontribuuttorit läpi ilman hyväksyntää. Vaihda
   asetus arvoon `all_external_contributors` ennen runnerin rekisteröintiä (vaihe 1).
2. **Hyväksyjä lukee `.github/`-diffin ennen kuin hyväksyy fork-PR:n ajon.** Jos PR muuttaa
   `runs-on`-rivejä tai lisää workflowta, älä hyväksy ajoa.
3. **Runneri ajaa omana käyttäjänään** (`ghrunner-pc`). Käyttäjällä ei ole sudoa, docker-ryhmää
   eikä pääsyä org-runnerien (`ghrunner`) hakemistoihin ja cacheihin. Docker on rootless.
4. **Runneri ei aja paperclip-01:llä.** Prod ajaa siellä, ja `CONSTITUTION.md` kieltää
   CI-buildit sille hostille. Asennusskripti kieltäytyy, jos host ajaa `paperclip.service`ä.

Suositus, ei pakollinen: vaihda repon `default_workflow_permissions` arvosta `write` arvoon
`read`. Jobit, jotka kirjoittavat (`release.yml`, `docker.yml`, `refresh-lockfile.yml`,
`ai-auto-merge.yml`), julistavat oikeutensa itse. `pr.yml`, `e2e.yml` ja `release-smoke.yml`
tarvitsevat vain lukuoikeuden.

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
Uusi runneri on neljäs slotti samassa slicessa, joten sen muisti kuuluu slicen yhteiseen
kattoon.

Repoa ei ole kloonattu build-hosteille. Kopioi skripti hostille, esim.
`scp scripts/ci/install-paperclip-runner.sh <host>:`, ja aja se siellä.

Tarkista esivaatimukset ilman muutoksia:

```sh
sudo scripts/ci/install-paperclip-runner.sh --check
```

Esitarkistus kertoo puuttuvat paketit. Tyypilliset korjaukset rootina:

```sh
apt install uidmap slirp4netns docker-ce-rootless-extras   # rootless Docker
apt install qemu-user-static binfmt-support                # docker.yml:n arm64-build
npx -y playwright install-deps chromium                    # Chromiumin kirjastot
```

### Vaihe 3: rekisteröinti ja asennus

```sh
export RUNNER_TOKEN="$(gh api -X POST repos/mv50000/paperclip/actions/runners/registration-token --jq .token)"
sudo --preserve-env=RUNNER_TOKEN scripts/ci/install-paperclip-runner.sh
unset RUNNER_TOKEN
```

Skripti tekee nämä:

- luo järjestelmäkäyttäjän `ghrunner-pc` (koti `/srv/ci/ghrunner-pc`, lukittu salasana, ei ryhmiä)
- lataa actions/runnerin kiinnitetyllä versiolla ja tarkistaa SHA256:n
- rekisteröi runnerin labeleilla `self-hosted, Linux, X64, paperclip-ci`
- kirjoittaa `.env`:iin `NODE_OPTIONS=--max-old-space-size=4096` ja rootless-`DOCKER_HOST`in
- asentaa rootless Dockerin käyttäjän user-sessioon (linger päällä)
- asentaa systemd-unitin `actions.runner.mv50000-paperclip.<nimi>.service` drop-inillä
  `Slice=ci-runners.slice`, `MemoryHigh=6G`, `MemoryMax=7G`, `Restart=on-failure`,
  `OOMPolicy=continue`

Skripti on idempotentti. Uusi ajo ohittaa jo tehdyt vaiheet.

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

`runner_name` on runnerin nimi eikä `GitHub Actions N`. Seuraava master-push todentaa
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

Runnerin poisto hostilta:

```sh
DIR=/srv/ci/actions-runners/<nimi>
sudo bash -c "cd $DIR && ./svc.sh stop && ./svc.sh uninstall"
TOKEN="$(gh api -X POST repos/mv50000/paperclip/actions/runners/remove-token --jq .token)"
sudo runuser -u ghrunner-pc -- bash -c "cd $DIR && ./config.sh remove --token $TOKEN"
```

Hakemisto on 750 ja käyttäjän `ghrunner-pc` oma, joten `cd` onnistuu vain rootina tai
runner-käyttäjänä.

## Tunnetut rajat

- **Yksi slotti.** `verify` ja `e2e` ajavat rinnakkain vain, jos runnereita on kaksi. Yhdellä
  slotilla ne ajavat peräkkäin. PR-checkit hidastuvat, mutta mikään ei kaadu.
- **Runnerin katkos pysäyttää CI:n.** Jobit jäävät jonoon, eikä `ai-auto-merge` merge mitään.
  Ohitus on vivun palautus (`gh variable delete CI_RUNNER`).
- **Playwright ilman sudoa.** Workflow ajaa `playwright install --with-deps` vain, jos
  `sudo -n true` onnistuu. Muuten se asentaa pelkän selaimen, ja kirjastot tulevat hostilta.
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
