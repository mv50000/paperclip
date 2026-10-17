import { describe, expect, it } from "vitest";
import { parseBrandConfig } from "../src/config.js";
import { DEFAULT_RULES, parseRules } from "../src/features/rules/schema.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { brandConfig, importRepoModule } from "./fixtures.js";

const CPC = { ruleId: "cpc-ceiling", type: "threshold_pause", metric: "cpc", operator: "gt", threshold: 0.5, days: 2, minImpressions: 500, minClicks: 10 };

async function validate(rules: unknown) {
  return plugin.definition.onValidateConfig!(brandConfig({ rules }));
}

async function errorsOf(rules: unknown): Promise<string[]> {
  const result = await validate(rules);
  expect(result.ok).toBe(false);
  return result.errors ?? [];
}

describe("rule schema (A11)", () => {
  it("ships the CPC ceiling and the built-in pause_all_cap, every rule in shadow, when rules are omitted", () => {
    for (const raw of [undefined, null, {}, { liveMode: false }]) {
      const { rules, errors } = parseRules(raw);
      expect(errors).toEqual([]);
      expect(rules.liveMode).toBe(false);
      expect(rules.list).toEqual([
        { ...DEFAULT_RULES[0] },
        { ruleId: "pause_all_cap", type: "pause_all_cap", enabled: true, mode: "shadow", cooldownHours: 24 },
      ]);
    }
    expect(DEFAULT_RULES[0]).toMatchObject({ type: "threshold_pause", metric: "cpc", operator: "gt", threshold: 0.5, mode: "shadow" });
    // RK9-536: a spend gate over a 7-day window total, no click gate.
    expect(DEFAULT_RULES[0]).toMatchObject({ days: 7, aggregate: "window_total", minSpendEur: 3, minClicks: 0, minImpressions: 0 });
  });

  it("keeps the built-in pause_all_cap when rules[] is empty, and an entry can only switch its mode", async () => {
    expect(parseRules({ list: [] }).rules.list).toEqual([
      { ruleId: "pause_all_cap", type: "pause_all_cap", enabled: true, mode: "shadow", cooldownHours: 24 },
    ]);
    const live = parseRules({ liveMode: true, list: [{ type: "pause_all_cap", mode: "live", cooldownHours: 6 }] });
    expect(live.errors).toEqual([]);
    expect(live.rules.list).toEqual([{ ruleId: "pause_all_cap", type: "pause_all_cap", enabled: true, mode: "live", cooldownHours: 6 }]);

    const errors = await errorsOf({ list: [{ type: "pause_all_cap", enabled: false }] });
    expect(errors).toEqual([expect.stringMatching(/^rules\.list\[0\] \(pause_all_cap\)\.enabled: the built-in pause_all_cap cannot be disabled/)]);
    expect(await errorsOf({ list: [{ ruleId: "my-cap", type: "pause_all_cap" }] })).toEqual([
      "rules.list[0] (my-cap).ruleId: the built-in pause_all_cap rule id is pause_all_cap",
    ]);
    expect(await errorsOf({ list: [{ ...CPC, ruleId: "pause_all_cap" }] })).toEqual([
      "rules.list[0] (pause_all_cap).ruleId: pause_all_cap is reserved for the built-in rule",
    ]);
  });

  it("validates through onValidateConfig and accepts every rule type", async () => {
    expect(
      await validate({
        liveMode: true,
        list: [
          CPC,
          { ruleId: "low-ctr", type: "threshold_pause", metric: "ctr", operator: "lt", threshold: 0.8, minImpressions: 2000, minClicks: 0 },
          { ruleId: "expired", type: "pause_valid_until" },
          { ruleId: "tired", type: "pause_fatigued", mode: "live", cooldownHours: 48 },
          { ruleId: "scale", type: "propose_scale", enabled: false, threshold: 0.2, days: 3, minImpressions: 1000, minClicks: 20, maxIncreasePct: 20 },
          { type: "pause_all_cap", mode: "live" },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["an unknown type", { ruleId: "x", type: "scale_budget" }, 'rules.list[0] (x).type: unknown rule type "scale_budget"'],
    ["a missing type", { ruleId: "x" }, "rules.list[0] (x).type: is required"],
    ["a zero threshold", { ...CPC, threshold: 0 }, "rules.list[0] (cpc-ceiling).threshold: must be > 0"],
    ["a negative threshold", { ...CPC, threshold: -0.5 }, "rules.list[0] (cpc-ceiling).threshold: must be > 0"],
    ["propose_scale above 20 %", { ruleId: "s", type: "propose_scale", enabled: false, threshold: 0.2, minImpressions: 1, minClicks: 1, maxIncreasePct: 25 }, "rules.list[0] (s).maxIncreasePct: must be <= 20"],
    ["propose_scale enabled (G9)", { ruleId: "s", type: "propose_scale", enabled: true, threshold: 0.2, minImpressions: 1, minClicks: 1 }, "rules.list[0] (s).enabled: propose_scale must stay disabled"],
    ["a missing minImpressions", { ...CPC, minImpressions: undefined }, "rules.list[0] (cpc-ceiling).minImpressions: is required (minimum-data gate)"],
    ["a missing minClicks", { ...CPC, minClicks: undefined }, "rules.list[0] (cpc-ceiling).minClicks: is required (minimum-data gate)"],
    ["cooldownHours < 1", { ...CPC, cooldownHours: 0.5 }, "rules.list[0] (cpc-ceiling).cooldownHours: must be >= 1"],
    ["an unknown key", { ...CPC, windowDays: 3 }, "rules.list[0] (cpc-ceiling).windowDays: is not a known setting"],
    ["a bad mode", { ...CPC, mode: "on" }, "rules.list[0] (cpc-ceiling).mode: must be one of shadow, live"],
    ["days 0", { ...CPC, days: 0 }, "rules.list[0] (cpc-ceiling).days: must be >= 1"],
    ["an unknown aggregate", { ...CPC, aggregate: "sum" }, "rules.list[0] (cpc-ceiling).aggregate: must be one of each_day, window_total"],
    ["a window total of frequency", { ...CPC, metric: "frequency", aggregate: "window_total" }, "rules.list[0] (cpc-ceiling).aggregate: frequency has no window total"],
    ["a negative minSpendEur", { ...CPC, minSpendEur: -1 }, "rules.list[0] (cpc-ceiling).minSpendEur: must be >= 0"],
    ["minClicks above 1e9", { ...CPC, minClicks: 1e16 }, "rules.list[0] (cpc-ceiling).minClicks: must be <= 1000000000"],
    ["minImpressions above 1e9", { ...CPC, minImpressions: 1e10 }, "rules.list[0] (cpc-ceiling).minImpressions: must be <= 1000000000"],
  ])("rejects %s, naming the rule id and the field", async (_label, rule, message) => {
    const errors = await errorsOf({ list: [rule] });
    expect(errors.some((error) => error.startsWith(message))).toBe(true);
  });

  it("rejects duplicate rule ids, a non-array list and unknown rules keys", async () => {
    expect(await errorsOf({ list: [CPC, CPC] })).toEqual(["rules.list[1] (cpc-ceiling).ruleId: duplicate rule id cpc-ceiling"]);
    expect(await errorsOf({ list: { ruleId: "x" } })).toEqual(["rules.list: must be an array"]);
    expect(await errorsOf({ live: true })).toEqual(["rules.live: is not a known setting"]);
    expect(await errorsOf({ liveMode: "yes" })).toEqual(["rules.liveMode: must be a boolean"]);
  });

  it("starts every rule in shadow and keeps liveMode off by default", () => {
    const parsed = parseBrandConfig(brandConfig({ rules: { list: [CPC, { ruleId: "expired", type: "pause_valid_until" }] } }));
    expect(parsed.state).toBe("enabled");
    if (parsed.state !== "enabled") return;
    expect(parsed.config.rules.liveMode).toBe(false);
    expect(parsed.config.rules.list.every((rule) => rule.mode === "shadow")).toBe(true);
  });

  it("passes the host's Ajv check for a full rules block (the settings form saves it)", async () => {
    const validator = await importRepoModule<{
      validateInstanceConfig(config: Record<string, unknown>, schema: unknown): { valid: boolean; errors?: unknown[] };
    }>("server/src/services/plugin-config-validator.ts");
    const schema = manifest.instanceConfigSchema;
    const rules = {
      liveMode: true,
      list: [
        CPC,
        { ruleId: "expired", type: "pause_valid_until" },
        { ruleId: "tired", type: "pause_fatigued", mode: "live" },
        { type: "pause_all_cap", mode: "live" },
      ],
    };
    expect(validator.validateInstanceConfig(brandConfig({ rules }), schema).valid).toBe(true);
    expect(validator.validateInstanceConfig(brandConfig({ rules: { list: [{ ...CPC, threshold: 0 }] } }), schema).valid).toBe(false);
    // RK9-536: the spend-gated window rule, as the default ships it.
    const windowRule = { ...CPC, days: 7, aggregate: "window_total", minImpressions: 0, minClicks: 0, minSpendEur: 3 };
    const saved = brandConfig({ rules: { list: [windowRule, { type: "pause_all_cap" }] } });
    expect(validator.validateInstanceConfig(saved, schema).valid).toBe(true);
    // The save check adds no default for the new fields, so parseRules still accepts the saved config.
    expect(parseBrandConfig(saved).state).toBe("enabled");
  });

  it.each([
    ["a threshold rule without minImpressions", { ...CPC, minImpressions: undefined }],
    ["a threshold rule without minClicks", { ...CPC, minClicks: undefined }],
    ["a threshold rule without metric", { ...CPC, metric: undefined }],
    ["a threshold rule with maxIncreasePct", { ...CPC, maxIncreasePct: 10 }],
    ["a disabled cap rule", { type: "pause_all_cap", enabled: false }],
    ["a renamed cap rule", { ruleId: "cap", type: "pause_all_cap" }],
    ["a cap rule with a 25 h cooldown", { type: "pause_all_cap", cooldownHours: 25 }],
    ["a cap rule with a threshold", { type: "pause_all_cap", threshold: 0.9 }],
    ["propose_scale without enabled", { ruleId: "s", type: "propose_scale", threshold: 0.2, minImpressions: 1, minClicks: 1 }],
    ["propose_scale enabled", { ruleId: "s", type: "propose_scale", enabled: true, threshold: 0.2, minImpressions: 1, minClicks: 1 }],
    ["pause_valid_until with a metric", { ruleId: "v", type: "pause_valid_until", metric: "cpc" }],
    ["pause_fatigued without ruleId", { type: "pause_fatigued" }],
    ["a rule without type", { ruleId: "x" }],
    ["a rule using the reserved id", { ruleId: "pause_all_cap", type: "pause_valid_until" }],
    ["minClicks above 1e9 (RK9-531)", { ...CPC, minClicks: 1e16 }],
    ["a window total of frequency", { ...CPC, metric: "frequency", aggregate: "window_total" }],
    ["a cap rule with aggregate", { type: "pause_all_cap", aggregate: "window_total" }],
    ["pause_valid_until with minSpendEur", { ruleId: "v", type: "pause_valid_until", minSpendEur: 3 }],
    ["propose_scale with aggregate", { ruleId: "s", type: "propose_scale", enabled: false, threshold: 0.2, minImpressions: 1, minClicks: 1, aggregate: "window_total" }],
  ])("the host's save check refuses what parseRules refuses: %s", async (_label, rule) => {
    const validator = await importRepoModule<{
      validateInstanceConfig(config: Record<string, unknown>, schema: unknown): { valid: boolean };
    }>("server/src/services/plugin-config-validator.ts");
    const config = brandConfig({ rules: { list: [JSON.parse(JSON.stringify(rule))] } });
    expect(parseBrandConfig(config).state).toBe("invalid");
    expect(validator.validateInstanceConfig(config, manifest.instanceConfigSchema).valid).toBe(false);
  });

  it("keeps the built-in cap rule's cooldown at 24 h or less, so it cannot sleep through a month", async () => {
    expect(parseRules({ list: [{ type: "pause_all_cap", cooldownHours: 24 }] }).errors).toEqual([]);
    expect(await errorsOf({ list: [{ type: "pause_all_cap", cooldownHours: 25 }] })).toEqual([
      "rules.list[0] (pause_all_cap).cooldownHours: must be <= 24",
    ]);
  });
});
