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
    expect(DEFAULT_RULES[0]).toHaveProperty("minClicks");
    expect(DEFAULT_RULES[0]).toHaveProperty("days");
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
  });
});
