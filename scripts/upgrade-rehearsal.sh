#!/usr/bin/env bash
# upgrade-rehearsal.sh — harjoitusinstanssi upstream-päivityksen portaille (RK9-306).
#
# Ottaa prod-kannasta dumpin, palauttaa sen kantaan paperclip_rehearsal, checkouttaa
# refin omaan worktreehen ja käynnistää palvelimen verkkonimiavaruudessa, jossa on vain
# loopback. Tuotantoon ei kirjoiteta, eikä paperclip.serviceä kosketa.
#
# Eristys (operaattorin päätös 2026-09-26, ensisijaisesti verkkotaso):
#   1. Palvelin ajetaan `unshare -rn` -nimiavaruudessa: ei reittiä ulos, ei DNS:ää.
#      Ulos lähtevä SES/Resend/Slack/GitHub/outreach epäonnistuu jo yhteyden avauksessa.
#   2. Kantayhteys kulkee unix-socketin kautta (tiedostopolku, ei kuulu verkkonimiavaruuteen).
#   3. Palvelimen env rakennetaan `env -i`:llä allowlististä: ei ses.env:iä, ei tokeneita,
#      ei PAPERCLIP_SECRETS_*-muuttujia. Oma PAPERCLIP_HOME, joten master.key on uusi
#      eikä kantaan tallennettuja salaisuuksia voi purkaa.
#   4. Ajastimet pois olemassa olevilla lipuilla (HEARTBEAT_SCHEDULER_ENABLED=false,
#      OUTREACH_*_ENABLED=false ym.). Koodiin ei lisätty gatea: verkkotaso kattaa loput.
#   5. Skripti kieltäytyy jatkamasta (fail closed), jos egress-koetin pääsee ulos, nimiavaruudessa
#      on muu kuin lo tai palvelimen env sisältää salaisuudennäköisen muuttujan.
#
# Käyttö:
#   scripts/upgrade-rehearsal.sh <git-ref>     koko putki: dump → restore → worktree → install → palvelin
#   scripts/upgrade-rehearsal.sh smoke [args]  aja upgrade-smoke.sh instanssia vasten (nsenterillä)
#   scripts/upgrade-rehearsal.sh rollback      tyhjä kanta + pg_restore --clean dumpista + git reset pre-SHA:han
#   scripts/upgrade-rehearsal.sh status        näytä tila
#   scripts/upgrade-rehearsal.sh stop          pysäytä palvelin ja nimiavaruus
#
# Ajo tällä koneella: kanta hyväksyy socketissa vain peer-tunnistuksen, joten aja
# palvelun käyttäjänä:  sudo -u paperclip scripts/upgrade-rehearsal.sh <git-ref>
# Kertaluonteinen valmistelu (root):  install -d -o paperclip -m 700 /var/backups/paperclip
#   ja paperclip-roolilla on oltava CREATEDB (tai luo paperclip_rehearsal valmiiksi sen omistajaksi).
#
# Ympäristömuuttujat (oletus):
#   REHEARSAL_PROD_DB=paperclip  REHEARSAL_DB=paperclip_rehearsal  REHEARSAL_PORT=3199
#   REHEARSAL_PG_SOCKET_DIR=/var/run/postgresql  REHEARSAL_PG_USER=paperclip
#   REHEARSAL_HOME=$HOME/.paperclip-rehearsal    REHEARSAL_BACKUP_DIR=/var/backups/paperclip
#   REHEARSAL_WORKTREE=/tmp/paperclip-worktrees/RK9/rehearsal   REHEARSAL_KEEP_DUMPS=5
#   REHEARSAL_MIN_FREE_FACTOR=3   vapaata levyä vähintään näin monta kertaa kannan koko
# Testisaumat: REHEARSAL_INSTALL_CMD, REHEARSAL_SERVER_CMD.
#
# Poistumiskoodi: 0 = ok, 1 = virhe tai eristystarkistus epäonnistui, 2 = käyttövirhe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROD_DB="${REHEARSAL_PROD_DB:-paperclip}"
REH_DB="${REHEARSAL_DB:-paperclip_rehearsal}"
PORT="${REHEARSAL_PORT:-3199}"
SOCKET_DIR="${REHEARSAL_PG_SOCKET_DIR:-/var/run/postgresql}"
PG_USER="${REHEARSAL_PG_USER:-paperclip}"
REH_HOME="${REHEARSAL_HOME:-${HOME:-/tmp}/.paperclip-rehearsal}"
BACKUP_DIR="${REHEARSAL_BACKUP_DIR:-/var/backups/paperclip}"
WORKTREE="${REHEARSAL_WORKTREE:-/tmp/paperclip-worktrees/RK9/rehearsal}"
KEEP_DUMPS="${REHEARSAL_KEEP_DUMPS:-5}"
FREE_FACTOR="${REHEARSAL_MIN_FREE_FACTOR:-3}"
INSTALL_CMD="${REHEARSAL_INSTALL_CMD:-pnpm install --frozen-lockfile}"
SERVER_CMD="${REHEARSAL_SERVER_CMD:-pnpm --filter @paperclipai/server exec tsx src/index.ts}"

