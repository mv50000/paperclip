/**
 * Failed undos of an activation that lost the race to a pause (RK9-565).
 *
 * When activate_ad sees a pause's halt during or after its writes, it pauses
 * again what it set ACTIVE. When Meta refuses one of those PAUSED writes
 * (rate limit, 5xx), the object may stay ACTIVE: the kill switch and a
 * scheduled pause already marked done do not run again. So the handler
 * stores the object here and sends one Telegram alert, and the
 * scheduled-pause job (every 5 min) pauses it again on each tick until Meta
 * confirms.
 *
 * The retry runs only while a halt is in force. Once none is (a board user
 * cleared it, which acknowledges the open undos, or a timed halt ended), the
 * entry is dropped with one audit row and one alert: activations are allowed
 * again, and a pause then could stop a newer, approved activation.
 *
 * Alerts use alert_dedupe markers (`undo-failed:<brand>:<gateRequestId>`,
 * `undo-dropped:<brand>:<gateRequestId>`) like the spend alerts (alerts.ts):
 * claimed before the send and given back when the send fails, so the next
 * tick sends again. A failed retry writes no audit row (the job run fails
 * instead); a successful retry and a drop write one each.
 *
 * Stored in plugin_state (no migration, G11), one key per company. The gate
 * handlers and the job run in one worker process, so a per-company lock
 * there serializes every write of the list. The job removes only the
 * entries it handled (object and gate request), so a newer failure of the
 * same object that arrived during its Meta calls stays.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { setObjectStatus } from "../../meta/methods.js";
import { isDryRun } from "../../meta/types.js";
import { HALT_NAMESPACE, readHalt, type HaltRule } from "./halt.js";
import { brandClient, recordAction, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "./support.js";

export const UNDO_FAILED_KIND = "undo_failed";
export const UNDO_DROPPED_KIND = "undo_dropped";

export type UndoObjectKind = "campaign" | "adset" | "ad";

export interface PendingUndo {
  objectId: string;
  kind: UndoObjectKind;
  gateRequestId: string;
  brandCode: string;
  /** The halt that won the race; null when the halt could not be read. */
  haltRule: HaltRule | null;
  /** ISO time the undo first failed. */
  since: string;
  error: string;
}

type StateCtx = Pick<PluginContext, "state">;

function undoKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `pending-undo:${companyId}` };
}

export function undoAlertKey(kind: "failed" | "dropped", brandCode: string, gateRequestId: string): string {
  return `undo-${kind}:${brandCode}:${gateRequestId}`;
}

function isPendingUndo(value: unknown): value is PendingUndo {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<PendingUndo>;
  return typeof entry.objectId === "string" && typeof entry.gateRequestId === "string" && typeof entry.kind === "string";
}

/** The company's open undos. Throws when the state cannot be read or the record is damaged. */
export async function readPendingUndos(ctx: StateCtx, companyId: string): Promise<PendingUndo[]> {
  const value = await ctx.state.get(undoKey(companyId));
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPendingUndo)) throw new Error("the pending undo record is damaged");
  return value;
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier write of the company's list has finished. */
async function withLock<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(companyId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  locks.set(companyId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(companyId) === tail) locks.delete(companyId);
  }
}

/** Adds (or replaces, by object id) open undos. */
export async function addPendingUndos(ctx: StateCtx, companyId: string, entries: readonly PendingUndo[]): Promise<void> {
  await withLock(companyId, async () => {
    const ids = new Set(entries.map((entry) => entry.objectId));
    const current = (await readPendingUndos(ctx, companyId)).filter((entry) => !ids.has(entry.objectId));
    await ctx.state.set(undoKey(companyId), [...current, ...entries]);
  });
}

/** Removes these entries. A newer failure of the same object (another gate request) that replaced one stays. */
async function removePendingUndos(ctx: StateCtx, companyId: string, entries: readonly Pick<PendingUndo, "objectId" | "gateRequestId">[]): Promise<void> {
  if (entries.length === 0) return;
  await withLock(companyId, async () => {
    const ids = new Set(entries.map((entry) => `${entry.objectId}|${entry.gateRequestId}`));
    const rest = (await readPendingUndos(ctx, companyId)).filter((entry) => !ids.has(`${entry.objectId}|${entry.gateRequestId}`));
    if (rest.length === 0) await ctx.state.delete(undoKey(companyId));
    else await ctx.state.set(undoKey(companyId), rest);
  });
}

