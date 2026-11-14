/**
 * Organic posting (RK9-832): staged creative -> Telegram card -> tap -> post.
 *
 * The Telegram controller and router are the real ones on a fake Bot API;
 * Meta is a routing fake that records every call; no real chat and no real
 * IG or FB account. "Live" here means the client mode is live against the
 * fake: the acceptance run is a dry run with a mocked Meta client.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../../src/manifest.js";
import { createLedger } from "../../src/db.js";
import { registerOrganic, ORGANIC_DELETE_ACTION_KEY, ORGANIC_POSTS_ACTION_KEY, ORGANIC_REQUEST_ACTION_KEY, ORGANIC_TOOL } from "../../src/features/organic/register.js";
import { TelegramController } from "../../src/features/telegram/controller.js";
import { gateRegistry, resetGateRegistry } from "../../src/features/telegram/gates.js";
import type { FeatureRuntime } from "../../src/features/types.js";
import { createMemoryGateStore, type MemoryGateStore } from "../../src/kit/testing/memory-gate-store.js";
import { useCompanyConfigs, useCompanySecrets } from "../../src/kit/testing/harness.js";
import { telegramBotKey } from "../../src/kit/telegram/bot-api.js";
import { memoryCreativeSource, type CreativeRow } from "../../src/publish/store.js";
import { memoryOrganicPostStore } from "../../src/organic/store.js";
import type { OrganicService } from "../../src/organic/service.js";
import { brandConfig, COMPANY_A, SECRET_A_BOT, SECRET_A_META, secretRef } from "../fixtures.js";
import { FakeTelegram } from "../helpers/fake-telegram.js";
import { FakeRoutes, graphError } from "../brand/fake-routes.js";

const META_TOKEN = "EAAtest-meta-token-organic-00000000000";
const PAGE_TOKEN = "EAAtest-page-token-organic-11111111111";
const SECRET_A_PAGE = "aaaaaaaa-0000-4000-8000-00000000000c";
const BOT_TOKEN = "1234567:AAE-organic-test-fake-bot-token-012345678";
const BOT = telegramBotKey(BOT_TOKEN);
const CHAT = "-100777";
const APPROVER = 4242;
const STRANGER = 9999;
const IG = "17841414934844046";
const PAGE = "1284777064729996";
const VIDEO_ID = "dddddddd-0000-4000-8000-0000000000a1";
const IMAGE_ID = "dddddddd-0000-4000-8000-0000000000a2";
const CONTAINER = "17900000000000001";
const MEDIA = "17900000000000002";

const LINT = {
  brand: "sunspot",
  mode: "strict",
  ok: true,
  needsHumanReview: true,
  results: [
    { id: "video.resolution", rule: "1080x1920", status: "pass" },
    { id: "source.palette", rule: "Värit vain paletista", status: "partial" },
    { id: "human.helsinki", rule: "Helsinki on tunnistettava", status: "human", detail: "katso kuvat" },
    { id: "human.logo", rule: "Logo loppukortissa", status: "human" },
  ],
};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function config(organic: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return brandConfig({
    meta: { adAccountId: "act_29231592883113369", pageId: PAGE, igUserId: IG, accessTokenRef: secretRef(SECRET_A_META) },
    telegram: { botTokenRef: secretRef(SECRET_A_BOT), chatId: CHAT, allowedUserIds: [String(APPROVER)], mode: "poll" },
    organic: {
      enabled: true,
      mode: "live",
      channels: ["ig_reel", "ig_feed", "fb_video", "fb_photo"],
      pageAccessTokenRef: secretRef(SECRET_A_PAGE),
      ...organic,
    },
    ...extra,
  });
}

function creative(overrides: Partial<CreativeRow> = {}): CreativeRow & { companyId: string } {
  return {
    companyId: COMPANY_A,
    id: VIDEO_ID,
    brand: "OLL",
    kind: "video",
    status: "ready",
    sha256: "a".repeat(64),
    mediaUrl: "https://media.ololla.fi/valon-paluu.mp4",
    posterUrl: "https://media.ololla.fi/valon-paluu.jpg",
    aspectRatio: "9:16",
    copy: { message: "Valo palaa. #ololla" },
    cta: null,
    landingUrlKey: null,
    utmCampaign: null,
    targetAdsetId: null,
    validUntil: null,
    metaVideoId: null,
    ...overrides,
  };
}

/** Graph answers for a working IG account and Page. */
function graph(): FakeRoutes {
  return new FakeRoutes()
    .on("GET me/permissions", { body: { data: [{ permission: "instagram_basic", status: "granted" }, { permission: "instagram_content_publish", status: "granted" }] } })
    .on(`POST ${IG}/media`, { body: { id: CONTAINER } })
    .on(`GET ${CONTAINER}`, { body: { status_code: "FINISHED" } })
    .on(`POST ${IG}/media_publish`, { body: { id: MEDIA } })
    .on(`GET ${MEDIA}`, { body: { permalink: "https://www.instagram.com/reel/ABC/" } })
    .on(`POST ${PAGE}/photos`, { body: { id: "555", post_id: `${PAGE}_777` } })
    .on(`GET ${PAGE}_777`, { body: { permalink_url: "https://www.facebook.com/ololla/posts/777" } })
    .on(`POST ${PAGE}/videos`, { body: { id: "666" } })
    .on(`DELETE ${MEDIA}`, { body: { success: true } })
    .on("DELETE 555", { body: { success: true } });
}

