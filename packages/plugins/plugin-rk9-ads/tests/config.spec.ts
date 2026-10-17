import { describe, expect, it } from "vitest";
import {
  configSecretRefs,
  dailyBudgetCents,
  normaliseAdAccountId,
  parseBrandConfig,
  type BrandConfig,
} from "../src/config.js";
import { brandConfig, SECRET_A_BOT, SECRET_A_META, secretRef } from "./fixtures.js";

function enabled(raw: unknown): BrandConfig {
  const result = parseBrandConfig(raw);
  if (result.state !== "enabled") throw new Error(`expected enabled, got ${JSON.stringify(result)}`);
  return result.config;
}

function errorsOf(raw: unknown): string[] {
  const result = parseBrandConfig(raw);
  if (result.state !== "invalid") throw new Error(`expected invalid, got ${result.state}`);
  return result.errors;
}

describe("parseBrandConfig", () => {
  it("treats an absent or empty config as off, not as an error", () => {
    expect(parseBrandConfig(undefined)).toEqual({ state: "absent" });
    expect(parseBrandConfig(null)).toEqual({ state: "absent" });
    expect(parseBrandConfig({})).toEqual({ state: "absent" });
  });

  it("enables a minimal valid config and fills defaults", () => {
    const config = enabled(brandConfig());
    expect(config.brandCode).toBe("OLL");
    expect(config.timeZone).toBe("Europe/Helsinki");
    expect(config.namingPrefix).toBe("OLL");
    expect(config.meta.adAccountId).toBe("29231592883113369");
    expect(config.meta.specialAdCategories).toEqual(["NONE"]);
    expect(config.landing.defaultUrlKey).toBe("home");
    expect(config.telegram).toBeUndefined();
    expect(config.schedule.scheduledPause).toEqual({ enabled: false, at: "21:30" });
    expect(config.digest).toEqual({ enabled: true, time: "07:30", cpcWarnEur: 0.5, zeroSpendMode: "message" });
    expect(config.fatigue.issuesEnabled).toBe(false);
    // Defaults (A11): the CPC ceiling and the built-in cap pause, both in shadow.
    expect(config.rules.liveMode).toBe(false);
    expect(config.rules.list.map((rule) => [rule.ruleId, rule.type, rule.mode])).toEqual([
      ["cpc-ceiling", "threshold_pause", "shadow"],
      ["pause_all_cap", "pause_all_cap", "shadow"],
    ]);
  });

  it("has no enable switch and rejects unknown keys", () => {
    expect(errorsOf(brandConfig({ enabled: false }))).toEqual(["config.enabled: is not a known setting"]);
    expect(errorsOf(brandConfig({ schedule: { scheduledPause: { enable: true } } }))).toEqual([
      "schedule.scheduledPause.enable: is not a known setting",
    ]);
  });

  it("does not accept inherited object keys as a landing URL key", () => {
    const errors = errorsOf(brandConfig({
      landing: { allowedDomains: ["ololla.fi"], urls: { home: "https://ololla.fi/" }, defaultUrlKey: "constructor" },
    })).join("\n");
    expect(errors).toMatch(/no landing URL with key constructor/);
  });

  it("rejects legacy string secret refs (fail closed)", () => {
    const errors = errorsOf(brandConfig({
      meta: { adAccountId: "1", pageId: "2", accessTokenRef: SECRET_A_META },
    }));
    expect(errors.join("\n")).toMatch(/meta\.accessTokenRef: must be a secret reference/);
  });

  it("requires the core fields", () => {
    const errors = errorsOf({ brandCode: "oll" }).join("\n");
    expect(errors).toMatch(/config\.brandCode/);
    expect(errors).not.toMatch(/monthlyCapEur/);
    expect(errors).toMatch(/config\.meta: is required/);
    expect(errors).toMatch(/config\.landing: is required/);
  });

  it("rejects a non-positive cap, a non-numeric account and a landing host outside the allowlist", () => {
    const errors = errorsOf(brandConfig({
      monthlyCapEur: 0,
      meta: { adAccountId: "act_abc", pageId: "1", accessTokenRef: secretRef(SECRET_A_META) },
      landing: { allowedDomains: ["ololla.fi"], urls: { home: "https://evil.example.com/", plain: "http://ololla.fi/" } },
    })).join("\n");
    expect(errors).toMatch(/monthlyCapEur: must be > 0/);
    expect(errors).toMatch(/meta\.adAccountId: must be numeric/);
    expect(errors).toMatch(/landing\.urls\.home: host evil\.example\.com is not in landing\.allowedDomains/);
    expect(errors).toMatch(/landing\.urls\.plain: must be an https URL/);
  });

  it("allows subdomains of an allowed landing domain", () => {
    expect(enabled(brandConfig({
      landing: { allowedDomains: ["ololla.fi"], urls: { home: "https://www.ololla.fi/kohteet?x=1" } },
    })).landing.urls.home).toBe("https://www.ololla.fi/kohteet?x=1");
  });

  it("validates the telegram block and requires a webhook secret in webhook mode", () => {
    const config = enabled(brandConfig({
      telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-100123", allowedUserIds: [12345] },
    }));
    expect(config.telegram).toEqual({
      botTokenRef: secretRef(SECRET_A_BOT),
      chatId: "-100123",
      allowedUserIds: ["12345"],
      mode: "poll",
    });
    const errors = errorsOf(brandConfig({
      telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-100123", allowedUserIds: [], mode: "webhook" },
    })).join("\n");
    expect(errors).toMatch(/telegram\.allowedUserIds: must list at least one approver/);
    expect(errors).toMatch(/telegram\.webhookSecretRef: is required/);
    expect(errors).toMatch(/telegram\.webhookUrl: is required/);
    expect(
      errorsOf(brandConfig({
        telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-1", allowedUserIds: ["1"], webhookUrl: "http://insecure.example/hook" },
      })).join("\n"),
    ).toMatch(/telegram\.webhookUrl: must be an https URL/);
  });

  it("treats an untouched telegram block from the settings form as no telegram", () => {
    const config = enabled(brandConfig({ telegram: { allowedUserIds: [], mode: "poll" } }));
    expect(config.telegram).toBeUndefined();
    expect(errorsOf(brandConfig({ telegram: { chatId: "-1" } })).join("\n")).toMatch(/telegram\.botTokenRef: is required/);
  });

  it("keeps propose_scale disabled (G9) and validates rules", () => {
    const errors = errorsOf(brandConfig({
      rules: {
        list: [
          { ruleId: "scale", type: "propose_scale", enabled: true },
          { ruleId: "cpc", type: "threshold_pause" },
          { ruleId: "cpc", type: "pause_fatigued", cooldownHours: 0 },
        ],
      },
    })).join("\n");
    expect(errors).toMatch(/rules\.list\[0\] \(scale\)\.enabled: propose_scale must stay disabled/);
    expect(errors).toMatch(/rules\.list\[1\] \(cpc\)\.metric: must be one of/);
    expect(errors).toMatch(/rules\.list\[2\] \(cpc\)\.cooldownHours: must be >= 1/);

    const config = enabled(brandConfig({
      rules: {
        list: [{ ruleId: "cpc-ceiling", type: "threshold_pause", metric: "cpc", operator: "gt", threshold: 0.5, minImpressions: 500, minClicks: 10 }],
      },
    }));
    expect(config.rules.list[0]).toMatchObject({ mode: "shadow", enabled: true, cooldownHours: 24 });
  });

  it("rejects special ad categories that mix NONE with others", () => {
    const errors = errorsOf(brandConfig({
      meta: {
        adAccountId: "1",
        pageId: "2",
        accessTokenRef: secretRef(SECRET_A_META),
        specialAdCategories: ["NONE", "HOUSING"],
      },
    })).join("\n");
    expect(errors).toMatch(/NONE cannot be combined/);
  });

  it("lists secret refs with their host config paths", () => {
    const config = enabled(brandConfig({
      telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "1", allowedUserIds: ["2"] },
    }));
    expect(configSecretRefs(config).map((entry) => entry.configPath)).toEqual([
      "meta.accessTokenRef",
      "telegram.botTokenRef",
    ]);
  });
});

