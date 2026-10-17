// @vitest-environment jsdom
/**
 * Operator UI render tests (A12, RK9-518), following
 * plugin-llm-wiki/tests/wiki-route-sidebar-ui.spec.ts: the host bridge global
 * is mocked, components render into a jsdom root.
 */
import * as React from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiOverview, UiPublication, UiSettings, UiWidget } from "../src/features/ui/dto.js";
import { AdsPage, AdsWidget, SettingsPage } from "../src/ui/index.js";
import { CLEAR_HALT_WORD, PAUSE_WORD } from "../src/ui/AdsPage.js";
import { saveRulesBlock } from "../src/ui/host-config.js";
import { ACTION, DATA } from "../src/ui/keys.js";
import { weakeningChanges } from "../src/ui/rule-fields.js";
import { LIVE_WORD, WEAKEN_WORD } from "../src/ui/SettingsPage.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT = { companyId: COMPANY_ID, companyPrefix: "OLL", projectId: null, entityId: null, entityType: null, userId: "board-user-1" };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

interface Bridge {
  data: Map<string, unknown>;
  actions: Map<string, Handler>;
  actionCalls: Array<{ key: string; params: Record<string, unknown> }>;
  refreshes: string[];
  toasts: Array<{ title: string; tone?: string }>;
  notify(): void;
}

