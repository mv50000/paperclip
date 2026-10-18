import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company, PluginLogger } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { GATE_REQUEST_KINDS } from "../src/db.js";
import { getTelegramController, TelegramController } from "../src/features/telegram/controller.js";
import { createCallbackRouter, GATE_TEXT, type GateBrand } from "../src/kit/gate/callback-router.js";
import { createGateRegistry, type GateHandlerInput } from "../src/kit/gate/registry.js";
import {
  createGateCard,
  createSqlGateStore,
  gateCallbackData,
  gateTokenHash,
  newGateToken,
  parseGateCallbackData,
  type GateStore,
} from "../src/kit/gate/state-machine.js";
import { createBotApi, editCard, TelegramApiError, telegramBotKey } from "../src/kit/telegram/bot-api.js";
import { createPollLoop, MAX_POLL_TIMEOUT_SECONDS, stateOffsetStore } from "../src/kit/telegram/poll-loop.js";
import { TELEGRAM_SECRET_HEADER, verifyWebhookSecret, webhookSecretDigest } from "../src/kit/telegram/webhook.js";
import { createMemoryGateStore } from "../src/kit/testing/memory-gate-store.js";
import { recordedOutput, useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";
import { EMBEDDED_PG_TIMEOUT_MS, describeEmbeddedPostgres, startPluginTestDatabase, type PluginTestDatabase } from "./helpers/embedded-pg.js";
import { brandConfig, COMPANY_A, COMPANY_B, COMPANY_UNCONFIGURED, PACKAGE_ROOT, SECRET_A_BOT, secretRef } from "./fixtures.js";

const TOKEN_A = "1234567:AAE-company-a-fake-bot-token-0123456789";
const TOKEN_C = "7654321:AAE-company-c-fake-bot-token-9876543210";
const SECRET_C_BOT = "cccccccc-0000-4000-8000-00000000000b";
const SECRET_WEBHOOK = "aaaaaaaa-0000-4000-8000-00000000000c";
const WEBHOOK_SECRET_VALUE = "wh_secret-Value_0123456789_abcdefghijklmnop";
const WEBHOOK_URL = "https://paperclip.example/api/plugins/rk9-ads/webhooks/telegram";
const CHAT_A = "-100111";
const CHAT_B = "-100222";
const APPROVER = 42;
const BOT_A = telegramBotKey(TOKEN_A);
const BOT_C = telegramBotKey(TOKEN_C);

function company(id: string, name: string): Company {
  return { id, name } as Company;
}

function telegramBlock(overrides: Record<string, unknown> = {}) {
  return { botTokenRef: secretRef(SECRET_A_BOT), chatId: CHAT_A, allowedUserIds: [String(APPROVER)], mode: "poll", ...overrides };
}

const silentLogger: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harnessWith(
  configs: Record<string, Record<string, unknown>>,
  secrets: Record<string, Record<string, string>>,
  companies: Company[] = [company(COMPANY_A, "Ololla"), company(COMPANY_B, "Sunspot"), company(COMPANY_UNCONFIGURED, "Other")],
): TestHarness {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies });
  useCompanyConfigs(harness, configs);
  useCompanySecrets(harness, secrets);
  return harness;
}

interface Rig {
  harness: TestHarness;
  fake: FakeTelegram;
  store: ReturnType<typeof createMemoryGateStore>;
  controller: TelegramController;
  handlerCalls: GateHandlerInput[];
}

const rigs: Rig[] = [];

async function rig(input: {
  configs?: Record<string, Record<string, unknown>>;
  secrets?: Record<string, Record<string, string>>;
  harness?: TestHarness;
  fake?: FakeTelegram;
  store?: ReturnType<typeof createMemoryGateStore>;
  handler?: (input: GateHandlerInput) => Promise<unknown>;
  webhookMode?: "enabled" | "disabled";
} = {}): Promise<Rig> {
  const harness =
    input.harness ??
    harnessWith(input.configs ?? { [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) }, input.secrets ?? { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
  const fake = input.fake ?? new FakeTelegram();
  const store = input.store ?? createMemoryGateStore();
  const handlerCalls: GateHandlerInput[] = [];
  const registry = createGateRegistry(GATE_REQUEST_KINDS);
  registry.register("activate_ad", async (call) => {
    fake.mark("handler");
    handlerCalls.push(call);
    if (input.handler) return (await input.handler(call)) as never;
    return { statusText: "✅ Mainos aktivoitu", outcome: { ok: true } };
  });
  const controller = new TelegramController(harness.ctx, {
    store,
    registry,
    fetch: fake.fetch,
    webhookMode: input.webhookMode ?? "disabled",
    pollTimeoutSeconds: 2,
    errorBackoffMs: 20,
    conflictBackoffMs: 60,
  });
  const out = { harness, fake, store, controller, handlerCalls };
  rigs.push(out);
  await controller.replan();
  return out;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.controller.stop()));
});

async function photoCard(r: Rig, validForMs = 3_600_000, companyId = COMPANY_A) {
  return r.controller.sendGateCard({
    companyId,
    kind: "activate_ad",
    validUntil: new Date(Date.now() + validForMs),
    card: { media: "photo", mediaUrl: "https://cdn.example/ad.jpg", text: "Ololla: syysmainos 1" },
    payload: { adId: "120000000001" },
  });
}

function approveData(r: Rig, messageId: number): string {
  return r.fake.buttons(messageId)[0]!;
}

function denyData(r: Rig, messageId: number): string {
  return r.fake.buttons(messageId)[1]!;
}

// ---------------------------------------------------------------------------

