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
#
# Käyttö:
#   sudo scripts/ci/install-paperclip-runner.sh --check
#   sudo RUNNER_TOKEN=<rekisteröintitoken> scripts/ci/install-paperclip-runner.sh
#
# Rekisteröintitoken (voimassa 1 h, kertakäyttöinen):
#   gh api -X POST repos/mv50000/paperclip/actions/runners/registration-token --jq .token
#
# Valinnat:
#   --check          aja vain esitarkistukset, älä muuta mitään
#   --name NIMI      runnerin nimi (oletus: <hostname>-paperclip)
#   --user KÄYTTÄJÄ  runnerin käyttäjä (oletus: ghrunner-pc)
#   --labels L       lisälabelit pilkulla eroteltuna (oletus: paperclip-ci)
#   --no-docker      älä asenna rootless Dockeria (docker.yml ja release-smoke eivät
#                    silloin toimi tällä runnerilla)

set -euo pipefail

REPO_URL="https://github.com/mv50000/paperclip"
RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
BASE_DIR="/srv/ci/actions-runners"

RUNNER_USER="ghrunner-pc"
RUNNER_NAME="$(hostname -s)-paperclip"
RUNNER_LABELS="paperclip-ci"
WITH_DOCKER=1
CHECK_ONLY=0

usage() {
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --name) RUNNER_NAME="$2"; shift ;;
    --user) RUNNER_USER="$2"; shift ;;
    --labels) RUNNER_LABELS="$2"; shift ;;
    --no-docker) WITH_DOCKER=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Tuntematon valinta: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

RUNNER_DIR="$BASE_DIR/$RUNNER_NAME"
RUNNER_HOME="/srv/ci/$RUNNER_USER"
UNIT="actions.runner.mv50000-paperclip.${RUNNER_NAME}.service"

fail() { echo "VIRHE: $*" >&2; exit 1; }
warn() { echo "VAROITUS: $*" >&2; }
info() { echo "==> $*"; }

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

  for cmd in curl tar sha256sum systemctl useradd runuser loginctl; do
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
    mkdir -p "$(dirname "$RUNNER_HOME")"
    useradd --system --user-group --create-home --home-dir "$RUNNER_HOME" --shell /bin/bash "$RUNNER_USER"
    passwd -l "$RUNNER_USER" >/dev/null
  fi
  chmod 750 "$RUNNER_HOME"

  # Käyttäjä ei saa kuulua mihinkään etuoikeutettuun ryhmään.
  local groups
  groups="$(id -nG "$RUNNER_USER")"
  for g in sudo admin wheel docker lxd adm paperclip; do
    if printf ' %s ' "$groups" | grep -q " $g "; then
      fail "$RUNNER_USER kuuluu ryhmään '$g'. Poista jäsenyys ennen jatkoa."
    fi
  done
}

# --- Runnerin asennus -----------------------------------------------------

install_runner() {
  mkdir -p "$BASE_DIR"
  if [ -x "$RUNNER_DIR/config.sh" ]; then
    info "Runner-binäärit löytyvät jo: $RUNNER_DIR"
    return
  fi

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

  mkdir -p "$RUNNER_DIR"
  tar xzf "$tmp/$tarball" -C "$RUNNER_DIR"
  rm -rf "$tmp"
  chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
  chmod 750 "$RUNNER_DIR"
}

configure_runner() {
  if [ -f "$RUNNER_DIR/.runner" ]; then
    info "Runneri on jo rekisteröity ($RUNNER_DIR/.runner). Ohitetaan config.sh."
    return
  fi
  [ -n "${RUNNER_TOKEN:-}" ] || fail "RUNNER_TOKEN puuttuu. Hae token: gh api -X POST repos/mv50000/paperclip/actions/runners/registration-token --jq .token"

  info "Rekisteröidään runneri $RUNNER_NAME repolle $REPO_URL."
  # Token välitetään ympäristömuuttujana, ei komentoriviargumenttina (ps-näkyvyys).
  # shellcheck disable=SC2016 # argumentit laajenevat tarkoituksella vasta alikuoressa
  ACTIONS_RUNNER_INPUT_TOKEN="$RUNNER_TOKEN" runuser -u "$RUNNER_USER" -- \
    bash -c 'cd "$1" && ./config.sh --unattended --url "$2" --name "$3" --labels "$4" --work _work --replace' \
    _ "$RUNNER_DIR" "$REPO_URL" "$RUNNER_NAME" "$RUNNER_LABELS"
  unset RUNNER_TOKEN
}

