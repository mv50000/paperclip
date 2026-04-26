import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createSlackInteractionsService,
  type SlackUser,
} from "../services/slack/interactions.js";

interface FakeApproval {
  id: string;
  companyId: string;
  type: string;
  status: "pending" | "approved" | "rejected" | "revision_requested";
  payload: Record<string, unknown>;
  decidedByUserId: string | null;
  decisionNote: string | null;
}

const COMPANY_ID = "co-1";
const APPROVAL_ID = "ap-1";

function makeApproval(overrides: Partial<FakeApproval> = {}): FakeApproval {
  return {
    id: APPROVAL_ID,
    companyId: COMPANY_ID,
    type: "hire_agent",
    status: "pending",
    payload: { title: "Hire DataAnalyst" },
    decidedByUserId: null,
    decisionNote: null,
    ...overrides,
  };
}

function makeUser(overrides: Partial<SlackUser> = {}): SlackUser {
  return {
    paperclipUserId: "u-mauri",
    email: "mauri@example.com",
    isInstanceAdmin: false,
    companyIds: [COMPANY_ID],
    ...overrides,
  };
}

function buildService(opts: {
  approval: FakeApproval | null;
  user: SlackUser | null;
  approveImpl?: ReturnType<typeof vi.fn>;
  rejectImpl?: ReturnType<typeof vi.fn>;
  revisionImpl?: ReturnType<typeof vi.fn>;
  viewsOpen?: ReturnType<typeof vi.fn>;
  updateMessage?: ReturnType<typeof vi.fn>;
}) {
  const approveImpl =
    opts.approveImpl ?? vi.fn(async () => ({ approval: opts.approval, applied: true }));
  const rejectImpl =
    opts.rejectImpl ?? vi.fn(async () => ({ approval: opts.approval, applied: true }));
  const revisionImpl = opts.revisionImpl ?? vi.fn(async () => opts.approval);
  const viewsOpen = opts.viewsOpen ?? vi.fn(async () => ({ ok: true }));
  const updateMessage =
    opts.updateMessage ?? vi.fn(async () => ({ ok: true as const }));
  const fakeApprovals = {
    getById: vi.fn(async (id: string) => (opts.approval && opts.approval.id === id ? opts.approval : null)),
    approve: approveImpl,
    reject: rejectImpl,
    requestRevision: revisionImpl,
    create: vi.fn(),
    list: vi.fn(),
    resubmit: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    setSlackMessageRef: vi.fn(),
  };
  const fakeWebClient = {
    views: { open: viewsOpen },
    users: { info: vi.fn() },
  };
  const fakeClient = {
    getClientForCompany: vi.fn(async () => fakeWebClient),
    postMessage: vi.fn(),
    updateMessage,
    invalidateCache: vi.fn(),
  };
  const svc = createSlackInteractionsService({} as never, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: fakeClient as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    approvals: fakeApprovals as any,
    resolveUser: async () => opts.user,
  });
  return { svc, fakeApprovals, fakeClient, fakeWebClient, viewsOpen, updateMessage };
}

function makeBlockActions(actionId: string, blockId: string) {
  return {
    type: "block_actions",
    user: { id: "U123" },
    trigger_id: "trigger-1",
    actions: [{ action_id: actionId, block_id: blockId, value: APPROVAL_ID }],
    message: { ts: "1700000000.000100" },
    channel: { id: "C-team" },
  };
}

const APPROVAL_BLOCK_ID = JSON.stringify({
  kind: "approval-actions",
  approvalId: APPROVAL_ID,
});