describe("Bot API client", () => {
  it("never puts the token into an error, and drops the transport error cause", async () => {
    const api = createBotApi({
      token: TOKEN_A,
      fetch: async (url) => {
        throw new Error(`request to ${url} failed, reason: ECONNRESET`, { cause: new Error(url) });
      },
    });
    const error = await api.getUpdates({ timeout: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN_A);
    expect(String((error as Error).message)).not.toContain("AAE-company-a");
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(TOKEN_A);
  });

  it("maps Telegram errors (401, 409, retry_after) without the URL", async () => {
    const fake = new FakeTelegram();
    const api = createBotApi({ token: TOKEN_A, fetch: fake.fetch });
    fake.failNext.set("sendMessage", { status: 401, description: "Unauthorized" });
    const unauthorized = (await api.sendMessage({ chat_id: CHAT_A, text: "x" }).catch((e: unknown) => e)) as TelegramApiError;
    expect(unauthorized.message).toBe("Telegram sendMessage failed (401): Unauthorized");
    fake.conflicts.add(BOT_A);
    const conflict = (await api.getUpdates({ timeout: 0 }).catch((e: unknown) => e)) as TelegramApiError;
    expect(conflict.isConflict).toBe(true);
    fake.failNext.set("sendMessage", { status: 429, description: "Too Many Requests: retry after 3", retryAfter: 3 });
    const limited = (await api.sendMessage({ chat_id: CHAT_A, text: "x" }).catch((e: unknown) => e)) as TelegramApiError;
    expect(limited.retryAfterSeconds).toBe(3);
  });

  it("edits a photo caption with editMessageCaption and a text card with editMessageText, tolerating 'not modified'", async () => {
    const fake = new FakeTelegram();
    const api = createBotApi({ token: TOKEN_A, fetch: fake.fetch });
    const photo = await api.sendPhoto({ chat_id: CHAT_A, photo: "https://cdn.example/a.jpg", caption: "kuva" });
    const text = await api.sendMessage({ chat_id: CHAT_A, text: "teksti" });
    await editCard(api, { chatId: CHAT_A, messageId: photo.message_id, media: "photo", original: "kuva", status: "⏳" });
    await editCard(api, { chatId: CHAT_A, messageId: text.message_id, media: "text", original: "teksti", status: "⏳" });
    // Same content again: Telegram answers "message is not modified", which is not an error.
    await editCard(api, { chatId: CHAT_A, messageId: photo.message_id, media: "photo", original: "kuva", status: "⏳" });
    expect(fake.messages.get(photo.message_id)?.caption).toBe("kuva\n\n⏳");
    expect(fake.messages.get(text.message_id)?.text).toBe("teksti\n\n⏳");
    expect(fake.callsOf("editMessageCaption")).toHaveLength(2);
    expect(fake.callsOf("editMessageText")).toHaveLength(1);
  });

  it("keeps callback_data within 64 bytes and the token at >= 128 bit", () => {
    const token = newGateToken();
    expect(Buffer.from(token, "base64url").length * 8).toBeGreaterThanOrEqual(128);
    const data = gateCallbackData("approved", token);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseGateCallbackData(data)).toEqual({ decision: "approved", token });
    expect(parseGateCallbackData("g:x:abc")).toBeNull();
  });
});

describe("gate registry", () => {
  it("allows only the plugin's kinds and refuses scale_budget (G9)", () => {
    const registry = createGateRegistry(GATE_REQUEST_KINDS);
    expect(() => registry.register("scale_budget" as never, async () => {})).toThrow(/not allowed/);
    registry.register("activate_ad", async () => {});
    expect(() => registry.register("activate_ad", async () => {})).toThrow(/already has a handler/);
    expect(registry.has("activate_ad")).toBe(true);
    expect(registry.has("pause_all")).toBe(false);
    expect(registry.get("scale_budget")).toBeUndefined();
  });
});

