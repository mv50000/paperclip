#!/usr/bin/env bash
# qmd-recall-remote.sh — recall from the RK9 second-brain vault from ANY host (e.g. skynet.rk9.fi),
# by calling the central recall API on the box that hosts the vault + qmd index + models. No vault
# clone, models, or qmd install needed on the calling host — it's a thin HTTP client.
#
# The server runs company-scoped semantic (vsearch) recall over `<company-slug>` + `<slug>-docs`
# + `shared`, derived server-side from the authenticated company (you can never reach another
# company's knowledge). See server/src/services/knowledge-recall.ts (RK9-17/C5 + cross-host).
#
# Env:
#   PAPERCLIP_API_BASE   base URL of the recall host (default https://paperclip.rk9.fi).
#                        Over Tailscale use e.g. http://<tailscale-ip>:<port>.
#   PAPERCLIP_API_TOKEN  a Paperclip board API key (Bearer) with access to the target company.
#   PAPERCLIP_COMPANY_ID the company UUID to scope recall to (e.g. RK9 holding for the operator brain).
#
# Usage:
#   qmd-recall-remote.sh "how do we deploy sunspot to prod"
#   PAPERCLIP_COMPANY_ID=<uuid> qmd-recall-remote.sh -n 8 "saatavilla auth csp bug"
#   qmd-recall-remote.sh --json "..."        # raw API JSON
set -euo pipefail

BASE="${PAPERCLIP_API_BASE:-https://paperclip.rk9.fi}"
TOKEN="${PAPERCLIP_API_TOKEN:?set PAPERCLIP_API_TOKEN to a Paperclip board API key}"
COMPANY="${PAPERCLIP_COMPANY_ID:?set PAPERCLIP_COMPANY_ID to the target company UUID}"
N=6
JSON=0
QUERY=""
# scope: "all" = operator mode (every collection: rk9 + shared + all <company>-docs); only honored
# server-side for instance-admin tokens, else silently company-scoped. Default "all" since this
# client is the operator's cross-host tool; pass --company-scope to restrict to PAPERCLIP_COMPANY_ID.
SCOPE=all
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) N="${2:?}"; shift 2;;
    --json) JSON=1; shift;;
    --company-scope) SCOPE=company; shift;;
    --all) SCOPE=all; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    -*) echo "qmd-recall-remote: unknown flag $1" >&2; exit 2;;
    *) QUERY="$1"; shift;;
  esac
done
[[ -z "$QUERY" ]] && { echo "usage: qmd-recall-remote.sh [-n N] [--company-scope] [--json] \"<query>\"" >&2; exit 2; }

# jq builds the JSON body safely (query may contain quotes/newlines).
body=$(jq -nc --arg q "$QUERY" --argjson n "$N" --arg s "$SCOPE" '{query:$q, limit:$n, scope:$s}')
resp=$(curl -fsS -X POST "$BASE/api/companies/$COMPANY/knowledge/recall" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body") || {
  echo "qmd-recall-remote: request failed (base/token/company/network?)" >&2; exit 1; }

if [[ "$JSON" == "1" ]]; then printf '%s\n' "$resp"; exit 0; fi

printf '%s' "$resp" | jq -r '
  if (.snippets | length) == 0 then "(no results)"
  else .snippets[] | "- [\(.score // "?" )] \(.title // "?")\n    \(.sourcePath)\n    \((.snippet // "") | gsub("@@[^\n]*@@";"") | gsub("\\s+";" ") | .[0:200])"
  end'
