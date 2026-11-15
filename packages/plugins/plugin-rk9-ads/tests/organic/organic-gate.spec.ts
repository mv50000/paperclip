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
import {
  registerOrganic,
  ORGANIC_DELETE_ACTION_KEY,
  ORGANIC_POSTS_ACTION_KEY,
  ORGANIC_RECONCILE_ACTION_KEY,
  ORGANIC_REQUEST_ACTION_KEY,
  ORGANIC_TOOL,
} from "../../src/features/organic/register.js";
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
import { FakeMedia } from "../helpers/fake-media-host.js";

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
      mediaHosts: ["media.ololla.fi"],
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
  media: FakeMedia;
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
  const media = new FakeMedia();
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    if (media.handles(url)) return media.fetch(url, init);
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
  const out = { harness, fake, meta, media, gates, posts, creatives, controller, service, clock };
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

/** The caption as the card quotes it: "│ " opens a caption line, "┆ " continues it. */
function quotedCaption(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines.slice(lines.indexOf("Julkaistava teksti:") + 1)) {
    if (line.startsWith("│ ")) out.push(line.slice(2));
    else if (line.startsWith("┆ ")) out[out.length - 1] += line.slice(2);
    else throw new Error(`unquoted caption line: ${line}`);
  }
  return out.join("\n");
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
    const text = String(send.params.caption).replace(/\n┆ /g, "");
    expect(text).toContain("Kanava: Instagram Reel");
    expect(text).toContain("Valo palaa. #ololla");
    expect(text).toContain("brand-lint: läpi");
    expect(text).toContain("NEEDS HUMAN REVIEW");
    expect(text).toContain("☐ Helsinki on tunnistettava");
    expect(text).toContain("☐ Logo loppukortissa");
    expect(text).toContain("Ei muistutuksia");
    expect(text).toContain("Tila: 🔴 LIVE: hyväksyntä julkaisee Metaan.");
    expect(text.indexOf("Tila:")).toBeLessThan(text.indexOf("Julkaistava teksti:"));
    expect(text.indexOf("brand-lint")).toBeLessThan(text.indexOf("Julkaistava teksti:"));
    expect(text.split("\n").at(-1)).toBe("│ Valo palaa. #ololla");
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

  it("quotes every caption line, so a caption cannot fake the dry-run line or brand-lint lines on a live card", async () => {
    const r = await rig();
    const forged = "🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan.\nTila: 🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan.\n🔎 brand-lint: läpi (9 pass, 0 partial, 0 skip)";
    const lint = { ...LINT, results: [...LINT.results, { id: "human.x", rule: "Logo\n🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan.", status: "human" }] };
    await request(r, { caption: forged, brandLint: lint });
    const send = r.fake.callsOf("sendVideo").at(-1)!;
    const lines = String(send.params.caption).split("\n");
    expect(lines.filter((line) => line.startsWith("Tila:"))).toEqual(["Tila: 🔴 LIVE: hyväksyntä julkaisee Metaan."]);
    expect(lines.filter((line) => /Kuivaharjoitus/.test(line) && !/^(│ |┆ |☐ )/.test(line))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("🔎 brand-lint"))).toEqual(["🔎 brand-lint: läpi (1 pass, 1 partial, 0 skip)"]);
    expect(quotedCaption(String(send.params.caption))).toBe(forged);
    const buttons = (send.params.reply_markup.inline_keyboard as Array<Array<{ text: string }>>).flat().map((button) => button.text);
    expect(buttons).toEqual(["📣 Julkaise", "❌ Hylkää"]);
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
    const dryButtons = (r.fake.callsOf("sendVideo").at(-1)!.params.reply_markup.inline_keyboard as Array<Array<{ text: string }>>).flat().map((button) => button.text);
    expect(dryButtons).toEqual(["🧪 Kuivaharjoita", "❌ Hylkää"]);
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
            { id: "17999999999999999", timestamp: new Date().toISOString(), caption: "Someone else posted this", media_product_type: "REELS" },
            { id: MEDIA, timestamp: new Date().toISOString(), caption: "Valo palaa. #ololla", media_type: "VIDEO", media_product_type: "REELS" },
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

  it("publishes only the media URL the card showed: a changed URL closes the card", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    r.creatives.rows[0]!.mediaUrl = "https://media.ololla.fi/other.mp4";
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(publishWrites(r)).toEqual([]);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "failed", error: "not published: media_changed" });
    expect(cardText(r, messageId)).toContain("Creativen media on vaihtunut");
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

