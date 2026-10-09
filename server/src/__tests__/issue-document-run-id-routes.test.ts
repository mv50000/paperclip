// --- RK9 Custom (RK9-78): regression tests for run-id validation on issue document writes ---
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  heartbeatRuns,
  issueDocuments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue document run-id route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue document PUT run-id validation (RK9-78)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  let otherCompanyId!: string;
  let knownRunId!: string;
  let otherCompanyRunId!: string;
  let actorRunId: string | null = null;
  let issueCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-document-run-id-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    knownRunId = randomUUID();
    otherCompanyRunId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Run-id tenant", issuePrefix: "RID", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other tenant", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Agent",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other agent",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: knownRunId, companyId, agentId, status: "running", invocationSource: "on_demand" },
      {
        id: otherCompanyRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "running",
        invocationSource: "on_demand",
      },
    ]);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
        runId: actorRunId,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in issue document run-id route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in issue document run-id route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  async function createIssue(): Promise<string> {
    issueCounter += 1;
    actorRunId = null;
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `Document run-id target ${issueCounter}`, status: "todo", priority: "medium" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function revisionRowsForIssue(issueId: string) {
    return db
      .select({ id: documentRevisions.id, createdByRunId: documentRevisions.createdByRunId })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documentRevisions.documentId))
      .where(eq(issueDocuments.issueId, issueId));
  }

  function putPlan(issueId: string) {
    return request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ title: "Plan", format: "markdown", body: "# Plan" });
  }

  it("rejects an unknown UUID run id with 422 and writes no document revision", async () => {
    const issueId = await createIssue();
    actorRunId = randomUUID();

    const res = await putPlan(issueId);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("Unknown actorRunId");
    expect(await revisionRowsForIssue(issueId)).toHaveLength(0);
  });

  it("rejects a run id that belongs to another company with 422 and writes no document revision", async () => {
    const issueId = await createIssue();
    actorRunId = otherCompanyRunId;

    const res = await putPlan(issueId);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await revisionRowsForIssue(issueId)).toHaveLength(0);
  });

  it("rejects a non-UUID run id with 422 instead of a uuid cast 500", async () => {
    const issueId = await createIssue();
    actorRunId = "not-a-uuid";

    const res = await putPlan(issueId);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await revisionRowsForIssue(issueId)).toHaveLength(0);
  });

  it("still writes the document and records a known same-company run id", async () => {
    const issueId = await createIssue();
    actorRunId = knownRunId;

    const res = await putPlan(issueId);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await revisionRowsForIssue(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdByRunId).toBe(knownRunId);
  });

  it("still writes the document when no run id is present", async () => {
    const issueId = await createIssue();
    actorRunId = null;

    const res = await putPlan(issueId);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await revisionRowsForIssue(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdByRunId).toBeNull();
  });
});
