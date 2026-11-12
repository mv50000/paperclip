// RK9-701: upstream v2026.1023.0 creates every new agent as status "paused" with
// lifecycleState "preparing" until the lifecycle worker finishes. The fork's paused-agent
// rules (52b995085: hidden from agents.list, refused as assignee) must apply only to a held
// pause, so a new hire stays visible and assignable while it is prepared.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { isRk9HeldPausedAgent } from "../services/rk9-agent-pause.ts";
import { agentService } from "../services/agents.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("isRk9HeldPausedAgent", () => {
  it("treats a paused agent as held unless the lifecycle is preparing it", () => {
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: "paused" })).toBe(true);
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: "pausing" })).toBe(true);
    // Rows written before 0320 or by fixtures keep the column default "ready": fail closed.
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: "ready" })).toBe(true);
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: null })).toBe(true);
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: "preparing" })).toBe(false);
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: "verifying" })).toBe(false);
    expect(isRk9HeldPausedAgent({ status: "paused", lifecycleState: "resuming" })).toBe(false);
    expect(isRk9HeldPausedAgent({ status: "idle", lifecycleState: "ready" })).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agents.list hides only held paused agents (RK9-701)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-agent-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists a new hire the lifecycle is preparing and hides an operator-paused agent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pause Co",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const base = { companyId, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await db.insert(agents).values([
      { ...base, name: "Active", status: "idle", lifecycleState: "ready" },
      { ...base, name: "Preparing", status: "paused", lifecycleState: "preparing" },
      { ...base, name: "Held", status: "paused", lifecycleState: "paused", pauseReason: "manual" },
    ]);

    const names = (await agentService(db).list(companyId)).map((agent) => agent.name).sort();
    expect(names).toEqual(["Active", "Preparing"]);
    const all = (await agentService(db).list(companyId, { includePaused: true })).map((agent) => agent.name).sort();
    expect(all).toEqual(["Active", "Held", "Preparing"]);
  });
});
