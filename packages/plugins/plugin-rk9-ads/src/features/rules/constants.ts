/**
 * The rule engine's constants and the JSON Schema conditions of one
 * `rules.list` item, without zod (RK9-579). config.ts builds the manifest's
 * config schema from these, so the manifest bundle does not carry zod;
 * schema.ts re-exports them with the zod schemas.
 */

export const RULE_TYPES = ["threshold_pause", "pause_all_cap", "pause_valid_until", "pause_fatigued", "propose_scale"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_MODES = ["shadow", "live"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const RULE_METRICS = ["cpc", "ctr", "cpm", "frequency", "spend"] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const RULE_AGGREGATES = ["each_day", "window_total"] as const;
export type RuleAggregate = (typeof RULE_AGGREGATES)[number];

export const BUILTIN_PAUSE_ALL_CAP_PCT = 90;
/** The built-in rule's id. It is also the rule_actions rule_id of its decisions. */
export const BUILTIN_PAUSE_ALL_CAP_RULE_ID = "pause_all_cap";
export const MAX_SCALE_INCREASE_PCT = 20;
export const DEFAULT_RULE_COOLDOWN_HOURS = 24;
/** Bounds the cooldown lookback in rule_actions. */
export const MAX_RULE_COOLDOWN_HOURS = 720;
/**
 * The built-in cap pause may wait at most a day before it acts again, so its
 * cooldown can never switch it off for a month.
 */
export const MAX_CAP_COOLDOWN_HOURS = 24;
/** Bounds the insights window a threshold rule reads. */
export const MAX_RULE_DAYS = 14;
/** Bounds minImpressions and minClicks (RK9-531: the JSON schema and zod agree). */
export const MAX_RULE_MIN_COUNT = 1_000_000_000;
/** Bounds minSpendEur. */
export const MAX_RULE_MIN_SPEND_EUR = 1_000_000;
export const RULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const VARIANT_ONLY_KEYS = ["metric", "operator", "threshold", "days", "aggregate", "minImpressions", "minClicks", "minSpendEur", "maxIncreasePct"] as const;
const forbid = (keys: readonly string[]) => ({ not: { anyOf: keys.map((key) => ({ required: [key] })) } });
const notBuiltinId = { ruleId: { not: { const: BUILTIN_PAUSE_ALL_CAP_RULE_ID } } };

/**
 * The per-type rules of `ruleSchema` as JSON Schema conditions for one
 * `rules.list` item (config.ts). The host checks a saved config with Ajv
 * against the manifest schema; without these, a config could pass the save
 * and then fail parseRules(), which turns the whole brand off.
 */
export const RULE_ITEM_JSON_CONDITIONS = [
  {
    if: { properties: { type: { const: "threshold_pause" } }, required: ["type"] },
    then: {
      required: ["ruleId", "metric", "operator", "threshold", "minImpressions", "minClicks"],
      properties: notBuiltinId,
      ...forbid(["maxIncreasePct"]),
      if: { properties: { aggregate: { const: "window_total" } }, required: ["aggregate"] },
      then: { properties: { metric: { not: { const: "frequency" } } } },
    },
  },
  {
    if: { properties: { type: { const: "pause_all_cap" } }, required: ["type"] },
    then: {
      properties: {
        ruleId: { const: BUILTIN_PAUSE_ALL_CAP_RULE_ID },
        enabled: { const: true },
        cooldownHours: { type: "number", maximum: MAX_CAP_COOLDOWN_HOURS },
      },
      ...forbid(VARIANT_ONLY_KEYS),
    },
  },
  {
    if: { properties: { type: { enum: ["pause_valid_until", "pause_fatigued"] } }, required: ["type"] },
    then: { required: ["ruleId"], properties: notBuiltinId, ...forbid(VARIANT_ONLY_KEYS) },
  },
  {
    if: { properties: { type: { const: "propose_scale" } }, required: ["type"] },
    then: {
      required: ["ruleId", "enabled", "threshold", "minImpressions", "minClicks"],
      properties: { ...notBuiltinId, enabled: { const: false } },
      ...forbid(["metric", "operator", "aggregate", "minSpendEur"]),
    },
  },
];
