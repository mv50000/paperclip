// RK9-701 (follows RK9-693, RK9-707): leak cases for the ten fork-only files that used to query
// `issues` without visibleIssueCondition(). Each case seeds a hidden issue (hiddenAt set) and shows
// that the fork code ignores it. Most cases also seed a visible issue and show it is still handled,
// so a green case proves the filter and not a broken query. The inventory test
// (nosto-private-issue-visibility-rk9.test.ts) keeps the list of files that still lack the filter.
import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyEmailConfig,
  createDb,
  emailRoutes,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  rk9EmailMessages,
  riskEntries,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { githubWebhookRoutes } from "../routes/github-webhooks.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { agentMetricsService } from "../services/agent-metrics.js";
import { startEmailEscalationCron } from "../services/email/escalation.js";
import type { EmailService } from "../services/email/index.js";
import { createInboundRouter, type ResendEvent } from "../services/email/inbound-router.js";
import { riskIncidentService } from "../services/risk-incidents.js";
import { riskMonitorService } from "../services/risk-monitors.js";
import { riskRegistryService } from "../services/risk-registry.js";
import { rk9CoordPresenceService } from "../services/rk9-coord-presence.js";
import { taintingSourcesForRun } from "../services/rk9-run-taint.js";
import { createVoiceActionDeps } from "../services/rk9-voice-action-deps.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[nosto-leaks] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

const HOUR_MS = 3_600_000;

