import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const riskPolicies = pgTable(
  "risk_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    categoryCode: text("category_code").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    thresholdJson: jsonb("threshold_json").$type<Record<string, unknown>>().notNull(),
    autoActions: jsonb("auto_actions").$type<string[]>(),
    escalationSev: text("escalation_sev"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCategoryUniqueIdx: uniqueIndex("risk_policies_company_category_unique_idx").on(
      table.companyId,
      table.categoryCode,
    ),
  }),
);
