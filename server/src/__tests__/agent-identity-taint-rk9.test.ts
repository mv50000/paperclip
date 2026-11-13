// RK9 fork regression (RK9-701, RK9-319): a run that received untrusted content gets no agent
// private key. Upstream v2026.1023.0 gives `PAPERCLIP_AGENT_PRIVATE_KEY` to every managed run.
// The key outlives the run, so a prompt-injected run (an inbound email wake) could copy it out.
// The claim hook marks the taint before the run environment is built, so the fork leaves the key
// out of a tainted run. A clean run keeps it.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, rk9RunTaints, type Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent private key and tainted runs (fork, RK9-701)", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let directory: string;
  let companyId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-identity-taint-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-identity-taint-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Identity taint test", issuePrefix: "KTT", defaultResponsibleUserId: "identity-taint-owner",
    });
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function processAgent() {
    const [agent] = await db.insert(agents).values({
      companyId, name: randomUUID(), role: "engineer", adapterType: "process",
      adapterConfig: {
        command: process.execPath, cwd: directory,
        args: ["-e", "process.stdout.write('HAS_KEY=' + (process.env.PAPERCLIP_AGENT_PRIVATE_KEY ? 'yes' : 'no'))"],
      },
    }).returning();
    return agent!;
  }

  async function runOnce(agentId: string, context: Record<string, unknown>) {
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(agentId, "on_demand", context, "manual");
      expect(run).toBeTruthy();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const finished = await heartbeat.getRun(run!.id);
      expect(finished?.status, JSON.stringify(finished)).toBe("succeeded");
      return finished!;
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
  }

  it("gives the key to a clean run", async () => {
    const agent = await processAgent();
    const finished = await runOnce(agent.id, {});
    expect(finished.stdoutExcerpt).toContain("HAS_KEY=yes");
  }, 60_000);

  it("leaves the key out of a run that an inbound email woke", async () => {
    const agent = await processAgent();
    const finished = await runOnce(agent.id, { wakeReason: "email_inbound" });
    const taints = await db.select().from(rk9RunTaints).where(eq(rk9RunTaints.runId, finished.id));
    expect(taints.length).toBeGreaterThan(0);
    expect(finished.stdoutExcerpt).toContain("HAS_KEY=no");
  }, 60_000);
});
