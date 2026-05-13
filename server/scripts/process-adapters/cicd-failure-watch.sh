#!/usr/bin/env bash
# Process-adapter: alert if any recent CI run failed in the past N hours.
#
# Env:
#   LOOKBACK_HOURS     How far back to scan (default 24)
#   SLACK_WEBHOOK_URL  Optional Slack webhook
#   GITHUB_TOKEN       Required (uses gh CLI)

set -euo pipefail

LOOKBACK="${LOOKBACK_HOURS:-24}"
SINCE=$(date -u -d "$LOOKBACK hours ago" +%Y-%m-%dT%H:%M:%SZ)

REPOS=(
  "mv50000/saatavilla"
  "mv50000/alli-audit"
  "mv50000/quantimodo-rust"
  "mv50000/bk"
  "mv50000/sunspot"
)

failures=()

for repo in "${REPOS[@]}"; do
  count=$(gh run list --repo "$repo" --status failure --created ">$SINCE" --limit 100 --json databaseId 2>/dev/null | python3 -c 'import sys, json; print(len(json.load(sys.stdin)))' 2>/dev/null || echo "0")
  if [ "$count" -gt 0 ]; then
    echo "FAIL: $repo has $count failed runs since $SINCE"
    latest=$(gh run list --repo "$repo" --status failure --created ">$SINCE" --limit 1 --json url,workflowName,displayTitle 2>/dev/null || echo "{}")
    failures+=("$repo: $count failure(s) | $latest")
  else
    echo "OK: $repo has no failures since $SINCE"
  fi
done

if [ ${#failures[@]} -gt 0 ] && [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  msg=":x: CI failures in last $LOOKBACK hours:\n"
  for f in "${failures[@]}"; do
    msg+="- $f\n"
  done
  curl -sS -X POST -H "Content-type: application/json" \
    --data "$(printf '{"text":"%s"}' "$msg")" \
    "$SLACK_WEBHOOK_URL" >/dev/null
fi

if [ ${#failures[@]} -gt 0 ]; then
  exit 1
fi
