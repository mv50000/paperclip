/**
 * Worker side of the operator UI (A12, RK9-518): company scoping, the
 * allowlisted DTOs, pause-ad and the kill switch, no activate path, and a
 * secret scan over every data and action response and over the UI bundle.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import esbuild from "esbuild";
import type { Company } from "@paperclipai/plugin-sdk";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { PREFLIGHT_STATUS_DATA_KEY, PROVISION_ACTION_KEY, VERIFY_CONNECTION_ACTION_KEY } from "../src/features/brand/register.js";
import { RESEND_GATE_CARD_ACTION_KEY } from "../src/features/gate/register.js";
import { RULE_AGGREGATES, RULE_METRICS, RULE_MODES, RULE_OPERATORS } from "../src/features/rules/schema.js";
import { EDITABLE_RULE_TYPES } from "../src/features/rules/editor.js";
import { RULES_DATA_KEY, RULES_DRY_RUN_ACTION_KEY, RULES_PREPARE_SAVE_ACTION_KEY } from "../src/features/rules/register.js";
import { CLEAR_HALT_ACTION_KEY, PAUSE_ALL_ACTION_KEY } from "../src/features/spend-guard/register.js";
import type { UiOverview, UiSettings, UiWidget } from "../src/features/ui/dto.js";
import { OVERVIEW_DATA_KEY, PAUSE_AD_ACTION_KEY, SETTINGS_DATA_KEY, UI_PAUSE_RULE_ID, WIDGET_DATA_KEY } from "../src/features/ui/register.js";
import { PUBLICATION_DATA_KEY } from "../src/features/publish/register.js";
import { sanitize } from "../src/features/ui/sanitize.js";
import { addDays } from "../src/insights/mtd.js";
import { localDate } from "../src/kit/local-time.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import manifest, { PLUGIN_ID } from "../src/manifest.js";
import { ACTION, DATA, PLUGIN_KEY } from "../src/ui/keys.js";
import { EDITOR_AGGREGATES, EDITOR_METRICS, EDITOR_MODES, EDITOR_OPERATORS, EDITOR_RULE_TYPES } from "../src/ui/rule-fields.js";
import plugin from "../src/worker.js";
import { brandConfig, COMPANY_A, COMPANY_B, COMPANY_UNCONFIGURED, PACKAGE_ROOT, SECRET_A_BOT, SECRET_A_META, SECRET_B_META, secretRef } from "./fixtures.js";
import { FakeMeta } from "./spend-guard/fake-meta.js";

const META_TOKEN = "EAAuitestmetatokencompanya0000000000000";
const META_TOKEN_B = "EAAuitestmetatokencompanyb0000000000000";
const BOT_TOKEN = "7123456789:AAEuiTestBotTokenCompanyA_xxxxxxxxxxxx";
const UI = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } };
const AGENT = { companyId: COMPANY_A, actor: { type: "agent" as const, agentId: "agent-1" } };
const PUB_A = "aaaaaaaa-1111-4111-8111-000000000001";
const PUB_B = "bbbbbbbb-1111-4111-8111-000000000001";
const GATE_A = "aaaaaaaa-2222-4222-8222-000000000001";

/** The patterns of the AC: a Meta token, a Telegram bot token (also inside a Bot API URL), and the harness's resolved values. */
const SECRET_PATTERNS = [/EAA[A-Za-z0-9]+/, /\d{6,}:[A-Za-z0-9_-]{30,}/];

function assertNoSecrets(label: string, text: string) {
  for (const pattern of SECRET_PATTERNS) expect(pattern.test(text), `${label} matches ${pattern}`).toBe(false);
  for (const secret of [META_TOKEN, META_TOKEN_B, BOT_TOKEN]) expect(text.includes(secret), `${label} holds a resolved secret`).toBe(false);
}

function publicationRow(companyId: string, id: string, adId: string, name: string, error: string | null = null) {
  return {
    id,
    company_id: companyId,
    brand_code: "OLL",
    creative_id: null,
    idempotency_key: `key-${id}`,
    content_hash: "hash",
    mode: "publish",
    status: "published",
    ad_name: name,
    meta_ad_id: adId,
    error,
    payload: JSON.stringify({ v: 1, kind: "image", mediaUrl: "https://cdn.example/x.jpg", copy: { message: "Hei" } }),
    published_at: "2026-10-15T08:00:00Z",
    created_at: "2026-10-15T07:59:00Z",
    updated_at: "2026-10-15T08:00:00Z",
  };
}

