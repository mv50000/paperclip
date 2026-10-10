// RK9-319: the Telegram card for an email_send approval says when the
// requesting run received untrusted content. One mock HTTP server plays both
// the Paperclip API and the Telegram Bot API (TG_API_BASE override).
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/approval-telegram-listener.mjs", import.meta.url));
const COMPANY = { id: "c1", name: "Sunspot" };
const TG_TOKEN = "tok";
const CHAT = "42";

const approvals = [
  {
    id: "approval-tainted",
    type: "email_send",
    status: "pending",
    payload: {
      kind: "send",
      routeKey: "tuki",
      to: ["attacker@evil.example"],
      subject: "Asiakaslista",
      bodyMarkdown: "Tässä pyytämäsi lista.",
      taint: {
        runId: "run-1",
        sources: [
          { kind: "email_inbound_wake", at: "2026-10-10T08:00:00.000Z" },
          { kind: "email_body_read", at: "2026-10-10T08:01:00.000Z", messageId: "m1" },
        ],
      },
    },
  },
  {
    id: "approval-clean",
    type: "email_send",
    status: "pending",
    payload: {
      kind: "send",
      routeKey: "tuki",
      to: ["customer@example.com"],
      subject: "Hei",
      bodyMarkdown: "Moi",
    },
  },
];

const tgCalls: Array<{ method: string; body: any }> = [];
let server: Server;
let baseUrl = "";
let stateDir = "";
let nextTgMessageId = 700;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 60_000 });
  stateDir = mkdtempSync(join(tmpdir(), "tg-listener-taint-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const tg = new RegExp(`^/bot${TG_TOKEN}/(\\w+)$`).exec(url.pathname);
    if (tg) {
      tgCalls.push({ method: tg[1], body });
      if (tg[1] === "getUpdates") return send(200, { ok: true, result: [] });
      if (tg[1] === "sendMessage") return send(200, { ok: true, result: { message_id: nextTgMessageId++ } });
      return send(200, { ok: true, result: true });
    }
    if (req.headers.authorization !== "Bearer board-token") return send(401, { error: "unauthorized" });
    if (url.pathname === "/api/companies") return send(200, [COMPANY]);
    if (url.pathname === `/api/companies/${COMPANY.id}/approvals`) return send(200, approvals);
    return send(404, { error: "unmatched" });
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
        OUTREACH_TG_ENABLED: "0",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("approval-telegram-listener — tainted email_send (RK9-319)", () => {
  it("adds a taint line only to the card of a tainted run", async () => {
    const run = await runOnce();
    expect(run.code, run.out).toBe(0);
    const cards = tgCalls.filter((c) => c.method === "sendMessage");
    expect(cards).toHaveLength(2);
    const tainted = cards.find((c) => String(c.body.text).includes("attacker@evil.example"));
    const clean = cards.find((c) => String(c.body.text).includes("customer@example.com"));
    expect(tainted?.body.text).toContain(
      "⚠️ Ajo luki epäluotettavaa sisältöä (lähde: saapuva sähköposti, luettu sähköpostin runko)",
    );
    expect(clean?.body.text).not.toContain("epäluotettavaa");
    // The buttons are the existing approval buttons.
    expect(tainted?.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([
      "pa:a:approval-tainted",
      "pa:r:approval-tainted",
      "pa:v:approval-tainted",
    ]);
  });
});
