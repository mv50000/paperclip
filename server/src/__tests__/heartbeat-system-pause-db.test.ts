import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { isSystemPausedConflict } from "../errors.js";
import { undeliveredConversationComments } from "../services/agent-conversations.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeatService system pause fallback (no systemPause option)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-system-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("refuses wakeups from a route-built instance while the system is paused", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PausedAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600 } },
      permissions: {},
    });
    await instanceSettingsService(db).updateGeneral({
      systemPause: {
        pausedAt: new Date().toISOString(),
        pausedUntil: null,
        reason: "db-test pause",
        source: "manual",
      },
    });

    // Same construction as the routes: no systemPause option.
    // Clean env: a worktree/dev host sets PAPERCLIP_IN_WORKTREE, which would skip the wake before the pause gate.
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    const onDemand = heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      requestedByActorType: "user",
    });
    await expect(onDemand).rejects.toSatisfy(isSystemPausedConflict);

    const timer = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
    });
    expect(timer).toBeNull();

    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toEqual([]);
    const skipped = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((row) => row.status === "skipped")).toBe(true);
  });
  it("keeps a conversation comment undelivered when its wake was skipped by a system pause", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "ChatAgent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Chat", status: "todo", priority: "medium", assigneeAgentId: agentId,
    });
    const [paused, other] = [randomUUID(), randomUUID()];
    await db.insert(issueComments).values([
      { id: paused, companyId, issueId, body: "a", clientRequestId: randomUUID(), authorUserId: "u" },
      { id: other, companyId, issueId, body: "b", clientRequestId: randomUUID(), authorUserId: "u" },
    ]);
    const wake = (commentId: string, reason: string) => ({
      companyId, agentId, source: "on_demand", triggerDetail: "manual", reason, status: "skipped",
      idempotencyKey: `conversation-comment:${commentId}`,
    });
    await db.insert(agentWakeupRequests).values([wake(paused, "system.paused"), wake(other, "heartbeat.idle")]);

    const undelivered = await undeliveredConversationComments(db, companyId, issueId);
    expect(undelivered.map((c) => c.id)).toEqual([paused]);
  });
});