write_runner_env() {
  local uid env_file
  uid="$(id -u "$RUNNER_USER")"
  env_file="$RUNNER_DIR/.env"
  info "Kirjoitetaan $env_file."
  {
    echo "LANG=C.UTF-8"
    # Node mitoittaa heapin VM:n muistista, ei slotin cgroup-rajasta (policy-note, 4.8.2026).
    echo "NODE_OPTIONS=--max-old-space-size=4096"
    if [ "$WITH_DOCKER" -eq 1 ]; then
      echo "DOCKER_HOST=unix:///run/user/${uid}/docker.sock"
    fi
  } >"$env_file"
  chown "$RUNNER_USER:$RUNNER_USER" "$env_file"
  chmod 640 "$env_file"
}

# --- Rootless Docker ------------------------------------------------------

next_subid_start() {
  # Ensimmäinen vapaa alue kaikkien olemassa olevien subuid/subgid-alueiden jälkeen.
  awk -F: 'BEGIN { max = 100000 } { end = $2 + $3; if (end > max) max = end } END { print max }' \
    /etc/subuid /etc/subgid 2>/dev/null
}

setup_rootless_docker() {
  [ "$WITH_DOCKER" -eq 1 ] || return 0
  local uid start
  uid="$(id -u "$RUNNER_USER")"

  if ! grep -q "^${RUNNER_USER}:" /etc/subuid 2>/dev/null || ! grep -q "^${RUNNER_USER}:" /etc/subgid 2>/dev/null; then
    start="$(next_subid_start)"
    info "Varataan subuid/subgid-alue ${start}-$((start + 65535)) käyttäjälle $RUNNER_USER."
    usermod --add-subuids "${start}-$((start + 65535))" --add-subgids "${start}-$((start + 65535))" "$RUNNER_USER"
  fi

  loginctl enable-linger "$RUNNER_USER"
  systemctl start "user@${uid}.service"

  if [ ! -S "/run/user/${uid}/docker.sock" ]; then
    info "Asennetaan rootless Docker käyttäjälle $RUNNER_USER."
    runuser -u "$RUNNER_USER" -- env \
      XDG_RUNTIME_DIR="/run/user/${uid}" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
      HOME="$RUNNER_HOME" \
      dockerd-rootless-setuptool.sh install
  fi
  runuser -u "$RUNNER_USER" -- env XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    systemctl --user enable --now docker.service
}

# --- systemd-palvelu ------------------------------------------------------

install_service() {
  if ! systemctl cat "$UNIT" >/dev/null 2>&1; then
    info "Asennetaan palvelu $UNIT."
    (cd "$RUNNER_DIR" && ./svc.sh install "$RUNNER_USER")
  fi

  local dropin="/etc/systemd/system/${UNIT}.d"
  mkdir -p "$dropin"
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
  } >"$dropin/override.conf"

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
    runuser -u "$RUNNER_USER" -- env DOCKER_HOST="unix:///run/user/${uid}/docker.sock" docker info --format '{{.SecurityOptions}}' \
      | grep -q rootless || fail "rootless Docker ei vastaa käyttäjälle $RUNNER_USER."
    info "Rootless Docker vastaa."
  fi
  cat <<EOF

Seuraavaksi (doc/CI-RUNNER.md, vaiheet 3-5):
  gh api repos/mv50000/paperclip/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'
  gh variable set CI_RUNNER -R mv50000/paperclip --body '["self-hosted","${RUNNER_LABELS%%,*}"]'
EOF
}

preflight
if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi
ensure_user
install_runner
configure_runner
write_runner_env
setup_rootless_docker
install_service
verify