STATE_FILE="$REH_HOME/rehearsal-state.env"
HOLDER_PID_FILE="$REH_HOME/netns-holder.pid"
SERVER_PID_FILE="$REH_HOME/server.pid"
SERVER_LOG="$REH_HOME/server.log"

# Taulut, joiden rivimäärät vertaillaan rollbackissa ja joista etsitään ulos lähteneet rivit.
OUTBOUND_TABLES=(email_messages email_outbound_audit outreach_messages outreach_events outreach_sender_pauses)
KEY_TABLES=(companies agents issues heartbeat_runs activity_log "${OUTBOUND_TABLES[@]}")

die()  { printf 'VIRHE: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,45p' "$0"; exit 2; }
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

export PGHOST="$SOCKET_DIR" PGUSER="$PG_USER"

# --- Vartijat -------------------------------------------------------------------------------

guard_names() {
  [[ "$REH_DB" =~ ^paperclip_rehearsal(_[a-z0-9]+)?$ ]] || die "REHEARSAL_DB '$REH_DB' ei täytä muotoa paperclip_rehearsal[_x]"
  [[ "$REH_DB" != "$PROD_DB" ]] || die "harjoituskanta ja prod-kanta ovat sama: $REH_DB"
  [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ne 3100 && "$PORT" -gt 1024 ]] || die "portti $PORT ei kelpaa (ei 3100, > 1024)"
  [[ "$SOCKET_DIR" == /* ]] || die "REHEARSAL_PG_SOCKET_DIR pitää olla absoluuttinen polku (unix socket)"
  local real_home prod_home
  real_home="$(realpath -m "$REH_HOME")"
  for prod_home in "${PAPERCLIP_HOME:-}" "${HOME:-/nonexistent}/.paperclip" /var/lib/paperclip/.paperclip; do
    [[ -z "$prod_home" ]] && continue
    prod_home="$(realpath -m "$prod_home")"
    if [[ "$real_home" == "$prod_home" || "$real_home" == "$prod_home"/* || "$prod_home" == "$real_home"/* ]]; then
      die "REHEARSAL_HOME ($real_home) osuu prodin PAPERCLIP_HOMEen ($prod_home)"
    fi
  done
  local real_wt
  real_wt="$(realpath -m "$WORKTREE")"
  [[ "$real_wt" == /tmp/paperclip-worktrees/* ]] || die "REHEARSAL_WORKTREE pitää olla /tmp/paperclip-worktrees/ alla (nyt $real_wt)"
  [[ "$real_wt" != "$(realpath -m "$REPO_ROOT")" ]] || die "REHEARSAL_WORKTREE on sama kuin tämä repo"
}

psql_q() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }

# --- Nimiavaruus ----------------------------------------------------------------------------

holder_alive() { [[ -s "$HOLDER_PID_FILE" ]] && kill -0 "$(cat "$HOLDER_PID_FILE")" 2>/dev/null; }

# ns_exec CMD... — aja komento harjoitusnimiavaruudessa (käyttäjä+verkko).
ns_exec() {
  holder_alive || die "nimiavaruutta ei ole käynnissä (aja ensin: $0 <git-ref>)"
  nsenter -t "$(cat "$HOLDER_PID_FILE")" -U -n --preserve-credentials -- "$@"
}

start_netns() {
  command -v unshare >/dev/null && command -v nsenter >/dev/null || die "unshare/nsenter puuttuu"
  if holder_alive; then return; fi
  # Holder pitää nimiavaruuden elossa. lo nostetaan ylös, muuta liitäntää ei ole.
  setsid unshare -r -n bash -c 'ip link set lo up && exec sleep infinity' >/dev/null 2>&1 &
  echo $! >"$HOLDER_PID_FILE"
  local i
  for i in $(seq 1 20); do
    if ns_exec ip -o link show lo 2>/dev/null | grep -q 'UP\|UNKNOWN'; then return; fi
    sleep 0.25
  done
  die "verkkonimiavaruus ei käynnistynyt. Jos unshare -rn on estetty (kernel.unprivileged_userns_clone=0 / apparmor), aja operaattorina: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0"
}

# Fail closed: todista eristys ennen kuin palvelin käynnistetään ja sen jälkeen.
verify_isolation() {
  local links probe
  links="$(ns_exec ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1 | sort | tr '\n' ' ')"
  [[ "$links" == "lo " ]] || die "eristys: nimiavaruudessa on muita liitäntöjä kuin lo: $links"
  if ns_exec ip -o route show | grep -q .; then die "eristys: nimiavaruudessa on reittejä"; fi
  for probe in 1.1.1.1:443 8.8.8.8:53 169.254.169.254:80; do
    if ns_exec timeout 3 bash -c "exec 3<>/dev/tcp/${probe%:*}/${probe#*:}" 2>/dev/null; then
      die "eristys: egress-koetin pääsi ulos ($probe)"
    fi
  done
  # Nimi voi resolvoitua host-resolverin unix-socketin kautta, mutta yhteys ei saa avautua.
  for probe in email.eu-north-1.amazonaws.com:443 api.resend.com:443 slack.com:443 api.github.com:443; do
    if ns_exec timeout 5 bash -c "exec 3<>/dev/tcp/${probe%:*}/${probe#*:}" 2>/dev/null; then
      die "eristys: yhteys ulkoiseen palveluun avautui ($probe)"
    fi
  done
  log "eristys ok: vain lo, ei reittejä, egress-koettimet (1.1.1.1, 8.8.8.8, metadata, SES, Resend, Slack, GitHub) estetty"
}

# Palvelimen env ei saa sisältää salaisuudennäköisiä muuttujia (paitsi kantayhteys).
verify_server_env() {
  local pid="$1" bad
  bad="$(tr '\0' '\n' <"/proc/$pid/environ" | cut -d= -f1 \
    | grep -E -i '(SES|RESEND|SLACK|GITHUB|TELEGRAM|ANTHROPIC|OPENAI|TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE|AWS_)' \
    | grep -v -E '^(PAPERCLIP_HOME)$' || true)"
  [[ -z "$bad" ]] || die "eristys: palvelimen env sisältää salaisuudennäköisiä muuttujia: $(echo "$bad" | tr '\n' ' ')"
  log "palvelimen env ok: ei salaisuusmuuttujia"
}

# --- Kanta ----------------------------------------------------------------------------------

table_counts() { # db → "taulu=n" riveittäin; puuttuva taulu = -1
  local db="$1" t n
  for t in "${KEY_TABLES[@]}"; do
    n="$(psql_q -d "$db" -c "select count(*) from \"$t\"" 2>/dev/null || echo -1)"
    echo "$t=$n"
  done
  # Skeema: portti voi lisätä tauluja ja sarakkeita, joita --clean yksin ei poista.
  echo "_public_tables=$(psql_q -d "$db" -c "select count(*) from information_schema.tables where table_schema='public'")"
  echo "_public_columns=$(psql_q -d "$db" -c "select count(*) from information_schema.columns where table_schema='public'")"
}

check_disk_and_retention() {
  mkdir -p "$BACKUP_DIR" 2>/dev/null || die "en voi luoda $BACKUP_DIR. Operaattori: sudo install -d -o $(id -un) -m 700 $BACKUP_DIR"
  [[ -w "$BACKUP_DIR" ]] || die "$BACKUP_DIR ei ole kirjoitettava käyttäjälle $(id -un). Operaattori: sudo chown $(id -un) $BACKUP_DIR"
  local db_bytes avail_kb need_kb
  db_bytes="$(psql_q -d "$PROD_DB" -c "select pg_database_size('$PROD_DB')")"
  avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2{print $4}')"
  need_kb=$(( db_bytes / 1024 * FREE_FACTOR ))
  log "kanta $PROD_DB $(( db_bytes / 1048576 )) MiB, levyä vapaana $(( avail_kb / 1024 )) MiB (vaatimus $(( need_kb / 1024 )) MiB)"
  (( avail_kb >= need_kb )) || die "levytila ei riitä: vapaana $(( avail_kb / 1024 )) MiB, tarvitaan $(( need_kb / 1024 )) MiB"
}

prune_dumps() {
  local n=0 f
  while IFS= read -r f; do
    n=$((n + 1))
    if (( n > KEEP_DUMPS )); then rm -f -- "$f"; log "retention: poistettu $f"; fi
  done < <(ls -1t "$BACKUP_DIR"/rehearsal-*.dump 2>/dev/null)
  log "retention: säilytetään $KEEP_DUMPS viimeisintä rehearsal-dumppia (${BACKUP_DIR})"
}

recreate_reh_db() {
  guard_names
  psql_q -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$REH_DB' and pid<>pg_backend_pid()" >/dev/null 2>&1 || true
  dropdb --if-exists "$REH_DB"
  createdb "$REH_DB" || die "createdb $REH_DB epäonnistui: paperclip-roolille puuttuu CREATEDB. Operaattori: sudo -u postgres psql -c 'ALTER ROLE $PG_USER CREATEDB'"
}

restore_dump() { # dump [--clean]
  local dump="$1" clean="${2:-}"
  guard_names
  local args=(--no-owner --no-acl --exit-on-error -d "$REH_DB")
  [[ "$clean" == "--clean" ]] && args+=(--clean --if-exists)
  pg_restore "${args[@]}" "$dump"
}

# --- Palvelin -------------------------------------------------------------------------------

stop_server() {
  local pid
  if [[ -s "$SERVER_PID_FILE" ]]; then
    pid="$(cat "$SERVER_PID_FILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$SERVER_PID_FILE"
  fi
}

stop_all() {
  stop_server
  if [[ -s "$HOLDER_PID_FILE" ]]; then kill "$(cat "$HOLDER_PID_FILE")" 2>/dev/null || true; rm -f "$HOLDER_PID_FILE"; fi
}

start_server() {
  mkdir -p "$REH_HOME"
  chmod 700 "$REH_HOME"
  local db_url="postgres://${PG_USER}@localhost/${REH_DB}?host=$(printf %s "$SOCKET_DIR" | sed 's|/|%2F|g')${PGPORT:+&port=$PGPORT}"
  : >"$SERVER_LOG"
  # env -i: vain allowlist. Ei perittyjä tokeneita, ei ses.env:iä, ei PAPERCLIP_SECRETS_*.
  ( cd "$WORKTREE" && ns_exec env -i \
      PATH="$PATH" HOME="$REH_HOME" PAPERCLIP_HOME="$REH_HOME" \
      NODE_ENV=development HOST=127.0.0.1 PORT="$PORT" \
      PAPERCLIP_LISTEN_HOST=127.0.0.1 PAPERCLIP_LISTEN_PORT="$PORT" \
      PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
      DATABASE_URL="$db_url" \
      HEARTBEAT_SCHEDULER_ENABLED=false \
      OUTREACH_SENDER_ENABLED=false OUTREACH_AUTO_PAUSE_ENABLED=false OUTREACH_DNSBL_ENABLED=false \
      PAPERCLIP_ANNOUNCEMENTS_ENABLED=false PAPERCLIP_QMD_WATCHDOG_ENABLED=false \
      PAPERCLIP_DB_BACKUP_ENABLED=false \
      bash -c "echo \$\$ >'$SERVER_PID_FILE'; exec $SERVER_CMD" ) >>"$SERVER_LOG" 2>&1 </dev/null &
  local i
  for i in $(seq 1 120); do
    if [[ -s "$SERVER_PID_FILE" ]] && ns_exec bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
      log "palvelin kuuntelee nimiavaruudessa 127.0.0.1:$PORT (pid $(cat "$SERVER_PID_FILE"))"
      verify_server_env "$(cat "$SERVER_PID_FILE")"
      return
    fi
    sleep 1
  done
  tail -n 30 "$SERVER_LOG" >&2 || true
  die "palvelin ei alkanut kuunnella portissa $PORT 120 s:ssa (loki: $SERVER_LOG)"
}

# --- Komennot -------------------------------------------------------------------------------

save_state() { # avain=arvo...
  mkdir -p "$REH_HOME"
  local kv
  for kv in "$@"; do
    grep -v "^${kv%%=*}=" "$STATE_FILE" 2>/dev/null >"$STATE_FILE.tmp" || true
    printf '%s\n' "$kv" >>"$STATE_FILE.tmp"
    mv "$STATE_FILE.tmp" "$STATE_FILE"
  done
}
load_state() { [[ -f "$STATE_FILE" ]] || die "ei tilaa ($STATE_FILE): aja ensin $0 <git-ref>"; . "$STATE_FILE"; }

cmd_run() {
  local ref="$1"
  guard_names
  SECONDS=0
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || die "ref '$ref' ei ole olemassa (git fetch --tags?)"
  local pre_sha; pre_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"   # ENNEN checkoutia
  local stamp dump; stamp="$(date +%Y%m%d-%H%M%S)"; dump="$BACKUP_DIR/rehearsal-${stamp}.dump"

  stop_all
  check_disk_and_retention
  log "pg_dump -Fc $PROD_DB → $dump (vain luku)"
  pg_dump -Fc --no-owner -d "$PROD_DB" -f "$dump.part" && mv "$dump.part" "$dump"
  chmod 600 "$dump"
  pg_restore --list "$dump" >/dev/null || die "dumppi ei ole luettavissa: $dump"
  prune_dumps

  log "palautetaan kantaan $REH_DB"
  recreate_reh_db
  restore_dump "$dump"
  local counts_restored; counts_restored="$(table_counts "$REH_DB" | tr '\n' ' ')"

  log "worktree $WORKTREE @ $ref"
  if [[ -e "$WORKTREE" ]]; then git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" || rm -rf -- "$WORKTREE"; fi
  git -C "$REPO_ROOT" worktree prune
  mkdir -p "$(dirname "$WORKTREE")"
  git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$ref"
  log "asennus: $INSTALL_CMD"
  ( cd "$WORKTREE" && bash -c "$INSTALL_CMD" )

  save_state "DUMP=$dump" "PRE_SHA=$pre_sha" "REF=$ref" "COUNTS_RESTORED=\"$counts_restored\"" "PORT=$PORT"
  start_netns
  verify_isolation
  start_server
  verify_isolation

  # Ulos lähteneet rivit: taulut eivät saa kasvaa ajon aikana (aloitusluvut = restore-hetki).
  local now; now="$(table_counts "$REH_DB" | tr '\n' ' ')"
  for t in "${OUTBOUND_TABLES[@]}"; do
    a="$(grep -o "$t=[-0-9]*" <<<"$counts_restored" | head -1 | cut -d= -f2)"
    b="$(grep -o "$t=[-0-9]*" <<<"$now" | head -1 | cut -d= -f2)"
    [[ "$a" == "$b" ]] || die "eristys: $t kasvoi $a → $b palvelimen käynnistyksessä"
  done
  log "ulos lähtevien taulujen rivimäärät ennallaan käynnistyksen jälkeen"
  log "kill-switch-todiste: nimiavaruus vain lo, salaisuusvapaa env, ajastimet pois (HEARTBEAT_SCHEDULER_ENABLED=false, OUTREACH_*_ENABLED=false)"

  cat <<EOF

=== harjoitusinstanssi valmis ===
dumppi:        $dump
pre-upgrade:   $pre_sha
ref:           $ref
osoite:        http://127.0.0.1:$PORT (vain nimiavaruuden sisällä)
kesto:         ${SECONDS} s
seuraava:      $0 smoke        # savutesti instanssia vasten
               $0 rollback     # rollback-harjoitus
               $0 stop
EOF
}

cmd_smoke() {
  load_state
  ns_exec env -i PATH="$PATH" HOME="$REH_HOME" PAPERCLIP_SMOKE_URL="http://127.0.0.1:$PORT" \
    bash "$REPO_ROOT/scripts/upgrade-smoke.sh" "$@"
}

cmd_rollback() {
  load_state
  guard_names
  SECONDS=0
  [[ -f "$DUMP" ]] || die "dumppia ei löydy: $DUMP"
  local expected="$COUNTS_RESTORED"
  log "pysäytetään palvelin ja palautetaan $REH_DB dumpista (pg_restore --clean)"
  stop_server
  # Luo kanta tyhjäksi ennen restorea: pg_restore --clean ei poista tauluja, jotka portti lisäsi.
  recreate_reh_db
  restore_dump "$DUMP" --clean
  log "worktree reset → $PRE_SHA"
  git -C "$WORKTREE" reset --hard "$PRE_SHA" >/dev/null
  local head; head="$(git -C "$WORKTREE" rev-parse HEAD)"
  [[ "$head" == "$PRE_SHA" ]] || die "worktree HEAD $head != pre-SHA $PRE_SHA"
  local after; after="$(table_counts "$REH_DB" | tr '\n' ' ')"
  echo "rivimäärät restoren jälkeen:  $expected"
  echo "rivimäärät rollbackin jälkeen: $after"
  [[ "$(echo $expected)" == "$(echo $after)" ]] || die "rollback: rivimäärät eivät täsmää"
  save_state "ROLLBACK_SECONDS=$SECONDS"
  log "rollback ok: rivimäärät ja skeema täsmäävät, HEAD = $PRE_SHA, kesto ${SECONDS} s"
}

cmd_status() {
  if [[ -f "$STATE_FILE" ]]; then cat "$STATE_FILE"; else echo "ei tilaa"; fi
  holder_alive && echo "nimiavaruus: käynnissä (pid $(cat "$HOLDER_PID_FILE"))" || echo "nimiavaruus: ei käynnissä"
  [[ -s "$SERVER_PID_FILE" ]] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null && echo "palvelin: käynnissä" || echo "palvelin: ei käynnissä"
}

case "${1:-}" in
  ""|-h|--help) usage ;;
  smoke) shift; cmd_smoke "$@" ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  stop) stop_all; log "pysäytetty" ;;
  -*) echo "tuntematon valitsin: $1" >&2; exit 2 ;;
  *) cmd_run "$1" ;;
esac
