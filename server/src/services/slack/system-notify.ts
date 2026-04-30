import type { Db } from "@paperclipai/db";
import type { InstanceSystemPauseState } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { createSlackClientService } from "./client.js";
import { createChannelResolver } from "./channel-resolver.js";
import { fields, header, section, contextLine, type FormattedMessage } from "./formatters.js";

export interface SystemPauseNotifierDeps {
  db: Db;
  listCompanyIds: () => Promise<string[]>;
}

function pausedMessage(state: InstanceSystemPauseState): FormattedMessage {
  const sourceLabel = state.source === "auto" ? "Automatic" : "Manual";
  const until = state.pausedUntil ? `<!date^${Math.floor(Date.parse(state.pausedUntil) / 1000)}^Resumes {date_short_pretty} at {time}|${state.pausedUntil}>` : "Until manually resumed";
  const session = state.quotaSnapshot?.sessionPct ?? null;
  const week = state.quotaSnapshot?.weekPct ?? null;
  const text = `:pause_button: Paperclip paused — ${state.reason}`;
  return {
    text,
    blocks: [
      header(":pause_button: Paperclip paused"),
      section(`*${sourceLabel} pause*\n${state.reason}`),
      fields([
        ["Resumes", until],
        ["Session", session != null ? `${session}%` : "—"],
        ["Week", week != null ? `${week}%` : "—"],
      ]),
      contextLine("New agent runs blocked. Active runs continue. Use UI Resume button or wait for auto-clear."),
    ],
  };
}

function resumedMessage(previous: InstanceSystemPauseState): FormattedMessage {
  const sourceLabel = previous.source === "auto" ? "auto-pause cleared" : "manual pause cleared";
  const text = `:arrow_forward: Paperclip resumed — ${sourceLabel}`;
  return {
    text,
    blocks: [
      header(":arrow_forward: Paperclip resumed"),
      section(`*${sourceLabel.replace(/^./, (c) => c.toUpperCase())}*`),
      contextLine(`Pause reason was: _${previous.reason}_`),
    ],
  };
}

export function createSystemPauseSlackNotifier(deps: SystemPauseNotifierDeps) {
  const slackClient = createSlackClientService(deps.db);
  const channelResolver = createChannelResolver(deps.db);

  async function broadcast(message: FormattedMessage): Promise<void> {
    const companyIds = await deps.listCompanyIds().catch((err) => {
      logger.warn({ err }, "system-pause notifier failed to list companies");
      return [] as string[];
    });
    await Promise.all(
      companyIds.map(async (companyId) => {
        const channel = await channelResolver.resolve(companyId, "company");
        if (!channel) return;
        const result = await slackClient.postMessage(companyId, {
          channel,
          text: message.text,
          blocks: message.blocks,
        });
        if (!result.ok && result.reason !== "integration_disabled") {
          logger.warn({ companyId, reason: result.reason }, "system-pause Slack notify failed");
        }
      }),
    );
  }

  return {
    onPaused: (state: InstanceSystemPauseState) => broadcast(pausedMessage(state)),
    onResumed: (previous: InstanceSystemPauseState) => broadcast(resumedMessage(previous)),
  };
}
