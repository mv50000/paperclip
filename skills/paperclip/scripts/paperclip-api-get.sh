#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-api-get.sh PATH [--out FILE]

Sends GET $PAPERCLIP_API_URL/api/PATH and prints only the response body, so the
output pipes straight into jq. The HTTP status never mixes into the body: a
non-2xx answer exits 1 and reports the status and body on stderr.

Examples:
  scripts/paperclip-api-get.sh "issues/$PAPERCLIP_TASK_ID/heartbeat-context" | jq '.issue.status'
  scripts/paperclip-api-get.sh "issues/$PAPERCLIP_TASK_ID/comments?order=asc" --out comments.json
EOF
}

api_path=""
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      out="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$api_path" ]]; then
        printf 'Only one PATH is allowed.\n' >&2
        exit 1
      fi
      api_path="$1"
      shift
      ;;
  esac
done

if [[ -z "$api_path" ]]; then
  usage >&2
  exit 1
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL or PAPERCLIP_API_KEY.\n' >&2
  exit 1
fi

# PAPERCLIP_API_URL may or may not end in /api; PATH may or may not start with it.
base="${PAPERCLIP_API_URL%/}"
base="${base%/api}"
api_path="${api_path#/}"
api_path="${api_path#api/}"
url="$base/api/$api_path"

# Two attempts total, matching paperclip-issue-update.sh: retry a connection-level
# failure or 5xx once, never a definitive 4xx.
max_attempts=2
attempt=1
while :; do
  http_code=""
  body=""
  set +e
  response="$(
    curl -sS -m 30 "$url" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -w '\n%{http_code}'
  )"
  curl_exit=$?
  set -e

  if [[ "$curl_exit" -eq 0 ]]; then
    http_code="${response##*$'\n'}"
    body="${response%$'\n'*}"
  fi

  if [[ "$curl_exit" -eq 0 && "$http_code" == 2* ]]; then
    if [[ -n "$out" ]]; then
      printf '%s\n' "$body" >"$out"
    else
      printf '%s\n' "$body"
    fi
    exit 0
  fi

  if [[ "$curl_exit" -eq 0 && "$http_code" == 4* && "$http_code" != "429" ]] || (( attempt >= max_attempts )); then
    printf 'GET /api/%s failed (curl exit %s, HTTP %s).\n' "$api_path" "$curl_exit" "${http_code:-000}" >&2
    [[ -n "$body" ]] && printf '%s\n' "$body" >&2
    exit 1
  fi

  printf 'GET attempt %d/%d failed (curl exit %s, HTTP %s); retrying...\n' "$attempt" "$max_attempts" "$curl_exit" "${http_code:-000}" >&2
  sleep $((attempt * 2))
  attempt=$((attempt + 1))
done
