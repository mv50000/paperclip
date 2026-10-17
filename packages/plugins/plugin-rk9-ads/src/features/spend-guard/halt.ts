/**
 * The kill switch's standing halt (RK9-557, RK9-517 verifier).
 *
 * A live kill switch (rule `kill_switch`) leaves a halt for the company's
 * brand in the plugin state. While it is set, activate_ad refuses: the
 * handler reads it right before its first Meta write and again before every
 * ACTIVE write, and a read that fails refuses too. A card sent after the
 * kill switch therefore cannot activate anything either.
 *
 * The halt has no expiry. Only a board user clears it, with the spend-guard
 * action `clear-halt` (an agent may preview it with dryRun). There is no
 * Telegram button for it.
 *
 * Stored in plugin_state (no migration, G11), instance scope keyed by
 * company, like the alert-check marker: one company runs one brand.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Initiator } from "./support.js";

export const HALT_NAMESPACE = "spend-guard";

export interface HaltState {
  brandCode: string;
  rule: "kill_switch";
  /** ISO time of the kill switch run that set it. */
  since: string;
  reason: string;
  initiator: Initiator;
}

type StateCtx = Pick<PluginContext, "state">;

function haltKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `halt:${companyId}` };
}

function isHalt(value: unknown): value is HaltState {
  if (value === null || typeof value !== "object") return false;
  const halt = value as Partial<HaltState>;
  return typeof halt.brandCode === "string" && typeof halt.since === "string";
}

/**
 * The company's halt, or null when none is set. Throws when the state cannot
 * be read. Any stored value that is not a valid halt still counts as a halt,
 * so a damaged row never lifts it.
 */
export async function readHalt(ctx: StateCtx, companyId: string): Promise<HaltState | null> {
  const value = await ctx.state.get(haltKey(companyId));
  if (value === null || value === undefined) return null;
  if (isHalt(value)) return value;
  return { brandCode: "?", rule: "kill_switch", since: "?", reason: "unreadable halt record", initiator: { source: "job" } };
}

export async function setHalt(ctx: StateCtx, companyId: string, halt: HaltState): Promise<void> {
  await ctx.state.set(haltKey(companyId), halt);
}

export async function clearHalt(ctx: StateCtx, companyId: string): Promise<void> {
  await ctx.state.delete(haltKey(companyId));
}
