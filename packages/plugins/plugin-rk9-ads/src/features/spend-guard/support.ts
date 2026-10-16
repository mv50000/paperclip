/**
 * Shared plumbing of the spend-guard feature (A6, RK9-511): Meta clients,
 * once-only markers, Telegram notices and the audit trail (rule_actions +
 * activity log).
 */

import type { PluginContext, PluginLogger } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import { createMetaClient, type MetaClientMode, type MetaGraphClient, type WritePlan } from "../../meta/graph.js";
import { redactText } from "../../meta/redact.js";
import { getTelegramController } from "../telegram/controller.js";
import { createSpendGuardHook, type GuardResult, type SpendGuardHookOptions } from "./guard.js";

export type ActionSource = "job" | "ui" | "telegram" | "agent";

/** Who started an action. Ids only, never a token. */
export interface Initiator {
  source: ActionSource;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  tgUserId?: number | null;
  jobRunId?: string | null;
}

export const SPEND_GUARD_ACTIVITY_PREFIX = "rk9-ads spend guard";

// ---------------------------------------------------------------------------
// Meta clients
// ---------------------------------------------------------------------------

/**
 * A brand's Meta client. Every write passes the spend guard hook, and every
 * refusal is audited. This feature never authorizes a spend-raising write
 * (no `authorizeSpend`), so its clients can only pause, rename or upload.
 * The activation gate (A9) passes its own `authorizeSpend`.
 */
export function brandClient(
  deps: { ctx: PluginContext; ledger: Ledger },
  companyId: string,
  config: BrandConfig,
  mode: MetaClientMode,
  options: { initiator: Initiator; authorizeSpend?: SpendGuardHookOptions["authorizeSpend"] },
): MetaGraphClient {
  const readClient = brandReadClient(deps.ctx, companyId, config);
  return createMetaClient(deps.ctx, {
    companyId,
    tokenRef: config.meta.accessTokenRef,
    mode,
    guardedWrite: createSpendGuardHook({
      config,
      readClient,
      authorizeSpend: options.authorizeSpend,
      onDecision: guardRefusalRecorder(deps, companyId, config, options.initiator),
    }),
  });
}

/** A read-only client: any write throws before a request is made. */
export function brandReadClient(ctx: PluginContext, companyId: string, config: BrandConfig): MetaGraphClient {
  return createMetaClient(ctx, { companyId, tokenRef: config.meta.accessTokenRef, mode: "readOnly" });
}

// ---------------------------------------------------------------------------
// Once-only markers (alert_dedupe)
// ---------------------------------------------------------------------------

/** Once-only markers that survive worker restarts. */
export interface OnceStore {
  /** True when this call created the marker. */
  claim(companyId: string, key: string, kind: string, metadata?: Record<string, unknown>): Promise<boolean>;
  /** The keys of `keys` that already have a marker. */
  claimed(companyId: string, keys: readonly string[]): Promise<string[]>;
  /** Gives back a marker this run claimed but could not follow through on. */
  release(companyId: string, key: string): Promise<void>;
}

export function sqlOnceStore(ledger: Ledger): OnceStore {
  return {
    async claim(companyId, key, kind, metadata = {}) {
      const { inserted } = await ledger.insertIfAbsent(companyId, "alert_dedupe", { dedupe_key: key, kind, metadata });
      return inserted;
    },
    async claimed(companyId, keys) {
      const out: string[] = [];
      for (const key of keys) {
        if ((await ledger.count(companyId, "alert_dedupe", { dedupe_key: key })) > 0) out.push(key);
      }
      return out;
    },
    async release(companyId, key) {
      await ledger.remove(companyId, "alert_dedupe", { dedupe_key: key });
    },
  };
}

export function memoryOnceStore(): OnceStore & { keys(): string[] } {
  const markers = new Set<string>();
  return {
    async claim(companyId, key) {
      const id = `${companyId}|${key}`;
      if (markers.has(id)) return false;
      markers.add(id);
      return true;
    },
    async claimed(companyId, keys) {
      return keys.filter((key) => markers.has(`${companyId}|${key}`));
    },
    async release(companyId, key) {
      markers.delete(`${companyId}|${key}`);
    },
    keys: () => [...markers],
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export type NoticeResult = "sent" | "not_configured";

/** Thrown when the brand has Telegram configured but the message did not go out. */
export class NoticeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeFailedError";
  }
}

export interface SpendGuardNotifier {
  /** A plain message to the brand chat. */
  sendMessage(companyId: string, config: BrandConfig, text: string): Promise<NoticeResult>;
  /** A message with a "Pysäytä kaikki" button (a pause_all gate card). */
  sendPauseCard(companyId: string, config: BrandConfig, text: string, validUntil: Date): Promise<NoticeResult>;
}

