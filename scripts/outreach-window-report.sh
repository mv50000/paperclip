#!/usr/bin/env bash
# outreach-window-report.sh — outreach-tila ennen ja jälkeen cutover-ikkunan (RK9-307).
# Vain luku: kantaan tehdään vain SELECT-kyselyitä (read-only-transaktio). Ei lähetä postia eikä
# kutsu palvelinta. Salasana ei näy prosessilistassa (lib-pg-url.sh).
#
# Käyttö:
#   DATABASE_URL=postgres://... scripts/outreach-window-report.sh snapshot [--label before|after] [--out <tiedosto.json>]
#   scripts/outreach-window-report.sh compare <before.json> <after.json> [--expect-paused]
#   DATABASE_URL=postgres://... scripts/outreach-window-report.sh export --since <ISO-aika> --out <hakemisto>
#
# snapshot tulostaa ja tallentaa (--out, 0600):
#   - jonon syvyys: outreach_messages.status = 'queued' (sama kuin metriikan queueDepth) ja 'approved'
#   - lähetetyt viestit yhteensä ja viimeisin onnistunut lähetys (sent_at)
#   - aktiiviset lähettäjäpysäytykset (outreach_sender_pauses) ja järjestelmäpysäytys (SYSTEM_PAUSE)
#   - saapuneet vastaukset: email_messages inbound yhteensä, ja käsittelemättömät (route_key ja
#     issue_id tyhjiä; sama kysely kuin metriikka outreach_inbound_unrouted, RK9-234)
#   - outreach.reply_unmatched-rivit (RK9-235) ja kaksoiskappaleet (sama message_id kahdessa viestissä)
#   - jokaisen outreach-viestin (id, status, message_id), jotta compare vertaa viestejä yksitellen
#
# compare vertaa viestejä id:llä, ei laskureilla (laskuri ei erota uutta luonnosta häviöstä):
#   HÄVIÖ     viesti, joka oli ennen tilassa queued, approved tai sent, puuttuu jälkeen-tilasta kokonaan
#   KAKSOIS   lähetetty viesti on jälkeen-tilassa jokin muu kuin sent (jono voi lähettää sen uudelleen),
#             tai sama message_id on useammassa viestissä
#   INBOUND   saapuneiden vastausten määrä laski (vastaus ei säilynyt)
#   PYSÄYTYS  --expect-paused: lähetettyjen viestien määrä muuttui ikkunan aikana
#   Normaali päivä (uusi luonnos hyväksytään ja lähetetään) ei ole löydös.
#
# export --since <aika> --out <hakemisto> tallentaa CSV:nä kaikki ikkunan aikana syntyneet tai muuttuneet
# outreach-, suppression- ja saapuvan postin rivit (rollbackin data: runbook, osio Rollback).
# Poistumiskoodi: 0 = ei löydöksiä, 1 = löydös, 2 = käyttövirhe.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
die() { echo "[outreach-window-report] VIRHE: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq puuttuu"

MODE=${1:-}
[ -n "$MODE" ] || { sed -n '2,35p' "$0"; exit 2; }
shift || true

need_db() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL puuttuu"
  command -v psql >/dev/null 2>&1 || die "psql puuttuu"
  command -v python3 >/dev/null 2>&1 || die "python3 puuttuu"
  # shellcheck source=lib-pg-url.sh
  . "$HERE/lib-pg-url.sh"
  pg_url_env "$DATABASE_URL" >/dev/null || die "DATABASE_URL:ia ei voitu jäsentää"
}
# Kaikki kyselyt read-only-transaktiossa.
ro_psql() { PGOPTIONS="-c default_transaction_read_only=on" pg_with "$DATABASE_URL" psql -qAt -v ON_ERROR_STOP=1 "$@"; }

