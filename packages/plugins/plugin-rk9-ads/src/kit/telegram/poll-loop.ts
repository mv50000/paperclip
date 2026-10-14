/**
 * Long-poll loop: one getUpdates consumer per bot token (A5, RK9-509).
 *
 * - The update offset lives in plugin state (instance scope, namespace
 *   "telegram", key `offset:<botKey>`). The key holds the token hash, never
 *   the token. The loop saves the offset after each processed batch.
 * - Telegram confirms updates only through a later `offset`, so a batch the
 *   loop fetched but did not process (shutdown, crash) is delivered again.
 *   The update handler must therefore be idempotent per update_id.
 * - `stop()` abandons the in-flight getUpdates at once and resolves after the
 *   update being processed finishes. The host cannot abort a `ctx.http`
 *   request, so that request ends on its own within `timeoutSeconds`; its
 *   result is discarded and no new getUpdates starts.
 * - 409 means another consumer owns the token (a second instance or a
 *   webhook). The loop logs it as an error and waits `conflictBackoffMs`.
 */

import type { PluginLogger, PluginStateClient } from "@paperclipai/plugin-sdk";
import { redactToken, TelegramApiError, type BotApi, type TelegramUpdate } from "./bot-api.js";

/** The host's worker->host RPC timeout and http.fetch timeout are 30 s. */
export const MAX_POLL_TIMEOUT_SECONDS = 25;
export const DEFAULT_POLL_TIMEOUT_SECONDS = 20;
export const POLL_ALLOWED_UPDATES = ["callback_query", "message"] as const;
export const TELEGRAM_STATE_NAMESPACE = "telegram";

export interface OffsetStore {
  load(): Promise<number | null>;
  save(offset: number): Promise<void>;
}

/** Offset store in `ctx.state` (instance scope, keyed by the bot key). */
export function stateOffsetStore(state: PluginStateClient, botKey: string): OffsetStore {
  if (!/^[0-9a-f]{16,64}$/.test(botKey)) throw new Error("botKey must be a token hash");
  const key = { scopeKind: "instance" as const, namespace: TELEGRAM_STATE_NAMESPACE, stateKey: `offset:${botKey}` };
  return {
    async load() {
      const value = await state.get(key);
      return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
    },
    async save(offset) {
      await state.set(key, offset);
    },
  };
}

export interface PollLoopOptions {
  api: BotApi;
  offsets: OffsetStore;
  /** Handles one update. A throw is logged and the update is skipped. */
  onUpdate(update: TelegramUpdate): Promise<void>;
  logger: PluginLogger;
  timeoutSeconds?: number;
  errorBackoffMs?: number;
  conflictBackoffMs?: number;
}

export interface PollLoop {
  readonly botKey: string;
  readonly running: boolean;
  start(): void;
  /** Stops the loop. Resolves when no getUpdates is pending on our side. */
  stop(): Promise<void>;
}

const STOPPED = Symbol("stopped");

export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { api, offsets, logger } = options;
  const timeout = Math.min(
    MAX_POLL_TIMEOUT_SECONDS,
    Math.max(0, Math.floor(options.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS)),
  );
  const errorBackoffMs = options.errorBackoffMs ?? 5_000;
  const conflictBackoffMs = options.conflictBackoffMs ?? 60_000;

  let stopped = false;
  let running = false;
  let done: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  const stopSignal = new Promise<typeof STOPPED>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });

  async function sleep(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), stopSignal]);
    if (timer) clearTimeout(timer);
  }

  async function run(): Promise<void> {
    let offset: number | null;
    try {
      offset = await offsets.load();
    } catch (error) {
      logger.error("telegram poll: offset unreadable, loop not started", { botKey: api.botKey, error: describe(error) });
      return;
    }
    logger.info("telegram poll: started", { botKey: api.botKey, offset, timeoutSeconds: timeout });

    while (!stopped) {
      let updates: TelegramUpdate[] | typeof STOPPED;
      try {
        updates = await Promise.race([
          api.getUpdates(
            { ...(offset !== null ? { offset } : {}), timeout, allowed_updates: [...POLL_ALLOWED_UPDATES] },
            { signal: controller.signal },
          ),
          stopSignal,
        ]);
      } catch (error) {
        if (stopped) break;
        if (error instanceof TelegramApiError && error.isConflict) {
          logger.error(
            "telegram poll: 409 conflict, another consumer uses this bot token (second instance or a webhook). Dev and prod need separate bots.",
            { botKey: api.botKey, error: error.message },
          );
          await sleep(conflictBackoffMs);
        } else if (error instanceof TelegramApiError && error.retryAfterSeconds) {
          logger.warn("telegram poll: rate limited", { botKey: api.botKey, retryAfterSeconds: error.retryAfterSeconds });
          await sleep(error.retryAfterSeconds * 1000);
        } else {
          logger.warn("telegram poll: getUpdates failed", { botKey: api.botKey, error: describe(error) });
          await sleep(errorBackoffMs);
        }
        continue;
      }
      // Fetched but not processed: Telegram delivers it again after a restart.
      if (updates === STOPPED || stopped) break;
      if (!Array.isArray(updates) || updates.length === 0) continue;

      const ordered = [...updates]
        .filter((update) => Number.isSafeInteger(update?.update_id))
        .sort((a, b) => a.update_id - b.update_id);
      const before = offset;
      for (const update of ordered) {
        if (offset !== null && update.update_id < offset) continue;
        try {
          await options.onUpdate(update);
        } catch (error) {
          logger.error("telegram poll: update handler failed, update skipped", {
            botKey: api.botKey,
            updateId: update.update_id,
            error: describe(error),
          });
        }
        offset = update.update_id + 1;
        if (stopped) break;
      }
      if (offset !== null && offset !== before) {
        try {
          await offsets.save(offset);
        } catch (error) {
          // Not fatal: the next save covers it, and update_id dedupe absorbs a redelivery.
          logger.warn("telegram poll: offset save failed", { botKey: api.botKey, error: describe(error) });
        }
      }
    }
    logger.info("telegram poll: stopped", { botKey: api.botKey, offset });
  }

  return {
    botKey: api.botKey,
    get running() {
      return running;
    },
    start() {
      if (running || stopped) return;
      running = true;
      done = run()
        .catch((error) => {
          logger.error("telegram poll: loop crashed", { botKey: api.botKey, error: describe(error) });
        })
        .finally(() => {
          running = false;
        });
    },
    async stop() {
      stopped = true;
      controller.abort();
      await done;
    },
  };
}

function describe(error: unknown): string {
  // TelegramApiError messages are already redacted; redact the rest by shape.
  return redactToken(error instanceof Error ? error.message : String(error)).slice(0, 300);
}