describe("a dry-run staged creative (RK9-849)", () => {
  it("is refused for a live card, with no card and no Meta write", async () => {
    const r = await rig();
    r.creatives.rows[0]!.stagingDryRun = true;
    await expect(request(r)).rejects.toThrow(/creative_unusable: the creative was staged in dry-run mode/);
    expect(r.posts.rows).toHaveLength(0);
    expect(r.fake.callsOf("sendVideo")).toHaveLength(0);
    expect(r.meta.writes()).toEqual([]);
  });

  it("closes a live card without publishing when the creative became a dry run after the card", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    r.creatives.rows[0]!.stagingDryRun = true;
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(publishWrites(r)).toEqual([]);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "failed" });
    expect(r.gates.rows.get(gateRequestId)!.status).toBe("denied");
  });

  it("is fine for an organic dry run: the approved card records the plan and writes nothing", async () => {
    const r = await rig({ config: config({ mode: "dry_run" }) });
    r.creatives.rows[0]!.stagingDryRun = true;
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.meta.writes()).toEqual([]);
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("dry_run");
  });
});

describe("organic media lock (RK9-852 M2)", () => {
  const VIDEO_URL = "https://media.ololla.fi/valon-paluu.mp4";

  it("records the media validators on the card and publishes when they still match", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    expect(r.posts.rows.find((row) => row.id === postId)!.payload.mediaLock).toMatchObject({ host: "media.ololla.fi", contentLength: 1048576, etag: '"v1"', contentType: "video/mp4" });
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.media.heads).toEqual([VIDEO_URL, VIDEO_URL]);
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("published");
  });

  it("refuses a live card on a host outside organic.mediaHosts; a dry-run card only warns", async () => {
    const live = await rig({ config: config({ mediaHosts: ["cdn.ololla.fi"] }) });
    await expect(request(live)).rejects.toThrow(/media_untrusted/);
    expect(live.posts.rows).toHaveLength(0);
    expect(live.media.heads).toEqual([]);
    await live.controller.stop();

    const dry = await rig({ config: config({ mode: "dry_run", mediaHosts: [] }) });
    await request(dry);
    const text = String(dry.fake.callsOf("sendVideo").at(-1)!.params.caption);
    expect(text.replace(/\n┆ /g, "")).toContain("⚠️ Live-tila hylkäisi tämän: media host media.ololla.fi is not in organic.mediaHosts");
    expect(text.indexOf("Live-tila hylkäisi")).toBeLessThan(text.indexOf("Julkaistava teksti:"));
  });

  it("refuses a live card when the host gives no ETag or Last-Modified (Sunspot's host today)", async () => {
    const r = await rig();
    r.media.file(VIDEO_URL).headers = { "content-type": "video/mp4", "content-length": "1048576" };
    await expect(request(r)).rejects.toThrow(/media_unlockable/);
    expect(r.posts.rows).toHaveLength(0);
  });

  it("closes the card without a Meta write when the file changed or vanished after the card", async () => {
    for (const change of [
      (file: { status: number; headers: Record<string, string> }) => (file.headers.etag = '"v2"'),
      (file: { status: number; headers: Record<string, string> }) => (file.headers["content-length"] = "1048577"),
      (file: { status: number; headers: Record<string, string> }) => (file.status = 404),
    ]) {
      const r = await rig();
      const { gateRequestId, postId } = await request(r);
      change(r.media.file(VIDEO_URL));
      const messageId = cardMessageId(r, gateRequestId);
      await tap(r, messageId, r.fake.buttons(messageId)[0]!);
      expect(publishWrites(r)).toEqual([]);
      expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "failed" });
      expect(r.posts.rows.find((row) => row.id === postId)!.error).toMatch(/media_changed/);
      expect(cardText(r, messageId)).toContain("Media on muuttunut tai vanhentunut");
      await r.controller.stop();
    }
  });

  it("ends the card before the media host drops the file, and refuses a later publish without Meta", async () => {
    const r = await rig({ config: config({ mediaHostTtlHours: 2 }) });
    const modified = new Date(r.clock.now.getTime() - 30 * 60_000);
    r.media.file(VIDEO_URL).headers["last-modified"] = modified.toUTCString();
    const result = (await request(r)) as unknown as { validUntil: string; gateRequestId: string; postId: string };
    const expected = Math.floor(modified.getTime() / 1000) * 1000 + 2 * 3_600_000 - 10 * 60_000;
    expect(Date.parse(result.validUntil)).toBe(expected);
    // The gate would expire the card at validUntil; the publish refuses on its own too.
    r.clock.now = new Date(expected - 1_000);
    r.posts.rows[0]!.payload = { ...r.posts.rows[0]!.payload, mediaLock: { ...(r.posts.rows[0]!.payload.mediaLock as object), expiresAt: new Date(expected).toISOString() } };
    const messageId = cardMessageId(r, result.gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(publishWrites(r)).toEqual([]);
    expect(r.posts.rows.find((row) => row.id === result.postId)!.error).toMatch(/media_expired/);
  });

  it("refuses a live card with a host TTL when the host gives no Last-Modified, and a card the file outlives too briefly", async () => {
    const r = await rig({ config: config({ mediaHostTtlHours: 2 }) });
    delete r.media.file(VIDEO_URL).headers["last-modified"];
    await expect(request(r)).rejects.toThrow(/media_unlockable: organic.mediaHostTtlHours/);
    r.media.file(VIDEO_URL).headers["last-modified"] = new Date(r.clock.now.getTime() - 110 * 60_000).toUTCString();
    await expect(request(r)).rejects.toThrow(/media_expiring/);
    expect(r.posts.rows).toHaveLength(0);
  });

  it("refuses a post whose card has no media lock (a card from before RK9-852)", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    const row = r.posts.rows.find((entry) => entry.id === postId)!;
    delete row.payload.mediaLock;
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(publishWrites(r)).toEqual([]);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("not published: media_unlocked");
  });
});

