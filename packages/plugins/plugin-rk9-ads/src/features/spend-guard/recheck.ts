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
 * - A failed listing or pause keeps it for the next tick within that window.
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
}

type StateCtx = Pick<PluginContext, "state">;

function recheckKey(companyId: string, rule: RecheckRule) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `recheck:${companyId}:${rule}` };
}

export function isRecheckRule(rule: string): rule is RecheckRule {
  return (RECHECK_RULES as readonly string[]).includes(rule);
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
  };
}
