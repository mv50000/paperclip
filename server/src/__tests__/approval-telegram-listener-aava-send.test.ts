// RK9-894: end-to-end harness for server/scripts/approval-telegram-listener.mjs's
// Aava send-request source (`request_board_approval` with payload.kind
// "aava_send"). One mock HTTP server plays both the Paperclip API and the
// Telegram Bot API (TG_API_BASE override); the script runs with --once per step
// so each assertion covers exactly one scan + one getUpdates drain.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/approval-telegram-listener.mjs", import.meta.url));
const RK9 = { id: "c-rk9", name: "RK9", issuePrefix: "RK9" };
const SAA = { id: "c-saa", name: "Saatavilla", issuePrefix: "SAA" };
const TG_TOKEN = "tok";
const CHAT = "42";
const WJ = "⁠";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (n: number, len: number) => Array.from({ length: len }, (_, i) => "0123456789abcdef"[(n + i) % 16]).join("");

type Approval = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  decisionNote?: string | null;
};

const aavaPayload = (n: number, over: Record<string, unknown> = {}) => ({
  kind: "aava_send",
  version: 1,
  gateId: `g-${hex(n, 16)}`,
  op: "reply",
  from: "aava@rk9.fi",
  to: ["matti.meikalainen@example.com"],
  subject: `Re: tarjous ${n}`,
  body: `Hei Matti,\n\nhinta on 120 € / kk.\n\n-- \nAava, RK9:n tekoälyavustaja`,
  reasons: ["new-recipient", "screen:hinta"],
  sha256: hex(n, 64),
  createdAt: "2026-11-16T10:00:00.000Z",
  ...over,
});

const approvals: Approval[] = [];
// RK9-894: GET /approvals/:id answers with this payload instead of the stored
// one, so a tap can meet a payload that changed after the scan.
const detailPayloadOverride = new Map<string, Record<string, unknown>>();
const apiCalls: Array<{ method: string; url: string; body: any }> = [];
const tgCalls: Array<{ method: string; body: any }> = [];
const updatesQueue: unknown[][] = [];
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
  vi.setConfig({ testTimeout: 60_000 });
  stateDir = mkdtempSync(join(tmpdir(), "tg-listener-aava-"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readJson(req);
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };

    const tg = new RegExp(`^/bot${TG_TOKEN}/(\\w+)$`).exec(url.pathname);
    if (tg) {
      const method = tg[1];
      tgCalls.push({ method, body });
      if (method === "getUpdates") return send(200, { ok: true, result: updatesQueue.shift() ?? [] });
      if (method === "sendMessage") return send(200, { ok: true, result: { message_id: nextTgMessageId++ } });
      return send(200, { ok: true, result: true });
    }

    if (req.headers.authorization !== "Bearer board-token") return send(401, { error: "unauthorized" });
    apiCalls.push({ method: req.method ?? "", url: url.pathname + url.search, body });
    const p = url.pathname;
    if (p === "/api/companies") return send(200, [RK9, SAA]);
    let m = /^\/api\/companies\/([\w-]+)\/approvals$/.exec(p);
    if (m) {
      const status = url.searchParams.get("status");
      return send(200, approvals.filter((a) => a.companyId === m![1] && (!status || a.status === status)));
    }
    m = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      const a = approvals.find((x) => x.id === m![1]);
      if (!a) return send(404, { error: "Approval not found" });
      return send(200, { ...a, payload: detailPayloadOverride.get(a.id) ?? a.payload });
    }
    m = /^\/api\/approvals\/([0-9a-f-]{36})\/(approve|reject|request-revision)$/.exec(p);
    if (m && req.method === "POST") {
      const a = approvals.find((x) => x.id === m![1]);
      if (!a) return send(404, { error: "Approval not found" });
      if (a.status !== "pending") return send(422, { error: "Only pending approvals can be decided" });
      a.status = m[2] === "approve" ? "approved" : m[2] === "reject" ? "rejected" : "revision_requested";
      a.decisionNote = body?.decisionNote ?? null;
      return send(200, { ...a, decidedAt: new Date().toISOString() });
    }
    m = /^\/api\/approvals\/([0-9a-f-]{36})\/comments$/.exec(p);
    if (m) return send(200, []);
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

