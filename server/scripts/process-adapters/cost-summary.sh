#!/usr/bin/env bash
# Process-adapter: päivittäinen kulutusyhteenveto migration-aikaiseen seurantaan.
# Lähettää Slack-yhteenvedon Paperclip-agenttien kustannuksista per yritys.
#
# Env:
#   SLACK_WEBHOOK_URL  Optional webhook (jos ei, tulostaa vain stdoutiin)
#   LOOKBACK_DAYS      Aikaikkuna kustannustietoihin (default 1)

set -euo pipefail

LOOKBACK="${LOOKBACK_DAYS:-1}"
PGPASSWORD=paperclip

# Per-yritys yhteenveto
SUMMARY=$(PGPASSWORD=paperclip psql -h 127.0.0.1 -U paperclip -d paperclip -t -A -F'|' -c "
SELECT c.name,
       COALESCE(SUM(a.spent_monthly_cents) FILTER (WHERE a.status NOT IN ('paused','terminated')), 0) AS company_spent_cents,
       COALESCE(SUM(a.budget_monthly_cents) FILTER (WHERE a.status NOT IN ('paused','terminated')), 0) AS company_budget_cents,
       COUNT(*) FILTER (WHERE a.status NOT IN ('paused','terminated') AND a.adapter_type='claude_local') AS active_agents
FROM companies c
LEFT JOIN agents a ON a.company_id = c.id
WHERE c.status NOT IN ('archived')
GROUP BY c.name
ORDER BY c.name;
" 2>/dev/null)

# Recent run summary
RUNS=$(PGPASSWORD=paperclip psql -h 127.0.0.1 -U paperclip -d paperclip -t -A -c "
SELECT
  COUNT(*) FILTER (WHERE status='succeeded') AS ok,
  COUNT(*) FILTER (WHERE status='failed') AS fail,
  COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
  COUNT(*) FILTER (WHERE status='timed_out') AS timeout
FROM heartbeat_runs
WHERE created_at > NOW() - INTERVAL '$LOOKBACK days';
" 2>/dev/null | tr '|' ' ')

OK_COUNT=$(echo "$RUNS" | awk '{print $1}')
FAIL_COUNT=$(echo "$RUNS" | awk '{print $2}')
CANCEL_COUNT=$(echo "$RUNS" | awk '{print $3}')
TIMEOUT_COUNT=$(echo "$RUNS" | awk '{print $4}')

MSG=":bar_chart: *Paperclip cost summary (last $LOOKBACK day(s))*\\n\\n"
MSG+="*Heartbeat runs:* :white_check_mark: $OK_COUNT ok, :x: $FAIL_COUNT fail, :ghost: $CANCEL_COUNT cancelled, :hourglass: $TIMEOUT_COUNT timeout\\n\\n"
MSG+="*Per company:*\\n"

total_spent=0
total_budget=0
while IFS='|' read -r name spent_cents budget_cents agents; do
  [ -z "$name" ] && continue
  spent_eur=$(awk "BEGIN { printf \"%.2f\", $spent_cents/100 }")
  budget_eur=$(awk "BEGIN { printf \"%.2f\", $budget_cents/100 }")
  MSG+="• *$name* (${agents} active): \$${spent_eur} / \$${budget_eur}\\n"
  total_spent=$((total_spent + spent_cents))
  total_budget=$((total_budget + budget_cents))
done <<< "$SUMMARY"

total_spent_eur=$(awk "BEGIN { printf \"%.2f\", $total_spent/100 }")
total_budget_eur=$(awk "BEGIN { printf \"%.2f\", $total_budget/100 }")
pct=$(awk "BEGIN { if ($total_budget > 0) printf \"%.1f\", $total_spent/$total_budget*100; else print \"0\" }")
MSG+="\\n*Yhteensa:* \$${total_spent_eur} / \$${total_budget_eur} (${pct}%)"

echo -e "${MSG//\\n/$'\n'}"

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  curl -sS -X POST -H "Content-type: application/json" \
    --data "$(printf '{"text":"%s"}' "$MSG")" \
    "$SLACK_WEBHOOK_URL" >/dev/null
fi
