// RK9-481: voice_action approvals in server/scripts/approval-telegram-listener.mjs.
// One mock HTTP server plays both the Paperclip API and the Telegram Bot API
// (TG_API_BASE override); the script runs with --once per step, so each
// assertion covers exactly one scan + one getUpdates drain.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/approval-telegram-listener.mjs", import.meta.url));
const COMPANY = { id: "c1", name: "RK9" };
const TG_TOKEN = "tok";
const CHAT = "42";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AGENT = { id: uuid(900), name: "CTO" };

type Approval = { id: string; type: string; status: string; payload: Record<string, unknown> };
type Issue = { id: string; identifier: string; title: string; status: string; assigneeAgentId: string | null };

const issues = new Map<string, Issue>([
  [uuid(201), { id: uuid(201), identifier: "RK9-469", title: "Grok-connector", status: "todo", assigneeAgentId: AGENT.id }],
  [uuid(202), { id: uuid(202), identifier: "RK9-470", title: "Siivous", status: "in_progress", assigneeAgentId: null }],
]);

const COMMENT_BODY = "Tarkista *tämä* ennen julkaisua.\nToinen rivi <b>ei HTML:ää</b>.";
const approvals: Approval[] = [
  {
    id: uuid(1),
    type: "voice_action",
    status: "pending",
    payload: { action: "issue_comment", issueId: uuid(201), identifier: "RK9-469", body: COMMENT_BODY, source: "grok" },
  },
  {
    id: uuid(2),
    type: "voice_action",
    status: "pending",
    payload: { action: "issue_status", issueId: uuid(202), identifier: "RK9-470", status: "done", source: "grok" },
  },
];
const approvalComments = new Map<string, Array<{ body: string; authorAgentId?: string }>>();

