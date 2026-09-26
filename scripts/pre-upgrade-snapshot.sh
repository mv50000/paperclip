#!/usr/bin/env bash
# pre-upgrade-snapshot.sh — pg_dump -Fc + pre-upgrade-SHA + todennettu palautus scratch-kantaan
# (RK9-307). Ajetaan cutover-runbookin vaiheessa 3 (doc/upgrade/cutover-runbook.md), kun
# outreach-sender ja heartbeatit on pysäytetty.
#
# Mitä skripti tekee:
#   1. Kirjaa SHA:t tiedostoon pre-upgrade-sha.txt: HEAD, origin/master, fork/master ja
#      upstream/master (puuttuva remote kirjataan "unknown").
#   2. Ajaa pg_dump -Fc lähdekantaan.
#   3. Palauttaa dumpin kertakäyttöiseen scratch-kantaan (pg_restore) ja vertaa lähteeseen:
#      taulujen määrää, drizzle-migraatioiden määrää ja avaintaulujen rivimääriä.
#   4. Pudottaa scratch-kannan aina, myös virheessä. Lähdekantaan ei kirjoiteta.
#   5. Tallentaa versioidut paikalliset muutokset (patch) ja versioimattomat tiedostot (tar).
# Vain onnistunut vertailu tulostaa "SNAPSHOT_OK". Muu poistumiskoodi = ÄLÄ jatka deployhin.
#
# Käyttö:
#   DATABASE_URL=postgres://... scripts/pre-upgrade-snapshot.sh --tag v2026.512.0
#   DATABASE_URL=postgres://... scripts/pre-upgrade-snapshot.sh --verify <snapshot-hakemisto>
#
#   --tag <nimi>      pakollinen; porras, esim. v2026.512.0 (kirjainnumero, piste, viiva)
#   --repo <polku>    git-työhakemisto SHA:iden lukuun (oletus /opt/paperclip)
#   --out-dir <polku> oletus /var/backups/paperclip-pre-upgrade (luotaessa 0700, tiedostot 0600)
#   --verify <hakemisto>
#                     rollbackin jälkeinen todennus: vertaa DATABASE_URL:n kannan taulu-, migraatio- ja
#                     avaintaulumäärät snapshotin counts-scratch.txt:hen (dumpin sisältö). Tulostaa VERIFY_OK tai erot.
#
# Ympäristö:
#   DATABASE_URL          lähdekanta (pakollinen).
#   SNAPSHOT_ADMIN_URL    yhteys, jolla scratch-kanta luodaan ja pudotetaan. Oletus: DATABASE_URL,
#                         kantana `postgres`. Käyttäjällä pitää olla CREATEDB.
#   SNAPSHOT_TAR_AS       käyttäjä, jonka oikeuksilla versioimattomat tiedostot pakataan
#                         (`sudo -n -u <käyttäjä> tar`), esim. root: osa tuotannon tiedostoista
#                         (cli/.paperclip/.env, server/data/secrets/master.key) on root-omisteisia 0600-tiedostoja. Ilman tätä
#                         lukematon tiedosto katkaisee snapshotin.
# Salasana ei näy prosessilistassa: URL muutetaan libpq-ympäristömuuttujiksi (lib-pg-url.sh).
#
# Poistumiskoodi: 0 = dump ja palautus todennettu, 1 = vertailu tai vaihe epäonnistui,
#                 2 = käyttövirhe.
set -euo pipefail

TAG=""
VERIFY_DIR=""
REPO=/opt/paperclip
OUT_DIR=/var/backups/paperclip-pre-upgrade
LOGTAG="[pre-upgrade-snapshot]"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "$LOGTAG VIRHE: $*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=${2:-}; shift 2 ;;
    --repo) REPO=${2:-}; shift 2 ;;
    --out-dir) OUT_DIR=${2:-}; shift 2 ;;
    --verify) VERIFY_DIR=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "tuntematon valitsin: $1" 2 ;;
  esac
done

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL puuttuu" 2
# shellcheck source=lib-pg-url.sh
. "$HERE/lib-pg-url.sh"
for t in pg_dump pg_restore psql git sha256sum python3; do
  command -v "$t" >/dev/null 2>&1 || die "$t puuttuu PATHista" 2
