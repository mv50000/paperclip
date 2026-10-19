/**
 * A pause beats an open activation card (RK9-557, RK9-517 verifier): the
 * kill switch, the 90 % cap pause and the scheduled pause close the brand's
 * open activate_ad cards and leave a halt that refuses every activation: the
 * kill switch's until a board user clears it, the scheduled pause's until the
 * next local morning, the cap pause's until the next local month (RK9-561).
 * A real pauseAll that runs during an activation's writes wins. The approval is
 * also bound to the publication's contentHash. The Telegram controller is
 * the real one on a fake Bot API; Meta is a routing fake.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createLedger } from "../src/db.js";
import { registerGate, type GateOverrides } from "../src/features/gate/register.js";
import { HALT_NAMESPACE, newAdHalt, readAdHalt, readHalt, setAdHalt, setHalt, type AdHaltState, type HaltState } from "../src/features/spend-guard/halt.js";
import { pauseAll, type PauseAllResult, type PauseRule } from "../src/features/spend-guard/killswitch.js";
import { CLEAR_HALT_ACTION_KEY, HALT_CLEARED_ACTIVITY, PAUSE_ALL_ACTION_KEY, registerSpendGuard, SPEND_GUARD_ACTION_KEY, UNDO_ACKNOWLEDGED_ACTIVITY } from "../src/features/spend-guard/register.js";
import { addPendingUndos, readPendingUndos, reportUndoFailure, type PendingUndo } from "../src/features/spend-guard/pending-undo.js";
import { memoryOnceStore } from "../src/features/spend-guard/support.js";
import { TelegramController } from "../src/features/telegram/controller.js";
import { gateRegistry, resetGateRegistry } from "../src/features/telegram/gates.js";
import type { FeatureRuntime } from "../src/features/types.js";
import type { BrandConfig } from "../src/config.js";
import { parseBrandConfig } from "../src/config.js";
import type { StagingCards } from "../src/gate/staging-card.js";
import { GATE_TEXT } from "../src/kit/gate/callback-router.js";
import { createMemoryGateStore, type MemoryGateStore } from "../src/kit/testing/memory-gate-store.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { telegramBotKey } from "../src/kit/telegram/bot-api.js";
import type { PublishedPublication } from "../src/publish/handoff.js";
import { memoryPublicationStore } from "../src/publish/store.js";
import type { PublicationRecord } from "../src/publish/types.js";
import { nextLocalMonthStart, nextLocalTime } from "../src/kit/local-time.js";
import { brandConfig, COMPANY_A, COMPANY_B, SECRET_A_BOT, SECRET_A_META, secretRef } from "./fixtures.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";
import { memoryActivationRepo } from "./gate/memory-repo.js";
import { FakeMeta } from "./spend-guard/fake-meta.js";
import { FakeNotifier } from "./spend-guard/rig.js";

const META_TOKEN = "EAAtest-meta-token-halt-00000000000000";
const BOT_TOKEN = "1234567:AAE-halt-test-fake-bot-token-0123456789";
const BOT = telegramBotKey(BOT_TOKEN);
const CHAT = "-100778";
const APPROVER = 4242;
const PUBLICATION_ID = "dddddddd-0000-4000-8000-000000000011";
const SWAP_PUBLICATION_ID = "dddddddd-0000-4000-8000-000000000012";
const CAMPAIGN = "120200000000000101";
const ADSET = "120200000000000201";
const AD = "120200000000000301";
const OLD_AD = "120200000000000302";
const CREATIVE = "120200000000000401";
const HASH = "c".repeat(64);

const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-1" } };
const AGENT = { companyId: COMPANY_A, actor: { type: "agent" as const, agentId: "agent-1", runId: "run-1" } };

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawConfig(): Record<string, unknown> {
  return brandConfig({ telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: CHAT, allowedUserIds: [String(APPROVER)], mode: "poll" } });
}

function parsedConfig(): BrandConfig {
  const parsed = parseBrandConfig(rawConfig());
  if (parsed.state !== "enabled") throw new Error("test config invalid");
  return parsed.config;
}

/** Campaign, ad set and the new ad PAUSED; an older ad of the ad set ACTIVE. */
function freshMeta(): FakeMeta {
  const meta = new FakeMeta();
  meta.campaigns = [{ id: CAMPAIGN, name: "OLL pysyvä", status: "PAUSED" }];
  meta.adsets = [{ id: ADSET, name: "OLL Helsinki", status: "PAUSED", campaign_id: CAMPAIGN, daily_budget: "322" }];
  meta.ads = [
    { id: OLD_AD, name: "OLL vanha", status: "ACTIVE", adset_id: ADSET, campaign_id: CAMPAIGN, creative_id: "120200000000000499" },
    { id: AD, name: "OLL syksy 1", status: "PAUSED", adset_id: ADSET, campaign_id: CAMPAIGN, creative_id: CREATIVE },
  ];
  return meta;
}

function publication(): PublishedPublication {
  return {
    publicationId: PUBLICATION_ID,
    companyId: COMPANY_A,
    brandCode: "OLL",
    adName: "OLL syksy 1",
    adId: AD,
    adsetId: ADSET,
    campaignId: CAMPAIGN,
    creativeId: CREATIVE,
    contentHash: HASH,
    finalUrl: "https://www.ololla.fi/?utm_source=meta",
    publishedAt: "2026-10-21T09:00:00.000Z",
    preview: { kind: "image", mediaUrl: "https://media.ololla.fi/syksy.jpg", posterUrl: null, copy: { message: "Syksyn parhaat kohteet" } },
  };
}

function publicationRow(overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: PUBLICATION_ID,
    companyId: COMPANY_A,
    brandCode: "OLL",
    creativeId: null,
    idempotencyKey: "oll-syksy-1",
    contentHash: HASH,
    mode: "publish",
    status: "published",
    adName: "OLL syksy 1",
    campaignId: CAMPAIGN,
    adsetId: ADSET,
    metaVideoId: null,
    metaImageHash: null,
    metaCreativeId: CREATIVE,
    metaAdId: AD,
    replacesPublicationId: null,
    error: null,
    payload: {} as PublicationRecord["payload"],
    publishedAt: "2026-10-21T09:00:00.000Z",
    createdAt: "2026-10-21T09:00:00.000Z",
    updatedAt: "2026-10-21T09:00:00.000Z",
    ...overrides,
  };
}