describe("long-poll transport", () => {
  it("runs exactly one getUpdates loop per distinct bot token, with timeout <= 25 s and callback_query+message", async () => {
    const r = await rig({
      configs: {
        [COMPANY_A]: brandConfig({ telegram: telegramBlock() }),
        // Company B shares company A's bot (same secret value, different chat).
        [COMPANY_B]: brandConfig({ brandCode: "AUR", telegram: telegramBlock({ chatId: CHAT_B }) }),
        [COMPANY_UNCONFIGURED]: brandConfig({ brandCode: "OTH", telegram: telegramBlock({ botTokenRef: secretRef(SECRET_C_BOT) }) }),
      },
      secrets: {
        [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A },
        [COMPANY_B]: { [SECRET_A_BOT]: TOKEN_A },
        [COMPANY_UNCONFIGURED]: { [SECRET_C_BOT]: TOKEN_C },
      },
    });
    await waitFor(() => r.fake.callsOf("getUpdates", BOT_A).length > 0 && r.fake.callsOf("getUpdates", BOT_C).length > 0);
    const summary = r.controller.summary();
    expect(summary).toHaveLength(2);
    expect(summary.find((bot) => bot.botKey === BOT_A)?.companies.sort()).toEqual([COMPANY_A, COMPANY_B].sort());
    for (const call of r.fake.callsOf("getUpdates")) {
      expect(call.params.timeout).toBeLessThanOrEqual(MAX_POLL_TIMEOUT_SECONDS);
      expect(call.params.allowed_updates).toEqual(["callback_query", "message"]);
    }
    expect(r.fake.maxInflight.get(BOT_A)).toBe(1);
    expect(r.fake.maxInflight.get(BOT_C)).toBe(1);
    // No webhook existed, so poll mode deleted nothing.
    expect(r.fake.callsOf("deleteWebhook")).toHaveLength(0);
  });

  it("re-plans on a config change: a removed bot stops, an unchanged bot keeps its loop", async () => {
    const configs: Record<string, Record<string, unknown>> = {
      [COMPANY_A]: brandConfig({ telegram: telegramBlock() }),
      [COMPANY_B]: brandConfig({ brandCode: "AUR", telegram: telegramBlock({ chatId: CHAT_B, botTokenRef: secretRef(SECRET_C_BOT) }) }),
    };
    const r = await rig({ configs, secrets: { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A }, [COMPANY_B]: { [SECRET_C_BOT]: TOKEN_C } } });
    await waitFor(() => r.fake.callsOf("getUpdates", BOT_C).length > 0);
    delete (configs[COMPANY_B] as Record<string, unknown>).telegram;
    await r.controller.replan();
    expect(r.controller.summary().map((bot) => bot.botKey)).toEqual([BOT_A]);
    const cCalls = r.fake.callsOf("getUpdates", BOT_C).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.fake.callsOf("getUpdates", BOT_C).length).toBe(cCalls);
    expect(r.fake.maxInflight.get(BOT_A)).toBe(1);
  });

  it("stops within a few seconds on shutdown and calls getUpdates no more", async () => {
    const r = await rig();
    await waitFor(() => r.fake.callsOf("getUpdates").length > 0);
    const started = Date.now();
    await r.controller.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    const count = r.fake.callsOf("getUpdates").length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(r.fake.callsOf("getUpdates").length).toBe(count);
  });

  it("saves the offset under the bot-token hash and resumes at last update_id + 1 after a restart", async () => {
    const harness = harnessWith({ [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) }, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    const fake = new FakeTelegram();
    const store = createMemoryGateStore();
    const first = await rig({ harness, fake, store });
    const card = await photoCard(first);
    const tapId = fake.tap(BOT_A, { messageId: card.messageId, data: approveData(first, card.messageId), fromId: APPROVER });
    const offsetKey = { scopeKind: "instance" as const, namespace: "telegram", stateKey: `offset:${BOT_A}` };
    await waitFor(() => harness.getState(offsetKey) === tapId + 1);
    await first.controller.idle();
    await first.controller.stop();
    expect(first.handlerCalls).toHaveLength(1);

    const callsBefore = fake.callsOf("getUpdates").length;
    const second = await rig({ harness, fake, store });
    await waitFor(() => fake.callsOf("getUpdates").length > callsBefore);
    expect(fake.callsOf("getUpdates")[callsBefore]!.params.offset).toBe(tapId + 1);
    expect(second.handlerCalls).toHaveLength(0);
    expect(recordedOutput(harness)).not.toContain(TOKEN_A);
  });

  it("does not handle an update again when the offset save was lost (crash before save)", async () => {
    const harness = harnessWith({ [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) }, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    const fake = new FakeTelegram();
    const store = createMemoryGateStore();
    const first = await rig({ harness, fake, store });
    const card = await photoCard(first);
    const tap = fake.callbackUpdate({ messageId: card.messageId, data: approveData(first, card.messageId), fromId: APPROVER });
    const tapId = fake.pushUpdate(BOT_A, tap);
    await waitFor(() => first.handlerCalls.length === 1);
    await first.controller.idle();
    await first.controller.stop();
    const answersBefore = fake.callsOf("answerCallbackQuery").length;

    // Simulate a kill between the handler and the offset save: Telegram delivers it again.
    const offsets = stateOffsetStore(harness.ctx.state, BOT_A);
    await offsets.save(tapId);
    await fake.drained();
    fake.pushUpdate(BOT_A, { ...tap, update_id: tapId });
    const second = await rig({ harness, fake, store });
    await waitFor(async () => (await offsets.load()) === tapId + 1);
    await second.controller.idle();
    expect(first.handlerCalls.length + second.handlerCalls.length).toBe(1);
    expect(fake.callsOf("answerCallbackQuery").length).toBe(answersBefore);
    expect(store.writes.decide).toBe(1);
  });

  it("logs a 409 (another consumer) as a clear error and backs off", async () => {
    const fake = new FakeTelegram();
    fake.conflicts.add(BOT_A);
    const r = await rig({ fake });
    await waitFor(() => r.harness.logs.some((log) => log.level === "error" && /409 conflict/.test(log.message)));
    const error = r.harness.logs.find((log) => /409 conflict/.test(log.message))!;
    expect(error.message).toMatch(/another consumer uses this bot token/);
    expect(error.message).toMatch(/Dev and prod need separate bots/);
    // Two 409s in a row stop the loop, so the two consumers do not trade updates.
    await waitFor(() => r.controller.summary()[0]?.loop === "conflict");
    expect(fake.callsOf("getUpdates")).toHaveLength(2);
    expect(r.controller.summary()[0]?.ready).toBe(false);
    await expect(
      r.controller.sendGateCard({ companyId: COMPANY_A, kind: "activate_ad", validUntil: new Date(Date.now() + 1000), card: { media: "text", text: "x" } }),
    ).rejects.toThrow(/not ready/);
    // The retry timer does not restart it; a config save does.
    await r.controller.replan("retry");
    expect(fake.callsOf("getUpdates")).toHaveLength(2);
    fake.conflicts.delete(BOT_A);
    await r.controller.replan("config");
    await waitFor(() => r.controller.summary()[0]?.loop === "running");
  });

  it("stops after two 409s even when a success comes between them (two consumers that alternate)", async () => {
    const fake = new FakeTelegram();
    const conflict = { status: 409, description: "Conflict: terminated by other getUpdates request" };
    fake.failNext.set("getUpdates", conflict);
    const r = await rig({ fake });
    // The second getUpdates succeeds: it long-polls until an update arrives.
    await waitFor(() => fake.callsOf("getUpdates").length === 2);
    fake.failNext.set("getUpdates", conflict);
    fake.pushUpdate(BOT_A, { message: { message_id: 900, date: 0, chat: { id: Number(CHAT_A) }, text: "moi" } });
    await waitFor(() => r.controller.summary()[0]?.loop === "conflict");
    expect(fake.callsOf("getUpdates")).toHaveLength(3);
  });

  it("holds every brand for pause cards only while a plan fails, and lifts the hold when a plan succeeds", async () => {
    const r = await rig();
    const card = await photoCard(r);
    // An operator saves the config (it may revoke an approver), and the plan
    // cannot list the companies: the old allowlist must not approve spend.
    const list = r.harness.ctx.companies.list;
    r.harness.ctx.companies.list = async () => {
      throw new Error("missing, expired, or unknown invocation scope");
    };
    await r.controller.replan("config");
    expect(r.harness.logs.some((log) => log.level === "error" && /planning failed/.test(log.message))).toBe(true);
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(card.id)?.status).toBe("pending");
    expect(r.handlerCalls).toHaveLength(0);
    expect(r.controller.botFor(COMPANY_A)).toBeNull();

    r.harness.ctx.companies.list = list;
    await r.controller.replan("retry");
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.handlerCalls.length === 1);
    await r.controller.idle();
    expect(r.store.rows.get(card.id)?.status).toBe("approved");
    // A config change holds spend decisions at once, before its plan runs.
    expect(r.controller.botFor(COMPANY_A)).not.toBeNull();
    r.controller.holdAll("config_changed");
    expect(r.controller.botFor(COMPANY_A)).toBeNull();
  });

  it("keeps a brand with an unreadable config on its bot for pause cards only", async () => {
    const configs: Record<string, Record<string, unknown>> = { [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) };
    const harness = harnessWith(configs, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    const r = await rig({ harness });
    const card = await photoCard(r);
    // The host now refuses company A's config (marker says it has one): "unavailable".
    harness.ctx.config.get = async () => {
      throw new Error("company context is required");
    };
    await r.controller.replan("retry");
    expect(r.controller.summary()).toMatchObject([{ botKey: BOT_A, companies: [COMPANY_A] }]);
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(card.id)?.status).toBe("pending");
    expect(r.controller.botFor(COMPANY_A)).toBeNull();
  });

  it("refuses poll mode on a bot whose webhook belongs to another consumer, and deletes only its own webhook", async () => {
    const fake = new FakeTelegram();
    fake.webhooks.set(BOT_A, { url: "https://core.example/api/chat/telegram", secret: null });
    const refused = await rig({ fake });
    expect(fake.callsOf("deleteWebhook")).toHaveLength(0);
    expect(fake.callsOf("getUpdates")).toHaveLength(0);
    expect(refused.harness.logs.some((log) => log.level === "error" && /webhook set by another consumer/.test(log.message))).toBe(true);
    await refused.controller.stop();

    const harness = harnessWith({ [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) }, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    fake.webhooks.set(BOT_A, { url: WEBHOOK_URL, secret: WEBHOOK_SECRET_VALUE });
    await harness.ctx.state.set({ scopeKind: "instance", namespace: "telegram", stateKey: `webhook-owner:${BOT_A}` }, WEBHOOK_URL);
    await rig({ harness, fake });
    expect(fake.callsOf("deleteWebhook")).toHaveLength(1);
    await waitFor(() => fake.callsOf("getUpdates").length > 0);
  });

  it("the kit loop discards a batch fetched after stop()", async () => {
    const fake = new FakeTelegram();
    const api = createBotApi({ token: TOKEN_A, fetch: fake.fetch });
    const handled: number[] = [];
    let saved: number | null = null;
    const loop = createPollLoop({
      api,
      offsets: { load: async () => saved, save: async (offset) => { saved = offset; } },
      onUpdate: async (update) => { handled.push(update.update_id); },
      logger: silentLogger,
      timeoutSeconds: 2,
    });
    loop.start();
    await waitFor(() => fake.callsOf("getUpdates").length === 1);
    await loop.stop();
    fake.pushUpdate(BOT_A, { message: { message_id: 1, chat: { id: 1 }, text: "late" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handled).toEqual([]);
    expect(saved).toBeNull();
    expect(fake.callsOf("getUpdates")).toHaveLength(1);
  });
});

describe("gate transitions", () => {
  it("turns a tap into approved within 2 s: answer and hourglass first, then the handler, then the outcome", async () => {
    const r = await rig();
    const card = await photoCard(r);
    expect(card.messageId).toBeGreaterThan(0);
    const sent = r.fake.callsOf("sendPhoto")[0]!;
    expect(sent.params.reply_markup.inline_keyboard[0]).toHaveLength(2);

    const tappedAt = Date.now();
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.handlerCalls.length === 1);
    await r.controller.idle();
    const finalEdit = r.fake.callsOf("editMessageCaption").at(-1)!;
    expect(finalEdit.at - tappedAt).toBeLessThan(2_000);

    const answer = r.fake.indexOf((call) => call.method === "answerCallbackQuery");
    const hourglass = r.fake.indexOf((call) => call.method === "editMessageCaption" && String(call.params.caption).includes("⏳"));
    const handler = r.fake.indexOf((call) => call.method === "#handler");
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(answer).toBeLessThan(hourglass);
    expect(hourglass).toBeLessThan(handler);
    expect(r.fake.calls[hourglass]!.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(finalEdit.params.caption).toBe("Ololla: syysmainos 1\n\n✅ Mainos aktivoitu");
    expect(r.fake.callsOf("editMessageText")).toHaveLength(0);

    const row = r.store.rows.get(card.id)!;
    expect(row.status).toBe("approved");
    expect(row.decidedByTgUserId).toBe(APPROVER);
    expect(row.outcome).toEqual({ ok: true });
    expect(r.handlerCalls[0]!.request.payload.adId).toBe("120000000001");
    // The buttons are gone after the decision, and only the token hash is stored.
    expect(r.fake.buttons(card.messageId)).toEqual([]);
    const sentToken = parseGateCallbackData(sent.params.reply_markup.inline_keyboard[0][0].callback_data)!.token;
    expect(row.tokenHash).toBe(gateTokenHash(sentToken));
    expect(row.tokenHash).not.toContain(sentToken);
    expect(r.harness.activity.some((entry) => entry.message === "rk9-ads gate: decided")).toBe(true);
  });

  it("edits a text card with editMessageText; a denial is final and runs no handler", async () => {
    const r = await rig();
    const card = await r.controller.sendGateCard({
      companyId: COMPANY_A,
      kind: "activate_ad",
      validUntil: new Date(Date.now() + 60_000),
      card: { media: "text", text: "Hyväksy mainos?" },
    });
    const lastDeny = denyData(r, card.messageId);
    r.fake.tap(BOT_A, { messageId: card.messageId, data: denyData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.store.rows.get(card.id)?.status === "denied");
    await waitFor(() => r.fake.callsOf("editMessageText").length === 1);
    await r.controller.idle();
    expect(r.fake.callsOf("editMessageCaption")).toHaveLength(0);
    expect(r.fake.messages.get(card.messageId)?.text).toBe(`Hyväksy mainos?\n\n${GATE_TEXT.denied}`);
    expect(r.fake.messages.get(card.messageId)?.reply_markup).toEqual({ inline_keyboard: [] });
    expect(r.handlerCalls).toHaveLength(0);
    // A second tap on the decided card changes nothing.
    r.fake.pushUpdate(BOT_A, r.fake.callbackUpdate({ messageId: card.messageId, data: lastDeny, fromId: APPROVER }));
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 2);
    expect(r.fake.callsOf("answerCallbackQuery")[1]!.params.text).toMatch(/Jo käsitelty \(denied\)/);
    expect(r.handlerCalls).toHaveLength(0);
  });

  it("refuses a tap from a user outside the allowlist or from another chat: 'ei oikeutta', state unchanged", async () => {
    const r = await rig();
    const card = await photoCard(r);
    const before = structuredClone(r.store.rows.get(card.id));
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: 999 });
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER, chatId: -100999 });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 2);
    for (const call of r.fake.callsOf("answerCallbackQuery")) expect(call.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(card.id)).toEqual(before);
    expect(r.store.processed.size).toBe(0);
    expect(r.handlerCalls).toHaveLength(0);
    expect(r.harness.logs.filter((log) => log.level === "warn" && log.message === "gate: tap refused")).toHaveLength(2);
    const refusals = r.harness.activity.filter((entry) => entry.message === "rk9-ads gate: unauthorized");
    expect(refusals.map((entry) => entry.metadata?.reason).sort()).toEqual(["chat", "user"]);
  });

  it("refuses a card of a company this bot does not serve", async () => {
    const r = await rig({
      configs: {
        [COMPANY_A]: brandConfig({ telegram: telegramBlock() }),
        [COMPANY_B]: brandConfig({ brandCode: "AUR", telegram: telegramBlock({ chatId: CHAT_A, botTokenRef: secretRef(SECRET_C_BOT) }) }),
      },
      secrets: { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A }, [COMPANY_B]: { [SECRET_C_BOT]: TOKEN_C } },
    });
    // A card of company B, tapped through bot A (same chat id, same approver).
    const card = await photoCard(r, 60_000, COMPANY_B);
    const message = r.fake.messages.get(card.messageId)!;
    r.fake.pushUpdate(BOT_A, r.fake.callbackUpdate({ messageId: message.message_id, data: approveData(r, card.messageId), fromId: APPROVER }));
    await waitFor(() => r.fake.callsOf("answerCallbackQuery", BOT_A).length === 1);
    expect(r.fake.callsOf("answerCallbackQuery", BOT_A)[0]!.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(card.id)?.status).toBe("pending");
  });

  it("on a bot shared by two companies in one chat, only the card's own company approvers can decide it", async () => {
    const OTHER_APPROVER = 77;
    const r = await rig({
      configs: {
        [COMPANY_A]: brandConfig({ telegram: telegramBlock() }),
        [COMPANY_B]: brandConfig({ brandCode: "AUR", telegram: telegramBlock({ allowedUserIds: [String(OTHER_APPROVER)] }) }),
      },
      secrets: { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A }, [COMPANY_B]: { [SECRET_A_BOT]: TOKEN_A } },
    });
    expect(r.controller.summary()).toMatchObject([{ botKey: BOT_A, companies: [COMPANY_A, COMPANY_B] }]);
    const cardA = await photoCard(r, 60_000, COMPANY_A);
    const cardB = await photoCard(r, 60_000, COMPANY_B);
    r.fake.tap(BOT_A, { messageId: cardA.messageId, data: approveData(r, cardA.messageId), fromId: OTHER_APPROVER });
    r.fake.tap(BOT_A, { messageId: cardB.messageId, data: approveData(r, cardB.messageId), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 2);
    for (const call of r.fake.callsOf("answerCallbackQuery")) expect(call.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(cardA.id)?.status).toBe("pending");
    expect(r.store.rows.get(cardB.id)?.status).toBe("pending");
    expect(r.handlerCalls).toHaveLength(0);
  });

  it("checks a spend approval against the saved config: a revocation counts even when no plan has read it", async () => {
    const configs: Record<string, Record<string, unknown>> = { [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) };
    const harness = harnessWith(configs, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    const r = await rig({ harness });
    const card = await photoCard(r);
    // The operator revokes the approver. The configChanged call is lost: no hold, no plan.
    configs[COMPANY_A] = brandConfig({ telegram: telegramBlock({ allowedUserIds: ["99"] }) });
    expect(r.controller.botFor(COMPANY_A)).not.toBeNull();
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.store.rows.get(card.id)?.status).toBe("pending");
    expect(r.store.processed.size).toBe(0);
    expect(r.handlerCalls).toHaveLength(0);
    // Both lists must allow a spend approval: the new approver can approve once a plan has read the config.
    await r.controller.replan("config");
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: 99 });
    await waitFor(() => r.handlerCalls.length === 1);
    await r.controller.idle();
    expect(r.store.rows.get(card.id)?.status).toBe("approved");
  });

  it("refuses a spend approval when a plan that read the old config finishes after the hold", async () => {
    const configs: Record<string, Record<string, unknown>> = { [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) };
    const harness = harnessWith(configs, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    const r = await rig({ harness });
    const card = await photoCard(r);
    // A retry plan reads the old config, then waits on secrets.resolve.
    const resolve = harness.ctx.secrets.resolve;
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let entered = false;
    harness.ctx.secrets.resolve = async (...args: Parameters<typeof resolve>) => {
      entered = true;
      await gate;
      return resolve(...args);
    };
    const plan = r.controller.replan("retry");
    await waitFor(() => entered);
    configs[COMPANY_A] = brandConfig({ telegram: telegramBlock({ allowedUserIds: ["99"] }) });
    r.controller.holdAll("config_changed");
    harness.ctx.secrets.resolve = resolve;
    release();
    await plan;
    // The old plan put the old allowlist back in memory; the tap is still checked against the saved config.
    expect(r.controller.botFor(COMPANY_A)).not.toBeNull();
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.unauthorized);
    expect(r.handlerCalls).toHaveLength(0);
    expect(r.store.rows.get(card.id)?.status).toBe("pending");
  });

  it("refuses a spend approval when the saved config cannot be read, and allows a denial", async () => {
    const r = await rig();
    const card = await photoCard(r);
    r.harness.ctx.config.get = async () => {
      throw new Error("worker RPC timed out");
    };
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.unauthorized);
    const refusal = r.harness.activity.find((entry) => entry.message === "rk9-ads gate: unauthorized");
    expect(refusal?.metadata?.reason).toBe("stale");
    expect(r.store.rows.get(card.id)?.status).toBe("pending");
    r.fake.tap(BOT_A, { messageId: card.messageId, data: denyData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.store.rows.get(card.id)?.status === "denied");
    expect(r.handlerCalls).toHaveLength(0);
  });

  it("expires a card past valid_until on tap: 'vanhentunut', buttons removed, handler not run", async () => {
    const r = await rig();
    const card = await photoCard(r, 30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.store.rows.get(card.id)?.status === "expired");
    await waitFor(() => r.fake.callsOf("editMessageCaption").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.expired);
    const message = r.fake.messages.get(card.messageId)!;
    expect(message.caption).toMatch(/vanhentunut$/);
    expect(message.reply_markup).toEqual({ inline_keyboard: [] });
    expect(r.handlerCalls).toHaveLength(0);
  });

  it("refuses a card whose kind has no handler, without a state change", async () => {
    const r = await rig();
    const token = newGateToken();
    const message = r.fake.addMessage({ chat: { id: Number(CHAT_A) }, text: "Pysäytä kaikki?" });
    await r.store.insertPending({
      id: "99999999-9999-4999-8999-999999999999",
      companyId: COMPANY_A,
      brandCode: "OLL",
      kind: "pause_all",
      tokenHash: gateTokenHash(token),
      chatId: CHAT_A,
      validUntil: new Date(Date.now() + 60_000),
      payload: {},
    });
    await r.store.setMessageId(COMPANY_A, "99999999-9999-4999-8999-999999999999", message.message_id);
    r.fake.tap(BOT_A, { messageId: message.message_id, data: gateCallbackData("approved", token), fromId: APPROVER });
    await waitFor(() => r.fake.callsOf("answerCallbackQuery").length === 1);
    expect(r.fake.callsOf("answerCallbackQuery")[0]!.params.text).toBe(GATE_TEXT.unknownKind);
    expect(r.store.rows.get("99999999-9999-4999-8999-999999999999")?.status).toBe("pending");
    expect(r.store.processed.size).toBe(0);
    await expect(
      r.controller.sendGateCard({ companyId: COMPANY_A, kind: "pause_all", validUntil: new Date(Date.now() + 1000), card: { media: "text", text: "x" } }),
    ).rejects.toThrow(/has no handler/);
  });

  it("moves an approved card to failed when the handler throws, with a generic card line and a redacted error", async () => {
    const r = await rig({
      handler: async () => {
        throw new Error("Meta API: (#100) invalid parameter for https://graph.facebook.com/v23.0/act_1/ads?access_token=EAAGsecretvalue123");
      },
    });
    const card = await photoCard(r);
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.store.rows.get(card.id)?.status === "failed");
    await r.controller.idle();
    expect(r.store.rows.get(card.id)?.error).toMatch(/invalid parameter/);
    expect(r.store.rows.get(card.id)?.error).toContain("access_token=<redacted>");
    expect(r.store.rows.get(card.id)?.outcome).toEqual({ handler: "threw" });
    expect(r.fake.messages.get(card.messageId)?.caption).toBe(`Ololla: syysmainos 1\n\n${GATE_TEXT.failed}`);
    expect(recordedOutput(r.harness)).not.toContain("EAAGsecretvalue123");
  });

  it("marks the handler as started before it runs, and a storage error after success does not fail the card", async () => {
    const store = createMemoryGateStore();
    let seenOutcome: unknown;
    const r = await rig({
      store,
      handler: async (input) => {
        seenOutcome = store.rows.get(input.request.id)?.outcome;
        // The final settle fails once: the ad is live, so the card must not say failed.
        const settle = store.settle.bind(store);
        store.settle = async () => {
          store.settle = settle;
          throw new Error("connection reset");
        };
        return { statusText: "✅ Mainos aktivoitu", outcome: { handler: "done", result: "activated" } };
      },
    });
    const card = await photoCard(r);
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => r.handlerCalls.length === 1);
    await r.controller.idle();
    expect(seenOutcome).toEqual({ handler: "started" });
    expect(store.rows.get(card.id)?.status).toBe("approved");
    expect(r.fake.messages.get(card.messageId)?.caption).toMatch(/✅ Mainos aktivoitu$/);
    // RK9-567 (L2): the write is tried again, so the card does not stay `started` (read later as "result unknown").
    expect(store.rows.get(card.id)?.outcome).toEqual({ handler: "done", result: "activated" });
    expect(r.harness.logs.some((log) => /outcome not stored, trying again/.test(log.message))).toBe(true);
    expect(r.harness.logs.some((log) => /outcome was not stored/.test(log.message))).toBe(false);
  });

  it("gives up on the final outcome only after its repeats, and logs it (RK9-567)", async () => {
    const store = createMemoryGateStore();
    const fake = new FakeTelegram();
    const api = createBotApi({ token: TOKEN_A, fetch: fake.fetch });
    const registry = createGateRegistry(GATE_REQUEST_KINDS);
    const settle = store.settle.bind(store);
    let finalWrites = 0;
    registry.register("activate_ad", async () => {
      store.settle = async () => {
        finalWrites += 1;
        throw new Error("connection reset");
      };
      return { outcome: { handler: "done", result: "activated" } };
    });
    const errors: string[] = [];
    const logger = { ...silentLogger, error: (message: string) => void errors.push(message) };
    const brand: GateBrand = { companyId: COMPANY_A, chatId: CHAT_A, allowedUserIds: [String(APPROVER)] };
    const router = createCallbackRouter({ api, store, registry, brandFor: (id) => (id === COMPANY_A ? brand : null), logger, outcomeRetryDelaysMs: [0, 0] });
    const card = await createGateCard({
      store,
      api,
      registry,
      companyId: COMPANY_A,
      brandCode: "OLL",
      kind: "activate_ad",
      chatId: CHAT_A,
      validUntil: new Date(Date.now() + 60_000),
      card: { media: "photo", mediaUrl: "https://cdn.example/a.jpg", text: "outcome retry" },
    });
    await router.handleUpdate({ ...fake.callbackUpdate({ messageId: card.messageId, data: fake.buttons(card.messageId)[0]!, fromId: APPROVER }), update_id: nextUpdateId++ });
    await router.idle();
    store.settle = settle;
    expect(finalWrites).toBe(3);
    expect(store.rows.get(card.id)?.outcome).toEqual({ handler: "started" });
    expect(errors).toContain("gate: handler succeeded but its outcome was not stored");
  });

  it("does not run the handler when its start marker cannot be stored", async () => {
    const store = createMemoryGateStore();
    const r = await rig({ store });
    const card = await photoCard(r);
    const settle = store.settle.bind(store);
    store.settle = async () => {
      store.settle = settle;
      throw new Error("connection reset");
    };
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    await waitFor(() => store.rows.get(card.id)?.status === "failed");
    await r.controller.idle();
    expect(r.handlerCalls).toHaveLength(0);
    expect(store.rows.get(card.id)?.error).toMatch(/did not run/);
    expect(store.rows.get(card.id)?.outcome).toEqual({ handler: "not_run" });
    expect(r.fake.messages.get(card.messageId)?.caption).toBe(`Ololla: syysmainos 1\n\n${GATE_TEXT.failed}`);
  });

  it("leaves a callback that is not a gate button unanswered (it may belong to another consumer)", async () => {
    const r = await rig();
    const message = r.fake.addMessage({ chat: { id: Number(CHAT_A) }, text: "muu botti" });
    r.fake.tap(BOT_A, { messageId: message.message_id, data: "approve:RK9-1", fromId: APPROVER });
    const offsets = stateOffsetStore(r.harness.ctx.state, BOT_A);
    await waitFor(async () => (await offsets.load()) !== null);
    expect(r.fake.callsOf("answerCallbackQuery")).toHaveLength(0);
  });

  it("never calls ctx.approvals and keeps the token out of every log, activity and state key", async () => {
    const harness = harnessWith({ [COMPANY_A]: brandConfig({ telegram: telegramBlock() }) }, { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A } });
    const approvals = harness.ctx.approvals as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = Object.keys(approvals)
      .filter((key) => typeof approvals[key] === "function")
      .map((key) => vi.spyOn(approvals, key));
    expect(spies.length).toBeGreaterThan(0);
    const fake = new FakeTelegram();
    fake.failNext.set("getUpdates", { status: 502, description: `Bad Gateway for bot${TOKEN_A}` });
    const r = await rig({ harness, fake });
    const card = await photoCard(r);
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER });
    r.fake.tap(BOT_A, { messageId: card.messageId, data: approveData(r, card.messageId), fromId: 999 });
    await waitFor(() => r.handlerCalls.length === 1 && r.fake.callsOf("answerCallbackQuery").length === 2);
    await r.controller.idle();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(manifest.capabilities.filter((capability) => /approv/.test(capability))).toEqual([]);
    const output = recordedOutput(harness);
    expect(output).not.toContain(TOKEN_A);
    expect(output).not.toContain("AAE-company-a");
    expect(harness.logs.some((log) => log.level === "warn" && /getUpdates failed/.test(log.message))).toBe(true);
  });
});

