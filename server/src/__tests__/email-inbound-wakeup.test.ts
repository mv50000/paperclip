// RK9-80: inbound email must wake the assigned agent, and a reply that
// references an existing thread must land on the existing issue instead of
// opening a duplicate.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  companyEmailConfig,
  emailMessages,
  emailRoutes,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

const mockMaybeSendAutoReply = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock("../services/email/auto-reply.js", () => ({
  maybeSendAutoReply: mockMaybeSendAutoReply,
}));

import {
  createInboundRouter,
  extractReferencedMessageIds,
  type InboundEmailEvent,
} from "../services/email/inbound-router.js";

const COMPANY = "company-1";
const AGENT = "agent-1";

/**
 * Minimal fake drizzle Db: select results are served from a FIFO queue (call
 * order in handleReceived is deterministic), inserts/updates are recorded per
 * table for assertions. `transaction` runs the callback against the same stub.
 */
function fakeDb() {
  const selectQueue: unknown[][] = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const insertReturning: unknown[][] = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];

  const makeSelectChain = () => {
    const result = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => void) => resolve(result);
    return chain;
  };

  const db = {
    select: () => makeSelectChain(),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const returned = insertReturning.shift() ?? [{ id: `row-${inserts.length}` }];
        const tail = {
          returning: async () => returned,
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        };
        return {
          ...tail,
          onConflictDoNothing: () => tail,
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return { where: async () => undefined };
      },
    }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };

  return { db: db as unknown as Db, selectQueue, inserts, insertReturning, updates };
}

const route = {
  companyId: COMPANY,
  domain: "sunspot.fi",
  localPart: "tuki",
  routeKey: "tuki",
  assignedAgentId: AGENT,
  autoReplyTemplateId: null,
};

const config = { companyId: COMPANY, primaryDomain: "sunspot.fi" };

function inboundEvent(overrides: Partial<InboundEmailEvent["data"]> = {}): InboundEmailEvent {
  return {
    type: "email.received",
    created_at: "2026-07-25T10:00:00.000Z",
    data: {
      email_id: "prov-msg-1",
      from: "customer@example.com",
      to: ["tuki@sunspot.fi"],
      subject: "Apua",
      text: "Tarvitsen apua",
      html: null,
      ...overrides,
    },
  };
}

function flushImmediates() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("extractReferencedMessageIds", () => {
  it("collects In-Reply-To first, then References right-to-left, deduped", () => {
    expect(
      extractReferencedMessageIds({
        "in-reply-to": "<c@ses>",
        references: "<a@x> <b@y> <c@ses>",
      }),
    ).toEqual(["<c@ses>", "<b@y>", "<a@x>"]);
  });

  it("handles missing/mixed-case headers", () => {
    expect(extractReferencedMessageIds(undefined)).toEqual([]);
    expect(extractReferencedMessageIds({})).toEqual([]);
    expect(extractReferencedMessageIds({ "In-Reply-To": "<a@x>" })).toEqual(["<a@x>"]);
  });

  it("ignores tokens with whitespace or missing brackets", () => {
    expect(extractReferencedMessageIds({ "in-reply-to": "not-a-msgid" })).toEqual([]);
  });
});

describe("inbound wakeup", () => {
  const wakeup = vi.fn(async () => undefined);

  beforeEach(() => {
    wakeup.mockClear();
    mockMaybeSendAutoReply.mockClear();
  });

  it("wakes the assigned agent when a routed inbound creates an issue", async () => {
    const { db, selectQueue, inserts, insertReturning } = fakeDb();
    selectQueue.push([config]); // company_email_config
    selectQueue.push([route]); // exact route
    insertReturning.push([{ id: "msg-1" }]); // email_messages insert
    insertReturning.push([{ id: "issue-1" }]); // issues insert

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    const result = await router.handleEvent(COMPANY, inboundEvent());

    expect(result).toEqual({ ok: true, status: "issue_created" });
    await flushImmediates();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({
        source: "assignment",
        reason: "email_inbound",
        payload: { issueId: "issue-1", mutation: "create" },
        contextSnapshot: { issueId: "issue-1", source: "email.inbound" },
      }),
    );
    expect(inserts.some((i) => i.table === issues)).toBe(true);
  });

  it("does not wake anyone for an unassigned route (backlog issue)", async () => {
    const { db, selectQueue, insertReturning } = fakeDb();
    selectQueue.push([config]);
    selectQueue.push([{ ...route, assignedAgentId: null }]);
    insertReturning.push([{ id: "msg-1" }]);
    insertReturning.push([{ id: "issue-1" }]);

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    const result = await router.handleEvent(COMPANY, inboundEvent());

    expect(result).toEqual({ ok: true, status: "issue_created" });
    await flushImmediates();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("ignores a duplicate delivery without waking or auto-replying", async () => {
    const { db, selectQueue, insertReturning } = fakeDb();
    selectQueue.push([config]);
    selectQueue.push([route]);
    insertReturning.push([]); // onConflictDoNothing → no row

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    const result = await router.handleEvent(COMPANY, inboundEvent());

    expect(result).toEqual({ ok: true, status: "ignored" });
    await flushImmediates();
    expect(wakeup).not.toHaveBeenCalled();
    expect(mockMaybeSendAutoReply).not.toHaveBeenCalled();
  });

  it("schedules the auto-reply only after the transaction resolves", async () => {
    const { db, selectQueue, insertReturning } = fakeDb();
    selectQueue.push([config]);
    selectQueue.push([{ ...route, autoReplyTemplateId: "tpl-1" }]);
    insertReturning.push([{ id: "msg-1" }]);
    insertReturning.push([{ id: "issue-1" }]);

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    await router.handleEvent(COMPANY, inboundEvent());

    expect(mockMaybeSendAutoReply).not.toHaveBeenCalled();
    await flushImmediates();
    expect(mockMaybeSendAutoReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ templateId: "tpl-1", inboundMessageId: "msg-1" }),
    );
  });
});