interface Rig {
  harness: TestHarness;
  fake: FakeTelegram;
  meta: FakeRoutes;
  gates: MemoryGateStore;
  posts: ReturnType<typeof memoryOrganicPostStore>;
  creatives: ReturnType<typeof memoryCreativeSource>;
  controller: TelegramController;
  service: OrganicService;
  clock: { now: Date };
}

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.controller.stop()));
});

async function rig(input: { config?: Record<string, unknown>; meta?: FakeRoutes } = {}): Promise<Rig> {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY_A, name: "Ololla" } as Company] });
  const cfg = input.config ?? config();
  useCompanyConfigs(harness, { [COMPANY_A]: cfg });
  useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: META_TOKEN, [SECRET_A_BOT]: BOT_TOKEN, [SECRET_A_PAGE]: PAGE_TOKEN } });
  const meta = input.meta ?? graph();
  const fake = new FakeTelegram();
  fake.maxWaitMs = 200;
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    return fake.fetch(url, init);
  };
  const clock = { now: new Date() };
  const gates = createMemoryGateStore(() => clock.now);
  const posts = memoryOrganicPostStore(
    () => clock.now,
    (_companyId, id) => {
      const row = gates.rows.get(id);
      return row ? { status: row.status, live: row.validUntil.getTime() > clock.now.getTime() } : null;
    },
  );
  const creatives = memoryCreativeSource([creative(), creative({ id: IMAGE_ID, kind: "image", mediaUrl: "https://media.ololla.fi/kuva.jpg", posterUrl: null, aspectRatio: "4:5" })]);
  resetGateRegistry();
  const controller = new TelegramController(harness.ctx, { store: gates, registry: gateRegistry(), fetch: fake.fetch, pollTimeoutSeconds: 1, errorBackoffMs: 20, conflictBackoffMs: 60 });
  const runtime: FeatureRuntime = {
    ctx: harness.ctx,
    ledger: createLedger(harness.ctx.db),
    handleWebhook() {},
    handleApiRoute() {},
    onConfigChanged() {},
    onShutdown() {},
  };
  const service = registerOrganic(runtime, { posts, creatives, transport: () => controller, now: () => clock.now, wait: { intervalMs: 500, timeoutMs: 5_000 } });
  await controller.replan();
  await waitFor(() => controller.summary()[0]?.loop === "running");
  const out = { harness, fake, meta, gates, posts, creatives, controller, service, clock };
  rigs.push(out);
  return out;
}

async function request(r: Rig, params: Record<string, unknown> = {}) {
  return (await r.harness.performAction(ORGANIC_REQUEST_ACTION_KEY, { creativeId: VIDEO_ID, channel: "ig_reel", brandLint: LINT, ...params }, { companyId: COMPANY_A })) as {
    status: string;
    postId: string;
    gateRequestId: string;
  };
}

