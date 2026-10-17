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
 * (ui/rule-fields.ts weakeningChanges), or turns live mode on, is refused
 * until the call names those changes in `confirmedWeakening` and sets
 * `confirmLive` (RK9-566): the refusal's `confirm` lists them for the UI's
 * typed words. The browser checks again right before its POST
 * (ui/host-config.ts). Both guard against an operator's mistake, not
 * against an instance admin: the host's config route saves any
 * schema-valid config without asking this worker.
 */

import { liveModeTurnedOn, savedRulesBlock, weakeningChanges } from "../../ui/rule-fields.js";
import { UI_PAUSE_RULE_ID } from "../ui/register.js";
import { parseRules, type RuleSet } from "./schema.js";

export const EDITABLE_RULE_TYPES = ["threshold_pause", "pause_all_cap", "pause_valid_until", "pause_fatigued"] as const;
export const MAX_EDITED_RULES = 50;

export type PreparedRules =
  | { ok: true; rules: { liveMode: boolean; list: Array<Record<string, unknown>> }; effective: RuleSet }
  | { ok: false; errors: string[]; confirm?: RulesConfirmation };

/** What a weakening or live-mode save must confirm (RK9-566). */
export interface RulesConfirmation {
  weakening: string[];
  liveOn: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** propose_scale entries of the saved config, unchanged. */
function keptEntries(rawConfig: Record<string, unknown>): Array<Record<string, unknown>> {
  const rules = rawConfig.rules;
  if (!isRecord(rules) || !Array.isArray(rules.list)) return [];
  return rules.list.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "propose_scale");
}

export function prepareRules(
  rawConfig: Record<string, unknown>,
  input: { liveMode?: unknown; list?: unknown; confirmedWeakening?: unknown; confirmLive?: unknown },
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
  const block = { liveMode: input.liveMode === true, list: [...edited, ...keptEntries(rawConfig)] };
  const parsed = parseRules(block);
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors };
  const saved = savedRulesBlock(rawConfig);
  const confirm: RulesConfirmation = { weakening: weakeningChanges(saved, block), liveOn: liveModeTurnedOn(saved, block) };
  const confirmed = Array.isArray(input.confirmedWeakening) ? input.confirmedWeakening.filter((entry): entry is string => typeof entry === "string") : [];
  const unconfirmed = confirm.weakening.filter((change) => !confirmed.includes(change));
  const liveUnconfirmed = confirm.liveOn && input.confirmLive !== true;
  if (unconfirmed.length > 0 || liveUnconfirmed) {
    return {
      ok: false,
      errors: [
        ...(unconfirmed.length > 0 ? [`The save weakens the spend protection and needs confirmation: ${unconfirmed.join(" ")}`] : []),
        ...(liveUnconfirmed ? ["The save turns live mode on and needs confirmation"] : []),
      ],
      confirm,
    };
  }
  return { ok: true, rules: block, effective: parsed.rules };
}
