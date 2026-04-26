import { index, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const riskSnapshots = pgTable(
  "risk_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    overallScore: integer("overall_score").notNull(),
    domainScores: jsonb("domain_scores").$type<Record<string, number>>().notNull(),
    openRisks: integer("open_risks").notNull(),
    openIncidents: integer("open_incidents").notNull(),
    detailsJson: jsonb("details_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySnapshotIdx: index("risk_snapshots_company_snapshot_idx").on(
      table.companyId,
      table.snapshotAt,
    ),
  }),
);