interface Rig {
  harness: TestHarness;
  runtime: FeatureRuntime;
  meta: FakeMeta;
  fake: FakeTelegram;
  store: MemoryGateStore;
  controller: TelegramController;
  cards: StagingCards;
  notifier: FakeNotifier;
  publications: ReturnType<typeof memoryPublicationStore>;
  repo: ReturnType<typeof memoryActivationRepo>;
  once: ReturnType<typeof memoryOnceStore>;
}

const rigs: Rig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.controller.stop()));
});

/** The telegram, spend-guard and gate features, in the worker's order. */
async function rig(input: { meta?: FakeMeta; gate?: GateOverrides } = {}): Promise<Rig> {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY_A, name: "Ololla" } as Company] });
  useCompanyConfigs(harness, { [COMPANY_A]: rawConfig() });
  useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: META_TOKEN, [SECRET_A_BOT]: BOT_TOKEN } });
  const meta = input.meta ?? freshMeta();
  const fake = new FakeTelegram();
  fake.maxWaitMs = 200;
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    return fake.fetch(url, init);
  };
  const store = createMemoryGateStore();
  const repo = memoryActivationRepo(store, () => new Date());
  resetGateRegistry();
  const controller = new TelegramController(harness.ctx, {
    store,
    registry: gateRegistry(),
    fetch: fake.fetch,
    pollTimeoutSeconds: 1,
    errorBackoffMs: 20,
    conflictBackoffMs: 60,
  });
  const runtime: FeatureRuntime = {
    ctx: harness.ctx,
    ledger: createLedger(harness.ctx.db),
    handleWebhook() {},
    handleApiRoute() {},
    onConfigChanged() {},
    onShutdown() {},
  };
  const notifier = new FakeNotifier();
  // One marker store for the spend guard's job and the gate's undo alert, as in the worker (alert_dedupe).
  const once = memoryOnceStore();
  registerSpendGuard(runtime, { store: once, notifier, newerActivation: (companyId, query) => repo.newerActivation(companyId, query) });
  const publications = memoryPublicationStore();
  publications.rows.push(publicationRow());
  const { cards } = registerGate(runtime, {
    store,
    repo,
    publications,
    transport: () => controller,
    assertLaunchReady: async () => undefined,
    notifier,
    onceStore: once,
    ...input.gate,
  });
  await controller.replan();
  await waitFor(() => controller.summary()[0]?.loop === "running");
  const out = { harness, runtime, meta, fake, store, controller, cards, notifier, publications, repo, once };
  rigs.push(out);
  return out;
}

async function tap(r: Rig, messageId: number, data?: string): Promise<void> {
  const before = r.fake.callsOf("answerCallbackQuery").length;
  r.fake.tap(BOT, { messageId, data: data ?? r.fake.buttons(messageId)[0]!, fromId: APPROVER });
  await waitFor(() => r.fake.callsOf("answerCallbackQuery").length > before);
  await r.controller.idle();
}

function caption(r: Rig, messageId: number): string {
  const message = r.fake.messages.get(messageId);
  return String(message?.caption ?? message?.text ?? "");
}

function activeWrites(meta: FakeMeta) {
  return meta.writes.filter((call) => call.body.status === "ACTIVE");
}

function lastAnswer(r: Rig): string {
  return String(r.fake.callsOf("answerCallbackQuery").at(-1)!.params.text);
}

/** pauseAll with the deps the rules runner and the scheduled-pause job pass (no card override). */
function runPause(r: Rig, rule: PauseRule): Promise<PauseAllResult> {
  return pauseAll({ ctx: r.harness.ctx, ledger: r.runtime.ledger, notifier: r.notifier }, COMPANY_A, parsedConfig(), {
    dryRun: false,
    rule,
    reason: `${rule} test`,
    initiator: { source: "job", jobRunId: "job-1" },
    notify: true,
  });
}

function haltOf(r: Rig): Promise<HaltState | null> {
  return readHalt(r.harness.ctx, COMPANY_A);
}

function statusOf(meta: FakeMeta, id: string): string | undefined {
  return [...meta.campaigns, ...meta.adsets, ...meta.ads].find((object) => object.id === id)?.status;
}

/**
 * Runs `pause` while the activation's ACTIVE write on `objectId` is in
 * flight: before Meta applies it, or after Meta applied it and before the
 * handler goes on. Returns whether the write was seen.
 */
function pauseDuringWrite(r: Rig, objectId: string, when: "before" | "after", pause: () => Promise<unknown>): () => boolean {
  const original = r.harness.ctx.http.fetch;
  let fired = false;
  r.harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? new URLSearchParams(String(init.body)) : null;
    const hit = !fired && init?.method === "POST" && new URL(url).pathname.endsWith(`/${objectId}`) && body?.get("status") === "ACTIVE";
    if (!hit) return original(url, init);
    fired = true;
    if (when === "before") {
      await pause();
      return original(url, init);
    }
    const response = await original(url, init);
    await pause();
    return response;
  };
  return () => fired;
}

