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
 * - A failed listing keeps it for the next tick within that window.
 * - A pause that Meta refuses moves the object to the pause retry
 *   (pending-undo.ts, RK9-568), and the re-check is done: its listing ran.
 *   Only when the retry cannot be stored does the re-check stay, counting
 *   its failed runs and their last error, so a drop at the window's end
 *   says that the ticks ran and failed instead of "no tick ran".
 * - It sets no new halt and closes no cards; it notifies only when it paused
 *   something.
 *
 * The cap pause needs none: the rules job runs it again every hour while the
 * month stays over the cap. Stored in plugin_state (no migration, G11); the
 * tick is runDueRechecks in scheduled-pause.ts.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { HALT_NAMESPACE } from "./halt.js";

export const RECHECK_DELAY_MS = 60_000;
export const RECHECK_WINDOW_MS = 15 * 60_000;
export const RECHECK_RULES = ["kill_switch", "scheduled_pause"] as const;
export type RecheckRule = (typeof RECHECK_RULES)[number];

export interface Recheck {
  rule: RecheckRule;
  /** The halt the pause left; null when its write failed. */
  haltId: string | null;
  /** ISO time from which a tick runs it. */
  dueAt: string;
  reason: string;
  /** Runs whose pauses failed and whose objects could not be stored for the retry (RK9-568). */
  attempts?: number;
  /** The last of those runs' errors (safeError). */
  lastError?: string;
}

type StateCtx = Pick<PluginContext, "state">;

function recheckKey(companyId: string, rule: RecheckRule) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `recheck:${companyId}:${rule}` };
}

export function isRecheckRule(rule: string): rule is RecheckRule {
  return (RECHECK_RULES as readonly string[]).includes(rule);
}

/**
 * One more failed run of this re-check. Writes nothing when a newer pause
 * replaced it since it was read.
 */
export async function noteRecheckFailure(ctx: StateCtx, companyId: string, recheck: Recheck, error: string): Promise<void> {
  const current = await readRecheck(ctx, companyId, recheck.rule);
  if (!current || current.dueAt !== recheck.dueAt || current.haltId !== recheck.haltId) return;
  await ctx.state.set(recheckKey(companyId, recheck.rule), { ...current, attempts: (current.attempts ?? 0) + 1, lastError: error });
}

/** Stores the re-check of a live pause; a newer pause of the same rule replaces it. */
export async function scheduleRecheck(ctx: StateCtx, companyId: string, recheck: Recheck): Promise<void> {
  await ctx.state.set(recheckKey(companyId, recheck.rule), recheck);
}

export async function dropRecheck(ctx: StateCtx, companyId: string, rule: RecheckRule): Promise<void> {
  await ctx.state.delete(recheckKey(companyId, rule));
}

export async function readRecheck(ctx: StateCtx, companyId: string, rule: RecheckRule): Promise<Recheck | null> {
  const value = (await ctx.state.get(recheckKey(companyId, rule))) as Partial<Recheck> | null;
  if (!value || typeof value !== "object" || typeof value.dueAt !== "string") return null;
  return {
    rule,
    haltId: typeof value.haltId === "string" ? value.haltId : null,
    dueAt: value.dueAt,
    reason: typeof value.reason === "string" ? value.reason : rule,
    ...(typeof value.attempts === "number" && Number.isFinite(value.attempts) ? { attempts: value.attempts } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}
