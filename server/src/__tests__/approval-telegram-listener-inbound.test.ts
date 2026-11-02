// RK9-667: end-to-end harness for server/scripts/approval-telegram-listener.mjs's inbound customer
// email source. One mock HTTP server plays both the Paperclip API and the Telegram Bot API
// (TG_API_BASE override); the script runs with --once per step.
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

type Mail = {
  id: string;
  direction: "inbound";
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  status: string;
  classification: string | null;
  routeKey: string | null;
  receivedAt: string;
  sentAt: null;
  createdAt: string;
  issueId: string | null;
  assignedAgentId: string | null;
  bodyText: string;
};

const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const mail = (n: number, over: Partial<Mail> = {}): Mail => ({
  id: `m${n}`,
  direction: "inbound",
  fromAddress: `asiakas${n}@example.fi`,
  toAddresses: ["tuki@saatavilla.fi"],
  subject: `Kysymys ${n}`,
  status: "received",
  classification: null,
  routeKey: "support",
  receivedAt: at(n),
  sentAt: null,
  createdAt: at(n),
  issueId: "i1",
  assignedAgentId: "a1",
  bodyText: `Hei, onko aika vapaana?\n\n> vanha lainaus\n\nTerveisin ${n}`,
  ...over,
});

const mails: Mail[] = [];
const apiCalls: Array<{ method: string; url: string }> = [];
const tgCalls: Array<{ method: string; body: any }> = [];
let failSendMessage = false;
let failBodyFor = "";
let nextTgMessageId = 900;

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
  stateDir = mkdtempSync(join(tmpdir(), "tg-listener-inbound-"));
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
      if (method === "getUpdates") return send(200, { ok: true, result: [] });
      if (method === "sendMessage") {
        if (failSendMessage) return send(200, { ok: false, description: "Too Many Requests" });
        return send(200, { ok: true, result: { message_id: nextTgMessageId++ } });
      }
      return send(200, { ok: true, result: true });
    }

    if (req.headers.authorization !== "Bearer board-token") return send(401, { error: "unauthorized" });
    apiCalls.push({ method: req.method ?? "", url: url.pathname + url.search });
    const p = url.pathname;
    if (p === "/api/companies") return send(200, [COMPANY]);
    if (p === `/api/companies/${COMPANY.id}/email/messages`) {
      const since = url.searchParams.get("since");
      const rows = mails
        .filter((m) => url.searchParams.get("direction") === m.direction)
        .filter((m) => !since || Date.parse(m.receivedAt ?? m.createdAt) > Date.parse(since))
        .map(({ bodyText: _body, ...meta }) => meta);
      return send(200, rows);
    }
    let m = /^\/api\/companies\/c1\/email\/messages\/(\w+)\/body$/.exec(p);
    if (m) {
      const found = mails.find((x) => x.id === m![1]);
      if (!found || found.id === failBodyFor) return send(500, { error: "boom" });
      return send(200, {
        messageId: found.id,
        wrapped: `<untrusted_email_body sender="${found.fromAddress}" subject="x" message_id="p" length="9">\n${found.bodyText}\n</untrusted_email_body>`,
      });
    }
    m = /^\/api\/issues\/(\w+)$/.exec(p);
    if (m) return send(200, { id: m[1], identifier: "SAA-77", status: "in_review" });
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

