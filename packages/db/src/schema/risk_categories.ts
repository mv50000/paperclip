import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const riskCategories = pgTable(
  "risk_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    domain: text("domain").notNull(),
    defaultSeverity: text("default_severity").notNull(),
    isBuiltin: boolean("is_builtin").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCodeUniqueIdx: uniqueIndex("risk_categories_company_code_unique_idx").on(
      table.companyId,
      table.code,
    ),
    domainIdx: index("risk_categories_domain_idx").on(table.domain),
  }),
);
