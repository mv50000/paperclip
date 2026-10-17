/**
 * Activation gate (A9, RK9-517): card after publish, one tap -> spend guard
 * -> newest-wins activation. The Telegram controller is the real one on a
 * fake Bot API; Meta is a routing fake; every activation write goes through
 * the real spend guard hook. No real chat, no real ad account.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createLedger } from "../src/db.js";
import { registerGate, type GateOverrides } from "../src/features/gate/register.js";
import { PAUSE_AD_ACTION_KEY, registerUi } from "../src/features/ui/register.js";
import type { UiPauseAdResult } from "../src/features/ui/dto.js";
import { getActivationCards, setActivationCards } from "../src/features/gate/runtime.js";
import { TelegramController } from "../src/features/telegram/controller.js";
import { gateRegistry, resetGateRegistry } from "../src/features/telegram/gates.js";
import type { FeatureRuntime } from "../src/features/types.js";
import { AD_PAUSE_CLOSE_TEXT, AD_PAUSE_FAILED_CLOSE_TEXT, stagingCardText, type StagingCards } from "../src/gate/staging-card.js";
import { newAdHalt, readAdHalt, setAdHalt } from "../src/features/spend-guard/halt.js";
import { GATE_TEXT } from "../src/kit/gate/callback-router.js";
import { createMemoryGateStore, type MemoryGateStore } from "../src/kit/testing/memory-gate-store.js";
import { recordedOutput, useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { telegramBotKey } from "../src/kit/telegram/bot-api.js";
import type { PublishedPublication } from "../src/publish/handoff.js";
import { memoryPublicationStore } from "../src/publish/store.js";
import type { PublicationRecord } from "../src/publish/types.js";
import { brandConfig, COMPANY_A, SECRET_A_BOT, SECRET_A_META, secretRef } from "./fixtures.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";
import { memoryActivationRepo } from "./gate/memory-repo.js";
import { FakeMeta } from "./spend-guard/fake-meta.js";

const META_TOKEN = "EAAtest-meta-token-gate-0000000000000";
const BOT_TOKEN = "1234567:AAE-gate-test-fake-bot-token-0123456789";
const BOT = telegramBotKey(BOT_TOKEN);
const CHAT = "-100777";
const APPROVER = 4242;
const STRANGER = 9999;
const PUBLICATION_ID = "dddddddd-0000-4000-8000-000000000001";
const CAMPAIGN = "120200000000000101";
const ADSET = "120200000000000201";
const AD = "120200000000000301";
const OLD_AD = "120200000000000302";
const CREATIVE = "120200000000000401";
const OTHER_CREATIVE = "120200000000000402";

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function telegramBlock(overrides: Record<string, unknown> = {}) {
  return { botTokenRef: secretRef(SECRET_A_BOT), chatId: CHAT, allowedUserIds: [String(APPROVER)], mode: "poll", ...overrides };
}

/** A fresh account: campaign, ad set and the new ad PAUSED, an older ad ACTIVE in the same ad set. */
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

function publication(overrides: Partial<PublishedPublication> = {}): PublishedPublication {
  return {
    publicationId: PUBLICATION_ID,
    companyId: COMPANY_A,
    brandCode: "OLL",
    adName: "OLL syksy 1",
    adId: AD,
    adsetId: ADSET,
    campaignId: CAMPAIGN,
    creativeId: CREATIVE,
    contentHash: "c".repeat(64),
    finalUrl: "https://www.ololla.fi/?utm_source=meta",
    publishedAt: "2026-10-21T09:00:00.000Z",
    preview: { kind: "image", mediaUrl: "https://media.ololla.fi/syksy.jpg", posterUrl: null, copy: { message: "Syksyn parhaat kohteet", title: "Ololla" } },
    ...overrides,
  };
}

interface Rig {
  harness: TestHarness;
  runtime: FeatureRuntime;
  meta: FakeMeta;
  fake: FakeTelegram;
  store: MemoryGateStore;
  repo: ReturnType<typeof memoryActivationRepo>;
  controller: TelegramController;
  cards: StagingCards;
  clock: { now: Date };
  preflights: string[];
  publications: ReturnType<typeof memoryPublicationStore>;
}

/** The publication row that owns AD, as the publish service leaves it. */
function publicationRow(overrides: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: PUBLICATION_ID,
    companyId: COMPANY_A,
    brandCode: "OLL",
    creativeId: null,
    idempotencyKey: "oll-syksy-1",
    contentHash: "c".repeat(64),
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

const rigs: Rig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.controller.stop()));
});

