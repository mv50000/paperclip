#!/usr/bin/env bash
# Testi scripts/outreach-window-report.sh:lle (RK9-307). Väliaikainen PostgreSQL unix-socketissa,
# outreach-skeeman minimiversio. Kattaa: snapshot tulostaa jonon, viimeisimmän lähetyksen ja
# käsittelemättömät vastaukset eikä kirjoita kantaan; normaali päivä (jonosta lähtee viesti, uusi
# luonnos hyväksytään ja lähetetään, uusi vastaus tulee) -> exit 0; jonosta kadonnut queued- tai
# approved-viesti -> HÄVIÖ (approved-häviö oli aiemmin false negative); lähetetty viesti takaisin
# jonoon -> KAKSOIS; kaksoiskappale-message_id -> KAKSOIS; kadonnut vastaus -> INBOUND; lähetys
# pysäytetyssä ikkunassa (--expect-paused) -> PYSÄYTYS; export tallentaa ikkunan rivit 0600-tiedostoihin.
# Aja: scripts/outreach-window-report-test.sh   (ei roottina)
set -u
[ "$(id -u)" != 0 ] || { echo "älä aja roottina" >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUT="$HERE/outreach-window-report.sh"
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)
[ -x "$PGBIN/initdb" ] || { echo "SKIP: initdb puuttuu"; exit 0; }
command -v jq >/dev/null || { echo "SKIP: jq puuttuu"; exit 0; }

TMP=$(mktemp -d /tmp/rk9-307-win.XXXXXX)
SOCK="$TMP/sock"; mkdir -p "$SOCK"
PORT=$((20000 + RANDOM % 20000))
cleanup() { "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1: '$3' puuttuu: $(printf '%s' "$2" | head -c 600)"; fi }

"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w -l "$TMP/pg.log" start >/dev/null || exit 2
export PATH="$PGBIN:$PATH"
export DATABASE_URL="postgresql://postgres:s3cretpw@/postgres?host=$SOCK&port=$PORT"
sql() { psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE outreach_messages (id serial primary key, status text, message_id text, sent_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE TABLE outreach_sender_pauses (id serial primary key, resumed_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE TABLE outreach_suppressions (id serial primary key, email text, created_at timestamptz DEFAULT now());
CREATE TABLE outreach_events (id serial primary key, type text, created_at timestamptz DEFAULT now());
CREATE TABLE outreach_prospects (id serial primary key, name text, updated_at timestamptz DEFAULT now());
CREATE TABLE instance_settings (singleton_key text, general jsonb NOT NULL DEFAULT '{}');
INSERT INTO instance_settings VALUES ('default', '{"systemPause": {"reason": "x"}}');
CREATE TABLE companies (id serial primary key, status text);
INSERT INTO companies (status) VALUES ('active'), ('paused');
CREATE TABLE email_messages (id serial primary key, direction text, route_key text, issue_id int, created_at timestamptz DEFAULT now());
CREATE TABLE activity_log (id serial primary key, action text);
INSERT INTO outreach_messages (status, message_id, sent_at, updated_at) VALUES
  ('sent', 'm1', '2026-10-01T10:00:00Z', '2026-10-01'), ('queued', NULL, NULL, '2026-10-01'), ('queued', NULL, NULL, '2026-10-01'),
  ('queued', NULL, NULL, '2026-10-01'), ('approved', NULL, NULL, '2026-10-01'), ('approved', NULL, NULL, '2026-10-01');
INSERT INTO email_messages (direction, route_key, issue_id, created_at) VALUES ('inbound', 'k', 1, '2026-10-01'), ('inbound', NULL, NULL, '2026-10-01');
INSERT INTO outreach_suppressions (email, created_at) VALUES ('old@example.test', '2026-09-01');
SQL
ARGV_LOG="$TMP/argv.log"; WRAP="$TMP/wrap"; mkdir -p "$WRAP"
printf '#!/usr/bin/env bash\necho "psql $*" >>"%s"\nexec "%s/psql" "$@"\n' "$ARGV_LOG" "$PGBIN" >"$WRAP/psql"; chmod +x "$WRAP/psql"

B="$TMP/before.json"
OUT=$(PATH="$WRAP:$PATH" "$SUT" snapshot --label before --out "$B" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "snapshot exit 0" || bad "snapshot exit $RC: $OUT"
has "jono 3" "$OUT" "jono (queued):              3"
has "viimeisin lähetys" "$OUT" "2026-10-01"
has "unrouted 1" "$OUT" "(unrouted): 1"
has "järjestelmäpysäytys päällä" "$OUT" "SYSTEM_PAUSE): päällä"
[ "$(stat -c %a "$B")" = 600 ] && ok "json 0600" || bad "json-oikeudet"
[ "$(jq '.messages | length' "$B")" = 6 ] && ok "viestit id:llä mukana" || bad "messages-lista puuttuu"
if grep -q s3cretpw "$ARGV_LOG"; then bad "salasana argv:ssä"; else ok "salasana ei näy argv:ssä"; fi
"$SUT" snapshot >/dev/null 2>&1
[ "$(psql "$DATABASE_URL" -qAt -c 'SELECT count(*) FROM outreach_messages')" = 6 ] && ok "snapshot ei kirjoita" || bad "rivimäärä muuttui"
"$SUT" snapshot --out "$TMP/x.json" >/dev/null; sql "CREATE TABLE ro_probe (i int)" && ok "kanta kirjoitettavissa normaalisti (read-only vain skriptille)" || bad "probe"

echo "== normaali päivä: 1 lähetetty jonosta, uusi luonnos hyväksytty ja lähetetty, uusi vastaus"
sql "UPDATE outreach_messages SET status='sent', message_id='m2', sent_at=now(), updated_at=now() WHERE id=2"
sql "INSERT INTO outreach_messages (status, message_id, sent_at) VALUES ('sent', 'm7', now())"
sql "INSERT INTO email_messages (direction, route_key, issue_id) VALUES ('inbound','k',2)"
A="$TMP/after.json"; "$SUT" snapshot --label after --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "normaali päivä -> exit 0" || bad "exit $RC: $OUT"
has "tulos ei löydöksiä" "$OUT" "ei löydöksiä"

echo "== jonosta katoaa queued-viesti"
sql "DELETE FROM outreach_messages WHERE id=3"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); RC=$?
[ "$RC" = 1 ] && ok "häviö -> exit 1" || bad "exit $RC"
has "HÄVIÖ" "$OUT" "HÄVIÖ: 1 viestiä"

echo "== approved-viesti katoaa (aiempi false negative)"
sql "INSERT INTO outreach_messages (id, status) VALUES (3, 'queued')"   # palauta id 3
sql "DELETE FROM outreach_messages WHERE id=5"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); has "approved-häviö havaitaan" "$OUT" "HÄVIÖ: 1 viestiä"
sql "INSERT INTO outreach_messages (id, status) VALUES (5, 'approved')"

echo "== lähetetty viesti takaisin jonoon"
sql "UPDATE outreach_messages SET status='queued' WHERE id=1"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); RC=$?
[ "$RC" = 1 ] && has "KAKSOIS (revert)" "$OUT" "KAKSOIS: 1 lähetettyä viestiä" || bad "exit $RC: $OUT"
sql "UPDATE outreach_messages SET status='sent' WHERE id=1"

echo "== kaksoiskappale-message_id"
sql "INSERT INTO outreach_messages (status, message_id, sent_at) VALUES ('sent','m1', now())"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); has "KAKSOIS (message_id)" "$OUT" "message_id:tä esiintyy"

