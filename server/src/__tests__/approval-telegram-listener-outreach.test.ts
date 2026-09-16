// RK9-222: end-to-end harness for server/scripts/approval-telegram-listener.mjs's
// outreach draft source. One mock HTTP server plays both the Paperclip API and
// the Telegram Bot API (TG_API_BASE override); the script runs with --once per
// step so each assertion covers exactly one scan + one getUpdates drain.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/approval-telegram-listener.mjs", import.meta.url));
const COMPANY = { id: "c1", name: "Saatavilla" };
const TG_TOKEN = "tok";
const CHAT = "42";

type Draft = {
  id: string;
  prospectId: string;
  subject: string;
  bodyText: string;
  status: string;
  createdAt: string;
  // RK9-224: null models the pre-fix bug (an approved message the scheduler
  // could never reach) — the card must make that visible, not hide it.
  sequenceName: string | null;
};
type Prospect = { id: string; orgName: string; email: string; status: string };

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const drafts: Draft[] = [];
const prospects = new Map<string, Prospect>();
for (let i = 1; i <= 4; i += 1) {
  prospects.set(uuid(100 + i), { id: uuid(100 + i), orgName: `Hoitola ${i}`, email: `info@hoitola${i}.fi`, status: "new" });
  drafts.push({
    id: uuid(i),
    prospectId: uuid(100 + i),
    subject: `Aihe ${i}`,
    bodyText: `Runko ${i}\n\nMikko-Ville Lahti`,
    status: "draft",
    createdAt: new Date(2026, 8, 14, 12, i).toISOString(),
    sequenceName: i === 1 ? null : `saatavilla-pilot`,
  });
}

const apiCalls: Array<{ method: string; url: string; body: unknown }> = [];
const tgCalls: Array<{ method: string; body: any }> = [];
const updatesQueue: unknown[][] = [];
const rejectReasons: Record<string, string> = {};
let nextTgMessageId = 500;

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

let server: Server;
let baseUrl = "";
let stateDir = "";

beforeAll(async () => {
  // each step spawns the script 1–3 times (~1–2 s each on a loaded host)
  vi.setConfig({ testTimeout: 60_000 });
  stateDir = mkdtempSync(join(tmpdir(), "tg-listener-"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readJson(req);
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };

    // ── Telegram Bot API ────────────────────────────────────────────────
    const tg = new RegExp(`^/bot${TG_TOKEN}/(\\w+)$`).exec(url.pathname);
    if (tg) {
      const method = tg[1];
      tgCalls.push({ method, body });
      if (method === "getUpdates") return send(200, { ok: true, result: updatesQueue.shift() ?? [] });
      if (method === "sendMessage") return send(200, { ok: true, result: { message_id: nextTgMessageId++ } });
      return send(200, { ok: true, result: true });
    }

    // ── Paperclip API ───────────────────────────────────────────────────
    if (req.headers.authorization !== "Bearer board-token") return send(401, { error: "unauthorized" });
    apiCalls.push({ method: req.method ?? "", url: url.pathname + url.search, body });
    const p = url.pathname;
    if (p === "/api/companies") return send(200, [COMPANY]);
    if (p === `/api/companies/${COMPANY.id}/approvals`) return send(200, []);
    if (p === `/api/companies/${COMPANY.id}/outreach/messages`) {
      const status = url.searchParams.get("status");
      // newest first, like listMessages()
      return send(200, [...drafts].filter((d) => !status || d.status === status).reverse());
    }
    let m = /^\/api\/companies\/c1\/outreach\/messages\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      const d = drafts.find((x) => x.id === m![1]);
      return d ? send(200, d) : send(404, { error: "not_found" });
    }
    m = /^\/api\/companies\/c1\/outreach\/messages\/([0-9a-f-]{36})\/approve$/.exec(p);
    if (m) {
      const d = drafts.find((x) => x.id === m![1]);
      if (!d) return send(404, { error: "not_found" });
      const pr = prospects.get(d.prospectId);
      if (pr?.status !== "approved") return send(409, { error: "prospect_not_contactable", status: d.status });
      d.status = "approved";
      return send(200, d);
    }
    m = /^\/api\/companies\/c1\/outreach\/messages\/([0-9a-f-]{36})\/reject$/.exec(p);
    if (m) {
      const d = drafts.find((x) => x.id === m![1]);
      if (!d) return send(404, { error: "not_found" });
      d.status = "rejected";
      rejectReasons[d.id] = body?.reason;
      return send(200, d);
    }
    m = /^\/api\/companies\/c1\/outreach\/prospects\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      const pr = prospects.get(m[1]);
      if (!pr) return send(404, { error: "not_found" });
      if (req.method === "PATCH") pr.status = body?.status ?? pr.status;
      return send(200, pr);
    }
    return send(404, { error: "unmatched", path: p });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(stateDir, { recursive: true, force: true });
});