async function rig(input: { config?: Record<string, unknown>; meta?: FakeMeta; overrides?: GateOverrides } = {}): Promise<Rig> {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY_A, name: "Ololla" } as Company] });
  useCompanyConfigs(harness, { [COMPANY_A]: input.config ?? brandConfig({ telegram: telegramBlock() }) });
  useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: META_TOKEN, [SECRET_A_BOT]: BOT_TOKEN } });
  const meta = input.meta ?? freshMeta();
  const fake = new FakeTelegram();
  fake.maxWaitMs = 200;
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    return fake.fetch(url, init);
  };
  // Real time: the router reads the memory store's clock, which the tests move forward.
  const clock = { now: new Date() };
  const store = createMemoryGateStore(() => clock.now);
  const repo = memoryActivationRepo(store, () => clock.now);
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
  const preflights: string[] = [];
  const publications = memoryPublicationStore();
  publications.rows.push(publicationRow());
  const { cards } = registerGate(runtime, {
    store,
    repo,
    publications,
    transport: () => controller,
    assertLaunchReady: async (companyId) => {
      preflights.push(companyId);
    },
    now: () => clock.now,
    ...input.overrides,
  });
  await controller.replan();
  const config = input.config ?? brandConfig({ telegram: telegramBlock() });
  if (config.telegram) await waitFor(() => controller.summary()[0]?.loop === "running");
  const out = { harness, runtime, meta, fake, store, repo, controller, cards, clock, preflights, publications };
  rigs.push(out);
  return out;
}

function statusWrites(meta: FakeMeta, status?: string) {
  return meta.writes.filter((call) => call.body.status !== undefined && (status === undefined || call.body.status === status));
}

async function tap(r: Rig, messageId: number, button: 0 | 1, fromId = APPROVER): Promise<void> {
  const before = r.fake.callsOf("answerCallbackQuery").length;
  r.fake.tap(BOT, { messageId, data: r.fake.buttons(messageId)[button]!, fromId });
  await waitFor(() => r.fake.callsOf("answerCallbackQuery").length > before);
  await r.controller.idle();
}

function lastAnswer(r: Rig): string {
  return String(r.fake.callsOf("answerCallbackQuery").at(-1)!.params.text);
}

function caption(r: Rig, messageId: number): string {
  const message = r.fake.messages.get(messageId);
  return String(message?.caption ?? message?.text ?? "");
}

