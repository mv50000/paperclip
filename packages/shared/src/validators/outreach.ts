import { z } from "zod";
import {
  OUTREACH_EVENT_TYPES,
  OUTREACH_LEGAL_BASES,
  OUTREACH_PROSPECT_SOURCES,
  OUTREACH_SUPPRESSION_REASONS,
  OUTREACH_TEMPLATE_COMPANIES,
} from "../constants.js";

// RK9-193: outreach module validators. Every write route in
// server/src/routes/outreach.ts runs through one of these via validate().

const EMAIL_MAX = 254;
// Deliberately simple: one "@", no whitespace, a dot in the domain part.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased, trimmed e-mail address. Suppression and uniqueness both key on this form. */
export const outreachEmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(EMAIL_MAX)
  .regex(EMAIL_RE, "invalid e-mail address")
  .transform((value) => value.toLowerCase());

const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

const businessIdSchema = z
  .string()
  .trim()
  .regex(/^\d{7}-\d$/, "business id must be NNNNNNN-N")
  .optional()
  .nullable();

export const createOutreachProspectSchema = z.object({
  orgName: z.string().trim().min(1).max(300),
  businessId: businessIdSchema,
  // RK9-196: a PRH import may land before any address is known — enrichment
  // or manual review fills it in later via PATCH. `null`/omitted both mean
  // "no address yet"; the row stays `status: "new"` until one is set.
  email: outreachEmailSchema.nullable().default(null),
  contactName: optionalText(200),
  role: optionalText(200),
  source: z.enum(OUTREACH_PROSPECT_SOURCES),
  sourceUrl: z.string().trim().url().max(2000).optional().nullable(),
  legalBasis: z.enum(OUTREACH_LEGAL_BASES).default("b2b_legitimate_interest"),
  enrichment: z.record(z.unknown()).optional(),
});
export type CreateOutreachProspect = z.infer<typeof createOutreachProspectSchema>;

export const updateOutreachProspectSchema = z
  .object({
    orgName: z.string().trim().min(1).max(300),
    businessId: businessIdSchema,
    // RK9-196: enrichment (Firecrawl) or manual review sets the address once
    // it is found; the service maps a unique-constraint hit to 409 `duplicate_email`.
    email: outreachEmailSchema.nullable(),
    contactName: optionalText(200),
    role: optionalText(200),
    sourceUrl: z.string().trim().url().max(2000).nullable(),
    // Only the manual review transition is exposed here; every other status is
    // driven by events (bounce/reply/unsubscribe) or by the sender (RK9-196).
    status: z.enum(["new", "approved"]),
    enrichment: z.record(z.unknown()),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "no fields to update" });
export type UpdateOutreachProspect = z.infer<typeof updateOutreachProspectSchema>;

export const importOutreachProspectsSchema = z.object({
  prospects: z.array(createOutreachProspectSchema).min(1).max(1000),
});
export type ImportOutreachProspects = z.infer<typeof importOutreachProspectsSchema>;

export const outreachSequenceStepSchema = z.object({
  dayOffset: z.number().int().min(0).max(365),
  templateId: z.string().trim().min(1).max(200),
});

export const outreachSendWindowSchema = z
  .object({
    tz: z.string().trim().min(1).max(64).default("Europe/Helsinki"),
    /** ISO weekday numbers, 1 = Monday … 7 = Sunday. */
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .default([1, 2, 3, 4, 5])
      .transform((days) => Array.from(new Set(days)).sort((a, b) => a - b)),
    startHour: z.number().int().min(0).max(23).default(8),
    endHour: z.number().int().min(1).max(24).default(16),
  })
  .refine((value) => value.startHour < value.endHour, {
    message: "startHour must be before endHour",
  });

export const outreachRampStepSchema = z.object({
  /** Days since the sequence was activated at which this cap applies. */
  fromDay: z.number().int().min(0).max(365),
  dailyCap: z.number().int().min(0).max(10_000),
});

