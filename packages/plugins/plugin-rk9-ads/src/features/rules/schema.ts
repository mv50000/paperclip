/**
 * Rule schema of the rule engine (A11, RK9-515).
 *
 * A brand's `rules` block is `{ liveMode, list }`. Every rule is one variant
 * of a zod discriminated union on `type`:
 * - threshold_pause: pause an ad whose metric breaks a threshold over the N
 *   completed local days that end yesterday, behind minimum-data gates.
 *   `aggregate: "each_day"` (the default) needs every one of the N days to
 *   break it; `"window_total"` computes the metric once from the window's
 *   totals (RK9-536: a CPC ceiling on a small budget).
 * - pause_all_cap: the built-in pause of the whole ad account at 90 % of the
 *   monthly cap. It is always on: a config entry can only set its mode and
 *   cooldown, never remove it.
 * - pause_valid_until: pause an ad whose creative's validUntil has passed.
 * - pause_fatigued: pause an ad that A10's fatigue model calls fatigued.
 *   Opt-in: only a configured rule enables it.
 * - propose_scale: in the schema only and always disabled (G9).
 *
 * Every rule starts in shadow mode. A Meta write needs both the rule's
 * `mode: "live"` and the brand's `rules.liveMode: true`.
 *
 * `parseRules()` is what config.ts calls. Its error messages name the rule
 * (list index and ruleId) and the field.
 */

import { z } from "zod";
import {
  BUILTIN_PAUSE_ALL_CAP_RULE_ID,
  DEFAULT_RULE_COOLDOWN_HOURS,
  MAX_CAP_COOLDOWN_HOURS,
  MAX_RULE_COOLDOWN_HOURS,
  MAX_RULE_DAYS,
  MAX_RULE_MIN_COUNT,
  MAX_RULE_MIN_SPEND_EUR,
  MAX_SCALE_INCREASE_PCT,
  RULE_AGGREGATES,
  RULE_ID_RE,
  RULE_METRICS,
  RULE_MODES,
  RULE_OPERATORS,
  RULE_TYPES,
} from "./constants.js";

export * from "./constants.js";

const ruleId = z.string({ error: "is required" }).regex(RULE_ID_RE, { error: `must match ${RULE_ID_RE.source}` });
const mode = z.enum(RULE_MODES, { error: `must be one of ${RULE_MODES.join(", ")}` }).default("shadow");
const enabled = z.boolean({ error: "must be a boolean" }).default(true);
const cooldownHours = z
  .number({ error: "must be a finite number" })
  .min(1, { error: "must be >= 1" })
  .max(MAX_RULE_COOLDOWN_HOURS, { error: `must be <= ${MAX_RULE_COOLDOWN_HOURS}` })
  .default(DEFAULT_RULE_COOLDOWN_HOURS);
const minCount = z
  .number({ error: "is required (minimum-data gate)" })
  .int({ error: "must be an integer" })
  .min(0, { error: "must be >= 0" })
  .max(MAX_RULE_MIN_COUNT, { error: `must be <= ${MAX_RULE_MIN_COUNT}` });
const minSpendEur = z
  .number({ error: "must be a finite number" })
  .min(0, { error: "must be >= 0" })
  .max(MAX_RULE_MIN_SPEND_EUR, { error: `must be <= ${MAX_RULE_MIN_SPEND_EUR}` })
  .default(0);
const threshold = z.number({ error: "is required" }).positive({ error: "must be > 0" });
const days = z
  .number({ error: "must be a finite number" })
  .int({ error: "must be an integer" })
  .min(1, { error: "must be >= 1" })
  .max(MAX_RULE_DAYS, { error: `must be <= ${MAX_RULE_DAYS}` })
  .default(1);

