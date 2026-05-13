#!/usr/bin/env bash
# Process-adapter: dev health check for all RK9 yritykset.
# Posts a Slack alert if any company's dev environment is unreachable.
#
# Env (optional):
#   SLACK_WEBHOOK_URL  Slack incoming webhook for alerts
#   ALERT_ON_OK        If set, also post when all healthy (default: alert only on failures)

set -euo pipefail

declare -A TARGETS=(
  [saatavilla]="https://saatavilla-dev.rk9.fi/api/health"
  [alli-audit]="https://alli-audit-dev.rk9.fi/"
  [quantimodo]="https://quantimodo-dev.rk9.fi/health"
  [ololla]="https://ololla-dev.rk9.fi/api/v1/health"
  [sunspot]="https://sunspot-dev.rk9.fi/api/health"
)

failures=()

for company in "${!TARGETS[@]}"; do
  url="${TARGETS[$company]}"
  status=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "$url" || echo "000")
  if [[ "$status" =~ ^[23] ]]; then
    echo "OK: $company → $url ($status)"
  else
    echo "FAIL: $company → $url ($status)"
    failures+=("$company ($url returned $status)")
  fi
done

if [ ${#failures[@]} -gt 0 ] && [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  msg=":warning: Dev health check failures:\n$(printf -- '- %s\n' "${failures[@]}")"
  curl -sS -X POST -H "Content-type: application/json" \
    --data "$(printf '{"text":"%s"}' "$msg")" \
    "$SLACK_WEBHOOK_URL" >/dev/null
fi

if [ ${#failures[@]} -gt 0 ]; then
  exit 1
fi