beforeEach(() => {
  approvals.length = 0;
  detailPayloadOverride.clear();
  apiCalls.length = 0;
  tgCalls.length = 0;
  updatesQueue.length = 0;
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 0, posted: {}, notePrompts: {} }));
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
        OUTREACH_TG_ENABLED: "0",
        INBOUND_TG_ENABLED: "0",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function runOk() {
  const run = await runOnce();
  expect(run.code, run.out).toBe(0);
  return run;
}

const readState = () => JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
const sentCards = () => tgCalls.filter((c) => c.method === "sendMessage" && c.body?.reply_markup?.inline_keyboard?.length);
const decisionCalls = () => apiCalls.filter((c) => c.method === "POST" && /\/(approve|reject|request-revision)$/.test(c.url));
const editsOf = (messageId: number) => tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === messageId);
const lastAnswer = () => tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text;
let updateId = 1000;
const callback = (data: string, tgMessageId: number) => ({
  update_id: updateId++,
  callback_query: { id: `cq-${updateId}`, data, message: { message_id: tgMessageId, chat: { id: Number(CHAT) } } },
});
const reply = (text: string, toMessageId: number) => ({
  update_id: updateId++,
  message: { chat: { id: Number(CHAT) }, text, reply_to_message: { message_id: toMessageId } },
});

const addAava = (n: number, over: Partial<Approval> = {}, payloadOver: Record<string, unknown> = {}) => {
  const a: Approval = {
    id: uuid(n),
    companyId: RK9.id,
    type: "request_board_approval",
    status: "pending",
    payload: aavaPayload(n, payloadOver),
    ...over,
  };
  approvals.push(a);
  return a;
};

