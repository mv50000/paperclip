#!/usr/bin/env bash
# Process-adapter: validate a recent dev deployment by running health check
# after waiting for the latest workflow run to complete.
#
# Args:
#   $1 = company name (saatavilla, ololla, alli-audit, quantimodo, sunspot)
#
# Env:
#   GITHUB_TOKEN  Required for gh CLI
#   SLACK_WEBHOOK_URL  Optional webhook for failure alerts

set -euo pipefail

COMPANY="${1:?Usage: deploy-validate.sh <company>}"

declare -A REPO_MAP=(
  [saatavilla]="mv50000/saatavilla"
  [alli-audit]="mv50000/alli-audit"
  [quantimodo]="mv50000/quantimodo-rust"
  [ololla]="mv50000/bk"
  [sunspot]="mv50000/sunspot"
)
declare -A HEALTH_MAP=(
  [saatavilla]="https://saatavilla-dev.rk9.fi/api/health"
  [alli-audit]="https://alli-audit-dev.rk9.fi/"
  [quantimodo]="https://quantimodo-dev.rk9.fi/health"
  [ololla]="https://ololla-dev.rk9.fi/api/v1/health"
  [sunspot]="https://sunspot-dev.rk9.fi/api/health"
)

REPO="${REPO_MAP[$COMPANY]:-}"
HEALTH="${HEALTH_MAP[$COMPANY]:-}"
if [ -z "$REPO" ] || [ -z "$HEALTH" ]; then
  echo "Unknown company: $COMPANY"
  exit 2
fi

# Find latest deploy-dev workflow run
RUN_ID=$(gh run list --repo "$REPO" --workflow=deploy-dev.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")

if [ -z "$RUN_ID" ]; then
  echo "No deploy-dev runs found for $REPO"
  exit 0
fi

echo "Watching deploy run $RUN_ID for $REPO..."
gh run watch "$RUN_ID" --repo "$REPO" --exit-status 2>&1 || {
  echo "FAIL: Deploy workflow failed for $COMPANY"
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    msg=":x: Deploy failed for *$COMPANY*: https://github.com/$REPO/actions/runs/$RUN_ID"
    curl -sS -X POST -H "Content-type: application/json" \
      --data "$(printf '{"text":"%s"}' "$msg")" \
      "$SLACK_WEBHOOK_URL" >/dev/null
  fi
  exit 1
}

# Post-deploy health check
echo "Deploy succeeded, checking health: $HEALTH"
status=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 30 "$HEALTH" || echo "000")
if [[ "$status" =~ ^[23] ]]; then
  echo "OK: $COMPANY dev environment healthy ($status)"
  exit 0
fi

echo "FAIL: $COMPANY dev environment unhealthy after deploy ($status)"
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  msg=":warning: *$COMPANY* deploy succeeded but health check failed: $HEALTH returned $status"
  curl -sS -X POST -H "Content-type: application/json" \
    --data "$(printf '{"text":"%s"}' "$msg")" \
    "$SLACK_WEBHOOK_URL" >/dev/null
fi
exit 1
