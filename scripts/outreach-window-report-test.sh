#!/usr/bin/env bash
# Testi scripts/outreach-window-report.sh:lle (RK9-307). Väliaikainen PostgreSQL unix-socketissa,
# outreach-skeeman minimiversio. Kattaa: snapshot tulostaa jonon, viimeisimmän lähetyksen ja
# käsittelemättömät vastaukset; puhdas ikkuna (lähetyksiä, uusi vastaus) -> exit 0; jonosta
# kadonnut viesti -> HÄVIÖ; kaksoiskappale-message_id -> KAKSOIS; kadonnut vastaus -> INBOUND;
# lähetys pysäytetyssä ikkunassa (--expect-paused) -> PYSÄYTYS; snapshot ei kirjoita kantaan.
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
export DATABASE_URL="postgresql:///postgres?host=$SOCK&port=$PORT&user=postgres"
sql() { psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE outreach_messages (id serial primary key, status text, message_id text, sent_at timestamptz);
CREATE TABLE outreach_sender_pauses (id serial primary key, resumed_at timestamptz);
CREATE TABLE instance_settings (singleton_key text, general jsonb NOT NULL DEFAULT '{}');
INSERT INTO instance_settings VALUES ('default', '{"systemPause": {"reason": "x"}}');
CREATE TABLE companies (id serial primary key, status text);
INSERT INTO companies (status) VALUES ('active'), ('paused');
CREATE TABLE email_messages (id serial primary key, direction text, route_key text, issue_id int);
CREATE TABLE activity_log (id serial primary key, action text);
INSERT INTO outreach_messages (status, message_id, sent_at) VALUES
  ('sent', 'm1', '2026-10-01T10:00:00Z'), ('queued', NULL, NULL), ('queued', NULL, NULL), ('queued', NULL, NULL), ('approved', NULL, NULL);
INSERT INTO email_messages (direction, route_key, issue_id) VALUES ('inbound', 'k', 1), ('inbound', NULL, NULL);
SQL

B="$TMP/before.json"
OUT=$("$SUT" snapshot --label before --out "$B" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "snapshot exit 0" || bad "snapshot exit $RC: $OUT"
has "jono 3" "$OUT" "jono (queued):              3"
has "viimeisin lähetys" "$OUT" "2026-10-01"
has "unrouted 1" "$OUT" "(unrouted): 1"
has "järjestelmäpysäytys päällä" "$OUT" "SYSTEM_PAUSE): päällä"
[ "$(stat -c %a "$B")" = 600 ] && ok "json 0600" || bad "json-oikeudet"
"$SUT" snapshot >/dev/null 2>&1
[ "$(psql "$DATABASE_URL" -qAt -c 'SELECT count(*) FROM outreach_messages')" = 5 ] && ok "snapshot ei kirjoita" || bad "rivimäärä muuttui"

echo "== puhdas ikkuna: 1 lähetetty jonosta, 1 uusi vastaus"
sql "UPDATE outreach_messages SET status='sent', message_id='m2', sent_at=now() WHERE id=2"
sql "INSERT INTO email_messages (direction, route_key, issue_id) VALUES ('inbound','k',2)"
A="$TMP/after.json"; "$SUT" snapshot --label after --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "puhdas -> exit 0" || bad "exit $RC: $OUT"
has "tulos ei löydöksiä" "$OUT" "ei löydöksiä"

echo "== jonosta katoaa viesti lähettämättä"
sql "DELETE FROM outreach_messages WHERE id=3"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); RC=$?
[ "$RC" = 1 ] && ok "häviö -> exit 1" || bad "exit $RC"
has "HÄVIÖ" "$OUT" "HÄVIÖ"

echo "== kaksoiskappale-message_id"
sql "INSERT INTO outreach_messages (status, message_id, sent_at) VALUES ('sent','m1', now())"
"$SUT" snapshot --out "$A" >/dev/null
OUT=$("$SUT" compare "$B" "$A" 2>&1); has "KAKSOIS" "$OUT" "KAKSOIS"

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

echo "yhteensä: $PASS ok, $FAIL virhettä"
[ "$FAIL" = 0 ]
