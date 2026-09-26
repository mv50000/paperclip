#!/usr/bin/env bash
# upgrade-smoke.sh — RK9-forkin kykyjen savutesti upstream-päivityksen jokaisessa portaassa.
#
# Ajetaan harjoitusinstanssia vasten (ks. doc/UPSTREAM-UPGRADE.md, osio "Harjoitusinstanssi").
# Kaikki HTTP-tarkistukset ovat vain luku -tyyppisiä: pyynnöt ovat allekirjoittamattomia
# tai tuntemattomalla tokenilla, joten ne eivät lähetä postia, eivät reititä viestejä
# eivätkä muuta dataa. Tarkistus todistaa, että reitti on mountattu ja vastaa odotetusti
# (ei 404, ei 5xx).
#
# Käyttö:
#   scripts/upgrade-smoke.sh [--offline] [--fork-tests] [BASE_URL]
#
#   BASE_URL       oletus $PAPERCLIP_SMOKE_URL tai http://127.0.0.1:3100
#   --offline      vain repo-tarkistukset (migraatiojournal), ei HTTP:tä
#   --fork-tests   aja lisäksi doc/upgrade/fork-tests.txt:n vitest-tiedostot
#
# Valinnaiset ympäristömuuttujat:
#   PAPERCLIP_SMOKE_TOKEN       board-token; ilman sitä risk-reitiltä hyväksytään 401/403
#   PAPERCLIP_SMOKE_COMPANY_ID  yritys-id risk-reitille (oletus: nollauuid)
#   OUTREACH_METRICS_API_KEY    jos asetettu, digest ja /metrics vaaditaan 200:ksi
#
# Poistumiskoodi: 0 = kaikki ok, 1 = vähintään yksi tarkistus epäonnistui, 2 = käyttövirhe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFLINE=0
FORK_TESTS=0
BASE_URL="${PAPERCLIP_SMOKE_URL:-http://127.0.0.1:3100}"

for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --fork-tests) FORK_TESTS=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) echo "tuntematon valitsin: $arg" >&2; exit 2 ;;
    *) BASE_URL="$arg" ;;
  esac
done
BASE_URL="${BASE_URL%/}"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf 'ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }

# --- Migraatiojournal: 9001–9010 olemassa, järjestyksessä ja upstreamin rivien jälkeen ---
check_journal() {
  local out
  if out="$(node - "$REPO_ROOT" <<'NODE' 2>&1
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const dir = path.join(root, "packages/db/src/migrations");
const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
const tags = journal.entries.map((e) => e.tag);
const errors = [];
const expected = [];
for (let n = 9001; n <= 9010; n++) {
  const tag = tags.find((t) => t.startsWith(`${n}_`));
  if (!tag) { errors.push(`journal: ${n} puuttuu`); continue; }
  if (!fs.existsSync(path.join(dir, `${tag}.sql`))) errors.push(`${tag}.sql puuttuu`);
  expected.push(tag);
}
const custom = tags.filter((t) => /^9\d{3}_/.test(t));
if (custom.slice(0, expected.length).join() !== expected.join()) errors.push(`9xxx-järjestys väärä: ${custom.join(", ")}`);
const firstCustom = tags.findIndex((t) => /^9\d{3}_/.test(t));
const lastUpstream = tags.map((t) => /^0\d{3}_/.test(t)).lastIndexOf(true);
if (firstCustom !== -1 && lastUpstream > firstCustom) errors.push(`upstream-migraatio ${tags[lastUpstream]} on 9xxx-rivien jälkeen`);
journal.entries.forEach((e, i) => { if (e.idx !== i) errors.push(`idx ei juokse: ${e.tag} idx=${e.idx}, odotettu ${i}`); });
for (const f of fs.readdirSync(dir).filter((f) => /^9\d{3}_.*\.sql$/.test(f))) {
  if (!tags.includes(f.replace(/\.sql$/, ""))) errors.push(`${f} ei ole journalissa`);
}
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
console.log(`${custom.length} custom-migraatiota, viimeinen ${custom.at(-1)}`);
NODE
)"; then
    ok "migraatiojournal 9001–9010 ($out)"
  else
    fail "migraatiojournal: $out"
  fi
}

# --- HTTP-apurit ---
# http METHOD PATH [curl-args...] → tulostaa "STATUS<TAB>BODY(ensimmäiset 300 merkkiä)"
http() {
  local method="$1" path="$2"; shift 2
  local tmp status
  tmp="$(mktemp)"
  status="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 15 -X "$method" "$@" "$BASE_URL$path" 2>/dev/null)" || status=000
  printf '%s\t%s' "$status" "$(head -c 300 "$tmp" | tr '\n' ' ')"
  rm -f "$tmp"
}

