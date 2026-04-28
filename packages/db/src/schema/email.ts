import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const companyEmailConfig = pgTable(
  "company_email_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    primaryDomain: text("primary_domain").notNull(),
    sendingDomain: text("sending_domain").notNull(),
    mailProvider: text("mail_provider").notNull().default("resend"),
    resendDomainId: text("resend_domain_id"),
    defaultFromName: text("default_from_name"),
    status: text("status").notNull().default("pending"),
    maxPerAgentPerDay: integer("max_per_agent_per_day").notNull().default(50),
    maxPerCompanyPerDay: integer("max_per_company_per_day").notNull().default(500),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_email_config_company_unique_idx").on(table.companyId),
    primaryDomainUq: uniqueIndex("company_email_config_primary_domain_unique_idx").on(table.primaryDomain),
    statusIdx: index("company_email_config_status_idx").on(table.status),
  }),
);

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    locale: text("locale").notNull().default("fi"),
    subjectTpl: text("subject_tpl"),
    bodyMdTpl: text("body_md_tpl").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyLocaleUq: uniqueIndex("email_templates_company_key_locale_unique_idx").on(
      table.companyId,
      table.key,
      table.locale,
    ),
  }),
);

export const emailRoutes = pgTable(
  "email_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    domain: text("domain").notNull(),
    routeKey: text("route_key").notNull(),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    autoReplyTemplateId: uuid("auto_reply_template_id").references(() => emailTemplates.id, {
      onDelete: "set null",
    }),
    escalateAfterHours: integer("escalate_after_hours").notNull().default(24),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLocalDomainUq: uniqueIndex("email_routes_company_local_domain_unique_idx").on(
      table.companyId,
      table.localPart,
      table.domain,
    ),
    domainIdx: index("email_routes_domain_idx").on(table.domain),
  }),
);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    inReplyToId: uuid("in_reply_to_id").references((): AnyPgColumn => emailMessages.id, {
      onDelete: "set null",
    }),
    fromAddress: text("from_address").notNull(),
    toAddresses: text("to_addresses").array().notNull(),
    ccAddresses: text("cc_addresses").array().notNull().default([] as unknown as string[]),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtmlSanitized: text("body_html_sanitized"),
    attachments: jsonb("attachments").notNull().default([]),
    headers: jsonb("headers").notNull().default({}),
    routeKey: text("route_key"),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    autoRepliedAt: timestamp("auto_replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderMsgUq: uniqueIndex("email_messages_company_provider_message_unique_idx").on(
      table.companyId,
      table.providerMessageId,
    ),
    companyDirectionReceivedIdx: index("email_messages_company_direction_received_idx").on(
      table.companyId,
      table.direction,
      table.receivedAt,
    ),
    companyAssignedStatusIdx: index("email_messages_company_assigned_status_idx").on(
      table.companyId,
      table.assignedAgentId,
      table.status,
    ),
    providerMsgIdx: index("email_messages_provider_message_idx").on(table.providerMessageId),
  }),
);

export const emailOutboundAudit = pgTable(
  "email_outbound_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id"),
    toAddresses: text("to_addresses").array().notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject"),
    templateKey: text("template_key"),
    suppressionHit: boolean("suppression_hit").notNull().default(false),
    rateLimitHit: boolean("rate_limit_hit").notNull().default(false),
    providerMessageId: text("provider_message_id"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("email_outbound_audit_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    companyStatusCreatedIdx: index("email_outbound_audit_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
  }),
);

export const emailSuppressionList = pgTable(
  "email_suppression_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    reason: text("reason").notNull(),
    sourceMessageId: uuid("source_message_id").references((): AnyPgColumn => emailMessages.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAddressUq: uniqueIndex("email_suppression_list_company_address_unique_idx").on(
      table.companyId,
      table.address,
    ),
  }),
);

export const emailRateLimits = pgTable(
  "email_rate_limits",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({
      name: "email_rate_limits_pk",
      columns: [table.companyId, table.agentId, table.windowStart],
    }),
  }),
);
