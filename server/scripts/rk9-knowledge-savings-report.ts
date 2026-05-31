// RK9-18 (C6): heartbeat knowledge-recall token-savings measurement harness.
//
// Compares heartbeat token usage for an agent BEFORE vs WITH knowledge-recall
// injection, by splitting that agent's completed heartbeat runs into two groups:
//   - baseline:    runs with NO knowledge_recall_injection activity row
//   - with-recall: runs that DID inject a knowledge section (joined on run_id)
// and reporting the per-heartbeat input/output token deltas plus the injection's
// own logged metrics (injected tokens, recall latency, top score / precision proxy).
//
// IMPORTANT METHODOLOGY NOTE (read before quoting any number):
//   This script measures the HEARTBEAT-LEVEL cost of injection: injecting a
//   ~500-token "Knowledge Context" section ADDS input tokens to each heartbeat —
//   it is a cost, not a saving, at the heartbeat level. The headline "70–90%
//   savings" is a REPEATED-QUERY claim: when an agent would otherwise re-READ raw
//   memory files / the full flat MEMORY.md (~6.5K tokens) to answer a question, a
//   scoped recall (≤500 tokens) replaces that read → ~90% fewer tokens for THAT
//   operation. That saving shows up as FEWER/SMALLER tool-read turns inside the
//   session, not in the preamble. This harness quantifies (a) the injection's
//   fixed per-heartbeat add, and (b) whether output/total tokens trend down as the
//   agent stops re-reading raw files. See rk9-knowledge-savings-methodology.md.
//
// Usage:
//   pnpm tsx scripts/rk9-knowledge-savings-report.ts --agent <agentId>
//   pnpm tsx scripts/rk9-knowledge-savings-report.ts --agent-name CEO --days 14
//   pnpm tsx scripts/rk9-knowledge-savings-report.ts --json
//
// Environment:
//   DATABASE_URL - required (inherited from paperclip env)
//
// Exits 0 on success, 2 on script error.

import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";

interface Args {
  agentId?: string;
  agentName?: string;
  days: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 14, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") args.agentId = argv[++i];
    else if (a === "--agent-name") args.agentName = argv[++i];
    else if (a === "--days") args.days = Math.max(1, Number(argv[++i]) || 14);
    else if (a === "--json") args.json = true;
  }
  return args;
}

interface GroupRow {
  with_recall: boolean;
  n: number;
  avg_in: number;
  avg_out: number;
  avg_cached: number;
}

interface InjectionRow {
  n: number;
  avg_injected: number | null;
  avg_latency: number | null;
  avg_top_score: number | null;
  p95_latency: number | null;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL env var required");
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const db = createDb(dbUrl);
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  // Resolve the target agent(s).
  let agentIds: Array<{ id: string; name: string; role: string | null; companyId: string }> = [];
  if (args.agentId) {
    const rows = (await db.execute(
      sql`SELECT id, name, role, company_id AS "companyId" FROM agents WHERE id = ${args.agentId}`,
    )) as unknown as Array<{ id: string; name: string; role: string | null; companyId: string }>;
    agentIds = rows;
  } else if (args.agentName) {
    const rows = (await db.execute(
      sql`SELECT id, name, role, company_id AS "companyId" FROM agents WHERE name ILIKE ${"%" + args.agentName + "%"}`,
    )) as unknown as Array<{ id: string; name: string; role: string | null; companyId: string }>;
    agentIds = rows;
  } else {
    // Default: every agent that has injected at least once in the window.
    const rows = (await db.execute(
      sql`SELECT DISTINCT a.id, a.name, a.role, a.company_id AS "companyId"
          FROM agents a
          JOIN activity_log al ON al.agent_id = a.id
          WHERE al.action = 'knowledge_recall_injection' AND al.created_at >= ${since}`,
    )) as unknown as Array<{ id: string; name: string; role: string | null; companyId: string }>;
    agentIds = rows;
  }

  if (agentIds.length === 0) {
    console.error("No matching agents found (or none have injected recall yet in the window).");
    process.exit(0);
  }