interface Rows {
  publications: Record<string, unknown>[];
  gates: Record<string, unknown>[];
  series: Record<string, unknown>[];
  ruleActions: Record<string, unknown>[];
}

/** Stored rows per company. `poisoned`: a stored error that echoed both tokens, which the UI DTOs must redact. */
function rowsByCompany(poisoned: boolean): Record<string, Rows> {
  const today = localDate(new Date(), "Europe/Helsinki");
  return {
    [COMPANY_A]: {
      publications: [publicationRow(COMPANY_A, PUB_A, "301", "OLL kesä 1", poisoned ? `Graph 400 for token ${META_TOKEN} via bot ${BOT_TOKEN}` : null)],
      gates: [{ id: GATE_A, company_id: COMPANY_A, kind: "activate_ad", status: "pending", ad_id: "301", publication_id: PUB_A, valid_until: addDays(today, 2) + "T09:00:00Z", token: "gate-token-hash", payload: { secret: "x" } }],
      series: [
        { ad_id: "301", day: addDays(today, -2), cents: 250, impressions: 1000, reach: 900, frequency: 1.1, clicks: 12, inline_link_clicks: 10 },
        { ad_id: "301", day: addDays(today, -1), cents: 150, impressions: 800, reach: 700, frequency: 1.1, clicks: 6, inline_link_clicks: 5 },
      ],
      ruleActions: [
        { rule_id: "cpc-ceiling", rule_type: "threshold_pause", action: "pause", object_type: "ad", object_id: "301", mode: "shadow", applied: false, decided_at: "2026-10-20T05:00:00Z" },
      ],
    },
    [COMPANY_B]: {
      publications: [publicationRow(COMPANY_B, PUB_B, "901", "SUN ad")],
      gates: [],
      series: [],
      ruleActions: [],
    },
  };
}

interface Rig {
  harness: TestHarness;
  meta: FakeMeta;
  actionKeys: string[];
  dataKeys: string[];
  queries: Array<{ sql: string; params: unknown[] }>;
  ruleActionInserts(): Array<Record<string, unknown>>;
}

