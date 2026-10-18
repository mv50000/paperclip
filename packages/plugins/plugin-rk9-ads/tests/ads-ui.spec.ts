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
import { ACK_UNDO_WORD, ackPrompt, CLEAR_HALT_WORD, PAUSE_WORD } from "../src/ui/AdsPage.js";
import { readConfigVersion, saveRulesBlock } from "../src/ui/host-config.js";
import { ACTION, DATA } from "../src/ui/keys.js";
import { EDITOR_DEFAULT_RULES, fromEditor, liveChanges, savedRulesBlock, toEditor, weakeningChanges } from "../src/ui/rule-fields.js";
import { prepareRules } from "../src/features/rules/editor.js";
import { DEFAULT_RULES, parseRules } from "../src/features/rules/schema.js";
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
      headroomEur: 80,
      remainingEur: 87.66,
      spendCapStatus: "set",
      allow: true,
      reason: "ok",
      detail: "",
      risks: [],
    },
    halt: null,
    pendingUndo: [],
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

    expect(bridge.actionCalls[1]).toEqual({ key: ACTION.pauseAd, params: { adId: "301", dryRun: false, confirm: true, idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/) } });
    expect(bridge.refreshes).toContain(DATA.overview);
    expect(container.querySelector('[data-badge="PAUSED"]')).not.toBeNull();
    expect(buttons("Pysäytä")).toEqual([]);
    expect(bridge.toasts.map((toast) => toast.title)).toContain("Mainos OLL kesä 1 pysäytetty");
  });

  it("shows the standing spend risks as warnings, with Meta's headroom against what is left of the month (RK9-563)", async () => {
    bridge.data.set(DATA.overview, ollolaOverview());
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.querySelector('ul[aria-label="Kulutusriskit"]')).toBeNull();
    const spend = ollolaOverview().spend!;
    bridge.data.set(
      DATA.overview,
      ollolaOverview({
        spend: { ...spend, headroomEur: 100, spendCapStatus: "headroom_above_remaining", projectedMonthEndEur: 140, risks: ["spend_cap_headroom_exceeds_remaining", "projection_exceeds_cap"] },
      }),
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    const risks = Array.from(container.querySelectorAll('ul[aria-label="Kulutusriskit"] li')).map((node) => node.textContent ?? "");
    expect(risks).toHaveLength(2);
    expect(risks[0]).toMatch(/^Metan spend_cap sallii vielä 100,00\s€, mutta kuukausikatosta on jäljellä 87,66\s€: Meta ei pysäytä ajoissa\.$/);
    expect(risks[1]).toMatch(/^Nykyisillä budjeteilla kuun loppuun arvio 140,00\s€ ylittää kuukausikaton 100,00\s€\.$/);
    expect(container.textContent).toMatch(/sallii enemmän kuin kuukausikatosta on jäljellä \(vielä 100,00\s€\)/);
  });

  it("a repeated pause names the ad's status now instead of a second pause (RK9-563)", async () => {
    bridge.data.set(DATA.overview, ollolaOverview());
    bridge.actions.set(ACTION.pauseAd, async (params) =>
      params.dryRun !== false
        ? { dryRun: true, adId: "301", name: "OLL kesä 1", previousStatus: "ACTIVE", status: "ACTIVE", paused: false }
        : { dryRun: false, adId: "301", name: "OLL kesä 1", previousStatus: "PAUSED", status: "PAUSED", paused: true, duplicate: true },
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    await click("Pysäytä");
    await click("Tarkista ja jatka");
    await type(`Kirjoita ${PAUSE_WORD}`, PAUSE_WORD);
    await click("Pysäytä mainos");
    expect(bridge.toasts.map((toast) => toast.title)).toEqual(["Pysäytys oli jo lähetetty: mainoksen OLL kesä 1 tila nyt PAUSED"]);
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

  it("says so when the halt ended before the clear (RK9-565)", async () => {
    const halt = { rule: "kill_switch", since: "2026-10-17T08:00:00.000Z", until: null, reason: "Pysäytä kaikki (UI)", source: "ui", userId: "board-user-1", agentId: null, tgUserId: null };
    bridge.data.set(DATA.overview, ollolaOverview({ halt }));
    bridge.actions.set(ACTION.clearHalt, async (params) => {
      if (params.dryRun !== false) return { dryRun: true, cleared: false, halt: { brandCode: "OLL", rule: "kill_switch", since: halt.since, reason: halt.reason, initiator: { source: "ui" } } };
      bridge.data.set(DATA.overview, ollolaOverview());
      return { dryRun: false, cleared: false, halt: null };
    });
    await render(createElement(AdsPage, { context: CONTEXT }));
    await click("Poista pysäytystila");
    await type(`Kirjoita ${CLEAR_HALT_WORD}`, CLEAR_HALT_WORD);
    await click("Poista pysäytystila");
    expect(bridge.toasts.map((toast) => toast.title)).toEqual(["Pysäytystila oli jo päättynyt, mitään ei poistettu"]);
  });

  it("shows the open activation undos without a halt and acknowledges only the previewed ones (RK9-565)", async () => {
    const pendingUndo = [{ kind: "campaign", objectId: "120200000000000101", gateRequestId: "gate-9", since: "2026-10-17T08:00:05.000Z" }];
    bridge.data.set(DATA.overview, ollolaOverview({ pendingUndo }));
    bridge.actions.set(ACTION.clearHalt, async (params) => {
      if (params.dryRun !== false) return { dryRun: true, cleared: false, halt: null, pendingUndo: [{ ...pendingUndo[0], key: "120200000000000101|gate-9|2026-10-17T08:00:05.000Z" }] };
      bridge.data.set(DATA.overview, ollolaOverview());
      return { dryRun: false, cleared: false, halt: null, acknowledgedUndos: 1 };
    });
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).not.toContain("Pysäytystila päällä");
    expect(container.textContent).toContain("Aktivoinnin peruutus epäonnistui, voi olla yhä ACTIVE: kampanja 120200000000000101");
    await click("Kuittaa uudelleenyritykset");
    expect(container.textContent).toContain("Kuittaus lopettaa 1 aktivoinnin peruutuksen uudelleenyrityksen");
    expect(buttons("Kuittaa uudelleenyritykset")[0]!.disabled).toBe(true);
    await type(`Kirjoita ${ACK_UNDO_WORD}`, ACK_UNDO_WORD);
    await click("Kuittaa uudelleenyritykset");
    expect(bridge.actionCalls.map((call) => call.params)).toEqual([
      { dryRun: true },
      { dryRun: false, confirm: true, acknowledgeUndos: ["120200000000000101|gate-9|2026-10-17T08:00:05.000Z"] },
    ]);
    expect(bridge.toasts.map((toast) => toast.title)).toEqual(["Kuitattu 1 uudelleenyritystä"]);
    expect(container.textContent).not.toContain("Aktivoinnin peruutus epäonnistui");
  });

  it("names what the acknowledgement stops by origin (RK9-570)", () => {
    expect(ackPrompt([{ origin: "pause" }, { origin: "pause" }])).toMatch(/^Kuittaus lopettaa 2 pysäytyksen uudelleenyrityksen\./);
    expect(ackPrompt([{}, { origin: "activation" }])).toMatch(/^Kuittaus lopettaa 2 aktivoinnin peruutuksen uudelleenyrityksen\./);
    expect(ackPrompt([{ origin: "pause" }, {}])).toMatch(/^Kuittaus lopettaa 1 aktivoinnin peruutuksen ja 1 pysäytyksen uudelleenyrityksen\./);
    expect(ackPrompt([{ origin: "pause" }])).not.toContain("peruutu");
  });

  it("an acknowledgement that took fewer entries than the preview listed is an error, not a success (RK9-570)", async () => {
    const pendingUndo = [{ kind: "ad" as const, objectId: "120200000000000301", gateRequestId: "kill_switch:halt-1", since: "2026-10-17T08:00:05.000Z", origin: "pause" as const, attempts: 2 }];
    bridge.data.set(DATA.overview, ollolaOverview({ pendingUndo }));
    bridge.actions.set(ACTION.clearHalt, async (params) => {
      if (params.dryRun !== false) return { dryRun: true, cleared: false, halt: null, pendingUndo: [{ ...pendingUndo[0], key: "120200000000000301|kill_switch:halt-1|2026-10-17T08:00:05.000Z" }] };
      // A pause failed on the ad after the preview: its key changed, nothing was taken.
      return { dryRun: false, cleared: false, halt: null, acknowledgedUndos: 0 };
    });
    await render(createElement(AdsPage, { context: CONTEXT }));
    await click("Kuittaa uudelleenyritykset");
    expect(container.textContent).toContain("Kuittaus lopettaa 1 pysäytyksen uudelleenyrityksen");
    await type(`Kirjoita ${ACK_UNDO_WORD}`, ACK_UNDO_WORD);
    await click("Kuittaa uudelleenyritykset");
    expect(bridge.toasts).toEqual([]);
    expect(container.textContent).toContain("Kuitattiin 0/1: 1 merkintää muuttui esikatselun jälkeen");
    expect(container.textContent).toContain("Pysäytys epäonnistui pysäytystilan aikana");
  });

  it("names a pause's failed PAUSED write apart from an activation undo, with its attempts (RK9-568)", async () => {
    bridge.data.set(
      DATA.overview,
      ollolaOverview({
        pendingUndo: [
          { kind: "ad", objectId: "120200000000000301", gateRequestId: "kill_switch:halt-1", since: "2026-10-17T08:00:05.000Z", origin: "pause", attempts: 4 },
        ],
      }),
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("Pysäytys epäonnistui pysäytystilan aikana, voi olla yhä ACTIVE: mainos 120200000000000301 (4 epäonnistunutta yritystä)");
    expect(container.textContent).not.toContain("Aktivoinnin peruutus epäonnistui");
    expect(buttons("Kuittaa uudelleenyritykset")).toHaveLength(1);
  });

  it("names a retry that Meta refuses for good, so the board knows only a fix and an acknowledgement end it (RK9-567)", async () => {
    bridge.data.set(
      DATA.overview,
      ollolaOverview({
        pendingUndo: [
          { kind: "ad", objectId: "120200000000000301", gateRequestId: "gate-9", since: "2026-10-17T08:00:05.000Z", attempts: 3, permanentError: "object_missing" },
          { kind: "campaign", objectId: "120200000000000101", gateRequestId: "gate-9", since: "2026-10-17T08:00:05.000Z", attempts: 2 },
        ],
      }),
    );
    await render(createElement(AdsPage, { context: CONTEXT }));
    expect(container.textContent).toContain("Meta hylkää pysäytyksen pysyvästi (token, oikeudet tai poistettu kohde): mainos 120200000000000301.");
    expect(container.textContent).not.toMatch(/pysyvästi[^.]*kampanja 120200000000000101/);
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
    expect(alerts).toEqual([expect.stringContaining("Mainos 301 pysäytettiin, mutta aktivointikorttien sulkemisessa oli ongelma (gate store down)")]);
  });

  it("a clean pause of another ad keeps the first ad's warning; the ad's halt shows and a board user lifts it (RK9-566)", async () => {
    bridge.data.set(DATA.overview, ollolaOverview({ publications: [publication(), publication({ id: "aaaaaaaa-1111-4111-8111-000000000002", adName: "OLL kesä 2", metaAdId: "302" })] }));
    const halt = { id: "halt-302", until: "2026-10-17T10:30:00.000Z" };
    const clears: Array<Record<string, unknown>> = [];
    bridge.actions.set(ACTION.pauseAd, async (params) => {
      const adId = String(params.adId);
      if (params.dryRun !== false) return { dryRun: true, adId, name: null, previousStatus: "ACTIVE", status: "ACTIVE", paused: false };
      return adId === "301"
        ? { dryRun: false, adId, name: null, previousStatus: "ACTIVE", status: "PAUSED", paused: true, closedCardIds: [], haltError: "state down", activationRunning: true }
        : { dryRun: false, adId, name: null, previousStatus: "ACTIVE", status: "PAUSED", paused: true, closedCardIds: [], adHalt: halt };
    });
    bridge.actions.set(ACTION.clearHalt, async (params) => {
      clears.push(params);
      return { dryRun: false, cleared: true };
    });
    await render(createElement(AdsPage, { context: CONTEXT }));
    for (const index of [0, 1]) {
      await click("Pysäytä", index);
      await click("Tarkista ja jatka");
      await type(`Kirjoita ${PAUSE_WORD}`, PAUSE_WORD);
      await click("Pysäytä mainos");
    }
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent);
    expect(alerts).toEqual([expect.stringMatching(/Mainos 301 pysäytettiin, mutta pysäytystilaa EI tallennettu \(state down\).*juuri hyväksytty aktivointi voi olla vielä käynnissä ja käynnistää mainoksen uudelleen/)]);
    expect(container.textContent).toContain("Mainoksen 302 aktivointi on estetty");
    await click("Poista mainoksen pysäytystila");
    await type(`Kirjoita ${CLEAR_HALT_WORD}`, CLEAR_HALT_WORD);
    await click("Poista pysäytystila");
    expect(clears).toEqual([{ dryRun: false, confirm: true, adId: "302", id: "halt-302" }]);
    expect(container.textContent).not.toContain("Mainoksen 302 aktivointi on estetty");
    // The first ad's warning stays.
    expect(Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent)).toEqual(alerts);
  });

  describe("rule editor confirmation for weakening saves (RK9-562)", () => {
    const CAP = { ruleId: "pause_all_cap", type: "pause_all_cap", enabled: true, mode: "live", cooldownHours: 24 };
    const CPC = { ruleId: "cpc-ceiling", type: "threshold_pause", enabled: true, mode: "live", metric: "cpc", operator: "gt", threshold: 0.8, days: 7, aggregate: "window_total", minImpressions: 0, minClicks: 0, minSpendEur: 3, cooldownHours: 24 };
    const realFetch = globalThis.fetch;
    let posts: Array<Record<string, unknown>>;
    let prepares: Array<Record<string, unknown>>;
    /** The config saved now: the worker's prepareSave and the browser's GET read it. */
    let savedConfig: { brandCode: string; rules: { liveMode: boolean; list: Array<Record<string, unknown>> } };

    beforeEach(() => {
      posts = [];
      prepares = [];
      savedConfig = { brandCode: "OLL", rules: { liveMode: true, list: [CPC, { type: "pause_all_cap", mode: "live" }] } };
      bridge.data.set(DATA.settings, { state: "disabled", errors: [], brand: null, meta: null, telegram: null, landing: null, schedule: null, digest: null, fatigue: null } satisfies UiSettings);
      bridge.data.set(DATA.preflight, { state: "disabled", fresh: false, result: null });
      bridge.data.set(DATA.rules, { state: "enabled", liveMode: true, rules: [CPC, CAP] });
      // The worker's own check (features/rules/editor.ts) against the config saved now.
      bridge.actions.set(ACTION.rulesPrepareSave, async (params) => {
        prepares.push(params);
        const { effective: _effective, ...out } = prepareRules(savedConfig, params) as Record<string, unknown>;
        return out;
      });
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ configJson: savedConfig }), { status: 200 });
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
      savedConfig.rules.liveMode = false;
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

    it("a live rule's threshold raised needs the word; the worker refuses it unconfirmed and accepts it confirmed (RK9-566)", async () => {
      await render(createElement(SettingsPage, { context: CONTEXT }));
      await type("Kynnys", "9999");
      await click("Tallenna säännöt");
      expect(changes()).toEqual(["Kynnyspysäytys cpc-ceiling: kynnys 0.8 → 9999."]);
      expect(prepares).toHaveLength(1);
      expect(posts).toEqual([]);
      await type(`Kirjoita ${WEAKEN_WORD}`, WEAKEN_WORD);
      await click("Tallenna heikennetyt säännöt");
      expect(prepares.at(-1)).toMatchObject({ confirmedWeakening: ["Kynnyspysäytys cpc-ceiling: kynnys 0.8 → 9999."], confirmLive: false });
      expect(posts).toHaveLength(1);
    });

    it("a weakening save that also turns live mode on asks HEIKENNÄ and then LIVE (RK9-566)", async () => {
      bridge.data.set(DATA.rules, { state: "enabled", liveMode: false, rules: [CPC, CAP] });
      savedConfig.rules.liveMode = false;
      await render(createElement(SettingsPage, { context: CONTEXT }));
      const [liveToggle] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
      await act(async () => {
        liveToggle!.click();
        await flush();
      });
      await click("Poista");
      await click("Tallenna säännöt");
      expect(changes()).toEqual(["Kynnyspysäytys cpc-ceiling: poistetaan.", "Live-tila päälle: säännöt pysäyttävät mainoksia Metassa ilman erillistä hyväksyntää."]);
      await type(`Kirjoita ${WEAKEN_WORD}`, WEAKEN_WORD);
      await click("Jatka");
      expect(posts).toEqual([]);
      expect(buttons("Tallenna heikennetyt säännöt")[0]!.disabled).toBe(true);
      await type(`Kirjoita ${LIVE_WORD}`, LIVE_WORD);
      await click("Tallenna heikennetyt säännöt");
      expect(posts).toHaveLength(1);
      expect((posts[0]!.configJson as { rules: { liveMode: boolean } }).rules.liveMode).toBe(true);
    });

    it("live mode turned off elsewhere after the page loaded: a save with live on asks LIVE again", async () => {
      // The page loaded with live mode on; another session turned it off since.
      savedConfig.rules.liveMode = false;
      await render(createElement(SettingsPage, { context: CONTEXT }));
      await type("Kynnys", "0.6");
      await click("Tallenna säännöt");
      expect(posts).toEqual([]);
      expect(buttons("Tallenna live-tilassa")).toHaveLength(1);
      await type(`Kirjoita ${LIVE_WORD}`, LIVE_WORD);
      await click("Tallenna live-tilassa");
      expect(posts).toHaveLength(1);
    });

    it("a rule switched to live while live mode is on needs LIVE; no POST without it (RK9-563)", async () => {
      const shadow = { ...CPC, mode: "shadow" };
      savedConfig.rules.list = [shadow, CAP];
      bridge.data.set(DATA.rules, { state: "enabled", liveMode: true, rules: [shadow, CAP] });
      await render(createElement(SettingsPage, { context: CONTEXT }));
      const mode = container.querySelectorAll<HTMLSelectElement>('select[aria-label="Tila"]')[0]!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(mode, "live");
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
      });
      await click("Tallenna säännöt");
      expect(changes()).toEqual(["Kynnyspysäytys cpc-ceiling: varjotilasta live-tilaan."]);
      expect(posts).toEqual([]);
      await type(`Kirjoita ${LIVE_WORD}`, LIVE_WORD);
      await click("Tallenna live-tilassa");
      expect(prepares.at(-1)).toMatchObject({ confirmLive: true });
      expect(posts).toHaveLength(1);
    });

    it("liveChanges: a rule becoming live counts only while live mode is on", () => {
      const shadow = { ...CPC, mode: "shadow" };
      const on = (list: Array<Record<string, unknown>>) => ({ liveMode: true, list });
      expect(liveChanges(on([shadow, CAP]), on([CPC, CAP]))).toEqual(["Kynnyspysäytys cpc-ceiling: varjotilasta live-tilaan."]);
      expect(liveChanges(on([{ ...CPC, enabled: false }, CAP]), on([CPC, CAP]))).toEqual(["Kynnyspysäytys cpc-ceiling: kytketään päälle live-tilassa."]);
      expect(liveChanges(on([CAP]), on([CAP, { ...CPC, ruleId: "new-rule" }]))).toEqual(["Kynnyspysäytys new-rule: uusi sääntö live-tilassa."]);
      expect(liveChanges(on([CPC, CAP]), on([CPC, CAP]))).toEqual([]);
      expect(liveChanges({ liveMode: false, list: [shadow] }, { liveMode: false, list: [CPC] })).toEqual([]);
      expect(liveChanges({ liveMode: false, list: [CPC] }, on([CPC]))).toHaveLength(1);
      // The built-in cap the schema appends in shadow: naming it live is a change.
      expect(liveChanges(on([CPC]), on([CPC, CAP]))).toEqual(["Kuukausikatto 90 % (sisäänrakennettu): varjotilasta live-tilaan."]);
    });

    it("a config saved elsewhere after the page loaded refuses the save, with no POST (RK9-563)", async () => {
      let updatedAt = "2026-10-18T08:00:00.000Z";
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          updatedAt = "2026-10-18T09:30:00.000Z";
          return new Response(JSON.stringify({ configJson: savedConfig, updatedAt }), { status: 200 });
        }
        return new Response(JSON.stringify({ configJson: savedConfig, updatedAt }), { status: 200 });
      }) as typeof fetch;
      await render(createElement(SettingsPage, { context: CONTEXT }));
      // The host's form saved the config after the editor loaded.
      updatedAt = "2026-10-18T09:00:00.000Z";
      await type("Kynnys", "0.6");
      await click("Tallenna säännöt");
      expect(posts).toEqual([]);
      expect(container.textContent).toContain("saved elsewhere after this page loaded");
    });

    it("saveRulesBlock compares updatedAt with the loaded one and returns the new one", async () => {
      let updatedAt = "2026-10-18T08:00:00.000Z";
      const fetcher = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push({});
          updatedAt = "2026-10-18T10:00:00.000Z";
        }
        return new Response(JSON.stringify({ configJson: savedConfig, updatedAt }), { status: 200 });
      }) as typeof fetch;
      const loaded = await readConfigVersion(COMPANY_ID, fetcher);
      expect(loaded).toBe("2026-10-18T08:00:00.000Z");
      await expect(saveRulesBlock(COMPANY_ID, savedConfig.rules, fetcher, [], false, "2026-10-18T07:00:00.000Z")).rejects.toThrow(/saved elsewhere/);
      expect(posts).toEqual([]);
      await expect(saveRulesBlock(COMPANY_ID, savedConfig.rules, fetcher, [], false, loaded)).resolves.toBe("2026-10-18T10:00:00.000Z");
      expect(posts).toHaveLength(1);
      const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
      await expect(readConfigVersion(COMPANY_ID, failing)).rejects.toThrow(/could not be read/);
    });

    it("no save while the loaded config version is unknown (RK9-563)", async () => {
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") posts.push({});
        return new Response("down", { status: 503 });
      }) as typeof fetch;
      await render(createElement(SettingsPage, { context: CONTEXT }));
      await type("Kynnys", "0.6");
      await click("Tallenna säännöt");
      expect(posts).toEqual([]);
      expect(container.textContent).toContain("Tallennetun configin versiota ei ole luettu");
    });

    it("a save that keeps the shipped defaults of a config without rules.list leaves list out (RK9-563)", () => {
      // The editor shows the effective rules (defaults plus the built-in cap) and sends them back unchanged.
      const shown = parseRules(undefined).rules.list.map((rule) => fromEditor(toEditor(rule as unknown as Record<string, unknown>)));
      const raw = { brandCode: "OLL" };
      expect(prepareRules(raw, { liveMode: false, list: shown })).toMatchObject({ ok: true, rules: { liveMode: false } });
      expect((prepareRules(raw, { liveMode: false, list: shown }) as { rules: Record<string, unknown> }).rules).not.toHaveProperty("list");
      // A changed threshold is the operator's own list.
      const tuned = shown.map((rule) => (rule.ruleId === "cpc-ceiling" ? { ...rule, threshold: 0.4 } : rule));
      expect((prepareRules(raw, { liveMode: false, list: tuned }) as { rules: { list?: unknown[] } }).rules.list).toHaveLength(2);
      // A config with a saved list keeps saving it, defaults or not.
      const listed = { brandCode: "OLL", rules: { liveMode: false, list: [...DEFAULT_RULES] } };
      expect((prepareRules(listed, { liveMode: false, list: shown }) as { rules: { list?: unknown[] } }).rules.list).toHaveLength(2);
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
      await expect(saveRulesBlock(COMPANY_ID, { liveMode: true, list: [CPC] }, fetcher, ["Kynnyspysäytys cpm-ceiling: poistetaan."])).resolves.toBeNull();
      expect(posts).toHaveLength(1);
    });

    it("the save refuses live mode on against a config saved with it off, unless LIVE was typed (RK9-566)", async () => {
      const fetcher = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push({});
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ configJson: { brandCode: "OLL", rules: { liveMode: false, list: [CPC] } } }), { status: 200 });
      }) as typeof fetch;
      await expect(saveRulesBlock(COMPANY_ID, { liveMode: true, list: [CPC] }, fetcher, [])).rejects.toThrow(/Live-tila päälle/);
      expect(posts).toEqual([]);
      await expect(saveRulesBlock(COMPANY_ID, { liveMode: true, list: [CPC] }, fetcher, [], true)).resolves.toBeNull();
      expect(posts).toHaveLength(1);
    });

    it("a saved config without rules.list reads as the default rules (RK9-566)", async () => {
      expect(EDITOR_DEFAULT_RULES).toEqual(DEFAULT_RULES);
      expect(savedRulesBlock({ brandCode: "OLL" })).toEqual({ liveMode: false, list: EDITOR_DEFAULT_RULES });
      expect(savedRulesBlock({ rules: { liveMode: true } }).list).toEqual(EDITOR_DEFAULT_RULES);
      expect(savedRulesBlock({ rules: { liveMode: true, list: [] } }).list).toEqual([]);
      // Removing the shipped default is listed like any enabled rule's removal.
      expect(weakeningChanges(savedRulesBlock({ rules: {} }), { liveMode: false, list: [] })).toEqual(["Kynnyspysäytys cpc-ceiling: poistetaan."]);
    });

    describe("parameter changes of a live rule (RK9-566)", () => {
      const live = { liveMode: true, list: [CPC, CAP] };
      const edit = (patch: Record<string, unknown>, cap: Record<string, unknown> = {}) =>
        weakeningChanges(live, { liveMode: true, list: [{ ...CPC, ...patch }, { ...CAP, ...cap }] });

      it("flags the direction that fires less, for each parameter", () => {
        expect(edit({ threshold: 1000 })).toEqual(["Kynnyspysäytys cpc-ceiling: kynnys 0.8 → 1000."]);
        expect(edit({ operator: "lt" })).toEqual(["Kynnyspysäytys cpc-ceiling: vertailu gt → lt."]);
        expect(edit({ metric: "cpm" })).toEqual(["Kynnyspysäytys cpc-ceiling: mittari cpc → cpm."]);
        expect(edit({ minSpendEur: 1_000_000 })).toEqual(["Kynnyspysäytys cpc-ceiling: väh. kulutus € 3 → 1000000."]);
        expect(edit({ minImpressions: 500, minClicks: 5 })).toEqual(["Kynnyspysäytys cpc-ceiling: väh. näytöt 0 → 500, väh. linkkiklikit 0 → 5."]);
        expect(edit({ cooldownHours: 720 })).toEqual(["Kynnyspysäytys cpc-ceiling: cooldown h 24 → 720."]);
        expect(edit({}, { cooldownHours: 24 })).toEqual([]);
        expect(weakeningChanges({ liveMode: true, list: [CPC, { ...CAP, cooldownHours: 6 }] }, live)).toEqual(["Kuukausikatto 90 % (sisäänrakennettu): cooldown h 6 → 24."]);
        // window_total: any change of the window is flagged; aggregate changes too.
        expect(edit({ days: 3 })).toEqual(["Kynnyspysäytys cpc-ceiling: päivät 7 → 3."]);
        expect(edit({ aggregate: "each_day" })).toEqual(["Kynnyspysäytys cpc-ceiling: laskenta window_total → each_day."]);
      });

      it("does not flag a change that fires as much or more", () => {
        expect(edit({ threshold: 0.5, minSpendEur: 1, minImpressions: 0, cooldownHours: 12, operator: "gte" })).toEqual([]);
        expect(edit({}, { cooldownHours: 12 })).toEqual([]);
      });

      it("reads the threshold against the operator's direction, and gte -> gt / lte -> lt as weakening", () => {
        const ctr = { ...CPC, metric: "ctr", operator: "lt", threshold: 0.5 };
        const savedCtr = { liveMode: true, list: [ctr] };
        expect(weakeningChanges(savedCtr, { liveMode: true, list: [{ ...ctr, threshold: 0.1 }] })).toEqual(["Kynnyspysäytys cpc-ceiling: kynnys 0.5 → 0.1."]);
        expect(weakeningChanges(savedCtr, { liveMode: true, list: [{ ...ctr, threshold: 0.9 }] })).toEqual([]);
        expect(weakeningChanges({ liveMode: true, list: [{ ...ctr, operator: "lte" }] }, { liveMode: true, list: [ctr] })).toEqual(["Kynnyspysäytys cpc-ceiling: vertailu lte → lt."]);
        expect(edit({ operator: "gte" })).toEqual([]);
        expect(weakeningChanges({ liveMode: true, list: [{ ...CPC, operator: "gte" }] }, live)).toEqual(["Kynnyspysäytys cpc-ceiling: vertailu gte → gt."]);
        // each_day: more days must all break the threshold; fewer days shrink the window the minimum gates sum over.
        const daily = { ...CPC, aggregate: "each_day", days: 2 };
        expect(weakeningChanges({ liveMode: true, list: [daily] }, { liveMode: true, list: [{ ...daily, days: 5 }] })).toEqual(["Kynnyspysäytys cpc-ceiling: päivät 2 → 5."]);
        expect(weakeningChanges({ liveMode: true, list: [daily] }, { liveMode: true, list: [{ ...daily, days: 1 }] })).toEqual(["Kynnyspysäytys cpc-ceiling: päivät 2 → 1."]);
      });

      it("a shadow rule's tuning is not weakening; the schema's defaults fill missing fields", () => {
        const shadow = { ...CPC, mode: "shadow" };
        expect(weakeningChanges({ liveMode: true, list: [shadow] }, { liveMode: true, list: [{ ...shadow, threshold: 1000 }] })).toEqual([]);
        const bare = { ruleId: "bare", type: "threshold_pause", mode: "live", metric: "cpc", operator: "gt", threshold: 1, minImpressions: 0, minClicks: 0 };
        expect(weakeningChanges({ liveMode: true, list: [bare] }, { liveMode: true, list: [{ ...bare, days: 1, aggregate: "each_day", minSpendEur: 0, cooldownHours: 24, enabled: true }] })).toEqual([]);
        expect(weakeningChanges({ liveMode: true, list: [bare] }, { liveMode: true, list: [{ ...bare, cooldownHours: 48 }] })).toEqual(["Kynnyspysäytys bare: cooldown h 24 → 48."]);
      });

      it("the worker refuses an unconfirmed weakening or live-mode save and accepts the confirmed one", () => {
        const raw = { brandCode: "OLL", rules: live };
        const weakened = { liveMode: true, list: [{ ...CPC, threshold: 1000 }, CAP] };
        expect(prepareRules(raw, weakened)).toMatchObject({ ok: false, confirm: { weakening: ["Kynnyspysäytys cpc-ceiling: kynnys 0.8 → 1000."], liveOn: false } });
        expect(prepareRules(raw, { ...weakened, confirmedWeakening: ["something else"] })).toMatchObject({ ok: false });
        expect(prepareRules(raw, { ...weakened, confirmedWeakening: ["Kynnyspysäytys cpc-ceiling: kynnys 0.8 → 1000."] })).toMatchObject({ ok: true });
        const off = { brandCode: "OLL", rules: { ...live, liveMode: false } };
        expect(prepareRules(off, live)).toMatchObject({ ok: false, confirm: { weakening: [], liveOn: true } });
        expect(prepareRules(off, { ...live, confirmLive: true })).toMatchObject({ ok: true });
      });
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
