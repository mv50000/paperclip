// Postgres-backed daily token-bucket. The window is the UTC date for the call;
// each (companyId, agentId, windowStart) row holds the day's count. Atomic
// `INSERT ... ON CONFLICT DO UPDATE RETURNING` increments and returns the post-
// increment value; if it exceeds the limit we roll back by decrementing again
// and report the hit. The "company-level" counter uses the sentinel agent id
// COMPANY_AGENT_SENTINEL.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export const COMPANY_AGENT_SENTINEL = "00000000-0000-0000-0000-000000000000";

function todayWindowStart(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d;
}

async function bumpAndCheck(
  db: Db,
  companyId: string,
  agentKey: string,
  limit: number,
  windowStart: Date,
): Promise<{ ok: true; count: number } | { ok: false; count: number }> {
  // Single atomic upsert; the RETURNING clause gives us the new count.
  const rows = await db.execute(sql`
    INSERT INTO email_rate_limits (company_id, agent_id, window_start, count)
    VALUES (${companyId}::uuid, ${agentKey}::uuid, ${windowStart.toISOString()}::timestamptz, 1)
    ON CONFLICT (company_id, agent_id, window_start)
    DO UPDATE SET count = email_rate_limits.count + 1
    RETURNING count
  `);
  const count = Number((rows as unknown as { rows?: Array<{ count: number }> }).rows?.[0]?.count ?? 0);
  if (count > limit) {
    // Roll back the bump so retries with a different scope still see the right value.
    await db.execute(sql`
      UPDATE email_rate_limits
      SET count = count - 1
      WHERE company_id = ${companyId}::uuid
        AND agent_id = ${agentKey}::uuid
        AND window_start = ${windowStart.toISOString()}::timestamptz
    `);
    return { ok: false, count: count - 1 };
  }
  return { ok: true, count };
}

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; scope: "agent" | "company"; count: number; limit: number };

export async function checkAndConsumeRateLimit(
  db: Db,
  args: {
    companyId: string;
    agentId: string | null;
    perAgentPerDay: number;
    perCompanyPerDay: number;
  },
): Promise<RateLimitDecision> {
  const window = todayWindowStart();

  if (args.agentId) {
    const r = await bumpAndCheck(db, args.companyId, args.agentId, args.perAgentPerDay, window);
    if (!r.ok) {
      return { ok: false, scope: "agent", count: r.count, limit: args.perAgentPerDay };
    }
  }

  const c = await bumpAndCheck(
    db,
    args.companyId,
    COMPANY_AGENT_SENTINEL,
    args.perCompanyPerDay,
    window,
  );
  if (!c.ok) {
    // We already consumed the agent token; release it.
    if (args.agentId) {
      await db.execute(sql`
        UPDATE email_rate_limits
        SET count = count - 1
        WHERE company_id = ${args.companyId}::uuid
          AND agent_id = ${args.agentId}::uuid
          AND window_start = ${window.toISOString()}::timestamptz
      `);
    }
    return { ok: false, scope: "company", count: c.count, limit: args.perCompanyPerDay };
  }

  return { ok: true };
}
