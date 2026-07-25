-- RK9-81/RK9-82: AI support desk hardening.
-- email_messages.classification: 'automated' marks inbound mail from
-- noreply/bulk senders — such messages get no auto-reply, no agent wakeup and
-- no CEO escalation (the July 2026 Instagram-notification lesson).
-- email_routes.approval_required: when true (default = trust-ramp posture),
-- an agent's outbound send/reply on this route is parked behind an
-- email_send approval and dispatched server-side on approve.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS classification text;
--> statement-breakpoint
ALTER TABLE email_routes ADD COLUMN IF NOT EXISTS approval_required boolean NOT NULL DEFAULT true;
