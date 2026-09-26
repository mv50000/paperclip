#!/usr/bin/env bash
# Testi scripts/lib-pg-url.sh:lle (RK9-307): URL -> libpq-ympäristö. Kattaa käyttäjän, salasanan
# (prosenttikoodattu), isännän, portin, kannan, unix-socket-polun queryssä, sslmode; kielletty
# `dbname`-query ja tuntematon avain hylätään; väärä skeema hylätään; kanta puuttuu -> virhe;
# pg_url_with_db vaihtaa vain polun ja säilyttää queryn.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib-pg-url.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1: '$3' puuttuu: $2"; fi }

OUT=$(pg_url_env 'postgresql://app:p%40ss%20w@db.example.test:5433/paperclip?sslmode=require')
has "käyttäjä" "$OUT" "export PGUSER=app"
has "salasana dekoodataan" "$OUT" "PGPASSWORD='p@ss w'"
has "isäntä" "$OUT" "PGHOST=db.example.test"
has "portti" "$OUT" "PGPORT=5433"
has "kanta" "$OUT" "PGDATABASE=paperclip"
has "sslmode" "$OUT" "PGSSLMODE=require"
OUT=$(pg_url_env 'postgres:///paperclip?host=/var/run/postgresql&user=u')
has "socket-polku queryssä" "$OUT" "PGHOST=/var/run/postgresql"
pg_url_env 'postgresql:///p?dbname=other' >/dev/null 2>&1 && bad "dbname-query hyväksyttiin" || ok "dbname-query hylätään"
pg_url_env 'postgresql:///p?options=-c%20x' >/dev/null 2>&1 && bad "tuntematon avain hyväksyttiin" || ok "tuntematon query-avain hylätään"
pg_url_env 'mysql://u@h/d' >/dev/null 2>&1 && bad "väärä skeema hyväksyttiin" || ok "väärä skeema hylätään"
pg_url_env 'postgresql://u@h' >/dev/null 2>&1 && bad "kannaton URL hyväksyttiin" || ok "kannaton URL hylätään"
OUT=$(pg_url_with_db 'postgresql://u:pw@h:1/a?host=/s' 'scratch db')
has "polku vaihtuu ja query säilyy" "$OUT" "postgresql://u:pw@h:1/scratch%20db?host=/s"
# pg_with välittää ympäristön aliprosessiin eikä vuoda sitä kutsujalle
V=$(pg_with 'postgresql://u:pw@h:1/d' bash -c 'echo "$PGDATABASE/$PGPORT"')
[ "$V" = "d/1" ] && ok "pg_with asettaa ympäristön" || bad "pg_with: $V"
[ -z "${PGDATABASE:-}" ] && ok "ympäristö ei vuoda kutsujaan" || bad "PGDATABASE vuosi"
V=$(PGSERVICE=foo PGHOSTADDR=1.2.3.4 PGDATABASE=other pg_with 'postgresql://u@h:1/d' bash -c 'echo "${PGSERVICE:-none}/${PGHOSTADDR:-none}/$PGDATABASE"')
[ "$V" = "none/none/d" ] && ok "kutsujan PGSERVICE/PGHOSTADDR/PGDATABASE eivät ohita URL:ia" || bad "ympäristö vuoti: $V"
OUT=$(pg_url_env 'postgres://app:Secr3tPart#rest@db/paperclip' 2>&1); RC=$?
[ "$RC" != 0 ] && ok "koodaamaton # hylätään" || bad "hyväksyttiin"
case "$OUT" in *Secr3tPart*|*rest*) bad "virheviesti vuotaa salasanaa: $OUT" ;; *) ok "virheviesti ei sisällä salasanaa" ;; esac
echo "yhteensä: $PASS ok, $FAIL virhettä"; [ "$FAIL" = 0 ]
