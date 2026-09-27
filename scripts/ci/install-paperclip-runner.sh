#!/usr/bin/env bash
# install-paperclip-runner.sh — asenna repo-tason GitHub Actions -runneri
# repolle mv50000/paperclip (RK9-350).
#
# Operaattori ajaa tämän rootina kohdehostilla (suositus: builder-02). Skripti
# ei koske GitHubin asetuksiin eikä repo-muuttujiin. Ne tehdään erikseen
# doc/CI-RUNNER.md:n mukaan.
#
# Malli on sama kuin org-runnereilla (RK9-200, RK9-216):
#   - oma järjestelmäkäyttäjä ilman sudoa ja ilman docker-ryhmää
#   - runner hakemistossa /srv/ci/actions-runners/<nimi> (750)
#   - systemd-unit ci-runners.slicessa, Restart=on-failure, OOMPolicy=continue
#   - Docker on rootless Docker käyttäjän omassa user-sessiossa
#
# Käyttäjä on eri kuin org-runnerien ghrunner. Repo on julkinen, joten tämän
# runnerin jobi ei saa päästä käsiksi org-runnerien hakemistoihin ja cacheihin.
# Root-omisteinen job-started-hook tappaa jobin, jonka koodi ei tule
# repositoriosta mv50000/paperclip itsestään (fork-PR:t).
#
# Root ei aja eikä kirjoita mitään runner-hakemistossa sen jälkeen, kun runneri on
# asennettu: hakemisto on runner-käyttäjän kirjoitettavissa.
#
# Käyttö:
#   sudo scripts/ci/install-paperclip-runner.sh --check
#   sudo --preserve-env=RUNNER_TOKEN scripts/ci/install-paperclip-runner.sh
#
# Rekisteröintitoken (voimassa 1 h, kertakäyttöinen) haetaan vasta, kun fork-PR:ien
# hyväksyntä on all_external_contributors (doc/CI-RUNNER.md, vaiheet 1 ja 3).
#
# Valinnat:
#   --check          aja vain esitarkistukset, älä muuta mitään
#   --name NIMI      runnerin nimi (oletus: <hostname>-paperclip)
#   --user KÄYTTÄJÄ  runnerin käyttäjä (oletus: ghrunner-pc)
#   --labels L       lisälabelit pilkulla eroteltuna (oletus: paperclip-ci)
#   --no-docker      älä asenna rootless Dockeria (docker.yml ja release-smoke eivät
#                    silloin toimi tällä runnerilla)

set -euo pipefail

REPO="mv50000/paperclip"
REPO_URL="https://github.com/$REPO"
RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
BASE_DIR="/srv/ci/actions-runners"
HOOK_DIR="/usr/local/lib/paperclip-runner"
HOOK="$HOOK_DIR/job-started.sh"

RUNNER_USER="ghrunner-pc"
RUNNER_NAME="$(hostname -s)-paperclip"
RUNNER_LABELS="paperclip-ci"
WITH_DOCKER=1
CHECK_ONLY=0

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --name) RUNNER_NAME="${2:?--name vaatii arvon}"; shift ;;
    --user) RUNNER_USER="${2:?--user vaatii arvon}"; shift ;;
    --labels) RUNNER_LABELS="${2:?--labels vaatii arvon}"; shift ;;
    --no-docker) WITH_DOCKER=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Tuntematon valinta: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Token talteen viemättömään muuttujaan: runner-käyttäjänä ajettavat komennot
# eivät saa periä sitä ympäristöstä.
TOKEN="${RUNNER_TOKEN:-}"
unset RUNNER_TOKEN

fail() { echo "VIRHE: $*" >&2; exit 1; }
warn() { echo "VAROITUS: $*" >&2; }
info() { echo "==> $*"; }