describe("the kill switch closes open activation cards and leaves a standing halt", () => {
  it("open card, kill switch, tap: no Meta ACTIVE write, the card names the reason, the halt is set", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const staleButton = r.fake.buttons(sent.messageId)[0]!;

    const result = await r.harness.performAction<PauseAllResult>(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
    expect(result.closedCardIds).toEqual([sent.id]);
    expect(result.halt).toMatchObject({ brandCode: "OLL", rule: "kill_switch", reason: "hätä", initiator: { source: "ui", userId: "board-1" } });
    expect(result.cardsError).toBeUndefined();
    expect(result.haltError).toBeUndefined();
    expect(r.store.rows.get(sent.id)).toMatchObject({ status: "expired", outcome: { handler: "not_run", reason: "kill_switch" } });
    expect(caption(r, sent.messageId)).toContain("⛔ Hätäkatkaisin painettu: kortti mitätöity");
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    expect(await haltOf(r)).toMatchObject({ brandCode: "OLL", rule: "kill_switch" });
    expect(r.notifier.messages[0]!.text).toContain("Pysäytystila päällä");
    expect(r.notifier.messages[0]!.text).toContain("Avoimia aktivointikortteja mitätöity: 1");

    // A second approver whose client still shows the old buttons.
    await tap(r, sent.messageId, staleButton);
    expect(lastAnswer(r)).toBe(GATE_TEXT.expired);
    expect(activeWrites(r.meta)).toEqual([]);
    expect(r.store.rows.get(sent.id)!.status).toBe("expired");
    expect(caption(r, sent.messageId)).toContain("⛔ Hätäkatkaisin painettu");
    expect(r.harness.activity.some((entry) => entry.message === "rk9-ads gate: card closed" && entry.entityId === sent.id)).toBe(true);
  });

  it("a card sent after the kill switch refuses to activate and says why", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
    const writesAfterSwitch = r.meta.writes.length;
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("denied");
    expect(row.outcome).toMatchObject({ result: "denied", reason: "halted" });
    expect(caption(r, sent.messageId)).toContain("⛔ Ei aktivoitu: hätäkatkaisin on painettu");
    expect(caption(r, sent.messageId)).toContain("hätä");
    expect(r.meta.writes).toHaveLength(writesAfterSwitch);
  });

  it("the Telegram pause_all button and the agent tool leave the halt too", async () => {
    const r = await rig();
    const tool = await r.harness.executeTool<{ content?: string; error?: string }>("rk9ads_pause_all", { reason: "CPC karkasi" }, { companyId: COMPANY_A, agentId: "agent-1" });
    expect(tool.error).toBeUndefined();
    expect(tool.content).toContain("Standing halt set");
    expect(await haltOf(r)).toMatchObject({ initiator: { source: "agent", agentId: "agent-1" } });
  });

  it("a config that cannot be loaded still leaves the halt and closes the cards, then fails with nothing paused (RK9-561)", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    // No last valid config: pause-config has never run for the company.
    r.harness.ctx.config.get = async () => {
      throw new Error("config store down");
    };
    await expect(r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD)).rejects.toThrow(
      /nothing was paused in Meta\. Standing halt set.*Closed 1 open activation card/,
    );
    expect(await haltOf(r)).toMatchObject({ rule: "kill_switch", brandCode: "?", reason: "hätä", initiator: { source: "ui", userId: "board-1" } });
    expect(r.store.rows.get(sent.id)).toMatchObject({ status: "expired", outcome: { reason: "kill_switch" } });
    expect(caption(r, sent.messageId)).toContain("⛔ Hätäkatkaisin painettu");
    expect(r.meta.writes).toEqual([]);

    const tool = await r.harness.executeTool<{ content?: string; error?: string }>("rk9ads_pause_all", { reason: "CPC karkasi" }, { companyId: COMPANY_A, agentId: "agent-1" });
    expect(tool.error).toMatch(/nothing was paused in Meta\. Standing halt set/);
    expect(await haltOf(r)).toMatchObject({ initiator: { source: "agent", agentId: "agent-1" } });
  });

  it("a listing that fails after the halt names the halt and the closed cards in the UI action's error", async () => {
    const r = await rig();
    await r.cards.openActivationCard(publication());
    r.meta.fail = (call) => (call.method === "GET" && call.path.endsWith("/campaigns") ? new Error("graph down") : null);
    await expect(r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD)).rejects.toThrow(
      /Pause failed before anything was paused: .*graph down.*Standing halt set.*Closed 1 open activation card/,
    );
    expect(await haltOf(r)).toMatchObject({ rule: "kill_switch" });
  });

  it("a dry run of the kill switch closes nothing and sets no halt", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const result = await r.harness.performAction<PauseAllResult>(PAUSE_ALL_ACTION_KEY, { dryRun: true }, BOARD);
    expect(result.closedCardIds).toEqual([]);
    expect(result.halt).toBeUndefined();
    expect(r.store.rows.get(sent.id)!.status).toBe("pending");
    expect(await haltOf(r)).toBeNull();
  });

  it("refuses when the halt cannot be read, with no Meta write", async () => {
    const r = await rig({
      gate: {
        haltOf: async () => {
          throw new Error("state unavailable");
        },
      },
    });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "denied", reason: "halt_unreadable" });
    expect(r.meta.writes).toEqual([]);
  });

  it("a halt set while the activation writes pauses the ad again and fails the card", async () => {
    let reads = 0;
    const halt: HaltState = { brandCode: "OLL", rule: "kill_switch", since: "2026-10-21T09:00:00.000Z", reason: "hätä", initiator: { source: "ui" } };
    // Clear for the card send, the check before the writes and the ad's ACTIVE; set by the next ACTIVE write.
    const r = await rig({ gate: { haltOf: async () => (++reads <= 3 ? null : halt) } });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("failed");
    expect(row.outcome).toMatchObject({ result: "failed", step: "adset_active", done: ["ad_active", "pause_others"] });
    expect(String((row.outcome as { detail: string }).detail)).toContain("the ad was paused again");
    expect(r.meta.writes.filter((call) => call.path === AD).map((call) => call.body.status)).toEqual(["ACTIVE", "PAUSED"]);
    expect(r.meta.writes.some((call) => call.path === ADSET || call.path === CAMPAIGN)).toBe(false);
  });

  it("a halt seen only after the last write pauses again the campaign, the ad set and the ad", async () => {
    let reads = 0;
    const halt: HaltState = { brandCode: "OLL", rule: "kill_switch", since: "2026-10-21T09:00:00.000Z", reason: "hätä", initiator: { source: "ui" } };
    // The card send, 1 before the writes, 3 ACTIVE writes (ad, ad set, campaign), then the final check.
    const r = await rig({ gate: { haltOf: async () => (++reads <= 5 ? null : halt) } });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "failed", step: "verify_halt" });
    expect(r.meta.writes.filter((call) => call.body.status !== undefined).map((call) => `${call.path}=${call.body.status}`)).toEqual([
      `${AD}=ACTIVE`,
      `${OLD_AD}=PAUSED`,
      `${ADSET}=ACTIVE`,
      `${CAMPAIGN}=ACTIVE`,
      `${CAMPAIGN}=PAUSED`,
      `${ADSET}=PAUSED`,
      `${AD}=PAUSED`,
    ]);
  });

  it("a card close that fails does not stop the kill switch, and the result and the notice say so", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const result = await pauseAll(
      {
        ctx: r.harness.ctx,
        ledger: r.runtime.ledger,
        notifier: r.notifier,
        closeCards: async () => {
          throw new Error("db down");
        },
      },
      COMPANY_A,
      parsedConfig(),
      { dryRun: false, rule: "kill_switch", reason: "hätä", initiator: { source: "ui" }, notify: true },
    );
    expect(result).toMatchObject({ count: 1, cardsError: expect.stringContaining("db down"), closedCardIds: [] });
    expect(result.halt).toBeDefined();
    expect(r.meta.ads.find((ad) => ad.id === OLD_AD)!.status).toBe("PAUSED");
    expect(r.notifier.messages[0]!.text).toContain("Avoimia aktivointikortteja ei voitu sulkea");
    // The halt still refuses the card that stayed open.
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "halted" });
    expect(activeWrites(r.meta)).toEqual([]);
  });
});

