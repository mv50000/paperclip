// approval-telegram-listener.mjs — Telegram approval gate for Paperclip
// email_send approvals (RK9-85). Mirrors the sunspot-ig-listen pattern:
// pending approvals are posted to the operator's Telegram chat with inline
// buttons, and a tap approves/rejects within ~1s via a getUpdates long-poll.
//
//   ✅ Hyväksy   → POST /api/approvals/:id/approve, outcome edited into the msg
//   ❌ Hylkää    → ForceReply prompt; the reply text becomes decisionNote
//   ✏️ Revisio   → ForceReply prompt; the reply text becomes decisionNote
//
// Deliberately a standalone .mjs with ZERO repo imports (plain `node` — the
// tsx/import path under /opt is known to hang, see vault
// paperclip_fork_git_gotchas / project_ai_support_desk_2026_07). Talks only to
// the Paperclip HTTP API (board token) and the Telegram Bot API.
//
// This bot needs its OWN token: one bot token supports exactly one getUpdates
// consumer, and the sunspot bot's is taken by sunspot-ig-listen.
//
// Env (systemd EnvironmentFile=/etc/paperclip/approval-telegram.env):
//   PAPERCLIP_API_URL   e.g. http://localhost:3100
//   PAPERCLIP_TOKEN     board token (pcp_board_…)
//   TG_BOT_TOKEN        BotFather token for the dedicated approvals bot
//   TG_CHAT_ID          operator's chat id (only this chat may tap buttons)
//   STATE_DIR           default /var/lib/paperclip/approval-telegram
//
//   node approval-telegram-listener.mjs            # long-poll listener (systemd)
//   node approval-telegram-listener.mjs --once     # one scan+drain, then exit (smoke)

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const API_URL = (process.env.PAPERCLIP_API_URL ?? "http://localhost:3100").replace(/\/$/, "");
const PCP_TOKEN = process.env.PAPERCLIP_TOKEN ?? "";
const TG_TOKEN = process.env.TG_BOT_TOKEN ?? "";
const TG_CHAT = String(process.env.TG_CHAT_ID ?? "");
const STATE_DIR = process.env.STATE_DIR ?? "/var/lib/paperclip/approval-telegram";
const SCAN_MIN_INTERVAL_MS = 20_000;
const NOTE_PROMPT_TTL_MS = 30 * 60_000;

if (!PCP_TOKEN || !TG_TOKEN || !TG_CHAT) {
  console.error("Missing PAPERCLIP_TOKEN / TG_BOT_TOKEN / TG_CHAT_ID");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const STATE_PATH = join(STATE_DIR, "state.json");

// ── state: posted approvals + tg offset + open ForceReply note prompts ────────
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { offset: 0, posted: {}, notePrompts: {} };
  }
}
function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state) + "\n");
  renameSync(tmp, STATE_PATH);
}
const state = loadState();

// ── tiny clients ──────────────────────────────────────────────────────────────
async function tg(method, params, timeoutMs = 15_000) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

async function pcp(method, path, body) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${PCP_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, json };
}

// ── message rendering ─────────────────────────────────────────────────────────
function renderApproval(companyName, approval) {
  const p = approval.payload ?? {};
  const to = Array.isArray(p.to) ? p.to.join(", ") : "?";
  let body = typeof p.bodyMarkdown === "string" ? p.bodyMarkdown : "(ei runkoa)";
  if (body.length > 3000) body = body.slice(0, 2997) + "…";
  return [
    `📧 Hyväksyntä — ${companyName}`,
    `Vastaanottaja: ${to}`,
    `Aihe: ${p.subject ?? "?"}`,
    "──────────",
    body,
  ].join("\n");
}

const buildMarkup = (approvalId) => ({
  inline_keyboard: [
    [
      { text: "✅ Hyväksy", callback_data: `pa:a:${approvalId}` },
      { text: "❌ Hylkää", callback_data: `pa:r:${approvalId}` },
      { text: "✏️ Revisio", callback_data: `pa:v:${approvalId}` },
    ],
  ],
});

