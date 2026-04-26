import type { Db } from "@paperclipai/db";
import { secretService } from "../secrets.js";
import { logger } from "../../middleware/logger.js";

const COMPANY_CHANNEL_SECRET_NAME = "slack.channel_id";
const BOARD_CHANNEL_SECRET_NAME = "slack.board_channel_id";

export type ChannelTarget = "company" | "board";

interface CachedChannel {
  value: string | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ChannelResolver {
  resolve(companyId: string, target: ChannelTarget): Promise<string | null>;
  invalidate(companyId: string): void;
}

export function createChannelResolver(db: Db): ChannelResolver {
  const secrets = secretService(db);
  const cache = new Map<string, CachedChannel>();

  function cacheKey(companyId: string, target: ChannelTarget) {
    return `${companyId}:${target}`;
  }

  async function resolve(companyId: string, target: ChannelTarget): Promise<string | null> {
    const key = cacheKey(companyId, target);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }
    const secretName = target === "board" ? BOARD_CHANNEL_SECRET_NAME : COMPANY_CHANNEL_SECRET_NAME;
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) {
      cache.set(key, { value: null, fetchedAt: Date.now() });
      return null;
    }
    let value: string;
    try {
      value = (await secrets.resolveSecretValue(companyId, secret.id, "latest")).trim();
    } catch (err) {
      logger.warn({ err, companyId, target }, "failed to resolve slack channel id");
      return null;
    }
    if (!value) {
      cache.set(key, { value: null, fetchedAt: Date.now() });
      return null;
    }
    cache.set(key, { value, fetchedAt: Date.now() });
    return value;
  }

  function invalidate(companyId: string) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${companyId}:`)) cache.delete(key);
    }
  }

  return { resolve, invalidate };
}
