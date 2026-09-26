#!/usr/bin/env bash
# Testi scripts/pre-upgrade-snapshot.sh:lle (RK9-307). Käynnistää väliaikaisen PostgreSQL-instanssin
# unix-socketissa (initdb, ei verkkoa, ei tuotantokantaa) ja ajaa skriptin oikeaa pg_dumpia ja
# pg_restorea vasten.
#
# Kattaa: onnistunut ajo (SNAPSHOT_OK, SHA-tiedosto sisältää HEAD, origin/master ja fork/master,
# scratch-kanta pudotettu, tiedostojen oikeudet 0600); palautus, joka pudottaa rivin
# (PATH-stub pg_restore) -> exit 1 ja scratch pudotettu; puuttuva --tag -> exit 2; puuttuva
# DATABASE_URL -> exit 2.
#
# Aja: scripts/pre-upgrade-snapshot-test.sh   (vaatii postgresql-17:n initdb:n; ei roottina)
set -u
[ "$(id -u)" != 0 ] || { echo "älä aja roottina" >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUT="$HERE/pre-upgrade-snapshot.sh"
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)
[ -x "$PGBIN/initdb" ] || { echo "SKIP: initdb puuttuu"; exit 0; }

TMP=$(mktemp -d /tmp/rk9-307-snap.XXXXXX)
SOCK="$TMP/sock"; mkdir -p "$SOCK"
PORT=$((20000 + RANDOM % 20000))
cleanup() { "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1: '$3' puuttuu tulosteesta: $(printf '%s' "$2" | head -c 500)"; fi }

"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null || { echo "initdb epäonnistui"; exit 2; }
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w -l "$TMP/pg.log" start >/dev/null \
  || { echo "postgres ei käynnisty"; cat "$TMP/pg.log"; exit 2; }
export PATH="$PGBIN:$PATH"
URL_BASE="postgresql:///%s?host=$SOCK&port=$PORT&user=postgres"
url() { printf "$URL_BASE" "$1"; }
# Salasanallinen URL (trust-tunnistus ei pyydä sitä): testaa, ettei salasana päädy argv:hen.
PWURL_BASE="postgresql://postgres:s3cretpw@/%s?host=$SOCK&port=$PORT"
pwurl() { printf "$PWURL_BASE" "$1"; }

psql "$(url postgres)" -qAt -c 'CREATE DATABASE src' >/dev/null
psql "$(url src)" -qAt -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2), ('c', 3);
CREATE TABLE companies (id serial primary key, name text);
INSERT INTO companies (name) SELECT 'c' || g FROM generate_series(1, 7) g;
CREATE TABLE outreach_messages (id serial primary key, status text);
INSERT INTO outreach_messages (status) SELECT 'queued' FROM generate_series(1, 12);
CREATE TABLE email_messages (id serial primary key, direction text);
INSERT INTO email_messages (direction) SELECT 'inbound' FROM generate_series(1, 4);
SQL

# git-fixture: origin ja fork, eri commitit, HEAD = origin/master.
REPO="$TMP/repo"
git init -q "$REPO"
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
git -C "$REPO" branch -M master
git -C "$REPO" update-ref refs/remotes/origin/master HEAD
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
git -C "$REPO" update-ref refs/remotes/fork/master HEAD
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
ORIGIN_SHA=$(git -C "$REPO" rev-parse origin/master)

export DATABASE_URL="$(pwurl src)"
OUT="$TMP/out"
# argv-lokitus: kääre kirjaa jokaisen psql-, pg_dump- ja pg_restore-kutsun argumentit.
WRAP="$TMP/wrap"; ARGV_LOG="$TMP/argv.log"; mkdir -p "$WRAP"; : >"$ARGV_LOG"
for tool in psql pg_dump pg_restore; do
  printf '#!/usr/bin/env bash\necho "%s $*" >>"%s"\nexec "%s/%s" "$@"\n' "$tool" "$ARGV_LOG" "$PGBIN" "$tool" >"$WRAP/$tool"; chmod +x "$WRAP/$tool"
done

