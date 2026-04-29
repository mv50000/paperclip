-- RK9: Backfill — resolve orphaned incidents whose linked risk entry is already closed
UPDATE risk_incidents SET
  status = 'resolved',
  resolved_at = NOW(),
  resolution_note = 'Auto-resolved: linked risk entry was already closed (backfill)',
  timeline_json = timeline_json || jsonb_build_array(jsonb_build_object(
    'timestamp', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor', 'risk-monitor',
    'action', 'resolved',
    'detail', 'Auto-resolved: linked risk entry was already closed (backfill)'
  )),
  updated_at = NOW()
WHERE status IN ('detected', 'acknowledged', 'investigating', 'mitigating')
  AND risk_entry_id IS NOT NULL
  AND risk_entry_id IN (SELECT id FROM risk_entries WHERE status IN ('closed', 'mitigated'));