describe("organic card text (RK9-852)", () => {
  it("quotes every phone line of a long caption line, so a forged status line cannot start a screen line", async () => {
    const r = await rig();
    const forged = `${"⠀".repeat(40)}Tila: 🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan.`;
    await request(r, { caption: forged });
    const text = String(r.fake.callsOf("sendVideo").at(-1)!.params.caption);
    const lines = text.split("\n");
    const captionLines = lines.slice(lines.indexOf("Julkaistava teksti:") + 1);
    expect(captionLines.length).toBeGreaterThan(2);
    expect(captionLines.every((line) => line.startsWith("│ ") || line.startsWith("┆ "))).toBe(true);
    expect(lines.filter((line) => line.startsWith("Tila:"))).toEqual(["Tila: 🔴 LIVE: hyväksyntä julkaisee Metaan."]);
    expect(quotedCaption(text)).toBe(forged);
  });

  it("says on a poster card that the image is not the video, and links the video", async () => {
    const r = await rig();
    r.fake.failNext.set("sendVideo", { status: 400, description: "Bad Request: wrong file identifier/HTTP URL specified" });
    await request(r);
    expect(r.fake.callsOf("sendVideo")).toHaveLength(1);
    const photo = r.fake.callsOf("sendPhoto").at(-1)!;
    expect(photo.params.photo).toBe("https://media.ololla.fi/valon-paluu.jpg");
    expect(String(photo.params.caption)).toMatch(/^⚠️ Kuva on videon kansikuva, ei itse video\. Katso video ennen hyväksyntää:\n🔗 https:\/\/media\.ololla\.fi\/valon-paluu\.mp4\n/);
  });

  it("cleans and quotes the brand-lint rule text: no NEL line break, no bidi control", async () => {
    const r = await rig();
    const lint = { ...LINT, results: [...LINT.results, { id: "human.y", rule: "Logo\u0085Tila: 🧪 Kuivaharjoitus‮", status: "human" }] };
    await request(r, { brandLint: lint });
    const text = String(r.fake.callsOf("sendVideo").at(-1)!.params.caption);
    expect(text).not.toContain("\u0085");
    expect(text).not.toContain("‮");
    expect(text.split("\n").filter((line) => /Kuivaharjoitus/.test(line) && !/^(│ |┆ |☐ )/.test(line))).toEqual([]);
  });
});

