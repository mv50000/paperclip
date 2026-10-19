/**
 * The operator UI's rule editor (A12, RK9-518), server side.
 *
 * The worker cannot write its own config: the host saves it
 * (POST /api/plugins/:pluginId/config, instance admin, schema-checked). So the
 * editor asks `rules.prepareSave` for the `rules` block to save, and the UI
 * puts exactly that block into the config it saves through the host.
 *
 * The editor saves pause rules only. A propose_scale entry already in the
 * config is kept as it is (the schema keeps it disabled, G9); one sent by the
 * editor is refused.
 *
 * A block that weakens the spend protection against the config saved now
 * (ui/rule-fields.ts weakeningChanges), turns live mode on, or makes a rule
 * live while live mode is on (liveChanges, RK9-563), is refused until the
 * call names those changes in `confirmedWeakening` and `confirmedLive`
 * (RK9-566): the refusal's `confirm` lists them for the UI's typed words.
 * LIVE confirms only the live changes it listed: one that appears after the
 * confirmation needs the word again (RK9-581).
 *
 * `loaded` is the rules block the editor's draft started from (data `rules`).
 * When the saved rules no longer equal it, the save is refused as `stale`
 * (RK9-581): a rule saved elsewhere after the page loaded is not overwritten
 * by the old draft, even when the change does not weaken anything. Saved
 * rules that do not parse skip this check, so the draft can still fix them.
 *
 * A config without `rules.list` runs the shipped default rules. A save that
 * keeps exactly those defaults leaves `list` out, so the defaults are not
 * frozen into the config and a later release's defaults still apply
 * (RK9-563). The browser checks again right before its POST
 * (ui/host-config.ts). Both guard against an operator's mistake, not
 * against an instance admin: the host's config route saves any
 * schema-valid config without asking this worker.
 */

import { liveChanges, savedRulesBlock, weakeningChanges } from "../../ui/rule-fields.js";
import { UI_PAUSE_RULE_ID } from "../ui/register.js";
import { parseRules, type RuleSet } from "./schema.js";

export const EDITABLE_RULE_TYPES = ["threshold_pause", "pause_all_cap", "pause_valid_until", "pause_fatigued"] as const;
export const MAX_EDITED_RULES = 50;

export type PreparedRules =
  /** `rules.list` is left out when the save keeps the default rules of a config that has no list. */
  | { ok: true; rules: { liveMode: boolean; list?: Array<Record<string, unknown>> }; effective: RuleSet }
  | { ok: false; errors: string[]; confirm?: RulesConfirmation; stale?: true };

/** What a weakening or live-mode save must confirm (RK9-566). */
export interface RulesConfirmation {
  weakening: string[];
  /** True when `live` is not empty: the save needs LIVE. */
  liveOn: boolean;
  /** What starts pausing ads in Meta (ui/rule-fields.ts liveChanges). */
  live: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON text: keys sorted, so a parsed rule equals the same rule written in another key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** True when the saved config has no `rules.list`: it runs the shipped defaults. */
function savedWithoutList(rawConfig: Record<string, unknown>): boolean {
  const rules = rawConfig.rules;
  return !isRecord(rules) || rules.list === undefined || rules.list === null;
}

/** propose_scale entries of the saved config, unchanged. */
function keptEntries(rawConfig: Record<string, unknown>): Array<Record<string, unknown>> {
  const rules = rawConfig.rules;
  if (!isRecord(rules) || !Array.isArray(rules.list)) return [];
  return rules.list.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "propose_scale");
}

export function prepareRules(
  rawConfig: Record<string, unknown>,
  input: { liveMode?: unknown; list?: unknown; confirmedWeakening?: unknown; confirmedLive?: unknown; loaded?: unknown },
): PreparedRules {
  const errors: string[] = [];
  if (input.liveMode !== undefined && typeof input.liveMode !== "boolean") errors.push("rules.liveMode: must be a boolean");
  if (!Array.isArray(input.list)) return { ok: false, errors: [...errors, "rules.list: must be an array"] };
  if (input.list.length > MAX_EDITED_RULES) return { ok: false, errors: [...errors, `rules.list: at most ${MAX_EDITED_RULES} rules`] };
  const edited: Array<Record<string, unknown>> = [];
  input.list.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`rules.list[${index}]: must be an object`);
      return;
    }
    if (!(EDITABLE_RULE_TYPES as readonly unknown[]).includes(entry.type)) {
      errors.push(`rules.list[${index}].type: the editor saves pause rules only (${EDITABLE_RULE_TYPES.join(", ")}); propose_scale stays off (G9)`);
      return;
    }
    // The UI's own pause rows carry this id; a rule with it would share their cooldown.
    if (entry.ruleId === UI_PAUSE_RULE_ID) {
      errors.push(`rules.list[${index}].ruleId: ${UI_PAUSE_RULE_ID} is reserved for pauses from the UI`);
      return;
    }
    edited.push({ ...entry });
  });
  if (errors.length > 0) return { ok: false, errors };
  if (input.loaded !== undefined) {
    // Saved rules that do not parse cannot be shown to reload; the draft may fix them, as before (rules/register.ts).
    const current = parseRules(rawConfig.rules);
    if (current.errors.length === 0 && canonical(input.loaded) !== canonical(current.rules)) {
      return { ok: false, errors: ["The saved rules changed after this page loaded; the page reloads them, then edit and save again"], stale: true };
    }
  }
  const block = { liveMode: input.liveMode === true, list: [...edited, ...keptEntries(rawConfig)] };
  const parsed = parseRules(block);
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors };
  const saved = savedRulesBlock(rawConfig);
  const live = liveChanges(saved, block);
  const confirm: RulesConfirmation = { weakening: weakeningChanges(saved, block), liveOn: live.length > 0, live };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  const confirmed = strings(input.confirmedWeakening);
  const unconfirmed = confirm.weakening.filter((change) => !confirmed.includes(change));
  const confirmedLive = strings(input.confirmedLive);
  const liveUnconfirmed = live.filter((change) => !confirmedLive.includes(change));
  if (unconfirmed.length > 0 || liveUnconfirmed.length > 0) {
    return {
      ok: false,
      errors: [
        ...(unconfirmed.length > 0 ? [`The save weakens the spend protection and needs confirmation: ${unconfirmed.join(" ")}`] : []),
        ...(liveUnconfirmed.length > 0 ? [`The save starts pausing ads in Meta and needs confirmation: ${liveUnconfirmed.join(" ")}`] : []),
      ],
      confirm,
    };
  }
  if (savedWithoutList(rawConfig) && canonical(parsed.rules.list) === canonical(parseRules({ liveMode: block.liveMode }).rules.list)) {
    return { ok: true, rules: { liveMode: block.liveMode }, effective: parsed.rules };
  }
  return { ok: true, rules: block, effective: parsed.rules };
}
