import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { approvalService } from "../approvals.js";
import { createSlackClientService, type SlackClientService } from "./client.js";
import { formatApprovalDecided } from "./formatters.js";
import type { LiveEvent } from "@paperclipai/shared";

export type ApprovalServiceLike = ReturnType<typeof approvalService>;
export type SlackUserResolver = (
  companyId: string,
  slackUserId: string,
) => Promise<SlackUser | null>;

const USER_CACHE_TTL_MS = 5 * 60 * 1000;

export interface SlackUser {
  paperclipUserId: string;
  email: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
}

interface CachedUser {
  user: SlackUser | null;
  fetchedAt: number;
}

export interface SlackInteractionResult {
  status: number;
  body?: Record<string, unknown> | string;
}

interface BlockActionsPayload {
  type: "block_actions";
  user: { id: string };
  trigger_id: string;
  actions: Array<{
    action_id: string;
    block_id: string;
    value?: string;
  }>;
  message?: { ts?: string };
  channel?: { id?: string };
}

interface ViewSubmissionPayload {
  type: "view_submission";
  user: { id: string };
  view: {
    callback_id: string;
    private_metadata?: string;
    state: {
      values: Record<string, Record<string, { value?: string }>>;
    };
  };
}

interface ApprovalActionsBlockId {
  kind: "approval-actions";
  approvalId: string;
}

interface ApprovalModalMetadata {
  approvalId: string;
  decision: "rejected" | "revision_requested";
  channel: string;
  messageTs: string;
}

export interface SlackInteractionsService {
  handle(payload: unknown): Promise<SlackInteractionResult>;
  invalidateUserCache(slackUserId?: string): void;
}

export interface SlackInteractionsServiceOptions {
  client?: SlackClientService;
  approvals?: ApprovalServiceLike;
  resolveUser?: SlackUserResolver;
}

function ephemeral(text: string): SlackInteractionResult {
  return {
    status: 200,
    body: { response_type: "ephemeral", text },
  };
}