# expect NAME "sallitut koodit" METHOD PATH [grep-regex-bodylle|-] [curl-args...]
expect() {
  local name="$1" codes="$2" method="$3" path="$4" body_re="$5"; shift 5
  local res status body
  res="$(http "$method" "$path" "$@")"
  status="${res%%$'\t'*}"
  body="${res#*$'\t'}"
  if [[ " $codes " != *" $status "* ]]; then
    fail "$name: $method $path → $status (odotettu: $codes) ${body:0:120}"
    return
  fi
  if [[ "$body_re" != "-" ]] && ! grep -qE "$body_re" <<<"$body"; then
    fail "$name: $method $path → $status, mutta runko ei vastaa /$body_re/: ${body:0:120}"
    return
  fi
  ok "$name ($method $path → $status)"
}

check_http() {
  local company="${PAPERCLIP_SMOKE_COMPANY_ID:-00000000-0000-0000-0000-000000000000}"
  local auth=()
  [[ -n "${PAPERCLIP_SMOKE_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $PAPERCLIP_SMOKE_TOKEN")

  expect "health" "200" GET /api/health -

  # github-webhooks: allekirjoituksetta 401; 503 = GITHUB_WEBHOOK_SECRET puuttuu (mountattu, ei konfiguroitu).
  expect "github-webhooks" "401 503" POST /api/github/webhooks '"error"' \
    -H 'Content-Type: application/json' -H 'X-GitHub-Event: ping' --data '{}'

  # Resend inbound: ilman svix-otsakkeita tenant-resoluutio hylkää → 401.
  expect "resend-inbound" "401" POST /api/webhooks/resend-inbound 'signature_verification_failed' \
    -H 'Content-Type: application/json' --data '{}'

  # SES inbound: SNS-kirjekuori puuttuu → 200 invalid_payload (ei allekirjoitustarkistusta, ei reititystä).
  expect "ses-inbound" "200" POST /api/webhooks/ses 'invalid_payload' \
    -H 'Content-Type: application/json' --data '{}'

  # Outreach digest + Prometheus-metriikat: bearer-avain; ilman avainta 401 (fail closed).
  if [[ -n "${OUTREACH_METRICS_API_KEY:-}" ]]; then
    expect "outreach-digest" "200" GET /api/outreach/digest - -H "Authorization: Bearer $OUTREACH_METRICS_API_KEY"
    expect "outreach-metrics" "200" GET /metrics 'outreach_' -H "Authorization: Bearer $OUTREACH_METRICS_API_KEY"
  else
    expect "outreach-digest" "401" GET /api/outreach/digest -
    # /metrics on /api:n ulkopuolella; 401 erottaa sen UI:n SPA-fallbackista (joka antaisi 200).
    expect "outreach-metrics" "401" GET /metrics -
  fi

  # Unsubscribe: tuntematon token palauttaa aina saman vahvistussivun eikä muuta dataa.
  expect "unsubscribe" "200" GET /u/upgrade-smoke-nonexistent-token 'peruuttanut'

  # Risk management: tokenilla 200/403/404 (yritysrajaus), ilman 401/403. 404 ilman tokenia = ei mountattu.
  if [[ ${#auth[@]} -gt 0 ]]; then
    expect "risk-summary" "200 403 404" GET "/api/companies/$company/risks/summary" - "${auth[@]}"
    expect "risk-board" "200 403" GET /api/board/risks - "${auth[@]}"
  else
    expect "risk-summary" "200 401 403" GET "/api/companies/$company/risks/summary" -
    expect "risk-board" "200 401 403" GET /api/board/risks -
  fi
}

check_fork_tests() {
  local list="$REPO_ROOT/doc/upgrade/fork-tests.txt"
  local files=()
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ -f "$REPO_ROOT/$line" ]]; then files+=("$line"); else fail "fork-testi puuttuu: $line"; fi
  done <"$list"
  if (cd "$REPO_ROOT" && npx vitest run "${files[@]}"); then
    ok "fork-testit (${#files[@]} tiedostoa)"
  else
    fail "fork-testit: vitest epäonnistui"
  fi
}

echo "upgrade-smoke: repo=$REPO_ROOT"
check_journal
if [[ $OFFLINE -eq 0 ]]; then
  echo "upgrade-smoke: BASE_URL=$BASE_URL"
  check_http
fi
[[ $FORK_TESTS -eq 1 ]] && check_fork_tests

echo "upgrade-smoke: $PASS ok, $FAIL epäonnistui"
[[ $FAIL -eq 0 ]]
