#!/usr/bin/env bash
# qmd-recall-remote.sh — recall from the RK9 second-brain vault from ANY host (e.g. skynet.rk9.fi),
# by calling the central recall API on the box that hosts the vault + qmd index + models. No vault
# clone, models, or qmd install needed on the calling host — it's a thin HTTP client.
#
# The server runs company-scoped semantic (vsearch) recall over `<company-slug>` + `<slug>-docs`
# + `shared`, derived server-side from the authenticated company (you can never reach another
# company's knowledge). See server/src/services/knowledge-recall.ts (RK9-17/C5 + cross-host).
#
# Credentials (RK9-653): a per-host recall token, never a board key on a remote host.
#   ~/.config/rk9/recall.env (mode 600, written by rk9-coord-provision.sh recall <host>):
#     RK9_RECALL_URL         base URL of the recall host (e.g. http://paperclip:3100 over the tailnet)
#     RK9_RECALL_COMPANY_ID  the company UUID the token is bound to
#     RK9_RECALL_TOKEN       rk9_coord_... token with scope "recall"; it can call only the recall route
#   recall.env wins whenever it exists, also over a board key already in the environment.
#   Legacy, read only when recall.env is absent: ~/.config/rk9-recall.env or the environment with
#     PAPERCLIP_API_BASE (default https://paperclip.rk9.fi), PAPERCLIP_API_TOKEN (a board API key) and
#     PAPERCLIP_COMPANY_ID. RK9_RECALL_ENV=<file> loads that one file instead of both defaults.
#
# Usage:
#   qmd-recall-remote.sh "how do we deploy sunspot to prod"
#   PAPERCLIP_COMPANY_ID=<uuid> qmd-recall-remote.sh -n 8 "saatavilla auth csp bug"
#   qmd-recall-remote.sh --json "..."        # raw API JSON
set -euo pipefail

# Auto-load config so this works no matter how it's invoked (each Claude Code Bash tool call is a
# fresh shell -- never rely on the caller having sourced the env first).
# The per-host recall token wins (RK9-653): ~/.config/rk9/recall.env is loaded whenever it exists,
# even when a board key is already in the environment (a sourced legacy file, an exported key), so a
# provisioned host never sends the board key. The legacy file is read only without recall.env.
# shellcheck disable=SC1090  # the env file paths are chosen at run time
if [ -z "${RK9_RECALL_TOKEN:-}" ]; then
  if [ -n "${RK9_RECALL_ENV:-}" ]; then
    if [ -z "${PAPERCLIP_API_TOKEN:-}" ] && [ -f "$RK9_RECALL_ENV" ]; then set -a; . "$RK9_RECALL_ENV"; set +a; fi
  elif [ -f "$HOME/.config/rk9/recall.env" ]; then
    set -a; . "$HOME/.config/rk9/recall.env"; set +a
  elif [ -z "${PAPERCLIP_API_TOKEN:-}" ] && [ -f "$HOME/.config/rk9-recall.env" ]; then
    set -a; . "$HOME/.config/rk9-recall.env"; set +a
  fi
fi

if [ -n "${RK9_RECALL_TOKEN:-}" ]; then
  BASE="${RK9_RECALL_URL:-${PAPERCLIP_API_BASE:-https://paperclip.rk9.fi}}"
  TOKEN="$RK9_RECALL_TOKEN"
  COMPANY="${RK9_RECALL_COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}"
  [ -n "$COMPANY" ] || { echo "qmd-recall-remote: set RK9_RECALL_COMPANY_ID in ~/.config/rk9/recall.env" >&2; exit 2; }
else
  BASE="${PAPERCLIP_API_BASE:-https://paperclip.rk9.fi}"
  TOKEN="${PAPERCLIP_API_TOKEN:?no recall credential: run rk9-coord-provision.sh recall <host> on paperclip-01 (RK9-653)}"
  COMPANY="${PAPERCLIP_COMPANY_ID:?set PAPERCLIP_COMPANY_ID to the target company UUID}"
fi
N=6
JSON=0
QUERY=""
# scope: "all" = operator mode (every collection: rk9 + shared + all <company>-docs); honoured
# server-side only for instance-admin board keys and for a recall token that the operator issued
# with --recall-all (RK9-653), else silently company-scoped. Default "all" since this client is the
# operator's cross-host tool; pass --company-scope to restrict to the token's company.
SCOPE=all
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) N="${2:?}"; shift 2;;
    --json) JSON=1; shift;;
    --company-scope) SCOPE=company; shift;;
    --all) SCOPE=all; shift;;
    -h|--help) sed -n '2,23p' "$0"; exit 0;;
    -*) echo "qmd-recall-remote: unknown flag $1" >&2; exit 2;;
    *) QUERY="$1"; shift;;
  esac
done
[[ -z "$QUERY" ]] && { echo "usage: qmd-recall-remote.sh [-n N] [--company-scope] [--json] \"<query>\"" >&2; exit 2; }

# jq builds the JSON body safely (query may contain quotes/newlines).
body=$(jq -nc --arg q "$QUERY" --argjson n "$N" --arg s "$SCOPE" '{query:$q, limit:$n, scope:$s}')
# The token goes in through stdin (-H @-), not argv, so /proc/<pid>/cmdline never shows it (RK9-485).
resp=$(curl -fsS -X POST "$BASE/api/companies/$COMPANY/knowledge/recall" \
  -H @- -H "Content-Type: application/json" -d "$body" <<<"Authorization: Bearer $TOKEN") || {
  echo "qmd-recall-remote: request failed (base/token/company/network?)" >&2; exit 1; }

if [[ "$JSON" == "1" ]]; then printf '%s\n' "$resp"; exit 0; fi

printf '%s' "$resp" | jq -r '
  if (.snippets | length) == 0 then "(no results)"
  else .snippets[] | "- [\(.score // "?" )] \(.title // "?")\n    \(.sourcePath)\n    \((.snippet // "") | gsub("@@[^\n]*@@";"") | gsub("\\s+";" ") | .[0:200])"
  end'