describe("the cap pause and the scheduled pause close open cards too", () => {
  it.each([
    ["pause_all_cap", "⛔ Kulutuskatto 90 % ylittyi: kortti mitätöity", "kulutuskatto 90 % ylittyi"],
    ["scheduled_pause", "⛔ Ajastettu pysäytys: kortti mitätöity", "ajastettu pysäytys on päällä"],
  ] as const)("%s: open card, pause, tap: no Meta ACTIVE write; a timed halt refuses new cards until it ends or the board clears it", async (rule, text, refusal) => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const staleButton = r.fake.buttons(sent.messageId)[0]!;
    const before = new Date();
    const result = await runPause(r, rule);
    expect(result.closedCardIds).toEqual([sent.id]);
    expect(result.cardsError).toBeUndefined();
    expect(result.haltError).toBeUndefined();
    expect(r.store.rows.get(sent.id)).toMatchObject({ status: "expired", outcome: { reason: rule } });
    expect(caption(r, sent.messageId)).toContain(text);

    await tap(r, sent.messageId, staleButton);
    expect(lastAnswer(r)).toBe(GATE_TEXT.expired);
    expect(activeWrites(r.meta)).toEqual([]);
    expect(caption(r, sent.messageId)).toContain(text);

    // A timed halt: the next local morning, or the next local month for the cap.
    const halt = (await haltOf(r))!;
    expect(halt).toMatchObject({ rule, brandCode: "OLL", id: expect.any(String) });
    const expectedUntil = rule === "scheduled_pause" ? nextLocalTime(before, "06:00", "Europe/Helsinki") : nextLocalMonthStart(before, "Europe/Helsinki");
    expect(Math.abs(Date.parse(halt.until!) - expectedUntil.getTime())).toBeLessThan(60_000);
    expect(r.notifier.messages[0]!.text).toContain("Pysäytystila päällä");

    // A card sent now says so, and its tap refuses with no Meta write.
    const refused = await r.cards.openActivationCard(publication());
    expect(caption(r, refused.messageId)).toContain("⛔ Pysäytystila päällä");
    await tap(r, refused.messageId);
    expect(r.store.rows.get(refused.id)!.outcome).toMatchObject({ result: "denied", reason: "halted" });
    expect(caption(r, refused.messageId)).toContain(`⛔ Ei aktivoitu: ${refusal}`);
    expect(activeWrites(r.meta)).toEqual([]);

    // The halt ends when its time is up.
    expect(await readHalt(r.harness.ctx, COMPANY_A, new Date(Date.parse(halt.until!) + 1))).toBeNull();

    // A board user may lift it early; then the next card activates.
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, BOARD);
    expect(await haltOf(r)).toBeNull();
    const next = await r.cards.openActivationCard(publication());
    expect(caption(r, next.messageId)).not.toContain("Pysäytystila päällä");
    await tap(r, next.messageId);
    expect(r.store.rows.get(next.id)!.outcome).toMatchObject({ result: "activated" });
  });

  it("a card whose close fails does not stop the others: the rest close and are edited, the result names the failure (RK9-561)", async () => {
    const r = await rig();
    const first = await r.cards.openActivationCard(publication());
    const second = await r.cards.openActivationCard({ ...publication(), publicationId: SWAP_PUBLICATION_ID, adId: OLD_AD, adName: "OLL vanha" });
    const close = r.repo.close.bind(r.repo);
    r.repo.close = async (companyId, id, outcome) => {
      if (id === first.id) throw new Error("row locked");
      return close(companyId, id, outcome);
    };
    const result = await runPause(r, "scheduled_pause");
    expect(result.closedCardIds).toEqual([second.id]);
    expect(result.cardsError).toMatch(new RegExp(`1 card\\(s\\) not closed \\(${first.id}\\): Error: row locked`));
    expect(result.halt).toMatchObject({ rule: "scheduled_pause" });
    expect(r.store.rows.get(second.id)!.status).toBe("expired");
    expect(caption(r, second.messageId)).toContain("⛔ Ajastettu pysäytys");
    expect(r.store.rows.get(first.id)!.status).toBe("pending");
    expect(r.notifier.messages[0]!.text).toContain("Avoimia aktivointikortteja ei voitu sulkea");
    // The card left open still refuses: the halt is in force.
    await tap(r, first.messageId);
    expect(r.store.rows.get(first.id)!.outcome).toMatchObject({ reason: "halted" });
    expect(activeWrites(r.meta)).toEqual([]);
  });

  it("the data gate leaves the cards open", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const result = await runPause(r, "data_gate");
    expect(result.closedCardIds).toEqual([]);
    expect(r.store.rows.get(sent.id)!.status).toBe("pending");
  });
});

describe("a real pause during an approved activation wins (RK9-561)", () => {
  // "before": the pause lists before Meta applies the ad's ACTIVE, so its listing misses it.
  // "after": the pause runs after the campaign's ACTIVE, the last write.
  it.each([
    ["kill_switch", AD, "before"],
    ["kill_switch", CAMPAIGN, "after"],
    ["scheduled_pause", AD, "before"],
    ["scheduled_pause", CAMPAIGN, "after"],
    ["pause_all_cap", AD, "before"],
    ["pause_all_cap", CAMPAIGN, "after"],
  ] as const)("%s during the ACTIVE write of %s (%s): nothing stays ACTIVE and the card fails", async (rule, objectId, when) => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    let pause: PauseAllResult | null = null;
    const fired = pauseDuringWrite(r, objectId, when, async () => {
      pause = await runPause(r, rule);
    });
    await tap(r, sent.messageId);
    expect(fired()).toBe(true);
    expect(pause!).toMatchObject({ halt: { rule } });
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "failed", step: when === "before" ? "adset_active" : "verify_halt" });
    for (const id of [AD, OLD_AD, ADSET, CAMPAIGN]) expect(statusOf(r.meta, id)).toBe("PAUSED");
    expect(await haltOf(r)).toMatchObject({ rule });
  });
});

