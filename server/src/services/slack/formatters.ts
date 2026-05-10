import type { LiveEvent } from "@paperclipai/shared";

type Block = Record<string, unknown>;

export interface FormattedMessage {
  text: string;
  blocks: Block[];
}

export function publicUrl(): string {
  return (process.env.PAPERCLIP_PUBLIC_URL ?? "http://localhost:3100").replace(/\/$/, "");
}

export function companyBaseUrl(companyPrefix: string | null, companyId: string): string {
  // Prefer the prefix-based UI route (e.g. /AUR/...). Fall back to /companies/<uuid>
  // for legacy callers, but the UI now also handles that fallback via redirect.
  return companyPrefix ? `${publicUrl()}/${companyPrefix}` : `${publicUrl()}/companies/${companyId}`;
}

export function dashboardLink(companyId: string, companyPrefix: string | null = null, label = "Open in Paperclip"): Block {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<${companyBaseUrl(companyPrefix, companyId)}|${label}>`,
      },
    ],
  };
}

export function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

export function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function fields(pairs: Array<[string, string]>): Block {
  return {
    type: "section",
    fields: pairs.map(([label, value]) => ({ type: "mrkdwn", text: `*${label}*\n${value}` })),
  };
}

export function contextLine(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function asString(value: unknown, fallback = "(unknown)"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatBudgetExceeded(event: LiveEvent, companyName: string, companyPrefix: string | null = null): FormattedMessage {
  const payload = event.payload as Record<string, unknown>;
  const scopeName = asString(payload.scopeName ?? payload.entityName ?? companyName);
  const spentCents = asNumber(payload.spentCents);
  const budgetCents = asNumber(payload.budgetCents);
  const spent = spentCents !== null ? `€${(spentCents / 100).toFixed(2)}` : "(unknown)";
  const budget = budgetCents !== null ? `€${(budgetCents / 100).toFixed(2)}` : "(unknown)";
  const text = `:moneybag: Budget exceeded — ${companyName} / ${scopeName}`;
  return {
    text,
    blocks: [
      header(":moneybag: Budget exceeded"),
      section(`*${companyName}* — scope *${scopeName}*`),
      fields([
        ["Spent", spent],
        ["Budget", budget],
      ]),
      dashboardLink(event.companyId, companyPrefix, "Open dashboard"),
    ],
  };
}

export function formatAgentStatus(event: LiveEvent, companyName: string, companyPrefix: string | null = null): FormattedMessage {
  const payload = event.payload as Record<string, unknown>;
  const status = asString(payload.status, "unknown");
  const agentName = asString(payload.agentName ?? payload.name);
  const reason = typeof payload.pauseReason === "string" ? payload.pauseReason : null;
  const emoji = status === "terminated" ? ":no_entry:" : status === "error" ? ":warning:" : ":robot_face:";
  const text = `${emoji} ${agentName} → ${status} — ${companyName}`;
  const blocks: Block[] = [
    header(`${emoji} Agent ${status}`),
    section(`*${agentName}* in *${companyName}* changed status to *${status}*${reason ? `\n_${reason}_` : ""}`),
    dashboardLink(event.companyId, companyPrefix, "Open agent"),
  ];
  return { text, blocks };
}

export function formatHeartbeatFailureBurst(
  event: LiveEvent,
  companyName: string,
  consecutiveFailures: number,
  companyPrefix: string | null = null,
): FormattedMessage {
  const payload = event.payload as Record<string, unknown>;
  const agentName = asString(payload.agentName ?? payload.name);
  const errorMsg = typeof payload.error === "string" ? payload.error : null;
  const text = `:rotating_light: ${agentName} failed ${consecutiveFailures} runs in a row — ${companyName}`;
  return {
    text,
    blocks: [
      header(":rotating_light: Heartbeat failures"),
      section(
        `*${agentName}* in *${companyName}* has failed *${consecutiveFailures}* consecutive runs.${errorMsg ? `\n\`\`\`${errorMsg.slice(0, 400)}\`\`\`` : ""}`,
      ),
      dashboardLink(event.companyId, companyPrefix, "Investigate"),
    ],
  };
}

const APPROVAL_TYPE_EMOJI: Record<string, string> = {
  hire_agent: ":bust_in_silhouette:",
  approve_ceo_strategy: ":compass:",
  budget_override_required: ":money_with_wings:",
  request_board_approval: ":ballot_box_with_ballot:",
  risk_incident_acknowledgment: ":rotating_light:",
};

const APPROVAL_TYPE_LABEL: Record<string, string> = {
  hire_agent: "Hire agent",
  approve_ceo_strategy: "CEO strategy",
  budget_override_required: "Budget override",
  request_board_approval: "Board approval",
  risk_incident_acknowledgment: "Risk incident",
};

function approvalEmoji(type: string): string {
  return APPROVAL_TYPE_EMOJI[type] ?? ":pushpin:";
}

function approvalLabel(type: string): string {
  return APPROVAL_TYPE_LABEL[type] ?? type;
}

function actionsBlock(approvalId: string, companyId: string, companyPrefix: string | null): Block {
  const blockId = JSON.stringify({ kind: "approval-actions", approvalId });
  return {
    type: "actions",
    block_id: blockId,
    elements: [
      {
        type: "button",
        action_id: "approval_approve",
        style: "primary",
        text: { type: "plain_text", text: "Approve", emoji: true },
        value: approvalId,
      },
      {
        type: "button",
        action_id: "approval_reject",
        style: "danger",
        text: { type: "plain_text", text: "Reject", emoji: true },
        value: approvalId,
      },
      {
        type: "button",
        action_id: "approval_request_revision",
        text: { type: "plain_text", text: "Request revision", emoji: true },
        value: approvalId,
      },
      {
        type: "button",
        action_id: "approval_open_in_ui",
        text: { type: "plain_text", text: "Open in Paperclip", emoji: true },
        url: `${companyBaseUrl(companyPrefix, companyId)}/approvals/${approvalId}`,
      },
    ],
  };
}

export function formatApprovalCreated(event: LiveEvent, companyName: string, companyPrefix: string | null = null): FormattedMessage {
  const payload = event.payload as Record<string, unknown>;
  const approvalId = asString(payload.id, "");
  const type = asString(payload.type, "approval");
  const title = asString(
    payload.title ?? payload.subject,
    approvalLabel(type),
  );
  const emoji = approvalEmoji(type);
  const requestedByAgentId =
    typeof payload.requestedByAgentId === "string" ? payload.requestedByAgentId : null;
  const text = `${emoji} Approval needed — ${approvalLabel(type)} — ${companyName}`;
  const contextElements: Array<Record<string, unknown>> = [
    { type: "mrkdwn", text: `*${approvalLabel(type)}*` },
  ];
  if (requestedByAgentId) {
    contextElements.push({ type: "mrkdwn", text: `Requested by \`${requestedByAgentId}\`` });
  }
  return {
    text,
    blocks: [
      header(`${emoji} Approval needed`),
      section(`*${title}*\n_${companyName}_`),
      { type: "context", elements: contextElements },
      actionsBlock(approvalId, event.companyId, companyPrefix),
    ],
  };
}

export function formatApprovalDecided(event: LiveEvent, companyName: string, companyPrefix: string | null = null): FormattedMessage {
  const payload = event.payload as Record<string, unknown>;
  const approvalId = asString(payload.id, "");
  const type = asString(payload.type, "approval");
  const decision = asString(payload.decision, "decided");
  const decidedBy = asString(payload.decidedByName ?? payload.decidedByUserId, "board");
  const note = typeof payload.decisionNote === "string" ? payload.decisionNote : null;
  const verb =
    decision === "approved"
      ? ":white_check_mark: Approved"
      : decision === "rejected"
        ? ":x: Rejected"
        : decision === "revision_requested"
          ? ":memo: Revision requested"
          : decision;
  const text = `${verb} — ${approvalLabel(type)} — ${companyName}`;
  const blocks: Block[] = [
    section(`${verb} — *${approvalLabel(type)}* in *${companyName}*`),
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `By *${decidedBy}*` },
        ...(note ? [{ type: "mrkdwn", text: `_${note}_` }] : []),
        { type: "mrkdwn", text: `<${companyBaseUrl(companyPrefix, event.companyId)}/approvals/${approvalId}|Open in Paperclip>` },
      ],
    },
  ];
  return { text, blocks };
}

