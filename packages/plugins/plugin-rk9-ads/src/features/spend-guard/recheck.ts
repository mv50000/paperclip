/**
 * The second listing of a kill switch or scheduled pause (RK9-565).
 *
 * The race argument of the halt (halt.ts) assumes that Meta's listing shows
 * a confirmed ACTIVE write at once. When the listing lags, an activation that
 * finished its writes just before the halt is missing from the pause's
 * listing, and the activation's last halt read was before the halt too. So a
 * live kill switch or scheduled pause stores a re-check, and the
 * scheduled-pause job's next tick at least RECHECK_DELAY_MS later lists the
 * ACTIVE objects again and pauses what it finds.
 *
 * - The re-check runs only while the halt the pause left (named by its id)
 *   is still in force. A board user who cleared it allowed activations
 *   again, so the re-check is dropped. A pause whose halt write failed
 *   re-checks anyway.
 * - It is for the read delay only: a re-check that a tick finds more than
 *   RECHECK_WINDOW_MS past its due time is dropped unrun.
 * - A failed listing or halt read keeps it for the next tick within that
 *   window.
 * - A pause that Meta refuses moves the object to the pause retry
 *   (pending-undo.ts, RK9-568), and the re-check is done: its listing ran.
 *   Only when the retry cannot be stored does the re-check stay.
 * - Every run that keeps it counts as failed, with its last error: a failed
 *   listing, halt read or unstored PAUSED write. A drop at the window's end
 *   then says that the ticks ran and failed instead of "no tick ran", and
 *   sends one Telegram alert (alert_dedupe marker), because what the late
 *   listing would show may still be ACTIVE (RK9-570).
 * - It sets no new halt and closes no cards; it notifies only when it paused
 *   something.
 * - Plugin state has no compare-and-delete (RK9-584). So a drop stores a
 *   marker with the dropped re-check's id instead of deleting it, and a
 *   failed run's count goes to its own key with that id. A newer pause that
 *   stores its re-check at any time during a tick has a new id: neither the
 *   marker nor the count touches it.
 *
 * The cap pause needs none: the rules job runs it again every hour while the
 * month stays over the cap. Stored in plugin_state (no migration, G11); the
 * tick is runDueRechecks in scheduled-pause.ts.
 */

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { HALT_NAMESPACE } from "./halt.js";

export const RECHECK_DELAY_MS = 60_000;
export const RECHECK_WINDOW_MS = 15 * 60_000;
export const RECHECK_RULES = ["kill_switch", "scheduled_pause"] as const;
export type RecheckRule = (typeof RECHECK_RULES)[number];

export interface Recheck {
  rule: RecheckRule;
  /** Names this re-check for its drop and its count (RK9-584). Re-checks stored before have none; `dueAt` and `haltId` stand in. */
  id?: string;
  /** The halt the pause left; null when its write failed. */
  haltId: string | null;
  /** ISO time from which a tick runs it. */
  dueAt: string;
  reason: string;
  /** Failed runs: the listing, the halt read, or PAUSED writes not stored for the retry (RK9-568, RK9-570). */
  attempts?: number;
  /** The last of those runs' errors (safeError), with what failed. */
  lastError?: string;
}

type StateCtx = Pick<PluginContext, "state">;

function recheckKey(companyId: string, rule: RecheckRule) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `recheck:${companyId}:${rule}` };
}

/** The id of the last dropped re-check (RK9-584). */
function droppedKey(companyId: string, rule: RecheckRule) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `recheck-done:${companyId}:${rule}` };
}

/** The failed runs of the re-check named by `id` (RK9-584). */
function attemptsKey(companyId: string, rule: RecheckRule) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `recheck-attempts:${companyId}:${rule}` };
}

export function recheckIdentity(recheck: Pick<Recheck, "id" | "dueAt" | "haltId">): string {
  return recheck.id ?? `${recheck.dueAt}|${recheck.haltId ?? ""}`;
}

export function isRecheckRule(rule: string): rule is RecheckRule {
  return (RECHECK_RULES as readonly string[]).includes(rule);
}

/**
 * One more failed run of this re-check. It writes only the count's key, with
 * the re-check's id, so a newer pause's re-check stored since the read keeps
 * its own count. The scheduled-pause job is the only writer.
 */
export async function noteRecheckFailure(ctx: StateCtx, companyId: string, recheck: Recheck, error: string): Promise<void> {
  await ctx.state.set(attemptsKey(companyId, recheck.rule), { id: recheckIdentity(recheck), attempts: (recheck.attempts ?? 0) + 1, lastError: error });
}

/** Stores the re-check of a live pause with a new id; a newer pause of the same rule replaces it. */
export async function scheduleRecheck(ctx: StateCtx, companyId: string, recheck: Recheck): Promise<void> {
  await ctx.state.set(recheckKey(companyId, recheck.rule), { ...recheck, id: recheck.id ?? randomUUID() });
}

/** Drops the re-check named by its id: a newer one stored meanwhile stays (RK9-584). */
export async function dropRecheck(ctx: StateCtx, companyId: string, recheck: Recheck): Promise<void> {
  await ctx.state.set(droppedKey(companyId, recheck.rule), recheckIdentity(recheck));
}

/** The rule's re-check, or null when none is stored or it was dropped. Its count comes from the count's key when that names it. */
export async function readRecheck(ctx: StateCtx, companyId: string, rule: RecheckRule): Promise<Recheck | null> {
  const [value, dropped, counted] = (await Promise.all([
    ctx.state.get(recheckKey(companyId, rule)),
    ctx.state.get(droppedKey(companyId, rule)),
    ctx.state.get(attemptsKey(companyId, rule)),
  ])) as [Partial<Recheck> | null, unknown, { id?: unknown; attempts?: unknown; lastError?: unknown } | null];
  if (!value || typeof value !== "object" || typeof value.dueAt !== "string") return null;
  const recheck: Recheck = {
    rule,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    haltId: typeof value.haltId === "string" ? value.haltId : null,
    dueAt: value.dueAt,
    reason: typeof value.reason === "string" ? value.reason : rule,
  };
  const id = recheckIdentity(recheck);
  if (dropped === id) return null;
  // A re-check stored before RK9-584 carries its count inline.
  const count = counted && typeof counted === "object" && counted.id === id ? counted : value;
  return {
    ...recheck,
    ...(typeof count.attempts === "number" && Number.isFinite(count.attempts) ? { attempts: count.attempts } : {}),
    ...(typeof count.lastError === "string" ? { lastError: count.lastError } : {}),
  };
}
