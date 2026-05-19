/**
 * Migrate existing AI board-member agents and E2E Smoke Tarkkailija agents
 * to the `human_proxy` adapter type so they are never invoked automatically.
 *
 * Idempotent — safe to re-run. Only updates rows that are not already
 * `adapter_type='human_proxy'`.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-ai-agents-to-human-proxy.ts [--dry-run]
 *
 * Targets:
 *   - agents.name = 'AI' (board-member identities, per-company)
 *   - agents.metadata->>'kind' = 'e2e-smoke-bot' (external Playwright runner)
 */
import { eq, sql } from "drizzle-orm";
import { agents, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const HUMAN_PROXY = "human_proxy" as const;

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);

  const targets = await db
    .select()
    .from(agents)
    .where(
      sql`(${agents.name} = 'AI' OR ${agents.metadata}->>'kind' = 'e2e-smoke-bot')`,
    );

  console.log(
    `Found ${targets.length} target agent(s) (AI board members + e2e-smoke-bots).`,
  );

  let migrated = 0;
  let skipped = 0;
  for (const agent of targets) {
    if (agent.adapterType === HUMAN_PROXY) {
      skipped += 1;
      console.log(
        `  - SKIP ${agent.id} (${agent.name}, company=${agent.companyId}) — already human_proxy`,
      );
      continue;
    }

    const previousRuntimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntimeConfig: Record<string, unknown> = {
      ...previousRuntimeConfig,
      heartbeat: {
        enabled: false,
        wakeOnDemand: false,
        intervalSec: 0,
        maxConcurrentRuns: 0,
      },
    };

    const nextStatus = agent.status === "terminated" ? "terminated" : "idle";

    console.log(
      `  - MIGRATE ${agent.id} (${agent.name}, company=${agent.companyId}, ` +
        `status=${agent.status}→${nextStatus}, adapter=${agent.adapterType}→${HUMAN_PROXY})`,
    );

    if (DRY_RUN) continue;

    await db
      .update(agents)
      .set({
        adapterType: HUMAN_PROXY,
        status: nextStatus,
        pauseReason: nextStatus === "terminated" ? agent.pauseReason : null,
        pausedAt: nextStatus === "terminated" ? agent.pausedAt : null,
        runtimeConfig: nextRuntimeConfig,
        budgetMonthlyCents: 0,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id));
    migrated += 1;
  }

  console.log(
    `\nDone. migrated=${migrated} skipped=${skipped} (dry-run=${DRY_RUN}).`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`migrate-ai-agents-to-human-proxy failed: ${message}`);
  process.exitCode = 1;
});
