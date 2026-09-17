-- RK9-234: give every outreach sender identity a CS-desk route, so a prospect's
-- reply opens a Paperclip issue instead of landing unowned.
--
-- Replies arrive at the SHARED outreach domain (saatavilla@outreach.rk9.fi),
-- never at the company's own domain, so no existing route could ever match.
-- Derived from outreach_sequences rather than hardcoded ids: the row belongs to
-- whichever company actually sends under that identity.
--
-- assigned_agent_id and auto_reply_template_id are deliberately NULL:
--   * NULL agent  -> the issue lands in backlog for the operator, and no agent
--     run is burned on a sales reply.
--   * NULL template -> no robot ever auto-answers a prospect. A warm reply to a
--     cold outreach mail is the one thing a human must handle.
-- escalate_after_hours 24: an unanswered reply emails the operator after a day
-- (email/escalation.ts joins email_routes, so an unrouted message never escalates).
INSERT INTO email_routes (company_id, local_part, domain, route_key, assigned_agent_id, auto_reply_template_id, escalate_after_hours, approval_required)
SELECT DISTINCT
  s.company_id,
  lower(split_part(s.sender_identity, '@', 1)),
  lower(split_part(s.sender_identity, '@', 2)),
  'outreach',
  -- Bare NULLs in an INSERT ... SELECT are inferred as text, which the uuid
  -- columns reject — cast them explicitly.
  NULL::uuid,
  NULL::uuid,
  24,
  true
FROM outreach_sequences s
WHERE s.sender_identity LIKE '%@%'
  AND split_part(s.sender_identity, '@', 1) <> ''
  AND split_part(s.sender_identity, '@', 2) <> ''
ON CONFLICT (company_id, local_part, domain) DO NOTHING;
