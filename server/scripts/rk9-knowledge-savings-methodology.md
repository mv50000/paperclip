# RK9-18 (C6) — Knowledge-recall token-savings methodology & rollout plan

Companion to `rk9-knowledge-savings-report.ts`. Read this before quoting any savings number.

## What the feature does

On each heartbeat run, the server can inject a small **"Knowledge Context"** section (top
3–5 facts, hard-capped at ~500 tokens) recalled from the company's qmd vault collection
(via the C5 recall service). Two gates, **both default-off**, must be true:

1. **Global kill-switch** — `instance_settings.experimental.knowledgeRecallInjectionEnabled`
2. **Per-agent opt-in** — `agents.runtime_config.knowledgeRecall.enabled`

Optional per-agent overrides in the same `knowledgeRecall` block: `query` (string, else
role-derived) and `limit` (1–5, default 5).

## The two numbers — don't conflate them

**(a) Heartbeat injection COST.** Injecting the section ADDS input tokens to every heartbeat
(hard-capped ≈500). This is a cost, not a saving. The harness measures it directly as the
per-heartbeat input-token delta between baseline runs (no injection row) and with-recall runs.
Expected: roughly **+200…+500 input tokens/heartbeat**.

**(b) Repeated-query SAVING (the 70–90% headline).** When an agent would otherwise re-READ raw
memory files or the full flat `MEMORY.md` (~6.5K tokens) to answer a recurring question, a
scoped recall (≤500 tokens) replaces that read → **~90% fewer tokens for that operation**. This
shows up as fewer/smaller tool-read turns *inside the session*, not in the preamble. It is a
per-query claim about repeated lookups, not a per-heartbeat claim.

Net effect is positive only when the agent performs enough repeated knowledge lookups per
session that the saved raw-file reads outweigh the fixed ≈500-token preamble add. For a 4h-cadence
CEO/CFO that triages the same goals/budget context every wake, that holds; for a one-shot worker
it may not — which is exactly why injection is **opt-in per agent**.

## How the harness measures it

`rk9-knowledge-savings-report.ts` splits an agent's completed `heartbeat_runs` over a window into:
- **baseline**: runs with NO `knowledge_recall_injection` activity row,
- **with-recall**: runs that DID inject (joined on `activity_log.run_id`),

and reports avg input/output/cached tokens per group, the input-token delta/heartbeat (cost (a)),
and the injection's own logged metrics (avg injected tokens, recall latency avg+p95, avg topScore
as a precision proxy). Token reads are taken from `heartbeat_runs.usage_json` (handles both
camelCase and snake_case keys).

```
pnpm tsx scripts/rk9-knowledge-savings-report.ts --agent-name CEO --days 14
pnpm tsx scripts/rk9-knowledge-savings-report.ts --json     # all opted-in agents
```

**Baseline capture:** because the global flag starts off, every historical run for an agent is a
clean baseline. Flip the flag for a subset, let heartbeats accrue, then run the harness — the
same agent's pre-flip runs ARE the baseline (no separate control needed).

## Safety / cost controls (the "cost-delta alarm")

- **Hard token cap** (≈500 tok / ≤5 facts) in `knowledge-injection.ts` — the per-heartbeat add
  cannot run away regardless of vault size. This is the primary cost guardrail.
- **Global kill-switch** disables injection instantly for all agents (one settings flag).
- **Per-injection signal**: every injection logs `injectedTokenEstimate` + latency + topScore to
  `activity_log`; the harness surfaces the rolling delta so the operator sees cost creep.
- **Existing budget system** (`cost_events` → `budget_incidents`) already auto-pauses an agent on
  EUR overrun; recall injection inherits that protection — no bespoke EUR alarm is added (would
  duplicate `budgets.ts`).
- **Graceful fallback**: recall error/timeout/no-hit → no section injected, heartbeat proceeds.
  Recall has a 10s SIGKILL timeout and never throws; injection adds its own try/catch. Heartbeat
  total-time impact target <5% (recall is local qmd; warm `search` is sub-second to low-seconds).
  NOTE: cold `qmd query` loads 3 models (~30s) — the recall service uses `qmd search` (BM25,
  instant), NOT `qmd query`, precisely to keep the heartbeat fast.

## Cross-company isolation

Enforced in the C5 recall service: the company's vault slug is derived server-side from its
issue_prefix and only `<company>` + `shared` collections are queried, with a post-parse re-filter.
The injection layer only passes the agent's own `companyId` through and never widens scope.
Covered by `knowledge-injection.test.ts` (asserts the agent's companyId is what reaches recall)
and the C5 `knowledge-recall.test.ts` leak-guard tests; verified E2E against the live vault
(an Ololla-only term under rk9+shared scope returns 0 rows).

## Rollout plan

1. **Ship default-off** (this PR). No live behavior change until the operator flips flags.
2. **Subset first**: enable the global flag, then opt-in **RK9 CEO + RK9 CFO** only
   (`runtime_config.knowledgeRecall.enabled = true`). These are 4h/weekly cadence, low volume,
   high repeated-context value — ideal first canaries among the ~400€/mo live agents.
3. **Watch 1–2 weeks**: run the harness; confirm input delta ≈ +200–500 tok/heartbeat, recall
   latency p95 acceptable, topScore reasonable, no budget incidents.
4. **Expand** to the other company CEOs/CTOs if the per-query savings materialize (fewer raw-file
   reads in session); otherwise tune the role query or keep it scoped to high-repeat roles.
5. **Kill-switch** is the instant rollback at any step.

## How to flip the flags (operator)

Global (instance settings):
```sql
UPDATE instance_settings
SET experimental = experimental || '{"knowledgeRecallInjectionEnabled": true}'::jsonb, updated_at = now()
WHERE singleton_key = 'default';
```
Per-agent opt-in:
```sql
UPDATE agents
SET runtime_config = runtime_config || '{"knowledgeRecall": {"enabled": true}}'::jsonb, updated_at = now()
WHERE id = '<agent-uuid>';
```
(Both are also reachable via the instance-settings experimental PATCH API / agent update API.)