describe("an undo that Meta refuses after a pause won (RK9-565)", () => {
  /** The pause lists before Meta applies the ad's ACTIVE, so only the handler's undo can stop the ad; Meta then refuses that PAUSED write. */
  async function lostUndo(r: Rig, rule: PauseRule = "kill_switch") {
    let refuse = true;
    r.meta.fail = (call) => (refuse && call.method === "POST" && call.path === AD && call.body.status === "PAUSED" ? new Response(JSON.stringify({ error: { message: "rate limited", code: 17 } }), { status: 400 }) : null);
    const sent = await r.cards.openActivationCard(publication());
    pauseDuringWrite(r, AD, "before", () => runPause(r, rule));
    await tap(r, sent.messageId);
    return { sent, allow: () => (refuse = false) };
  }

  it("alerts once, marks the card failed and pauses the ad on the next tick", async () => {
    const r = await rig();
    const { sent, allow } = await lostUndo(r);
    expect(statusOf(r.meta, AD)).toBe("ACTIVE");
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("failed");
    expect(row.outcome).toMatchObject({
      result: "failed",
      step: "adset_active",
      undoFailed: [{ kind: "ad", objectId: AD }],
      undoRetry: { stored: true, telegram: "sent" },
    });
    expect(caption(r, sent.messageId)).toContain(`Peruutus epäonnistui, voi olla yhä ACTIVE: ${AD}`);
    expect(caption(r, sent.messageId)).toContain("yritetään uudelleen 5 minuutin välein");
    const alerts = () => r.notifier.messages.filter((message) => message.text.includes("aktivoinnin peruutus epäonnistui"));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.text).toContain(`mainos ${AD}`);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, kind: "ad", gateRequestId: sent.id, haltRule: "kill_switch" }]);

    // Meta still refuses: the run fails, the ad stays listed, no second alert.
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(new RegExp(`activation undo: pausing ad ${AD} failed again`));
    expect(alerts()).toHaveLength(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);

    allow();
    await r.harness.runJob("scheduled-pause");
    expect(statusOf(r.meta, AD)).toBe("PAUSED");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    const writes = r.meta.writes.length;
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(writes);
  });

  it("a scheduled halt that ends at 06:00 with no newer activation keeps the retry: the next tick writes PAUSED", async () => {
    const r = await rig();
    const { allow } = await lostUndo(r, "scheduled_pause");
    // 06:00 passed: the stored scheduled halt is no longer in force.
    const key = { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `halt:${COMPANY_A}:scheduled_pause` };
    const stored = (await r.harness.ctx.state.get(key)) as HaltState;
    await r.harness.ctx.state.set(key, { ...stored, until: new Date(Date.now() - 60_000).toISOString() });
    expect(await haltOf(r)).toBeNull();
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(new RegExp(`activation undo: pausing ad ${AD} failed again`));
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
    allow();
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes.at(-1)).toMatchObject({ path: AD, body: { status: "PAUSED" } });
    expect(statusOf(r.meta, AD)).toBe("PAUSED");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });

  /** A board user clears the halt from the preview; the undo stays open. */
  async function clearHaltAsBoard(r: Rig) {
    const preview = await r.harness.performAction<{ halt: HaltState }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: preview.halt.since }, BOARD);
    expect(await haltOf(r)).toBeNull();
  }

  /** A newer card of the same publication, approved now, with `outcome`. */
  function newerCard(r: Rig, failedId: string, id: string, outcome: Record<string, unknown> | null) {
    const failed = r.store.rows.get(failedId)!;
    r.store.rows.set(id, { ...failed, id, status: "approved", outcome, decidedAt: new Date(Date.now() + 1_000) });
  }

  it("after the halt ends, a newer approved activation of the ad ends the retry with an audit row and one alert, and pauses nothing", async () => {
    const r = await rig();
    const { sent } = await lostUndo(r);
    await clearHaltAsBoard(r);
    newerCard(r, sent.id, "gate-newer", { handler: "done", result: "activated" });
    const writes = r.meta.writes.length;
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(writes);
    expect(statusOf(r.meta, AD)).toBe("ACTIVE");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    const dropped = r.notifier.messages.filter((message) => message.text.includes("uudelleenyritys lopetettiin, koska uudempi aktivointi hyväksyttiin"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.text).toContain(`mainos ${AD}`);
    // The audit row's activity entry (the harness has no rule_actions table).
    expect(r.harness.activity.filter((entry) => entry.message.includes(`activation undo of ad ${AD} ended: superseded by gate-newer`))).toMatchObject([
      { metadata: { applied: false, gateRequestId: sent.id, supersededBy: "gate-newer" } },
    ]);
  });

  it("while a halt is in force, a newer activation does not end the retry: the tick pauses", async () => {
    const r = await rig();
    const { sent, allow } = await lostUndo(r);
    newerCard(r, sent.id, "gate-newer", { handler: "done", result: "activated" });
    allow();
    await r.harness.runJob("scheduled-pause");
    expect(statusOf(r.meta, AD)).toBe("PAUSED");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    expect(r.notifier.messages.some((message) => message.text.includes("uudelleenyritys lopetettiin"))).toBe(false);
  });

  it("a newer-activation lookup that fails pauses anyway and fails the run", async () => {
    const r = await rig();
    const { allow } = await lostUndo(r);
    await clearHaltAsBoard(r);
    r.repo.newerActivation = async () => {
      throw new Error("statement timeout");
    };
    allow();
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(/newer activations of ad .* not read \(Error: statement timeout\), pausing anyway/);
    expect(statusOf(r.meta, AD)).toBe("PAUSED");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });

  it("a newer card still activating leaves the entry alone; once it activated, the entry is dropped", async () => {
    const r = await rig();
    const { sent, allow } = await lostUndo(r);
    await clearHaltAsBoard(r);
    newerCard(r, sent.id, "gate-newer", { handler: "started" });
    allow();
    const writes = r.meta.writes.length;
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(writes);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
    r.store.rows.get("gate-newer")!.outcome = { handler: "done", result: "activated" };
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(writes);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });

  it("a newer activation of another ad does not end the retry", async () => {
    const r = await rig();
    const { sent, allow } = await lostUndo(r);
    await clearHaltAsBoard(r);
    const failed = r.store.rows.get(sent.id)!;
    const payload = failed.payload as { activation: Record<string, unknown> };
    r.store.rows.set("gate-other", {
      ...failed,
      id: "gate-other",
      status: "approved",
      outcome: { handler: "done", result: "activated" },
      decidedAt: new Date(Date.now() + 1_000),
      payload: { ...payload, activation: { ...payload.activation, adId: OLD_AD, adsetId: "other-adset", campaignId: "other-campaign", publicationId: "other-publication" } },
    });
    allow();
    await r.harness.runJob("scheduled-pause");
    expect(statusOf(r.meta, AD)).toBe("PAUSED");
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });

  it("a company whose config was removed with an undo open fails the run and names the objects", async () => {
    const r = await rig();
    await lostUndo(r);
    useCompanyConfigs(r.harness, { [COMPANY_A]: {} });
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(new RegExp(`1 activation undo\\(s\\) or pause retry\\(ies\\) open \\(ad ${AD}\\) but no brand config to retry them`));
  });

  it("clearing the halt alone keeps the retry; the board's acknowledgement of the previewed entries ends it", async () => {
    const r = await rig();
    const { sent } = await lostUndo(r);
    const preview = await r.harness.performAction<{ halt: HaltState; pendingUndo?: Array<{ objectId: string; key: string }> }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    const since = (await readPendingUndos(r.harness.ctx, COMPANY_A))[0]!.since;
    expect(preview.pendingUndo).toMatchObject([{ objectId: AD, key: `${AD}|${sent.id}|${since}` }]);
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: preview.halt.since }, BOARD);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
    await expect(r.harness.runJob("scheduled-pause")).rejects.toThrow(new RegExp(`activation undo: pausing ad ${AD} failed again`));

    // An agent may not acknowledge.
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, acknowledgeUndos: [`${AD}|${sent.id}|${since}`] }, AGENT)).rejects.toThrow(/board-only/);
    const result = await r.harness.performAction<{ acknowledgedUndos?: number }>(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, acknowledgeUndos: [`${AD}|${sent.id}|${since}`, "unknown|key"] }, BOARD);
    expect(result).toMatchObject({ cleared: false, acknowledgedUndos: 1 });
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    expect(r.harness.activity.filter((entry) => entry.message === UNDO_ACKNOWLEDGED_ACTIVITY)).toMatchObject([
      { metadata: { acknowledged: [{ objectId: AD, gateRequestId: sent.id }], acknowledgedBy: { userId: expect.any(String) } } },
    ]);
    const writes = r.meta.writes.length;
    await r.harness.runJob("scheduled-pause");
    expect(r.meta.writes).toHaveLength(writes);
  });

  it("concurrent writes of the list keep every entry", async () => {
    const r = await rig();
    const entry = (objectId: string): PendingUndo => ({ objectId, kind: "ad", gateRequestId: `gate-${objectId}`, brandCode: "OLL", haltRule: "kill_switch", since: "2026-10-21T09:00:00.000Z", error: "x" });
    // A slow state store widens the read-modify-write window.
    const state = r.harness.ctx.state;
    const get = state.get.bind(state);
    state.get = async (input) => {
      const value = await get(input);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    };
    await Promise.all(["1", "2", "3"].map((id) => addPendingUndos(r.harness.ctx, COMPANY_A, [entry(id)])));
    expect((await readPendingUndos(r.harness.ctx, COMPANY_A)).map((undo) => undo.objectId).sort()).toEqual(["1", "2", "3"]);
  });

  it("the tick removes only what it handled: a newer failure of the same object stays", async () => {
    const r = await rig();
    const { allow } = await lostUndo(r);
    allow();
    // While the tick pauses the ad, another card's undo of the same ad fails and replaces the entry.
    const fetch = r.harness.ctx.http.fetch;
    r.harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      if (init?.method === "POST" && new URL(url).pathname.endsWith(`/${AD}`)) {
        r.harness.ctx.http.fetch = fetch;
        await addPendingUndos(r.harness.ctx, COMPANY_A, [
          { objectId: AD, kind: "ad", gateRequestId: "gate-newer", brandCode: "OLL", haltRule: "kill_switch", since: new Date().toISOString(), error: "x" },
        ]);
      }
      return response;
    };
    await r.harness.runJob("scheduled-pause");
    expect((await readPendingUndos(r.harness.ctx, COMPANY_A)).map((undo) => undo.gateRequestId)).toEqual(["gate-newer"]);
  });

  it("an undo that cannot be stored alerts to pause by hand, not a retry", async () => {
    const r = await rig();
    const state = r.harness.ctx.state;
    const set = state.set.bind(state);
    state.set = async (input, value) => {
      if (input.stateKey.startsWith("pending-undo:")) throw new Error("state down");
      return set(input, value);
    };
    const report = await reportUndoFailure({ ctx: r.harness.ctx, store: r.once, notifier: r.notifier }, COMPANY_A, parsedConfig(), {
      gateRequestId: "gate-1",
      haltRule: "kill_switch",
      failed: [{ kind: "campaign", objectId: CAMPAIGN, error: "rate limited" }],
    }, new Date());
    expect(report).toMatchObject({ stored: false, telegram: "sent", error: expect.stringContaining("state down") });
    expect(r.notifier.messages.at(-1)!.text).toContain("Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa.");
    expect(r.notifier.messages.at(-1)!.text).not.toContain("yritetään uudelleen");
  });

  it("an ad that was ACTIVE before the run is not this run's: the undo leaves it ACTIVE", async () => {
    const meta = freshMeta();
    meta.ads.find((ad) => ad.id === AD)!.status = "ACTIVE";
    let reads = 0;
    const halt: HaltState = { brandCode: "OLL", rule: "kill_switch", since: "2026-10-21T09:00:00.000Z", reason: "hätä", initiator: { source: "ui" } };
    // The card send, 1 before the writes, 2 ACTIVE writes (ad set, campaign), then the final check.
    const r = await rig({ meta, gate: { haltOf: async () => (++reads <= 4 ? null : halt) } });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "failed", step: "verify_halt", done: ["pause_others", "adset_active", "campaign_active", "verify_creative"] });
    expect(r.meta.writes.filter((call) => call.body.status !== undefined).map((call) => `${call.path}=${call.body.status}`)).toEqual([
      `${OLD_AD}=PAUSED`,
      `${ADSET}=ACTIVE`,
      `${CAMPAIGN}=ACTIVE`,
      `${CAMPAIGN}=PAUSED`,
      `${ADSET}=PAUSED`,
    ]);
    expect(statusOf(r.meta, AD)).toBe("ACTIVE");
  });
});