describe("organic publish with an unknown result (RK9-852)", () => {
  const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } };

  it("keeps the post open when media_publish got no answer, so the same content gets no second card", async () => {
    let status = "FINISHED";
    const meta = graph()
      .on(`POST ${IG}/media_publish`, new Error("socket hang up"))
      .on(`GET ${CONTAINER}`, () => ({ body: { status_code: status } }));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    const post = () => r.posts.rows.find((row) => row.id === postId)!;
    expect(post()).toMatchObject({ status: "publishing", metaContainerId: CONTAINER });
    expect(post().error).toMatch(/^result unknown: /);
    expect(cardText(r, messageId)).toContain("Julkaisun tulos on epäselvä");
    expect(await request(r)).toMatchObject({ status: "exists", postId, postStatus: "publishing" });

    // Too early: the publish may still land.
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId }, BOARD)).toMatchObject({ status: "too_early" });
    r.clock.now = new Date(r.clock.now.getTime() + 6 * 60_000);
    status = "FINISHED";
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId }, BOARD)).toMatchObject({ status: "failed" });
    expect(post().status).toBe("failed");
    expect(post().error).toMatch(/IG container reports FINISHED/);
    expect(publishWrites(r).map((call) => call.key)).toEqual([`POST ${IG}/media`, `POST ${IG}/media_publish`]);
  });

  it("reconciles a live container to published; a caption-matched id cannot be deleted from the board", async () => {
    let status = "FINISHED";
    const meta = graph()
      .on(`POST ${IG}/media_publish`, new Error("socket hang up"))
      .on(`GET ${CONTAINER}`, () => ({ body: { status_code: status } }))
      .on(`GET ${IG}/media`, () => ({
        body: { data: [{ id: MEDIA, timestamp: r.clock.now.toISOString(), caption: "Valo palaa. #ololla", media_type: "VIDEO", media_product_type: "REELS" }] },
      }));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    status = "PUBLISHED";
    r.clock.now = new Date(r.clock.now.getTime() + 6 * 60_000);
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId }, BOARD)).toMatchObject({ status: "published" });
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "published", metaMediaId: MEDIA });
    await expect(r.harness.performAction(ORGANIC_DELETE_ACTION_KEY, { postId, dryRun: false, confirm: true }, BOARD)).rejects.toThrow(/media_id_unverified/);
    expect(r.meta.writes().filter((call) => call.method === "DELETE")).toEqual([]);
  });

  it("the reconcile action is board-only and writes nothing to Meta", async () => {
    const r = await rig();
    const { postId } = await request(r);
    await expect(
      r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId }, { companyId: COMPANY_A, actor: { type: "agent", agentId: "agent-1", companyId: COMPANY_A } } as never),
    ).rejects.toThrow(/board_only/);
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId }, BOARD)).toMatchObject({ status: "not_publishing", detail: "pending" });
    expect(r.meta.writes()).toEqual([]);
  });

  it("an unanswered Page photo stays open; the job closes it once Meta shows exactly one matching photo", async () => {
    let photos: Array<Record<string, unknown>> = [];
    const meta = graph()
      .on(`POST ${PAGE}/photos`, { status: 500, body: { error: { message: "An unknown error occurred", code: 1, fbtrace_id: "t" } } })
      .on(`GET ${PAGE}/photos`, () => ({ body: { data: photos } }));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r, { creativeId: IMAGE_ID, channel: "fb_photo" });
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    const post = () => r.posts.rows.find((row) => row.id === postId)!;
    expect(post().status).toBe("publishing");

    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    // No unique match yet: the job leaves it open.
    expect(await r.service.reconcileStale()).toEqual({ checked: 1, closed: 0 });
    expect(post().status).toBe("publishing");
    photos = [
      { id: "555", created_time: r.clock.now.toISOString(), name: "Valo palaa. #ololla" },
      { id: "556", created_time: new Date(Date.parse(post().decidedAt!) - 3_600_000).toISOString(), name: "Valo palaa. #ololla" },
    ];
    // The unclear check touched the row; the job looks again after another idle period.
    expect(await r.service.reconcileStale()).toEqual({ checked: 0, closed: 0 });
    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    expect(await r.service.reconcileStale()).toEqual({ checked: 1, closed: 1 });
    expect(post()).toMatchObject({ status: "published", metaMediaId: "555" });
    expect(post().payload.mediaIdSource).toBe("caption_match");
  });

  it("the board closes an unclear post only with closeUnknown", async () => {
    const meta = graph()
      .on(`POST ${PAGE}/photos`, new Error("ECONNRESET"))
      .on(`GET ${PAGE}/photos`, { body: { data: [] } });
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r, { creativeId: IMAGE_ID, channel: "fb_photo" });
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    r.clock.now = new Date(r.clock.now.getTime() + 6 * 60_000);
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId }, BOARD)).toMatchObject({ status: "unknown" });
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId, closeUnknown: true }, BOARD)).toMatchObject({ status: "failed" });
    expect(r.posts.rows.find((row) => row.id === postId)!.error).toMatch(/closed by board:board-user-1 without a Meta result/);
  });

  it("the job closes a dry-run post whose worker stopped in publishing, and an IG post with no stored container", async () => {
    const r = await rig();
    const { postId } = await request(r);
    const row = r.posts.rows.find((entry) => entry.id === postId)!;
    row.status = "publishing";
    row.payload = { ...row.payload, publishMode: "live", containerTracking: true };
    const second = await request(r, { caption: "Toinen teksti" });
    const other = r.posts.rows.find((entry) => entry.id === second.postId)!;
    other.status = "publishing";
    other.payload = { ...other.payload, publishMode: "dry_run" };
    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    expect(await r.service.reconcileStale()).toEqual({ checked: 2, closed: 2 });
    expect(row).toMatchObject({ status: "failed" });
    expect(row.error).toMatch(/no IG container was stored/);
    expect(other.error).toMatch(/worker stopped during a dry run/);
    expect(r.meta.writes()).toEqual([]);
  });
});