describe("staging card after publish", () => {
  it("posts a photo card with the copy, ad name, ad set, daily budget and MTD against the cap, valid for 24 h", async () => {
    const r = await rig();
    r.meta.spend = () => "12.34";
    const sent = await r.cards.openActivationCard(publication());

    const send = r.fake.callsOf("sendPhoto").at(-1)!;
    expect(send.params.chat_id).toBe(CHAT);
    expect(send.params.photo).toBe("https://media.ololla.fi/syksy.jpg");
    const text = String(send.params.caption);
    expect(text).toContain("OLL syksy 1");
    expect(text).toContain("OLL Helsinki");
    expect(text).toContain(ADSET);
    expect(text).toContain("Päiväbudjetti: 3.22 €");
    expect(text).toContain("Kulutus tässä kuussa: 12.34 € / 100.00 €");
    expect(text).toContain("Syksyn parhaat kohteet");
    const labels = (send.params.reply_markup.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
    expect(labels.map((button) => button.text)).toEqual(["📣 Aktivoi mainos", "🗑 Ohita"]);
    expect(labels[1]!.callback_data).toMatch(/^g:s:/);

    const row = r.store.rows.get(sent.id)!;
    expect(row).toMatchObject({ status: "pending", kind: "activate_ad", chatId: CHAT, messageId: sent.messageId });
    expect(row.validUntil.getTime() - r.clock.now.getTime()).toBe(24 * 3_600_000);
    expect(row.payload.activation).toMatchObject({ adId: AD, adsetId: ADSET, creativeId: CREATIVE, contentHash: "c".repeat(64), publicationId: PUBLICATION_ID });
    // The card read Meta only.
    expect(r.meta.writes).toHaveLength(0);
    expect(r.harness.activity.some((entry) => entry.message === "rk9-ads gate: card sent")).toBe(true);
  });

  it("posts a video preview, and honours telegram.gateTtlHours", async () => {
    const r = await rig({ config: brandConfig({ telegram: telegramBlock({ gateTtlHours: 6 }) }) });
    const sent = await r.cards.openActivationCard(
      publication({ preview: { kind: "video", mediaUrl: "https://media.ololla.fi/syksy.mp4", posterUrl: "https://media.ololla.fi/p.jpg", copy: { message: "Video" } } }),
    );
    expect(r.fake.callsOf("sendVideo").at(-1)!.params.video).toBe("https://media.ololla.fi/syksy.mp4");
    expect(r.store.rows.get(sent.id)!.validUntil.getTime() - r.clock.now.getTime()).toBe(6 * 3_600_000);
  });

  it("refuses the hand-off without Telegram, so the publish service hands it off again later", async () => {
    const r = await rig({ config: brandConfig() });
    await expect(r.cards.openActivationCard(publication())).rejects.toThrow(/Telegram is not configured/);
    expect(r.store.rows.size).toBe(0);
  });

  it("closes an older open card of the same ad when a new one is sent (newest card wins)", async () => {
    const r = await rig();
    const first = await r.cards.openActivationCard(publication());
    const second = await r.cards.openActivationCard(publication());
    expect(r.store.rows.get(first.id)!.status).toBe("expired");
    expect(r.store.rows.get(first.id)!.outcome).toMatchObject({ reason: "superseded" });
    expect(r.fake.buttons(first.messageId)).toEqual([]);
    expect(r.store.rows.get(second.id)!.status).toBe("pending");
  });

  it("keeps the card text short enough for a caption", () => {
    const text = stagingCardText({
      brandCode: "OLL",
      adName: "a".repeat(80),
      adId: AD,
      adsetId: ADSET,
      adsetName: null,
      dailyBudgetCents: null,
      guard: null,
      monthlyCapEur: 100,
      copy: { message: "x".repeat(5_000) },
      validUntil: new Date("2026-10-22T09:00:00Z"),
      timeZone: "Europe/Helsinki",
    });
    expect(text.length).toBeLessThan(1024);
    expect(text).toContain("Voimassa 2026-10-22 klo 12:00 asti.");
  });
});

describe("approve tap", () => {
  it("re-runs preflight and the guard, sets the ad ACTIVE, pauses the other ACTIVE ad, flips the PAUSED ad set and campaign, and edits the card", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0);

    expect(r.preflights).toEqual([COMPANY_A]);
    expect(statusWrites(r.meta).map((call) => `${call.path}=${call.body.status}`)).toEqual([
      `${AD}=ACTIVE`,
      `${OLD_AD}=PAUSED`,
      `${ADSET}=ACTIVE`,
      `${CAMPAIGN}=ACTIVE`,
    ]);
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("approved");
    expect(row.decidedByTgUserId).toBe(APPROVER);
    expect(row.outcome).toMatchObject({
      handler: "done",
      result: "activated",
      adId: AD,
      pausedAdIds: [OLD_AD],
      decidedBy: { tgUserId: APPROVER, memberUserId: null },
      creativeId: CREATIVE,
    });
    expect(r.repo.pausedAdIds.get(sent.id)).toEqual([OLD_AD]);
    const text = caption(r, sent.messageId);
    expect(text).toContain(`✅ Mainos aktivoitu: ${AD}`);
    expect(text).toContain(`Pysäytetyt mainokset: ${OLD_AD}`);
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    const audit = r.harness.activity.find((entry) => entry.message === "rk9-ads gate: activate_ad activated");
    expect(audit).toMatchObject({ entityType: "gate_request", entityId: sent.id, metadata: { pausedAdIds: [OLD_AD] } });
    expect(recordedOutput(r.harness)).not.toContain(META_TOKEN);
    expect(recordedOutput(r.harness)).not.toContain(BOT_TOKEN);
  });

  it("leaves an ACTIVE ad set and campaign alone", async () => {
    const meta = freshMeta();
    meta.campaigns[0]!.status = "ACTIVE";
    meta.adsets[0]!.status = "ACTIVE";
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0);
    expect(statusWrites(r.meta).map((call) => `${call.path}=${call.body.status}`)).toEqual([`${AD}=ACTIVE`, `${OLD_AD}=PAUSED`]);
  });

  it("activates once for a double tap and for parallel taps; the other taps get 'already handled' and no Meta write", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const data = r.fake.buttons(sent.messageId)[0]!;
    r.fake.tap(BOT, { messageId: sent.messageId, data, fromId: APPROVER });
    r.fake.tap(BOT, { messageId: sent.messageId, data, fromId: APPROVER });
    r.fake.tap(BOT, { messageId: sent.messageId, data, fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 3);
    await r.controller.idle();
    expect(statusWrites(r.meta, "ACTIVE").filter((call) => call.path === AD)).toHaveLength(1);
    expect(r.store.writes.decide).toBe(1);
    const answers = r.fake.callsOf("answerCallbackQuery").map((call) => String(call.params.text));
    expect(answers.filter((text) => text.startsWith(GATE_TEXT.alreadyDecided))).toHaveLength(2);
  });

  it("refuses a tap from someone outside the approver list without changing anything", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0, STRANGER);
    expect(lastAnswer(r)).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(sent.id)!.status).toBe("pending");
    expect(r.meta.writes).toHaveLength(0);
  });
});

