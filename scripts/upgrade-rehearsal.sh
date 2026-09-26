#!/usr/bin/env bash
# upgrade-rehearsal.sh — harjoitusinstanssi upstream-päivityksen portaille (RK9-306).
#
# Ottaa prod-kannasta dumpin, palauttaa sen kantaan paperclip_rehearsal, checkouttaa
# refin omaan worktreehen ja käynnistää palvelimen verkkonimiavaruudessa, jossa on vain
# loopback. Tuotantoon ei kirjoiteta, eikä paperclip.serviceä kosketa.
#
# Eristys (operaattorin päätös 2026-09-26, ensisijaisesti verkkotaso):
#   1. Palvelin ajetaan `unshare -r -n -p -f` -nimiavaruudessa: ei reittiä ulos, oma pid-avaruus
#      (kannan kopion process_pid-arvot eivät osu prodin prosesseihin; /proc on silti hostin). Nimet voivat resolvoitua
#      hostin resolverin unix-socketin kautta, mutta yhteys ei avaudu. Ulos lähtevä
#      SES/Resend/Slack/GitHub/outreach epäonnistuu yhteyden avauksessa.
#   2. Kantayhteys: nimiavaruuden sisäinen silta 127.0.0.1:5432 → hostin PG:n unix-socket
#      (tiedostopolku, ei kuulu verkkonimiavaruuteen). postgres.js ei tue ?host=-muotoa.
#   3. Palvelimen env rakennetaan `env -i`:llä allowlististä: ei ses.env:iä eikä tokeneita.
#      Oma PAPERCLIP_HOME, PAPERCLIP_CONFIG ja PAPERCLIP_SECRETS_MASTER_KEY_FILE on lukittu sen alle,
#      joten master.key on uusi eikä kantaan tallennettuja salaisuuksia voi purkaa.
#   4. Ajastimet pois lipuilla (HEARTBEAT_SCHEDULER_ENABLED=false, OUTREACH_*_ENABLED=false ym.;
#      PAPERCLIP_ANNOUNCEMENTS_ENABLED tulee voimaan vasta portaassa 916.1). Koodiin ei lisätty gatea: verkkotaso kattaa loput.
#   5. Skripti kieltäytyy jatkamasta (fail closed), jos egress-koetin pääsee ulos, nimiavaruudessa
#      on muu kuin lo tai jonkin nimiavaruuden prosessin env sisältää salaisuudennäköisen muuttujan.
#
# Käyttö:
#   scripts/upgrade-rehearsal.sh <git-ref>     koko putki: dump → restore → worktree → install → palvelin
#   scripts/upgrade-rehearsal.sh smoke [args]  aja upgrade-smoke.sh instanssia vasten (nsenterillä)
#   scripts/upgrade-rehearsal.sh rollback      tyhjä kanta + pg_restore --clean dumpista + git reset pre-SHA:han
#   scripts/upgrade-rehearsal.sh status        näytä tila
#   scripts/upgrade-rehearsal.sh stop          pysäytä palvelin ja nimiavaruus
#   scripts/upgrade-rehearsal.sh clean [--dumps]  pudota harjoituskanta (prod-dataa!) ja worktree; dumpit vain --dumps
#
# Ajo tällä koneella: kanta hyväksyy socketissa vain peer-tunnistuksen, joten aja
# palvelun käyttäjänä paperclip-omisteisesta checkoutista (ks. doc/UPSTREAM-UPGRADE.md, "Ajo tällä koneella").
# Rajat: nimiavaruus ei eristä tiedostojärjestelmää eikä käyttäjää; ks. samasta osiosta "Tunnetut rajat".
#
# Ympäristömuuttujat (oletus):
#   REHEARSAL_PROD_DB=paperclip  REHEARSAL_DB=paperclip_rehearsal  REHEARSAL_PORT=3199
#   REHEARSAL_PG_SOCKET_DIR=/var/run/postgresql  REHEARSAL_PG_USER=paperclip
#   REHEARSAL_HOME=$HOME/.paperclip-rehearsal    REHEARSAL_BACKUP_DIR=/var/backups/paperclip
#   REHEARSAL_WORKTREE=/tmp/paperclip-worktrees/rehearsal/RK9   REHEARSAL_KEEP_DUMPS=5
#   REHEARSAL_MIN_FREE_FACTOR=3   vapaata levyä vähintään näin monta kertaa kannan koko
# Testisaumat: REHEARSAL_INSTALL_CMD, REHEARSAL_SERVER_CMD.
# sudo nollaa ympäristön: anna muuttujat näin:  sudo -u paperclip env REHEARSAL_X=… scripts/upgrade-rehearsal.sh …
#
# Poistumiskoodi: 0 = ok, 1 = virhe tai eristystarkistus epäonnistui, 2 = käyttövirhe.

