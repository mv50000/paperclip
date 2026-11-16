// RK9-894: end-to-end harness for server/scripts/approval-telegram-listener.mjs's
// Aava send-request source (`request_board_approval` with payload.kind
// "aava_send"). One mock HTTP server plays both the Paperclip API and the
// Telegram Bot API (TG_API_BASE override); the script runs with --once per step
// so each assertion covers exactly one scan + one getUpdates drain.
import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmodSync, chownSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/approval-telegram-listener.mjs", import.meta.url));

// The character rules live in one self-contained block of the script, marked
// `// <aava-charset>` … `// </aava-charset>`; load it on its own.
const charset = (() => {
  const src = readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("// <aava-charset>");
  const end = src.indexOf("// </aava-charset>");
  if (start < 0 || end < start) throw new Error("aava-charset block not found");
  return new Function(
    `${src.slice(start, end)}\nreturn { isAavaTextCodePoint, aavaApprovalBlocker, aavaReasonLabel };`,
  )() as {
    isAavaTextCodePoint: (cp: number) => boolean;
    aavaApprovalBlocker: (p: Record<string, unknown>) => { field: string; rule: string; codePoint?: number } | null;
    aavaReasonLabel: (code: unknown) => string | null;
  };
})();
const LIST_EXTRAS = [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026, 0x20ac];
const inList = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0x17f && cp !== 0xad) || LIST_EXTRAS.includes(cp);
const buttons = (card: any) => card.reply_markup.inline_keyboard[0].map((b: any) => b.text);
const RK9 = { id: "c-rk9", name: "RK9", issuePrefix: "RK9" };
const SAA = { id: "c-saa", name: "Saatavilla", issuePrefix: "SAA" };
const TG_TOKEN = "tok";
const CHAT = "42";
const WJ = "⁠";