echo "== vastaus katoaa"
sql "DELETE FROM email_messages"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); has "INBOUND" "$OUT" "INBOUND"

echo "== pysäytetty ikkuna, lähetys tulee silti"
"$SUT" snapshot --out "$B" >/dev/null
sql "UPDATE outreach_messages SET status='sent', message_id='m9', sent_at=now() WHERE id=4"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" --expect-paused 2>&1); RC=$?
[ "$RC" = 1 ] && has "PYSÄYTYS" "$OUT" "PYSÄYTYS" || bad "exit $RC: $OUT"

echo "== export"
sql "INSERT INTO outreach_suppressions (email) VALUES ('new@example.test')"
EXP="$TMP/export"
OUT=$("$SUT" export --since 2026-09-15T00:00:00Z --out "$EXP" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "export exit 0" || bad "export exit $RC: $OUT"
has "suppressions-rivi mukana" "$(cat "$EXP/outreach_suppressions.csv")" "new@example.test"
case "$(cat "$EXP/outreach_suppressions.csv")" in *old@example.test*) bad "vanha rivi ei kuulu ikkunaan" ;; *) ok "vanha rivi rajautuu pois" ;; esac
[ "$(stat -c %a "$EXP/outreach_suppressions.csv")" = 600 ] && [ "$(stat -c %a "$EXP")" = 700 ] && ok "oikeudet 700/600" || bad "export-oikeudet"
OUT=$("$SUT" export --since "x'; drop table outreach_messages;--" --out "$TMP/e2" 2>&1); RC=$?
[ "$RC" = 2 ] && ok "kelvoton --since hylätään" || bad "injektiotesti exit $RC"

echo "yhteensä: $PASS ok, $FAIL virhettä"
[ "$FAIL" = 0 ]