QUERY=$(cat <<'SQL'
SELECT json_build_object(
  'queued',        (SELECT count(*) FROM outreach_messages WHERE status = 'queued'),
  'approved',      (SELECT count(*) FROM outreach_messages WHERE status = 'approved'),
  'sent_total',    (SELECT count(*) FROM outreach_messages WHERE status = 'sent'),
  'last_sent_at',  (SELECT max(sent_at) FROM outreach_messages WHERE status = 'sent'),
  'duplicate_message_ids', (SELECT count(*) FROM (
      SELECT message_id FROM outreach_messages WHERE message_id IS NOT NULL
      GROUP BY message_id HAVING count(*) > 1) d),
  'active_sender_pauses', (SELECT count(*) FROM outreach_sender_pauses WHERE resumed_at IS NULL),
  'system_paused', (SELECT jsonb_typeof(general -> 'systemPause') = 'object'
                    FROM instance_settings WHERE singleton_key = 'default'),
  'paused_companies', (SELECT count(*) FROM companies WHERE status = 'paused'),
  'inbound_total', (SELECT count(*) FROM email_messages WHERE direction = 'inbound'),
  'inbound_unrouted', (SELECT count(*) FROM email_messages
                       WHERE direction = 'inbound' AND route_key IS NULL AND issue_id IS NULL),
  'reply_unmatched', (SELECT count(*) FROM activity_log WHERE action = 'outreach.reply_unmatched'),
  'messages',      (SELECT coalesce(json_agg(json_build_array(id, status, message_id)), '[]'::json) FROM outreach_messages)
)
SQL
)

snapshot() {
  local label="" out="" json
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) label=${2:-}; shift 2 ;;
      --out) out=${2:-}; shift 2 ;;
      *) die "tuntematon valitsin: $1" ;;
    esac
  done
  need_db
  json=$(ro_psql -c "$QUERY" | tail -n 1)
  json=$(jq -c --arg label "$label" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {label: $label, taken_at: $at}' <<<"$json")
  jq -r '"Outreach-tila" + (if .label != "" then " (" + .label + ")" else "" end) + " " + .taken_at,
    "  jono (queued):              \(.queued)",
    "  hyväksytty, ei jonossa:     \(.approved)",
    "  lähetetty yhteensä:         \(.sent_total)",
    "  viimeisin onnistunut lähetys: \(.last_sent_at // "ei koskaan")",
    "  kaksoiskappale-message_id:  \(.duplicate_message_ids)",
    "  aktiiviset lähettäjäpysäytykset: \(.active_sender_pauses)",
    "  järjestelmäpysäytys (SYSTEM_PAUSE): \(if .system_paused then "päällä" else "pois" end)",
    "  pysäytetyt yritykset:       \(.paused_companies)",
    "  saapuneet vastaukset yht.:  \(.inbound_total)",
    "  käsittelemättömät vastaukset (unrouted): \(.inbound_unrouted)",
    "  reply_unmatched (pudotettu): \(.reply_unmatched)"' <<<"$json"
  if [ -n "$out" ]; then
    ( umask 077; printf '%s\n' "$json" >"$out" )
    echo "  tallennettu: $out"
  fi
}

