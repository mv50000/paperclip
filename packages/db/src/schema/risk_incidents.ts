import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { riskEntries } from "./risk_entries.js";

export const riskIncidents = pgTable(
  "risk_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    riskEntryId: uuid("risk_entry_id").references(() => riskEntries.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("detected"),
    playbookCode: text("playbook_code"),
    autoActions: jsonb("auto_actions").$type<Record<string, unknown>[]>(),
    manualActions: jsonb("manual_actions").$type<Record<string, unknown>[]>(),
    timelineJson: jsonb("timeline_json").$type<Record<string, unknown>[]>().notNull().default([]),
    assignedTo: text("assigned_to"),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusSeverityIdx: index("risk_incidents_company_status_severity_idx").on(
      table.companyId,
      table.status,
      table.severity,
    ),
    riskEntryIdx: index("risk_incidents_risk_entry_idx").on(table.riskEntryId),
  }),
);