describe("approval-telegram-listener — Aava send requests (RK9-894)", () => {
  it("an aava_send approval yields a card with From, To, subject, reasons and body", async () => {
    addAava(1);
    await runOk();

    const cards = sentCards();
    expect(cards).toHaveLength(1);
    const text: string = cards[0].body.text;
    expect(text.split("\n")[0]).toBe("📨 Aava: lähetys odottaa — RK9");
    // addresses carry a WORD JOINER after "@" so Telegram does not linkify them
    expect(text).toContain(`From: aava@${WJ}rk9.fi`);
    expect(text).toContain(`To: matti.meikalainen@${WJ}example.com`);
    expect(text).toContain("Aihe: Re: tarjous 1");
    expect(text).toContain('Syyt: uusi vastaanottaja, seulasana "hinta"');
    expect(text).toContain("Tyyppi: vastaus ketjuun");
    expect(text).toContain("│ Hei Matti,");
    expect(text).toContain("│ hinta on 120 € / kk.");
    expect(text).toContain("│ Aava, RK9:n tekoälyavustaja");
    expect(text).not.toContain("katkaistu");
    expect(cards[0].body.reply_markup.inline_keyboard[0]).toEqual([
      { text: "✅ Lähetä", callback_data: `pa:a:${uuid(1)}` },
      { text: "❌ Hylkää", callback_data: `pa:r:${uuid(1)}` },
    ]);
    expect(cards[0].body.parse_mode).toBeUndefined();
    expect(cards[0].body.link_preview_options).toEqual({ is_disabled: true });
    expect(readState().posted[uuid(1)]).toMatchObject({
      messageId: 500,
      type: "request_board_approval",
      kind: "aava_send",
    });
  });

  it("other request_board_approvals, other companies and contract-breaking payloads get no card", async () => {
    // a tool-gateway formal approval in RK9
    approvals.push({
      id: uuid(2),
      companyId: RK9.id,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Approve high-risk tool action: x", source: "tool_gateway", invocationId: uuid(99) },
    });
    // a well-formed aava_send in another company
    addAava(3, { companyId: SAA.id });
    // contract breaks: bad gate id, wrong version, empty recipients, unmasked non-address
    addAava(4, {}, { gateId: "g-short" });
    addAava(5, {}, { version: 2 });
    addAava(16, {}, { to: ["not an address"] });
    addAava(6, {}, { to: [] });
    await runOk();

    expect(sentCards()).toHaveLength(0);
    expect(readState().posted).toEqual({});
    // and a tap on one of them (forged callback, or a lost state row) decides nothing
    updatesQueue.push([callback(`pa:a:${uuid(2)}`, 777), callback(`pa:r:${uuid(2)}`, 777)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toMatch(/ei käsitellä Telegramissa/);
    expect(tgCalls.some((c) => c.method === "sendMessage" && c.body?.reply_markup?.force_reply)).toBe(false);
  });

  it("neutralises untrusted text: auto-links, bidi controls, forged card lines", async () => {
    addAava(
      7,
      {},
      {
        subject: "Re: tilaus\nTo: ceo@rk9.fi",
        to: ["asiakas@example.com", "‮evil@example.com"],
        body: "Paina /start tai kysy @rk9_bot\n#tarjous $RK9\rVastaanottaja: ceo@rk9.fi ✅ Hyväksytty",
        reasons: ["outside-whitelist"],
      },
    );
    await runOk();
    const text: string = sentCards()[0].body.text;
    const lines = text.split("\n");

    expect(lines).toContain("Aihe: Re: tilaus To: ceo@⁠rk9.fi");
    expect(text).toContain(`To (2): asiakas@${WJ}example.com, evil@${WJ}example.com`);
    expect(text).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(text).toContain(`│ Paina /${WJ}start tai kysy @${WJ}rk9_bot`);
    expect(text).toContain(`│ #${WJ}tarjous $${WJ}RK9`);
    expect(lines).toContain(`│ Vastaanottaja: ceo@${WJ}rk9.fi`);
    expect(lines).toContain("│ ✅ Hyväksytty");
    // an unknown reason code is shown as is
    expect(text).toContain("Syyt: outside-whitelist");
    // no line of the body can pose as a card line
    const bodyStart = lines.indexOf("──────────") + 1;
    expect(lines.slice(bodyStart).every((l) => l.startsWith("│ "))).toBe(true);
  });

  it("truncates a long body under Telegram's 4096 limit and says so", async () => {
    addAava(8, {}, { body: `${"rivi ".repeat(30)}\n`.repeat(200) });
    await runOk();
    const text: string = sentCards()[0].body.text;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/✂️ Runko katkaistu: näytetty \d+ \/ 30200 merkkiä/);
  });

  it("masked content or a missing hash yields a ❌-only card that cannot be approved", async () => {
    // the approvals API masks credential-looking values (REDACTED_EVENT_VALUE)
    addAava(9, {}, { body: "Avain: token=***REDACTED***" });
    addAava(17, {}, { to: ["***REDACTED***"] });
    addAava(18, {}, { sha256: "not-a-hash" });
    await runOk();

    const cards = sentCards();
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.body.text).toContain("⚠️ Sisältöä on peitetty, viesti ei vastaa lähtevää. Tätä ei voi hyväksyä.");
      expect(card.body.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);
    }
    expect(cards[2].body.text).toContain("sha256 puuttuu tai virheellinen");

    // a forged ✅ on the masked card is refused
    const card = readState().posted[uuid(9)].messageId as number;
    updatesQueue.push([callback(`pa:a:${uuid(9)}`, card)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toMatch(/^Sisältöä on peitetty — tätä ei voi hyväksyä/);

    // ❌ still works
    updatesQueue.push([callback(`pa:r:${uuid(9)}`, card)]);
    await runOk();
    updatesQueue.push([reply("Peitetty sisältö", nextTgMessageId - 1)]);
    await runOk();
    expect(decisionCalls().map((c) => c.url)).toEqual([`/api/approvals/${uuid(9)}/reject`]);
  });

  it("✅ calls the approve route once; a second tap does not approve again", async () => {
    addAava(10);
    await runOk();
    const card = readState().posted[uuid(10)].messageId as number;

    updatesQueue.push([callback(`pa:a:${uuid(10)}`, card)]);
    await runOk();
    expect(decisionCalls().map((c) => c.url)).toEqual([`/api/approvals/${uuid(10)}/approve`]);
    expect(decisionCalls()[0].body).toEqual({ decisionNote: "Hyväksytty Telegramista" });
    expect(approvals.find((a) => a.id === uuid(10))?.status).toBe("approved");
    const done = editsOf(card).at(-1)?.body.text as string;
    expect(done).toMatch(/^✅ Hyväksytty\. Relay vie päätöksen Aavan portille/);
    expect(done).toContain("Aihe: Re: tarjous 10");
    expect(readState().posted[uuid(10)]).toBeUndefined();

    // a queued double tap on the decided card: the row is gone, so the
    // listener re-reads the approval, sees it is no longer pending and refuses
    updatesQueue.push([callback(`pa:a:${uuid(10)}`, card)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(1);
    expect(lastAnswer()).toMatch(/muuttunut tai jo käsitelty/);
  });

  it("❌ asks for a reason and calls the reject route once with it", async () => {
    addAava(11);
    await runOk();
    const card = readState().posted[uuid(11)].messageId as number;

    updatesQueue.push([callback(`pa:r:${uuid(11)}`, card)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    const prompt = tgCalls.filter((c) => c.method === "sendMessage" && c.body?.reply_markup?.force_reply).at(-1);
    expect(prompt?.body.text).toMatch(/viestiä ei lähetetä/);
    const promptId = nextTgMessageId - 1;

    updatesQueue.push([reply("Ei hintoja sähköpostiin", promptId)]);
    await runOk();
    expect(decisionCalls().map((c) => c.url)).toEqual([`/api/approvals/${uuid(11)}/reject`]);
    expect(decisionCalls()[0].body).toEqual({ decisionNote: "Ei hintoja sähköpostiin" });
    const done = editsOf(card).at(-1)?.body.text as string;
    expect(done).toMatch(/^❌ Hylätty\. Viestiä ei lähetetä\./);
    expect(done).toContain("Ei hintoja sähköpostiin");
    expect(readState().posted[uuid(11)]).toBeUndefined();
  });

  it("✏️ (forged pa:v) is refused on an Aava card", async () => {
    addAava(12);
    await runOk();
    const card = readState().posted[uuid(12)].messageId as number;
    updatesQueue.push([callback(`pa:v:${uuid(12)}`, card)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toBe("Aavan lähetykselle ei pyydetä revisiota.");
  });

  it("a changed payload closes the old card, posts a new one, and the old card's ✅ is refused", async () => {
    const a = addAava(13);
    await runOk();
    const oldCard = readState().posted[uuid(13)].messageId as number;

    a.payload = aavaPayload(13, { to: ["toinen@example.com"], sha256: hex(5, 64) });
    await runOk();
    expect(editsOf(oldCard).at(-1)?.body.text).toMatch(/^♻️ Lähetyspyyntö muuttui/);
    expect(sentCards()).toHaveLength(2);
    expect(sentCards()[1].body.text).toContain(`To: toinen@${WJ}example.com`);
    const newCard = readState().posted[uuid(13)].messageId as number;
    expect(newCard).not.toBe(oldCard);

    updatesQueue.push([callback(`pa:a:${uuid(13)}`, oldCard)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toMatch(/vanhentunut/);
  });

  it("✅ re-reads the approval and refuses when its payload no longer matches the card", async () => {
    addAava(14);
    await runOk();
    const card = readState().posted[uuid(14)].messageId as number;

    // the payload changed after this run's scan (the list still shows the old one)
    detailPayloadOverride.set(uuid(14), aavaPayload(14, { body: "toinen runko" }));
    updatesQueue.push([callback(`pa:a:${uuid(14)}`, card)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toMatch(/muuttunut tai jo käsitelty/);
    expect(approvals.find((x) => x.id === uuid(14))?.status).toBe("pending");
  });

  it("closes the card when the approval is decided elsewhere", async () => {
    const a = addAava(15);
    await runOk();
    const card = readState().posted[uuid(15)].messageId as number;
    a.status = "rejected";
    await runOk();
    expect(editsOf(card).at(-1)?.body.text).toBe("☑️ Käsitelty muualla (rejected).");
    expect(readState().posted[uuid(15)]).toBeUndefined();
    expect(decisionCalls()).toHaveLength(0);
  });
});