const thresholdPause = z
  .strictObject({
    ruleId,
    type: z.literal("threshold_pause"),
    enabled,
    mode,
    metric: z.enum(RULE_METRICS, { error: `must be one of ${RULE_METRICS.join(", ")}` }),
    operator: z.enum(RULE_OPERATORS, { error: `must be one of ${RULE_OPERATORS.join(", ")}` }),
    threshold,
    /** The completed local days the rule reads, ending yesterday. */
    days,
    /** each_day: every day breaks the threshold; window_total: the window's totals do. */
    aggregate: z.enum(RULE_AGGREGATES, { error: `must be one of ${RULE_AGGREGATES.join(", ")}` }).default("each_day"),
    /** Impressions over those days; below it the rule never fires (learning phase). */
    minImpressions: minCount,
    /** Link clicks over those days; below it the rule never fires. */
    minClicks: minCount,
    /** Spend over those days in EUR; below it the rule never fires. */
    minSpendEur,
    cooldownHours,
  })
  .refine((rule) => !(rule.aggregate === "window_total" && rule.metric === "frequency"), {
    // Daily frequencies do not add up: reach is not additive across days.
    error: "frequency has no window total; use aggregate: \"each_day\"",
    path: ["aggregate"],
  });

const pauseAllCap = z.strictObject({
  ruleId: ruleId.default(BUILTIN_PAUSE_ALL_CAP_RULE_ID),
  type: z.literal("pause_all_cap"),
  enabled: z.literal(true, { error: "the built-in pause_all_cap cannot be disabled; set mode: \"shadow\" instead" }).default(true),
  mode,
  cooldownHours: z
    .number({ error: "must be a finite number" })
    .min(1, { error: "must be >= 1" })
    .max(MAX_CAP_COOLDOWN_HOURS, { error: `must be <= ${MAX_CAP_COOLDOWN_HOURS}` })
    .default(DEFAULT_RULE_COOLDOWN_HOURS),
});

const pauseValidUntil = z.strictObject({
  ruleId,
  type: z.literal("pause_valid_until"),
  enabled,
  mode,
  cooldownHours,
});

const pauseFatigued = z.strictObject({
  ruleId,
  type: z.literal("pause_fatigued"),
  enabled,
  mode,
  cooldownHours,
});

const proposeScale = z.strictObject({
  ruleId,
  type: z.literal("propose_scale"),
  enabled: z.literal(false, { error: "propose_scale must stay disabled (budget scaling is deferred, G9)" }),
  mode,
  /** Link CPC below this for `days` days. */
  threshold,
  days,
  minImpressions: minCount,
  minClicks: minCount,
  maxIncreasePct: z
    .number({ error: "must be a finite number" })
    .positive({ error: "must be > 0" })
    .max(MAX_SCALE_INCREASE_PCT, { error: `must be <= ${MAX_SCALE_INCREASE_PCT}` })
    .default(MAX_SCALE_INCREASE_PCT),
  cooldownHours,
});

export const ruleSchema = z.discriminatedUnion("type", [thresholdPause, pauseAllCap, pauseValidUntil, pauseFatigued, proposeScale]);

export type RuleConfig = z.output<typeof ruleSchema>;

export type ThresholdPauseRule = z.output<typeof thresholdPause>;
export type PauseAllCapRule = z.output<typeof pauseAllCap>;
export type ProposeScaleRule = z.output<typeof proposeScale>;

export interface RuleSet {
  /** Brand kill switch for live rule actions. Off means every rule runs in shadow. */
  liveMode: boolean;
  /** Effective rules: the configured ones (or the defaults) plus the built-in pause_all_cap, last. */
  list: RuleConfig[];
}

/**
 * Shipped when the config has no `rules.list`: a CPC ceiling, in shadow.
 *
 * It gates on spend, not on clicks (RK9-536). At a 100 EUR cap G3's daily
 * budget is 3.22 EUR, so a click gate (10 clicks in 2 days) could never be
 * met by an ad above about 0.64 EUR per click: the worst ads escaped it. The
 * window is 7 days of totals: an ad that spent at least 3 EUR there and got
 * fewer than spend / 0.50 link clicks breaks the ceiling, and so does one
 * with no link click at all.
 */
export const DEFAULT_RULES: readonly RuleConfig[] = Object.freeze([
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
    cooldownHours: DEFAULT_RULE_COOLDOWN_HOURS,
  },
]);

export function builtinPauseAllCap(overrides: Partial<Pick<PauseAllCapRule, "mode" | "cooldownHours">> = {}): PauseAllCapRule {
  return {
    ruleId: BUILTIN_PAUSE_ALL_CAP_RULE_ID,
    type: "pause_all_cap",
    enabled: true,
    mode: overrides.mode ?? "shadow",
    cooldownHours: overrides.cooldownHours ?? DEFAULT_RULE_COOLDOWN_HOURS,
  };
}