describe("slack interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approve via block_actions calls approvals.approve with paperclip user id", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    const result = await svc.handle(makeBlockActions("approval_approve", APPROVAL_BLOCK_ID));
    expect(result.status).toBe(200);
    expect(fakeApprovals.approve).toHaveBeenCalledWith(APPROVAL_ID, "u-mauri", null);
  });

  it("reject button opens views.open modal with private_metadata", async () => {
    const approval = makeApproval();
    const { svc, viewsOpen } = buildService({ approval, user: makeUser() });
    const result = await svc.handle(makeBlockActions("approval_reject", APPROVAL_BLOCK_ID));
    expect(result.status).toBe(200);
    expect(viewsOpen).toHaveBeenCalledTimes(1);
    const args = viewsOpen.mock.calls[0]![0] as { view: { private_metadata: string } };
    const meta = JSON.parse(args.view.private_metadata);
    expect(meta.approvalId).toBe(APPROVAL_ID);
    expect(meta.decision).toBe("rejected");
  });

  it("request revision button opens modal with revision decision", async () => {
    const approval = makeApproval();
    const { svc, viewsOpen } = buildService({ approval, user: makeUser() });
    await svc.handle(makeBlockActions("approval_request_revision", APPROVAL_BLOCK_ID));
    const args = viewsOpen.mock.calls[0]![0] as { view: { private_metadata: string } };
    expect(JSON.parse(args.view.private_metadata).decision).toBe("revision_requested");
  });

  it("returns ephemeral error when slack user has no paperclip account", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: null });
    const result = await svc.handle(makeBlockActions("approval_approve", APPROVAL_BLOCK_ID));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ response_type: "ephemeral" });
    expect(fakeApprovals.approve).not.toHaveBeenCalled();
  });

  it("returns ephemeral error when user is not member of approval's company", async () => {
    const approval = makeApproval();
    const otherUser = makeUser({ companyIds: ["other-co"] });
    const { svc, fakeApprovals } = buildService({ approval, user: otherUser });
    const result = await svc.handle(makeBlockActions("approval_approve", APPROVAL_BLOCK_ID));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ response_type: "ephemeral" });
    expect(fakeApprovals.approve).not.toHaveBeenCalled();
  });

  it("instance admin can act on any company", async () => {
    const approval = makeApproval();
    const adminUser = makeUser({ isInstanceAdmin: true, companyIds: [] });
    const { svc, fakeApprovals } = buildService({ approval, user: adminUser });
    await svc.handle(makeBlockActions("approval_approve", APPROVAL_BLOCK_ID));
    expect(fakeApprovals.approve).toHaveBeenCalled();
  });

  it("approve on already-decided approval returns ephemeral", async () => {
    const approval = makeApproval({ status: "approved" });
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    const result = await svc.handle(makeBlockActions("approval_approve", APPROVAL_BLOCK_ID));
    expect(result.body).toMatchObject({ response_type: "ephemeral" });
    expect(fakeApprovals.approve).not.toHaveBeenCalled();
  });

  it("view_submission for reject calls reject with decision note", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    const result = await svc.handle({
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "approval_reject_modal",
        private_metadata: JSON.stringify({
          approvalId: APPROVAL_ID,
          decision: "rejected",
          channel: "C-team",
          messageTs: "1700000000.000100",
        }),
        state: {
          values: {
            decision_note: { value: { value: "Cost too high" } },
          },
        },
      },
    });
    expect(result.status).toBe(200);
    expect(fakeApprovals.reject).toHaveBeenCalledWith(APPROVAL_ID, "u-mauri", "Cost too high");
  });

  it("view_submission for revision calls requestRevision", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    await svc.handle({
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "approval_revision_modal",
        private_metadata: JSON.stringify({
          approvalId: APPROVAL_ID,
          decision: "revision_requested",
          channel: "C-team",
          messageTs: "1700000000.000100",
        }),
        state: {
          values: {
            decision_note: { value: { value: "Please add cost analysis" } },
          },
        },
      },
    });
    expect(fakeApprovals.requestRevision).toHaveBeenCalledWith(
      APPROVAL_ID,
      "u-mauri",
      "Please add cost analysis",
    );
  });

  it("view_submission with empty note returns errors response", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    const result = await svc.handle({
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "approval_reject_modal",
        private_metadata: JSON.stringify({
          approvalId: APPROVAL_ID,
          decision: "rejected",
          channel: "C-team",
          messageTs: "1700000000.000100",
        }),
        state: { values: { decision_note: { value: { value: "   " } } } },
      },
    });
    expect(result.body).toMatchObject({ response_action: "errors" });
    expect(fakeApprovals.reject).not.toHaveBeenCalled();
  });

  it("ignores unknown block_actions block_id", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    const result = await svc.handle(makeBlockActions("approval_approve", "not-json"));
    expect(result.body).toMatchObject({ response_type: "ephemeral" });
    expect(fakeApprovals.approve).not.toHaveBeenCalled();
  });

  it("approval_open_in_ui is a no-op (link handles itself)", async () => {
    const approval = makeApproval();
    const { svc, fakeApprovals } = buildService({ approval, user: makeUser() });
    const result = await svc.handle(
      makeBlockActions("approval_open_in_ui", APPROVAL_BLOCK_ID),
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe("");
    expect(fakeApprovals.approve).not.toHaveBeenCalled();
  });
});
