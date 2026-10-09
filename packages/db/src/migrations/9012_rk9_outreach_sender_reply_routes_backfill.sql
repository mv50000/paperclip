-- Backfill: an outreach sender identity created after 9010 ran has no
-- inbound route. rk9@outreach.rk9.fi (26.9.2026) was one: its replies were
-- stored but never opened an issue or escalated, and an unthreadable reply to
-- it could not be tied to a company. The service now creates the route when a
-- sequence is created or its sender changes (sequences.ts); this catches the
-- identities that already exist. Same statement as 9010, idempotent.
INSERT INTO email_routes (company_id, local_part, domain, route_key, assigned_agent_id, auto_reply_template_id, escalate_after_hours, approval_required)
SELECT DISTINCT
  s.company_id,
  lower(split_part(s.sender_identity, '@', 1)),
  lower(split_part(s.sender_identity, '@', 2)),
  'outreach',
  NULL::uuid,
  NULL::uuid,
  24,
  true
FROM outreach_sequences s
WHERE s.sender_identity LIKE '%@%'
  AND split_part(s.sender_identity, '@', 1) <> ''
  AND split_part(s.sender_identity, '@', 2) <> ''
ON CONFLICT (company_id, local_part, domain) DO NOTHING;
