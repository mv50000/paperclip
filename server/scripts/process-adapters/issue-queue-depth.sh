#!/usr/bin/env bash
# Process-adapter: alert if any company has too many unattended todo issues.
# Queries Paperclip DB directly.
#
# Env:
#   QUEUE_THRESHOLD     Per-company todo issue count that triggers alert (default 20)
#   SLACK_WEBHOOK_URL   Optional Slack webhook for alerts
#   DATABASE_URL        Optional override (default uses Paperclip local DB)

set -euo pipefail

THRESHOLD="${QUEUE_THRESHOLD:-20}"
DB_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:5432/paperclip}"

# Parse password and host from URL
PGPASSWORD_VAL=$(echo "$DB_URL" | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|')

readarray -t rows < <(PGPASSWORD="$PGPASSWORD_VAL" psql -h 127.0.0.1 -U paperclip -d paperclip -t -A -F'|' -c "
SELECT c.name, COUNT(i.id)
FROM companies c
LEFT JOIN issues i ON i.company_id = c.id AND i.status = 'todo'
WHERE c.status NOT IN ('archived', 'paused')
GROUP BY c.name
HAVING COUNT(i.id) >= $THRESHOLD
ORDER BY COUNT(i.id) DESC;
" 2>/dev/null)

if [ ${#rows[@]} -eq 0 ] || [ -z "${rows[0]}" ]; then
  echo "OK: no company over $THRESHOLD unattended todo issues"
  exit 0
fi

echo "Companies over threshold ($THRESHOLD):"
for row in "${rows[@]}"; do
  echo "  $row"
done

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  msg=":bar_chart: Issue queue depth alert (threshold $THRESHOLD):\n"
  for row in "${rows[@]}"; do
    company=$(echo "$row" | cut -d'|' -f1)
    count=$(echo "$row" | cut -d'|' -f2)
    msg+="- *$company*: $count todo issues\n"
  done
  curl -sS -X POST -H "Content-type: application/json" \
    --data "$(printf '{"text":"%s"}' "$msg")" \
    "$SLACK_WEBHOOK_URL" >/dev/null
fi

exit 1