function parseApprovalBlockId(blockId: string): ApprovalActionsBlockId | null {
  try {
    const parsed = JSON.parse(blockId) as ApprovalActionsBlockId;
    if (parsed?.kind === "approval-actions" && typeof parsed.approvalId === "string") {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

function parseModalMetadata(value: string | undefined): ApprovalModalMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ApprovalModalMetadata;
    if (
      typeof parsed?.approvalId === "string" &&
      (parsed.decision === "rejected" || parsed.decision === "revision_requested") &&
      typeof parsed.channel === "string" &&
      typeof parsed.messageTs === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

export function createSlackInteractionsService(
  db: Db,
  opts: SlackInteractionsServiceOptions = {},
): SlackInteractionsService {
  const client = opts.client ?? createSlackClientService(db);
  const approvals = opts.approvals ?? approvalService(db);
  const userCache = new Map<string, CachedUser>();

  function invalidateUserCache(slackUserId?: string) {
    if (slackUserId) userCache.delete(slackUserId);
    else userCache.clear();
  }

  const defaultUserResolver: SlackUserResolver = async (companyId, slackUserId) => {
    const cached = userCache.get(slackUserId);
    if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL_MS) {
      return cached.user;
    }
    const webClient = await client.getClientForCompany(companyId);
    if (!webClient) {
      userCache.set(slackUserId, { user: null, fetchedAt: Date.now() });
      return null;
    }
    let email: string | null = null;
    try {
      const info = await webClient.users.info({ user: slackUserId });
      const profile = (info as { user?: { profile?: { email?: string } } }).user?.profile;
      email = profile?.email?.trim() || null;
    } catch (err) {
      logger.warn({ err, slackUserId, companyId }, "slack users.info failed");
      return null;
    }
    if (!email) {
      userCache.set(slackUserId, { user: null, fetchedAt: Date.now() });
      return null;
    }
    const userRow = await db
      .select({ id: authUsers.id, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);
    if (!userRow) {
      userCache.set(slackUserId, { user: null, fetchedAt: Date.now() });
      return null;
    }
    const [adminRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(
          and(eq(instanceUserRoles.userId, userRow.id), eq(instanceUserRoles.role, "instance_admin")),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userRow.id),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);
    const user: SlackUser = {
      paperclipUserId: userRow.id,
      email: userRow.email,
      isInstanceAdmin: Boolean(adminRow),
      companyIds: memberships.map((row) => row.companyId),
    };
    userCache.set(slackUserId, { user, fetchedAt: Date.now() });
    return user;
  };
  const resolveSlackUser: SlackUserResolver = opts.resolveUser ?? defaultUserResolver;

  function userCanActOnCompany(user: SlackUser, companyId: string): boolean {
    if (user.isInstanceAdmin) return true;
    return user.companyIds.includes(companyId);
  }

  async function postApprovalDecidedUpdate(
    companyId: string,
    approvalId: string,
  ) {
    const approval = await approvals.getById(approvalId);
    if (!approval) return;
    const ref = (approval.payload as { slackMessageRef?: { channel?: unknown; ts?: unknown } } | null)
      ?.slackMessageRef;
    const channel = typeof ref?.channel === "string" ? ref.channel : null;
    const ts = typeof ref?.ts === "string" ? ref.ts : null;
    if (!channel || !ts) return;
    const fakeEvent: LiveEvent = {
      id: 0,
      companyId: approval.companyId,
      type: "approval.decided",
      createdAt: new Date().toISOString(),
      payload: {
        id: approval.id,
        type: approval.type,
        decision:
          approval.status === "approved"
            ? "approved"
            : approval.status === "rejected"
              ? "rejected"
              : approval.status === "revision_requested"
                ? "revision_requested"
                : approval.status,
        decidedByUserId: approval.decidedByUserId,
        decisionNote: approval.decisionNote,
      },
    };
    const message = formatApprovalDecided(fakeEvent, "");
    const result = await client.updateMessage(companyId, {
      channel,
      ts,
      text: message.text,
      blocks: message.blocks,
    });
    if (!result.ok && result.reason !== "integration_disabled") {
      logger.info({ companyId, approvalId, reason: result.reason }, "slack approval update failed");
    }
  }

  async function openDecisionModal(
    triggerId: string,
    approvalId: string,
    decision: "rejected" | "revision_requested",
    channel: string,
    messageTs: string,
    companyId: string,
  ): Promise<SlackInteractionResult> {
    const webClient = await client.getClientForCompany(companyId);
    if (!webClient) return ephemeral("Slack-integraatio ei ole käytössä tälle yritykselle.");
    const callbackId =
      decision === "rejected" ? "approval_reject_modal" : "approval_revision_modal";
    const titleText = decision === "rejected" ? "Reject approval" : "Request revision";
    const submitText = decision === "rejected" ? "Reject" : "Send back";
    const labelText = decision === "rejected" ? "Reason for rejection" : "What needs revising?";
    const metadata: ApprovalModalMetadata = {
      approvalId,
      decision,
      channel,
      messageTs,
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (webClient.views as any).open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: callbackId,
          private_metadata: JSON.stringify(metadata),
          title: { type: "plain_text", text: titleText, emoji: true },
          submit: { type: "plain_text", text: submitText, emoji: true },
          close: { type: "plain_text", text: "Cancel", emoji: true },
          blocks: [
            {
              type: "input",
              block_id: "decision_note",
              label: { type: "plain_text", text: labelText, emoji: true },
              element: {
                type: "plain_text_input",
                action_id: "value",
                multiline: true,
                min_length: 1,
              },
            },
          ],
        },
      });
    } catch (err) {
      logger.warn({ err, approvalId, decision }, "slack views.open failed");
      return ephemeral("Modaalin avaaminen epäonnistui.");
    }
    return { status: 200, body: "" };
  }

  async function handleApprovalApprove(
    payload: BlockActionsPayload,
    approvalId: string,
  ): Promise<SlackInteractionResult> {
    const approval = await approvals.getById(approvalId);
    if (!approval) return ephemeral("Approvalia ei löytynyt.");
    const slackUser = await resolveSlackUser(approval.companyId, payload.user.id);
    if (!slackUser) {
      return ephemeral(
        "Sähköpostiasi ei löydy Paperclipista. Pyydä boardilta käyttöoikeus.",
      );
    }
    if (!userCanActOnCompany(slackUser, approval.companyId)) {
      return ephemeral("Sinulla ei ole oikeuksia tähän yritykseen.");
    }
    if (approval.status !== "pending" && approval.status !== "revision_requested") {
      await postApprovalDecidedUpdate(approval.companyId, approvalId);
      return ephemeral(`Tämä approval on jo käsitelty (${approval.status}).`);
    }
    try {
      await approvals.approve(approvalId, slackUser.paperclipUserId, null);
    } catch (err) {
      logger.warn({ err, approvalId }, "slack approval approve failed");
      return ephemeral("Hyväksyminen epäonnistui.");
    }
    return { status: 200, body: "" };
  }

  async function handleApprovalDecisionWithNote(
    payload: ViewSubmissionPayload,
    metadata: ApprovalModalMetadata,
  ): Promise<SlackInteractionResult> {
    const note = payload.view.state.values.decision_note?.value?.value?.trim() ?? "";
    if (!note) {
      return {
        status: 200,
        body: {
          response_action: "errors",
          errors: { decision_note: "Lisää lyhyt perustelu." },
        },
      };
    }
    const approval = await approvals.getById(metadata.approvalId);
    if (!approval) {
      return {
        status: 200,
        body: {
          response_action: "errors",
          errors: { decision_note: "Approvalia ei löytynyt." },
        },
      };
    }
    const slackUser = await resolveSlackUser(approval.companyId, payload.user.id);
    if (!slackUser) {
      return {
        status: 200,
        body: {
          response_action: "errors",
          errors: { decision_note: "Sähköpostiasi ei löydy Paperclipista." },
        },
      };
    }
    if (!userCanActOnCompany(slackUser, approval.companyId)) {
      return {
        status: 200,
        body: {
          response_action: "errors",
          errors: { decision_note: "Ei oikeuksia tähän yritykseen." },
        },
      };
    }
    try {
      if (metadata.decision === "rejected") {
        await approvals.reject(metadata.approvalId, slackUser.paperclipUserId, note);
      } else {
        await approvals.requestRevision(metadata.approvalId, slackUser.paperclipUserId, note);
      }
    } catch (err) {
      logger.warn({ err, approvalId: metadata.approvalId }, "slack approval decision failed");
      return {
        status: 200,
        body: {
          response_action: "errors",
          errors: { decision_note: "Tallennus epäonnistui." },
        },
      };
    }
    return { status: 200, body: "" };
  }

  async function handleBlockActions(
    payload: BlockActionsPayload,
  ): Promise<SlackInteractionResult> {
    const action = payload.actions[0];
    if (!action) return ephemeral("Tuntematon toiminto.");
    const blockMeta = parseApprovalBlockId(action.block_id);
    if (!blockMeta) {
      if (action.action_id === "approval_open_in_ui") return { status: 200, body: "" };
      return ephemeral("Tuntematon nappi.");
    }
    const approvalId = blockMeta.approvalId;
    if (action.action_id === "approval_approve") {
      return handleApprovalApprove(payload, approvalId);
    }
    if (
      action.action_id === "approval_reject" ||
      action.action_id === "approval_request_revision"
    ) {
      const approval = await approvals.getById(approvalId);
      if (!approval) return ephemeral("Approvalia ei löytynyt.");
      const slackUser = await resolveSlackUser(approval.companyId, payload.user.id);
      if (!slackUser) {
        return ephemeral("Sähköpostiasi ei löydy Paperclipista.");
      }
      if (!userCanActOnCompany(slackUser, approval.companyId)) {
        return ephemeral("Sinulla ei ole oikeuksia tähän yritykseen.");
      }
      const decision: ApprovalModalMetadata["decision"] =
        action.action_id === "approval_reject" ? "rejected" : "revision_requested";
      const channel = payload.channel?.id ?? "";
      const messageTs = payload.message?.ts ?? "";
      return openDecisionModal(
        payload.trigger_id,
        approvalId,
        decision,
        channel,
        messageTs,
        approval.companyId,
      );
    }
    if (action.action_id === "approval_open_in_ui") {
      return { status: 200, body: "" };
    }
    return ephemeral("Tuntematon nappi.");
  }

  async function handleViewSubmission(
    payload: ViewSubmissionPayload,
  ): Promise<SlackInteractionResult> {
    const callbackId = payload.view.callback_id;
    if (
      callbackId !== "approval_reject_modal" &&
      callbackId !== "approval_revision_modal"
    ) {
      return { status: 200, body: "" };
    }
    const metadata = parseModalMetadata(payload.view.private_metadata);
    if (!metadata) {
      return {
        status: 200,
        body: {
          response_action: "errors",
          errors: { decision_note: "Sisäinen virhe (metadata puuttuu)." },
        },
      };
    }
    return handleApprovalDecisionWithNote(payload, metadata);
  }

  async function handle(payload: unknown): Promise<SlackInteractionResult> {
    if (!payload || typeof payload !== "object") {
      return { status: 200, body: "" };
    }
    const typed = payload as { type?: string };
    if (typed.type === "block_actions") {
      return handleBlockActions(payload as BlockActionsPayload);
    }
    if (typed.type === "view_submission") {
      return handleViewSubmission(payload as ViewSubmissionPayload);
    }
    return { status: 200, body: "" };
  }

  return { handle, invalidateUserCache };
}