function installBridge(): Bridge {
  const listeners = new Set<() => void>();
  const bridge: Bridge = {
    data: new Map(),
    actions: new Map(),
    actionCalls: [],
    refreshes: [],
    toasts: [],
    notify: () => listeners.forEach((listener) => listener()),
  };
  const cell = (value: unknown) => (value === null || value === undefined ? "" : (value as React.ReactNode));
  (globalThis as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = {
    react: React,
    sdkUi: {
      usePluginData(key: string) {
        const [, setTick] = React.useState(0);
        React.useEffect(() => {
          const listener = () => setTick((tick) => tick + 1);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }, []);
        return {
          data: bridge.data.get(key) ?? null,
          loading: false,
          error: null,
          refresh: () => {
            bridge.refreshes.push(key);
            bridge.notify();
          },
        };
      },
      usePluginAction(key: string) {
        return async (params: Record<string, unknown> = {}) => {
          bridge.actionCalls.push({ key, params });
          const handler = bridge.actions.get(key);
          if (!handler) throw new Error(`no handler for ${key}`);
          return handler(params);
        };
      },
      useHostContext: () => CONTEXT,
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/OLL${to}`,
        navigate: () => undefined,
        linkProps: (to: string) => ({ href: `/OLL${to}`, onClick: () => undefined }),
      }),
      usePluginToast: () => (input: { title: string; tone?: string }) => {
        bridge.toasts.push(input);
        return null;
      },
      Spinner: ({ label }: { label?: string }) => createElement("span", { role: "status" }, label),
      MetricCard: ({ label, value }: { label: string; value: string | number }) => createElement("div", { "data-metric": label }, `${label}: ${value}`),
      StatusBadge: ({ label }: { label: string }) => createElement("span", { "data-badge": label }, label),
      KeyValueList: ({ pairs }: { pairs: Array<{ label: string; value: React.ReactNode }> }) =>
        createElement("dl", null, pairs.flatMap((pair) => [createElement("dt", { key: `${pair.label}:t` }, pair.label), createElement("dd", { key: `${pair.label}:d` }, pair.value)])),
      DataTable: ({ columns, rows, emptyMessage }: { columns: Array<{ key: string; header: string; render?: (value: unknown, row: Record<string, unknown>) => React.ReactNode }>; rows: Array<Record<string, unknown>>; emptyMessage?: string }) =>
        rows.length === 0
          ? createElement("p", null, emptyMessage ?? "No rows.")
          : createElement(
              "table",
              null,
              createElement(
                "tbody",
                null,
                rows.map((row, index) =>
                  createElement(
                    "tr",
                    { key: String(row.id ?? index), "data-row": String(row.id ?? index) },
                    columns.map((column) => createElement("td", { key: column.key }, column.render ? column.render(row[column.key], row) : cell(row[column.key]))),
                  ),
                ),
              ),
            ),
    },
  };
  return bridge;
}

function publication(overrides: Partial<UiPublication> = {}): UiPublication {
  return {
    id: "aaaaaaaa-1111-4111-8111-000000000001",
    adName: "OLL kesä 1",
    status: "published",
    mode: "publish",
    metaAdId: "301",
    adStatus: "ACTIVE",
    adEffectiveStatus: "ACTIVE",
    publishedAt: "2026-10-15T08:00:00.000Z",
    createdAt: "2026-10-15T07:59:00.000Z",
    error: null,
    spendEur: 4,
    impressions: 1800,
    linkClicks: 15,
    ctrPct: 0.83,
    cpcEur: 0.27,
    fatigue: "ok",
    fatigueReasons: [],
    ...overrides,
  };
}

/** The Ololla brand as the worker would serve it. */
function ollolaOverview(overrides: Partial<UiOverview> = {}): UiOverview {
  return {
    state: "enabled",
    brand: { brandCode: "OLL", displayName: "Ololla", timeZone: "Europe/Helsinki", monthlyCapEur: 100 },
    launchReady: true,
    preflightCheckedAt: "2026-10-17T06:00:00.000Z",
    preflightFresh: true,
    spend: {
      month: "2026-10",
      mtdEur: 12.34,
      monthlyCapEur: 100,
      pctUsed: 12.3,
      projectedMonthEndEur: 58.3,
      dailyBudgetSumEur: 3.22,
      remainingDays: 14,
      spendCapEur: 100,
      spendCapStatus: "set",
      allow: true,
      reason: "ok",
      detail: "",
      risks: [],
    },
    halt: null,
    publications: [publication()],
    pendingGates: [{ id: "gate-1", kind: "activate_ad", adId: "302", publicationId: "pub-2", validUntil: "2026-10-18T09:00:00.000Z" }],
    ruleLog: [{ ruleId: "cpc-ceiling", ruleType: "threshold_pause", action: "pause", objectType: "ad", objectId: "301", mode: "shadow", applied: false, decidedAt: "2026-10-17T05:00:00.000Z" }],
    spend14d: [{ date: "2026-10-16", spendEur: 2.5, impressions: 1000, linkClicks: 10, cpcEur: 0.25 }],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let bridge: Bridge;

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
    await flush();
  });
}

function buttons(label: string | RegExp): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((button) =>
    typeof label === "string" ? button.textContent === label : label.test(button.textContent ?? ""),
  );
}

async function click(label: string | RegExp, index = 0) {
  const button = buttons(label)[index];
  if (!button) throw new Error(`no button ${label}: ${container.textContent}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
  });
}

async function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

beforeEach(() => {
  bridge = installBridge();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;
});

describe("operator UI (RK9-518)", () => {
  it("shows an empty state with the settings link when the company has no config", async () => {
    bridge.data.set(DATA.overview, { ...ollolaOverview(), state: "absent", brand: null, spend: null, publications: [], pendingGates: [], ruleLog: [], spend14d: [], error: "RK9 Ads is not configured for this company" });
    bridge.data.set(DATA.widget, { state: "absent", brandCode: null, mtdEur: null, monthlyCapEur: null, pctUsed: null, pendingGates: null, halted: false } satisfies UiWidget);
    bridge.data.set(DATA.settings, { state: "absent", errors: [], brand: null, meta: null, telegram: null, landing: null, schedule: null, digest: null, fatigue: null } satisfies UiSettings);

    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("RK9 Ads ei ole käytössä");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/OLL/company/settings/ads");
    expect(buttons("Pysäytä kaikki")).toHaveLength(0);

    await render(createElement(SettingsPage, { context: CONTEXT }));
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/OLL/company/settings/instance/plugins/rk9-ads");

    await render(createElement(AdsWidget, { context: CONTEXT }));
    expect(container.textContent).toContain("Mainonta ei ole käytössä");
  });

  it("shows an empty publications state for a configured brand with nothing published", async () => {
    bridge.data.set(DATA.overview, ollolaOverview({ publications: [], pendingGates: [], ruleLog: [], spend14d: [] }));
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("Ei vielä julkaisuja.");
    expect(container.textContent).toContain("Ei odottavia kortteja.");
  });

  it("renders the Ololla page: header gauge, publications, gate card, rule log, 14 days", async () => {
    bridge.data.set(DATA.overview, ollolaOverview());
    await render(createElement(AdsPage, { context: CONTEXT }));
    const text = container.textContent ?? "";
    expect(text).toContain("Mainonta: Ololla");
    expect(text).toMatch(/12,34\s€/);
    expect(text).toMatch(/100,00\s€\s*kuukausikatosta/);
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("12");
    expect(text).toContain("Metan spend_cap");
    expect(text).toContain("asetettu");
    expect(text).toContain("Julkaisuvalmis");
    expect(text).toContain("OLL kesä 1");
    expect(container.querySelector('[data-badge="Kunnossa"]')).not.toBeNull();
    expect(buttons("Lähetä uudelleen")).toHaveLength(1);
    expect(text).toContain("cpc-ceiling");
    expect(text).toContain("2026-10-16");
    expect(buttons("Pysäytä kaikki")).toHaveLength(1);
    // No control can activate, resume or unpause an ad (G1).
    expect(buttons(/aktivoi|jatka mainos|resume|unpause|activate/i)).toEqual([]);
  });

  it("pauses an ad after a typed confirmation and shows PAUSED without a reload", async () => {
    bridge.data.set(DATA.overview, ollolaOverview());
    bridge.actions.set(ACTION.pauseAd, async (params) => {
      if (params.dryRun !== false) return { dryRun: true, adId: "301", name: "OLL kesä 1", previousStatus: "ACTIVE", status: "ACTIVE", paused: false };
      bridge.data.set(DATA.overview, ollolaOverview({ publications: [publication({ adStatus: "PAUSED", adEffectiveStatus: "PAUSED" })] }));
      return { dryRun: false, adId: "301", name: "OLL kesä 1", previousStatus: "ACTIVE", status: "PAUSED", paused: true };
    });
    await render(createElement(AdsPage, { context: CONTEXT }));

    await click("Pysäytä");
    await click("Tarkista ja jatka");
    expect(bridge.actionCalls).toEqual([{ key: ACTION.pauseAd, params: { adId: "301", dryRun: true } }]);
    expect(buttons("Pysäytä mainos")[0]!.disabled).toBe(true);
    await type(`Kirjoita ${PAUSE_WORD}`, "pysäytä");
    expect(buttons("Pysäytä mainos")[0]!.disabled).toBe(true);
    await type(`Kirjoita ${PAUSE_WORD}`, PAUSE_WORD);
    await click("Pysäytä mainos");

    expect(bridge.actionCalls[1]).toEqual({ key: ACTION.pauseAd, params: { adId: "301", dryRun: false, confirm: true } });
    expect(bridge.refreshes).toContain(DATA.overview);
    expect(container.querySelector('[data-badge="PAUSED"]')).not.toBeNull();
    expect(buttons("Pysäytä")).toEqual([]);
    expect(bridge.toasts.map((toast) => toast.title)).toContain("Mainos OLL kesä 1 pysäytetty");
  });

  it("the kill switch previews, needs the typed word, and shows halt and card failures as errors", async () => {
    bridge.data.set(DATA.overview, ollolaOverview());
    const base = { rule: "kill_switch", scope: "account", campaignPaused: true, list: [], errors: [], telegram: "sent", closedCardIds: [] };
    bridge.actions.set(ACTION.pauseAll, async (params) =>
      params.dryRun !== false
        ? { ...base, dryRun: true, pausedAds: [{ id: "301", name: "a" }], pausedCampaigns: [{ id: "100", name: "c" }], count: 2 }
        : { ...base, dryRun: false, pausedAds: [{ id: "301", name: "a" }], pausedCampaigns: [{ id: "100", name: "c" }], count: 2, haltError: "state write failed", cardsError: "gate store down" },
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    await click("Pysäytä kaikki");
    expect(container.textContent).toContain("pysäyttää 1 mainosta ja 1 kampanjaa");
    expect(buttons("Pysäytä kaikki")[0]!.disabled).toBe(true);
    await type(`Kirjoita ${PAUSE_WORD}`, PAUSE_WORD);
    await click("Pysäytä kaikki");
    expect(bridge.actionCalls.map((call) => call.params)).toEqual([{ dryRun: true }, { dryRun: false, confirm: true }]);
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent);
    expect(alerts).toEqual(expect.arrayContaining([expect.stringContaining("Pysäytystilaa EI tallennettu: state write failed"), expect.stringContaining("aktivointikortteja EI suljettu: gate store down")]));
  });

  it("keeps the kill switch on a broken config, runs it on the fallback config, and the widget warns", async () => {
    bridge.data.set(DATA.overview, { ...ollolaOverview(), state: "invalid", error: "rules.list[0]: bad threshold" });
    const base = { rule: "kill_switch", scope: "account", campaignPaused: true, list: [], telegram: "sent", closedCardIds: [], fallbackConfig: "invalid" };
    bridge.actions.set(ACTION.pauseAll, async (params) =>
      params.dryRun !== false
        ? { ...base, dryRun: true, pausedAds: [{ id: "301", name: "a" }], pausedCampaigns: [], count: 1, errors: [{ id: "list:ads", error: "Meta 500" }] }
        : { ...base, dryRun: false, pausedAds: [{ id: "301", name: "a" }], pausedCampaigns: [], count: 1, errors: [] },
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("Brändin asetukset ovat virheelliset.");
    await click("Pysäytä kaikki");
    const previewAlerts = Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent);
    expect(previewAlerts).toEqual(expect.arrayContaining([expect.stringContaining("viimeisintä toimivaa"), expect.stringContaining("list:ads (Meta 500)")]));
    await type(`Kirjoita ${PAUSE_WORD}`, PAUSE_WORD);
    await click("Pysäytä kaikki");
    expect(bridge.actionCalls.map((call) => call.params)).toEqual([{ dryRun: true }, { dryRun: false, confirm: true }]);

    bridge.data.set(DATA.widget, { state: "invalid", error: "rules.list[0]: bad threshold", brandCode: null, mtdEur: null, monthlyCapEur: null, pctUsed: null, pendingGates: null, halted: true } satisfies UiWidget);
    await render(createElement(AdsWidget, { context: CONTEXT }));
    expect(container.textContent).toContain("mainokset voivat olla yhä käynnissä");
    expect(container.textContent).toContain("Pysäytystila päällä");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/OLL/ads");
  });

  it("shows the standing halt and clears it with the preview's since", async () => {
    const halt = { rule: "kill_switch", since: "2026-10-17T08:00:00.000Z", until: null, reason: "Pysäytä kaikki (UI)", source: "ui", userId: "board-user-1", agentId: null, tgUserId: null };
    bridge.data.set(DATA.overview, ollolaOverview({ halt }));
    bridge.actions.set(ACTION.clearHalt, async (params) => {
      if (params.dryRun !== false) return { dryRun: true, cleared: false, halt: { brandCode: "OLL", rule: "kill_switch", since: halt.since, reason: halt.reason, initiator: { source: "ui" } } };
      bridge.data.set(DATA.overview, ollolaOverview());
      return { dryRun: false, cleared: true };
    });
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("Pysäytystila päällä");
    expect(container.textContent).toContain("board-user-1 (ui)");
    expect(container.textContent).toContain("Pysäytä kaikki (UI)");
    await click("Poista pysäytystila");
    await type(`Kirjoita ${CLEAR_HALT_WORD}`, CLEAR_HALT_WORD);
    await click("Poista pysäytystila");
    expect(bridge.actionCalls.map((call) => call.params)).toEqual([{ dryRun: true }, { dryRun: false, confirm: true, since: halt.since }]);
    expect(container.textContent).not.toContain("Pysäytystila päällä");
  });

  it("the widget shows MTD against the cap and the pending gate count", async () => {
    bridge.data.set(DATA.widget, { state: "enabled", brandCode: "OLL", mtdEur: 12.34, monthlyCapEur: 100, pctUsed: 12.3, pendingGates: 2, halted: false } satisfies UiWidget);
    await render(createElement(AdsWidget, { context: CONTEXT }));
    expect(container.querySelector('[data-metric="Kulutus OLL"]')?.textContent).toMatch(/12,34\s€ \/ 100,00\s€ \(12,3 %\)/);
    expect(container.querySelector('[data-metric="Odottavat kortit"]')?.textContent).toBe("Odottavat kortit: 2");
  });

  it("the settings page lists preflight checks and re-runs them in place", async () => {
    bridge.data.set(DATA.settings, {
      state: "enabled",
      errors: [],
      brand: { brandCode: "OLL", displayName: "Ololla", timeZone: "Europe/Helsinki", monthlyCapEur: 100 },
      meta: { adAccountId: "29231592883113369", pageId: "1284777064729996", igUserId: null, datasetId: null, campaignId: null, adSetId: null, accessTokenConfigured: true, specialAdCategories: ["NONE"] },
      telegram: { configured: true, mode: "poll", chatId: "-1001", approverCount: 1, gateTtlHours: 24 },
      landing: { allowedDomains: ["ololla.fi"], urlKeys: ["home"], defaultUrlKey: "home" },
      schedule: { scheduledPauseEnabled: false, scheduledPauseAt: "21:30", dataGate: false },
      digest: { enabled: true, time: "07:30", cpcWarnEur: 0.5 },
      fatigue: { enabled: true, issuesEnabled: false },
    } satisfies UiSettings);
    const check = (name: string, status: string) => ({ check: name, status, required: true, reason: status === "pass" ? "ok" : "spend_cap_missing", detail: `${name} ${status}` });
    bridge.data.set(DATA.preflight, { state: "enabled", fresh: true, result: { launchReady: false, checkedAt: "2026-10-17T06:00:00.000Z", checks: [check("token_scopes", "pass"), check("spend_cap", "fail")] } });
    bridge.data.set(DATA.rules, { state: "enabled", liveMode: false, rules: [{ ruleId: "pause_all_cap", type: "pause_all_cap", enabled: true, mode: "shadow", cooldownHours: 24 }] });
    bridge.actions.set(ACTION.verifyConnection, async () => {
      bridge.data.set(DATA.preflight, { state: "enabled", fresh: true, result: { launchReady: true, checkedAt: "2026-10-17T07:00:00.000Z", checks: [check("token_scopes", "pass"), check("spend_cap", "pass")] } });
      return {};
    });
    await render(createElement(SettingsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("spend_cap fail");
    expect(container.textContent).toContain("asetettu (secret)");
    await click("Aja preflight uudelleen");
    expect(bridge.refreshes).toContain(DATA.preflight);
    expect(container.textContent).toContain("spend_cap pass");
    expect(container.textContent).toContain("Julkaisuvalmis.");
  });
  it("shows a pause-ad card close failure as an error after the panel closes (RK9-562)", async () => {
    bridge.data.set(DATA.overview, ollolaOverview());
    bridge.actions.set(ACTION.pauseAd, async (params) =>
      params.dryRun !== false
        ? { dryRun: true, adId: "301", name: "OLL kesä 1", previousStatus: "ACTIVE", status: "ACTIVE", paused: false }
        : { dryRun: false, adId: "301", name: "OLL kesä 1", previousStatus: "ACTIVE", status: "PAUSED", paused: true, closedCardIds: [], cardsError: "gate store down" },
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    await click("Pysäytä");
    await click("Tarkista ja jatka");
    await type(`Kirjoita ${PAUSE_WORD}`, PAUSE_WORD);
    await click("Pysäytä mainos");
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent);
    expect(alerts).toEqual([expect.stringContaining("aktivointikortteja EI saatu varmasti suljettua: gate store down")]);
  });

  describe("rule editor confirmation for weakening saves (RK9-562)", () => {
    const CAP = { ruleId: "pause_all_cap", type: "pause_all_cap", enabled: true, mode: "live", cooldownHours: 24 };
    const CPC = { ruleId: "cpc-ceiling", type: "threshold_pause", enabled: true, mode: "live", metric: "cpc", operator: "gt", threshold: 0.8, days: 7, aggregate: "window_total", minImpressions: 0, minClicks: 0, minSpendEur: 3, cooldownHours: 24 };
    const realFetch = globalThis.fetch;
    let posts: Array<Record<string, unknown>>;

    beforeEach(() => {
      posts = [];
      bridge.data.set(DATA.settings, { state: "disabled", errors: [], brand: null, meta: null, telegram: null, landing: null, schedule: null, digest: null, fatigue: null } satisfies UiSettings);
      bridge.data.set(DATA.preflight, { state: "disabled", fresh: false, result: null });
      bridge.data.set(DATA.rules, { state: "enabled", liveMode: true, rules: [CPC, CAP] });
      bridge.actions.set(ACTION.rulesPrepareSave, async (params) => ({ ok: true, rules: { liveMode: params.liveMode, list: params.list } }));
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ configJson: { brandCode: "OLL", rules: { liveMode: true, list: [CPC, { type: "pause_all_cap", mode: "live" }] } } }), { status: 200 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    function changes(): string[] {
      return Array.from(container.querySelectorAll('ul[aria-label="Vahvistettavat muutokset"] li')).map((node) => node.textContent ?? "");
    }

    it("a removed rule needs the typed word: no POST without it, the change is listed, the word saves", async () => {
      await render(createElement(SettingsPage, { context: CONTEXT }));
      await click("Poista");
      await click("Tallenna säännöt");
      expect(changes()).toEqual(["Kynnyspysäytys cpc-ceiling: poistetaan."]);
      expect(posts).toEqual([]);
      expect(buttons("Tallenna heikennetyt säännöt")[0]!.disabled).toBe(true);
      await type(`Kirjoita ${WEAKEN_WORD}`, LIVE_WORD);
      expect(buttons("Tallenna heikennetyt säännöt")[0]!.disabled).toBe(true);
      expect(posts).toEqual([]);
      await type(`Kirjoita ${WEAKEN_WORD}`, WEAKEN_WORD);
      await click("Tallenna heikennetyt säännöt");
      expect(posts).toHaveLength(1);
      expect((posts[0]!.configJson as { rules: { list: unknown[] } }).rules.list).toHaveLength(1);
      expect(bridge.toasts.map((toast) => toast.title)).toContain("Säännöt tallennettu");
    });

    it("live mode off and a disabled rule are listed; cancel sends nothing", async () => {
      await render(createElement(SettingsPage, { context: CONTEXT }));
      const [liveToggle, enabledToggle] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
      await act(async () => {
        liveToggle!.click();
        enabledToggle!.click();
        await flush();
      });
      await click("Tallenna säännöt");
      expect(changes()).toEqual(["Live-tila pois: yksikään sääntö ei enää pysäytä mainoksia Metassa.", "Kynnyspysäytys cpc-ceiling: kytketään pois päältä."]);
      await click("Peruuta");
      expect(posts).toEqual([]);
      expect(buttons("Tallenna säännöt")).toHaveLength(1);
    });

    it("shadow -> live still needs LIVE; no POST without it", async () => {
      bridge.data.set(DATA.rules, { state: "enabled", liveMode: false, rules: [CPC, CAP] });
      await render(createElement(SettingsPage, { context: CONTEXT }));
      const [liveToggle] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
      await act(async () => {
        liveToggle!.click();
        await flush();
      });
      await click("Tallenna säännöt");
      expect(posts).toEqual([]);
      expect(buttons("Tallenna live-tilassa")[0]!.disabled).toBe(true);
      await type(`Kirjoita ${LIVE_WORD}`, LIVE_WORD);
      await click("Tallenna live-tilassa");
      expect(posts).toHaveLength(1);
      expect((posts[0]!.configJson as { rules: { liveMode: boolean } }).rules.liveMode).toBe(true);
    });

    it("a change that does not weaken the protection saves without a word", async () => {
      await render(createElement(SettingsPage, { context: CONTEXT }));
      await type("Kynnys", "0.6");
      await click("Tallenna säännöt");
      expect(changes()).toEqual([]);
      expect(posts).toHaveLength(1);
    });

    it("the save refuses a weakening against the config saved now that the operator did not confirm", async () => {
      const extra = { ...CPC, ruleId: "cpm-ceiling", metric: "cpm" };
      const fetcher = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push({});
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ configJson: { brandCode: "OLL", rules: { liveMode: true, list: [CPC, extra] } } }), { status: 200 });
      }) as typeof fetch;
      await expect(saveRulesBlock(COMPANY_ID, { liveMode: true, list: [CPC] }, fetcher, [])).rejects.toThrow(/Kynnyspysäytys cpm-ceiling: poistetaan/);
      expect(posts).toEqual([]);
      await expect(saveRulesBlock(COMPANY_ID, { liveMode: true, list: [CPC] }, fetcher, ["Kynnyspysäytys cpm-ceiling: poistetaan."])).resolves.toBeUndefined();
      expect(posts).toHaveLength(1);
    });

    it("weakeningChanges: the cap to shadow, a live rule to shadow, a renamed rule; additions and disabled rules are not weakening", () => {
      const saved = { liveMode: true, list: [CPC, CAP, { ...CPC, ruleId: "off-rule", enabled: false }, { ruleId: "scale", type: "propose_scale", enabled: false }] };
      expect(
        weakeningChanges(saved, {
          liveMode: true,
          list: [{ ...CPC, ruleId: "cpc-renamed" }, { ...CAP, mode: "shadow" }],
        }),
      ).toEqual(["Kynnyspysäytys cpc-ceiling: poistetaan.", "Kuukausikatto 90 % (sisäänrakennettu): live-tilasta varjotilaan."]);
      expect(weakeningChanges(saved, { liveMode: true, list: [{ ...CPC, mode: "shadow" }, CAP, { ...CPC, ruleId: "new-rule" }] })).toEqual([
        "Kynnyspysäytys cpc-ceiling: live-tilasta varjotilaan.",
      ]);
      expect(weakeningChanges({ liveMode: false, list: [CAP] }, { liveMode: true, list: [CAP, CPC] })).toEqual([]);
    });
  });
});
