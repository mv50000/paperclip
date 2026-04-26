import { WebClient } from "@slack/web-api";
import type { Db } from "@paperclipai/db";
import { secretService } from "../secrets.js";
import { logger } from "../../middleware/logger.js";

const SLACK_BOT_TOKEN_SECRET_NAME = "slack.bot_token";

interface CachedClient {
  client: WebClient;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

type Block = Record<string, unknown>;

export interface PostMessageInput {
  channel: string;
  text: string;
  blocks?: Block[];
  thread_ts?: string;
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
}

export interface UpdateMessageInput {
  channel: string;
  ts: string;
  text?: string;
  blocks?: Block[];
}

export interface SlackClientService {
  getClientForCompany(companyId: string): Promise<WebClient | null>;
  postMessage(
    companyId: string,
    args: PostMessageInput,
  ): Promise<{ ok: true; ts: string; channel: string } | { ok: false; reason: string }>;
  updateMessage(
    companyId: string,
    args: UpdateMessageInput,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  invalidateCache(companyId: string): void;
}

export function createSlackClientService(db: Db): SlackClientService {
  const secrets = secretService(db);
  const cache = new Map<string, CachedClient>();

  async function getClientForCompany(companyId: string): Promise<WebClient | null> {
    const cached = cache.get(companyId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.client;
    }
    const secret = await secrets.getByName(companyId, SLACK_BOT_TOKEN_SECRET_NAME);
    if (!secret) {
      cache.delete(companyId);
      return null;
    }
    let token: string;
    try {
      token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    } catch (err) {
      logger.warn({ err, companyId }, "failed to resolve slack bot token");
      return null;
    }
    const client = new WebClient(token, { retryConfig: { retries: 2 } });
    cache.set(companyId, { client, fetchedAt: Date.now() });
    return client;
  }

  async function postMessage(companyId: string, args: PostMessageInput) {
    const client = await getClientForCompany(companyId);
    if (!client) return { ok: false as const, reason: "integration_disabled" };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await client.chat.postMessage(args as any);
      if (!res.ok || !res.ts || !res.channel) {
        return { ok: false as const, reason: res.error ?? "unknown" };
      }
      return { ok: true as const, ts: res.ts, channel: res.channel };
    } catch (err) {
      const errorCode = (err as { data?: { error?: string } })?.data?.error ?? "exception";
      if (errorCode === "invalid_auth" || errorCode === "account_inactive" || errorCode === "token_revoked") {
        cache.delete(companyId);
      }
      logger.warn({ err, companyId, channel: args.channel, errorCode }, "slack postMessage failed");
      return { ok: false as const, reason: errorCode };
    }
  }

  async function updateMessage(companyId: string, args: UpdateMessageInput) {
    const client = await getClientForCompany(companyId);
    if (!client) return { ok: false as const, reason: "integration_disabled" };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await client.chat.update(args as any);
      if (!res.ok) return { ok: false as const, reason: res.error ?? "unknown" };
      return { ok: true as const };
    } catch (err) {
      const errorCode = (err as { data?: { error?: string } })?.data?.error ?? "exception";
      logger.warn({ err, companyId, channel: args.channel, errorCode }, "slack updateMessage failed");
      return { ok: false as const, reason: errorCode };
    }
  }

  function invalidateCache(companyId: string) {
    cache.delete(companyId);
  }

  return { getClientForCompany, postMessage, updateMessage, invalidateCache };
}
