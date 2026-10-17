/**
 * A pause beats an open activation card (RK9-557, RK9-517 verifier): the
 * kill switch, the 90 % cap pause and the scheduled pause close the brand's
 * open activate_ad cards, and the kill switch leaves a standing halt that
 * refuses every activation until a board user clears it. The approval is
 * also bound to the publication's contentHash. The Telegram controller is
 * the real one on a fake Bot API; Meta is a routing fake.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createLedger } from "../src/db.js";
import { registerGate, type GateOverrides } from "../src/features/gate/register.js";
import { readHalt, setHalt, type HaltState } from "../src/features/spend-guard/halt.js";
import { pauseAll, type PauseAllResult, type PauseRule } from "../src/features/spend-guard/killswitch.js";
import { CLEAR_HALT_ACTION_KEY, HALT_CLEARED_ACTIVITY, PAUSE_ALL_ACTION_KEY, registerSpendGuard, SPEND_GUARD_DATA_KEY } from "../src/features/spend-guard/register.js";
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
import { brandConfig, COMPANY_A, SECRET_A_BOT, SECRET_A_META, secretRef } from "./fixtures.js";
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
  registerSpendGuard(runtime, { store: memoryOnceStore(), notifier });
  const publications = memoryPublicationStore();
  publications.rows.push(publicationRow());
  const { cards } = registerGate(runtime, {
    store,
    repo,
    publications,
    transport: () => controller,
    assertLaunchReady: async () => undefined,
    ...input.gate,
  });
  await controller.replan();
  await waitFor(() => controller.summary()[0]?.loop === "running");
  const out = { harness, runtime, meta, fake, store, controller, cards, notifier, publications };
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
    // Clear for the check before the writes and for the ad's ACTIVE; set by the next ACTIVE write.
    const r = await rig({ gate: { haltOf: async () => (++reads <= 2 ? null : halt) } });
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
    // 1 before the writes, 3 ACTIVE writes (ad, ad set, campaign), then the final check.
    const r = await rig({ gate: { haltOf: async () => (++reads <= 4 ? null : halt) } });
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
    ["pause_all_cap", "⛔ Kulutuskatto 90 % ylittyi: kortti mitätöity"],
    ["scheduled_pause", "⛔ Ajastettu pysäytys: kortti mitätöity"],
  ] as const)("%s: open card, pause, tap: no Meta ACTIVE write and the card names the reason; no halt", async (rule, text) => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const staleButton = r.fake.buttons(sent.messageId)[0]!;
    const result = await runPause(r, rule);
    expect(result.closedCardIds).toEqual([sent.id]);
    expect(result.cardsError).toBeUndefined();
    expect(result.halt).toBeUndefined();
    expect(r.store.rows.get(sent.id)).toMatchObject({ status: "expired", outcome: { reason: rule } });
    expect(caption(r, sent.messageId)).toContain(text);

    await tap(r, sent.messageId, staleButton);
    expect(lastAnswer(r)).toBe(GATE_TEXT.expired);
    expect(activeWrites(r.meta)).toEqual([]);
    expect(caption(r, sent.messageId)).toContain(text);

    // Not a standing halt: the next card activates.
    expect(await haltOf(r)).toBeNull();
    const next = await r.cards.openActivationCard(publication());
    await tap(r, next.messageId);
    expect(r.store.rows.get(next.id)!.outcome).toMatchObject({ result: "activated" });
  });

  it("the data gate leaves the cards open", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const result = await runPause(r, "data_gate");
    expect(result.closedCardIds).toEqual([]);
    expect(r.store.rows.get(sent.id)!.status).toBe("pending");
  });
});

describe("clearing the halt is board-only", () => {
  it("an agent may preview but not clear; a board user clears and a new card activates", async () => {
    const r = await rig();
    await r.harness.performAction(PAUSE_ALL_ACTION_KEY, { dryRun: false, confirm: true, reason: "hätä" }, BOARD);

    const data = await r.harness.getData<{ halt: HaltState | null }>(SPEND_GUARD_DATA_KEY, { companyId: COMPANY_A });
    expect(data.halt).toMatchObject({ brandCode: "OLL", reason: "hätä" });

    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true }, AGENT)).rejects.toThrow(/board-only/);
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, {}, AGENT)).toMatchObject({ dryRun: true, cleared: false, halt: { reason: "hätä" } });
    await expect(r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false }, BOARD)).rejects.toThrow(/confirm/);
    expect(await haltOf(r)).not.toBeNull();

    const refused = await r.cards.openActivationCard(publication());
    await tap(r, refused.messageId);
    expect(r.store.rows.get(refused.id)!.outcome).toMatchObject({ reason: "halted" });
    expect(activeWrites(r.meta)).toEqual([]);

    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true, reason: "tarkistettu" }, BOARD)).toMatchObject({
      dryRun: false,
      cleared: true,
    });
    expect(await haltOf(r)).toBeNull();
    expect(r.harness.activity.find((entry) => entry.message === HALT_CLEARED_ACTIVITY)).toMatchObject({
      metadata: { clearedBy: { userId: "board-1" }, reason: "tarkistettu" },
    });
    expect((await r.harness.getData<{ halt: HaltState | null }>(SPEND_GUARD_DATA_KEY, { companyId: COMPANY_A })).halt).toBeNull();

    const next = await r.cards.openActivationCard(publication());
    await tap(r, next.messageId);
    expect(r.store.rows.get(next.id)!.outcome).toMatchObject({ result: "activated" });
    expect(activeWrites(r.meta).map((call) => call.path)).toContain(AD);
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

  it("a clear without a halt changes nothing", async () => {
    const r = await rig();
    expect(await r.harness.performAction(CLEAR_HALT_ACTION_KEY, { dryRun: false, confirm: true }, BOARD)).toEqual({ dryRun: false, cleared: false, halt: null });
    expect(r.harness.activity.some((entry) => entry.message === HALT_CLEARED_ACTIVITY)).toBe(false);
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