const KIND_TEXT: Record<UndoObjectKind, string> = { campaign: "kampanja", adset: "ad set", ad: "mainos" };

function objectList(entries: readonly Pick<PendingUndo, "kind" | "objectId">[]): string {
  return entries.map((entry) => `${KIND_TEXT[entry.kind]} ${entry.objectId}`).join(", ");
}

export function undoAlertText(
  config: BrandConfig,
  kind: "failed" | "dropped",
  entries: readonly Pick<PendingUndo, "kind" | "objectId">[],
  stored = true,
): string {
  const name = config.displayName || config.brandCode;
  const lines =
    kind === "failed"
      ? [
          `⚠️ ${name}: aktivoinnin peruutus epäonnistui pysäytyksen aikana`,
          `Voi olla yhä ACTIVE-tilassa: ${objectList(entries)}`,
          stored
            ? "Peruutusta yritetään uudelleen 5 minuutin välein niin kauan kuin pysäytystila on päällä. Tarkista tila Metassa."
            : "Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa.",
        ]
      : [
          `⚠️ ${name}: pysäytystila päättyi ennen kuin aktivoinnin peruutus onnistui`,
          `Voi olla yhä ACTIVE-tilassa: ${objectList(entries)}`,
          "Uudelleenyritykset lopetettiin. Tarkista tila Metassa ja pysäytä tarvittaessa käsin.",
        ];
  return lines.join("\n").slice(0, 3900);
}

interface AlertDeps {
  store: OnceStore;
  notifier: SpendGuardNotifier;
}

/** One alert per gate request and kind. A failed send gives the marker back. Null when nothing failed. */
async function sendUndoAlert(
  deps: AlertDeps,
  companyId: string,
  config: BrandConfig,
  kind: "failed" | "dropped",
  gateRequestId: string,
  entries: readonly Pick<PendingUndo, "kind" | "objectId">[],
  stored = true,
): Promise<{ telegram: "sent" | "not_configured" | "skipped" | "failed"; error?: string }> {
  // Without Telegram there is no marker, so the alert goes out once Telegram is set up.
  if (!config.telegram) return { telegram: "not_configured" };
  const key = undoAlertKey(kind, config.brandCode, gateRequestId);
  try {
    if (!(await deps.store.claim(companyId, key, kind === "failed" ? UNDO_FAILED_KIND : UNDO_DROPPED_KIND, { gateRequestId }))) {
      return { telegram: "skipped" };
    }
  } catch (error) {
    return { telegram: "failed", error: `alert marker not claimed (${safeError(error)})` };
  }
  try {
    return { telegram: await deps.notifier.sendMessage(companyId, config, undoAlertText(config, kind, entries, stored)) };
  } catch (error) {
    await deps.store.release(companyId, key).catch(() => undefined);
    return { telegram: "failed", error: safeError(error) };
  }
}

export interface UndoFailure {
  kind: UndoObjectKind;
  objectId: string;
  error: string;
}

export interface UndoReport {
  /** The objects are stored for the retry. */
  stored: boolean;
  telegram: "sent" | "not_configured" | "skipped" | "failed";
  /** What failed: the store, the alert, or both. */
  error?: string;
}