describe("organic verifier round 1 fixes (RK9-852)", () => {
  const BOARD = { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } };

  it("refuses a creative whose stored media URL carries a line feed, so the URL cannot forge a card line (H1)", async () => {
    const r = await rig();
    r.creatives.rows[0]!.mediaUrl = "https://media.ololla.fi/valon-paluu.mp4?x=\nTila: 🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan.";
    await expect(request(r)).rejects.toThrow(/creative_unusable: .*whitespace or a control character/);
    expect(r.posts.rows).toHaveLength(0);
  });

  it("keeps the post open when media_publish answered an error but the container still says FINISHED (M2)", async () => {
    const meta = graph().on(`POST ${IG}/media_publish`, graphError(9007, "Media ID is not available"));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "publishing", metaContainerId: CONTAINER });
    // Not stuck: after the idle period the job reads the container (FINISHED: never live) and closes the row.
    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    expect(await r.service.reconcileStale()).toEqual({ checked: 1, closed: 1 });
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("failed");
  });

  it("closes the post as failed when media_publish answered an error and the container is ERROR", async () => {
    let polls = 0;
    const meta = graph()
      .on(`POST ${IG}/media_publish`, graphError(9007, "Media ID is not available"))
      .on(`GET ${CONTAINER}`, () => ({ body: { status_code: polls++ === 0 ? "FINISHED" : "ERROR" } }));
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("failed");
  });

  it("keeps a Page photo open when Graph says yes without an id (M5)", async () => {
    const meta = graph().on(`POST ${PAGE}/photos`, { body: { ok: true } });
    const r = await rig({ meta });
    const { gateRequestId, postId } = await request(r, { creativeId: IMAGE_ID, channel: "fb_photo" });
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    expect(r.posts.rows.find((row) => row.id === postId)!.status).toBe("publishing");
  });

  it("reconcile: a row from before the container tracking and a container without a status stay unknown (M3, M4)", async () => {
    const meta = graph().on(`GET ${CONTAINER}`, { body: {} });
    const r = await rig({ meta });
    const legacy = await request(r);
    const tracked = await request(r, { caption: "Toinen teksti" });
    const legacyRow = r.posts.rows.find((row) => row.id === legacy.postId)!;
    const trackedRow = r.posts.rows.find((row) => row.id === tracked.postId)!;
    legacyRow.status = "publishing";
    legacyRow.payload = { ...legacyRow.payload, publishMode: "live" };
    trackedRow.status = "publishing";
    trackedRow.metaContainerId = CONTAINER;
    trackedRow.payload = { ...trackedRow.payload, publishMode: "live", containerTracking: true };
    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId: legacy.postId }, BOARD)).toMatchObject({ status: "unknown", detail: expect.stringMatching(/predates/) });
    expect(await r.harness.performAction(ORGANIC_RECONCILE_ACTION_KEY, { postId: tracked.postId }, BOARD)).toMatchObject({ status: "unknown", detail: expect.stringMatching(/no status/) });
    expect(legacyRow.status).toBe("publishing");
    expect(trackedRow.status).toBe("publishing");
  });

  it("reconcile touches an unclear row, so the job checks the other stuck rows first (L1)", async () => {
    const r = await rig({ meta: graph().on(`GET ${CONTAINER}`, { body: {} }) });
    const { postId } = await request(r);
    const row = r.posts.rows.find((entry) => entry.id === postId)!;
    row.status = "publishing";
    row.metaContainerId = CONTAINER;
    row.payload = { ...row.payload, publishMode: "live", containerTracking: true };
    r.clock.now = new Date(r.clock.now.getTime() + 31 * 60_000);
    expect(await r.service.reconcileStale()).toEqual({ checked: 1, closed: 0 });
    expect(await r.service.reconcileStale()).toEqual({ checked: 0, closed: 0 });
  });
});

