#!/usr/bin/env bash
# outreach-window-report.sh — outreach-tila ennen ja jälkeen cutover-ikkunan (RK9-307).
# Vain luku: kantaan tehdään vain SELECT-kyselyitä. Ei lähetä postia eikä kutsu palvelinta.
#
# Käyttö:
#   DATABASE_URL=postgres://... scripts/outreach-window-report.sh snapshot [--label before|after] [--out <tiedosto.json>]
#   scripts/outreach-window-report.sh compare <before.json> <after.json> [--expect-paused]
#
# snapshot tulostaa ja tallentaa (--out):
#   - jonon syvyys: outreach_messages.status = 'queued' (sama kuin metriikan queueDepth) ja 'approved'
#   - lähetetyt viestit yhteensä ja viimeisin onnistunut lähetys (sent_at)
#   - aktiiviset lähettäjäpysäytykset (outreach_sender_pauses) ja järjestelmäpysäytys (SYSTEM_PAUSE)
#   - saapuneet vastaukset: email_messages inbound yhteensä, ja käsittelemättömät (route_key ja
#     issue_id tyhjiä; sama kysely kuin metriikka outreach_inbound_unrouted, RK9-234)
#   - outreach.reply_unmatched-rivit (RK9-235) ja kaksoiskappaleet (sama message_id kahdessa viestissä)
#
# compare päättelee kahdesta tilasta, hävisikö tai kaksinkertaistuiko viestejä:
#   HÄVIÖ     jonon lasku ei selity lähetysten lisäyksellä (queued_ennen - queued_jälkeen > sent_jälkeen - sent_ennen)
#   KAKSOIS   kaksoiskappale-message_id jälkeen-tilassa, tai lähetyksiä enemmän kuin jono pieneni
#             ja uusia jonoon nostettuja ei voi selittää (sent_delta > queued_lasku + approved_lasku)
#   INBOUND   saapuneiden vastausten määrä laski (vastaus ei säilynyt)
#   --expect-paused: lähetyksiä ei saa tulla lainkaan ikkunan aikana (sent_delta = 0)
# Poistumiskoodi: 0 = ei löydöksiä, 1 = löydös, 2 = käyttövirhe.
set -euo pipefail

die() { echo "[outreach-window-report] VIRHE: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq puuttuu"

MODE=${1:-}
[ -n "$MODE" ] || { sed -n '2,25p' "$0"; exit 2; }
shift || true

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
  'reply_unmatched', (SELECT count(*) FROM activity_log WHERE action = 'outreach.reply_unmatched')
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
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL puuttuu"
  command -v psql >/dev/null 2>&1 || die "psql puuttuu"
  json=$(psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on; $QUERY" | tail -n 1)
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
    umask 077
    printf '%s\n' "$json" >"$out"
    echo "  tallennettu: $out"
  fi
}

compare() {
  local before=${1:-} after=${2:-} expect_paused=0 findings=0
  [ -f "$before" ] && [ -f "$after" ] || die "compare vaatii kaksi JSON-tiedostoa"
  [ "${3:-}" != "--expect-paused" ] || expect_paused=1
  n() { jq -r ".$2" "$1"; }
  local q0 q1 a0 a1 s0 s1 i0 i1 u0 u1 dup1 r0 r1
  q0=$(n "$before" queued); q1=$(n "$after" queued)
  a0=$(n "$before" approved); a1=$(n "$after" approved)
  s0=$(n "$before" sent_total); s1=$(n "$after" sent_total)
  i0=$(n "$before" inbound_total); i1=$(n "$after" inbound_total)
  u0=$(n "$before" inbound_unrouted); u1=$(n "$after" inbound_unrouted)
  r0=$(n "$before" reply_unmatched); r1=$(n "$after" reply_unmatched)
  dup1=$(n "$after" duplicate_message_ids)
  local sent_delta=$((s1 - s0)) queue_drop=$((q0 - q1)) approved_drop=$((a0 - a1))

  echo "Ikkunan ero (ennen $(n "$before" taken_at) -> jälkeen $(n "$after" taken_at))"
  echo "  jono:        $q0 -> $q1"
  echo "  lähetetty:   $s0 -> $s1 (+$sent_delta)"
  echo "  vastaukset:  $i0 -> $i1 (+$((i1 - i0)))"
  echo "  unrouted:    $u0 -> $u1 (+$((u1 - u0)))"
  echo "  viimeisin lähetys: $(n "$before" last_sent_at) -> $(n "$after" last_sent_at)"

  if [ "$queue_drop" -gt "$sent_delta" ]; then
    echo "  HÄVIÖ: jono pieneni $queue_drop, mutta lähetyksiä tuli vain $sent_delta. Viestejä on kadonnut jonosta lähettämättä." >&2
    findings=$((findings + 1))
  fi
  if [ "$sent_delta" -gt $((queue_drop + approved_drop)) ] && [ "$sent_delta" -gt 0 ]; then
    echo "  KAKSOIS: lähetyksiä tuli $sent_delta, mutta jono ja hyväksytyt pienenivät yhteensä vain $((queue_drop + approved_drop))." >&2
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
  if [ "$expect_paused" = 1 ] && [ "$sent_delta" -ne 0 ]; then
    echo "  PYSÄYTYS: lähetyksiä tuli $sent_delta pysäytetyn ikkunan aikana." >&2
    findings=$((findings + 1))
  fi
  [ "$r1" -le "$r0" ] || echo "  HUOM: $((r1 - r0)) uutta reply_unmatched-riviä (vastaus pudotettu, ei säilytetty; RK9-235). Tarkista käsin."
  [ "$u1" -le "$u0" ] || echo "  HUOM: $((u1 - u0)) uutta käsittelemätöntä vastausta. Ne on tallennettu, mutta kukaan ei omista niitä: lisää email_routes-rivi."
  if [ "$findings" = 0 ]; then echo "  TULOS: ei löydöksiä (ei häviötä, ei kaksoiskappaleita, vastaukset säilyivät)"; return 0; fi
  echo "  TULOS: $findings löydöstä" >&2
  return 1
}

case "$MODE" in
  snapshot) snapshot "$@" ;;
  compare) compare "$@" ;;
  -h|--help) sed -n '2,25p' "$0" ;;
  *) die "tuntematon komento: $MODE (snapshot | compare)" ;;
esac