  const reports = [];
  for (const agent of agentIds) {
    const groups = (await db.execute(sql`
      WITH runs AS (
        SELECT hr.id,
          COALESCE((hr.usage_json->>'inputTokens')::numeric, (hr.usage_json->>'input_tokens')::numeric, 0) AS input_tokens,
          COALESCE((hr.usage_json->>'outputTokens')::numeric, (hr.usage_json->>'output_tokens')::numeric, 0) AS output_tokens,
          COALESCE((hr.usage_json->>'cachedInputTokens')::numeric, (hr.usage_json->>'cached_input_tokens')::numeric, 0) AS cached_input_tokens,
          EXISTS (
            SELECT 1 FROM activity_log al
            WHERE al.run_id = hr.id AND al.action = 'knowledge_recall_injection'
          ) AS with_recall
        FROM heartbeat_runs hr
        WHERE hr.agent_id = ${agent.id} AND hr.status = 'completed' AND hr.started_at >= ${since}
      )
      SELECT with_recall,
        count(*)::int AS n,
        COALESCE(avg(input_tokens), 0) AS avg_in,
        COALESCE(avg(output_tokens), 0) AS avg_out,
        COALESCE(avg(cached_input_tokens), 0) AS avg_cached
      FROM runs GROUP BY with_recall
    `)) as unknown as GroupRow[];

    const injection = (await db.execute(sql`
      SELECT count(*)::int AS n,
        avg((details->>'injectedTokenEstimate')::numeric) AS avg_injected,
        avg((details->>'latencyMs')::numeric) AS avg_latency,
        avg((details->>'topScore')::numeric) AS avg_top_score,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY (details->>'latencyMs')::numeric) AS p95_latency
      FROM activity_log
      WHERE action = 'knowledge_recall_injection' AND agent_id = ${agent.id} AND created_at >= ${since}
    `)) as unknown as InjectionRow[];

    const baseline = groups.find((g) => !g.with_recall);
    const withRecall = groups.find((g) => g.with_recall);
    const inj = injection[0];

    const baselineIn = baseline ? num(baseline.avg_in) : null;
    const recallIn = withRecall ? num(withRecall.avg_in) : null;
    const inputDelta = baselineIn !== null && recallIn !== null ? recallIn - baselineIn : null;
    const inputDeltaPct = baselineIn && inputDelta !== null ? (inputDelta / baselineIn) * 100 : null;

    reports.push({
      agent: { id: agent.id, name: agent.name, role: agent.role, companyId: agent.companyId },
      windowDays: args.days,
      baseline: baseline ? { runs: baseline.n, avgInput: baselineIn, avgOutput: num(baseline.avg_out), avgCached: num(baseline.avg_cached) } : null,
      withRecall: withRecall ? { runs: withRecall.n, avgInput: recallIn, avgOutput: num(withRecall.avg_out), avgCached: num(withRecall.avg_cached) } : null,
      injection: inj
        ? {
            injections: inj.n,
            avgInjectedTokens: inj.avg_injected !== null ? Math.round(num(inj.avg_injected)) : null,
            avgRecallLatencyMs: inj.avg_latency !== null ? Math.round(num(inj.avg_latency)) : null,
            p95RecallLatencyMs: inj.p95_latency !== null ? Math.round(num(inj.p95_latency)) : null,
            avgTopScore: inj.avg_top_score !== null ? Number(num(inj.avg_top_score).toFixed(3)) : null,
          }
        : null,
      inputTokenDeltaPerHeartbeat: inputDelta !== null ? Math.round(inputDelta) : null,
      inputTokenDeltaPct: inputDeltaPct !== null ? Number(inputDeltaPct.toFixed(1)) : null,
    });
  }

  if (args.json) {
    console.log(JSON.stringify({ generatedAtWindowDays: args.days, reports }, null, 2));
    return;
  }

  for (const r of reports) {
    console.log(`\n=== ${r.agent.name} (${r.agent.role ?? "?"}) — last ${r.windowDays}d ===`);
    console.log(`  baseline runs (no recall): ${r.baseline?.runs ?? 0}  avg input=${r.baseline?.avgInput?.toFixed(0) ?? "-"}  avg output=${r.baseline?.avgOutput?.toFixed(0) ?? "-"}`);
    console.log(`  with-recall runs:          ${r.withRecall?.runs ?? 0}  avg input=${r.withRecall?.avgInput?.toFixed(0) ?? "-"}  avg output=${r.withRecall?.avgOutput?.toFixed(0) ?? "-"}`);
    if (r.injection) {
      console.log(`  injection: ${r.injection.injections} events  avg injected≈${r.injection.avgInjectedTokens} tok  recall latency avg=${r.injection.avgRecallLatencyMs}ms p95=${r.injection.p95RecallLatencyMs}ms  avg topScore=${r.injection.avgTopScore}`);
    }
    if (r.inputTokenDeltaPerHeartbeat !== null) {
      console.log(`  → input-token delta/heartbeat: ${r.inputTokenDeltaPerHeartbeat >= 0 ? "+" : ""}${r.inputTokenDeltaPerHeartbeat} (${r.inputTokenDeltaPct}%)`);
    } else {
      console.log(`  → need BOTH baseline and with-recall runs to compute a delta (let more heartbeats accrue).`);
    }
  }
  console.log("\nReminder: the heartbeat-level input delta is the injection COST. The 70–90% savings is the");
  console.log("repeated-query claim (recall ≤500 tok replaces a ~6.5K-tok raw-file read). See the methodology doc.");
}

main().catch((err) => {
  console.error("rk9-knowledge-savings-report failed:", err);
  process.exit(2);
});
