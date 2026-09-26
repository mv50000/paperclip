#!/usr/bin/env bash
# lib-pg-url.sh — kirjasto: muuttaa PostgreSQL-URL:n libpq-ympäristömuuttujiksi (RK9-307).
# Syy: URL argumenttina (`psql "$DATABASE_URL"`, `pg_dump --dbname=URL`) näkyy salasanoineen
# prosessilistassa (/proc/<pid>/cmdline) koko dumpin ajan. Ympäristö ei näy muille käyttäjille.
#
#   . scripts/lib-pg-url.sh
#   pg_url_env <url>                    tulostaa `export PGHOST=... PGDATABASE=...` -rivit (arvot lainattu)
#   pg_with <url> <komento> [arg...]    ajaa komennon aliprosessissa URL:n ympäristöllä
#   pg_url_with_db <url> <kanta>        sama URL toisella kannalla (vain polkuosa vaihtuu; salasanaa ei tulosteta
#                                       ellei URL:ssa ollut sitä, ja silloinkin vain muuttujaan)
#
# Tuetut osat: postgres(ql)://[käyttäjä[:salasana]@][isäntä][:portti]/kanta?host=&port=&user=&password=&sslmode=
# &sslrootcert=&sslcert=&sslkey=&connect_timeout=. Tuntematon query-avain tai `dbname` queryssä hylätään
# (vaiennettu asetus voisi ohjata yhteyden eri kantaan kuin URL:n polku väittää).
pg_url_env() {
  python3 - "$1" <<'PY'
import sys, shlex
from urllib.parse import urlsplit, unquote, parse_qsl
try:
    u = urlsplit(sys.argv[1])
    port = u.port
    hostname, username, password = u.hostname, u.username, u.password
except ValueError:
    # Virheviesti ei saa sisältää URL:n osia: jäsentäjän poikkeus voisi lainata salasanaa.
    sys.exit("pg-url: URL:ia ei voitu jäsentää (onko salasanassa koodaamaton # tai /?)")
if u.scheme not in ("postgres", "postgresql"):
    sys.exit("pg-url: URL:n pitää alkaa postgres:// tai postgresql://")
env = {}
if hostname: env["PGHOST"] = hostname
if port: env["PGPORT"] = str(port)
if username: env["PGUSER"] = unquote(username)
if password: env["PGPASSWORD"] = unquote(password)
db = unquote(u.path.lstrip("/"))
if db: env["PGDATABASE"] = db
allowed = {"host": "PGHOST", "port": "PGPORT", "user": "PGUSER", "password": "PGPASSWORD", "sslmode": "PGSSLMODE",
           "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY", "connect_timeout": "PGCONNECT_TIMEOUT"}
for k, v in parse_qsl(u.query, keep_blank_values=True):
    if k not in allowed:
        sys.exit("pg-url: tuntematon tai kielletty query-avain: " + k)
    env[allowed[k]] = v
if "PGDATABASE" not in env:
    sys.exit("pg-url: URL:ssa ei ole kannan nimeä")
for k, v in env.items():
    print("export %s=%s" % (k, shlex.quote(v)))
PY
}

pg_with() { # <url> <komento> [arg...]
  local url=$1 envs; shift
  envs=$(pg_url_env "$url") || return 2
  # Kutsujan ympäristö ei saa ohittaa URL:ia (PGSERVICE ja PGHOSTADDR voittaisivat URL:n isännän).
  ( unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGHOST PGPORT PGUSER PGPASSWORD PGPASSFILE PGDATABASE PGSSLMODE \
          PGSSLROOTCERT PGSSLCERT PGSSLKEY PGCONNECT_TIMEOUT
    eval "$envs"; exec "$@" )
}

pg_url_with_db() { # <url> <kanta>
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit, quote
u = urlsplit(sys.argv[1])
print(urlunsplit((u.scheme, u.netloc, "/" + quote(sys.argv[2], safe=""), u.query, "")))
PY
}