function cardMessageId(r: Rig, gateRequestId: string): number {
  return r.gates.rows.get(gateRequestId)!.messageId!;
}

async function tap(r: Rig, messageId: number, data: string, fromId = APPROVER): Promise<void> {
  const before = r.fake.callsOf("answerCallbackQuery").length;
  r.fake.tap(BOT, { messageId, data, fromId });
  await waitFor(() => r.fake.callsOf("answerCallbackQuery").length > before);
  await r.controller.idle();
}

function lastAnswer(r: Rig): string {
  return String(r.fake.callsOf("answerCallbackQuery").at(-1)!.params.text);
}

function cardText(r: Rig, messageId: number): string {
  const message = r.fake.messages.get(messageId);
  return String(message?.caption ?? message?.text ?? "");
}

/** Every Meta write except the delete action's. */
function publishWrites(r: Rig) {
  return r.meta.writes().filter((call) => call.method === "POST");
}

describe("organic card", () => {
  it("sends one video card with channel, caption, brand-lint and the human checks; writes nothing to Meta", async () => {
    const r = await rig();
    const result = await request(r);
    expect(result.status).toBe("card_sent");

    const send = r.fake.callsOf("sendVideo").at(-1)!;
    expect(send.params.chat_id).toBe(CHAT);
    expect(send.params.video).toBe("https://media.ololla.fi/valon-paluu.mp4");
    const text = String(send.params.caption);
    expect(text).toContain("Kanava: Instagram Reel");
    expect(text).toContain("Valo palaa. #ololla");
    expect(text).toContain("brand-lint: läpi");
    expect(text).toContain("NEEDS HUMAN REVIEW");
    expect(text).toContain("☐ Helsinki on tunnistettava");
    expect(text).toContain("☐ Logo loppukortissa");
    expect(text).toContain("Ei muistutuksia");
    const buttons = (send.params.reply_markup.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
    expect(buttons.map((button) => button.text)).toEqual(["📣 Julkaise", "❌ Hylkää"]);
    expect(buttons[1]!.callback_data).toMatch(/^g:d:/);

    const post = r.posts.rows[0]!;
    expect(post).toMatchObject({ status: "pending", channel: "ig_reel", mode: "live", gateRequestId: result.gateRequestId });
    expect(post.lint?.summary).toEqual({ pass: 1, partial: 1, fail: 0, skip: 0, human: 2 });
    expect(r.gates.rows.get(result.gateRequestId)).toMatchObject({ kind: "organic_publish", status: "pending" });
    expect(publishWrites(r)).toEqual([]);
    expect(r.fake.callsOf("sendMessage")).toEqual([]);
  });

  it("returns the open post instead of a second card for the same content", async () => {
    const r = await rig();
    const first = await request(r);
    const second = await request(r);
    expect(second).toMatchObject({ status: "exists", postId: first.postId });
    expect(r.fake.callsOf("sendVideo")).toHaveLength(1);
  });

  it("refuses a failed or draft brand-lint, a wrong media kind and a channel the brand has not enabled", async () => {
    const r = await rig({ config: config({ channels: ["ig_reel", "fb_photo"] }) });
    const failed = { ...LINT, ok: true, results: [...LINT.results, { id: "source.safe_top", rule: "top 270", status: "fail" }] };
    await expect(request(r, { brandLint: failed })).rejects.toThrow(/lint_failed: brand-lint failed: source.safe_top/);
    await expect(request(r, { brandLint: { ...LINT, mode: "draft" } })).rejects.toThrow(/lint_draft/);
    await expect(request(r, { brandLint: { ok: true } })).rejects.toThrow(/invalid_lint/);
    await expect(request(r, { brandLint: undefined })).rejects.toThrow(/invalid_lint: brandLint is required/);
    await expect(request(r, { channel: "fb_photo" })).rejects.toThrow(/creative_unusable: fb_photo takes a image creative/);
    await expect(request(r, { channel: "ig_feed", creativeId: IMAGE_ID })).rejects.toThrow(/channel_unavailable: channel ig_feed is not in organic.channels/);
    expect(r.posts.rows).toHaveLength(0);
    expect(r.fake.callsOf("sendVideo")).toHaveLength(0);
  });

  it("refuses a live IG card when the token lacks instagram_content_publish (a new permission is the operator's decision)", async () => {
    const meta = graph().on("GET me/permissions", { body: { data: [{ permission: "ads_management", status: "granted" }] } });
    const r = await rig({ meta });
    await expect(request(r)).rejects.toThrow(/missing_scope: meta.accessTokenRef lacks instagram_basic, instagram_content_publish/);
    expect(r.posts.rows).toHaveLength(0);
  });

  it("the agent tool opens the same card and nothing else", async () => {
    const r = await rig();
    const result = await r.harness.executeTool(ORGANIC_TOOL, { creativeId: VIDEO_ID, channel: "ig_reel", brandLint: LINT }, { companyId: COMPANY_A });
    expect((result as { data: { status: string } }).data.status).toBe("card_sent");
    expect(publishWrites(r)).toEqual([]);
  });
});

describe("organic approve", () => {
  it("publishes an IG Reel once after the tap and records the media id and permalink", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    const approve = r.fake.buttons(messageId)[0]!;
    await tap(r, messageId, approve);

    const writes = publishWrites(r).map((call) => call.key);
    expect(writes).toEqual([`POST ${IG}/media`, `POST ${IG}/media_publish`]);
    const container = new URLSearchParams(publishWrites(r)[0]!.body);
    expect(Object.fromEntries(container)).toEqual({ media_type: "REELS", video_url: "https://media.ololla.fi/valon-paluu.mp4", caption: "Valo palaa. #ololla" });
    expect(publishWrites(r)[0]!.headers.Authorization ?? publishWrites(r)[0]!.headers.authorization).toBe(`Bearer ${META_TOKEN}`);

    const post = r.posts.rows.find((row) => row.id === postId)!;
    expect(post).toMatchObject({ status: "published", metaMediaId: MEDIA, metaContainerId: CONTAINER, permalink: "https://www.instagram.com/reel/ABC/", decidedByTgUserId: APPROVER });
    expect(cardText(r, messageId)).toContain("✅ Julkaistu: Instagram Reel");
    expect(r.gates.rows.get(gateRequestId)!.status).toBe("approved");
    expect(r.harness.activity.some((entry) => entry.message === "rk9-ads organic: published")).toBe(true);

    // A second tap and a redelivered update change nothing.
    await tap(r, messageId, approve);
    expect(lastAnswer(r)).toMatch(/Jo käsitelty/);
    expect(publishWrites(r)).toHaveLength(2);
    expect(r.fake.callsOf("sendMessage")).toEqual([]);
  });

  it("dry run: an approved card sends no Meta write and records the plan", async () => {
    const r = await rig({ config: config({ mode: "dry_run" }) });
    const { gateRequestId, postId } = await request(r);
    expect(String(r.fake.callsOf("sendVideo").at(-1)!.params.caption)).toContain("🧪 Kuivaharjoitus");
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);

    expect(r.meta.writes()).toEqual([]);
    const post = r.posts.rows.find((row) => row.id === postId)!;
    expect(post.status).toBe("dry_run");
    expect((post.payload.planned as Array<{ path: string }>).map((step) => step.path)).toEqual([`${IG}/media`, `${IG}/media_publish`]);
    expect(cardText(r, messageId)).toContain("🧪 Kuivaharjoitus hyväksytty");
  });

  it("posts a Page photo with the Page token", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r, { creativeId: IMAGE_ID, channel: "fb_photo", caption: "Syksyn kuva" });
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    const write = publishWrites(r).at(-1)!;
    expect(write.key).toBe(`POST ${PAGE}/photos`);
    expect(write.headers.Authorization ?? write.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "published", metaMediaId: "555", metaPostId: `${PAGE}_777` });
  });

  it("records a failed publish for the digest and edits the card; no new message", async () => {
    const meta = graph().on(`GET ${CONTAINER}`, { body: { status_code: "ERROR", status: "Error: video too long" } });
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(publishWrites(r).map((call) => call.key)).toEqual([`POST ${IG}/media`]);
    const post = r.posts.rows.find((row) => row.id === postId)!;
    expect(post.status).toBe("failed");
    expect(post.error).toMatch(/video too long/);
    expect(cardText(r, messageId)).toContain("⚠️ Julkaisu epäonnistui");
    expect(r.gates.rows.get(gateRequestId)!.status).toBe("failed");
    expect(r.fake.callsOf("sendMessage")).toEqual([]);
  });

  it("treats a media_publish error as success when the container reports PUBLISHED", async () => {
    let polls = 0;
    const meta = graph()
      .on(`POST ${IG}/media_publish`, graphError(9007, "Media ID is not available"))
      .on(`GET ${CONTAINER}`, () => ({ body: { status_code: polls++ === 0 ? "FINISHED" : "PUBLISHED" } }))
      .on(`GET ${IG}/media`, () => ({
        body: {
          data: [
            { id: "17999999999999999", timestamp: new Date().toISOString(), caption: "Someone else posted this" },
            { id: MEDIA, timestamp: new Date().toISOString(), caption: "Valo palaa. #ololla" },
          ],
        },
      }));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "published", metaMediaId: MEDIA });
  });

  it("stores no media id after a recovery when the caption match is not unique, so a delete cannot hit another post", async () => {
    let polls = 0;
    const meta = graph()
      .on(`POST ${IG}/media_publish`, graphError(9007, "Media ID is not available"))
      .on(`GET ${CONTAINER}`, () => ({ body: { status_code: polls++ === 0 ? "FINISHED" : "PUBLISHED" } }))
      .on(`GET ${IG}/media`, () => ({ body: { data: [{ id: "17999999999999999", timestamp: new Date().toISOString(), caption: "Someone else posted this" }] } }));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "published", metaMediaId: null });
    await expect(
      r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false, confirm: true }, { companyId: COMPANY_A, actor: { type: "user", userId: "board-user-1" } }),
    ).rejects.toThrow(/no_media_id/);
    expect(r.meta.writes().filter((call) => call.method === "DELETE")).toEqual([]);
  });

  it("closes a dry-run card without a Meta write when the brand switched to live after the card, and the reverse", async () => {
    for (const [cardMode, tapMode] of [["dry_run", "live"], ["live", "dry_run"]] as const) {
      const r = await rig({ config: config({ mode: cardMode }) });
      const { gateRequestId, postId } = await request(r);
      useCompanyConfigs(r.harness, { [COMPANY_A]: config({ mode: tapMode }) });
      const messageId = cardMessageId(r, gateRequestId);
      await tap(r, messageId, r.fake.buttons(messageId)[0]!);
      expect(publishWrites(r)).toEqual([]);
      expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "failed", mode: cardMode });
      expect(cardText(r, messageId)).toContain("Julkaisutila on muuttunut");
      await r.controller.stop();
    }
  });

  it("refuses to publish when the creative changed after the card", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    r.creatives.rows[0]!.sha256 = "b".repeat(64);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(publishWrites(r)).toEqual([]);
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("failed");
    expect(cardText(r, messageId)).toContain("Creative on muuttunut");
    expect(r.gates.rows.get(gateRequestId)!.status).toBe("denied");
  });

  it("refuses a stranger's tap and an expired card without publishing", async () => {
    const r = await rig();
    const { gateRequestId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!, STRANGER);
    expect(lastAnswer(r)).toBe("ei oikeutta");
    r.clock.now = new Date(r.clock.now.getTime() + 25 * 3_600_000);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(lastAnswer(r)).toBe("vanhentunut");
    expect(publishWrites(r)).toEqual([]);
    expect(r.gates.rows.get(gateRequestId)!.status).toBe("expired");
  });
});

