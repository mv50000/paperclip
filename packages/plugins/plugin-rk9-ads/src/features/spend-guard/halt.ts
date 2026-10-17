/**
 * The standing halts of the pauses (RK9-557, RK9-561).
 *
 * A live kill switch (rule `kill_switch`), cap pause (`pause_all_cap`) or
 * scheduled pause (`scheduled_pause`) leaves a halt for the company's brand
 * in the plugin state before its first Meta call. While one is set,
 * activate_ad refuses: the handler reads the halts right before its first
 * Meta write, again before every ACTIVE write and once after the writes, and
 * a read that fails refuses too. So an activation that was approved just
 * before a pause either sees the halt or its ACTIVE objects are in the
 * pause's listing, and a card sent after the pause cannot activate anything.
 *
 * - The kill switch's halt has no expiry.
 * - The scheduled pause's halt lasts until the next local morning
 *   (SCHEDULED_HALT_UNTIL in the brand's time zone).
 * - The cap pause's halt lasts until the next local month, when the
 *   month-to-date spend, and with it the headroom, starts again.
 *
 * A board user clears any of them early with the spend-guard action
 * `clear-halt` (an agent may preview it with dryRun). There is no Telegram
 * button for it. The clear names the halt by its `since`: plugin state has no
 * compare-and-delete, so the clear stores a marker with the cleared halt's id
 * instead of deleting it. A pause that sets a new halt between the preview
 * and the clear writes a new id, which the marker does not match, so the
 * newer halt stays.
 *
 * Stored in plugin_state (no migration, G11), instance scope keyed by
 * company and rule, like the alert-check marker: one company runs one brand.
 * Each rule has its own key, so a timed halt never overwrites the kill
 * switch's.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Initiator } from "./support.js";

export const HALT_NAMESPACE = "spend-guard";
/** The local time a scheduled pause's halt ends, the morning after the pause. */
export const SCHEDULED_HALT_UNTIL = "06:00";

/** The rules that leave a halt, strongest first. */
export const HALT_RULES = ["kill_switch", "scheduled_pause", "pause_all_cap"] as const;
export type HaltRule = (typeof HALT_RULES)[number];

export interface HaltState {
  brandCode: string;
  rule: HaltRule;
  /** Names this halt for a clear. Halts stored before RK9-561 have none; their `since` stands in. */
  id?: string;
  /** ISO time of the pause run that set it. */
  since: string;
  /** ISO end of a timed halt (scheduled pause, cap pause). The kill switch's halt has none. */
  until?: string;
  reason: string;
  initiator: Initiator;
}

type StateCtx = Pick<PluginContext, "state">;

function haltKey(companyId: string, rule: HaltRule) {
  // The kill switch keeps the key it had before RK9-561, so a halt stored then still holds.
  const stateKey = rule === "scheduled_pause" || rule === "pause_all_cap" ? `halt:${companyId}:${rule}` : `halt:${companyId}`;
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey };
}

function clearedKey(companyId: string, rule: HaltRule) {
  const stateKey = rule === "scheduled_pause" || rule === "pause_all_cap" ? `halt-cleared:${companyId}:${rule}` : `halt-cleared:${companyId}`;
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey };
}

function isHalt(value: unknown): value is HaltState {
  if (value === null || typeof value !== "object") return false;
  const halt = value as Partial<HaltState>;
  return (
    typeof halt.brandCode === "string" &&
    typeof halt.since === "string" &&
    (halt.id === undefined || typeof halt.id === "string") &&
    (halt.until === undefined || typeof halt.until === "string")
  );
}

function identity(halt: HaltState): string {
  return halt.id ?? halt.since;
}

/**
 * The rule's halt, or null when none is set, it was cleared, or it has
 * ended. Any stored value that is not a valid halt still counts as one, with
 * no end, so a damaged row never lifts it; a damaged clear marker clears
 * nothing.
 */
async function readRuleHalt(ctx: StateCtx, companyId: string, rule: HaltRule, now: Date): Promise<HaltState | null> {
  const [value, cleared] = await Promise.all([ctx.state.get(haltKey(companyId, rule)), ctx.state.get(clearedKey(companyId, rule))]);
  if (value === null || value === undefined) return null;
  const halt: HaltState = isHalt(value)
    ? { ...value, rule }
    : { brandCode: "?", rule, since: "?", reason: "unreadable halt record", initiator: { source: "job" } };
  if (typeof cleared === "string" && cleared === identity(halt)) return null;
  if (halt.until !== undefined) {
    const end = Date.parse(halt.until);
    if (Number.isFinite(end) && end <= now.getTime()) return null;
  }
  return halt;
}

/**
 * The company's halt in force, or null when none is. The kill switch's comes
 * first; of the timed ones, the one that lasts longest. Throws when the state
 * cannot be read.
 */
export async function readHalt(ctx: StateCtx, companyId: string, now: Date = new Date()): Promise<HaltState | null> {
  const halts = await Promise.all(HALT_RULES.map((rule) => readRuleHalt(ctx, companyId, rule, now)));
  const [killSwitch, ...timed] = halts;
  if (killSwitch) return killSwitch;
  let out: HaltState | null = null;
  for (const halt of timed) {
    if (!halt) continue;
    if (!out || halt.until === undefined || (out.until !== undefined && Date.parse(halt.until) > Date.parse(out.until))) out = halt;
  }
  return out;
}

export async function setHalt(ctx: StateCtx, companyId: string, halt: HaltState): Promise<void> {
  await ctx.state.set(haltKey(companyId, halt.rule), halt);
}

/**
 * Clears the halt in force whose `since` is the given one (from the
 * preview). `cleared` is null when no such halt is in force; `current` is the
 * halt still in force afterwards, if any. Throws when the state cannot be
 * read or written.
 */
export async function clearHalt(
  ctx: StateCtx,
  companyId: string,
  since: string,
  now: Date = new Date(),
): Promise<{ cleared: HaltState | null; current: HaltState | null }> {
  for (const rule of HALT_RULES) {
    const halt = await readRuleHalt(ctx, companyId, rule, now);
    if (!halt || halt.since !== since) continue;
    await ctx.state.set(clearedKey(companyId, rule), identity(halt));
    return { cleared: halt, current: await readHalt(ctx, companyId, now) };
  }
  return { cleared: null, current: await readHalt(ctx, companyId, now) };
}