echo "== onnistunut ajo"
OUTPUT=$(PATH="$WRAP:$PATH" "$SUT" --tag v2026.512.0 --repo "$REPO" --out-dir "$OUT" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "exit 0" || bad "exit $RC: $OUTPUT"
has "SNAPSHOT_OK tulostuu" "$OUTPUT" "SNAPSHOT_OK"
SNAP=$(ls -d "$OUT"/v2026.512.0-* 2>/dev/null | head -n 1)
SHAF="$SNAP/pre-upgrade-sha.txt"
has "HEAD kirjattu" "$(cat "$SHAF" 2>/dev/null)" "HEAD=$HEAD_SHA"
has "origin/master kirjattu" "$(cat "$SHAF" 2>/dev/null)" "origin/master=$ORIGIN_SHA"
has "fork/master kirjattu" "$(cat "$SHAF" 2>/dev/null)" "fork/master=$HEAD_SHA"
has "upstream/master unknown" "$(cat "$SHAF" 2>/dev/null)" "upstream/master=unknown"
[ "$(stat -c %a "$SNAP/paperclip.dump")" = 600 ] && ok "dump 0600" || bad "dump-oikeudet $(stat -c %a "$SNAP/paperclip.dump")"
[ "$(stat -c %a "$OUT")" = 700 ] && ok "out-dir 0700" || bad "out-dir-oikeudet"
has "scratch-luvut talteen" "$(cat "$SNAP/counts-scratch.txt")" "companies=7"
LEFT=$(psql "$(url postgres)" -qAt -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'pcp_restore_check_%'")
[ "$LEFT" = 0 ] && ok "scratch pudotettu" || bad "scratch-kantoja jäi $LEFT"
( cd "$SNAP" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) && ok "SHA256SUMS täsmää" || bad "SHA256SUMS ei täsmää"
[ -s "$ARGV_LOG" ] && ok "kutsut kirjattu ($(wc -l <"$ARGV_LOG"))" || bad "argv-loki tyhjä"
if grep -q 's3cretpw' "$ARGV_LOG" "$SNAP"/*.txt 2>/dev/null; then bad "salasana näkyy argv:ssä tai tiedostoissa"; else ok "salasana ei näy argv:ssä eikä tiedostoissa"; fi
case "$OUTPUT" in *s3cretpw*) bad "salasana tulosteessa" ;; *) ok "salasana ei tulosteessa" ;; esac

echo "== --verify"
OUTPUT=$("$SUT" --verify "$SNAP" 2>&1); RC=$?
[ "$RC" = 0 ] && has "VERIFY_OK" "$OUTPUT" "VERIFY_OK" || bad "verify exit $RC: $OUTPUT"
psql "$(url src)" -qAt -c "INSERT INTO companies (name) VALUES ('x')" >/dev/null
OUTPUT=$("$SUT" --verify "$SNAP" 2>&1); RC=$?
[ "$RC" = 1 ] && has "verify löytää eron" "$OUTPUT" "companies: snapshotissa 7, kannassa 8" || bad "verify exit $RC: $OUTPUT"
psql "$(url src)" -qAt -c "DELETE FROM companies WHERE name = 'x'" >/dev/null

echo "== dbname-query hylätään"
OUTPUT=$(DATABASE_URL="postgresql:///src?host=$SOCK&port=$PORT&dbname=postgres" "$SUT" --tag x --repo "$REPO" --out-dir "$OUT" 2>&1); RC=$?
[ "$RC" = 2 ] && ok "dbname=-query -> exit 2" || bad "exit $RC: $OUTPUT"

echo "== palautus pudottaa rivin -> exit 1"
STUB="$TMP/stub"; mkdir -p "$STUB"
cat >"$STUB/pg_restore" <<EOF
#!/usr/bin/env bash
"$PGBIN/pg_restore" "\$@" || exit \$?
# PGDATABASE ja muut PG*-muuttujat tulevat snapshot-skriptin ympäristöstä (scratch-kanta)
psql -qAt -c 'DELETE FROM companies WHERE id = 1' >/dev/null
exit 0
EOF
chmod +x "$STUB/pg_restore"
OUTPUT=$(PATH="$STUB:$PATH" "$SUT" --tag v2026.512.1 --repo "$REPO" --out-dir "$OUT" 2>&1); RC=$?
[ "$RC" = 1 ] && ok "exit 1" || bad "exit $RC: $OUTPUT"
has "companies-ero raportoitu" "$OUTPUT" "companies: lähde 7, scratch 6"
case "$OUTPUT" in *SNAPSHOT_OK*) bad "SNAPSHOT_OK ei saa tulostua virheessä" ;; *) ok "ei SNAPSHOT_OK:ta" ;; esac
LEFT=$(psql "$(url postgres)" -qAt -c "SELECT count(*) FROM pg_database WHERE datname LIKE 'pcp_restore_check_%'")
[ "$LEFT" = 0 ] && ok "scratch pudotettu virheessäkin" || bad "scratch-kantoja jäi $LEFT"

echo "== käyttövirheet"
OUTPUT=$("$SUT" --repo "$REPO" --out-dir "$OUT" 2>&1); RC=$?
[ "$RC" = 2 ] && ok "puuttuva --tag -> exit 2" || bad "exit $RC"
OUTPUT=$(env -u DATABASE_URL "$SUT" --tag x --repo "$REPO" --out-dir "$OUT" 2>&1); RC=$?
[ "$RC" = 2 ] && ok "puuttuva DATABASE_URL -> exit 2" || bad "exit $RC"

echo "yhteensä: $PASS ok, $FAIL virhettä"
[ "$FAIL" = 0 ]