const sequenceBase = z.object({
  name: z.string().trim().min(1).max(200),
  senderIdentity: outreachEmailSchema,
  steps: z.array(outreachSequenceStepSchema).max(50).default([]),
  dailyCap: z.number().int().min(0).max(10_000).default(20),
  sendWindow: outreachSendWindowSchema.default({}),
  rampSchedule: z.array(outreachRampStepSchema).max(50).default([]),
  active: z.boolean().default(false),
});

export const createOutreachSequenceSchema = sequenceBase;
export type CreateOutreachSequence = z.infer<typeof createOutreachSequenceSchema>;

export const updateOutreachSequenceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    senderIdentity: outreachEmailSchema,
    steps: z.array(outreachSequenceStepSchema).max(50),
    dailyCap: z.number().int().min(0).max(10_000),
    sendWindow: outreachSendWindowSchema,
    rampSchedule: z.array(outreachRampStepSchema).max(50),
    active: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "no fields to update" });
export type UpdateOutreachSequence = z.infer<typeof updateOutreachSequenceSchema>;

export const createOutreachMessageSchema = z.object({
  prospectId: z.string().uuid(),
  sequenceId: z.string().uuid().optional().nullable(),
  step: z.number().int().min(0).max(1000).default(0),
  subject: z.string().trim().min(1).max(998),
  bodyText: z.string().min(1).max(100_000),
  bodyHtml: z.string().max(500_000).optional().nullable(),
  inReplyTo: z.string().trim().max(998).optional().nullable(),
});
export type CreateOutreachMessage = z.infer<typeof createOutreachMessageSchema>;

export const approveOutreachMessageSchema = z.object({}).passthrough().optional();
export type ApproveOutreachMessage = z.infer<typeof approveOutreachMessageSchema>;

export const rejectOutreachMessageSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
export type RejectOutreachMessage = z.infer<typeof rejectOutreachMessageSchema>;

// RK9-196: edit a still-`draft` message before approving/rejecting it (the
// review tool's `e` action). Service re-checks `status = 'draft'` in the WHERE.
export const updateOutreachMessageSchema = z
  .object({
    subject: z.string().trim().min(1).max(998),
    bodyText: z.string().min(1).max(100_000),
    bodyHtml: z.string().max(500_000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "no fields to update" });
export type UpdateOutreachMessage = z.infer<typeof updateOutreachMessageSchema>;

// RK9-196: batch enrichment / drafting requests from the CLI. Bounded well
// below the 1000-row import cap — these calls do real network/LLM work.
export const enrichOutreachProspectsSchema = z.object({
  prospectIds: z.array(z.string().uuid()).min(1).max(200),
});
export type EnrichOutreachProspects = z.infer<typeof enrichOutreachProspectsSchema>;

export const draftOutreachMessagesSchema = z.object({
  prospectIds: z.array(z.string().uuid()).min(1).max(200),
  company: z.enum(OUTREACH_TEMPLATE_COMPANIES),
  maxCostUsd: z.number().positive().max(100).default(1),
});
export type DraftOutreachMessages = z.infer<typeof draftOutreachMessagesSchema>;

export const createOutreachEventSchema = z.object({
  prospectId: z.string().uuid(),
  messageId: z.string().uuid().optional().nullable(),
  type: z.enum(OUTREACH_EVENT_TYPES),
  payload: z.record(z.unknown()).default({}),
  occurredAt: z
    .coerce.date()
    .refine(
      (d) => d.getTime() > Date.UTC(2020, 0, 1) && d.getTime() < Date.now() + 24 * 3600 * 1000,
      "occurredAt out of range",
    )
    .optional(),
});
export type CreateOutreachEvent = z.infer<typeof createOutreachEventSchema>;

export const addOutreachSuppressionSchema = z.object({
  email: outreachEmailSchema,
  reason: z.enum(OUTREACH_SUPPRESSION_REASONS).default("manual"),
  note: z.string().trim().max(1000).optional().nullable(),
});
export type AddOutreachSuppression = z.infer<typeof addOutreachSuppressionSchema>;

export const checkOutreachSuppressionSchema = z.object({
  emails: z.array(outreachEmailSchema).min(1).max(1000),
});
export type CheckOutreachSuppression = z.infer<typeof checkOutreachSuppressionSchema>;