// RK9-922: the signing key. RFC 8032 section 7.1 TEST 1 (a published test
// vector, not a live key): built from its 32-byte seed at run time so no PEM
// private key is committed. The gate (RK9-920) uses the same vector.
const RFC8032_TEST1_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_TEST1_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const signingKey = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${RFC8032_TEST1_SEED}`, "hex"),
  format: "der",
  type: "pkcs8",
});
const verifyKey = createPublicKey({
  key: Buffer.from(`302a300506032b6570032100${RFC8032_TEST1_PUBLIC}`, "hex"),
  format: "der",
  type: "spki",
});
const SIGNED_NOTE_RE = /^Hyväksytty Telegramista · aava-sig:v1:([A-Za-z0-9+/]{86}==)$/;
const signedMessage = (approvalId: string, gateId: string, sha256: string) =>
  `aava-send-v1\n${approvalId}\n${gateId}\n${sha256}\napprove`;
const verifies = (message: string, b64: string) =>
  verify(null, Buffer.from(message, "utf8"), verifyKey, Buffer.from(b64, "base64"));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (n: number, len: number) => Array.from({ length: len }, (_, i) => "0123456789abcdef"[(n + i) % 16]).join("");

type Approval = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
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
// … and these top-level fields (status, requestedByAgentId) on the detail read only.
const detailFieldOverride = new Map<string, Partial<Approval>>();
const apiCalls: Array<{ method: string; url: string; body: any }> = [];
// RK9-922: the pending list answers 500, so a run's scan posts and re-posts
// nothing and a tap meets the state row exactly as written.
let failApprovalList = false;
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
let keyDir = "";
let keyPath = "";
// Writes a key file with the given mode and returns its path.
const keyFile = (name: string, content: string | Buffer, mode = 0o400) => {
  const path = join(keyDir, name);
  rmSync(path, { force: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
};

beforeAll(async () => {
  vi.setConfig({ testTimeout: 60_000 });
  stateDir = mkdtempSync(join(tmpdir(), "tg-listener-aava-"));
  keyDir = mkdtempSync(join(tmpdir(), "tg-listener-aava-key-"));
  keyPath = keyFile("approve.key", signingKey.export({ format: "pem", type: "pkcs8" }));
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
      if (failApprovalList) return send(500, { error: "down" });
      const status = url.searchParams.get("status");
      return send(200, approvals.filter((a) => a.companyId === m![1] && (!status || a.status === status)));
    }
    m = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      const a = approvals.find((x) => x.id === m![1]);
      if (!a) return send(404, { error: "Approval not found" });
      return send(200, { ...a, payload: detailPayloadOverride.get(a.id) ?? a.payload, ...detailFieldOverride.get(a.id) });
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
  rmSync(keyDir, { recursive: true, force: true });
});

beforeEach(() => {
  approvals.length = 0;
  detailPayloadOverride.clear();
  detailFieldOverride.clear();
  failApprovalList = false;
  apiCalls.length = 0;
  tgCalls.length = 0;
  updatesQueue.length = 0;
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 0, posted: {}, notePrompts: {} }));
});

function runOnce(env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
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
        AAVA_TG_SIGN_KEY_FILE: keyPath,
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function runOk(env: Record<string, string> = {}) {
  const run = await runOnce(env);
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
    // the relay creates its approvals with a board key
    requestedByAgentId: null,
    requestedByUserId: "board",
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
    expect(text).toContain('Syyt: uusi vastaanottaja, seula: hinta');
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
    // a well-formed aava_send created by an agent, not the relay
    addAava(19, { requestedByAgentId: uuid(98), requestedByUserId: null });
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
        reasons: ["outside-whitelist", "free-replies-off", "dmarc:dmarc-fail", "dmarc:no-auth-results"],
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
    expect(text).toContain(
      "Syyt: outside-whitelist, kaikki posti hyväksytetään, DMARC ei läpäissyt (tulos fail), DMARC ei läpäissyt (ei Authentication-Results-otsaketta)",
    );
    // no line of the body can pose as a card line
    const bodyStart = lines.indexOf("──────────") + 1;
    expect(lines.slice(bodyStart).every((l) => l.startsWith("│ "))).toBe(true);
    // the line break in the subject blocks ✅ (first rule hit: the bidi control in To)
    expect(text).toContain("⛔ ✅ estetty — To: kielletty merkki U+202E.");
    expect(buttons(sentCards()[0].body)).toEqual(["❌ Hylkää"]);
  });

  it("truncates a long body under Telegram's 4096 limit, says so and offers ❌ only", async () => {
    addAava(8, {}, { body: `${"rivi ".repeat(299)}rivi\n`.repeat(20) });
    await runOk();
    const card = sentCards()[0].body;
    expect(card.text.length).toBeLessThanOrEqual(4096);
    expect(card.text).toMatch(/✂️ Runko katkaistu: näytetty \d+ \/ 30000 merkkiä/);
    expect(card.text).toContain("✂️ Kortti ei näytä koko viestiä. Hyväksy se Paperclip-UI:ssa.");
    expect(card.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);

    // a forged ✅ on it is refused
    updatesQueue.push([callback(`pa:a:${uuid(8)}`, readState().posted[uuid(8)].messageId)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toBe("Kortti ei näytä koko viestiä — hyväksy se Paperclip-UI:ssa.");
  });

  it("bounds every header: huge recipient lists, many reasons and a cut emoji still post a valid card", async () => {
    const longAddress = (i: number) => `${"a".repeat(195)}${i}@${"b".repeat(200)}`;
    addAava(20, {}, { to: Array.from({ length: 25 }, (_, i) => longAddress(i)) });
    addAava(21, {}, { reasons: Array.from({ length: 1000 }, (_, i) => `screen:${"x".repeat(50)}${i}`) });
    addAava(22, {}, { subject: `${"a".repeat(298)}😀b` });
    await runOk();

    const cards = sentCards().map((c) => c.body);
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.text.length).toBeLessThanOrEqual(4096);
      expect(card.text.isWellFormed()).toBe(true);
      // the body still has room
      expect(card.text).toContain("│ Hei Matti,");
    }
    // cut recipients and a cut subject hide part of the message: ❌ only
    expect(cards[0].text).toContain("(+5 muuta)");
    expect(cards[0].reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);
    expect(cards[2].reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);
    // more than 10 reasons: some are hidden, so ✅ is blocked
    expect(cards[1].text).toContain("+990 muuta");
    expect(cards[1].text).toContain("⛔ ✅ estetty — Syyt: yli 10 syytä.");
    expect(buttons(cards[1])).toEqual(["❌ Hylkää"]);
  });

  it("strips invisible characters and flags a non-ASCII address", async () => {
    addAava(23, {}, { to: ["ce\u200fo@rk9.fi", "\u0430ava@rk9.fi"] });
    await runOk();
    const text: string = sentCards()[0].body.text;
    expect(text).toContain(`To (2): ceo@${WJ}rk9.fi, \u0430ava@${WJ}rk9.fi`);
    expect(text).not.toMatch(/[\u200b-\u200f\ufeff]/);
    // the stripped U+200F is the first character outside the list: ❌ only
    expect(text).toContain("⛔ ✅ estetty — To: kielletty merkki U+200F.");
    expect(sentCards()[0].body.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);
  });

  it("a body that hides text in invisible characters cannot be approved", async () => {
    const hidden = "IBAN FI12 3456"
      .split("")
      .map((c) => c.charCodeAt(0).toString(2).replace(/0/g, "\u200b").replace(/1/g, "\u200c"))
      .join("\u200d");
    addAava(24, {}, { body: `Kiitos viestistä!${hidden}` });
    // tag characters ("ASCII smuggling") and a variation selector in the subject
    addAava(25, {}, { subject: "Re: kysymys\u{e0041}\u{e0042}\ufe0f" });
    await runOk();

    const cards = sentCards().map((c) => c.body);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);
    }
    expect(cards[0].text).toContain("⛔ ✅ estetty — Runko: kielletty merkki U+200C.");
    expect(cards[1].text).toContain("⛔ ✅ estetty — Aihe: kielletty merkki U+E0041.");
    expect(cards[0].text).toContain("│ Kiitos viestistä!");
    expect(cards[0].text).not.toMatch(/[\u200b-\u200d]/);
    expect(cards[1].text).toContain("Aihe: Re: kysymys\n");

    updatesQueue.push([callback(`pa:a:${uuid(24)}`, readState().posted[uuid(24)].messageId)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(lastAnswer()).toBe("Kortti ei näytä koko viestiä — hyväksy se Paperclip-UI:ssa.");
  });

  it("C1 controls, odd whitespace, private-use and lone surrogates make the card ❌-only", async () => {
    const bodies = [
      "Kiitos!\u0080\u0081\u0080\u0081", // C1 controls (verifier round 3)
      "Kiitos\u00a0viestistä!", // NBSP looks like a space
      "Kiitos\tviestistä!",
      "Kiitos viestistä!  ", // trailing spaces
      "Kiitos  viestistä!", // a run of spaces
      "Kiitos\ue000!", // private use
      "Kiitos!\ud800", // lone surrogate
      "Kiitos\u3164!", // Hangul filler (a letter that draws as nothing)
    ];
    bodies.forEach((body, i) => addAava(30 + i, {}, { body }));
    addAava(40, {}, { subject: "Hi\u0080\u0081" });
    await runOk();
    const cards = sentCards().map((c) => c.body);
    expect(cards).toHaveLength(bodies.length + 1);
    for (const card of cards) {
      expect(card.text).toMatch(/⛔ ✅ estetty — (Runko|Aihe): /);
      expect(card.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["❌ Hylkää"]);
      expect(card.text).not.toMatch(/[\u0080-\u009f]/);
    }
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
    // RK9-922: the decision carries an Ed25519 signature over the card's fields
    const note = decisionCalls()[0].body.decisionNote as string;
    const sig = SIGNED_NOTE_RE.exec(note)?.[1];
    expect(sig, note).toBeDefined();
    const p = aavaPayload(10);
    expect(verifies(signedMessage(uuid(10), p.gateId, p.sha256), sig!)).toBe(true);
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

  it("closes the card when the approval is decided elsewhere, with the relay's note", async () => {
    const a = addAava(15);
    await runOk();
    const card = readState().posted[uuid(15)].messageId as number;
    a.status = "rejected";
    a.decisionNote = "Vanhentunut (72 h), relay sulki.";
    await runOk();
    expect(editsOf(card).at(-1)?.body.text).toBe(
      "☑️ Käsitelty muualla (rejected): Vanhentunut (72 h), relay sulki.\nTo: matti.meikalainen@\u2060example.com\nAihe: Re: tarjous 15",
    );
    expect(readState().posted[uuid(15)]).toBeUndefined();
    expect(decisionCalls()).toHaveLength(0);
  });
});

describe("Aava card character list (RK9-894, orchestrator decision after verifier round 4)", () => {
  const base = (over: Record<string, unknown> = {}) => aavaPayload(1, over);

  it("allows ✅ for exactly the listed code points, U+0000–U+10FFFF (subject, body, address)", () => {
    const wrong = { predicate: [] as number[], subject: [] as number[], body: [] as number[], address: [] as number[] };
    // one payload per field, mutated in place: 3.3 M blocker calls stay fast
    const pSubject = base();
    const pBody = base();
    const pAddress = base();
    const toList = ["x"];
    pAddress.to = toList;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const listed = inList(cp);
      if (charset.isAavaTextCodePoint(cp) !== listed) wrong.predicate.push(cp);
      pSubject.subject = `a${ch}a`;
      if ((charset.aavaApprovalBlocker(pSubject) === null) !== listed) wrong.subject.push(cp);
      // the body also allows "\n" (and nothing else that breaks a line)
      pBody.body = `a${ch}a`;
      if ((charset.aavaApprovalBlocker(pBody) === null) !== (listed || cp === 0x0a)) wrong.body.push(cp);
      toList[0] = `a${ch}b@example.com`;
      const asciiAddress = cp >= 0x21 && cp <= 0x7e && !'@<>"'.includes(ch);
      if ((charset.aavaApprovalBlocker(pAddress) === null) !== asciiAddress) wrong.address.push(cp);
    }
    expect(wrong).toEqual({ predicate: [], subject: [], body: [], address: [] });
  }, 120_000);

  it("each rule blocks on its own (one input per rule)", () => {
    const cases: Array<[Record<string, unknown>, { field: string; rule: string; codePoint?: number } | null]> = [
      [{}, null],
      [{ body: "Hei\r\nMoi" }, null], // CRLF is normalised
      [{ body: "Hei\n\n-- \nAava" }, null], // the signature delimiter may end in a space
      [{ from: "aava@\u0430rk9.fi" }, { field: "from", rule: "char", codePoint: 0x430 }],
      [{ from: "aava rk9.fi" }, { field: "from", rule: "char", codePoint: 0x20 }],
      [{ to: ["asiakas@example.com\u0085"] }, { field: "to", rule: "char", codePoint: 0x85 }],
      [{ to: ["ok@example.com", "a@b@c"] }, { field: "to", rule: "address" }],
      [{ subject: "" }, { field: "subject", rule: "empty" }],
      [{ subject: "Re: Hei\n" }, { field: "subject", rule: "char", codePoint: 0x0a }],
      [{ subject: " Re: Hei" }, { field: "subject", rule: "edge-space" }],
      [{ subject: "Re: Hei " }, { field: "subject", rule: "edge-space" }],
      [{ subject: "Re:  Hei" }, { field: "subject", rule: "space-run" }],
      [{ body: "" }, { field: "body", rule: "empty" }],
      [{ body: "Hei\rMoi" }, { field: "body", rule: "char", codePoint: 0x0d }],
      [{ body: "Maksamme teille 1\u0085000 €." }, { field: "body", rule: "char", codePoint: 0x85 }],
      [{ body: "Hei\u2028Moi" }, { field: "body", rule: "char", codePoint: 0x2028 }],
      [{ body: "Hei \nMoi" }, { field: "body", rule: "trailing-space" }],
      [{ body: "Hei\n--  \nMoi" }, { field: "body", rule: "space-run" }],
      [{ body: "Hei  Moi" }, { field: "body", rule: "space-run" }],
      [{ body: "\u2800" }, { field: "body", rule: "char", codePoint: 0x2800 }],
      [{ body: "a\ud800" }, { field: "body", rule: "char", codePoint: 0xd800 }],
      [{ reasons: Array.from({ length: 11 }, () => "auto") }, { field: "reasons", rule: "too-many" }],
      [{ reasons: Array.from({ length: 10 }, () => "auto") }, null],
      [{ reasons: ["constructor"] }, { field: "reasons", rule: "unknown-reason" }],
      [{ reasons: ["screen:"] }, { field: "reasons", rule: "unknown-reason" }],
      [{ reasons: ["dmarc:bogus"] }, { field: "reasons", rule: "unknown-reason" }],
      [{ reasons: ["outside-whitelist"] }, { field: "reasons", rule: "unknown-reason" }],
      // round 5: the signature line is exactly "-- "
      [{ body: "Hei\nx-- \nAava" }, { field: "body", rule: "trailing-space" }],
      [{ body: "Hei\n -- \nAava" }, { field: "body", rule: "trailing-space" }],
      // round 5, L1: only line breaks or spaces is empty
      [{ body: "\n \n\r\n" }, { field: "body", rule: "empty" }],
      [{ body: "  " }, { field: "body", rule: "empty" }],
      [{ subject: " " }, { field: "subject", rule: "empty" }],
      // round 5, M1: blank-line floods and long bodies
      [{ body: "Hei,\n" + "\n".repeat(1000) + "PS. loppu" }, { field: "body", rule: "too-many-lines" }],
      [{ body: Array.from({ length: 121 }, () => "a").join("\n") }, { field: "body", rule: "too-many-lines" }],
      [{ body: Array.from({ length: 120 }, () => "a").join("\n") }, null],
      [{ body: "Hei\n\n\n\nMoi" }, { field: "body", rule: "blank-run" }],
      [{ body: "Hei\n\n\nMoi" }, null],
      // round 5, L3: unknown payload keys block; the relay's four UI fields do not
      [{ cc: ["x@example.com"] }, { field: "payload", rule: "unknown-field", key: "cc" }],
      [{ attachments: [] }, { field: "payload", rule: "unknown-field", key: "attachments" }],
      [{ title: "t", summary: "s", recommendedAction: "r", proposedComment: "p" }, null],
    ];
    for (const [over, expected] of cases) {
      expect(charset.aavaApprovalBlocker(base(over)), JSON.stringify(over)).toEqual(expected);
    }
  });

  it("knows every gate reason code and no other", () => {
    const known = [
      "new-recipient", "added-recipient", "own-address", "brand-address", "not-own-address", "reply-to-mismatch",
      "reply-to-bad", "no-message-id", "auto", "caller-hold", "free-replies-off", "dmarc:no-received",
      "dmarc:no-auth-results", "dmarc:authserv", "dmarc:no-dmarc", "dmarc:ambiguous", "dmarc:header-from",
      "dmarc:dmarc-fail", "screen:hinta", "screen:money", "screen:percent", "screen:script",
    ];
    for (const code of known) expect(charset.aavaReasonLabel(code), code).toEqual(expect.any(String));
    expect(charset.aavaReasonLabel("free-replies-off")).toBe("kaikki posti hyväksytetään");
    for (const code of ["constructor", "toString", "__proto__", "new-message", "cc", "automated", "dmarc:", "screen:Hinta"]) {
      expect(charset.aavaReasonLabel(code), code).toBeNull();
    }
  });
});

describe("Aava card blocks hidden line breaks and blanks (RK9-894 verifier round 4)", () => {
  it("line-break variants and U+2800 give a ❌-only card that names the field and code point", async () => {
    addAava(50, {}, { subject: "Re: Hei" + "\n\r\v\f\u0085  ".repeat(700) });
    addAava(51, {}, { body: "Maksamme teille 1\u0085000 €." });
    addAava(52, {}, { to: ["asiakas@example.com\u0085"] });
    addAava(53, {}, { body: "Kiitos!\u2800\u2800\u2800" });
    addAava(54, {}, { subject: "" });
    addAava(55, {}, { body: "Hei \nMoi" });
    await runOk();
    const cards = sentCards().map((c) => c.body);
    expect(cards).toHaveLength(6);
    for (const card of cards) expect(buttons(card)).toEqual(["❌ Hylkää"]);
    expect(cards[0].text).toContain("⛔ ✅ estetty — Aihe: kielletty merkki U+000A.");
    expect(cards[1].text).toContain("⛔ ✅ estetty — Runko: kielletty merkki U+0085.");
    expect(cards[2].text).toContain("⛔ ✅ estetty — To: kielletty merkki U+0085.");
    expect(cards[3].text).toContain("⛔ ✅ estetty — Runko: kielletty merkki U+2800.");
    expect(cards[4].text).toContain("Aihe: ⟨tyhjä aihe⟩");
    expect(cards[4].text).toContain("⛔ ✅ estetty — Aihe: tyhjä.");
    expect(cards[5].text).toContain("⛔ ✅ estetty — Runko: välilyönti rivin lopussa.");

    updatesQueue.push([callback(`pa:a:${uuid(51)}`, readState().posted[uuid(51)].messageId)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
  });

  it("a CRLF body with listed characters keeps ✅", async () => {
    addAava(56, {}, { body: "Hei “Matti”,\r\n\r\nhinta on 120 € – sopimus • ok…\r\n\r\n-- \r\nAava" });
    await runOk();
    expect(buttons(sentCards()[0].body)).toEqual(["✅ Lähetä", "❌ Hylkää"]);
  });
});

describe("Aava card round-5 tightenings and mutation survivors (RK9-894)", () => {
  it("an unknown payload key and a blank-line flood give a ❌-only card with the reason", async () => {
    addAava(60, {}, { bcc: ["piilo@example.com"] });
    addAava(61, {}, { body: "Hei,\n" + "\n".repeat(1000) + "PS. loppu" });
    await runOk();
    const cards = sentCards().map((c) => c.body);
    expect(cards.map(buttons)).toEqual([["❌ Hylkää"], ["❌ Hylkää"]]);
    expect(cards[0].text).toContain('⛔ ✅ estetty — Payload: tuntematon kenttä "bcc".');
    expect(cards[1].text).toContain("⛔ ✅ estetty — Runko: yli 120 riviä.");
  });

  it("each display limit alone makes the card incomplete: >20 recipients, a cut subject, a cut To line", async () => {
    addAava(62, {}, { to: Array.from({ length: 21 }, (_, i) => `a${i}@example.com`) });
    addAava(63, {}, { subject: "a".repeat(301) });
    // 7 addresses of 191 chars: each fits its 200 cap, the line is over 1200
    addAava(64, {}, { to: Array.from({ length: 7 }, (_, i) => `${"a".repeat(178)}${i}@example.com`) });
    await runOk();
    const cards = sentCards().map((c) => c.body);
    expect(cards).toHaveLength(3);
    for (const [i, card] of cards.entries()) {
      // no character rule fires: only the display limit blocks ✅
      expect(charset.aavaApprovalBlocker(approvals[i].payload), String(i)).toBeNull();
      expect(card.text).not.toContain("⛔");
      expect(card.text).toContain("✂️ Kortti ei näytä koko viestiä. Hyväksy se Paperclip-UI:ssa.");
      expect(buttons(card)).toEqual(["❌ Hylkää"]);
    }
  });

  it("a change to only to, sha256, op, from or reasons re-posts the card", async () => {
    const changes: Array<Record<string, unknown>> = [
      { to: ["toinen@example.com"] },
      { sha256: hex(3, 64) },
      { op: "new" },
      { from: "info@rk9.fi" },
      { reasons: ["auto"] },
    ];
    const list = changes.map((_, i) => addAava(70 + i));
    await runOk();
    const oldCards = list.map((a) => readState().posted[a.id].messageId as number);
    list.forEach((a, i) => {
      a.payload = { ...a.payload, ...changes[i] };
    });
    await runOk();
    for (const [i, a] of list.entries()) {
      expect(editsOf(oldCards[i]).at(-1)?.body.text, JSON.stringify(changes[i])).toMatch(/^♻️ Lähetyspyyntö muuttui/);
      expect(readState().posted[a.id].messageId).not.toBe(oldCards[i]);
    }
    expect(sentCards()).toHaveLength(10);
  });

  it("✅ is refused when the re-read approval is no longer pending or was created by an agent", async () => {
    addAava(80);
    addAava(81);
    await runOk();
    detailFieldOverride.set(uuid(80), { status: "approved" });
    detailFieldOverride.set(uuid(81), { requestedByAgentId: uuid(98) });
    updatesQueue.push([
      callback(`pa:a:${uuid(80)}`, readState().posted[uuid(80)].messageId),
      callback(`pa:a:${uuid(81)}`, readState().posted[uuid(81)].messageId),
    ]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    const answers = tgCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
    expect(answers).toEqual([
      "Lähetyspyyntö on muuttunut tai jo käsitelty — käytä uusinta korttia tai Paperclip-UI:ta.",
      "Lähetyspyyntö on muuttunut tai jo käsitelty — käytä uusinta korttia tai Paperclip-UI:ta.",
    ]);
  });
});

describe("Aava ✅ is signed with the approve key (RK9-922)", () => {
  // Fixed test vector shared with the gate (RK9-920): RFC 8032 TEST 1 key and
  // these fields give exactly this decisionNote.
  const VECTOR = {
    approvalId: "4f8c2a1e-9b3d-4e7a-8c5f-0d1e2f3a4b5c",
    gateId: "g-0123456789abcdef",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    signature: "1kAq6ROEOQqg3F7TtMggtEaiikZC3BUFI0lwxQgIp6/USriNp7jGhDgNKW5jqmr+IWAyvCNq/YTdlALiM8lIAA==",
  };
  const KEY_LINE_RE = /^🔑 ✅ ei käytössä: hyväksynnän allekirjoitusavain ei toimi \((.+)\)\. /m;

  it("matches the shared test vector byte for byte, and nothing secret reaches logs or Telegram", async () => {
    // the five-line message itself, independent of the listener
    const message = signedMessage(VECTOR.approvalId, VECTOR.gateId, VECTOR.sha256);
    expect(Buffer.from(message, "utf8").toString("hex")).toBe(
      Buffer.from(
        "aava-send-v1\n4f8c2a1e-9b3d-4e7a-8c5f-0d1e2f3a4b5c\ng-0123456789abcdef\n" +
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\napprove",
        "utf8",
      ).toString("hex"),
    );
    expect(verifies(message, VECTOR.signature)).toBe(true);
    expect(Buffer.from(VECTOR.signature, "base64")).toHaveLength(64);

    addAava(900, { id: VECTOR.approvalId }, { gateId: VECTOR.gateId, sha256: VECTOR.sha256 });
    const scan = await runOk();
    const card = readState().posted[VECTOR.approvalId].messageId as number;
    expect(buttons(sentCards()[0].body)).toEqual(["✅ Lähetä", "❌ Hylkää"]);
    updatesQueue.push([callback(`pa:a:${VECTOR.approvalId}`, card)]);
    const tap = await runOk();

    expect(decisionCalls().map((c) => c.url)).toEqual([`/api/approvals/${VECTOR.approvalId}/approve`]);
    expect(decisionCalls()[0].body).toEqual({
      decisionNote: `Hyväksytty Telegramista · aava-sig:v1:${VECTOR.signature}`,
    });
    // a different message (trailing newline, CRLF, other field) does not verify
    expect(verifies(`${message}\n`, VECTOR.signature)).toBe(false);
    expect(verifies(message.replace(/\n/g, "\r\n"), VECTOR.signature)).toBe(false);
    expect(verifies(message.replace("approve", "reject"), VECTOR.signature)).toBe(false);

    // the key, the signed message and the signature stay out of logs, Telegram and state
    const pem = signingKey.export({ format: "pem", type: "pkcs8" }).toString();
    const pemBody = pem.split("\n")[1];
    const telegram = JSON.stringify(tgCalls);
    for (const leaked of [VECTOR.signature, "aava-send-v1", "aava-sig", pemBody, RFC8032_TEST1_SEED]) {
      expect(scan.out + tap.out, leaked).not.toContain(leaked);
      expect(telegram, leaked).not.toContain(leaked);
      expect(readFileSync(join(stateDir, "state.json"), "utf8"), leaked).not.toContain(leaked);
    }
  });

  it("a missing key: ❌-only card that says why, ✅ refused and logged, other cards still approve", async () => {
    const missing = join(keyDir, "does-not-exist.key");
    addAava(901);
    approvals.push({
      id: uuid(902),
      companyId: RK9.id,
      type: "email_send",
      status: "pending",
      payload: { to: ["asiakas@example.com"], subject: "Tarjous", bodyMarkdown: "Hei!" },
      requestedByAgentId: uuid(97),
    });
    const scan = await runOk({ AAVA_TG_SIGN_KEY_FILE: missing });
    expect(scan.out).toContain(`aava signing key ${missing} unusable: ENOENT`);
    const [aavaCard, emailCard] = sentCards().map((c) => c.body);
    expect(buttons(aavaCard)).toEqual(["❌ Hylkää"]);
    expect(KEY_LINE_RE.exec(aavaCard.text)?.[1]).toBe("avaintiedostoa ei ole");
    expect(aavaCard.text).not.toContain(missing);
    expect(buttons(emailCard)).toEqual(["✅ Hyväksy", "❌ Hylkää", "✏️ Revisio"]);
    expect(readState().posted[uuid(901)].noKey).toBe(true);

    updatesQueue.push([
      callback(`pa:a:${uuid(901)}`, readState().posted[uuid(901)].messageId),
      callback(`pa:a:${uuid(902)}`, readState().posted[uuid(902)].messageId),
    ]);
    const tap = await runOk({ AAVA_TG_SIGN_KEY_FILE: missing });
    expect(tap.out).toContain(`aava approval ${uuid(901)}: ✅ refused, signing key unusable (ENOENT)`);
    const answers = tgCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
    expect(answers[0]).toBe("Allekirjoitusavain ei toimi (avaintiedostoa ei ole) — tätä ei voi hyväksyä.");
    // the email_send card approves exactly as before
    expect(decisionCalls().map((c) => [c.url, c.body])).toEqual([
      [`/api/approvals/${uuid(902)}/approve`, { decisionNote: "Hyväksytty Telegramista" }],
    ]);
    expect(approvals.find((a) => a.id === uuid(901))?.status).toBe("pending");

    // ❌ is unchanged and unsigned
    updatesQueue.push([callback(`pa:r:${uuid(901)}`, readState().posted[uuid(901)].messageId)]);
    await runOk({ AAVA_TG_SIGN_KEY_FILE: missing });
    updatesQueue.push([reply("Ei nyt", nextTgMessageId - 1)]);
    await runOk({ AAVA_TG_SIGN_KEY_FILE: missing });
    expect(decisionCalls().at(-1)).toMatchObject({ url: `/api/approvals/${uuid(901)}/reject`, body: { decisionNote: "Ei nyt" } });
  });

  it("a key of the wrong type, a non-PEM file or a group/other-readable file disables Aava ✅", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" });
    const pem = signingKey.export({ format: "pem", type: "pkcs8" });
    const cases: Array<[string, string, string]> = [
      [keyFile("ec.key", ec), "avain ei ole Ed25519-avain", "key type ec, want ed25519"],
      [keyFile("junk.key", "not a key\n"), "avaintiedosto ei ole kelvollinen PEM-avain", "not a valid PEM private key"],
      [keyFile("open.key", pem, 0o440), "avaintiedoston oikeudet sallivat ryhmän tai muiden käytön", "mode 440 allows group/others"],
      [keyFile("world.key", pem, 0o404), "avaintiedoston oikeudet sallivat ryhmän tai muiden käytön", "mode 404 allows group/others"],
    ];
    for (const [i, [path, reason, log]] of cases.entries()) {
      approvals.length = 0;
      tgCalls.length = 0;
      apiCalls.length = 0;
      writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 0, posted: {}, notePrompts: {} }));
      addAava(910 + i);
      const scan = await runOk({ AAVA_TG_SIGN_KEY_FILE: path });
      expect(scan.out, path).toContain(`aava signing key ${path} unusable: ${log}`);
      expect(KEY_LINE_RE.exec(sentCards()[0].body.text)?.[1], path).toBe(reason);
      expect(buttons(sentCards()[0].body), path).toEqual(["❌ Hylkää"]);
      updatesQueue.push([callback(`pa:a:${uuid(910 + i)}`, readState().posted[uuid(910 + i)].messageId)]);
      await runOk({ AAVA_TG_SIGN_KEY_FILE: path });
      expect(decisionCalls(), path).toHaveLength(0);
      expect(lastAnswer(), path).toBe(`Allekirjoitusavain ei toimi (${reason}) — tätä ei voi hyväksyä.`);
    }
  });

  it("a card posted without a key is replaced once the listener runs with a working key", async () => {
    addAava(920);
    await runOk({ AAVA_TG_SIGN_KEY_FILE: join(keyDir, "missing.key") });
    const oldCard = readState().posted[uuid(920)].messageId as number;
    await runOk();
    expect(editsOf(oldCard).at(-1)?.body.text).toBe("🔑 Allekirjoitusavain toimii nyt — uusi kortti alla. Tämä kortti ei enää päde.");
    const newCard = readState().posted[uuid(920)];
    expect(newCard.messageId).not.toBe(oldCard);
    expect(newCard.noKey).toBeUndefined();
    expect(buttons(sentCards().at(-1)!.body)).toEqual(["✅ Lähetä", "❌ Hylkää"]);
    expect(sentCards().at(-1)!.body.text).not.toContain("🔑");

    // the old card's ✅ is refused; the new card's ✅ is signed
    updatesQueue.push([callback(`pa:a:${uuid(920)}`, oldCard)]);
    await runOk();
    expect(decisionCalls()).toHaveLength(0);
    updatesQueue.push([callback(`pa:a:${uuid(920)}`, newCard.messageId)]);
    await runOk();
    const sig = SIGNED_NOTE_RE.exec(decisionCalls()[0].body.decisionNote)?.[1];
    const p = aavaPayload(920);
    expect(verifies(signedMessage(uuid(920), p.gateId, p.sha256), sig!)).toBe(true);
  });

  it("with a working key, email_send and voice_action approvals keep the plain note", async () => {
    approvals.push(
      {
        id: uuid(940),
        companyId: RK9.id,
        type: "email_send",
        status: "pending",
        payload: { to: ["asiakas@example.com"], subject: "Tarjous", bodyMarkdown: "Hei!" },
        requestedByAgentId: uuid(97),
      },
      {
        id: uuid(941),
        companyId: RK9.id,
        type: "voice_action",
        status: "pending",
        payload: { action: "issue_status", identifier: "RK9-1", status: "done" },
        requestedByAgentId: uuid(97),
      },
    );
    await runOk();
    updatesQueue.push([
      callback(`pa:a:${uuid(940)}`, readState().posted[uuid(940)].messageId),
      callback(`pa:a:${uuid(941)}`, readState().posted[uuid(941)].messageId),
    ]);
    await runOk();
    expect(decisionCalls().map((c) => [c.url, c.body])).toEqual([
      [`/api/approvals/${uuid(940)}/approve`, { decisionNote: "Hyväksytty Telegramista" }],
      [`/api/approvals/${uuid(941)}/approve`, { decisionNote: "Hyväksytty Telegramista" }],
    ]);
  });

  it("a key owned by another user or a FIFO is refused without hanging; a card posted with ✅ is re-posted ❌-only after the key breaks", async () => {
    addAava(950);
    await runOk();
    const oldCard = readState().posted[uuid(950)].messageId as number;
    expect(buttons(sentCards()[0].body)).toEqual(["✅ Lähetä", "❌ Hylkää"]);

    const fifo = join(keyDir, "fifo.key");
    rmSync(fifo, { force: true });
    execFileSync("mkfifo", ["-m", "0400", fifo]);
    const run = await runOk({ AAVA_TG_SIGN_KEY_FILE: fifo });
    expect(run.out).toContain(`aava signing key ${fifo} unusable: not a regular file`);
    expect(editsOf(oldCard).at(-1)?.body.text).toBe("🔑 Allekirjoitusavain ei toimi — uusi kortti alla. Tämä kortti ei enää päde.");
    const card = sentCards().at(-1)!.body;
    expect(buttons(card)).toEqual(["❌ Hylkää"]);
    expect(KEY_LINE_RE.exec(card.text)?.[1]).toBe("avaintiedosto ei ole tavallinen tiedosto");

    // a symlink to a good key is not followed
    const link = join(keyDir, "link.key");
    rmSync(link, { force: true });
    symlinkSync(keyPath, link);
    const linked = await runOk({ AAVA_TG_SIGN_KEY_FILE: link });
    expect(linked.out).toContain(`aava signing key ${link} unusable: ELOOP`);

    // root can hand the file to another owner; as a normal user, check the rule only
    if (process.getuid?.() === 0) {
      const other = keyFile("other.key", signingKey.export({ format: "pem", type: "pkcs8" }));
      chownSync(other, 65534, 65534);
      const owned = await runOk({ AAVA_TG_SIGN_KEY_FILE: other });
      expect(owned.out).toContain("owner uid 65534");
    }
  });

  it("a tampered state row cannot make ✅ sign content the card did not show", async () => {
    const a = addAava(960);
    await runOk();
    const card = readState().posted[uuid(960)].messageId as number;
    expect(readState().posted[uuid(960)].mac).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    // whoever can write state.json swaps the payload and rewrites the row's
    // fingerprint to match it, keeping the old MAC
    const b = aavaPayload(960, { to: ["hyokkaaja@example.com"], sha256: hex(9, 64) });
    a.payload = b;
    const st = readState();
    st.posted[uuid(960)].sig = JSON.stringify([b.gateId, b.op, b.from, b.to, b.subject, b.body, b.reasons, b.sha256]);
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(st));
    // the tap comes in before any scan sees the change
    updatesQueue.push([callback(`pa:a:${uuid(960)}`, card)]);
    failApprovalList = true;
    const tap = await runOk();
    failApprovalList = false;
    expect(decisionCalls()).toHaveLength(0);
    expect(tap.out).toContain(`aava approval ${uuid(960)}: ✅ refused, state row fails its integrity check`);
    expect(lastAnswer()).toBe("Kortin tila ei täsmää — tätä ei hyväksytty. Uusi kortti tulee seuraavassa skannauksessa.");

    // the next scan replaces the card; the fresh card shows B and signs B
    await runOk();
    expect(editsOf(card).at(-1)?.body.text).toBe("♻️ Kortti päivitettiin — uusi kortti alla. Tämä kortti ei enää päde.");
    const fresh = readState().posted[uuid(960)];
    expect(sentCards().at(-1)!.body.text).toContain(`hyokkaaja@${WJ}example.com`);
    updatesQueue.push([callback(`pa:a:${uuid(960)}`, fresh.messageId)]);
    await runOk();
    const sig = SIGNED_NOTE_RE.exec(decisionCalls()[0].body.decisionNote)?.[1];
    expect(verifies(signedMessage(uuid(960), b.gateId, b.sha256), sig!)).toBe(true);
  });

  it("a row without a MAC (posted before RK9-922) or with a moved message id never signs", async () => {
    addAava(970);
    addAava(971);
    await runOk();
    const st = readState();
    delete st.posted[uuid(970)].mac;
    // point 971's row at another message: its MAC no longer matches
    st.posted[uuid(971)].messageId = 4242;
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(st));
    updatesQueue.push([callback(`pa:a:${uuid(970)}`, st.posted[uuid(970)].messageId), callback(`pa:a:${uuid(971)}`, 4242)]);
    failApprovalList = true;
    await runOk();
    failApprovalList = false;
    expect(decisionCalls()).toHaveLength(0);
    expect(tgCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text)).toEqual([
      "Kortin tila ei täsmää — tätä ei hyväksytty. Uusi kortti tulee seuraavassa skannauksessa.",
      "Kortin tila ei täsmää — tätä ei hyväksytty. Uusi kortti tulee seuraavassa skannauksessa.",
    ]);
    // both rows are re-posted with a valid MAC
    await runOk();
    expect(readState().posted[uuid(970)].mac).toEqual(expect.any(String));
    expect(readState().posted[uuid(971)].messageId).not.toBe(4242);
  });

  it("a payload that changed after the card was posted gets no signature and no approval", async () => {
    addAava(930);
    addAava(931);
    await runOk();
    // only the hash changed, or only the gate id: the card no longer shows what would be sent
    detailPayloadOverride.set(uuid(930), aavaPayload(930, { sha256: hex(1, 64) }));
    detailPayloadOverride.set(uuid(931), aavaPayload(931, { gateId: `g-${hex(2, 16)}` }));
    updatesQueue.push([
      callback(`pa:a:${uuid(930)}`, readState().posted[uuid(930)].messageId),
      callback(`pa:a:${uuid(931)}`, readState().posted[uuid(931)].messageId),
    ]);
    const tap = await runOk();
    expect(decisionCalls()).toHaveLength(0);
    expect(tap.out).not.toContain("aava-sig");
    expect(approvals.every((a) => a.status === "pending")).toBe(true);
  });
});
