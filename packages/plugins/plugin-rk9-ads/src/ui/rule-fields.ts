/**
 * Field lists of the rule editor. Copies of features/rules/schema.ts's enums:
 * importing the schema would put zod into the UI bundle. A test pins them.
 */

export const EDITOR_RULE_TYPES = ["threshold_pause", "pause_valid_until", "pause_fatigued", "pause_all_cap"] as const;
export const EDITOR_METRICS = ["cpc", "ctr", "cpm", "frequency", "spend"] as const;
export const EDITOR_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
export const EDITOR_AGGREGATES = ["each_day", "window_total"] as const;
export const EDITOR_MODES = ["shadow", "live"] as const;
export const BUILTIN_CAP_RULE_ID = "pause_all_cap";

export const RULE_TYPE_LABEL: Record<string, string> = {
  threshold_pause: "Kynnyspysäytys",
  pause_valid_until: "Voimassaolo päättynyt",
  pause_fatigued: "Väsynyt mainos",
  pause_all_cap: "Kuukausikatto 90 % (sisäänrakennettu)",
};

/** Number fields per rule type, in display order. */
export const NUMBER_FIELDS: Record<string, Array<{ key: string; label: string }>> = {
  threshold_pause: [
    { key: "threshold", label: "Kynnys" },
    { key: "days", label: "Päivät" },
    { key: "minImpressions", label: "Väh. näytöt" },
    { key: "minClicks", label: "Väh. linkkiklikit" },
    { key: "minSpendEur", label: "Väh. kulutus €" },
    { key: "cooldownHours", label: "Cooldown h" },
  ],
  pause_valid_until: [{ key: "cooldownHours", label: "Cooldown h" }],
  pause_fatigued: [{ key: "cooldownHours", label: "Cooldown h" }],
  pause_all_cap: [{ key: "cooldownHours", label: "Cooldown h" }],
};

/** The editor's row: what the rule's form holds; numbers stay text until save. */
export type EditorRule = Record<string, string | boolean>;

export function newRule(type: string, index: number): EditorRule {
  const base: EditorRule = { type, ruleId: `${type.replace(/_/g, "-")}-${index + 1}`, enabled: true, mode: "shadow", cooldownHours: "24" };
  if (type !== "threshold_pause") return base;
  return {
    ...base,
    metric: "cpc",
    operator: "gt",
    threshold: "",
    days: "7",
    aggregate: "window_total",
    minImpressions: "0",
    minClicks: "0",
    minSpendEur: "3",
  };
}

/** A saved rule (numbers) into editor text fields. */
export function toEditor(rule: Record<string, unknown>): EditorRule {
  const out: EditorRule = {};
  for (const [key, value] of Object.entries(rule)) {
    if (typeof value === "boolean" || typeof value === "string") out[key] = value;
    else if (typeof value === "number") out[key] = String(value);
  }
  return out;
}

/** Editor text back to the config shape. An empty number field is left out (the schema default, or its error). */
export function fromEditor(rule: EditorRule): Record<string, unknown> {
  const numbers = new Set((NUMBER_FIELDS[String(rule.type)] ?? []).map((field) => field.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    if (numbers.has(key)) {
      const text = String(value).trim().replace(",", ".");
      if (text !== "") out[key] = Number(text);
    } else if (rule.type === "pause_all_cap" && (key === "ruleId" || key === "enabled")) {
      // The built-in rule takes only mode and cooldown.
      continue;
    } else if (rule.type !== "threshold_pause" && ["metric", "operator", "aggregate"].includes(key)) {
      continue;
    } else {
      out[key] = value;
    }
  }
  return out;
}