describe("inbound reply threading", () => {
  const wakeup = vi.fn(async () => undefined);

  beforeEach(() => {
    wakeup.mockClear();
    mockMaybeSendAutoReply.mockClear();
  });

  function replyEvent() {
    return inboundEvent({
      email_id: "prov-msg-2",
      headers: { "in-reply-to": "<ses-out-1@eu-north-1.amazonses.com>" },
    });
  }

  it("links a referenced reply onto the existing issue and wakes its assignee", async () => {
    const { db, selectQueue, inserts, insertReturning } = fakeDb();
    selectQueue.push([config]);
    selectQueue.push([route]);
    // findThreadParent: parent message lookup, then its issue
    selectQueue.push([{ id: "msg-out-1", issueId: "issue-1" }]);
    selectQueue.push([{ id: "issue-1", assigneeAgentId: AGENT, status: "in_progress" }]);
    insertReturning.push([{ id: "msg-2" }]);

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    const result = await router.handleEvent(COMPANY, replyEvent());

    expect(result).toEqual({ ok: true, status: "reply_linked" });
    // No new issue; a metadata comment on the existing one instead.
    expect(inserts.some((i) => i.table === issues)).toBe(false);
    const comment = inserts.find((i) => i.table === issueComments);
    expect(comment?.values.issueId).toBe("issue-1");
    expect(String(comment?.values.body)).not.toContain("Tarvitsen apua");
    // The linked message rides the thread.
    const msg = inserts.find((i) => i.table === emailMessages);
    expect(msg?.values.issueId).toBe("issue-1");
    expect(msg?.values.inReplyToId).toBe("msg-out-1");

    await flushImmediates();
    expect(mockMaybeSendAutoReply).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({
        reason: "email_inbound_reply",
        payload: { issueId: "issue-1", mutation: "update" },
        contextSnapshot: { issueId: "issue-1", source: "email.inbound_reply" },
      }),
    );
  });

  it("opens a fresh issue when the referenced thread's issue is closed", async () => {
    const { db, selectQueue, inserts, insertReturning } = fakeDb();
    selectQueue.push([config]);
    selectQueue.push([route]);
    selectQueue.push([{ id: "msg-out-1", issueId: "issue-1" }]);
    selectQueue.push([{ id: "issue-1", assigneeAgentId: AGENT, status: "done" }]);
    insertReturning.push([{ id: "msg-2" }]);
    insertReturning.push([{ id: "issue-2" }]);

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    const result = await router.handleEvent(COMPANY, replyEvent());

    expect(result).toEqual({ ok: true, status: "issue_created" });
    expect(inserts.some((i) => i.table === issues)).toBe(true);
    await flushImmediates();
    expect(wakeup).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({ payload: { issueId: "issue-2", mutation: "create" } }),
    );
  });

  it("treats unknown references as a new thread", async () => {
    const { db, selectQueue, inserts, insertReturning } = fakeDb();
    selectQueue.push([config]);
    selectQueue.push([route]);
    selectQueue.push([]); // no matching parent message
    insertReturning.push([{ id: "msg-2" }]);
    insertReturning.push([{ id: "issue-2" }]);

    const router = createInboundRouter(db, { heartbeat: { wakeup } });
    const result = await router.handleEvent(COMPANY, replyEvent());

    expect(result).toEqual({ ok: true, status: "issue_created" });
    expect(inserts.some((i) => i.table === issues)).toBe(true);
  });
});

// Sanity: the config select in the fake must stay the first query — if
// handleReceived's query order changes, update the queues above.
void companyEmailConfig;
void emailRoutes;