function runOnce(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--once"], {
      env: {
        PATH: process.env.PATH ?? "",
        PAPERCLIP_API_URL: baseUrl,
        PAPERCLIP_TOKEN: "board-token",
        TG_BOT_TOKEN: TG_TOKEN,
        TG_CHAT_ID: CHAT,
        TG_API_BASE: baseUrl,
        STATE_DIR: stateDir,
        OUTREACH_TG_MAX_OPEN: "2",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const readState = () => JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
const sentCards = () => tgCalls.filter((c) => c.method === "sendMessage" && c.body?.reply_markup?.inline_keyboard?.length);
const callback = (data: string, tgMessageId: number, chatId = CHAT) => ({
  update_id: 1000 + tgCalls.length,
  callback_query: { id: `cq-${tgCalls.length}`, data, message: { message_id: tgMessageId, chat: { id: Number(chatId) } } },
});

describe("approval-telegram-listener — outreach drafts (RK9-222)", () => {
  it("posts at most OUTREACH_TG_MAX_OPEN cards, oldest first, from a pre-RK9-222 state.json", async () => {
    // legacy state without `postedOutreach`
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 0, posted: {}, notePrompts: {} }));
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);

    const cards = sentCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].body.text).toContain("Hoitola 1 <info@hoitola1.fi>");
    // RK9-224: draft 1 has no sequence in the fixture — the card must say so visibly.
    expect(cards[0].body.text).toContain("Sekvenssi: ⚠️ ei sekvenssiä");
    expect(cards[0].body.text).toContain("Aihe: Aihe 1");
    expect(cards[0].body.text).toContain("Runko 1");
    expect(cards[0].body.text).toContain("Jonossa vielä 3 luonnosta.");
    expect(cards[0].body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([
      `po:a:${uuid(1)}`,
      `po:r:${uuid(1)}`,
    ]);
    expect(cards[1].body.text).toContain("Hoitola 2");
    expect(cards[1].body.text).toContain("Sekvenssi: saatavilla-pilot");

    const state = readState();
    expect(Object.keys(state.postedOutreach)).toEqual([uuid(1), uuid(2)]);
    expect(state.postedOutreach[uuid(1)]).toMatchObject({ companyId: "c1", prospectId: uuid(101), messageId: 500 });
    expect(state.posted).toEqual({});
  });

  it("ignores taps from another chat", async () => {
    const before = apiCalls.length;
    updatesQueue.push([callback(`po:a:${uuid(1)}`, 500, "99")]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(tgCalls.at(-1)).toMatchObject({ method: "answerCallbackQuery", body: { text: "Ei oikeutta." } });
    expect(apiCalls.slice(before).some((c) => c.url.includes("/approve"))).toBe(false);
    expect(drafts[0].status).toBe("draft");
    // no new cards: both slots still open
    expect(sentCards()).toHaveLength(2);
  });

  it("✅ promotes a `new` prospect on 409 and approves; the freed slot is filled next scan", async () => {
    updatesQueue.push([callback(`po:a:${uuid(1)}`, 500)]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);

    const seq = apiCalls
      .filter((c) => c.method !== "GET" && (c.url.includes(uuid(1)) || c.url.includes(uuid(101))))
      .map((c) => `${c.method} ${c.url}`);
    expect(seq).toEqual([
      `POST /api/companies/c1/outreach/messages/${uuid(1)}/approve`,
      `PATCH /api/companies/c1/outreach/prospects/${uuid(101)}`,
      `POST /api/companies/c1/outreach/messages/${uuid(1)}/approve`,
    ]);
    expect(prospects.get(uuid(101))?.status).toBe("approved");
    expect(drafts[0].status).toBe("approved");
    const edits = tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === 500);
    expect(edits.at(-1)?.body.text).toMatch(/^✅ Hyväksytty/);
    expect(readState().postedOutreach[uuid(1)]).toBeUndefined();

    // next run: slot freed → third draft posted
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(sentCards()).toHaveLength(3);
    expect(sentCards()[2].body.text).toContain("Hoitola 3");
    expect(Object.keys(readState().postedOutreach)).toEqual([uuid(2), uuid(3)]);
  });

  it("❌ asks for a reason via ForceReply and stores it as reject_reason", async () => {
    updatesQueue.push([callback(`po:r:${uuid(2)}`, 501)]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const prompt = tgCalls.filter((c) => c.method === "sendMessage" && c.body?.reply_markup?.force_reply).at(-1);
    expect(prompt?.body.text).toMatch(/Hylkäys/);
    const promptId = nextTgMessageId - 1;
    expect(readState().notePrompts[String(promptId)]).toMatchObject({ kind: "outreach", outreachMessageId: uuid(2) });
    expect(readState().postedOutreach[uuid(2)].handling).toBe(true);

    updatesQueue.push([
      {
        update_id: 2000,
        message: { chat: { id: Number(CHAT) }, text: "Liian yleinen, ei havaintoa", reply_to_message: { message_id: promptId } },
      },
    ]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(drafts[1].status).toBe("rejected");
    expect(rejectReasons[uuid(2)]).toBe("Liian yleinen, ei havaintoa");
    expect(tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === 501).at(-1)?.body.text).toMatch(/^❌ Hylätty/);
    expect(readState().postedOutreach[uuid(2)]).toBeUndefined();
    expect(readState().notePrompts).toEqual({});
  });

  it("closes a card decided elsewhere (CLI review) without touching the message", async () => {
    // draft 3 is open on Telegram; the operator approves it via the CLI meanwhile
    prospects.get(uuid(103))!.status = "approved";
    drafts[2].status = "approved";
    const before = apiCalls.length;
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const card3 = readState().postedOutreach[uuid(3)];
    expect(card3).toBeUndefined();
    expect(tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === 502).at(-1)?.body.text).toBe(
      "☑️ Käsitelty muualla (approved).",
    );
    expect(apiCalls.slice(before).some((c) => c.method === "POST")).toBe(false);
    // draft 4 was posted into the freed slot (the same scan)
    expect(Object.keys(readState().postedOutreach)).toEqual([uuid(4)]);
  });

  it("parks a card whose approval keeps failing instead of re-posting it every scan", async () => {
    // make draft 4's prospect un-promotable: PATCH is refused by the mock via a suppressed status
    const pr = prospects.get(uuid(104))!;
    pr.status = "suppressed";
    const patchGuard = server.listeners("request")[0] as any;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (req.method === "PATCH" && req.url?.includes(uuid(104))) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_transition" }));
        apiCalls.push({ method: "PATCH", url: req.url, body: null });
        return;
      }
      patchGuard(req, res);
    });

    const card4 = readState().postedOutreach[uuid(4)].messageId as number;
    updatesQueue.push([callback(`po:a:${uuid(4)}`, card4)]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(drafts[3].status).toBe("draft");
    expect(tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === card4).at(-1)?.body.text).toMatch(
      /^⚠️ Hyväksyntä epäonnistui \(HTTP 409 — prospect_not_contactable\)/,
    );
    expect(readState().postedOutreach[uuid(4)]).toMatchObject({ parked: true });

    const cardsBefore = sentCards().length;
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(sentCards()).toHaveLength(cardsBefore); // not re-posted
  });

  it("stale card (state lost) answers with guidance and leaves a decided card's text alone", async () => {
    updatesQueue.push([callback(`po:a:${uuid(3)}`, 502)]); // no keyboard on the tapped message → outcome kept
    const before = apiCalls.length;
    const editsBefore = tgCalls.filter((c) => c.method === "editMessageText").length;
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toMatch(/vanhentunut/);
    expect(apiCalls.slice(before).some((c) => c.url.includes("/approve"))).toBe(false);
    expect(tgCalls.filter((c) => c.method === "editMessageText").length).toBe(editsBefore);

    // same tap on a card that still shows buttons → the card is rewritten
    const update = callback(`po:a:${uuid(3)}`, 502);
    (update.callback_query.message as any).reply_markup = { inline_keyboard: [[{ text: "x", callback_data: "y" }]] };
    updatesQueue.push([update]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(tgCalls.filter((c) => c.method === "editMessageText").at(-1)?.body.text).toMatch(/^⚠️ Kortti vanhentunut/);
  });

  it("a decision that throws (API down mid-tap) parks the card instead of locking a slot", async () => {
    // fresh draft 5 gets posted; its approve endpoint drops the connection
    prospects.set(uuid(105), { id: uuid(105), orgName: "Hoitola 5", email: "info@hoitola5.fi", status: "approved" });
    drafts.push({ id: uuid(5), prospectId: uuid(105), subject: "Aihe 5", bodyText: "Runko 5", status: "draft", createdAt: new Date().toISOString() });
    const inner = server.listeners("request")[0] as any;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (req.method === "POST" && req.url?.includes(`${uuid(5)}/approve`)) {
        req.socket.destroy();
        return;
      }
      inner(req, res);
    });
    const run = await runOnce(); // posts card 5
    expect(run.code, run.out).toBe(0);
    const card5 = readState().postedOutreach[uuid(5)].messageId as number;

    updatesQueue.push([callback(`po:a:${uuid(5)}`, card5)]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    const entry = readState().postedOutreach[uuid(5)];
    expect(entry).toMatchObject({ parked: true });
    expect(entry.handling).toBeUndefined();
    expect(tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === card5).at(-1)?.body.text).toMatch(
      /^⚠️ Yhteysvirhe/,
    );
    expect(drafts.find((d) => d.id === uuid(5))?.status).toBe("draft");
  });

  it("truncates an over-long reject reason to the server's 2000-char cap", async () => {
    prospects.set(uuid(106), { id: uuid(106), orgName: "Hoitola 6", email: "info@hoitola6.fi", status: "new" });
    drafts.push({ id: uuid(6), prospectId: uuid(106), subject: "Aihe 6", bodyText: "Runko 6", status: "draft", createdAt: new Date().toISOString() });
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const card6 = readState().postedOutreach[uuid(6)].messageId as number;
    updatesQueue.push([callback(`po:r:${uuid(6)}`, card6)]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    const promptId = nextTgMessageId - 1;
    updatesQueue.push([
      { update_id: 3000, message: { chat: { id: Number(CHAT) }, text: "x".repeat(2500), reply_to_message: { message_id: promptId } } },
    ]);
    const run3 = await runOnce();
    expect(run3.code, run3.out).toBe(0);
    expect(rejectReasons[uuid(6)]).toHaveLength(2000);
    expect(drafts.find((d) => d.id === uuid(6))?.status).toBe("rejected");
  });
});