describe("clearing the halt is board-only", () => {
  it("an agent may preview but not clear; a board user clears and a new card activates", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);

    const data = await r.harness.performAction<{ halt: HaltState | null }>(SPEND_GUARD_ACTION_KEY, {}, AGENT);
    expect(data.halt).toMatchObject({ brandCode: "OLL", reason: "hätä" });

    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true }, AGENT)).rejects.toThrow(/board-only/);
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, {}, AGENT)).toMatchObject({ dryRun: true, cleared: false, halt: { reason: "hätä" } });
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false }, BOARD)).rejects.toThrow(/confirm/);
    expect(await haltOf(r)).not.toBeNull();

    const refused = await r.cards.openActivationCard(publication());
    await tap(r, refused.messageId);
    expect(r.store.rows.get(refused.id)!.outcome).toMatchObject({ reason: "halted" });
    expect(activeWrites(r.meta)).toEqual([]);

    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: data.halt!.since, reason: "tarkistettu" }, BOARD)).toMatchObject({
      dryRun: false,
      cleared: true,
    });
    expect(await haltOf(r)).toBeNull();
    expect(r.harness.activity.find((entry) => entry.message === HALT_CLEARED_ACTIVITY)).toMatchObject({
      metadata: { clearedBy: { userId: "board-1" }, reason: "tarkistettu" },
    });
    expect((await r.harness.performAction<{ halt: HaltState | null }>(SPEND_GUARD_ACTION_KEY, {}, BOARD)).halt).toBeNull();

    const next = await r.cards.openActivationCard(publication());
    await tap(r, next.messageId);
    expect(r.store.rows.get(next.id)!.outcome).toMatchObject({ result: "activated" });
    expect(activeWrites(r.meta).map((call) => call.path)).toContain(AD);
  });

  it("the pause-ad halt of one ad: an agent previews, a board user clears it by its id, then the ad activates (RK9-566)", async () => {
    const r = await rig();
    const first = newAdHalt({ brandCode: "OLL", adId: AD, reason: "UI", initiator: { source: "ui", userId: "board-1" }, now: new Date() });
    await setAdHalt(r.harness.ctx, COMPANY_A, first);
    // The company's halt is not set: the page's banner stays clear.
    expect(await haltOf(r)).toBeNull();

    const preview = await r.harness.performAction<{ adHalt: AdHaltState | null }>(CLEAR_HALT_ACTION_KEY, { adId: AD }, AGENT);
    expect(preview.adHalt).toMatchObject({ id: first.id, adId: AD });
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, adId: AD, id: first.id }, AGENT)).rejects.toThrow(/board-only/);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, adId: AD }, BOARD)).rejects.toThrow(/needs `id`/);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { adId: "act_1" }, BOARD)).rejects.toThrow(/digits only/);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, adId: AD, id: first.id, acknowledgeUndos: ["x"] }, BOARD)).rejects.toThrow(/without adId/);
    // Another company's call does not see the halt.
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { adId: AD }, { ...BOARD, companyId: "other-company" })).toMatchObject({ adHalt: null });

    // A newer pause of the ad between the preview and the clear stays.
    const second = newAdHalt({ brandCode: "OLL", adId: AD, reason: "UI 2", initiator: { source: "ui", userId: "board-1" }, now: new Date() });
    await setAdHalt(r.harness.ctx, COMPANY_A, second);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, adId: AD, id: first.id }, BOARD)).rejects.toThrow(/newer pause of the ad/);
    expect(await readAdHalt(r.harness.ctx, COMPANY_A, AD)).toMatchObject({ id: second.id });

    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, adId: AD, id: second.id, reason: "ok" }, BOARD)).toMatchObject({ cleared: true });
    expect(await readAdHalt(r.harness.ctx, COMPANY_A, AD)).toBeNull();
    expect(r.harness.activity.find((entry) => entry.message === HALT_CLEARED_ACTIVITY)).toMatchObject({ metadata: { adHalt: { id: second.id }, clearedBy: { userId: "board-1" } } });
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, adId: AD, id: second.id }, BOARD)).toMatchObject({ cleared: false });

    const next = await r.cards.openActivationCard(publication());
    await tap(r, next.messageId);
    expect(r.store.rows.get(next.id)!.outcome).toMatchObject({ result: "activated" });
  });

  it("reads every halt as of the activation's start, or of now when the clock stepped back (RK9-567)", async () => {
    const start = Date.now();
    let steppedBack = false;
    const seen: Array<{ since: number | undefined }> = [];
    const r = await rig({
      gate: {
        // The handler's own clock: its first reading is its start, every later one a minute earlier (an NTP step).
        now: () => new Date(steppedBack ? start - 60_000 : start),
        haltOf: async (_companyId, since) => {
          seen.push({ since: since?.getTime() });
          steppedBack = true;
          return null;
        },
      },
    });
    const sent = await r.cards.openActivationCard(publication());
    steppedBack = false;
    await tap(r, sent.messageId);
    const reads = seen.slice(-3);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((read) => read.since === start - 60_000)).toBe(true);
  });

  it("a damaged pause-ad halt record still refuses", async () => {
    const r = await rig();
    await r.harness.ctx.state.set({ scopeKind: "instance", namespace: HALT_NAMESPACE, stateKey: `halt:${COMPANY_A}:ad:${AD}` }, "garbage");
    expect(await readAdHalt(r.harness.ctx, COMPANY_A, AD)).toMatchObject({ reason: "unreadable halt record" });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "denied", reason: "halted" });
    expect(activeWrites(r.meta)).toEqual([]);
  });

  it("a clear refuses when a newer kill switch set the halt after the preview", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "eka" }, BOARD);
    const preview = await r.harness.performAction<{ halt: HaltState }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    await setHalt(r.harness.ctx, COMPANY_A, { ...preview.halt, since: "2099-01-01T00:00:00.000Z", reason: "toka" });
    await expect(
      r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: preview.halt.since }, BOARD),
    ).rejects.toThrow(/newer kill switch/);
    expect(await haltOf(r)).toMatchObject({ reason: "toka" });
  });

  it("a kill switch between the preview and the clear stays: the clear lifts only the halt it named", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "eka" }, BOARD);
    const preview = await r.harness.performAction<{ halt: HaltState }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    // The clear reads the halt the preview named, then a kill switch stores a new one before the clear's write.
    const state = r.harness.ctx.state;
    const set = state.set.bind(state);
    state.set = async (input, value) => {
      if (input.stateKey.startsWith("halt-cleared:")) {
        await setHalt(r.harness.ctx, COMPANY_A, { ...preview.halt, id: "newer-halt", since: "2099-01-01T00:00:00.000Z", reason: "toka" });
      }
      return set(input, value);
    };
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: preview.halt.since }, BOARD)).toMatchObject({
      cleared: true,
      halt: { reason: "eka" },
      remaining: { reason: "toka" },
    });
    expect(await haltOf(r)).toMatchObject({ reason: "toka" });
  });

  it("a real clear needs `since`, and a system actor may not clear", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true }, BOARD)).rejects.toThrow(/needs `since`/);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: "" }, BOARD)).rejects.toThrow(/needs `since`/);
    const halt = (await haltOf(r))!;
    await expect(
      r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, { companyId: COMPANY_A, actor: { type: "system" } }),
    ).rejects.toThrow(/board-only/);
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, { companyId: COMPANY_A })).rejects.toThrow(/board-only/);
    expect(await haltOf(r)).toMatchObject({ reason: "hätä" });
    expect(r.harness.activity.some((entry) => entry.message === HALT_CLEARED_ACTIVITY)).toBe(false);
  });

  it("another company neither sees nor clears the halt", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
    const halt = (await haltOf(r))!;
    const boardB = { companyId: COMPANY_B, actor: { type: "user" as const, userId: "board-b" } };
    expect((await r.harness.performAction<{ halt: HaltState | null }>(SPEND_GUARD_ACTION_KEY, {}, boardB)).halt).toBeNull();
    // The company comes from the host context, not from params (RK9-603).
    expect((await r.harness.performAction<{ halt: HaltState | null }>(SPEND_GUARD_ACTION_KEY, { companyId: COMPANY_A }, boardB)).halt).toBeNull();
    await expect(r.harness.performAction(SPEND_GUARD_ACTION_KEY, {}, { actor: boardB.actor })).rejects.toThrow("company context is required");
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, {}, boardB)).toMatchObject({ dryRun: true, halt: null });
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: halt.since }, boardB)).toEqual({
      dryRun: false,
      cleared: false,
      halt: null,
    });
    expect(await haltOf(r)).toMatchObject({ since: halt.since, reason: "hätä" });
    // And the cleared marker of company B does not touch company A.
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "halted" });
  });

  it("a clear without a halt changes nothing", async () => {
    const r = await rig();
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: "2026-10-21T09:00:00.000Z" }, BOARD)).toEqual({
      dryRun: false,
      cleared: false,
      halt: null,
    });
    expect(r.harness.activity.some((entry) => entry.message === HALT_CLEARED_ACTIVITY)).toBe(false);
  });

  it("a damaged halt record can be cleared by a board user with its `since`; a later damaged record still halts", async () => {
    const r = await rig();
    await setHalt(r.harness.ctx, COMPANY_A, { broken: true } as unknown as HaltState);
    const preview = await r.harness.performAction<{ halt: HaltState }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    expect(preview.halt).toMatchObject({ since: "?" });
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: preview.halt.since }, BOARD);
    expect(await haltOf(r)).toBeNull();
    await setHalt(r.harness.ctx, COMPANY_A, { broken: "again" } as unknown as HaltState);
    expect(await haltOf(r)).toMatchObject({ reason: "unreadable halt record" });
  });

  it("a halt stored before RK9-561 (no id) is cleared by its `since`", async () => {
    const r = await rig();
    const legacy = { brandCode: "OLL", rule: "kill_switch", since: "2026-10-17T08:00:00.000Z", reason: "vanha", initiator: { source: "ui" } } as HaltState;
    await setHalt(r.harness.ctx, COMPANY_A, legacy);
    expect(await haltOf(r)).toMatchObject({ since: legacy.since, reason: "vanha" });
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: legacy.since }, BOARD)).toMatchObject({ cleared: true });
    expect(await haltOf(r)).toBeNull();
  });

  it("the kill switch's halt comes first; clearing it leaves the scheduled pause's halt in force", async () => {
    const r = await rig();
    await runPause(r, "scheduled_pause");
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);
    const first = (await haltOf(r))!;
    expect(first).toMatchObject({ rule: "kill_switch" });
    const cleared = await r.harness.performAction<{ cleared: boolean; remaining?: HaltState }>(
      CLEAR_HALT_ACTION_KEY,
      { dryRun: false, confirm: true, since: first.since },
      BOARD,
    );
    expect(cleared).toMatchObject({ cleared: true, remaining: { rule: "scheduled_pause" } });
    expect(await haltOf(r)).toMatchObject({ rule: "scheduled_pause", until: expect.any(String) });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "halted" });
    expect(activeWrites(r.meta)).toEqual([]);
  });

  it("two damaged records that share their first 500 characters are two halts (RK9-565)", async () => {
    const r = await rig();
    const head = "x".repeat(600);
    await setHalt(r.harness.ctx, COMPANY_A, { broken: `${head}-first` } as unknown as HaltState);
    const preview = await r.harness.performAction<{ halt: HaltState }>(CLEAR_HALT_ACTION_KEY, {}, BOARD);
    await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, since: preview.halt.since }, BOARD);
    expect(await haltOf(r)).toBeNull();
    await setHalt(r.harness.ctx, COMPANY_A, { broken: `${head}-second` } as unknown as HaltState);
    expect(await haltOf(r)).toMatchObject({ reason: "unreadable halt record" });
  });

  it("a damaged halt record still refuses", async () => {
    const r = await rig();
    await setHalt(r.harness.ctx, COMPANY_A, { broken: true } as unknown as HaltState);
    expect(await haltOf(r)).toMatchObject({ reason: "unreadable halt record" });
  });
});

describe("the approval is bound to the publication's contentHash (RK9-517 verifier, Low)", () => {
  it("denies when the publication that owns the ad has other content", async () => {
    const r = await rig();
    r.publications.rows[0]!.contentHash = "d".repeat(64);
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "denied", reason: "content_changed" });
    expect(caption(r, sent.messageId)).toContain("julkaisu tai sisältö on vaihtunut");
    expect(r.meta.writes).toEqual([]);
  });

  it("denies when a later publication (a swap) owns the ad, even with the same Meta creative", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    r.publications.rows.push(publicationRow({ id: SWAP_PUBLICATION_ID, idempotencyKey: "swap", mode: "swap", status: "swapped", contentHash: "e".repeat(64) }));
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "content_changed" });
    expect(r.meta.writes).toEqual([]);
  });

  it("denies when no publication owns the ad", async () => {
    const r = await rig();
    r.publications.rows.splice(0);
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "content_changed" });
    expect(r.meta.writes).toEqual([]);
  });
});