describe("guard and state refusals: no Meta write", () => {
  it.each([
    ["spend_cap missing", (meta: FakeMeta) => (meta.account.spend_cap = "0"), "no_spend_cap"],
    ["spend_cap above the cap", (meta: FakeMeta) => (meta.account.spend_cap = "50000"), "spend_cap_headroom_exceeds_remaining"],
    ["projection above monthlyCapEur", (meta: FakeMeta) => (meta.adsets[0]!.daily_budget = "900"), "projection_exceeds_cap"],
  ])("denies on %s and edits the reason into the card", async (_label, mutate, reason) => {
    const meta = freshMeta();
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    mutate(meta);
    await tap(r, sent.messageId, 0);
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("denied");
    expect(row.outcome).toMatchObject({ result: "denied", reason: `spend_guard:${reason}`, pausedAdIds: [] });
    expect(row.error).toContain(reason);
    expect(caption(r, sent.messageId)).toContain("⛔ Ei aktivoitu: kulutusvahti esti aktivoinnin");
    expect(caption(r, sent.messageId)).toContain(reason);
    expect(r.meta.writes).toHaveLength(0);
  });

  it("denies when the preflight fails, before any Meta read", async () => {
    const r = await rig({
      overrides: {
        assertLaunchReady: async () => {
          throw new Error("RK9 Ads is not launch-ready: spend_cap no_spend_cap");
        },
      },
    });
    const sent = await r.cards.openActivationCard(publication());
    const readsBefore = r.meta.calls.length;
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.status).toBe("denied");
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "preflight_failed" });
    expect(r.meta.calls).toHaveLength(readsBefore);
  });

  it.each([
    ["the ad set is ARCHIVED", (meta: FakeMeta) => (meta.adsets[0]!.status = "ARCHIVED"), `Ad set ${ADSET}: status ARCHIVED`],
    ["the campaign is DELETED", (meta: FakeMeta) => (meta.campaigns[0]!.status = "DELETED"), `Kampanja ${CAMPAIGN}: status DELETED`],
    ["the ad is DISAPPROVED", (meta: FakeMeta) => (meta.ads[1]!.effective_status = "DISAPPROVED"), `Mainos ${AD}: effective_status DISAPPROVED`],
    ["the ad has issues", (meta: FakeMeta) => (meta.ads[1]!.effective_status = "WITH_ISSUES"), `Mainos ${AD}: effective_status WITH_ISSUES`],
  ])("reports a ⚠ state when %s and fixes nothing", async (_label, mutate, line) => {
    const meta = freshMeta();
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    mutate(meta);
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.status).toBe("denied");
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "blocked_state" });
    expect(caption(r, sent.messageId)).toContain(`⚠️ ${line}`);
    expect(r.meta.writes).toHaveLength(0);
    expect(r.harness.logs.some((log) => log.level === "warn" && /activation refused/.test(log.message))).toBe(true);
  });
});