done
pg_url_env "$DATABASE_URL" >/dev/null || die "DATABASE_URL:ia ei voitu jäsentää" 2
# Kaikki yhteydet kulkevat ympäristön kautta: psqlq <url> [psql-argumentit]
psqlq() { local url=$1; shift; pg_with "$url" psql -qAt -v ON_ERROR_STOP=1 "$@"; }

# Taulut, joiden häviö tai kaksoiskappale näkyisi cutoverissa. Puuttuva taulu ei ole virhe (vanhempi
# skeema), mutta sen pitää puuttua molemmista.
KEY_TABLES=(companies issues agents heartbeat_runs activity_log outreach_prospects outreach_messages
  outreach_events outreach_sender_pauses email_messages email_routes)

count_state() { # <url> -> rivit "nimi=luku"; puuttuvan taulun arvo "-"
  local url=$1 t reg
  echo "tables=$(psqlq "$url" -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
  if [ "$(psqlq "$url" -c "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL")" = t ]; then
    echo "migrations=$(psqlq "$url" -c 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
  else
    echo "migrations=-"
  fi
  for t in "${KEY_TABLES[@]}"; do
    reg=$(psqlq "$url" -c "SELECT to_regclass('public.$t') IS NOT NULL")
    if [ "$reg" = t ]; then
      echo "$t=$(psqlq "$url" -c "SELECT count(*) FROM public.\"$t\"")"
    else
      echo "$t=-"
    fi
  done
}
get() { sed -n "s/^$2=//p" "$1"; }

# --- Rollbackin jälkeinen todennus ------------------------------------------------------------
if [ -n "$VERIFY_DIR" ]; then
  [ -f "$VERIFY_DIR/counts-scratch.txt" ] || die "$VERIFY_DIR/counts-scratch.txt puuttuu" 2
  NOW=$(mktemp); trap 'rm -f "$NOW"' EXIT
  count_state "$DATABASE_URL" >"$NOW"
  DIFFS=0
  want_enc=$(sed -n 's/^encoding=\([^|]*\).*/\1/p' "$VERIFY_DIR/db-level.txt" 2>/dev/null | head -n 1)
  have_enc=$(psqlq "$DATABASE_URL" -c "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()")
  [ -z "$want_enc" ] || [ "$want_enc" = "$have_enc" ] || { echo "$LOGTAG EROA: merkistö: snapshotissa $want_enc, kannassa $have_enc" >&2; DIFFS=$((DIFFS + 1)); }
  for key in tables migrations "${KEY_TABLES[@]}"; do
    want=$(get "$VERIFY_DIR/counts-scratch.txt" "$key"); have=$(get "$NOW" "$key")
    [ "$want" = "$have" ] || { echo "$LOGTAG EROA: $key: snapshotissa $want, kannassa $have" >&2; DIFFS=$((DIFFS + 1)); }
  done
  [ "$DIFFS" = 0 ] || die "kanta ei vastaa snapshotia ($DIFFS eroa); rollback on epätäydellinen tai kannassa on uusia kirjoituksia"
  echo "$LOGTAG VERIFY_OK: kanta vastaa snapshotia $VERIFY_DIR"
  exit 0
fi

