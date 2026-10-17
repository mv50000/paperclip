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

export type RulesBlock = { liveMode: boolean; list: ReadonlyArray<Record<string, unknown>> };

/**
 * Copy of features/rules/schema.ts DEFAULT_RULES: what runs when the saved
 * config has no `rules.list` (RK9-566). A test pins it.
 */
export const EDITOR_DEFAULT_RULES: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    ruleId: "cpc-ceiling",
    type: "threshold_pause",
    enabled: true,
    mode: "shadow",
    metric: "cpc",
    operator: "gt",
    threshold: 0.5,
    days: 7,
    aggregate: "window_total",
    minImpressions: 0,
    minClicks: 0,
    minSpendEur: 3,
    cooldownHours: 24,
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A saved config's `rules` block as the weakening check reads it, with the
 * schema's defaults: liveMode false, and the default rules when `list` is
 * missing (RK9-566). The browser and the worker both read it this way.
 */
export function savedRulesBlock(configJson: Record<string, unknown>): RulesBlock {
  const rules = configJson.rules;
  if (!isRecord(rules)) return { liveMode: false, list: EDITOR_DEFAULT_RULES };
  const list = rules.list === undefined || rules.list === null ? EDITOR_DEFAULT_RULES : Array.isArray(rules.list) ? rules.list.filter(isRecord) : [];
  return { liveMode: rules.liveMode === true, list };
}

/** True when the save turns the brand's live mode on: it needs the typed word LIVE. */
export function liveModeTurnedOn(saved: RulesBlock, next: RulesBlock): boolean {
  return next.liveMode && !saved.liveMode;
}

/** The rule's identity across saves: the built-in cap by its type, the others by ruleId. */
function ruleKey(rule: Record<string, unknown>): string {
  return rule.type === "pause_all_cap" ? BUILTIN_CAP_RULE_ID : String(rule.ruleId ?? "");
}

function ruleLabel(rule: Record<string, unknown>): string {
  const type = String(rule.type);
  return type === "pause_all_cap" ? (RULE_TYPE_LABEL[type] ?? type) : `${RULE_TYPE_LABEL[type] ?? type} ${String(rule.ruleId ?? "")}`;
}

/** The list with the built-in cap the schema appends when no entry names it (shadow, 24 h). */
function withCap(list: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Record<string, unknown>> {
  return list.some((rule) => rule.type === "pause_all_cap") ? list : [...list, { type: "pause_all_cap", mode: "shadow", cooldownHours: 24 }];
}

/** A number field with the schema's default when it is missing. */
function num(rule: Record<string, unknown>, key: string, fallback: number): number {
  const value = rule[key];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const UPWARD = new Set(["gt", "gte"]);

/**
 * The parameter changes of a live rule that make it fire less (RK9-566).
 * A change whose direction is not clear counts as weakening.
 * - metric: any change;
 * - operator: a turn of direction (gt/gte <-> lt/lte), or gte -> gt and
 *   lte -> lt (equal values no longer fire);
 * - threshold, with the same operator direction: up for gt/gte, down for lt/lte;
 * - days and aggregate: any change. More days with each_day means every
 *   one of them must break the threshold; fewer days shrink the window the
 *   minimum-data gates sum over; a window_total over a different window
 *   reads a different average;
 * - minImpressions, minClicks, minSpendEur, cooldownHours: up.
 */
function parameterChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  const up = (key: string, label: string, fallback: number) => {
    const from = num(before, key, fallback);
    const to = num(after, key, fallback);
    if (to > from) out.push(`${label} ${from} → ${to}`);
  };
  if (before.type === "threshold_pause") {
    const metric = [String(before.metric ?? ""), String(after.metric ?? "")];
    const operator = [String(before.operator ?? ""), String(after.operator ?? "")];
    const sameDirection = UPWARD.has(operator[0]!) === UPWARD.has(operator[1]!);
    if (metric[0] !== metric[1]) out.push(`mittari ${metric[0]} → ${metric[1]}`);
    if (!sameDirection || (operator[0] === "gte" && operator[1] === "gt") || (operator[0] === "lte" && operator[1] === "lt")) {
      out.push(`vertailu ${operator[0]} → ${operator[1]}`);
    }
    if (metric[0] === metric[1] && sameDirection) {
      const from = num(before, "threshold", Number.NaN);
      const to = num(after, "threshold", Number.NaN);
      if (UPWARD.has(operator[1]!) ? !(to <= from) : !(to >= from)) out.push(`kynnys ${from} → ${to}`);
    }
    const aggregate = [String(before.aggregate ?? "each_day"), String(after.aggregate ?? "each_day")];
    if (aggregate[0] !== aggregate[1]) out.push(`laskenta ${aggregate[0]} → ${aggregate[1]}`);
    const days = [num(before, "days", 1), num(after, "days", 1)];
    if (days[1] !== days[0]) out.push(`päivät ${days[0]} → ${days[1]}`);
    up("minImpressions", "väh. näytöt", 0);
    up("minClicks", "väh. linkkiklikit", 0);
    up("minSpendEur", "väh. kulutus €", 0);
  }
  up("cooldownHours", "cooldown h", 24);
  return out;
}

/**
 * The changes from the saved rules to the prepared ones that weaken the
 * automatic spend protection (RK9-562, RK9-566): live mode off, a live rule
 * to shadow, an enabled rule removed or disabled, and a live rule's
 * parameter changed so that it fires less (parameterChanges). Each needs a
 * typed confirmation. A shadow rule pauses nothing, so tuning its
 * parameters is not weakening; that is what shadow mode is for.
 * propose_scale is not edited here and is always off. Defaults follow
 * features/rules/schema.ts: mode "shadow", enabled true, the built-in cap
 * appended when the list has none.
 *
 * The strings are the confirmation: the worker (rules.prepareSave) and the
 * browser's save (host-config.ts) compare them with what the operator
 * confirmed, so both build them with this function.
 */
export function weakeningChanges(saved: RulesBlock, next: RulesBlock): string[] {
  const out: string[] = [];
  if (saved.liveMode && !next.liveMode) out.push("Live-tila pois: yksikään sääntö ei enää pysäytä mainoksia Metassa.");
  const nextByKey = new Map(withCap(next.list).map((rule) => [ruleKey(rule), rule]));
  for (const rule of withCap(saved.list)) {
    // A disabled rule protects nothing: removing it weakens nothing.
    if (rule.type === "propose_scale" || rule.enabled === false) continue;
    const label = ruleLabel(rule);
    const after = nextByKey.get(ruleKey(rule));
    if (!after || after.type !== rule.type) {
      out.push(`${label}: poistetaan.`);
      continue;
    }
    if (after.enabled === false) out.push(`${label}: kytketään pois päältä.`);
    else if (rule.mode === "live" && after.mode !== "live") out.push(`${label}: live-tilasta varjotilaan.`);
    else if (rule.mode === "live") {
      const changes = parameterChanges(rule, after);
      if (changes.length > 0) out.push(`${label}: ${changes.join(", ")}.`);
    }
  }
  return out;
}