const apiCalls: Array<{ method: string; url: string; body: any }> = [];
const tgCalls: Array<{ method: string; body: any }> = [];
const updatesQueue: unknown[][] = [];
let nextTgMessageId = 500;
// RK9-502: "lost" drops the connection before the approve is applied,
// "lost-after-apply" applies it (no outcome comment yet) and then drops it.
let approveMode: "normal" | "lost" | "lost-after-apply" = "normal";
// RK9-502: drops the connection on GET /api/approvals/:id.
let approvalReadDown = false;

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
  stateDir = mkdtempSync(join(tmpdir(), "tg-listener-voice-"));
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 0, posted: {}, notePrompts: {} }));
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
    if (p === `/api/companies/${COMPANY.id}/approvals`) {
      const status = url.searchParams.get("status");
      return send(200, approvals.filter((a) => !status || a.status === status));
    }
    if (p === `/api/companies/${COMPANY.id}/outreach/messages`) return send(200, []);
    let m = /^\/api\/issues\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      const issue = issues.get(m[1]);
      return issue ? send(200, issue) : send(404, { error: "not_found" });
    }
    m = /^\/api\/agents\/([0-9a-f-]{36})$/.exec(p);
    if (m) return m[1] === AGENT.id ? send(200, AGENT) : send(404, { error: "not_found" });
    m = /^\/api\/approvals\/([0-9a-f-]{36})(?:\/([\w-]+))?$/.exec(p);
    if (m) {
      const approval = approvals.find((a) => a.id === m![1]);
      if (!approval) return send(404, { error: "not_found" });
      const action = m[2];
      if (!action && approvalReadDown) return req.socket.destroy();
      if (!action) return send(200, approval);
      if (action === "comments") return send(200, approvalComments.get(approval.id) ?? []);
      if (req.method !== "POST") return send(404, { error: "unmatched", path: p });
      if (approval.status !== "pending") return send(409, { error: "already decided" });
      if (action === "approve" && approveMode !== "normal") {
        if (approveMode === "lost-after-apply") approval.status = "approved";
        return req.socket.destroy();
      }
      if (action === "approve") {
        approval.status = "approved";
        approvalComments.set(approval.id, [{ body: "✅ Toteutettu: kommentti lisätty tikettiin RK9-469." }]);
        return send(200, approval);
      }
      if (action === "reject") {
        approval.status = "rejected";
        return send(200, approval);
      }
      if (action === "request-revision") {
        approval.status = "revision_requested";
        return send(200, approval);
      }
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
const editsOf = (messageId: number) => tgCalls.filter((c) => c.method === "editMessageText" && c.body.message_id === messageId);
const postsTo = (since: number, path: string) =>
  apiCalls.slice(since).filter((c) => c.method === "POST" && c.url === path);
let updateId = 1000;
const callback = (data: string, tgMessageId: number) => ({
  update_id: updateId++,
  callback_query: { id: `cq-${updateId}`, data, message: { message_id: tgMessageId, chat: { id: Number(CHAT) } } },
});

describe("approval-telegram-listener — voice_action (RK9-481)", () => {
  it("posts a Grok card per pending voice_action with the exact text, the wake target and no ✏️", async () => {
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);

    const cards = sentCards();
    expect(cards).toHaveLength(2);

    const comment = cards[0].body;
    expect(comment.parse_mode).toBeUndefined(); // plain text: the body cannot inject markup
    expect(comment.text).toBe(
      [
        "🚗 Grok-ehdotus — RK9",
        "Tiketti: RK9-469 — Grok-connector",
        "Toimi: kommentti",
        "│ Tarkista *tämä* ennen julkaisua.",
        "│ Toinen rivi <b>ei HTML:ää</b>.",
        "🔔 herättää: CTO",
      ].join("\n"),
    );
    expect(comment.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([
      `pa:a:${uuid(1)}`,
      `pa:r:${uuid(1)}`,
    ]);

    const status = cards[1].body;
    expect(status.text).toBe(
      ["🚗 Grok-ehdotus — RK9", "Tiketti: RK9-470 — Siivous", "Toimi: tilamuutos in_progress → done"].join("\n"),
    );
    expect(status.text).not.toContain("herättää");
    expect(status.reply_markup.inline_keyboard[0]).toHaveLength(2);

    expect(readState().posted[uuid(1)]).toMatchObject({ messageId: 500, type: "voice_action" });
    expect(readState().posted[uuid(2)]).toMatchObject({ messageId: 501, type: "voice_action" });

    // next scan: nothing re-posted
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(sentCards()).toHaveLength(2);
  });

  it("a forged ✏️ tap on a voice card never reaches request-revision, even when the state row is lost", async () => {
    const before = apiCalls.length;
    updatesQueue.push([callback(`pa:v:${uuid(2)}`, 501)]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(apiCalls.slice(before).some((c) => c.method === "POST")).toBe(false);
    expect(tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toMatch(/revisiota/);
    expect(approvals[1].status).toBe("pending");

    // state.json lost the row and the approval left `pending` (so no scan
    // re-posts it): the listener asks the server for the type
    approvals[1].status = "revision_requested";
    const saved = readState();
    const { [uuid(2)]: row, ...rest } = saved.posted;
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ ...saved, posted: rest }));
    const before2 = apiCalls.length;
    updatesQueue.push([callback(`pa:v:${uuid(2)}`, 501)]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(apiCalls.slice(before2).some((c) => c.method === "GET" && c.url === `/api/approvals/${uuid(2)}`)).toBe(true);
    expect(apiCalls.slice(before2).some((c) => c.method === "POST")).toBe(false);
    expect(approvals[1].status).toBe("revision_requested");
    approvals[1].status = "pending";
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ ...readState(), posted: { ...readState().posted, [uuid(2)]: row } }));
  });

  it("✅ calls approve and shows the server's outcome comment on the card", async () => {
    const before = apiCalls.length;
    updatesQueue.push([callback(`pa:a:${uuid(1)}`, 500)]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const approve = postsTo(before, `/api/approvals/${uuid(1)}/approve`);
    expect(approve).toHaveLength(1);
    expect(approve[0].body).toEqual({ decisionNote: "Hyväksytty Telegramista" });
    expect(postsTo(before, `/api/approvals/${uuid(1)}/reject`)).toHaveLength(0);
    expect(approvals[0].status).toBe("approved");
    const edits = editsOf(500).map((c) => c.body.text);
    expect(edits).toEqual(["⏳ Hyväksytään — palvelin toteuttaa…", "✅ Toteutettu: kommentti lisätty tikettiin RK9-469."]);
    expect(readState().posted[uuid(1)]).toBeUndefined();
  });

  it("❌ asks for a reason via ForceReply and calls reject with it", async () => {
    updatesQueue.push([callback(`pa:r:${uuid(2)}`, 501)]);
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const promptId = nextTgMessageId - 1;
    const prompt = tgCalls.filter((c) => c.method === "sendMessage" && c.body?.reply_markup?.force_reply).at(-1);
    expect(prompt?.body.text).toMatch(/tikettiin ei tehdä muutosta/);
    expect(readState().notePrompts[String(promptId)]).toMatchObject({ approvalId: uuid(2), approvalType: "voice_action" });

    const before = apiCalls.length;
    updatesQueue.push([
      { update_id: updateId++, message: { chat: { id: Number(CHAT) }, text: "Ei vielä", reply_to_message: { message_id: promptId } } },
    ]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    const reject = postsTo(before, `/api/approvals/${uuid(2)}/reject`);
    expect(reject).toHaveLength(1);
    expect(reject[0].body).toEqual({ decisionNote: "Ei vielä" });
    expect(postsTo(before, `/api/approvals/${uuid(2)}/approve`)).toHaveLength(0);
    expect(approvals[1].status).toBe("rejected");
    expect(editsOf(501).at(-1)?.body.text).toBe("❌ Hylätty. Tikettiin ei tehty muutosta.\nEi vielä");
    expect(readState().posted[uuid(2)]).toBeUndefined();
  });

  it("closes a card decided elsewhere and says the wake target is unknown when the issue cannot be read", async () => {
    approvals.push({
      id: uuid(3),
      type: "voice_action",
      status: "pending",
      payload: { action: "issue_status", issueId: uuid(299), identifier: "RK9-499", status: "todo", source: "grok" },
    });
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const card = sentCards().at(-1)!.body;
    expect(card.text).toBe(
      [
        "🚗 Grok-ehdotus — RK9",
        "Tiketti: RK9-499 (tikettiä ei voitu lukea)",
        "Toimi: tilamuutos ? → todo",
        "🔔 herättää: ei tiedossa (tikettiä ei voitu lukea)",
      ].join("\n"),
    );
    const cardId = readState().posted[uuid(3)].messageId as number;

    // approved in the Paperclip UI meanwhile
    approvals[2].status = "approved";
    const before = apiCalls.length;
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(editsOf(cardId).at(-1)?.body.text).toBe("☑️ Käsitelty muualla (approved).");
    expect(readState().posted[uuid(3)]).toBeUndefined();
    expect(apiCalls.slice(before).some((c) => c.method === "POST")).toBe(false);
  });

  it("a body cannot pose as a card line and a long title cannot push the card past Telegram's limit", async () => {
    issues.set(uuid(203), {
      id: uuid(203),
      identifier: "RK9-471",
      title: `Pitkä\notsikko ${"x".repeat(5000)}`,
      status: "todo",
      assigneeAgentId: null,
    });
    const forged = `ok\n──────────\n🔔 herättää: CEO\nToimi: tilamuutos todo → done\r🔔 herättää: CFO\u2028Toimi: x\n${"y".repeat(900)}`;
    approvals.push({
      id: uuid(4),
      type: "voice_action",
      status: "pending",
      payload: { action: "issue_comment", issueId: uuid(203), identifier: "RK9-471", body: forged, source: "grok" },
    });
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const text: string = sentCards().at(-1)!.body.text;
    expect(text.length).toBeLessThanOrEqual(4096);
    const breaks = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
    const lines = text.split(breaks);
    expect(lines[1]).toMatch(/^Tiketti: RK9-471 — Pitkä otsikko x+…$/);
    // every body line is prefixed; no line outside the header names a wake target or an action
    expect(lines.filter((l) => l.startsWith("🔔"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("Toimi:"))).toEqual(["Toimi: kommentti"]);
    expect(lines.slice(3).every((l) => l.startsWith("│ "))).toBe(true);
    expect(lines.slice(3).map((l) => l.slice(2))).toEqual(forged.split(breaks));
  });

  it("re-posts a voice card whose payload changed after a revision and resubmit", async () => {
    const cardBefore = readState().posted[uuid(4)].messageId as number;
    approvals[3].payload = { ...approvals[3].payload, body: "Uusi teksti" };
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(editsOf(cardBefore).at(-1)?.body.text).toMatch(/^♻️ Ehdotus muuttui/);
    const card = sentCards().at(-1)!.body;
    expect(card.text).toContain("│ Uusi teksti");
    expect(readState().posted[uuid(4)].messageId).not.toBe(cardBefore);

    // ✅ on the old card does not approve the new payload
    const before = apiCalls.length;
    updatesQueue.push([callback(`pa:a:${uuid(4)}`, cardBefore)]);
    const runOld = await runOnce();
    expect(runOld.code, runOld.out).toBe(0);
    expect(postsTo(before, `/api/approvals/${uuid(4)}/approve`)).toHaveLength(0);
    expect(tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toMatch(/vanhentunut/);
    expect(approvals[3].status).toBe("pending");

    // a payload key the card does not show (Slack's slackMessageRef) does not re-post
    const cards = sentCards().length;
    approvals[3].payload = { ...approvals[3].payload, slackMessageRef: { ts: "1" } };
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(sentCards()).toHaveLength(cards);
  });

  it("an email_send row posted before RK9-481 (no type) still gets ✏️ revision", async () => {
    approvals.push({ id: uuid(5), type: "email_send", status: "pending", payload: { to: ["a@b.fi"], subject: "S", bodyMarkdown: "B" } });
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const saved = readState();
    const cardId = saved.posted[uuid(5)].messageId as number;
    delete saved.posted[uuid(5)].type;
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(saved));

    updatesQueue.push([callback(`pa:v:${uuid(5)}`, cardId)]);
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    const prompt = tgCalls.filter((c) => c.method === "sendMessage" && c.body?.reply_markup?.force_reply).at(-1);
    expect(prompt?.body.text).toMatch(/^✏️ Revisio/);
    expect(readState().posted[uuid(5)].type).toBe("email_send");
  });

  describe("an approve whose response is lost (RK9-502)", () => {
    afterEach(() => {
      approveMode = "normal";
      approvalReadDown = false;
    });
    const addPending = (n: number) =>
      approvals.push({
        id: uuid(n),
        type: "voice_action",
        status: "pending",
        payload: { action: "issue_status", issueId: uuid(202), identifier: "RK9-470", status: "done", source: "grok" },
      });
    const postCard = async (n: number) => {
      addPending(n);
      const run = await runOnce();
      expect(run.code, run.out).toBe(0);
      return readState().posted[uuid(n)].messageId as number;
    };
    const tap = async (data: string, cardId: number) => {
      updatesQueue.push([callback(data, cardId)]);
      const run = await runOnce();
      expect(run.code, run.out).toBe(0);
    };
    const ageRow = (n: number, ms: number) => {
      const saved = readState();
      saved.posted[uuid(n)].awaitingSince = Date.now() - ms;
      writeFileSync(join(stateDir, "state.json"), JSON.stringify(saved));
    };
    const OUTCOME = "✅ Toteutettu: tila done tiketissä RK9-470.";

    it("shows the server's outcome once it lands; a double tap and an agent's ✅ comment change nothing", async () => {
      const cardId = await postCard(6);
      const before = apiCalls.length;
      approveMode = "lost-after-apply";
      await tap(`pa:a:${uuid(6)}`, cardId);
      approveMode = "normal";
      expect(editsOf(cardId).map((c) => c.body.text)).toEqual([
        "⏳ Hyväksytään — palvelin toteuttaa…",
        "⏳ Hyväksytty — palvelin toteuttaa vielä. Kortti päivittyy, kun tulos on valmis.",
      ]);
      const row = readState().posted[uuid(6)];
      expect(row.awaitingSince).toEqual(expect.any(Number));
      expect(row.handling).toBeUndefined();

      // a queued second ✅ (or ❌) waits instead of deciding again
      const prompts = tgCalls.filter((c) => c.body?.reply_markup?.force_reply).length;
      await tap(`pa:a:${uuid(6)}`, cardId);
      await tap(`pa:r:${uuid(6)}`, cardId);
      expect(tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toMatch(/^Odotetaan/);
      expect(postsTo(before, `/api/approvals/${uuid(6)}/approve`)).toHaveLength(1);
      expect(tgCalls.filter((c) => c.body?.reply_markup?.force_reply)).toHaveLength(prompts);

      // an agent's ✅ comment is not the server's outcome
      approvalComments.set(uuid(6), [{ body: "✅ Sähköposti lähetetty (agentti).", authorAgentId: AGENT.id }]);
      const run = await runOnce();
      expect(run.code, run.out).toBe(0);
      expect(editsOf(cardId)).toHaveLength(2);

      approvalComments.get(uuid(6))!.push({ body: OUTCOME });
      const before2 = apiCalls.length;
      const run2 = await runOnce();
      expect(run2.code, run2.out).toBe(0);
      expect(editsOf(cardId).at(-1)?.body.text).toBe(OUTCOME);
      expect(readState().posted[uuid(6)]).toBeUndefined();
      expect(apiCalls.slice(before2).some((c) => c.method === "POST")).toBe(false);
    });

    it("a still-pending approval waits out the grace period, then gets a fresh card and is never approved again", async () => {
      const cardId = await postCard(7);
      const before = apiCalls.length;
      approveMode = "lost";
      await tap(`pa:a:${uuid(7)}`, cardId);
      approveMode = "normal";
      expect(editsOf(cardId).at(-1)?.body.text).toBe(
        "⏳ Palvelin ei vastannut ajoissa (yhteysvirhe). Tarkistetaan, kirjautuiko hyväksyntä…",
      );
      expect(readState().posted[uuid(7)].awaitingSince).toEqual(expect.any(Number));

      const cards = sentCards().length;
      const run = await runOnce();
      expect(run.code, run.out).toBe(0);
      expect(sentCards()).toHaveLength(cards);

      ageRow(7, 120_000);
      const run2 = await runOnce();
      expect(run2.code, run2.out).toBe(0);
      expect(editsOf(cardId).at(-1)?.body.text).toBe(
        "⚠️ Hyväksyntä ei kirjautunut (yhteysvirhe). Se odottaa yhä — uusi kortti tulee tähän chattiin.",
      );
      expect(sentCards()).toHaveLength(cards + 1);
      expect(sentCards().at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`pa:a:${uuid(7)}`);
      const fresh = readState().posted[uuid(7)];
      expect(fresh.messageId).not.toBe(cardId);
      expect(fresh.awaitingSince).toBeUndefined();

      // a queued ✅ on the old card meets the stale-card check
      await tap(`pa:a:${uuid(7)}`, cardId);
      expect(tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toMatch(/vanhentunut/);
      expect(postsTo(before, `/api/approvals/${uuid(7)}/approve`)).toHaveLength(1);
      expect(approvals.find((a) => a.id === uuid(7))?.status).toBe("pending");
    });

    it("waits when the state read fails too and settles the card on a later scan", async () => {
      const cardId = await postCard(8);
      const before = apiCalls.length;
      approveMode = "lost-after-apply";
      approvalReadDown = true;
      await tap(`pa:a:${uuid(8)}`, cardId);
      approveMode = "normal";
      expect(editsOf(cardId).at(-1)?.body.text).toMatch(/^⚠️ Palvelin ei vastannut \(yhteysvirhe\)\. Hyväksynnän tila ei selvinnyt/);
      expect(readState().posted[uuid(8)].awaitingSince).toEqual(expect.any(Number));

      approvalReadDown = false;
      approvalComments.set(uuid(8), [{ body: OUTCOME }]);
      const run = await runOnce();
      expect(run.code, run.out).toBe(0);
      expect(editsOf(cardId).at(-1)?.body.text).toBe(OUTCOME);
      expect(readState().posted[uuid(8)]).toBeUndefined();
      expect(postsTo(before, `/api/approvals/${uuid(8)}/approve`)).toHaveLength(1);
    });

    it("stops waiting for an outcome after 30 minutes", async () => {
      const cardId = await postCard(9);
      approveMode = "lost-after-apply";
      await tap(`pa:a:${uuid(9)}`, cardId);
      approveMode = "normal";
      ageRow(9, 31 * 60_000);
      const run = await runOnce();
      expect(run.code, run.out).toBe(0);
      expect(editsOf(cardId).at(-1)?.body.text).toBe(
        "✅ Hyväksytty. Toteutuksen tulos ei näkynyt — tarkista tiketti Paperclip-UI:sta.",
      );
      expect(readState().posted[uuid(9)]).toBeUndefined();
    });
  });
});