async function rig(options: { poisoned?: boolean } = {}): Promise<Rig> {
  const harness = createTestHarness({ manifest });
  harness.seed({
    companies: [
      { id: COMPANY_A, name: "Ololla" } as Company,
      { id: COMPANY_B, name: "Sunspot" } as Company,
      { id: COMPANY_UNCONFIGURED, name: "Other" } as Company,
    ],
  });
  useCompanyConfigs(harness, {
    [COMPANY_A]: brandConfig({
      displayName: "Ololla",
      telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: "-1001", allowedUserIds: ["4242"], mode: "poll" },
    }),
    [COMPANY_B]: brandConfig({
      brandCode: "SUN",
      meta: { adAccountId: "act_555", pageId: "777", accessTokenRef: secretRef(SECRET_B_META) },
      landing: { allowedDomains: ["sunspot.fi"], urls: { home: "https://sunspot.fi/" } },
    }),
  });
  useCompanySecrets(harness, {
    [COMPANY_A]: { [SECRET_A_META]: META_TOKEN, [SECRET_A_BOT]: BOT_TOKEN },
    [COMPANY_B]: { [SECRET_B_META]: META_TOKEN_B },
  });
  const meta = new FakeMeta();
  meta.spend = () => "12.34";
  meta.campaigns = [{ id: "100", name: "OLL kampanja", status: "ACTIVE" }];
  meta.adsets = [{ id: "200", name: "OLL joukko", status: "ACTIVE", campaign_id: "100", daily_budget: "322" }];
  meta.ads = [
    { id: "301", name: "OLL kesä 1", status: "ACTIVE", adset_id: "200", campaign_id: "100" },
    { id: "302", name: "Vieras", status: "ACTIVE", adset_id: "200", campaign_id: "100" },
  ];
  meta.foreign.add("302");
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    throw new Error("no route in the UI test");
  };

  const data = rowsByCompany(options.poisoned === true);
  const queries: Rig["queries"] = [];
  harness.ctx.db.query = async <T,>(sql: string, params?: unknown[]): Promise<T[]> => {
    queries.push({ sql, params: params ?? [] });
    const rows = data[String(params?.[0])];
    if (!rows) return [];
    if (/FROM \S+\.publications WHERE/.test(sql)) return rows.publications as T[];
    if (/FROM \S+\.gate_requests WHERE/.test(sql) && /status = \$2/.test(sql)) return rows.gates as T[];
    if (/FROM \S+\.insights_daily WHERE/.test(sql) && /ad_id IN/.test(sql)) return rows.series as T[];
    if (/FROM \S+\.rule_actions WHERE/.test(sql) && /make_interval/.test(sql)) return rows.ruleActions as T[];
    return [];
  };

  // The harness's execute reports rowCount 0; the pause-ad idempotency marker (alert_dedupe) needs a real ON CONFLICT answer (RK9-563).
  const dedupe = new Set<string>();
  const execute = harness.ctx.db.execute.bind(harness.ctx.db);
  harness.ctx.db.execute = async (sql: string, params?: unknown[]) => {
    const result = await execute(sql, params);
    if (/INSERT INTO \S+\.alert_dedupe .* ON CONFLICT DO NOTHING/s.test(sql)) {
      const key = `${String(params?.[0])}|${String(params?.[2])}`;
      if (dedupe.has(key)) return { rowCount: 0 };
      dedupe.add(key);
      return { rowCount: 1 };
    }
    if (/DELETE FROM \S+\.alert_dedupe WHERE/.test(sql)) {
      dedupe.delete(`${String(params?.[0])}|${String(params?.[1])}`);
      return { rowCount: 1 };
    }
    return result;
  };

  const actionKeys: string[] = [];
  const dataKeys: string[] = [];
  const registerAction = harness.ctx.actions.register.bind(harness.ctx.actions);
  harness.ctx.actions.register = (key, handler) => {
    actionKeys.push(key);
    registerAction(key, handler);
  };
  const registerData = harness.ctx.data.register.bind(harness.ctx.data);
  harness.ctx.data.register = (key, handler) => {
    dataKeys.push(key);
    registerData(key, handler);
  };
  await plugin.definition.setup(harness.ctx);
  return {
    harness,
    meta,
    actionKeys,
    dataKeys,
    queries,
    ruleActionInserts: () =>
      harness.dbExecutes
        .filter((entry) => /INSERT INTO \S+\.rule_actions/.test(entry.sql))
        .map((entry) => {
          const columns = /\(([^)]*)\) VALUES/.exec(entry.sql)![1]!.split(",").map((column) => column.trim());
          return Object.fromEntries(columns.map((column, index) => [column, entry.params?.[index]]));
        }),
  };
}