describe("concurrency (in-memory CAS store)", () => {
  it("runs one transition and one handler for N parallel taps and for one update delivered N times", async () => {
    await assertSingleWinner(createMemoryGateStore());
  });
});

let nextUpdateId = 90_000;

async function assertSingleWinner(store: GateStore, companyId = COMPANY_A, n = 25): Promise<void> {
  const fake = new FakeTelegram();
  const api = createBotApi({ token: TOKEN_A, fetch: fake.fetch });
  const registry = createGateRegistry(GATE_REQUEST_KINDS);
  const calls: GateHandlerInput[] = [];
  registry.register("activate_ad", async (input) => {
    calls.push(input);
  });
  const brand: GateBrand = { companyId, chatId: CHAT_A, allowedUserIds: [String(APPROVER)] };
  const router = createCallbackRouter({ api, store, registry, brandFor: (id) => (id === companyId ? brand : null), logger: silentLogger });

  for (const mode of ["taps", "redelivery"] as const) {
    calls.length = 0;
    const answersBefore = fake.callsOf("answerCallbackQuery").length;
    const card = await createGateCard({
      store,
      api,
      registry,
      companyId,
      brandCode: "OLL",
      kind: "activate_ad",
      chatId: CHAT_A,
      validUntil: new Date(Date.now() + 60_000),
      card: { media: "photo", mediaUrl: "https://cdn.example/a.jpg", text: `concurrency ${mode}` },
    });
    const data = fake.buttons(card.messageId)[0]!;
    const base = fake.callbackUpdate({ messageId: card.messageId, data, fromId: APPROVER });
    // Parallel taps: distinct update ids. Redelivery: one update id N times.
    const firstId = nextUpdateId;
    nextUpdateId += n;
    const updates = Array.from({ length: n }, (_, index) => ({
      ...structuredClone(base),
      update_id: mode === "taps" ? firstId + index : firstId,
    }));
    await Promise.all(updates.map((update) => router.handleUpdate(update)));
    await router.idle();
    expect(calls).toHaveLength(1);
    const row = await store.findByTokenHash(gateTokenHash(parseGateCallbackData(data)!.token));
    expect(row?.status).toBe("approved");
    const answers = fake.callsOf("answerCallbackQuery").length - answersBefore;
    // Parallel taps: every tap gets an answer. One update delivered N times: answered once.
    expect(answers).toBe(mode === "taps" ? n : 1);
  }
}