/** activate_ad: an undo PAUSED write failed. Stores the objects for the retry and sends the alert. Never throws. */
export async function reportUndoFailure(
  deps: AlertDeps & { ctx: StateCtx },
  companyId: string,
  config: BrandConfig,
  input: { gateRequestId: string; haltRule: HaltRule | null; failed: readonly UndoFailure[] },
  now: Date,
): Promise<UndoReport> {
  const errors: string[] = [];
  let stored = false;
  try {
    await addPendingUndos(
      deps.ctx,
      companyId,
      input.failed.map((entry) => ({
        ...entry,
        gateRequestId: input.gateRequestId,
        brandCode: config.brandCode,
        haltRule: input.haltRule,
        since: now.toISOString(),
      })),
    );
    stored = true;
  } catch (error) {
    errors.push(`not stored for the retry (${safeError(error)})`);
  }
  const alert = await sendUndoAlert(deps, companyId, config, "failed", input.gateRequestId, input.failed, stored);
  if (alert.error) errors.push(`alert: ${alert.error}`);
  return { stored, telegram: alert.telegram, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

export interface UndoRetryDeps extends AlertDeps {
  ctx: PluginContext;
  ledger: Ledger;
  clientFor?: (companyId: string, config: BrandConfig, mode: "live" | "dryRun", initiator: Initiator) => MetaGraphClient;
}

function byRequest(entries: readonly PendingUndo[]): Map<string, PendingUndo[]> {
  const out = new Map<string, PendingUndo[]>();
  for (const entry of entries) out.set(entry.gateRequestId, [...(out.get(entry.gateRequestId) ?? []), entry]);
  return out;
}

/**
 * The scheduled-pause job's tick: pauses every open undo again while a halt
 * is in force, or drops them all when none is. Returns the failure lines of
 * the run; throws only when the record or the halt cannot be read.
 */
export async function retryPendingUndos(
  deps: UndoRetryDeps,
  companyId: string,
  config: BrandConfig,
  initiator: Initiator,
  now: Date,
): Promise<string[]> {
  const entries = await readPendingUndos(deps.ctx, companyId);
  if (entries.length === 0) return [];
  const brand = config.brandCode;
  const failures: string[] = [];
  const audit = (entry: PendingUndo, applied: boolean, error: string | null, message: string) =>
    recordAction(deps, {
      companyId,
      config,
      ruleId: `undo-${entry.gateRequestId}`,
      ruleType: entry.haltRule ?? "kill_switch",
      objectType: entry.kind,
      objectId: entry.objectId,
      action: "pause",
      dryRun: false,
      applied,
      reason: applied ? "activation undo retried after a failed pause" : "the halt ended before the activation undo succeeded",
      metrics: { gateRequestId: entry.gateRequestId, failedSince: entry.since, firstError: entry.error },
      initiator,
      error,
      message,
    });

  if (!(await readHalt(deps.ctx, companyId, now))) {
    for (const [gateRequestId, group] of byRequest(entries)) {
      for (const entry of group) await audit(entry, false, entry.error, `activation undo dropped for ${entry.kind} ${entry.objectId}: no halt in force`);
      const alert = await sendUndoAlert(deps, companyId, config, "dropped", gateRequestId, group);
      if (alert.error) failures.push(`${brand} activation undo: drop alert failed (${alert.error})`);
    }
    await removePendingUndos(deps.ctx, companyId, entries);
    failures.push(`${brand} activation undo: the halt ended first, ${entries.length} object(s) may still be ACTIVE (${objectList(entries)})`);
    return failures;
  }

  const client = deps.clientFor ? deps.clientFor(companyId, config, "live", initiator) : brandClient(deps, companyId, config, "live", { initiator });
  const done: PendingUndo[] = [];
  const stillFailing: PendingUndo[] = [];
  for (const entry of entries) {
    try {
      const result = await setObjectStatus(client, entry.objectId, "PAUSED");
      if (isDryRun(result) || !result.success) throw new Error(`Meta did not confirm status PAUSED on ${entry.objectId}`);
      done.push(entry);
      await audit(entry, true, null, `activation undo paused ${entry.kind} ${entry.objectId} on retry`);
    } catch (error) {
      stillFailing.push(entry);
      failures.push(`${brand} activation undo: pausing ${entry.kind} ${entry.objectId} failed again (${safeError(error)}), retrying next tick`);
    }
  }
  await removePendingUndos(deps.ctx, companyId, done);
  // The first alert may not have gone out: the marker makes this a no-op once it has.
  for (const [gateRequestId, group] of byRequest(stillFailing)) {
    const alert = await sendUndoAlert(deps, companyId, config, "failed", gateRequestId, group);
    if (alert.error) failures.push(`${brand} activation undo: alert failed (${alert.error})`);
  }
  return failures;
}
