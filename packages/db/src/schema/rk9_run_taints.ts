// --- RK9 Custom (RK9-319) ---
// Server-side taint mark for a heartbeat run that received untrusted external
// content. Created by migration 9014. Monotonic: no code path clears a row.
import { pgTable, uuid, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** One reason a run was marked tainted. Holds references only, never content. */
export interface Rk9RunTaintSource {
  kind:
    | "email_inbound_wake"
    | "email_issue_context"
    | "email_body_read"
    | "propagated_wake"
    | "resumed_session";
  at: string;
  messageId?: string | null;
  issueId?: string | null;
  sourceRunId?: string | null;
  sessionId?: string | null;
}

export const rk9RunTaints = pgTable(
  "rk9_run_taints",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taintedAt: timestamp("tainted_at", { withTimezone: true }).notNull().defaultNow(),
    sources: jsonb("sources").$type<Rk9RunTaintSource[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("rk9_run_taints_company_agent_idx").on(
      table.companyId,
      table.agentId,
      table.taintedAt,
    ),
  }),
);
// --- /RK9 Custom ---