describe("approval bound to the creative (RK9-514 verifier)", () => {
  it("denies when the ad carries another creative than the card showed", async () => {
    const meta = freshMeta();
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    meta.ads[1]!.creative_id = OTHER_CREATIVE;
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.status).toBe("denied");
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "creative_changed" });
    expect(r.meta.writes).toHaveLength(0);
  });

  it("a creative swap closes the ad's open card; a later tap does nothing", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const oldData = r.fake.buttons(sent.messageId)[0]!;
    const closed = await getActivationCards()!.closeCardsForSwap({ companyId: COMPANY_A, adId: AD, publicationId: "dddddddd-0000-4000-8000-000000000002" });
    expect(closed).toEqual([sent.id]);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "creative_swapped" });
    expect(caption(r, sent.messageId)).toContain("Creative vaihdettu");
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    // A stale client still showing the old buttons.
    r.fake.tap(BOT, { messageId: sent.messageId, data: oldData, fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(lastAnswer(r)).toBe(GATE_TEXT.expired);
    expect(r.store.rows.get(sent.id)!.status).toBe("expired");
    expect(r.meta.writes).toHaveLength(0);
  });

  it("refuses a swap when a tap approved the card between the swap's listing and its close", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const close = r.repo.close;
    r.repo.close = async (companyId, id, outcome) => {
      // The approver's tap wins the race: pending -> approved just before the close.
      const row = r.store.rows.get(id)!;
      row.status = "approved";
      row.decidedAt = r.clock.now;
      return close(companyId, id, outcome);
    };
    await expect(r.cards.closeCardsForSwap({ companyId: COMPANY_A, adId: AD, publicationId: PUBLICATION_ID })).rejects.toThrow(/activation of ad .* is running/);
    expect(r.store.rows.get(sent.id)!.status).toBe("approved");
  });

  it("refuses a swap while an approved activation of the ad is running", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const row = r.store.rows.get(sent.id)!;
    row.status = "approved";
    row.decidedAt = r.clock.now;
    row.outcome = { handler: "started" };
    await expect(r.cards.closeCardsForSwap({ companyId: COMPANY_A, adId: AD, publicationId: PUBLICATION_ID })).rejects.toThrow(/activation of ad .* is running/);
    // A crashed handler from long ago does not block the ad for good.
    row.decidedAt = new Date(r.clock.now.getTime() - 31 * 60_000);
    await expect(r.cards.closeCardsForSwap({ companyId: COMPANY_A, adId: AD, publicationId: PUBLICATION_ID })).resolves.toEqual([]);
  });

  it("pauses the ad again and fails when a swap raced the activation", async () => {
    const meta = freshMeta();
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    // The creative changes right after the ad goes ACTIVE.
    const fetch = meta.fetch;
    meta.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "POST" && String(init.body).includes("status=ACTIVE") && url.includes(AD)) meta.ads[1]!.creative_id = OTHER_CREATIVE;
      return response;
    };
    await tap(r, sent.messageId, 0);
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("failed");
    expect(row.outcome).toMatchObject({ result: "failed", step: "verify_creative" });
    expect(statusWrites(meta).filter((call) => call.path === AD).map((call) => call.body.status)).toEqual(["ACTIVE", "PAUSED"]);
    expect(meta.ads[1]!.status).toBe("PAUSED");
  });
});