(support.supported ? describe : describe.skip)("hidden issues stay out of fork-only queries (RK9-701)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let issueSeq = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-nosto-leaks-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  /** Seed a company with a short unique prefix and one agent. */
  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Leak ${prefix}`, issuePrefix: prefix });
    await db
      .insert(agents)
      .values({ id: agentId, companyId, name: `Agent ${prefix}`, role: "engineer", adapterType: "claude_local" });
    return { companyId, agentId, prefix };
  }

  /** Insert an issue; `hidden` sets hiddenAt. Identifiers are unique per company through issueSeq. */
  async function seedIssue(
    company: { companyId: string; prefix: string },
    values: Partial<typeof issues.$inferInsert> & { hidden?: boolean } = {},
  ) {
    const { hidden, ...rest } = values;
    issueSeq += 1;
    const [row] = await db
      .insert(issues)
      .values({
        companyId: company.companyId,
        title: hidden ? "Hidden issue" : "Visible issue",
        issueNumber: issueSeq,
        identifier: `${company.prefix}-${issueSeq}`,
        hiddenAt: hidden ? new Date() : null,
        ...rest,
      })
      .returning();
    return row!;
  }

  async function issueRow(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }

  it("agent-metrics: a hidden issue is not counted in agent workload", async () => {
    const c = await seedCompany("LAM");
    const now = new Date();
    const staleAt = new Date(now.getTime() - 30 * 24 * HOUR_MS);
    const common = { assigneeAgentId: c.agentId };
    await seedIssue(c, { ...common, status: "done", completedAt: now });
    await seedIssue(c, { ...common, status: "in_progress", updatedAt: staleAt });
    await seedIssue(c, { ...common, status: "done", completedAt: now, hidden: true });
    await seedIssue(c, { ...common, status: "cancelled", cancelledAt: now, hidden: true });
    await seedIssue(c, { ...common, status: "in_progress", updatedAt: staleAt, hidden: true });

    const report = await agentMetricsService(db).agentSuccessRate(c.companyId, { now });
    expect(report.totals).toMatchObject({ done: 1, cancelled: 0, stuckInProgress: 1 });
    expect(report.agents.find((row) => row.agentId === c.agentId)).toMatchObject({
      done: 1,
      cancelled: 0,
      stuckInProgress: 1,
    });
  });

  it("risk-monitors: a hidden unassigned issue raises no stalled-work alert", async () => {
    const c = await seedCompany("LRM");
    const old = new Date(Date.now() - 48 * HOUR_MS);
    const visible = await seedIssue(c, { status: "todo", createdAt: old });
    const hidden = await seedIssue(c, { status: "todo", createdAt: old, hidden: true });
    // A hidden blocked issue and a hidden issue on a paused agent raise no alert either.
    const pausedAgentId = randomUUID();
    await db
      .insert(agents)
      .values({ id: pausedAgentId, companyId: c.companyId, name: "Paused", role: "engineer", adapterType: "claude_local", status: "paused" });
    const hiddenOnPaused = await seedIssue(c, { status: "todo", assigneeAgentId: pausedAgentId, hidden: true });
    const visibleOnPaused = await seedIssue(c, { status: "todo", assigneeAgentId: pausedAgentId });
    const longAgo = new Date(Date.now() - 10 * 24 * HOUR_MS);
    const hiddenBlocked = await seedIssue(c, { status: "blocked", updatedAt: longAgo, hidden: true });
    const visibleBlocked = await seedIssue(c, { status: "blocked", updatedAt: longAgo });

    const monitors = riskMonitorService(db);
    const routing = await monitors.runTaskRoutingValidator(c.companyId);
    const aging = await monitors.runBlockerAgingDetector(c.companyId);
    expect(routing.errors).toEqual([]);
    expect(aging.errors).toEqual([]);

    const scopes = (await db.select({ scopeId: riskEntries.scopeId }).from(riskEntries).where(eq(riskEntries.companyId, c.companyId))).map(
      (row) => row.scopeId,
    );
    expect(scopes).toEqual(expect.arrayContaining([visible.id, visibleOnPaused.id, visibleBlocked.id]));
    for (const leaked of [hidden.id, hiddenOnPaused.id, hiddenBlocked.id]) {
      expect(scopes).not.toContain(leaked);
    }
  });

  it("risk-incidents: reassign_tasks does not move a hidden in_progress issue to backlog", async () => {
    const c = await seedCompany("LRI");
    const visible = await seedIssue(c, { status: "in_progress", assigneeAgentId: c.agentId });
    const hidden = await seedIssue(c, { status: "in_progress", assigneeAgentId: c.agentId, hidden: true });
    const entry = await riskRegistryService(db).upsertMonitorRisk(c.companyId, "AGENT_CRASH_LOOP", "agent", c.agentId, {});

    await riskIncidentService(db).createIncident(c.companyId, {
      riskEntryId: entry.id,
      title: "Crash loop",
      severity: "sev2",
      playbookCode: "AGENT_CRASH_LOOP",
      autoActionTypes: ["reassign_tasks"],
    });

    expect(await issueRow(visible.id)).toMatchObject({ status: "backlog", assigneeAgentId: null });
    expect(await issueRow(hidden.id)).toMatchObject({ status: "in_progress", assigneeAgentId: c.agentId });
  });

  it("rk9-coord-inbox: a hidden issue is not resolved by identifier or id", async () => {
    const c = await seedCompany("LCI");
    const visible = await seedIssue(c, { assigneeAgentId: c.agentId });
    const hidden = await seedIssue(c, { assigneeAgentId: c.agentId, hidden: true });
    const [visibleRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId: c.companyId, agentId: c.agentId, status: "running", invocationSource: "assignment", contextSnapshot: { issueId: visible.id }, startedAt: new Date() })
      .returning();
    const [hiddenRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId: c.companyId, agentId: c.agentId, status: "running", invocationSource: "assignment", contextSnapshot: { issueId: hidden.id }, startedAt: new Date() })
      .returning();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "operator-user",
        companyIds: [c.companyId],
        memberships: [{ companyId: c.companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: true,
        keyId: "board-key-1",
        source: "board_key",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", rk9CoordRoutes(db, { boardHost: "paperclip-01", boardKeyIds: null, findAgentRun: async () => null }));
    app.use(errorHandler);
    const sender = "worktree:LCI-1";
    const send = (body: Record<string, unknown>) =>
      request(app).post(`/api/companies/${c.companyId}/rk9/coord/inbox`).set("X-RK9-Actor", sender).send(body);

    // By identifier (findIssue) and by run context id (findIssueById).
    const hiddenByIdentifier = await send({ to: `Agent ${c.prefix}`, body: "x", issue: hidden.identifier });
    expect(hiddenByIdentifier.status).toBe(404);
    expect(hiddenByIdentifier.body.code).toBe("rk9_coord_inbox_target_not_found");
    const hiddenById = await send({ to: `agent_run:${hiddenRun!.id}`, body: "x" });
    expect(hiddenById.status).toBe(404);
    expect(hiddenById.body.code).toBe("rk9_coord_inbox_target_not_found");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, hidden.id))).toHaveLength(0);

    // Control: the visible issue still becomes a comment.
    const okByIdentifier = await send({ to: `Agent ${c.prefix}`, body: "by identifier", issue: visible.identifier });
    expect(okByIdentifier.status).toBe(201);
    const okById = await send({ to: `agent_run:${visibleRun!.id}`, body: "by id" });
    expect(okById.status).toBe(201);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, visible.id))).toHaveLength(2);
  });

  it("rk9-coord-presence: a hidden issue is not joined into a run's presence row", async () => {
    const c = await seedCompany("LCP");
    const visible = await seedIssue(c);
    const hidden = await seedIssue(c, { hidden: true });
    const insertRun = async (issueId: string) => {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: c.companyId, agentId: c.agentId, status: "running", invocationSource: "assignment", contextSnapshot: { issueId }, startedAt: new Date() })
        .returning();
      return run!;
    };
    const visibleRun = await insertRun(visible.id);
    const hiddenRun = await insertRun(hidden.id);

    const rows = await rk9CoordPresenceService(db).list(c.companyId);
    const visibleRow = rows.find((row) => row.actorId === `agent_run:${visibleRun.id}`);
    const hiddenRow = rows.find((row) => row.actorId === `agent_run:${hiddenRun.id}`);
    expect(visibleRow?.issue).toBe(visible.identifier);
    // The LEFT JOIN keeps the run; the hidden issue's identifier is not exposed.
    expect(hiddenRow).toBeDefined();
    expect(hiddenRow?.issue).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(hidden.identifier!);
  });

  // RK9-701 decision: taint is a safety gate, so it fails safe. A hidden issue with inbound
  // mail still taints the run that holds it (the RK9-707 todo asked for the opposite).
  it("rk9-run-taint: a hidden issue still taints the run that holds it (fail-safe)", async () => {
    const c = await seedCompany("LRT");
    const visible = await seedIssue(c);
    const hidden = await seedIssue(c, { hidden: true });
    const insertRun = async () => {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: c.companyId, agentId: c.agentId, status: "running", invocationSource: "assignment", contextSnapshot: {}, startedAt: new Date() })
        .returning();
      return run!;
    };
    const visibleRun = await insertRun();
    const hiddenRun = await insertRun();
    await db.update(issues).set({ checkoutRunId: visibleRun.id }).where(eq(issues.id, visible.id));
    await db.update(issues).set({ checkoutRunId: hiddenRun.id }).where(eq(issues.id, hidden.id));
    for (const issue of [visible, hidden]) {
      await db.insert(rk9EmailMessages).values({
        companyId: c.companyId,
        direction: "inbound",
        providerMessageId: `taint-${issue.id}`,
        fromAddress: "customer@example.com",
        toAddresses: ["tuki@example.com"],
        issueId: issue.id,
        status: "received",
      });
    }

    const visibleSources = await taintingSourcesForRun(db, visibleRun);
    expect(visibleSources).toEqual([expect.objectContaining({ kind: "email_issue_context", issueId: visible.id })]);
    expect(await taintingSourcesForRun(db, hiddenRun)).toEqual([expect.objectContaining({ kind: "email_issue_context", issueId: hidden.id })]);
  });

  it("rk9-voice-action-deps: a voice action does not update a hidden issue", async () => {
    const c = await seedCompany("LVA");
    const visible = await seedIssue(c, { status: "blocked" });
    const hidden = await seedIssue(c, { status: "blocked", hidden: true });
    const deps = createVoiceActionDeps(db);
    const notifiedAt = new Date();

    await deps.markBlockedOwnerNotified({ id: hidden.id, companyId: c.companyId }, notifiedAt);
    await deps.markBlockedOwnerNotified({ id: visible.id, companyId: c.companyId }, notifiedAt);

    expect((await issueRow(hidden.id)).blockedOwnerNotifiedAt).toBeNull();
    expect((await issueRow(visible.id)).blockedOwnerNotifiedAt?.getTime()).toBe(notifiedAt.getTime());
  });

  it("email/escalation: a hidden issue is not joined into the escalation list", async () => {
    const c = await seedCompany("LES");
    await db.insert(companyEmailConfig).values({
      companyId: c.companyId,
      primaryDomain: "leak-es.example",
      sendingDomain: "leak-es.example",
      mailProvider: "ses",
      status: "verified",
    });
    await db.insert(emailRoutes).values({
      companyId: c.companyId,
      localPart: "tuki",
      domain: "leak-es.example",
      routeKey: "tuki",
      assignedAgentId: c.agentId,
      escalateAfterHours: 24,
      approvalRequired: false,
    });
    const visible = await seedIssue(c, { status: "todo" });
    const hidden = await seedIssue(c, { status: "todo", hidden: true });
    const receivedAt = new Date(Date.now() - 72 * HOUR_MS);
    const insertMessage = async (issueId: string) => {
      const [row] = await db
        .insert(rk9EmailMessages)
        .values({
          companyId: c.companyId,
          direction: "inbound",
          providerMessageId: `esc-${issueId}`,
          fromAddress: "customer@example.com",
          toAddresses: ["tuki@leak-es.example"],
          subject: `Subject ${issueId}`,
          routeKey: "tuki",
          issueId,
          status: "received",
          receivedAt,
        })
        .returning();
      return row!;
    };
    const visibleMessage = await insertMessage(visible.id);
    const hiddenMessage = await insertMessage(hidden.id);

    const sendEmail = vi.fn(async () => ({ ok: true as const, messageId: "m", providerMessageId: "p" }));
    const service = { sendEmail, replyToMessage: vi.fn() } as unknown as EmailService;
    const cron = startEmailEscalationCron(db, service, { intervalMs: 2 ** 31 - 1 });
    await cron.runNow();
    cron.stop();

    const escalated = async (id: string) =>
      (await db.select({ at: rk9EmailMessages.escalatedAt }).from(rk9EmailMessages).where(eq(rk9EmailMessages.id, id)))[0]!.at;
    expect(await escalated(visibleMessage.id)).not.toBeNull();
    expect(await escalated(hiddenMessage.id)).toBeNull();
    const subjects = (sendEmail.mock.calls as unknown as Array<[{ companyId: string; subject: string }]>)
      .filter(([arg]) => arg.companyId === c.companyId)
      .map(([arg]) => arg.subject);
    expect(subjects).toEqual([`[Eskalaatio] Subject ${visible.id}`]);
  });

  it("email/inbound-router: an inbound reply does not reopen a hidden issue", async () => {
    const c = await seedCompany("LIR");
    await db.insert(companyEmailConfig).values({
      companyId: c.companyId,
      primaryDomain: "leak-ir.example",
      sendingDomain: "leak-ir.example",
      mailProvider: "ses",
      status: "verified",
    });
    const visible = await seedIssue(c, { status: "todo" });
    const hidden = await seedIssue(c, { status: "todo", hidden: true });
    const parentFor = async (issueId: string) => {
      const providerMessageId = `parent-${issueId}`;
      await db.insert(rk9EmailMessages).values({
        companyId: c.companyId,
        direction: "outbound",
        providerMessageId,
        fromAddress: "tuki@leak-ir.example",
        toAddresses: ["customer@example.com"],
        issueId,
        status: "sent",
      });
      return providerMessageId;
    };
    const replyTo = async (parentId: string) => {
      const event = {
        type: "email.received",
        created_at: new Date().toISOString(),
        data: {
          email_id: `reply-to-${parentId}`,
          from: "Customer <customer@example.com>",
          to: ["tuki@leak-ir.example"],
          subject: "Re: Apua",
          text: "Hello again",
          headers: { "In-Reply-To": `<${parentId}>` },
        },
      } as unknown as ResendEvent;
      return createInboundRouter(db, { emailService: {} as EmailService }).handleEvent(c.companyId, event, {
        tenantResolvedBy: "thread",
      });
    };

    const hiddenParent = await parentFor(hidden.id);
    const visibleParent = await parentFor(visible.id);
    const hiddenUpdatedAt = (await issueRow(hidden.id)).updatedAt;

    // No email route exists, so a message that is not threaded onto an issue is stored unrouted.
    expect(await replyTo(hiddenParent)).toEqual({ ok: true, status: "stored_unrouted" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, hidden.id))).toHaveLength(0);
    expect((await issueRow(hidden.id)).updatedAt.getTime()).toBe(hiddenUpdatedAt.getTime());
    const [stored] = await db
      .select({ issueId: rk9EmailMessages.issueId })
      .from(rk9EmailMessages)
      .where(and(eq(rk9EmailMessages.companyId, c.companyId), eq(rk9EmailMessages.providerMessageId, `reply-to-${hiddenParent}`)));
    expect(stored!.issueId).toBeNull();

    // Control: the same reply on a visible issue is threaded onto it.
    expect(await replyTo(visibleParent)).toEqual({ ok: true, status: "reply_linked" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, visible.id))).toHaveLength(1);
  });

  it("github-webhooks: a webhook does not match a hidden issue", async () => {
    const c = await seedCompany("LGW");
    const secret = "leak-webhook-secret";
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", secret);
    try {
      const visible = await seedIssue(c, { status: "in_review" });
      const hidden = await seedIssue(c, { status: "in_review", hidden: true });
      const app = express();
      app.use(
        express.json({
          verify: (req, _res, buf) => {
            (req as unknown as { rawBody: Buffer }).rawBody = buf;
          },
        }),
      );
      app.use("/api", githubWebhookRoutes(db));
      const merged = async (title: string) => {
        const body = JSON.stringify({
          action: "closed",
          pull_request: {
            merged: true,
            number: 7,
            title,
            body: null,
            html_url: "https://github.com/org/repo/pull/7",
            base: { repo: { full_name: "org/repo" } },
          },
        });
        return request(app)
          .post("/api/github/webhooks")
          .set("content-type", "application/json")
          .set("x-github-event", "pull_request")
          .set("x-hub-signature-256", "sha256=" + createHmac("sha256", secret).update(body).digest("hex"))
          .send(body);
      };

      // Match by identifier in the PR title.
      const res = await merged(`feat: ${hidden.identifier} and ${visible.identifier}`);
      expect(res.status).toBe(200);
      expect(res.body.closedIssueIds).toEqual([visible.id]);
      expect(await issueRow(hidden.id)).toMatchObject({ status: "in_review" });
      expect(await issueRow(visible.id)).toMatchObject({ status: "done" });

      // Match by a pull_request work product that links the merged PR URL (second query).
      const linkedVisible = await seedIssue(c, { status: "in_review" });
      const linkedHidden = await seedIssue(c, { status: "in_review", hidden: true });
      for (const issue of [linkedVisible, linkedHidden]) {
        await db.insert(issueWorkProducts).values({
          companyId: c.companyId,
          issueId: issue.id,
          type: "pull_request",
          provider: "github",
          title: "PR 7",
          status: "active",
          url: "https://github.com/org/repo/pull/7",
        });
      }
      const linked = await merged("feat: no identifier here");
      expect(linked.status).toBe(200);
      expect(linked.body.closedIssueIds).toEqual([linkedVisible.id]);
      expect(await issueRow(linkedHidden.id)).toMatchObject({ status: "in_review" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