describe("organic reject reason", () => {
  it("asks for the reason on the card, stores the first preset and ignores a second one", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[1]!);

    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "rejected", decidedByTgUserId: APPROVER, rejectReasonCode: null });
    expect(cardText(r, messageId)).toContain("Valitse syy tai vastaa tähän viestiin");
    const reasons = r.fake.buttons(messageId);
    expect(reasons).toHaveLength(6);
    expect(reasons[2]).toMatch(/^g:r2:/);

    await tap(r, messageId, reasons[2]!);
    expect(lastAnswer(r)).toBe("Syy tallennettu");
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ rejectReasonCode: "claim", rejectReasonText: null });
    expect(cardText(r, messageId)).toContain("Syy: 🔢 Väite tai luku");
    expect(r.fake.buttons(messageId)).toEqual([]);

    await tap(r, messageId, reasons[0]!);
    expect(lastAnswer(r)).toBe("Syy on jo tallennettu");
    expect(r.posts.rows.find((row) => row.id === postId)!.rejectReasonCode).toBe("claim");
    expect(r.meta.writes()).toEqual([]);
    expect(r.fake.callsOf("sendMessage")).toEqual([]);
  });

  it("takes a reply to the card as a typed reason, and ignores a stranger's reply", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[1]!);

    const reply = (fromId: number, text: string) =>
      r.fake.pushUpdate(BOT, { message: { message_id: 900 + fromId, chat: { id: Number(CHAT) }, from: { id: fromId, first_name: "T" }, text, reply_to_message: { message_id: messageId } } });
    reply(STRANGER, "vieras syy");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.posts.rows.find((row) => row.id === postId)!.rejectReasonCode).toBeNull();

    reply(APPROVER, "  Aurinko\u0000 näyttää kuulta  ");
    await waitFor(() => r.posts.rows.find((row) => row.id === postId)!.rejectReasonCode !== null);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ rejectReasonCode: "other", rejectReasonText: "Aurinko näyttää kuulta" });
    expect(cardText(r, messageId)).toContain("Syy: Aurinko näyttää kuulta");
    expect(r.harness.activity.find((entry) => entry.message === "rk9-ads organic: reject reason")?.metadata).toMatchObject({ code: "other", typed: true });
    expect(JSON.stringify(r.harness.activity)).not.toContain("Aurinko");
    expect(r.fake.callsOf("sendMessage")).toEqual([]);
  });
});