# Luo root-omisteinen hakemisto vain, jos sitä ei ole. install -d muuttaisi myös
# olemassa olevan hakemiston omistajan ja oikeudet (org-runnerit asuvat samassa puussa).
ensure_root_dir() {
  if [ ! -d "$1" ]; then
    install -d -o root -g root -m 755 "$1"
    return
  fi
  # Olemassa olevan hakemiston pitää olla rootin ja muiden kirjoituskelvoton, muuten
  # joku muu käyttäjä voisi vaihtaa sen alle symlinkin ennen rootin kirjoitusta.
  local owner mode
  owner="$(stat -c %U "$1")"; mode="$(stat -c %a "$1")"
  if [ "$owner" != "root" ] || [ $(( 8#$mode & 8#022 )) -ne 0 ]; then
    fail "$1 on $owner:$mode. Vaaditaan root-omistus ilman ryhmän ja muiden kirjoitusoikeutta."
  fi
}

# Arvot päätyvät polkuihin ja unit-nimeen, joten sallitaan vain turvalliset merkit.
[[ "$RUNNER_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$ ]] || fail "--name: sallittu [A-Za-z0-9._-], enintään 40 merkkiä."
[[ "$RUNNER_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "--user: virheellinen käyttäjänimi."
[[ "$RUNNER_LABELS" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || fail "--labels: sallittu [A-Za-z0-9._-] pilkulla eroteltuna."

RUNNER_DIR="$BASE_DIR/$RUNNER_NAME"
RUNNER_HOME="/srv/ci/$RUNNER_USER"
UNIT="actions.runner.mv50000-paperclip.${RUNNER_NAME}.service"

# Aja komento runner-käyttäjänä. runuser säilyttää kutsujan ympäristön
# (paitsi HOME, SHELL, USER ja LOGNAME). Stdin ei ole rootin pääte.
as_runner() {
  runuser -u "$RUNNER_USER" -- "$@" </dev/null
}

# --- Esitarkistukset -------------------------------------------------------

preflight() {
  local missing=()

  [ "$(id -u)" -eq 0 ] || fail "aja rootina (sudo)."

  # CONSTITUTION.md: ei CI-buildeja paperclip-01:lle (prod ajaa samassa CT:ssä).
  if [ "$(hostname -s)" = "paperclip-01" ] || systemctl cat paperclip.service >/dev/null 2>&1; then
    fail "tällä hostilla ajaa Paperclip-prod. Asenna runneri build-hostille (esim. builder-02)."
  fi

  case "$RUNNER_USER" in
    root|rk9admin|paperclip|ghrunner) fail "käyttäjä '$RUNNER_USER' ei kelpaa: käytä omaa runner-käyttäjää." ;;
  esac

  for cmd in curl tar sha256sum jq pkill systemctl useradd usermod runuser loginctl install; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if [ "$WITH_DOCKER" -eq 1 ]; then
    for cmd in docker dockerd-rootless-setuptool.sh newuidmap newgidmap slirp4netns; do
      command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    fail "puuttuvat komennot: ${missing[*]}. Rootless Docker: apt install uidmap slirp4netns docker-ce-rootless-extras."
  fi

  if [ -e "$RUNNER_DIR" ] && [ ! -f "$RUNNER_DIR/.runner" ]; then
    fail "$RUNNER_DIR on olemassa, mutta runneria ei ole rekisteröity. Poista keskeneräinen hakemisto: rm -rf $RUNNER_DIR"
  fi

  if ! systemctl cat ci-runners.slice >/dev/null 2>&1; then
    warn "ci-runners.slice puuttuu. Runneri ajaa ilman yhteistä muistikattoa."
  fi

  # docker.yml rakentaa myös linux/arm64-imagen, joka vaatii QEMU-binfmt:n.
  if [ "$WITH_DOCKER" -eq 1 ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
    warn "qemu-aarch64-binfmt puuttuu: docker.yml:n arm64-build kaatuu. Korjaus: apt install qemu-user-static binfmt-support."
  fi

  # Playwrightin järjestelmäkirjastot. Runner-käyttäjällä ei ole sudoa, joten
  # workflow ajaa 'playwright install' ilman --with-deps.
  if ! ldconfig -p 2>/dev/null | grep -q 'libnss3\.so'; then
    warn "Chromiumin kirjastot puuttuvat. Korjaus rootina: npx -y playwright install-deps chromium."
  fi

  info "Esitarkistukset ok (käyttäjä=$RUNNER_USER, nimi=$RUNNER_NAME, labelit=$RUNNER_LABELS, docker=$WITH_DOCKER)."
}

# --- Käyttäjä ---------------------------------------------------------------

ensure_user() {
  if ! id "$RUNNER_USER" >/dev/null 2>&1; then
    info "Luodaan järjestelmäkäyttäjä $RUNNER_USER (koti $RUNNER_HOME)."
    ensure_root_dir "$(dirname "$RUNNER_HOME")"
    useradd --system --user-group --create-home --home-dir "$RUNNER_HOME" --shell /bin/bash "$RUNNER_USER"
    passwd -l "$RUNNER_USER" >/dev/null
    chmod 750 "$RUNNER_HOME"
  fi

  # Käyttäjä ei saa kuulua mihinkään etuoikeutettuun ryhmään.
  local groups
  groups="$(id -nG "$RUNNER_USER")"
  for g in sudo admin wheel docker lxd adm paperclip; do
    if printf ' %s ' "$groups" | grep -q " $g "; then
      fail "$RUNNER_USER kuuluu ryhmään '$g'. Poista jäsenyys ennen jatkoa."
    fi
  done

  # Org-runnerien (ghrunner) koti ja cachet eivät saa olla tämän käyttäjän
  # kirjoitettavissa. Luettavuus on varoitus: vain saman repon koodi ajaa täällä.
  local p
  for p in /srv/ci/ghrunner /opt/cache/*; do
    [ -e "$p" ] || continue
    if as_runner test -w "$p"; then
      fail "$RUNNER_USER voi kirjoittaa polkuun $p. Korjaa oikeudet ennen jatkoa."
    elif as_runner test -r "$p" -a -x "$p"; then
      warn "$RUNNER_USER voi lukea polun $p (org-runnerien cache)."
    fi
  done
}

# --- Job-started-hook ------------------------------------------------------

# Hook on root-omisteinen ja runner-hakemiston ulkopuolella, joten jobi ei voi
# muuttaa sitä. Runneri ajaa sen ennen jobin ensimmäistä askelta. Hylätessään
# hook tappaa jobin Runner.Worker-prosessin, joten jobin askeleet eivät aja.
install_hook() {
  info "Asennetaan job-started-hook $HOOK."
  ensure_root_dir "$HOOK_DIR"
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
#!/usr/bin/env bash
# Asentanut scripts/ci/install-paperclip-runner.sh (RK9-350). Älä muokkaa käsin.
# Hylkää jobin, jonka koodi ei tule repositoriosta $REPO itsestään.
set -uo pipefail
expected="$REPO"

reject() {
  echo "::error::\$1 Ks. doc/CI-RUNNER.md."
  # Nollasta poikkeava paluuarvo ei yksin riitä: runneri ajaa silti askeleet,
  # joiden ehto on always() tai failure(). Runnerilla on yksi slotti, joten
  # tämän käyttäjän ainoa Runner.Worker on tämä jobi. Tapetaan se.
  # Varalla: hook on Runner.Workerin suora lapsiprosessi.
  pkill -KILL -x -u "\$(id -u)" Runner.Worker || kill -KILL "\$PPID"
  exit 1
}

if [ "\${GITHUB_REPOSITORY:-}" != "\$expected" ]; then
  reject "Runneri palvelee vain repoa \$expected (saatiin '\${GITHUB_REPOSITORY:-}')."
fi
case "\${GITHUB_EVENT_NAME:-}" in
  push|workflow_dispatch|workflow_run|schedule)
    exit 0
    ;;
  pull_request)
    head="\$(jq -r '.pull_request.head.repo.full_name // ""' "\${GITHUB_EVENT_PATH:-/nonexistent}" 2>/dev/null)"
    if [ "\$head" = "\$expected" ]; then
      exit 0
    fi
    reject "Fork-PR ('\$head') ei saa ajaa self-hosted-runnerilla."
    ;;
  *)
    reject "Tapahtumaa '\${GITHUB_EVENT_NAME:-}' ei sallita self-hosted-runnerilla."
    ;;
esac
EOF
  install -o root -g root -m 755 "$tmp" "$HOOK"
  rm -f "$tmp"
}

# --- Runnerin asennus -----------------------------------------------------

install_runner() {
  if [ -f "$RUNNER_DIR/.runner" ]; then
    info "Runneri on jo asennettu ja rekisteröity: $RUNNER_DIR"
    TOKEN=""
    return
  fi
  [ -n "$TOKEN" ] || fail "RUNNER_TOKEN puuttuu. Hae token: gh api -X POST repos/$REPO/actions/runners/registration-token --jq .token"

  local tarball tmp
  tarball="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  tmp="$(mktemp -d)"

  info "Ladataan $tarball."
  curl -fsSL -o "$tmp/$tarball" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${tarball}"
  if ! echo "${RUNNER_SHA256}  $tmp/$tarball" | sha256sum -c - >/dev/null; then
    rm -rf "$tmp"
    fail "tarkistussumma ei täsmää: $tarball."
  fi

  # Hakemisto luodaan tyhjänä (esitarkistus hylkää keskeneräisen), joten root
  # purkaa paketin hakemistoon, jota jobi ei ole vielä koskaan nähnyt.
  ensure_root_dir "$BASE_DIR"
  install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 750 "$RUNNER_DIR"
  chmod 644 "$tmp/$tarball"
  chmod 711 "$tmp"
  as_runner tar xzf "$tmp/$tarball" -C "$RUNNER_DIR"
  rm -rf "$tmp"
  # svc.sh kopioisi tämän; skripti kirjoittaa unitin itse (ks. install_service).
  as_runner cp "$RUNNER_DIR/bin/runsvc.sh" "$RUNNER_DIR/runsvc.sh"

  info "Rekisteröidään runneri $RUNNER_NAME repolle $REPO_URL."
  # Token välitetään ympäristömuuttujana, ei komentoriviargumenttina (ps-näkyvyys).
  # shellcheck disable=SC2016 # argumentit laajenevat tarkoituksella vasta alikuoressa
  ACTIONS_RUNNER_INPUT_TOKEN="$TOKEN" as_runner \
    bash -c 'cd "$1" && ./config.sh --unattended --url "$2" --name "$3" --labels "$4" --work _work --replace' \
    _ "$RUNNER_DIR" "$REPO_URL" "$RUNNER_NAME" "$RUNNER_LABELS"
  TOKEN=""

}

# .env kirjoitetaan runner-käyttäjänä: root ei kirjoita käyttäjän hakemistoon
# (symlinkki voisi ohjata kirjoituksen minne tahansa).
write_runner_env() {
  local uid docker_host=""
  uid="$(id -u "$RUNNER_USER")"
  if [ "$WITH_DOCKER" -eq 1 ]; then
    docker_host="unix:///run/user/${uid}/docker.sock"
  fi
  info "Päivitetään $RUNNER_DIR/.env (runner-käyttäjänä)."
  # shellcheck disable=SC2016 # argumentit laajenevat tarkoituksella vasta alikuoressa
  as_runner bash -c '
    set -euo pipefail
    env_file="$1/.env"; hook="$2"; docker_host="$3"
    keys="ACTIONS_RUNNER_HOOK_JOB_STARTED|NODE_OPTIONS|DOCKER_HOST|PAPERCLIP_CI_NO_SUDO"
    tmp="$(mktemp "$1/.env.XXXXXX")"
    if [ -f "$env_file" ]; then
      grep -Ev "^($keys)=" "$env_file" >"$tmp" || true
    fi
    {
      echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook"
      # Node mitoittaa heapin VM:n muistista, ei slotin cgroup-rajasta (policy-note, 4.8.2026).
      echo "NODE_OPTIONS=--max-old-space-size=4096"
      # Workflow ohittaa playwright --with-deps -asennuksen (vaatisi sudon).
      echo "PAPERCLIP_CI_NO_SUDO=1"
      if [ -n "$docker_host" ]; then echo "DOCKER_HOST=$docker_host"; fi
    } >>"$tmp"
    chmod 640 "$tmp"
    mv -f "$tmp" "$env_file"
  ' _ "$RUNNER_DIR" "$HOOK" "$docker_host"
}

# --- Rootless Docker ------------------------------------------------------

next_subid_start() {
  # Ensimmäinen vapaa alue kaikkien olemassa olevien subuid/subgid-alueiden jälkeen.
  local files=()
  [ -f /etc/subuid ] && files+=(/etc/subuid)
  [ -f /etc/subgid ] && files+=(/etc/subgid)
  if [ ${#files[@]} -eq 0 ]; then
    echo 100000
    return
  fi
  awk -F: 'BEGIN { max = 100000 } { end = $2 + $3; if (end > max) max = end } END { print max }' "${files[@]}"
}

setup_rootless_docker() {
  [ "$WITH_DOCKER" -eq 1 ] || return 0
  local uid start range
  uid="$(id -u "$RUNNER_USER")"

  if ! grep -qs "^${RUNNER_USER}:" /etc/subuid; then
    start="$(next_subid_start)"; range="${start}-$((start + 65535))"
    info "Varataan subuid-alue $range käyttäjälle $RUNNER_USER."
    usermod --add-subuids "$range" "$RUNNER_USER"
  fi
  if ! grep -qs "^${RUNNER_USER}:" /etc/subgid; then
    start="$(next_subid_start)"; range="${start}-$((start + 65535))"
    info "Varataan subgid-alue $range käyttäjälle $RUNNER_USER."
    usermod --add-subgids "$range" "$RUNNER_USER"
  fi

  # Rootless dockerd ja kontit ajavat user@<uid>.servicessä, eivät runner-unitissa.
  # Ilman omaa kattoa ne ohittaisivat ci-runners.slicen ja runner-unitin MemoryMaxin.
  local slice_dropin="/etc/systemd/system/user-${uid}.slice.d"
  ensure_root_dir "$slice_dropin"
  printf '[Slice]\nMemoryHigh=5G\nMemoryMax=6G\nCPUWeight=20\n' >"$slice_dropin/override.conf"
  chmod 644 "$slice_dropin/override.conf"
  systemctl daemon-reload

  loginctl enable-linger "$RUNNER_USER"
  systemctl start "user@${uid}.service"

  local user_env=(env XDG_RUNTIME_DIR="/run/user/${uid}"
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" HOME="$RUNNER_HOME")
  if [ ! -S "/run/user/${uid}/docker.sock" ]; then
    info "Asennetaan rootless Docker käyttäjälle $RUNNER_USER."
    as_runner "${user_env[@]}" dockerd-rootless-setuptool.sh install
  fi
  as_runner "${user_env[@]}" systemctl --user enable --now docker.service
}

# --- systemd-palvelu ------------------------------------------------------

# Unit kirjoitetaan suoraan eikä svc.sh:lla: svc.sh on runner-hakemistossa, jota
# jobi voi muokata, joten rootin ei pidä ajaa sitä.
install_service() {
  local unit_file="/etc/systemd/system/$UNIT" dropin="/etc/systemd/system/${UNIT}.d" tmp
  info "Kirjoitetaan $unit_file."
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
[Unit]
Description=GitHub Actions Runner ($REPO.$RUNNER_NAME)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$RUNNER_DIR/runsvc.sh
User=$RUNNER_USER
WorkingDirectory=$RUNNER_DIR
# mixed: SIGTERM runnerille, pysäytyksen lopuksi SIGKILL kaikille unitin prosesseille.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
EOF
  install -o root -g root -m 644 "$tmp" "$unit_file"

  {
    echo "[Service]"
    if systemctl cat ci-runners.slice >/dev/null 2>&1; then
      echo "Slice=ci-runners.slice"
    fi
    echo "Nice=10"
    echo "MemoryHigh=6G"
    echo "MemoryMax=7G"
    echo "Restart=on-failure"
    echo "RestartSec=60"
    # Yhden prosessin OOM-kill ei saa pysäyttää koko runner-palvelua (RK9-216).
    echo "OOMPolicy=continue"
  } >"$tmp"
  install -d -o root -g root -m 755 "$dropin"
  install -o root -g root -m 644 "$tmp" "$dropin/override.conf"
  rm -f "$tmp"

  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null
  systemctl restart "$UNIT"
}

verify() {
  sleep 3
  systemctl is-active --quiet "$UNIT" || fail "$UNIT ei ole käynnissä. Katso: journalctl -u $UNIT -n 50"
  info "Palvelu $UNIT on käynnissä."
  if [ "$WITH_DOCKER" -eq 1 ]; then
    local uid
    uid="$(id -u "$RUNNER_USER")"
    as_runner env DOCKER_HOST="unix:///run/user/${uid}/docker.sock" docker info --format '{{.SecurityOptions}}' \
      | grep -q rootless || fail "rootless Docker ei vastaa käyttäjälle $RUNNER_USER."
    info "Rootless Docker vastaa."
  fi
  cat <<EOF

Seuraavaksi (doc/CI-RUNNER.md, vaiheet 4-6):
  gh api repos/$REPO/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
  gh variable set CI_RUNNER -R $REPO --body '["self-hosted","${RUNNER_LABELS%%,*}"]'
EOF
}

preflight
if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi
ensure_user
install_hook
install_runner
write_runner_env
setup_rootless_docker
install_service
verify
