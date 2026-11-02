// --- RK9 Custom (RK9-629): coord stall escalation bodies (epic RK9-620, key stall-escalator) ---
//
// Routes under /api/companies/:companyId/rk9/coord/escalations:
//   GET  /                 ?status=&limit=&nudges=   -> ledger rows (the shadow report)
//   POST /:escalationId/ack { status, channel_message_id?, error? } -> rk9claude delivery result
// Contract: docs/implementation-notes/coord-stall-escalator.md.
import { z } from "zod";

export const RK9_COORD_ESCALATION_STATUSES = ["reserved", "sent", "failed", "suppressed", "shadow"] as const;
export type Rk9CoordEscalationStatus = (typeof RK9_COORD_ESCALATION_STATUSES)[number];

/** Delivery results rk9claude may report for a reserved escalation. */
export const RK9_COORD_ESCALATION_ACK_STATUSES = ["sent", "failed"] as const;

/** GET /escalations */
export const rk9CoordEscalationListQuerySchema = z.object({
  status: z.enum(RK9_COORD_ESCALATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Include the holder-nudge rows (first stage); default false. */
  nudges: z.enum(["true", "false"]).optional(),
});
export type Rk9CoordEscalationListQuery = z.infer<typeof rk9CoordEscalationListQuerySchema>;

/** POST /escalations/:escalationId/ack (DB CHECKs: channel id <= 128, error <= 500). */
export const ackRk9CoordEscalationSchema = z.object({
  status: z.enum(RK9_COORD_ESCALATION_ACK_STATUSES),
  channel_message_id: z.string().trim().min(1).max(128).optional(),
  error: z.string().trim().min(1).max(500).optional(),
});
export type AckRk9CoordEscalation = z.infer<typeof ackRk9CoordEscalationSchema>;
// --- /RK9 Custom ---