// ---------------------------------------------------------------------------
// Real Postgres: the SQL store through the host's runtime validators
// ---------------------------------------------------------------------------

const describeDb = await describeEmbeddedPostgres("gate");

describeDb("gate on real Postgres (migration 001, host SQL validators)", () => {
  let testDb: PluginTestDatabase;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    testDb = await startPluginTestDatabase({ manifest, packageRoot: PACKAGE_ROOT, prefix: "rk9-ads-gate-" });
    await testDb.applyMigrations();
    companyA = await testDb.createCompany("Ololla");
    companyB = await testDb.createCompany("Sunspot");
  }, EMBEDDED_PG_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  it("stores the token hash only and runs the CAS transitions", async () => {
    const store = createSqlGateStore(testDb.client);
    const token = newGateToken();
    const id = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    await store.insertPending({
      id,
      companyId: companyA,
      brandCode: "OLL",
      kind: "activate_ad",
      tokenHash: gateTokenHash(token),
      chatId: CHAT_A,
      validUntil: new Date(Date.now() + 60_000),
      payload: { card: { media: "text", text: "x" } },
    });
    const [stored] = await testDb.adminQuery<{ token: string }>(`SELECT token FROM ${testDb.namespace}.gate_requests WHERE id = $1`, [id]);
    expect(stored!.token).toBe(gateTokenHash(token));
    expect(stored!.token).not.toContain(token);

    const row = await store.findByTokenHash(gateTokenHash(token));
    expect(row).toMatchObject({ id, companyId: companyA, status: "pending", live: true, payload: { card: { media: "text", text: "x" } } });
    // Another company's id never matches the row.
    expect(await store.decide(companyB, gateTokenHash(token), "approved", APPROVER)).toBe(false);
    expect(await store.expire(companyA, gateTokenHash(token))).toBe(false);
    expect(await store.decide(companyA, gateTokenHash(token), "approved", APPROVER)).toBe(true);
    expect(await store.decide(companyA, gateTokenHash(token), "denied", APPROVER)).toBe(false);
    expect(await store.settle(companyA, id, { from: "approved", to: "failed", error: "boom" })).toBe(true);
    expect((await store.findByTokenHash(gateTokenHash(token)))?.status).toBe("failed");

    expect(await store.markUpdateProcessed(companyA, BOT_A, 1, "callback_query")).toBe(true);
    expect(await store.markUpdateProcessed(companyA, BOT_A, 1, "callback_query")).toBe(false);
  });

  it("expires a pending card past valid_until by the database clock", async () => {
    const store = createSqlGateStore(testDb.client);
    const token = newGateToken();
    await store.insertPending({
      id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
      companyId: companyA,
      brandCode: "OLL",
      kind: "activate_ad",
      tokenHash: gateTokenHash(token),
      chatId: CHAT_A,
      validUntil: new Date(Date.now() - 1_000),
      payload: {},
    });
    expect(await store.decide(companyA, gateTokenHash(token), "approved", APPROVER)).toBe(false);
    expect(await store.expire(companyA, gateTokenHash(token))).toBe(true);
    expect((await store.findByTokenHash(gateTokenHash(token)))?.status).toBe("expired");
  });

  it("runs one transition and one handler for N parallel taps and for one update delivered N times", async () => {
    await assertSingleWinner(createSqlGateStore(testDb.client), companyA);
  });

  it("worker end to end: setup polls, a tap approves, a restart does not repeat it, no core approval rows", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ companies: [company(companyA, "Ololla")] });
    useCompanyConfigs(harness, { [companyA]: brandConfig({ telegram: telegramBlock() }) });
    useCompanySecrets(harness, { [companyA]: { [SECRET_A_BOT]: TOKEN_A } });
    (harness.ctx as { db: unknown }).db = testDb.client;
    const fake = new FakeTelegram();
    fake.maxWaitMs = 200;
    harness.ctx.http.fetch = fake.fetch;
    const approvalsBefore = await testDb.adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM approvals");

    // The worker's own activate_ad handler (A9) runs: a card without an
    // activation binding is refused by it before any Meta call.
    const handled = () => harness.activity.filter((entry) => entry.message.startsWith("rk9-ads gate: activate_ad"));
    async function start() {
      await plugin.definition.setup(harness.ctx);
      const controller = getTelegramController()!;
      await controller.whenPlanned();
      return controller;
    }

    const controller = await start();
    await waitFor(() => fake.callsOf("getUpdates").length > 0);
    const card = await controller.sendGateCard({
      companyId: companyA,
      kind: "activate_ad",
      validUntil: new Date(Date.now() + 60_000),
      card: { media: "photo", mediaUrl: "https://cdn.example/a.jpg", text: "E2E" },
    });
    const tap = fake.callbackUpdate({ messageId: card.messageId, data: fake.buttons(card.messageId)[0]!, fromId: APPROVER });
    const tapId = fake.pushUpdate(BOT_A, tap);
    await waitFor(() => handled().length === 1);
    await controller.idle();
    const [row] = await testDb.adminQuery<{ status: string; decided_by_tg_user_id: string; token: string; outcome: Record<string, unknown> }>(
      `SELECT status, decided_by_tg_user_id, token, outcome FROM ${testDb.namespace}.gate_requests WHERE id = $1`,
      [card.id],
    );
    expect(row).toMatchObject({ status: "denied", outcome: { handler: "done", reason: "invalid_binding" } });
    expect(Number(row!.decided_by_tg_user_id)).toBe(APPROVER);
    expect(row!.token).toMatch(/^[0-9a-f]{64}$/);

    await plugin.definition.onShutdown!();
    const afterShutdown = fake.callsOf("getUpdates").length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.callsOf("getUpdates").length).toBe(afterShutdown);

    // Restart with the offset save lost: Telegram delivers the tap again, processed_updates absorbs it.
    await stateOffsetStore(harness.ctx.state, BOT_A).save(tapId);
    await fake.drained();
    fake.pushUpdate(BOT_A, { ...tap, update_id: tapId });
    const restarted = await start();
    await waitFor(async () => (await stateOffsetStore(harness.ctx.state, BOT_A).load()) === tapId + 1);
    await restarted.idle();
    expect(handled()).toHaveLength(1);
    const [processed] = await testDb.adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${testDb.namespace}.processed_updates WHERE update_id = $1`,
      [tapId],
    );
    expect(processed!.n).toBe(1);
    await plugin.definition.onShutdown!();

    const approvalsAfter = await testDb.adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM approvals");
    expect(approvalsAfter[0]!.n).toBe(approvalsBefore[0]!.n);
    expect(recordedOutput(harness)).not.toContain(TOKEN_A);
  });
});

describe("webhook mode", () => {
  function webhookConfig() {
    return {
      [COMPANY_A]: brandConfig({
        telegram: telegramBlock({ mode: "webhook", webhookSecretRef: secretRef(SECRET_WEBHOOK), webhookUrl: WEBHOOK_URL }),
      }),
    };
  }
  const webhookSecrets = { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A, [SECRET_WEBHOOK]: WEBHOOK_SECRET_VALUE } };

  it("is disabled by default: no setWebhook, no polling, every delivery refused", async () => {
    const r = await rig({ configs: webhookConfig(), secrets: webhookSecrets });
    expect(r.fake.callsOf("setWebhook")).toHaveLength(0);
    expect(r.fake.callsOf("getUpdates")).toHaveLength(0);
    expect(r.harness.logs.some((log) => log.level === "error" && /webhook mode is disabled/.test(log.message))).toBe(true);
    await expect(
      r.controller.handleWebhook({
        endpointKey: "telegram",
        headers: { [TELEGRAM_SECRET_HEADER]: WEBHOOK_SECRET_VALUE },
        rawBody: "{}",
        requestId: "r0",
      }),
    ).rejects.toThrow(/webhook mode is disabled/);
  });

  it("calls setWebhook with secret_token and polls nothing (when enabled)", async () => {
    const r = await rig({ configs: webhookConfig(), secrets: webhookSecrets, webhookMode: "enabled" });
    const [call] = r.fake.callsOf("setWebhook");
    expect(call?.params).toMatchObject({ url: WEBHOOK_URL, secret_token: WEBHOOK_SECRET_VALUE, allowed_updates: ["callback_query", "message"] });
    expect(r.fake.callsOf("getUpdates")).toHaveLength(0);
    expect(r.controller.summary()).toMatchObject([{ mode: "webhook", ready: true }]);
  });

  it("rejects a delivery with a missing or wrong secret header and logs it; accepts the right one", async () => {
    const r = await rig({ configs: webhookConfig(), secrets: webhookSecrets, webhookMode: "enabled" });
    const card = await photoCard(r);
    const update = { update_id: 1, ...r.fake.callbackUpdate({ messageId: card.messageId, data: approveData(r, card.messageId), fromId: APPROVER }) };
    const body = JSON.stringify(update);
    await expect(r.controller.handleWebhook({ endpointKey: "telegram", headers: {}, rawBody: body, requestId: "r1" })).rejects.toThrow(/missing_header/);
    await expect(
      r.controller.handleWebhook({ endpointKey: "telegram", headers: { [TELEGRAM_SECRET_HEADER]: "wrong" }, rawBody: body, requestId: "r2" }),
    ).rejects.toThrow(/mismatch/);
    expect(r.harness.logs.filter((log) => log.message === "rk9-ads telegram: webhook delivery rejected")).toHaveLength(2);
    expect(r.store.rows.get(card.id)?.status).toBe("pending");

    await r.controller.handleWebhook({
      endpointKey: "telegram",
      headers: { [TELEGRAM_SECRET_HEADER]: WEBHOOK_SECRET_VALUE },
      rawBody: body,
      parsedBody: update,
      requestId: "r3",
    });
    await r.controller.idle();
    expect(r.store.rows.get(card.id)?.status).toBe("approved");
    expect(recordedOutput(r.harness)).not.toContain(WEBHOOK_SECRET_VALUE);
  });

  it("verifies against every candidate in constant time and refuses a repeated header", () => {
    const candidates = [
      { digest: webhookSecretDigest("first-secret"), value: "a" },
      { digest: webhookSecretDigest("second-secret"), value: "b" },
    ];
    expect(verifyWebhookSecret({ "X-Telegram-Bot-Api-Secret-Token": "second-secret" }, candidates)).toEqual({ ok: true, value: "b" });
    expect(verifyWebhookSecret({ [TELEGRAM_SECRET_HEADER]: ["first-secret", "first-secret"] }, candidates)).toEqual({ ok: false, reason: "repeated_header" });
    expect(verifyWebhookSecret({ [TELEGRAM_SECRET_HEADER]: "" }, candidates)).toEqual({ ok: false, reason: "missing_header" });
  });

  it("does not start a token that one brand uses in poll mode and another in webhook mode", async () => {
    const r = await rig({
      configs: {
        [COMPANY_A]: brandConfig({ telegram: telegramBlock() }),
        [COMPANY_B]: brandConfig({
          brandCode: "AUR",
          telegram: telegramBlock({ chatId: CHAT_B, mode: "webhook", webhookSecretRef: secretRef(SECRET_WEBHOOK), webhookUrl: WEBHOOK_URL }),
        }),
      },
      secrets: { [COMPANY_A]: { [SECRET_A_BOT]: TOKEN_A }, [COMPANY_B]: { [SECRET_A_BOT]: TOKEN_A, [SECRET_WEBHOOK]: WEBHOOK_SECRET_VALUE } },
      webhookMode: "enabled",
    });
    expect(r.controller.summary()).toEqual([]);
    expect(r.fake.callsOf("getUpdates")).toHaveLength(0);
    expect(r.fake.callsOf("setWebhook")).toHaveLength(0);
    expect(r.harness.logs.some((log) => log.level === "error" && /poll and webhook mode on one bot token/.test(log.message))).toBe(true);
  });
});