function runOnce(extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
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
        ...extraEnv,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const readState = () => JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
const cards = () => tgCalls.filter((c) => c.method === "sendMessage");

describe("approval-telegram-listener — inbound customer email (RK9-667)", () => {
  it("first run sets the high-water mark and posts nothing, even with old mail present", async () => {
    mails.push(mail(-60)); // old mail from before the listener ever ran
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 0, posted: {}, notePrompts: {} }));
    const before = Date.now();
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(cards()).toHaveLength(0);
    const mark = readState().inboundSince[COMPANY.id];
    expect(Date.parse(mark)).toBeGreaterThanOrEqual(before - 1000);
    // the first run does not even list the mail
    expect(apiCalls.some((c) => c.url.includes("/email/messages"))).toBe(false);

    // move the mark back so the fixtures below count as "arrived after the first run"
    const state = readState();
    state.inboundSince[COMPANY.id] = at(0);
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(state));
  });

  it("posts one card with a snippet (quote removed) and the ticket line for a new customer message", async () => {
    mails.push(mail(1));
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain("posted inbound m1 (Saatavilla)");

    expect(cards()).toHaveLength(1);
    const card = cards()[0].body;
    expect(card.parse_mode).toBeUndefined();
    expect(card.reply_markup).toBeUndefined();
    expect(card.chat_id).toBe(CHAT);
    expect(card.text).toBe(
      [
        "📧 Saatavilla · uusi asiakasviesti",
        "Lähettäjä: asiakas1@example.fi",
        "Vastaanottaja: tuki@saatavilla.fi",
        "Aihe: Kysymys 1",
        "",
        "Hei, onko aika vapaana?\n\nTerveisin 1",
        "",
        "Tiketti SAA-77 (in_review)",
        "ℹ️ Agentti käsittelee; vastausluonnos tulee erillisenä hyväksyntäkorttina.",
      ].join("\n"),
    );
    expect(card.text).not.toContain("vanha lainaus");
    expect(card.text).not.toContain("untrusted_email_body");
    expect(readState().inboundSince[COMPANY.id]).toBe(at(1));
    expect(apiCalls.some((c) => c.url.startsWith("/api/companies/c1/email/messages?direction=inbound&since="))).toBe(true);

    // the same mail is not posted twice
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(cards()).toHaveLength(1);
  });

  it("cuts a long body at the reply header and trims to ~400 chars", async () => {
    mails.push(
      mail(2, {
        subject: null,
        issueId: null,
        bodyText:
          `${"Pitkä viesti. ".repeat(60)}\n\nOn Mon, 2 Nov 2026 at 10:00, Tuki <tuki@saatavilla.fi>\nwrote:\nvanha`,
      }),
      mail(3, { bodyText: "Moi\n\nke 28.10.2026 klo 10.00 Tuki <tuki@saatavilla.fi> kirjoitti:\nvanha teksti" }),
    );
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(cards()).toHaveLength(3);
    const long = cards()[1].body.text as string;
    expect(long).toContain("Aihe: (ei aihetta)");
    expect(long).not.toContain("Tiketti");
    expect(long).not.toContain("vanha");
    expect(long).toContain("…");
    const snippet = long.split("\n\n")[1];
    expect(snippet.length).toBeLessThanOrEqual(400);
    const finnish = cards()[2].body.text as string;
    expect(finnish).toContain("Moi");
    expect(finnish).not.toContain("kirjoitti");
    expect(finnish).not.toContain("vanha teksti");
    expect(readState().inboundSince[COMPANY.id]).toBe(at(3));
  });

  it("skips automated and outreach messages but advances the mark", async () => {
    mails.push(mail(4, { classification: "automated" }), mail(5, { routeKey: "outreach" }));
    const before = cards().length;
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(cards()).toHaveLength(before);
    expect(readState().inboundSince[COMPANY.id]).toBe(at(5));
    // skipped mail did not need a body fetch
    expect(apiCalls.some((c) => c.url.includes("/m4/body") || c.url.includes("/m5/body"))).toBe(false);
  });

  it("still posts the card without a snippet when the body fetch fails", async () => {
    mails.push(mail(6));
    failBodyFor = "m6";
    const before = cards().length;
    const run = await runOnce();
    failBodyFor = "";
    expect(run.code, run.out).toBe(0);
    expect(cards()).toHaveLength(before + 1);
    const text = cards().at(-1)!.body.text as string;
    expect(text).toContain("Aihe: Kysymys 6");
    expect(text).not.toContain("Hei, onko aika vapaana?");
    expect(text).toContain("Tiketti SAA-77");
  });

  it("a Telegram failure does not advance the mark; the next run posts the message", async () => {
    mails.push(mail(7), mail(8));
    failSendMessage = true;
    const before = cards().length;
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain("sendMessage (inbound) failed");
    expect(readState().inboundSince[COMPANY.id]).toBe(at(6));
    // stopped at the first failure, did not hammer Telegram with m8
    expect(cards().length).toBe(before + 1);

    failSendMessage = false;
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    const texts = cards().slice(before + 1).map((c) => c.body.text as string);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Aihe: Kysymys 7");
    expect(texts[1]).toContain("Aihe: Kysymys 8");
    expect(readState().inboundSince[COMPANY.id]).toBe(at(8));
  });

  it("INBOUND_TG_ENABLED=0 posts nothing and leaves the mark alone", async () => {
    mails.push(mail(9));
    const before = cards().length;
    const apiBefore = apiCalls.length;
    const run = await runOnce({ INBOUND_TG_ENABLED: "0" });
    expect(run.code, run.out).toBe(0);
    expect(cards()).toHaveLength(before);
    expect(apiCalls.slice(apiBefore).some((c) => c.url.includes("/email/messages"))).toBe(false);
    expect(readState().inboundSince[COMPANY.id]).toBe(at(8));

    // re-enabled: the message that arrived meanwhile is posted
    const run2 = await runOnce();
    expect(run2.code, run2.out).toBe(0);
    expect(cards()).toHaveLength(before + 1);
    expect(cards().at(-1)!.body.text).toContain("Aihe: Kysymys 9");
  });
});