describe("brand validation (A4, RK9-510)", () => {
  it("accepts monthlyCapEur null (the default) but marks the brand disabled", () => {
    for (const raw of [brandConfig({ monthlyCapEur: null }), (({ monthlyCapEur: _cap, ...rest }) => rest)(brandConfig())]) {
      const result = parseBrandConfig(raw);
      expect(result.state).toBe("disabled");
      if (result.state !== "disabled") continue;
      expect(result.config.monthlyCapEur).toBeNull();
      expect(result.config.meta.adAccountId).toBe("29231592883113369");
      expect(result.reason).toMatch(/monthlyCapEur is not set/);
    }
  });

  it("rejects each malformed field the spec names, offline", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [brandConfig({ meta: { adAccountId: "act_12a", pageId: "1", accessTokenRef: secretRef(SECRET_A_META) } }), /meta\.adAccountId: must be numeric/],
      [brandConfig({ meta: { adAccountId: "act_12", pageId: "1" } }), /meta\.accessTokenRef: is required/],
      [brandConfig({ monthlyCapEur: -5 }), /monthlyCapEur: must be > 0/],
      [brandConfig({ monthlyCapEur: "100" }), /monthlyCapEur: must be a finite number/],
      [brandConfig({ landing: { allowedDomains: ["ololla.fi"], urls: { home: "http://www.ololla.fi/" } } }), /landing\.urls\.home: must be an https URL/],
      [brandConfig({ landing: { allowedDomains: ["ololla.fi"], urls: { home: "https://ololla.fi.evil.example/" } } }), /is not in landing\.allowedDomains/],
      [brandConfig({ telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-5540940287", allowedUserIds: [] } }), /telegram\.allowedUserIds: must list at least one approver/],
    ];
    for (const [raw, expected] of cases) expect(errorsOf(raw).join("\n")).toMatch(expected);
  });

  it("normalises an act_ prefix and stores secrets only as secret_ref objects", () => {
    const config = enabled(brandConfig({ meta: { adAccountId: "act_29231592883113369", pageId: "1", accessTokenRef: { ...secretRef(SECRET_A_META), extra: "x" } } }));
    expect(config.meta.adAccountId).toBe("29231592883113369");
    expect(config.meta.accessTokenRef).toEqual({ type: "secret_ref", secretId: SECRET_A_META, version: "latest" });
  });

  it("validates the Ololla and Sunspot fixtures", async () => {
    const { loadFixtureConfig } = await import("./brand/fake-routes.js");
    const ololla = enabled(loadFixtureConfig("ololla"));
    expect(ololla).toMatchObject({ brandCode: "OLL", monthlyCapEur: 100, telegram: { chatId: "-5540940287", allowedUserIds: ["440715827"] } });
    const sunspot = enabled(loadFixtureConfig("sunspot"));
    expect(sunspot.meta).toMatchObject({ adAccountId: "1336862981968191", campaignId: "120247250925830775", adSetId: "120247250925850775" });
  });
});

describe("normaliseAdAccountId", () => {
  it("strips act_ and requires digits", () => {
    expect(normaliseAdAccountId("act_123")).toBe("123");
    expect(normaliseAdAccountId("123")).toBe("123");
    expect(normaliseAdAccountId("act_")).toBeNull();
    expect(normaliseAdAccountId(123)).toBeNull();
  });
});

describe("dailyBudgetCents (G3)", () => {
  it("floors the monthly cap over the days of the local month", () => {
    expect(dailyBudgetCents(100, 28)).toBe(357);
    expect(dailyBudgetCents(100, 30)).toBe(333);
    expect(dailyBudgetCents(100, 31)).toBe(322);
    for (const days of [28, 30, 31]) {
      expect(dailyBudgetCents(100, days) * days).toBeLessThanOrEqual(10000);
    }
  });
});