[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--tag puuttuu tai sisältää kiellettyjä merkkejä" 2
# shellcheck source=lib-repo-git.sh
. "$HERE/lib-repo-git.sh"
repo_git "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO ei ole luettavissa git-hakemistona (git ajetaan repon omistajana: tarvitaan sudo -n -u <omistaja>)" 2

ADMIN_URL=${SNAPSHOT_ADMIN_URL:-$(pg_url_with_db "$DATABASE_URL" postgres)}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAP_DIR="$OUT_DIR/$TAG-$STAMP"
SCRATCH="pcp_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
SCRATCH_URL=$(pg_url_with_db "$ADMIN_URL" "$SCRATCH")
SCRATCH_CREATED=0

cleanup() {
  local rc=$?
  if [ "$SCRATCH_CREATED" = 1 ]; then
    psqlq "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1 \
      || echo "$LOGTAG HUOM: scratch-kantaa $SCRATCH ei voitu pudottaa; pudota käsin" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

umask 077
[ -d "$OUT_DIR" ] || { mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"; }   # olemassa olevan hakemiston oikeuksiin ei kosketa
mkdir "$SNAP_DIR"

# --- 1. SHA:t ---------------------------------------------------------------------------------
sha_of() { repo_git "$REPO" rev-parse --verify --quiet "$1^{commit}" 2>/dev/null || echo unknown; }
{
  echo "tag=$TAG"
  echo "recorded_at=$STAMP"
  echo "repo=$REPO"
  echo "HEAD=$(sha_of HEAD)"
  echo "origin/master=$(sha_of origin/master)"
  echo "fork/master=$(sha_of fork/master)"
  echo "upstream/master=$(sha_of upstream/master)"
} >"$SNAP_DIR/pre-upgrade-sha.txt"
if grep -q '^HEAD=unknown$' "$SNAP_DIR/pre-upgrade-sha.txt"; then die "HEAD ei ratkea $REPO:ssa"; fi
echo "$LOGTAG SHA:t kirjattu: $SNAP_DIR/pre-upgrade-sha.txt"

# --- 2. Avaintaulujen määrät ennen dumpia ------------------------------------------------------
count_state "$DATABASE_URL" >"$SNAP_DIR/counts-before.txt"

# Tietokantatason tila, jota dump (--no-privileges, ei ALTER DATABASE) ei kanna: käyttöoikeudet ja
# roolikohtaiset asetukset. Rollbackin R4 (DROP/CREATE DATABASE) hävittää ne, joten ne tallennetaan.
psqlq "$DATABASE_URL" -c "SELECT 'encoding=' || pg_encoding_to_char(encoding), 'collate=' || datcollate, 'ctype=' || datctype, 'owner=' || pg_get_userbyid(datdba), 'acl=' || coalesce(datacl::text, ''), 'settings=' || coalesce((SELECT string_agg(coalesce(setrole::text, '0') || ':' || setconfig::text, ';') FROM pg_db_role_setting s WHERE s.setdatabase = d.oid), '') FROM pg_database d WHERE datname = current_database()" >"$SNAP_DIR/db-level.txt" \
  || die "tietokantatason tilan luku epäonnistui"

# --- 3. Dump ----------------------------------------------------------------------------------
DUMP="$SNAP_DIR/paperclip.dump"
pg_with "$DATABASE_URL" pg_dump -Fc --no-owner --no-privileges --file="$DUMP" \
  || die "pg_dump epäonnistui"
[ -s "$DUMP" ] || die "dump on tyhjä"
pg_restore --list "$DUMP" >/dev/null || die "pg_restore --list ei lue dumpia"
count_state "$DATABASE_URL" >"$SNAP_DIR/counts-after.txt"
echo "$LOGTAG dump valmis: $(stat -c %s "$DUMP") tavua"

# --- 4. Palautus scratch-kantaan ---------------------------------------------------------------
[ "$SCRATCH_URL" != "$DATABASE_URL" ] || die "scratch-URL on sama kuin lähde-URL; keskeytetään"
# Sama merkistö ja locale kuin lähteellä (template1 voi olla SQL_ASCII, ja väärä merkistö ei näy rivimäärissä).
IFS='|' read -r DB_ENC DB_COLL DB_CTYPE < <(psqlq "$DATABASE_URL" -F'|' -c "SELECT pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = current_database()")
[[ "$DB_ENC$DB_COLL$DB_CTYPE" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "lähdekannan merkistö tai locale ei ole luettavissa"
psqlq "$ADMIN_URL" -c "CREATE DATABASE \"$SCRATCH\" TEMPLATE template0 ENCODING '$DB_ENC' LC_COLLATE '$DB_COLL' LC_CTYPE '$DB_CTYPE'" >/dev/null \
  || die "scratch-kannan luonti epäonnistui (CREATEDB-oikeus?)"
SCRATCH_CREATED=1
# Todenna ennen palautusta, että scratch-yhteys osuu scratchiin eikä lähteeseen.
[ "$(psqlq "$SCRATCH_URL" -c 'SELECT current_database()')" = "$SCRATCH" ] \
  || die "scratch-yhteys ei osu kantaan $SCRATCH; palautusta ei ajeta"
pg_with "$SCRATCH_URL" bash -c 'exec pg_restore --no-owner --no-privileges --exit-on-error --dbname="$PGDATABASE" "$1"' _ "$DUMP" \
  || die "palautus scratch-kantaan epäonnistui"
count_state "$SCRATCH_URL" >"$SNAP_DIR/counts-scratch.txt"

# --- 5. Vertailu -------------------------------------------------------------------------------
# Jos lähde ei muuttunut dumpin aikana, scratchin pitää täsmätä tarkasti. Jos muuttui (pysäytys ei
# pitänyt), scratchin pitää olla ennen/jälkeen-arvojen välissä, ja skripti varoittaa.
FAILS=0
DRIFT=0
for key in tables migrations "${KEY_TABLES[@]}"; do
  b=$(get "$SNAP_DIR/counts-before.txt" "$key")
  a=$(get "$SNAP_DIR/counts-after.txt" "$key")
  s=$(get "$SNAP_DIR/counts-scratch.txt" "$key")
  if [ "$b" = "-" ] || [ "$a" = "-" ] || [ "$s" = "-" ]; then
    if [ "$b" = "$a" ] && [ "$a" = "$s" ]; then continue; fi
    echo "$LOGTAG EROA: $key: taulu puuttuu joko lähteestä tai scratchista (lähde $b/$a, scratch $s)" >&2
    FAILS=$((FAILS + 1)); continue
  fi
  if [ "$b" = "$a" ]; then
    [ "$s" = "$b" ] || { echo "$LOGTAG EROA: $key: lähde $b, scratch $s" >&2; FAILS=$((FAILS + 1)); }
  else
    DRIFT=$((DRIFT + 1))
    lo=$b; hi=$a; [ "$a" -lt "$b" ] && { lo=$a; hi=$b; }
    if [ "$s" -lt "$lo" ] || [ "$s" -gt "$hi" ]; then
      echo "$LOGTAG EROA: $key: lähde muuttui dumpin aikana ($b -> $a), scratch $s on välin ulkopuolella" >&2
      FAILS=$((FAILS + 1))
    fi
  fi
done
[ "$DRIFT" = 0 ] || echo "$LOGTAG VAROITUS: $DRIFT taulun rivimäärä muuttui dumpin aikana. Onko outreach ja heartbeatit pysäytetty?" >&2
[ "$FAILS" = 0 ] || die "palautusvertailu epäonnistui ($FAILS eroa); dump EI ole käyttökelpoinen rollbackiin"
# Ilman migraatiotaulua vertailu ei todista skeemaa.
[ "$(get "$SNAP_DIR/counts-scratch.txt" migrations)" != "-" ] || die "drizzle.__drizzle_migrations puuttuu; vertailu ei todista skeemaa"

# --- 6. Paikalliset muutokset ja versioimattomat tiedostot ------------------------------------
# reset --hard hävittää versioidut paikalliset muutokset, joten ne talletetaan patchina. Löydös
# (exit 1) ei kaada snapshotia, koska dump on silti käyttökelpoinen, mutta runbookin go/no-go vaatii
# sen ratkaisun. Epätäydellinen varmuuskopio (exit 3, esim. lukematon tiedosto) kaataa: väärä
# turvallisuudentunne olisi pahempi kuin puuttuva snapshot.
UNTRACKED_RC=0
TAR_AS_ARGS=()
[ -z "${SNAPSHOT_TAR_AS:-}" ] || TAR_AS_ARGS=(--tar-as "$SNAPSHOT_TAR_AS")
"$HERE/prod-untracked-check.sh" --repo "$REPO" --backup "$SNAP_DIR/local" "${TAR_AS_ARGS[@]}" \
  >"$SNAP_DIR/untracked-check.txt" 2>&1 || UNTRACKED_RC=$?
case "$UNTRACKED_RC" in
  0) ;;
  1) echo "$LOGTAG VAROITUS: prod-untracked-check löysi ongelmia (ks. $SNAP_DIR/untracked-check.txt). Ratkaise ennen resettiä." >&2 ;;
  *) die "varmuuskopio versioimattomista tiedostoista epäonnistui (exit $UNTRACKED_RC): $(tail -n 3 "$SNAP_DIR/untracked-check.txt"). Aseta SNAPSHOT_TAR_AS=root, jos tiedostot eivät ole luettavissa." ;;
esac

# --- 7. Summa ja loppu -------------------------------------------------------------------------
( cd "$SNAP_DIR" && sha256sum paperclip.dump pre-upgrade-sha.txt db-level.txt local/local-changes.patch local/untracked-preserved.tar >SHA256SUMS )
find "$SNAP_DIR" -type f -exec chmod 600 {} +
echo "$LOGTAG SNAPSHOT_OK dir=$SNAP_DIR tables=$(get "$SNAP_DIR/counts-scratch.txt" tables) migrations=$(get "$SNAP_DIR/counts-scratch.txt" migrations)"
echo "$LOGTAG rollback ja todennus: doc/upgrade/cutover-runbook.md, osio Rollback"