/** Uses the running Telegram controller (A5). */
export const controllerNotifier: SpendGuardNotifier = {
  async sendMessage(companyId, config, text) {
    if (!config.telegram) return "not_configured";
    const bot = getTelegramController()?.botFor(companyId);
    if (!bot) throw new NoticeFailedError("the brand's Telegram bot is not ready");
    try {
      await bot.api.sendMessage({ chat_id: bot.chatId, text });
    } catch (error) {
      throw new NoticeFailedError(safeError(error));
    }
    return "sent";
  },
  async sendPauseCard(companyId, config, text, validUntil) {
    if (!config.telegram) return "not_configured";
    const controller = getTelegramController();
    if (!controller) throw new NoticeFailedError("the Telegram controller is not running");
    try {
      await controller.sendGateCard({
        companyId,
        kind: "pause_all",
        validUntil,
        card: { media: "text", text },
        payload: { origin: "spend_alert" },
        labels: { approve: "⏸ Pysäytä kaikki", deny: "Ohita" },
      });
    } catch (error) {
      throw new NoticeFailedError(safeError(error));
    }
    return "sent";
  },
};

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export function safeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactText(text).slice(0, 300);
}

export interface RuleActionInput {
  companyId: string;
  config: BrandConfig;
  ruleId: string;
  ruleType: "pause_all_cap" | "scheduled_pause" | "data_gate" | "kill_switch";
  objectType: "account" | "campaign" | "adset" | "ad";
  objectId: string;
  action: "pause" | "pause_all" | "none";
  dryRun: boolean;
  applied: boolean;
  reason: string;
  metrics: Record<string, unknown>;
  initiator: Initiator;
  error?: string | null;
  /** Activity log line after the prefix, e.g. "kill switch paused 3". */
  message: string;
}

/**
 * Writes the rule_actions row and the activity entry of one decision. An
 * audit failure is logged, never thrown: it must not undo or block a pause.
 */
export async function recordAction(
  deps: { ctx: PluginContext; ledger: Ledger },
  input: RuleActionInput,
): Promise<void> {
  const { ctx, ledger } = deps;
  const initiator = { ...input.initiator };
  try {
    await ledger.insert(input.companyId, "rule_actions", {
      brand_code: input.config.brandCode,
      rule_id: input.ruleId,
      rule_type: input.ruleType,
      object_type: input.objectType,
      object_id: input.objectId,
      action: input.action,
      mode: input.dryRun ? "shadow" : "live",
      source: input.initiator.source,
      dry_run: input.dryRun,
      applied: input.applied,
      reason: input.reason.slice(0, 500),
      metrics: { ...input.metrics, initiator },
      error: input.error ?? null,
    });
  } catch (error) {
    logError(ctx.logger, "rule_actions insert failed", input.companyId, error);
  }
  try {
    await ctx.activity.log({
      companyId: input.companyId,
      message: `${SPEND_GUARD_ACTIVITY_PREFIX}: ${input.message}`,
      entityType: "rk9_ads_brand",
      entityId: input.config.brandCode,
      metadata: {
        rule: input.ruleType,
        action: input.action,
        reason: input.reason.slice(0, 500),
        dryRun: input.dryRun,
        applied: input.applied,
        initiator,
        ...input.metrics,
        ...(input.error ? { error: input.error } : {}),
      },
    });
  } catch (error) {
    logError(ctx.logger, "activity log failed", input.companyId, error);
  }
}

function logError(logger: PluginLogger, what: string, companyId: string, error: unknown): void {
  logger.error(`rk9-ads spend guard: ${what}`, { companyId, error: safeError(error) });
}

/** The figures of a guard decision for rule_actions.metrics and activity metadata. */
export function guardMetrics(result: GuardResult): Record<string, unknown> {
  const { allow: _allow, reason: _reason, detail: _detail, ...figures } = result;
  return figures;
}

/** Audits a refused spend-raising write (the hook's onDecision). */
export function guardRefusalRecorder(
  deps: { ctx: PluginContext; ledger: Ledger },
  companyId: string,
  config: BrandConfig,
  initiator: Initiator,
) {
  return async (result: GuardResult, plan: WritePlan): Promise<void> => {
    if (result.allow) return;
    await recordAction(deps, {
      companyId,
      config,
      ruleId: "spend-guard",
      ruleType: "pause_all_cap",
      objectType: "account",
      objectId: config.meta.adAccountId,
      action: "none",
      dryRun: plan.mode === "dryRun",
      applied: false,
      reason: result.reason,
      metrics: { ...guardMetrics(result), detail: result.detail, write: { method: plan.method, path: plan.path, fields: Object.keys(plan.fields) } },
      initiator,
      message: `refused ${plan.method} ${plan.path} (${result.reason})`,
    });
  };
}
