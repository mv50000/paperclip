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
 */

import { UI_PAUSE_RULE_ID } from "../ui/register.js";
import { parseRules, type RuleSet } from "./schema.js";

export const EDITABLE_RULE_TYPES = ["threshold_pause", "pause_all_cap", "pause_valid_until", "pause_fatigued"] as const;
export const MAX_EDITED_RULES = 50;

export type PreparedRules =
  | { ok: true; rules: { liveMode: boolean; list: Array<Record<string, unknown>> }; effective: RuleSet }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** propose_scale entries of the saved config, unchanged. */
function keptEntries(rawConfig: Record<string, unknown>): Array<Record<string, unknown>> {
  const rules = rawConfig.rules;
  if (!isRecord(rules) || !Array.isArray(rules.list)) return [];
  return rules.list.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "propose_scale");
}

export function prepareRules(rawConfig: Record<string, unknown>, input: { liveMode?: unknown; list?: unknown }): PreparedRules {
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
  return { ok: true, rules: block, effective: parsed.rules };
}
