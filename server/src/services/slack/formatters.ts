import type { LiveEvent } from "@paperclipai/shared";

type Block = Record<string, unknown>;

export interface FormattedMessage {
  text: string;
  blocks: Block[];
}

function publicUrl(): string {
  return (process.env.PAPERCLIP_PUBLIC_URL ?? "http://localhost:3100").replace(/\/$/, "");
}

function dashboardLink(companyId: string, label = "Open in Paperclip"): Block {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<${publicUrl()}/companies/${companyId}|${label}>`,
      },
    ],
  };
}

function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function fields(pairs: Array<[string, string]>): Block {
  return {
    type: "section",
    fields: pairs.map(([label, value]) => ({ type: "mrkdwn", text: `*${label}*\n${value}` })),
  };
}

function asString(value: unknown, fallback = "(unknown)"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatBudgetExceeded(event: LiveEvent, companyName: string): FormattedMessage {
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
      dashboardLink(event.companyId, "Open dashboard"),
    ],
  };
}

export function formatAgentStatus(event: LiveEvent, companyName: string): FormattedMessage {
  const payload = event.payload as Record<string, unknown>;
  const status = asString(payload.status, "unknown");
  const agentName = asString(payload.agentName ?? payload.name);
  const reason = typeof payload.pauseReason === "string" ? payload.pauseReason : null;
  const emoji = status === "terminated" ? ":no_entry:" : status === "error" ? ":warning:" : ":robot_face:";
  const text = `${emoji} ${agentName} → ${status} — ${companyName}`;
  const blocks: Block[] = [
    header(`${emoji} Agent ${status}`),
    section(`*${agentName}* in *${companyName}* changed status to *${status}*${reason ? `\n_${reason}_` : ""}`),
    dashboardLink(event.companyId, "Open agent"),
  ];
  return { text, blocks };
}

export function formatHeartbeatFailureBurst(
  event: LiveEvent,
  companyName: string,
  consecutiveFailures: number,
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
      dashboardLink(event.companyId, "Investigate"),
    ],
  };
}

