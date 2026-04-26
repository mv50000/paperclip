import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { riskCategories } from "./risk_categories.js";

export const riskEntries = pgTable(
  "risk_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull().references(() => riskCategories.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    severity: text("severity").notNull(),
    likelihood: text("likelihood").notNull().default("possible"),
    riskScore: integer("risk_score").notNull().default(0),
    source: text("source").notNull().default("monitor"),
    sourceMonitor: text("source_monitor"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastEvaluated: timestamp("last_evaluated", { withTimezone: true }).notNull().defaultNow(),
    mitigatedAt: timestamp("mitigated_at", { withTimezone: true }),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    evidenceJson: jsonb("evidence_json").$type<Record<string, unknown>>(),
    mitigationJson: jsonb("mitigation_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusSeverityIdx: index("risk_entries_company_status_severity_idx").on(
      table.companyId,
      table.status,
      table.severity,
    ),
    companyScopeIdx: index("risk_entries_company_scope_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
    ),
    companyCategoryStatusIdx: index("risk_entries_company_category_status_idx").on(
      table.companyId,
      table.categoryId,
      table.status,
    ),
  }),
);
