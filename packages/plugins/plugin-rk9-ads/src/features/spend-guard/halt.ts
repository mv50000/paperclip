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
 * The marker also names who cleared the halt (RK9-582): `board` for
 * `clear-halt`, `rules_job` for the cap pause's headroom release. A marker
 * stored before RK9-582 is the bare id and names no clearer.
 *
 * Stored in plugin_state (no migration, G11), instance scope keyed by
 * company and rule, like the alert-check marker: one company runs one brand.
 * Each rule has its own key, so a timed halt never overwrites the kill
 * switch's.
 *
 * Every halt covers the whole company (RK9-565), also the scheduled pause's
 * when `meta.campaignId` limits its pause to one campaign: while it is in
 * force, no campaign of the brand activates before the morning. A halt that
 * is too broad only delays an activation, never spends. A scheduled pause at
 * a daytime `at` (07:00) therefore leaves a halt of about 23 hours every day;
 * `at` is meant for the evening.
 *
 * The cap pause's halt also ends when the rules job sees the month back under
 * the 90 % cap on two consecutive runs, e.g. after monthlyCapEur was raised
 * (rules/runner.ts, RK9-565).
 */

import { createHash, randomUUID } from "node:crypto";
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
  /**
   * The cap pause's month-to-date and cap when it paused (RK9-565). The rules
   * job lifts that halt early only on a reading not below this MTD.
   */
  cap?: { mtdEur: number; monthlyCapEur: number };
}

type StateCtx = Pick<PluginContext, "state">;

/** Who cleared a halt: a board user (`clear-halt`) or the rules job's headroom release. */
export type HaltClearer = "board" | "rules_job";

function haltKey(companyId: string, rule: HaltRule) {
  // The kill switch keeps the key it had before RK9-561, so a halt stored then still holds.
  const stateKey = rule === "scheduled_pause" || rule === "pause_all_cap" ? `halt:${companyId}:${rule}` : `halt:${companyId}`;
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey };
}

function clearedKey(companyId: string, rule: HaltRule) {
  const stateKey = rule === "scheduled_pause" || rule === "pause_all_cap" ? `halt-cleared:${companyId}:${rule}` : `halt-cleared:${companyId}`;
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey };
}

/**
 * The clear marker's halt id and clearer. A bare string is a marker from
 * before RK9-582, with no clearer; so is an object whose `by` is not a known
 * clearer. A value without a string id is damaged and clears nothing.
 */