set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROD_DB="${REHEARSAL_PROD_DB:-paperclip}"
REH_DB="${REHEARSAL_DB:-paperclip_rehearsal}"
PORT="${REHEARSAL_PORT:-3199}"
SOCKET_DIR="${REHEARSAL_PG_SOCKET_DIR:-/var/run/postgresql}"
PG_USER="${REHEARSAL_PG_USER:-paperclip}"
REH_HOME="${REHEARSAL_HOME:-${HOME:-/tmp}/.paperclip-rehearsal}"
BACKUP_DIR="${REHEARSAL_BACKUP_DIR:-/var/backups/paperclip}"
WORKTREE="${REHEARSAL_WORKTREE:-/tmp/paperclip-worktrees/rehearsal/RK9}"
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
usage() { sed -n '2,47p' "$0"; exit 2; }
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
  [[ "$KEEP_DUMPS" =~ ^[1-9][0-9]*$ ]] || die "REHEARSAL_KEEP_DUMPS pitää olla kokonaisluku >= 1"
  [[ "$FREE_FACTOR" =~ ^[1-9][0-9]*$ ]] || die "REHEARSAL_MIN_FREE_FACTOR pitää olla kokonaisluku >= 1"
  # Vain rehearsal-alihakemisto: rm -rf / git reset --hard eivät voi osua muiden issueiden worktreihin.
  local real_wt
  real_wt="$(realpath -m "$WORKTREE")"
  [[ "$real_wt" == /tmp/paperclip-worktrees/rehearsal/?* ]] || die "REHEARSAL_WORKTREE pitää olla /tmp/paperclip-worktrees/rehearsal/<nimi> (nyt $real_wt)"
  [[ "$real_wt" != "$(realpath -m "$REPO_ROOT")" && "$(realpath -m "$REPO_ROOT")" != "$real_wt"/* ]] || die "REHEARSAL_WORKTREE osuu tähän repoon"
}

psql_q() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }

# --- Nimiavaruus ----------------------------------------------------------------------------

# Holder on `unshare -r -n -p -f`: käyttäjä-, verkko- ja pid-nimiavaruus. (--mount-proc ei onnistu
# LXC-kontissa, joten /proc on hostin: nimiavaruuden prosessit näkyvät sieltä hostin pideillä.)
# Pid-nimiavaruus estää palvelinta signaloimasta prodin prosesseja kannan kopion pid-arvoilla
# (heartbeat_runs.process_pid). Kun nimiavaruuden init kuolee, kaikki sen prosessit kuolevat.
holder_init_pid() { pgrep -P "$(cat "$HOLDER_PID_FILE")" 2>/dev/null | head -1; }
holder_alive() {
  [[ -s "$HOLDER_PID_FILE" ]] || return 1
  local pid init cmd; pid="$(cat "$HOLDER_PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline")"   # ei putkea: pipefail + grep -q antaa SIGPIPE-virheen
  [[ "$cmd" == *"unshare -r -n -p -f "* ]] || return 1
  init="$(holder_init_pid)"; [[ -n "$init" ]] || return 1
  [[ "$(readlink "/proc/$init/ns/net")" != "$(readlink /proc/self/ns/net)" && "$(readlink "/proc/$init/ns/pid")" != "$(readlink /proc/self/ns/pid)" ]]
}

# ns_exec CMD... — aja komento harjoitusnimiavaruudessa. NS_WD asettaa työhakemiston.
ns_exec() {
  holder_alive || die "nimiavaruutta ei ole käynnissä (aja ensin: $0 <git-ref>)"
  nsenter -t "$(holder_init_pid)" -U -n -p ${NS_WD:+--wd="$NS_WD"} --preserve-credentials -- "$@"
}
# ns_daemon LOKI CMD... — sama taustalle omassa istunnossa (sudo-pty:n SIGHUP ei tapa sitä).
ns_daemon() {
  local logfile="$1"; shift
  holder_alive || die "nimiavaruutta ei ole käynnissä"
  setsid nsenter -t "$(holder_init_pid)" -U -n -p ${NS_WD:+--wd="$NS_WD"} --preserve-credentials -- "$@" >>"$logfile" 2>&1 </dev/null 9>&- &
}

# server_alive — palvelimen pid (nimiavaruuden numeroinnissa) elää.
server_alive() {
  holder_alive && [[ -s "$SERVER_PID_FILE" ]] || return 1
  ns_exec bash -c 'p="$(cat "$1")"; [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p"' _ "$SERVER_PID_FILE" 2>/dev/null
}

start_netns() {
  command -v unshare >/dev/null && command -v nsenter >/dev/null && command -v pgrep >/dev/null || die "unshare/nsenter/pgrep puuttuu"
  if holder_alive; then return; fi
  # env -i: nimiavaruuden init ei peri operaattorin env:iä. lo nostetaan ylös, muuta liitäntää ei ole.
  setsid env -i PATH="$PATH" unshare -r -n -p -f bash -c 'ip link set lo up && exec sleep infinity' >/dev/null 2>&1 </dev/null 9>&- &
  echo $! >"$HOLDER_PID_FILE"
  for _ in $(seq 1 20); do
    if holder_alive && [[ "$(ns_exec ip -o link show lo 2>/dev/null || true)" =~ (UP|UNKNOWN) ]]; then return; fi
    sleep 0.25
  done
  die "verkko/pid-nimiavaruus ei käynnistynyt. Jos unshare -rnpf on estetty (kernel.unprivileged_userns_clone=0 / apparmor), aja operaattorina: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0"
}

# Fail closed: todista eristys ennen kuin palvelin käynnistetään ja sen jälkeen.
verify_isolation() {
  local links probe
  links="$(ns_exec ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1 | sort | tr '\n' ' ')"
  [[ "$links" == "lo " ]] || die "eristys: nimiavaruudessa on muita liitäntöjä kuin lo: $links"
  [[ -z "$(ns_exec ip -o route show)" ]] || die "eristys: nimiavaruudessa on reittejä"
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

# Kaikkien nimiavaruuden prosessien env ei saa sisältää salaisuudennäköisiä muuttujia. Prosessit tunnistetaan
# pid-nimiavaruuden inodesta hostin /procista (nimiavaruudessa ei ole omaa /procia). Ei luettavissa oleva env on
# virhe (fail closed).
verify_server_env() {
  local init ns d p n=0 bad="" leaked envtxt
  init="$(holder_init_pid)"; ns="$(readlink "/proc/$init/ns/pid")"
  for d in /proc/[0-9]*; do
    p="${d#/proc/}"
    [[ "$(readlink "$d/ns/pid" 2>/dev/null || true)" == "$ns" ]] || continue
    if [[ ! -r "$d/environ" ]]; then [[ -d "$d" ]] && bad+="pid $p: environ ei luettavissa; "; continue; fi
    envtxt="$(tr '\0' '\n' <"$d/environ")" || { bad+="pid $p: environ-luku epäonnistui; "; continue; }
    n=$((n + 1))
    leaked="$(printf '%s\n' "$envtxt" | cut -d= -f1 \
      | grep -E -i '(SES|RESEND|SLACK|GITHUB|TELEGRAM|ANTHROPIC|OPENAI|TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE|AWS_)' \
      | grep -v -E '^PAPERCLIP_SECRETS_MASTER_KEY_FILE$' || true)"
    [[ -z "$leaked" ]] || bad+="pid $p: $(echo "$leaked" | tr '\n' ' ')"
    # Ei -q: pipefail + SIGPIPE.
    if [[ -n "$(printf '%s\n' "$envtxt" | grep -E '^DATABASE_URL=[a-z]+://[^@/]*:[^@/]*@' || true)" ]]; then bad+="pid $p: DATABASE_URL sisältää salasanan; "; fi
  done
  [[ -z "$bad" ]] || die "eristys: nimiavaruuden env sisältää salaisuudennäköistä: $bad"
  (( n >= 3 )) || die "eristys: nimiavaruudessa on $n prosessia, odotettu vähintään 3 (init, silta, palvelin)"
  log "nimiavaruuden env ok ($n prosessia): ei salaisuusmuuttujia"
}

# --- Kanta ----------------------------------------------------------------------------------

table_counts() { # db → "taulu=n" riveittäin; puuttuva taulu = -1; virhe keskeyttää
  local db="$1" t n
  for t in "${KEY_TABLES[@]}"; do
    if [[ "$(psql_q -d "$db" -c "select to_regclass('public.$t') is null")" == "t" ]]; then n=-1
    else n="$(psql_q -d "$db" -c "select count(*) from \"$t\"")"; fi
    [[ "$n" =~ ^-?[0-9]+$ ]] || die "rivimäärän luku epäonnistui: $db.$t"
    echo "$t=$n"
  done
  # Skeema: portti voi lisätä tauluja ja sarakkeita, joita --clean yksin ei poista.
  local nt nc
  nt="$(psql_q -d "$db" -c "select count(*) from information_schema.tables where table_schema='public'")"
  nc="$(psql_q -d "$db" -c "select count(*) from information_schema.columns where table_schema='public'")"
  [[ "$nt" =~ ^[0-9]+$ && "$nc" =~ ^[0-9]+$ ]] || die "skeemalaskenta epäonnistui: $db"
  echo "_public_tables=$nt"
  echo "_public_columns=$nc"
}

# Skeemasormenjälki: rollbackin pitää palauttaa täsmälleen restore-hetken skeema.
# pg_dump 17 lisää satunnaisen \restrict-tunnisteen, joten se poistetaan ennen tiivistettä.
schema_hash() { local h; h="$(pg_dump -s --no-owner --no-acl -d "$1" | sed -E '/^\\(un)?restrict /d' | md5sum)" || die "pg_dump -s epäonnistui: $1"; echo "${h%% *}"; }

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

# Pysäyttää koko nimiavaruuden: init kuolee → kernel tappaa sen kaikki prosessit (palvelin, silta, orvot lapset).
stop_all() {
  if holder_alive; then
    local init; init="$(holder_init_pid)"
    kill -KILL "$init" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$init" 2>/dev/null || break; sleep 0.25; done
  fi
  rm -f "$HOLDER_PID_FILE" "$SERVER_PID_FILE"
}

# Silta: nimiavaruuden 127.0.0.1:5432 → hostin PG:n unix-socket. Kuuluu vain nimiavaruuteen.
start_pg_bridge() {
  cat >"$REH_HOME/pg-bridge.js" <<'JS'
const net = require("node:net");
const [, , sock, port] = process.argv;
net.createServer((c) => {
  const u = net.connect(sock);
  c.pipe(u); u.pipe(c);
  const end = () => { c.destroy(); u.destroy(); };
  c.on("error", end); u.on("error", end);
}).listen(Number(port), "127.0.0.1");
JS
  local sock="$SOCKET_DIR/.s.PGSQL.${PGPORT:-5432}"
  [[ -S "$sock" ]] || die "PG-socketia ei löydy: $sock"
  ns_daemon "$SERVER_LOG" env -i PATH="$PATH" HOME="$REH_HOME" node "$REH_HOME/pg-bridge.js" "$sock" 5432
  for _ in $(seq 1 20); do
    ns_exec bash -c "exec 3<>/dev/tcp/127.0.0.1/5432" 2>/dev/null && return
    sleep 0.25
  done
  die "PG-silta ei käynnistynyt"
}

start_server() {
  mkdir -p "$REH_HOME"
  chmod 700 "$REH_HOME"
  local db_url="postgres://${PG_USER}@127.0.0.1:5432/${REH_DB}"
  : >"$SERVER_LOG"
  start_pg_bridge
  rm -f "$SERVER_PID_FILE"
  # env -i: vain allowlist. Ei perittyjä tokeneita eikä ses.env:iä; salaisuuksista vain master.key:n polku.
  NS_WD="$WORKTREE" ns_daemon "$SERVER_LOG" env -i \
      PATH="$PATH" HOME="$REH_HOME" PAPERCLIP_HOME="$REH_HOME" \
      NODE_ENV=development HOST=127.0.0.1 PORT="$PORT" \
      PAPERCLIP_LISTEN_HOST=127.0.0.1 PAPERCLIP_LISTEN_PORT="$PORT" \
      PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
      PAPERCLIP_CONFIG="$REH_HOME/instances/default/config.json" \
      PAPERCLIP_SECRETS_MASTER_KEY_FILE="$REH_HOME/secrets/master.key" \
      DATABASE_URL="$db_url" \
      HEARTBEAT_SCHEDULER_ENABLED=false \
      OUTREACH_SENDER_ENABLED=false OUTREACH_AUTO_PAUSE_ENABLED=false OUTREACH_DNSBL_ENABLED=false \
      PAPERCLIP_ANNOUNCEMENTS_ENABLED=false PAPERCLIP_QMD_WATCHDOG_ENABLED=false \
      PAPERCLIP_DB_BACKUP_ENABLED=false \
      bash -c "echo \$\$ >'$SERVER_PID_FILE'; exec $SERVER_CMD"
  for i in $(seq 1 120); do
    if (( i > 5 )) && ! server_alive; then
      tail -n 30 "$SERVER_LOG" >&2 || true
      die "palvelin päättyi ennen kuin alkoi kuunnella (loki: $SERVER_LOG)"
    fi
    if server_alive && ns_exec bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
      log "palvelin kuuntelee nimiavaruudessa 127.0.0.1:$PORT (nimiavaruuden pid $(cat "$SERVER_PID_FILE"))"
      verify_server_env
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
    { grep -v "^${kv%%=*}=" "$STATE_FILE" 2>/dev/null || true; printf '%s\n' "$kv"; } >"$STATE_FILE.tmp"
    mv "$STATE_FILE.tmp" "$STATE_FILE"
  done
}
# Ei `source`a: refnimi voi sisältää shell-metamerkkejä.
load_state() {
  [[ -f "$STATE_FILE" ]] || die "ei tilaa ($STATE_FILE): aja ensin $0 <git-ref>"
  local line k v
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      DUMP) DUMP="$v" ;; PRE_SHA) PRE_SHA="$v" ;; PORT) PORT="$v" ;;
      WORKTREE) WORKTREE="$v" ;; COUNTS_RESTORED) COUNTS_RESTORED="$v" ;; SCHEMA_RESTORED) SCHEMA_RESTORED="$v" ;;
    esac
  done <"$STATE_FILE"
  guard_names   # tilasta luetut arvot tarkistetaan uudelleen
}

# Yksi ajo kerrallaan: päällekkäinen ajo tappaisi toisen instanssin (EXIT-trap, stop_all).
acquire_lock() {
  mkdir -p "$REH_HOME"; chmod 700 "$REH_HOME"
  exec 9>"$REH_HOME/lock"
  flock -n 9 || die "toinen upgrade-rehearsal-ajo on käynnissä ($REH_HOME/lock)"
}

cmd_run() {
  local ref="$1"
  guard_names
  acquire_lock
  SECONDS=0
  DUMP_PART=""
  trap 'exit 143' TERM INT
  # Virhe kesken ajon: siivoa osittainen dumppi ja pysäytä palvelin/nimiavaruus (fail closed).
  trap 'rc=$?; [[ -n "${DUMP_PART:-}" ]] && rm -f -- "$DUMP_PART"; if (( rc != 0 )); then stop_all; fi' EXIT
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || die "ref '$ref' ei ole olemassa (git fetch --tags?)"
  local pre_sha; pre_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"   # ENNEN checkoutia
  local stamp dump; stamp="$(date +%Y%m%d-%H%M%S)"; dump="$BACKUP_DIR/rehearsal-${stamp}.dump"

  stop_all
  check_disk_and_retention
  log "pg_dump -Fc $PROD_DB → $dump (vain luku)"
  DUMP_PART="$dump.part"
  pg_dump -Fc --no-owner --lock-wait-timeout=60s -d "$PROD_DB" -f "$DUMP_PART" || die "pg_dump epäonnistui"
  mv "$DUMP_PART" "$dump"; DUMP_PART=""
  chmod 600 "$dump"
  pg_restore --list "$dump" >/dev/null || die "dumppi ei ole luettavissa: $dump"
  prune_dumps

  log "palautetaan kantaan $REH_DB"
  recreate_reh_db
  restore_dump "$dump"
  local counts_restored schema_restored
  counts_restored="$(table_counts "$REH_DB" | tr '\n' ' ')"
  schema_restored="$(schema_hash "$REH_DB")"

  log "worktree $WORKTREE @ $ref"
  if [[ -e "$WORKTREE" ]]; then git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" || rm -rf -- "$WORKTREE"; fi
  git -C "$REPO_ROOT" worktree prune
  mkdir -p "$(dirname "$WORKTREE")"
  git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$ref"
  log "asennus: $INSTALL_CMD"
  ( cd "$WORKTREE" && bash -c "$INSTALL_CMD" )

  save_state "DUMP=$dump" "PRE_SHA=$pre_sha" "REF=$ref" "COUNTS_RESTORED=$counts_restored" "SCHEMA_RESTORED=$schema_restored" "PORT=$PORT" "WORKTREE=$WORKTREE"
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

# Savutesti refin omalla upgrade-smoke.sh:lla (worktreestä, ei ajokopiosta): offline- ja fork-testit
# ajetaan nimiavaruuden ulkopuolella (embedded PG ei käynnisty root-uidilla), HTTP-tarkistukset sen sisällä.
cmd_smoke() {
  load_state
  local smoke="$WORKTREE/scripts/upgrade-smoke.sh" a rc=0 offline_only=0
  [[ -f "$smoke" ]] || die "$smoke puuttuu refistä ${REF:-?}: porrasbranchin pitää perustua masteriin (RK9-304)"
  local outside=(--offline) http_args=()
  for a in "$@"; do
    case "$a" in
      --fork-tests) outside+=(--fork-tests) ;;
      --offline) offline_only=1 ;;
      *) http_args+=("$a") ;;
    esac
  done
  log "smoke (worktree $WORKTREE): offline${outside[1]:+ + fork-testit}"
  # env -i: refin testikoodi ei näe prodin HOME/PAPERCLIP_HOMEa eikä PG-ympäristöä (verkko on tässä osassa auki).
  ( cd "$WORKTREE" && env -i PATH="$PATH" HOME="$REH_HOME" PAPERCLIP_HOME="$REH_HOME" \
      PAPERCLIP_CONFIG="$REH_HOME/instances/default/config.json" CI="${CI:-}" bash "$smoke" "${outside[@]}" ) || rc=1
  if (( offline_only == 0 )); then
    log "smoke: HTTP-tarkistukset nimiavaruudessa http://127.0.0.1:$PORT"
    ns_exec env -i PATH="$PATH" HOME="$REH_HOME" PAPERCLIP_SMOKE_URL="http://127.0.0.1:$PORT" \
      bash "$smoke" "${http_args[@]}" || rc=1
  fi
  return "$rc"
}

cmd_rollback() {
  load_state
  acquire_lock
  SECONDS=0
  [[ -f "$DUMP" ]] || die "dumppia ei löydy: $DUMP"
  local expected="$COUNTS_RESTORED"
  local schema_upgraded; schema_upgraded="$(schema_hash "$REH_DB")"
  if [[ "$schema_upgraded" == "$SCHEMA_RESTORED" ]]; then
    log "huom: skeema on muuttumaton restoresta (palvelin ei ajanut migraatioita), rollback ei todista skeeman palautusta"
  else
    log "skeema on muuttunut restoresta (migraatiot ajettu): rollbackin pitää palauttaa se"
  fi
  log "pysäytetään nimiavaruus ja palautetaan $REH_DB dumpista (pg_restore --clean)"
  stop_all
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
  [[ "${expected% }" == "${after% }" ]] || die "rollback: rivimäärät eivät täsmää"
  [[ "$(schema_hash "$REH_DB")" == "$SCHEMA_RESTORED" ]] || die "rollback: skeema ei vastaa restore-hetkeä"
  save_state "ROLLBACK_SECONDS=$SECONDS"
  log "rollback ok: rivimäärät ja skeemasormenjälki täsmäävät, HEAD = $PRE_SHA, kesto ${SECONDS} s"
}

cmd_status() {
  if [[ -f "$STATE_FILE" ]]; then cat "$STATE_FILE"; else echo "ei tilaa"; fi
  if holder_alive; then echo "nimiavaruus: käynnissä (pid $(cat "$HOLDER_PID_FILE"))"; else echo "nimiavaruus: ei käynnissä"; fi
  if server_alive; then echo "palvelin: käynnissä"; else echo "palvelin: ei käynnissä"; fi
}

# Siivoa: pysäytä, pudota harjoituskanta (sisältää prod-dataa, myös prospektien henkilötietoja), poista worktree.
# Dumpit poistetaan vain valitsimella --dumps.
cmd_clean() {
  guard_names
  acquire_lock
  stop_all
  dropdb --if-exists "$REH_DB"
  [[ -e "$WORKTREE" ]] && { git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" || rm -rf -- "$WORKTREE"; git -C "$REPO_ROOT" worktree prune; }
  if [[ "${1:-}" == "--dumps" ]]; then rm -f -- "$BACKUP_DIR"/rehearsal-*.dump; log "dumpit poistettu"; fi
  rm -f "$STATE_FILE" "$SERVER_LOG"
  log "siivottu: kanta $REH_DB pudotettu, worktree poistettu"
}

case "${1:-}" in
  ""|-h|--help) usage ;;
  smoke) shift; cmd_smoke "$@" ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  stop) stop_all; log "pysäytetty" ;;
  clean) shift; cmd_clean "$@" ;;
  -*) echo "tuntematon valitsin: $1" >&2; exit 2 ;;
  *) cmd_run "$1" ;;
esac