describe("operator UI handlers (RK9-518)", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it("pins every UI key to the worker's own constant", () => {
    expect(PLUGIN_KEY).toBe(PLUGIN_ID);
    expect(DATA).toEqual({
      overview: OVERVIEW_DATA_KEY,
      widget: WIDGET_DATA_KEY,
      settings: SETTINGS_DATA_KEY,
      preflight: PREFLIGHT_STATUS_DATA_KEY,
      rules: RULES_DATA_KEY,
    });
    expect(ACTION).toEqual({
      pauseAd: PAUSE_AD_ACTION_KEY,
      pauseAll: PAUSE_ALL_ACTION_KEY,
      clearHalt: CLEAR_HALT_ACTION_KEY,
      resendGateCard: RESEND_GATE_CARD_ACTION_KEY,
      digestPreview: "digest.dryRun",
      verifyConnection: VERIFY_CONNECTION_ACTION_KEY,
      provision: PROVISION_ACTION_KEY,
      rulesDryRun: RULES_DRY_RUN_ACTION_KEY,
      rulesPrepareSave: RULES_PREPARE_SAVE_ACTION_KEY,
    });
    for (const key of Object.values(ACTION)) expect(r.actionKeys).toContain(key);
    for (const key of Object.values(DATA)) expect(r.dataKeys).toContain(key);
    expect([...EDITOR_RULE_TYPES].sort()).toEqual([...EDITABLE_RULE_TYPES].sort());
    expect(EDITOR_METRICS).toEqual(RULE_METRICS);
    expect(EDITOR_OPERATORS).toEqual(RULE_OPERATORS);
    expect(EDITOR_AGGREGATES).toEqual(RULE_AGGREGATES);
    expect(EDITOR_MODES).toEqual(RULE_MODES);
  });

  it("registers no activate, resume or unpause action (G1), and performAction('activate') fails", async () => {
    expect(r.actionKeys.filter((key) => /activat|resume|unpause|enable|scale/i.test(key))).toEqual([]);
    await expect(r.harness.performAction("activate", { adId: "301" }, UI)).rejects.toThrow(/No action handler/);
    await expect(r.harness.performAction("resume", { adId: "301" }, UI)).rejects.toThrow(/No action handler/);
    expect(r.meta.writes).toEqual([]);
  });

  it("ads-overview serves the company's page: spend, publications, gates, rule log and 14 days", async () => {
    r = await rig({ poisoned: true });
    const overview = await r.harness.getData<UiOverview>(OVERVIEW_DATA_KEY, { companyId: COMPANY_A });
    expect(overview.state).toBe("enabled");
    expect(overview.brand).toEqual({ brandCode: "OLL", displayName: "Ololla", timeZone: "Europe/Helsinki", monthlyCapEur: 100 });
    // spend_cap 100 € with nothing spent: Meta still allows 100 €, but only 87.66 € of the month is left (RK9-563).
    expect(overview.spend).toMatchObject({
      mtdEur: 12.34,
      monthlyCapEur: 100,
      spendCapEur: 100,
      headroomEur: 100,
      remainingEur: 87.66,
      spendCapStatus: "headroom_above_remaining",
      risks: ["spend_cap_headroom_exceeds_remaining"],
    });
    expect(overview.publications).toEqual([
      expect.objectContaining({ id: PUB_A, adName: "OLL kesä 1", metaAdId: "301", adStatus: "ACTIVE", spendEur: 4, impressions: 1800, linkClicks: 15 }),
    ]);
    expect(overview.publications[0]!.error).toBe("Graph 400 for token [REDACTED] via bot [REDACTED]");
    expect(overview.spend14d.filter((day) => day.spendEur > 0).map((day) => day.spendEur)).toEqual([2.5, 1.5]);
    expect(overview.pendingGates).toEqual([{ id: GATE_A, kind: "activate_ad", adId: "301", publicationId: PUB_A, validUntil: expect.stringMatching(/T09:00:00\.000Z$/) }]);
    expect(overview.ruleLog).toEqual([expect.objectContaining({ ruleId: "cpc-ceiling", objectId: "301" })]);
    expect(overview.spend14d).toHaveLength(14);
    expect(overview.halt).toBeNull();
    // Allowlist: no gate token or payload, no raw config.
    const text = JSON.stringify(overview);
    expect(text).not.toContain("gate-token-hash");
    expect(text).not.toContain(SECRET_A_META);
    expect(text).not.toContain("accessTokenRef");
  });

  it("a lifetime spend_cap above the monthly cap is fine when its headroom fits what is left (RK9-563)", async () => {
    // 5000 € lifetime cap, 4950 € spent over the account's life: Meta allows 50 €, 87.66 € of the month is left.
    r.meta.account = { ...r.meta.account, spend_cap: "500000", amount_spent: "495000" };
    const overview = await r.harness.getData<UiOverview>(OVERVIEW_DATA_KEY, { companyId: COMPANY_A });
    expect(overview.spend).toMatchObject({ spendCapEur: 5000, headroomEur: 50, remainingEur: 87.66, spendCapStatus: "set", risks: [] });
  });

  it("pending cards: the database keeps only live ones, soonest-expiring first, so expired rows cannot fill the limit (RK9-563)", async () => {
    r.queries.length = 0;
    await r.harness.getData<UiOverview>(OVERVIEW_DATA_KEY, { companyId: COMPANY_A });
    const gates = r.queries.filter((query) => /FROM \S+\.gate_requests WHERE/.test(query.sql));
    expect(gates).toHaveLength(1);
    expect(gates[0]!.sql).toMatch(/WHERE company_id = \$1 AND status = \$2 AND valid_until > now\(\) ORDER BY valid_until ASC LIMIT 50$/);
    expect(gates[0]!.params).toEqual([COMPANY_A, "pending"]);
  });

  it("the publication data key redacts a stored error again when it is read (RK9-563)", async () => {
    r = await rig({ poisoned: true });
    const read = await r.harness.getData<{ state: string; publication: { error: string | null } }>(PUBLICATION_DATA_KEY, { companyId: COMPANY_A, publicationId: PUB_A });
    expect(read.state).toBe("ok");
    expect(read.publication.error).toBe("Graph 400 for token [REDACTED] via bot [REDACTED]");
    assertNoSecrets("publication", JSON.stringify(read));
  });

  it("sanitize redacts a bot token inside a Bot API URL, where no word boundary precedes it (RK9-563)", () => {
    const out = sanitize({ error: `POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed` });
    expect(out.error).toBe("POST https://api.telegram.org/bot[REDACTED]/sendMessage failed");
  });

  it("every UI data handler requires a company and serves only that company", async () => {
    for (const key of [OVERVIEW_DATA_KEY, WIDGET_DATA_KEY, SETTINGS_DATA_KEY]) {
      expect(await r.harness.getData(key, {})).toEqual({ state: "error", error: "company context is required" });
      const other = await r.harness.getData<{ state: string }>(key, { companyId: COMPANY_UNCONFIGURED });
      expect(other.state).toBe("absent");
      expect(JSON.stringify(other)).not.toMatch(/OLL|Ololla|301|act_/);
    }
    r.queries.length = 0;
    const b = await r.harness.getData<UiOverview>(OVERVIEW_DATA_KEY, { companyId: COMPANY_B });
    expect(b.brand?.brandCode).toBe("SUN");
    expect(b.publications.map((row) => row.id)).toEqual([PUB_B]);
    expect(JSON.stringify(b)).not.toContain(PUB_A);
    expect(JSON.stringify(b)).not.toContain("OLL kesä");
    // Every ledger read of B's page binds B as $1.
    expect(r.queries.length).toBeGreaterThan(0);
    for (const query of r.queries) expect(query.params[0]).toBe(COMPANY_B);
    // An unconfigured company reads nothing from the ledger.
    r.queries.length = 0;
    await r.harness.getData(OVERVIEW_DATA_KEY, { companyId: COMPANY_UNCONFIGURED });
    expect(r.queries).toEqual([]);
  });

  it("ads-widget and ads-settings are allowlisted views", async () => {
    const widget = await r.harness.getData<UiWidget>(WIDGET_DATA_KEY, { companyId: COMPANY_A });
    expect(widget).toEqual({ state: "enabled", brandCode: "OLL", mtdEur: 12.34, monthlyCapEur: 100, pctUsed: 12.3, pendingGates: 1, halted: false });
    const settings = await r.harness.getData<UiSettings>(SETTINGS_DATA_KEY, { companyId: COMPANY_A });
    expect(settings.meta).toMatchObject({ adAccountId: "29231592883113369", accessTokenConfigured: true });
    expect(settings.telegram).toMatchObject({ configured: true, chatId: "-1001", approverCount: 1 });
    const text = JSON.stringify(settings);
    expect(text).not.toContain(SECRET_A_META);
    expect(text).not.toContain(SECRET_A_BOT);
    expect(text).not.toContain("secret_ref");
    expect(text).not.toContain("4242");
  });

  it("pause-ad previews by default, needs confirm, is board-only, and refuses another account's ad", async () => {
    const preview = await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301" }, UI);
    expect(preview).toEqual({ dryRun: true, adId: "301", name: "OLL kesä 1", previousStatus: "ACTIVE", status: "ACTIVE", paused: false });
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false }, UI)).rejects.toThrow(/confirm: true/);
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true }, AGENT)).rejects.toThrow(/board-only/);
    expect(await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301" }, AGENT)).toMatchObject({ dryRun: true });
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "302", dryRun: false, confirm: true, idempotencyKey: randomUUID() }, UI)).rejects.toThrow(/not in this company's ad account/);
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "act_1; DROP" }, UI)).rejects.toThrow(/digits only/);
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301" }, { ...UI, companyId: COMPANY_UNCONFIGURED })).rejects.toThrow(/not configured/);
    expect(r.meta.writes).toEqual([]);
    expect(r.ruleActionInserts()).toEqual([]);
  });

  it("pause-ad pauses on Meta, writes rule_actions and the activity log, and the overview then shows PAUSED", async () => {
    const result = await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: randomUUID() }, UI);
    expect(result).toMatchObject({ dryRun: false, adId: "301", previousStatus: "ACTIVE", status: "PAUSED", paused: true });
    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([["301", "PAUSED"]]);
    expect(r.ruleActionInserts()).toEqual([
      expect.objectContaining({ rule_id: UI_PAUSE_RULE_ID, rule_type: "kill_switch", object_type: "ad", object_id: "301", action: "pause", source: "ui", applied: true, dry_run: false }),
    ]);
    expect(r.harness.activity).toEqual(
      expect.arrayContaining([expect.objectContaining({ companyId: COMPANY_A, message: expect.stringContaining("ui paused ad 301") })]),
    );
    const overview = await r.harness.getData<UiOverview>(OVERVIEW_DATA_KEY, { companyId: COMPANY_A });
    expect(overview.publications[0]).toMatchObject({ metaAdId: "301", adStatus: "PAUSED" });
  });

  it("pause-ad: a live pause needs an idempotency key, and a repeat of the same key writes nothing (RK9-563)", async () => {
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true }, UI)).rejects.toThrow(/idempotencyKey/);
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: "short" }, UI)).rejects.toThrow(/idempotencyKey/);
    expect(r.meta.writes).toEqual([]);
    const key = randomUUID();
    const first = await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: key }, UI);
    expect(first).toMatchObject({ paused: true, status: "PAUSED" });
    expect(first).not.toHaveProperty("duplicate");
    const activity = r.harness.activity.length;
    const again = await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: key }, UI);
    expect(again).toEqual({ dryRun: false, adId: "301", name: "OLL kesä 1", previousStatus: "PAUSED", status: "PAUSED", paused: true, duplicate: true });
    expect(r.meta.writes).toHaveLength(1);
    expect(r.ruleActionInserts()).toHaveLength(1);
    expect(r.harness.activity).toHaveLength(activity);
  });

  it("pause-ad: a repeat whose key is taken but whose ad still runs pauses again (verifier H1, RK9-563)", async () => {
    const key = randomUUID();
    // A first call that is still running, or that died before it gave the key back.
    await r.harness.ctx.db.execute(
      "INSERT INTO plugin_ns.alert_dedupe (company_id, id, dedupe_key, kind, metadata) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [COMPANY_A, randomUUID(), `pause-ad:301:${key}`, "ui_pause_ad", "{}"],
    );
    const retry = await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: key }, UI);
    expect(retry).toMatchObject({ paused: true, status: "PAUSED", previousStatus: "ACTIVE" });
    expect(retry).not.toHaveProperty("duplicate");
    expect(r.meta.writes.map((call) => [call.path, call.body.status])).toEqual([["301", "PAUSED"]]);
    expect(r.ruleActionInserts()).toHaveLength(1);
  });

  it("pause-ad: a failed pause gives its key back, so the same confirmation can retry (RK9-563)", async () => {
    const key = randomUUID();
    r.meta.fail = (call) => (call.method !== "GET" ? new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 }) : null);
    await expect(r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: key }, UI)).rejects.toThrow(/The pause of ad 301 failed/);
    r.meta.fail = () => null;
    const retry = await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: "301", dryRun: false, confirm: true, idempotencyKey: key }, UI);
    expect(retry).toMatchObject({ paused: true, status: "PAUSED" });
    expect(retry).not.toHaveProperty("duplicate");
    expect(r.ruleActionInserts().map((row) => row.applied)).toEqual([false, true]);
  });

  it("the kill switch (pause-all) needs confirm and pauses every active object with ledger and activity", async () => {
    await expect(r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false }, UI)).rejects.toThrow(/confirm: true/);
    const result = await r.harness.performAction<{ count: number; halt?: unknown }>(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true }, UI);
    expect(result.count).toBe(3);
    expect(result.halt).toBeDefined();
    expect(r.meta.writes.map((call) => call.body.status)).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
    expect(r.ruleActionInserts()).toEqual([expect.objectContaining({ rule_id: "kill_switch", action: "pause_all", source: "ui", applied: true })]);
    expect(r.harness.activity.some((entry) => entry.message.includes("kill_switch paused 3"))).toBe(true);
    // The page shows the standing halt with when, who and why.
    const overview = await r.harness.getData<UiOverview>(OVERVIEW_DATA_KEY, { companyId: COMPANY_A });
    expect(overview.halt).toMatchObject({ source: "ui", userId: "board-user-1" });
  });

  it("rules.prepareSave returns the pause-rules block to save and refuses propose_scale", async () => {
    const valid = await r.harness.performAction<{ ok: boolean; rules: { liveMode: boolean; list: unknown[] } }>(
      RULES_PREPARE_SAVE_ACTION_KEY,
      { liveMode: true, confirmLive: true, confirmedWeakening: ["Kynnyspysäytys cpc-ceiling: poistetaan."], list: [{ ruleId: "cpc-max", type: "threshold_pause", metric: "cpc", operator: "gt", threshold: 0.8, days: 3, minImpressions: 0, minClicks: 0 }, { type: "pause_all_cap", mode: "live" }] },
      UI,
    );
    expect(valid.ok).toBe(true);
    expect(valid.rules.liveMode).toBe(true);
    expect(valid.rules.list).toHaveLength(2);
    // Unconfirmed, the worker refuses and names what to confirm against the config saved now (RK9-566).
    const unconfirmed = await r.harness.performAction<{ ok: boolean; confirm: { weakening: string[]; liveOn: boolean } }>(
      RULES_PREPARE_SAVE_ACTION_KEY,
      { liveMode: true, list: [{ type: "pause_all_cap", mode: "live" }] },
      UI,
    );
    expect(unconfirmed).toMatchObject({ ok: false, confirm: { liveOn: true } });
    const scale = await r.harness.performAction<{ ok: boolean; errors: string[] }>(
      RULES_PREPARE_SAVE_ACTION_KEY,
      { list: [{ ruleId: "grow", type: "propose_scale", enabled: true, threshold: 0.2, minImpressions: 0, minClicks: 0 }] },
      UI,
    );
    expect(scale.ok).toBe(false);
    expect(scale.errors.join(" ")).toMatch(/pause rules only/);
    const reserved = await r.harness.performAction<{ ok: boolean; errors: string[] }>(
      RULES_PREPARE_SAVE_ACTION_KEY,
      { list: [{ ruleId: UI_PAUSE_RULE_ID, type: "pause_fatigued" }] },
      UI,
    );
    expect(reserved.errors.join(" ")).toMatch(/reserved/);
    const invalid = await r.harness.performAction<{ ok: boolean; errors: string[] }>(RULES_PREPARE_SAVE_ACTION_KEY, { list: [{ ruleId: "x", type: "threshold_pause" }] }, UI);
    expect(invalid.ok).toBe(false);
    expect(await r.harness.performAction(RULES_PREPARE_SAVE_ACTION_KEY, { list: [] }, { ...UI, companyId: COMPANY_UNCONFIGURED })).toEqual({ ok: false, errors: ["Brand config is absent"] });
  });

  it("no data or action response holds a token or a resolved secret", async () => {
    const outputs: string[] = [];
    for (const key of r.dataKeys) {
      for (const companyId of [COMPANY_A, COMPANY_B]) {
        try {
          outputs.push(`${key}: ${JSON.stringify(await r.harness.getData(key, { companyId, publicationId: PUB_A }))}`);
        } catch (error) {
          outputs.push(`${key} threw: ${(error as Error).message}`);
        }
      }
    }
    // Dry runs only: no action here may write to Meta.
    const params: Record<string, Record<string, unknown>> = {
      [PAUSE_AD_ACTION_KEY]: { adId: "301" },
      [RESEND_GATE_CARD_ACTION_KEY]: { gateRequestId: GATE_A },
      [RULES_PREPARE_SAVE_ACTION_KEY]: { list: [] },
    };
    for (const key of r.actionKeys) {
      try {
        outputs.push(`${key}: ${JSON.stringify(await r.harness.performAction(key, params[key] ?? {}, UI))}`);
      } catch (error) {
        outputs.push(`${key} threw: ${(error as Error).message}`);
      }
    }
    expect(r.meta.writes).toEqual([]);
    expect(outputs.length).toBe(r.dataKeys.length * 2 + r.actionKeys.length);
    for (const output of outputs) assertNoSecrets(output.slice(0, 40), output);
  });

  describe("the built UI bundle", () => {
    const outdir = mkdtempSync(join(tmpdir(), "rk9-ads-ui-"));
    afterAll(() => rmSync(outdir, { recursive: true, force: true }));

    it("holds no token shape and no worker code", async () => {
      const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx", outdir, sourcemap: false });
      await esbuild.build({ ...presets.esbuild.ui!, absWorkingDir: PACKAGE_ROOT, logLevel: "silent" } as esbuild.BuildOptions);
      const bundle = readFileSync(join(outdir, "ui", "index.js"), "utf8");
      assertNoSecrets("dist/ui/index.js", bundle);
      // Types only cross from the worker: no Meta client, no zod, no SQL.
      expect(bundle).not.toMatch(/graph\.facebook\.com|from "zod"|INSERT INTO/);
      expect(bundle).not.toMatch(/["']activate["']/);
    });
  });
});