async function editDone(messageId, text) {
  await tg("editMessageText", {
    chat_id: TG_CHAT,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

// ── scan: post new pending email_send approvals, clean up decided ones ────────
let companiesCache = { at: 0, list: [] };
async function listCompanies() {
  if (Date.now() - companiesCache.at < 10 * 60_000) return companiesCache.list;
  const res = await pcp("GET", "/companies");
  if (res.ok && Array.isArray(res.json)) {
    companiesCache = { at: Date.now(), list: res.json.map((c) => ({ id: c.id, name: c.name })) };
  }
  return companiesCache.list;
}

async function scan() {
  const companies = await listCompanies();
  const pendingIds = new Set();

  for (const company of companies) {
    const res = await pcp("GET", `/companies/${company.id}/approvals?status=pending`);
    if (!res.ok || !Array.isArray(res.json)) continue;
    for (const approval of res.json) {
      if (approval.type !== "email_send") continue;
      pendingIds.add(approval.id);
      if (state.posted[approval.id]) continue;
      const msg = await tg("sendMessage", {
        chat_id: TG_CHAT,
        text: renderApproval(company.name, approval),
        reply_markup: buildMarkup(approval.id),
      });
      if (msg?.ok) {
        state.posted[approval.id] = { messageId: msg.result.message_id, at: Date.now() };
        saveState(state);
        console.log(`posted approval ${approval.id} (${company.name})`);
      } else {
        console.error("sendMessage failed:", msg?.description);
      }
    }
  }

  // decided elsewhere (Paperclip UI / CLI) → close the Telegram card too
  for (const [approvalId, entry] of Object.entries(state.posted)) {
    if (pendingIds.has(approvalId) || entry.handling) continue;
    const res = await pcp("GET", `/approvals/${approvalId}`);
    const status = res.json?.status;
    if (res.status === 404 || (status && status !== "pending")) {
      await editDone(entry.messageId, `☑️ Käsitelty muualla (${status ?? "poistettu"}).`);
      delete state.posted[approvalId];
      saveState(state);
    }
  }
}

// ── decisions ─────────────────────────────────────────────────────────────────
async function latestOutcomeComment(approvalId) {
  const res = await pcp("GET", `/approvals/${approvalId}/comments`);
  if (!res.ok || !Array.isArray(res.json)) return null;
  const outcome = [...res.json].reverse().find((c) => /^(✅|⚠️)/.test(c.body ?? ""));
  return outcome?.body ?? null;
}

async function doApprove(approvalId, entry) {
  const res = await pcp("POST", `/approvals/${approvalId}/approve`, {
    decisionNote: "Hyväksytty Telegramista",
  });
  if (!res.ok) {
    await editDone(entry.messageId, `⚠️ Hyväksyntä epäonnistui (HTTP ${res.status}). Käsittele Paperclip-UI:ssa.`);
  } else {
    const outcome = (await latestOutcomeComment(approvalId)) ?? "✅ Hyväksytty.";
    await editDone(entry.messageId, outcome);
  }
  delete state.posted[approvalId];
  saveState(state);
}

async function doDecline(action, approvalId, entry, note) {
  const path = action === "r" ? "reject" : "request-revision";
  const res = await pcp("POST", `/approvals/${approvalId}/${path}`, { decisionNote: note });
  if (!res.ok) {
    await editDone(entry.messageId, `⚠️ ${path} epäonnistui (HTTP ${res.status}). Käsittele Paperclip-UI:ssa.`);
    delete state.posted[approvalId];
  } else if (action === "r") {
    await editDone(entry.messageId, `❌ Hylätty. Perustelu välitetty agentille:\n${note}`);
    delete state.posted[approvalId];
  } else {
    await editDone(
      entry.messageId,
      `✏️ Revisio pyydetty. Agentti laatii uuden version — se ilmestyy tähän chattiin uutena korttina.\n${note}`,
    );
    // resubmit flips the approval back to pending → allow a fresh card
    delete state.posted[approvalId];
  }
  saveState(state);
}

// ── update handling ───────────────────────────────────────────────────────────
async function handleCallback(cq) {
  const chatId = String(cq.message?.chat?.id ?? "");
  if (chatId !== TG_CHAT) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Ei oikeutta." });
    return;
  }
  const m = /^pa:([arv]):([0-9a-f-]{36})$/.exec(cq.data ?? "");
  if (!m) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  const [, action, approvalId] = m;
  const entry = state.posted[approvalId] ?? { messageId: cq.message.message_id };

  if (action === "a") {
    entry.handling = true;
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Hyväksytään ja lähetetään…" });
    await editDone(entry.messageId, "⏳ Hyväksytään — palvelin lähettää…");
    await doApprove(approvalId, entry);
    return;
  }

  // reject / revision → ask for the note via ForceReply
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Kirjoita perustelu vastauksena." });
  const prompt = await tg("sendMessage", {
    chat_id: TG_CHAT,
    text:
      action === "r"
        ? `❌ Hylkäys — vastaa TÄHÄN viestiin perustelulla (menee agentille decisionNotena).`
        : `✏️ Revisio — vastaa TÄHÄN viestiin ohjeella agentille.`,
    reply_markup: { force_reply: true },
  });
  if (prompt?.ok) {
    state.notePrompts[String(prompt.result.message_id)] = {
      action,
      approvalId,
      origMessageId: state.posted[approvalId]?.messageId ?? cq.message.message_id,
      at: Date.now(),
    };
    if (state.posted[approvalId]) state.posted[approvalId].handling = true;
    saveState(state);
  }
}

async function handleMessage(msg) {
  if (String(msg.chat?.id ?? "") !== TG_CHAT) return;
  const repliedTo = msg.reply_to_message?.message_id;
  if (!repliedTo) return;
  const prompt = state.notePrompts[String(repliedTo)];
  if (!prompt) return;
  const note = (msg.text ?? "").trim() || "(ei perustelua)";
  delete state.notePrompts[String(repliedTo)];
  const entry = state.posted[prompt.approvalId] ?? { messageId: prompt.origMessageId };
  await doDecline(prompt.action, prompt.approvalId, entry, note);
}

function pruneNotePrompts() {
  const cutoff = Date.now() - NOTE_PROMPT_TTL_MS;
  for (const [key, p] of Object.entries(state.notePrompts)) {
    if (p.at < cutoff) {
      delete state.notePrompts[key];
      if (state.posted[p.approvalId]) delete state.posted[p.approvalId].handling;
    }
  }
}

// ── main loop: getUpdates long-poll paces the approval scans ─────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const once = process.argv.includes("--once");
  console.log(`▶ approval-telegram listening (${API_URL}, chat ${TG_CHAT})…`);
  let lastScan = 0;
  for (;;) {
    if (Date.now() - lastScan >= SCAN_MIN_INTERVAL_MS) {
      try {
        await scan();
      } catch (e) {
        console.error("scan:", e.message);
      }
      lastScan = Date.now();
      pruneNotePrompts();
    }
    let upd;
    try {
      upd = await tg(
        "getUpdates",
        { offset: state.offset, timeout: once ? 0 : 25, allowed_updates: ["callback_query", "message"] },
        35_000,
      );
    } catch {
      if (once) break;
      await sleep(3000);
      continue;
    }
    if (upd?.ok) {
      for (const u of upd.result) {
        state.offset = u.update_id + 1;
        try {
          if (u.callback_query) await handleCallback(u.callback_query);
          else if (u.message) await handleMessage(u.message);
        } catch (e) {
          console.error("handle:", e.message);
        }
      }
      if (upd.result.length) saveState(state);
    } else if (!once) {
      console.error("getUpdates:", upd?.description);
      await sleep(3000);
    }
    if (once) {
      console.log("✓ once done");
      break;
    }
  }
}

await main();
