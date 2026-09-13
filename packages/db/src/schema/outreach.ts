import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// RK9-193: outreach data model. Company-scoped prospects/sequences/messages/
// events; suppression is deliberately GLOBAL (see
// docs/implementation-notes/outreach-data-model.md).

export const outreachProspects = pgTable(
  "outreach_prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    orgName: text("org_name").notNull(),
    businessId: text("business_id"),
    /** Always stored lower-cased; unique per company. */
    email: text("email").notNull(),
    contactName: text("contact_name"),
    role: text("role"),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    legalBasis: text("legal_basis").notNull().default("b2b_legitimate_interest"),
    status: text("status").notNull().default("new"),
    // Reserved for RK9-196 (web/tech-stack enrichment) so it needs no follow-up migration.
    enrichment: jsonb("enrichment").notNull().default({}),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEmailUq: uniqueIndex("outreach_prospects_company_email_unique_idx").on(
      table.companyId,
      table.email,
    ),
    companyStatusIdx: index("outreach_prospects_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyBusinessIdIdx: index("outreach_prospects_company_business_id_idx").on(
      table.companyId,
      table.businessId,
    ),
    // Retention job (future cron): status='new' AND last_contacted_at IS NULL AND created_at < now()-180d.
    statusCreatedIdx: index("outreach_prospects_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  }),
);

export const outreachSequences = pgTable(
  "outreach_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    senderIdentity: text("sender_identity").notNull(),
    /** [{ dayOffset, templateId }] */
    steps: jsonb("steps").notNull().default([]),
    dailyCap: integer("daily_cap").notNull().default(20),
    /** { tz, days[], startHour, endHour } */
    sendWindow: jsonb("send_window")
      .notNull()
      .default({ tz: "Europe/Helsinki", days: [1, 2, 3, 4, 5], startHour: 8, endHour: 16 }),
    /** [{ fromDay, dailyCap }] warm-up ramp. */
    rampSchedule: jsonb("ramp_schedule").notNull().default([]),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("outreach_sequences_company_name_unique_idx").on(
      table.companyId,
      table.name,
    ),
    companyActiveIdx: index("outreach_sequences_company_active_idx").on(
      table.companyId,
      table.active,
    ),
  }),
);

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Denormalised from the prospect so list/approve queries stay company-scoped
    // without a join.
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => outreachProspects.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id").references(() => outreachSequences.id, { onDelete: "set null" }),
    step: integer("step").notNull().default(0),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    status: text("status").notNull().default("draft"),
    /** Actor id (user or agent) that approved/rejected. */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    // Reserved for RK9-196 review flow.
    rejectReason: text("reject_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** RFC 5322 Message-ID assigned at send time. */
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("outreach_messages_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    prospectIdx: index("outreach_messages_prospect_idx").on(table.prospectId),
    sequenceIdx: index("outreach_messages_sequence_idx").on(table.sequenceId),
    messageIdIdx: index("outreach_messages_message_id_idx").on(table.messageId),
  }),
);

export const outreachEvents = pgTable(
  "outreach_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => outreachProspects.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => outreachMessages.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeOccurredIdx: index("outreach_events_company_type_occurred_idx").on(
      table.companyId,
      table.type,
      table.occurredAt,
    ),
    prospectIdx: index("outreach_events_prospect_idx").on(table.prospectId),
    messageIdx: index("outreach_events_message_idx").on(table.messageId),
  }),
);

/**
 * GLOBAL suppression list — no company_id on purpose: an opt-out from one RK9
 * company applies to all of them (shared sender domain, one data controller).
 * Rows are never deleted (GDPR objection right, exempt from retention).
 */
export const outreachSuppressions = pgTable(
  "outreach_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Always lower-cased; unique. */
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    /** Which company recorded it — informational only, not a scope. */
    sourceCompanyId: uuid("source_company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailUq: uniqueIndex("outreach_suppressions_email_unique_idx").on(table.email),
  }),
);