/** True when a rule may write to Meta: live on the rule and on the brand. */
export function isLive(rule: Pick<RuleConfig, "mode">, liveMode: boolean): boolean {
  return rule.mode === "live" && liveMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One zod issue as "<rule path>.<field>: <message>". */
function issueText(prefix: string, issue: z.core.$ZodIssue, raw: Record<string, unknown>): string[] {
  const field = issue.path.map(String).join(".");
  const at = (name: string) => `${prefix}.${name}`;
  if (issue.code === "unrecognized_keys") return issue.keys.map((key) => `${at(key)}: is not a known setting`);
  if (issue.code === "invalid_union" && field === "type") {
    const type = raw.type;
    return [
      type === undefined
        ? `${at("type")}: is required`
        : `${at("type")}: unknown rule type ${JSON.stringify(type)} (one of ${RULE_TYPES.join(", ")})`,
    ];
  }
  return [`${field ? at(field) : prefix}: ${issue.message}`];
}

/**
 * Parses the raw `rules` block. Without `list`, the defaults ship. The
 * built-in pause_all_cap is always appended; a list entry of that type only
 * sets its mode and cooldown.
 */
export function parseRules(raw: unknown): { rules: RuleSet; errors: string[] } {
  const errors: string[] = [];
  const block = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(block)) {
    return { rules: { liveMode: false, list: [builtinPauseAllCap()] }, errors: ["config.rules: must be an object"] };
  }
  for (const key of Object.keys(block)) {
    if (key !== "liveMode" && key !== "list") errors.push(`rules.${key}: is not a known setting`);
  }
  let liveMode = false;
  if (block.liveMode !== undefined && block.liveMode !== null) {
    if (typeof block.liveMode === "boolean") liveMode = block.liveMode;
    else errors.push("rules.liveMode: must be a boolean");
  }

  let configured: RuleConfig[] = [...DEFAULT_RULES];
  let builtin = builtinPauseAllCap();
  if (block.list !== undefined && block.list !== null) {
    configured = [];
    if (!Array.isArray(block.list)) {
      errors.push("rules.list: must be an array");
    } else {
      const seen = new Set<string>();
      let builtinSeen = false;
      block.list.forEach((item, index) => {
        const base = `rules.list[${index}]`;
        if (!isRecord(item)) {
          errors.push(`${base}: must be an object`);
          return;
        }
        const id = typeof item.ruleId === "string" ? item.ruleId : item.type === "pause_all_cap" ? BUILTIN_PAUSE_ALL_CAP_RULE_ID : undefined;
        const prefix = id ? `${base} (${id})` : base;
        const parsed = ruleSchema.safeParse(item);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) errors.push(...issueText(prefix, issue, item));
          return;
        }
        const rule = parsed.data;
        if (seen.has(rule.ruleId)) {
          errors.push(`${prefix}.ruleId: duplicate rule id ${rule.ruleId}`);
          return;
        }
        seen.add(rule.ruleId);
        if (rule.type === "pause_all_cap") {
          if (builtinSeen) {
            errors.push(`${prefix}.type: only one pause_all_cap entry is allowed`);
            return;
          }
          if (rule.ruleId !== BUILTIN_PAUSE_ALL_CAP_RULE_ID) {
            errors.push(`${prefix}.ruleId: the built-in pause_all_cap rule id is ${BUILTIN_PAUSE_ALL_CAP_RULE_ID}`);
            return;
          }
          builtinSeen = true;
          builtin = builtinPauseAllCap({ mode: rule.mode, cooldownHours: rule.cooldownHours });
          return;
        }
        if (rule.ruleId === BUILTIN_PAUSE_ALL_CAP_RULE_ID) {
          errors.push(`${prefix}.ruleId: ${BUILTIN_PAUSE_ALL_CAP_RULE_ID} is reserved for the built-in rule`);
          return;
        }
        configured.push(rule);
      });
    }
  }
  return { rules: { liveMode, list: [...configured, builtin] }, errors };
}