describe("skip, expiry, partial failure, resend", () => {
  it("skip sets skipped, removes the buttons and leaves the ad PAUSED", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 1);
    expect(r.store.rows.get(sent.id)!.status).toBe("skipped");
    expect(lastAnswer(r)).toBe(GATE_TEXT.skipped);
    expect(caption(r, sent.messageId)).toContain(GATE_TEXT.skipped);
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    expect(r.meta.writes).toHaveLength(0);
  });

  it("the expiry job expires a card past valid_until and edits it; a tap after that does nothing", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    expect(await r.cards.expireDueCards()).toBe(0);
    r.clock.now = new Date(r.clock.now.getTime() + 24 * 3_600_000 + 1_000);
    await r.harness.runJob("gate-expiry");
    expect(r.store.rows.get(sent.id)!.status).toBe("expired");
    expect(caption(r, sent.messageId)).toContain("⌛ Vanhentunut. Mainos jäi PAUSED-tilaan.");
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    expect(r.harness.activity.some((entry) => entry.message === "rk9-ads gate: card expired")).toBe(true);
    expect(await r.cards.expireDueCards()).toBe(0);
    expect(r.meta.writes).toHaveLength(0);
  });

  it("a tap past valid_until expires the card even before the job ran", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const data = r.fake.buttons(sent.messageId)[0]!;
    r.clock.now = new Date(r.clock.now.getTime() + 25 * 3_600_000);
    r.fake.tap(BOT, { messageId: sent.messageId, data, fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(lastAnswer(r)).toBe(GATE_TEXT.expired);
    expect(r.store.rows.get(sent.id)!.status).toBe("expired");
    expect(r.meta.writes).toHaveLength(0);
  });

  it("records a partial Meta failure as failed with the step reached and does not retry", async () => {
    const meta = freshMeta();
    meta.fail = (call) =>
      call.method === "POST" && call.path === ADSET
        ? new Response(JSON.stringify({ error: { message: "Invalid parameter", type: "OAuthException", code: 100 } }), { status: 400 })
        : null;
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0);
    const row = r.store.rows.get(sent.id)!;
    expect(row.status).toBe("failed");
    expect(row.outcome).toMatchObject({ result: "failed", step: "adset_active", done: ["ad_active", "pause_others"], pausedAdIds: [OLD_AD] });
    expect(caption(r, sent.messageId)).toContain("Aktivointi keskeytyi vaiheessa adset_active");
    expect(meta.writes.filter((call) => call.path === ADSET)).toHaveLength(1);
    expect(meta.writes.filter((call) => call.path === CAMPAIGN)).toHaveLength(0);
    expect(r.repo.pausedAdIds.get(sent.id)).toEqual([OLD_AD]);
  });

  it("resend_gate_card posts the pending card again; the old card's buttons no longer act", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    const oldData = r.fake.buttons(sent.messageId)[0]!;
    const resent = await r.harness.performAction<{ gateRequestId: string; messageId: number }>(
      "resend_gate_card",
      { publicationId: PUBLICATION_ID },
      { companyId: COMPANY_A },
    );
    expect(resent.gateRequestId).toBe(sent.id);
    expect(resent.messageId).not.toBe(sent.messageId);
    expect(r.store.rows.get(sent.id)!.messageId).toBe(resent.messageId);
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    expect(caption(r, sent.messageId)).toContain("Lähetetty uudelleen");

    r.fake.tap(BOT, { messageId: sent.messageId, data: oldData, fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(lastAnswer(r)).toBe(GATE_TEXT.unknownCard);
    expect(r.store.rows.get(sent.id)!.status).toBe("pending");

    await tap(r, resent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.status).toBe("approved");
    expect(statusWrites(r.meta, "ACTIVE").filter((call) => call.path === AD)).toHaveLength(1);
  });

  it("a resend whose send fails still removes the old card's buttons", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    r.fake.failNext.set("sendPhoto", { status: 400, description: "Bad Request: wrong file identifier/HTTP URL specified" });
    await expect(r.harness.performAction("resend_gate_card", { gateRequestId: sent.id }, { companyId: COMPANY_A })).rejects.toThrow();
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    expect(r.store.rows.get(sent.id)!).toMatchObject({ status: "pending", messageId: null });
  });

  it("falls back to the poster, then to a text card, when Telegram cannot fetch the media", async () => {
    const r = await rig();
    r.fake.failNext.set("sendVideo", { status: 400, description: "Bad Request: failed to get HTTP URL content" });
    const sent = await r.cards.openActivationCard(
      publication({ preview: { kind: "video", mediaUrl: "https://media.ololla.fi/big.mp4", posterUrl: "https://media.ololla.fi/p.jpg", copy: { message: "Video" } } }),
    );
    expect(r.fake.callsOf("sendPhoto").at(-1)!.params.photo).toBe("https://media.ololla.fi/p.jpg");
    expect(r.store.rows.get(sent.id)!.payload.activation).toMatchObject({ media: "photo", mediaUrl: "https://media.ololla.fi/p.jpg" });

    r.fake.failNext.set("sendPhoto", { status: 400, description: "Bad Request: failed to get HTTP URL content" });
    const text = await r.cards.openActivationCard(publication());
    expect(r.fake.messages.get(text.messageId)!.text).toContain("OLL syksy 1");
    expect(r.store.rows.get(text.id)!.payload.activation).toMatchObject({ media: "text", mediaUrl: null });
    await tap(r, text.messageId, 0);
    expect(r.store.rows.get(text.id)!.status).toBe("approved");
  });

  it("pauses the ad again when the creative cannot be read after activation", async () => {
    const meta = freshMeta();
    const r = await rig({ meta });
    const sent = await r.cards.openActivationCard(publication());
    let listings = 0;
    meta.fail = (call) => (call.method === "GET" && call.path === `${ADSET}/ads` && ++listings === 2 ? new Error("socket hang up") : null);
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "failed", step: "verify_creative" });
    expect(meta.ads[1]!.status).toBe("PAUSED");
  });

  it("resend refuses a decided or expired card and another company's card", async () => {
    const r = await rig();
    const sent = await r.cards.openActivationCard(publication());
    await expect(
      r.harness.performAction("resend_gate_card", { gateRequestId: sent.id }, { companyId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow(/no such activation card/);
    await tap(r, sent.messageId, 1);
    await expect(r.harness.performAction("resend_gate_card", { gateRequestId: sent.id }, { companyId: COMPANY_A })).rejects.toThrow(
      /only a pending, unexpired card/,
    );
  });
});

describe("pause-ad closes the ad's open activation cards (RK9-562)", () => {
  const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } };

  async function pauseAd(r: Rig): Promise<UiPauseAdResult> {
    return (await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: AD, dryRun: false, confirm: true }, BOARD)) as UiPauseAdResult;
  }

  it("an old card tapped after pause-ad makes no ACTIVE write, and the card says why", async () => {
    const r = await rig();
    registerUi(r.runtime);
    const sent = await r.cards.openActivationCard(publication());
    const oldData = r.fake.buttons(sent.messageId)[0]!;

    const result = await pauseAd(r);
    expect(result).toMatchObject({ paused: true, status: "PAUSED", closedCardIds: [sent.id] });
    expect(result.cardsError).toBeUndefined();
    expect(r.store.rows.get(sent.id)!.status).toBe("expired");
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ reason: "ad_paused", handler: "not_run" });
    expect(caption(r, sent.messageId)).toContain(AD_PAUSE_CLOSE_TEXT);
    expect(r.fake.buttons(sent.messageId)).toEqual([]);
    expect(statusWrites(r.meta, "PAUSED").map((call) => call.path)).toEqual([expect.stringContaining(AD)]);

    // A stale client still showing the old buttons.
    r.fake.tap(BOT, { messageId: sent.messageId, data: oldData, fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    await r.controller.idle();
    expect(lastAnswer(r)).toBe(GATE_TEXT.expired);
    expect(statusWrites(r.meta, "ACTIVE")).toHaveLength(0);
  });

  it("a dry run closes no card", async () => {
    const r = await rig();
    registerUi(r.runtime);
    const sent = await r.cards.openActivationCard(publication());
    await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: AD }, BOARD);
    expect(r.store.rows.get(sent.id)!.status).toBe("pending");
    expect(r.meta.writes).toHaveLength(0);
  });

  it("pauses the ad even when a card does not close, and reports cardsError", async () => {
    const r = await rig();
    registerUi(r.runtime);
    const sent = await r.cards.openActivationCard(publication());
    r.repo.close = async () => {
      throw new Error("row locked");
    };
    const result = await pauseAd(r);
    expect(result).toMatchObject({ paused: true, closedCardIds: [] });
    expect(result.cardsError).toMatch(new RegExp(`1 card\\(s\\) not closed \\(${sent.id}\\): .*row locked`));
    expect(statusWrites(r.meta, "PAUSED")).toHaveLength(1);
  });

  it("a failed Meta pause still closes the cards, and the error says so", async () => {
    const r = await rig();
    registerUi(r.runtime);
    const sent = await r.cards.openActivationCard(publication());
    r.meta.fail = (call) => (call.body.status === "PAUSED" ? new Error("Meta 500") : null);
    await expect(pauseAd(r)).rejects.toThrow(/The pause of ad .* failed: .*1 activation card\(s\) of the ad closed/);
    expect(r.store.rows.get(sent.id)!.status).toBe("expired");
    // The card does not claim the ad is being paused (RK9-566).
    expect(caption(r, sent.messageId)).toContain(AD_PAUSE_FAILED_CLOSE_TEXT);
    expect(caption(r, sent.messageId)).not.toContain(AD_PAUSE_CLOSE_TEXT);
  });

  it("with the ad's halt stored, a running activation is still named, with the halt that stops it (RK9-566)", async () => {
    const r = await rig();
    registerUi(r.runtime);
    r.repo.activationInFlight = async () => true;
    const result = await pauseAd(r);
    expect(result).toMatchObject({ paused: true, closedCardIds: [], adHalt: { id: expect.any(String), until: expect.any(String) } });
    expect(result.cardsError).toMatch(/approved activation of ad .* is running; the ad's halt makes it pause the ad again/);
  });

  it("reports an approved activation that may still run when the ad's halt was not stored", async () => {
    const r = await rig();
    registerUi(r.runtime);
    r.repo.activationInFlight = async () => true;
    const set = r.harness.ctx.state.set.bind(r.harness.ctx.state);
    r.harness.ctx.state.set = async (key, value) => {
      if (key.stateKey.includes(":ad:")) throw new Error("state down");
      return set(key, value);
    };
    const result = await pauseAd(r);
    expect(result).toMatchObject({ paused: true, closedCardIds: [], haltError: expect.stringContaining("state down") });
    expect(result.adHalt).toBeUndefined();
    expect(result.cardsError).toMatch(/approved activation of ad .* is running/);
  });

  it("reports cardsError when the activation gate is not running", async () => {
    const r = await rig();
    registerUi(r.runtime);
    setActivationCards(null);
    const result = await pauseAd(r);
    expect(result).toMatchObject({ paused: true });
    expect(result.cardsError).toMatch(/activation gate is not running/);
  });
});