describe("organic recovery match (RK9-852 L-a, L-b)", () => {
  function recovering(items: () => Array<Record<string, unknown>>): FakeRoutes {
    let polls = 0;
    return graph()
      .on(`POST ${IG}/media_publish`, graphError(9007, "Media ID is not available"))
      .on(`GET ${CONTAINER}`, () => ({ body: { status_code: polls++ === 0 ? "FINISHED" : "PUBLISHED" } }))
      .on(`GET ${IG}/media`, () => ({ body: { data: items() } }));
  }
  const item = (id: string, caption: string) => ({ id, timestamp: new Date().toISOString(), caption, media_type: "VIDEO", media_product_type: "REELS" });

  async function approveRecovered(r: Rig, params: Record<string, unknown> = {}) {
    const { gateRequestId, postId } = await request(r, params);
    const messageId = cardMessageId(r, gateRequestId);
    await tap(r, messageId, r.fake.buttons(messageId)[0]!);
    return r.posts.rows.find((row) => row.id === postId)!;
  }

  it("two items with the caption: no media id (L-b)", async () => {
    const r = await rig({ meta: recovering(() => [item(MEDIA, "Valo palaa. #ololla"), item("17999999999999999", "Valo palaa. #ololla")]) });
    expect(await approveRecovered(r)).toMatchObject({ status: "published", metaMediaId: null });
  });

  it("an empty caption never matches, even a single empty item (L-a)", async () => {
    const r = await rig({ meta: recovering(() => [item(MEDIA, "")]) });
    r.creatives.rows[0]!.copy = { message: "" };
    expect(await approveRecovered(r, { caption: "" })).toMatchObject({ status: "published", metaMediaId: null });
  });

  it("skips an id another post already holds, and an item of another kind (L-a)", async () => {
    const r = await rig({ meta: recovering(() => [item(MEDIA, "Valo palaa. #ololla"), { ...item("17999999999999998", "Valo palaa. #ololla"), media_type: "IMAGE", media_product_type: "FEED" }]) });
    const earlier = await request(r, { caption: "Toinen" });
    r.posts.rows.find((row) => row.id === earlier.postId)!.metaMediaId = MEDIA;
    expect(await approveRecovered(r)).toMatchObject({ status: "published", metaMediaId: null });
  });
});

describe("organic stuck rows and the reason race (RK9-852)", () => {
  it("a pending post that never got a card id expires after 10 minutes, so the content can get a card", async () => {
    const r = await rig();
    const content = await request(r);
    const row = r.posts.rows.find((entry) => entry.id === content.postId)!;
    row.gateRequestId = null;
    expect(await request(r)).toMatchObject({ status: "exists", postId: row.id });
    r.clock.now = new Date(r.clock.now.getTime() + 11 * 60_000);
    const again = await request(r);
    expect(again).toMatchObject({ status: "card_sent" });
    expect(row.status).toBe("expired");
  });

  it("a reason tap that overtakes onDenied records the deny tapper, not the reason giver (L-c)", async () => {
    const r = await rig();
    const { gateRequestId, postId } = await request(r);
    const gate = r.gates.rows.get(gateRequestId)!;
    await r.service.onReason({ ...gate, status: "denied", live: true, decidedByTgUserId: APPROVER, decidedAt: r.clock.now }, 777, "visual", null);
    expect(r.posts.rows.find((row) => row.id === postId)).toMatchObject({ status: "rejected", decidedByTgUserId: APPROVER, rejectReasonCode: "visual" });
  });
});