compare() {
  local before=${1:-} after=${2:-} expect_paused=0 findings=0
  [ -f "$before" ] && [ -f "$after" ] || die "compare vaatii kaksi JSON-tiedostoa"
  [ "${3:-}" != "--expect-paused" ] || expect_paused=1
  n() { jq -r ".$2" "$1"; }
  local i0 i1 u0 u1 r0 r1 dup1 s0 s1 diff lost reverted moved
  i0=$(n "$before" inbound_total); i1=$(n "$after" inbound_total)
  u0=$(n "$before" inbound_unrouted); u1=$(n "$after" inbound_unrouted)
  r0=$(n "$before" reply_unmatched); r1=$(n "$after" reply_unmatched)
  s0=$(n "$before" sent_total); s1=$(n "$after" sent_total)
  dup1=$(n "$after" duplicate_message_ids)

  # Viestikohtainen vertailu id:llä.
  diff=$(jq -n --slurpfile b "$before" --slurpfile a "$after" '
    def m: map({key: (.[0] | tostring), value: .[1]}) | from_entries;
    ($b[0].messages | m) as $B | ($a[0].messages | m) as $A |
    {
      lost:     [$B | to_entries[] | select((.value == "queued" or .value == "approved" or .value == "sent") and ($A[.key] == null)) | .key],
      reverted: [$B | to_entries[] | select(.value == "sent" and $A[.key] != null and $A[.key] != "sent") | .key],
      moved:    [$B | to_entries[] | select((.value == "queued" or .value == "approved") and $A[.key] == "sent") | .key]
    }')
  lost=$(jq '.lost | length' <<<"$diff"); reverted=$(jq '.reverted | length' <<<"$diff"); moved=$(jq '.moved | length' <<<"$diff")

  echo "Ikkunan ero (ennen $(n "$before" taken_at) -> jälkeen $(n "$after" taken_at))"
  echo "  jono:        $(n "$before" queued) -> $(n "$after" queued)   hyväksytty: $(n "$before" approved) -> $(n "$after" approved)"
  echo "  lähetetty:   $s0 -> $s1 (+$((s1 - s0))); ikkunan aikana jonosta lähteneitä: $moved"
  echo "  vastaukset:  $i0 -> $i1 (+$((i1 - i0)))"
  echo "  unrouted:    $u0 -> $u1 (+$((u1 - u0)))"
  echo "  viimeisin lähetys: $(n "$before" last_sent_at) -> $(n "$after" last_sent_at)"

  if [ "$lost" -gt 0 ]; then
    echo "  HÄVIÖ: $lost viestiä oli ennen tilassa queued/approved/sent ja puuttuu nyt kokonaan: $(jq -r '.lost[:5] | join(", ")' <<<"$diff")" >&2
    findings=$((findings + 1))
  fi
  if [ "$reverted" -gt 0 ]; then
    echo "  KAKSOIS: $reverted lähetettyä viestiä ei ole enää tilassa sent (jono voi lähettää ne uudelleen): $(jq -r '.reverted[:5] | join(", ")' <<<"$diff")" >&2
    findings=$((findings + 1))
  fi
  if [ "$dup1" -gt 0 ]; then
    echo "  KAKSOIS: $dup1 message_id:tä esiintyy useammassa viestissä." >&2
    findings=$((findings + 1))
  fi
  if [ "$i1" -lt "$i0" ]; then
    echo "  INBOUND: saapuneita vastauksia oli ennen $i0 ja jälkeen $i1. Vastaus ei säilynyt (RK9-234: talleta ennen reititystä)." >&2
    findings=$((findings + 1))
  fi
  if [ "$expect_paused" = 1 ] && [ "$s1" -ne "$s0" ]; then
    echo "  PYSÄYTYS: lähetettyjen määrä muuttui $s0 -> $s1 pysäytetyn ikkunan aikana." >&2
    findings=$((findings + 1))
  fi
  [ "$r1" -le "$r0" ] || echo "  HUOM: $((r1 - r0)) uutta reply_unmatched-riviä (vastaus pudotettu, ei säilytetty; RK9-235). Tarkista käsin."
  [ "$u1" -le "$u0" ] || echo "  HUOM: $((u1 - u0)) uutta käsittelemätöntä vastausta. Ne on tallennettu, mutta kukaan ei omista niitä: lisää email_routes-rivi."
  if [ "$findings" = 0 ]; then echo "  TULOS: ei löydöksiä (ei häviötä, ei kaksoiskappaleita, vastaukset säilyivät)"; return 0; fi
  echo "  TULOS: $findings löydöstä" >&2
  return 1
}

export_window() {
  local since="" out="" t spec file rows
  while [ $# -gt 0 ]; do
    case "$1" in
      --since) since=${2:-}; shift 2 ;;
      --out) out=${2:-}; shift 2 ;;
      *) die "tuntematon valitsin: $1" ;;
    esac
  done
  [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T\ ][0-9:.]+(Z|[+-][0-9:]+)?)?$ ]] || die "--since puuttuu tai ei ole ISO-aika (esim. 2026-10-04T05:00:00Z)"
  [ -n "$out" ] || die "--out puuttuu"
  need_db
  ( umask 077; mkdir -p "$out" ); chmod 700 "$out"
  # Taulu:aikasarake. created_at riittää taulussa, jonka rivejä ei päivitetä.
  for spec in outreach_suppressions:created_at outreach_events:created_at email_messages:created_at \
              outreach_prospects:updated_at outreach_messages:updated_at outreach_sender_pauses:updated_at; do
    t=${spec%%:*}; file="$out/$t.csv"
    ( umask 077; ro_psql -c "\\copy (SELECT * FROM public.\"$t\" WHERE ${spec##*:} >= '$since') TO '$file' CSV HEADER" >/dev/null )
    rows=$(( $(wc -l <"$file") - 1 ))
    echo "  $t: $rows riviä -> $file"
  done
  echo "  valmis: $out (0700, tiedostot 0600). Sisältää henkilötietoja (sähköpostit, viestien tekstit); säilytä kuten dumppi."
}

case "$MODE" in
  snapshot) snapshot "$@" ;;
  compare) compare "$@" ;;
  export) export_window "$@" ;;
  -h|--help) sed -n '2,35p' "$0" ;;
  *) die "tuntematon komento: $MODE (snapshot | compare | export)" ;;
esac