describe("organic delete (board)", () => {
  const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } };
  async function published(r: Rig) {
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    return postId;
  }

  it("previews by default, refuses an agent and a missing confirm, then deletes and logs", async () => {
    const r = await rig();
    const postId = await published(r);

    const preview = await r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId }, { companyId: COMPANY_A });
    expect(preview).toMatchObject({ status: "dry_run", planned: { method: "DELETE", path: MEDIA } });
    expect(r.meta.writes().filter((call) => call.method === "DELETE")).toEqual([]);

    await expect(
      r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false, confirm: true }, { companyId: COMPANY_A, actor: { type: "agent", agentId: "agent-1", companyId: COMPANY_A } } as never),
    ).rejects.toThrow(/board_only/);
    await expect(r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false }, BOARD)).rejects.toThrow(/confirm: true/);

    const deleted = await r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false, confirm: true }, BOARD);
    expect(deleted).toMatchObject({ status: "deleted", postId });
    expect(r.meta.writes().filter((call) => call.method === "DELETE").map((call) => call.key)).toEqual([`DELETE ${MEDIA}`]);
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("deleted");
    expect(r.harness.activity.some((entry) => entry.message === "rk9-ads organic: deleted")).toBe(true);

    const again = await r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false, confirm: true }, BOARD);
    expect(again).toMatchObject({ status: "already_deleted" });
    expect(r.meta.writes().filter((call) => call.method === "DELETE")).toHaveLength(1);

    const list = (await r.harness.performAction(ORGANIC_POSTS_ACTION_KEY, {}, { companyId: COMPANY_A })) as { posts: Array<{ status: string }> };
    expect(list.posts.map((post) => post.status)).toEqual(["deleted"]);
  });

  it("refuses to delete a post that is not published", async () => {
    const r = await rig();
    const { postId } = await request(r);
    await expect(r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false, confirm: true }, BOARD)).rejects.toThrow(/not_published/);
    expect(r.meta.writes()).toEqual([]);
  });
});