function readMarker(value: unknown): { id: string; by?: HaltClearer } | null {
  if (typeof value === "string") return { id: value };
  if (value === null || typeof value !== "object") return null;
  const marker = value as { id?: unknown; by?: unknown };
  if (typeof marker.id !== "string") return null;
  return marker.by === "board" || marker.by === "rules_job" ? { id: marker.id, by: marker.by } : { id: marker.id };
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
 * A damaged record's id is a hash of all of its content, so a clear of one
 * damaged record never clears a later, different one (RK9-565: the first 500
 * characters were not enough). The very same damaged content written again
 * after a clear reads as cleared; only corruption or a hand edit writes one,
 * and every halt a pause stores is valid and carries a new id.
 */
function damagedId(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return `damaged:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * The rule's halt, or null when none is set, it was cleared, or it has
 * ended. Any stored value that is not a valid halt still counts as one, with
 * no end, so a damaged row never lifts it; a damaged clear marker clears
 * nothing.
 */
export async function readRuleHalt(ctx: StateCtx, companyId: string, rule: HaltRule, now: Date): Promise<HaltState | null> {
  const [value, cleared] = await Promise.all([ctx.state.get(haltKey(companyId, rule)), ctx.state.get(clearedKey(companyId, rule))]);
  if (value === null || value === undefined) return null;
  const halt: HaltState = isHalt(value)
    ? { ...value, rule }
    : { brandCode: "?", rule, id: damagedId(value), since: "?", reason: "unreadable halt record", initiator: { source: "job" } };
  if (readMarker(cleared)?.id === identity(halt)) return null;
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

/**
 * The rule's stored halt as written, also when it was cleared or has ended,
 * and whether it was cleared, by a board user or by the rules job's headroom
 * release. `clearedBy` is set only when the marker names the clearer: a
 * marker from before RK9-582 does not. Null for no record or a damaged one.
 */
export async function storedRuleHalt(
  ctx: StateCtx,
  companyId: string,
  rule: HaltRule,
): Promise<{ halt: HaltState; cleared: boolean; clearedBy?: HaltClearer } | null> {
  const [value, cleared] = await Promise.all([ctx.state.get(haltKey(companyId, rule)), ctx.state.get(clearedKey(companyId, rule))]);
  if (!isHalt(value)) return null;
  const halt = { ...value, rule };
  const marker = readMarker(cleared);
  if (marker?.id !== identity(halt)) return { halt, cleared: false };
  return marker.by ? { halt, cleared: true, clearedBy: marker.by } : { halt, cleared: true };
}

/**
 * Clears the rule's halt when it is the one named by `id` (or `since` for a
 * halt without one), and records who cleared it. False when it is not in force.
 */
export async function clearRuleHalt(ctx: StateCtx, companyId: string, rule: HaltRule, id: string, by: HaltClearer, now: Date = new Date()): Promise<boolean> {
  const halt = await readRuleHalt(ctx, companyId, rule, now);
  if (!halt || identity(halt) !== id) return false;
  await ctx.state.set(clearedKey(companyId, rule), { id, by });
  return true;
}

export function haltIdentity(halt: HaltState): string {
  return identity(halt);
}

export async function setHalt(ctx: StateCtx, companyId: string, halt: HaltState): Promise<void> {
  await ctx.state.set(haltKey(companyId, halt.rule), halt);
}

/**
 * A board user's clear of the halt in force whose `since` is the given one
 * (from the preview). `cleared` is null when no such halt is in force; `current` is the
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
    await ctx.state.set(clearedKey(companyId, rule), { id: identity(halt), by: "board" satisfies HaltClearer });
    return { cleared: halt, current: await readHalt(ctx, companyId, now) };
  }
  return { cleared: null, current: await readHalt(ctx, companyId, now) };
}

/**
 * The pause-ad halt (RK9-566): a pause of one ad from the UI leaves a short
 * halt for that ad before it closes the ad's cards and writes PAUSED.
 * activate_ad reads it with the company's halts, before every ACTIVE write
 * and after the writes, so an activation approved just before the pause
 * either sees it and pauses again what it set ACTIVE, or finished its
 * writes before the pause's own PAUSED write. It lasts AD_HALT_MINUTES, as
 * long as an approved activation counts as running
 * (gate/staging-card.ts ACTIVATION_IN_FLIGHT_MINUTES), so a new card of the
 * ad tapped in that time is refused too. activate_ad reads it, like the
 * company's halts, as of its own start (RK9-567): an activation that stalls
 * past the halt's end still sees it and pauses again what it set ACTIVE.
 * pause-ad also names a running activation (`activationRunning`). A board
 * user clears it early with `clear-halt` and `adId`.
 *
 * Stored like the company's halts, one key per ad. A damaged record holds
 * with no end, like theirs.
 */
export const AD_HALT_RULE = "pause_ad";
export const AD_HALT_MINUTES = 30;
const AD_ID_RE = /^\d{1,30}$/;

export interface AdHaltState {
  brandCode: string;
  rule: typeof AD_HALT_RULE;
  adId: string;
  id: string;
  since: string;
  until: string;
  reason: string;
  initiator: Initiator;
}

function adKeys(companyId: string, adId: string) {
  if (!AD_ID_RE.test(adId)) throw new Error(`invalid ad id for a halt: ${adId.slice(0, 40)}`);
  return {
    halt: { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `halt:${companyId}:ad:${adId}` },
    cleared: { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `halt-cleared:${companyId}:ad:${adId}` },
  };
}

function isAdHalt(value: unknown): value is AdHaltState {
  if (value === null || typeof value !== "object") return false;
  const halt = value as Partial<AdHaltState>;
  return (
    typeof halt.brandCode === "string" &&
    typeof halt.adId === "string" &&
    typeof halt.id === "string" &&
    typeof halt.since === "string" &&
    typeof halt.until === "string" &&
    Number.isFinite(Date.parse(halt.until))
  );
}

/** A new pause-ad halt for the ad, from now for AD_HALT_MINUTES. */
export function newAdHalt(input: { brandCode: string; adId: string; reason: string; initiator: Initiator; now: Date }): AdHaltState {
  return {
    brandCode: input.brandCode,
    rule: AD_HALT_RULE,
    adId: input.adId,
    id: randomUUID(),
    since: input.now.toISOString(),
    until: new Date(input.now.getTime() + AD_HALT_MINUTES * 60_000).toISOString(),
    reason: input.reason.slice(0, 300),
    initiator: input.initiator,
  };
}

export async function setAdHalt(ctx: StateCtx, companyId: string, halt: AdHaltState): Promise<void> {
  await ctx.state.set(adKeys(companyId, halt.adId).halt, halt);
}

/** The ad's pause-ad halt in force, or null. Throws when the state cannot be read. */
export async function readAdHalt(ctx: StateCtx, companyId: string, adId: string, now: Date = new Date()): Promise<AdHaltState | null> {
  const keys = adKeys(companyId, adId);
  const [value, cleared] = await Promise.all([ctx.state.get(keys.halt), ctx.state.get(keys.cleared)]);
  if (value === null || value === undefined) return null;
  const halt: AdHaltState = isAdHalt(value)
    ? { ...value, rule: AD_HALT_RULE }
    : { brandCode: "?", rule: AD_HALT_RULE, adId, id: damagedId(value), since: "?", until: "", reason: "unreadable halt record", initiator: { source: "job" } };
  if (typeof cleared === "string" && cleared === halt.id) return null;
  if (halt.until !== "" && Date.parse(halt.until) <= now.getTime()) return null;
  return halt;
}

/** Clears the ad's halt when it is the one named by `id`. Null when it is not in force. Throws when the state cannot be read or written. */
export async function clearAdHalt(ctx: StateCtx, companyId: string, adId: string, id: string, now: Date = new Date()): Promise<AdHaltState | null> {
  const halt = await readAdHalt(ctx, companyId, adId, now);
  if (!halt || halt.id !== id) return null;
  await ctx.state.set(adKeys(companyId, adId).cleared, id);
  return halt;
}