describe("pause-ad leaves a short halt for the ad (RK9-566)", () => {
  const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } };

  async function pauseAd(r: Rig): Promise<UiPauseAdResult> {
    return (await r.harness.performAction(PAUSE_AD_ACTION_KEY, { adId: AD, dryRun: false, confirm: true }, BOARD)) as UiPauseAdResult;
  }

  it("stores the halt before the Meta write, and a card of the ad tapped while it holds is denied with no ACTIVE write", async () => {
    const r = await rig();
    registerUi(r.runtime);
    const result = await pauseAd(r);
    const halt = await readAdHalt(r.harness.ctx, COMPANY_A, AD);
    expect(halt).toMatchObject({ rule: "pause_ad", adId: AD, brandCode: "OLL", initiator: { source: "ui", userId: "board-user-1" } });
    expect(result.adHalt).toEqual({ id: halt!.id, until: halt!.until });
    expect(Date.parse(halt!.until) - Date.parse(halt!.since)).toBe(30 * 60_000);

    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "denied", reason: "halted" });
    expect(caption(r, sent.messageId)).toContain("mainos pysäytettiin käyttöliittymästä");
    expect(statusWrites(r.meta, "ACTIVE")).toHaveLength(0);
  });

  it("an activation approved before the pause and still writing pauses the ad again and fails", async () => {
    const r = await rig();
    registerUi(r.runtime);
    const sent = await r.cards.openActivationCard(publication());
    const original = r.harness.ctx.http.fetch;
    let fired = false;
    r.harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
      const body = init?.body ? new URLSearchParams(String(init.body)) : null;
      const hit = !fired && init?.method === "POST" && new URL(url).pathname.endsWith(`/${AD}`) && body?.get("status") === "ACTIVE";
      const response = await original(url, init);
      if (hit) {
        fired = true;
        // The pause from the UI lands right after Meta applied the activation's ACTIVE.
        expect(await pauseAd(r)).toMatchObject({ paused: true });
      }
      return response;
    };
    await tap(r, sent.messageId, 0);
    expect(fired).toBe(true);
    const outcome = r.store.rows.get(sent.id)!.outcome as { result: string; detail: string };
    expect(outcome.result).toBe("failed");
    expect(outcome.detail).toContain("the pause_ad halt was set during the activation");
    expect(outcome.detail).toContain("the ad was paused again");
    expect(statusWrites(r.meta).filter((call) => call.path.endsWith(AD)).at(-1)!.body.status).toBe("PAUSED");
  });

  it("the halt of another ad does not stop this one, and an ended halt stops nothing", async () => {
    const r = await rig();
    await setAdHalt(r.harness.ctx, COMPANY_A, newAdHalt({ brandCode: "OLL", adId: OLD_AD, reason: "muu", initiator: { source: "ui" }, now: new Date() }));
    await setAdHalt(r.harness.ctx, COMPANY_A, newAdHalt({ brandCode: "OLL", adId: AD, reason: "vanha", initiator: { source: "ui" }, now: new Date(Date.now() - 31 * 60_000) }));
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "activated" });
  });

  it("a halt that cannot be read refuses the activation", async () => {
    const r = await rig({
      overrides: {
        adHaltOf: async () => {
          throw new Error("state unavailable");
        },
      },
    });
    const sent = await r.cards.openActivationCard(publication());
    await tap(r, sent.messageId, 0);
    expect(r.store.rows.get(sent.id)!.outcome).toMatchObject({ result: "denied", reason: "halt_unreadable" });
    expect(statusWrites(r.meta, "ACTIVE")).toHaveLength(0);
  });
});
