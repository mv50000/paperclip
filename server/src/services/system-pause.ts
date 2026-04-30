import type {
  InstanceSystemPauseState,
  SystemPauseQuotaSnapshot,
  SystemPauseSource,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { instanceSettingsService } from "./instance-settings.js";

const CACHE_TTL_MS = 10_000;

export interface SystemPauseHooks {
  onPaused?: (state: InstanceSystemPauseState) => void | Promise<void>;
  onResumed?: (previous: InstanceSystemPauseState) => void | Promise<void>;
}

export interface SetPauseInput {
  reason: string;
  until: string | null;
  source: SystemPauseSource;
  quotaSnapshot?: SystemPauseQuotaSnapshot;
}

export function systemPauseService(
  instanceSvc: ReturnType<typeof instanceSettingsService>,
  hooks: SystemPauseHooks = {},
) {
  let cache: { value: InstanceSystemPauseState | null; expiresAt: number } | null = null;
  let inflightAutoClear: Promise<void> | null = null;

  async function readState(): Promise<InstanceSystemPauseState | null> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.value;
    const general = await instanceSvc.getGeneral();
    cache = { value: general.systemPause ?? null, expiresAt: now + CACHE_TTL_MS };
    return cache.value;
  }

  function invalidateCache(): void {
    cache = null;
  }

  function isMeaningfullyDifferent(
    previous: InstanceSystemPauseState | null,
    next: InstanceSystemPauseState,
  ): boolean {
    if (!previous) return true;
    if (previous.source !== next.source) return true;
    if (previous.reason !== next.reason) return true;
    if (previous.pausedUntil !== next.pausedUntil) return true;
    return false;
  }

  async function setPause(input: SetPauseInput): Promise<InstanceSystemPauseState> {
    const previous = await readState();
    const isTransition = previous == null || previous.source !== input.source;
    const state: InstanceSystemPauseState = {
      pausedAt: isTransition ? new Date().toISOString() : previous!.pausedAt,
      pausedUntil: input.until,
      reason: input.reason,
      source: input.source,
      ...(input.quotaSnapshot ? { quotaSnapshot: input.quotaSnapshot } : {}),
    };

    if (!isTransition && !isMeaningfullyDifferent(previous, state)) {
      cache = { value: state, expiresAt: Date.now() + CACHE_TTL_MS };
      return state;
    }

    if (!isTransition) {
      cache = { value: previous, expiresAt: Date.now() + CACHE_TTL_MS };
      return previous!;
    }

    await instanceSvc.updateGeneral({ systemPause: state });
    invalidateCache();
    logger.warn({ source: state.source, reason: state.reason, pausedUntil: state.pausedUntil }, "System paused");

    if (hooks.onPaused) {
      try {
        await hooks.onPaused(state);
      } catch (err) {
        logger.error({ err }, "system-pause onPaused hook failed");
      }
    }
    return state;
  }

  async function clearPause(source: SystemPauseSource): Promise<boolean> {
    const previous = await readState();
    if (!previous) return false;
    if (source === "auto" && previous.source === "manual") return false;

    await instanceSvc.updateGeneral({ systemPause: null });
    invalidateCache();
    logger.info({ clearedBy: source, previousSource: previous.source }, "System resumed");

    if (hooks.onResumed) {
      try {
        await hooks.onResumed(previous);
      } catch (err) {
        logger.error({ err }, "system-pause onResumed hook failed");
      }
    }
    return true;
  }

  async function isPaused(now: Date = new Date()): Promise<boolean> {
    const state = await readState();
    if (!state) return false;
    if (state.pausedUntil !== null && state.source === "auto") {
      const until = Date.parse(state.pausedUntil);
      if (!Number.isNaN(until) && now.getTime() > until) {
        if (!inflightAutoClear) {
          inflightAutoClear = clearPause("auto")
            .then(() => undefined)
            .catch((err) => {
              logger.error({ err }, "auto-clear after pausedUntil failed");
            })
            .finally(() => {
              inflightAutoClear = null;
            });
        }
        return false;
      }
    }
    return true;
  }

  async function assertNotPaused(): Promise<void> {
    if (await isPaused()) {
      const state = await readState();
      throw conflict(`System paused: ${state?.reason ?? "Paused"}`);
    }
  }

  async function getState(): Promise<InstanceSystemPauseState | null> {
    return readState();
  }

  return {
    getState,
    setPause,
    clearPause,
    isPaused,
    assertNotPaused,
    invalidateCache,
  };
}

export type SystemPauseService = ReturnType<typeof systemPauseService>;
