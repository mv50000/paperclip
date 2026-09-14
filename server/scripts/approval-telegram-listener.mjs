// approval-telegram-listener.mjs — Telegram approval gate for Paperclip
// email_send approvals (RK9-85) and outreach drafts (RK9-222). Mirrors the
// sunspot-ig-listen pattern: pending items are posted to the operator's
// Telegram chat with inline buttons, and a tap approves/rejects within ~1s
// via a getUpdates long-poll.
//
// email_send approvals (callback prefix `pa:`):
//   ✅ Hyväksy   → POST /api/approvals/:id/approve, outcome edited into the msg
//   ❌ Hylkää    → ForceReply prompt; the reply text becomes decisionNote
//   ✏️ Revisio   → ForceReply prompt; the reply text becomes decisionNote
//
// outreach drafts (RK9-222, callback prefix `po:`, `outreach_messages.status = draft`):
//   ✅ Hyväksy   → POST /api/companies/:cid/outreach/messages/:id/approve; a 409
//                  prospect_not_contactable promotes the prospect new→approved
//                  first and retries (same rule as `paperclipai outreach review`)
//   ❌ Hylkää    → ForceReply prompt; the reply text becomes reject_reason
//   (no ✏️ — editing a body on a phone is clumsy; use the CLI review for that)
//   At most OUTREACH_TG_MAX_OPEN (default 5) draft cards are open at a time so a
//   20-draft batch does not flood the chat; the next card is posted once one is
//   decided. Set OUTREACH_TG_ENABLED=0 to turn the outreach source off.
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
//   OUTREACH_TG_ENABLED default 1; "0" disables the outreach draft source
//   OUTREACH_TG_MAX_OPEN default 5; open outreach draft cards at a time (≥ 1; use
//                       OUTREACH_TG_ENABLED=0 to turn the source off, not 0 here)
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
const OUTREACH_ENABLED = (process.env.OUTREACH_TG_ENABLED ?? "1") !== "0";
const OUTREACH_MAX_OPEN = Math.max(1, Number.parseInt(process.env.OUTREACH_TG_MAX_OPEN ?? "5", 10) || 5);

if (!PCP_TOKEN || !TG_TOKEN || !TG_CHAT) {
  console.error("Missing PAPERCLIP_TOKEN / TG_BOT_TOKEN / TG_CHAT_ID");
  process.exit(1);
}

// TG_API_BASE is only overridden by the test harness (points both APIs at a mock server).
const TG_API = `${(process.env.TG_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "")}/bot${TG_TOKEN}`;
const STATE_PATH = join(STATE_DIR, "state.json");

// ── state: posted approvals + tg offset + open ForceReply note prompts ────────
function loadState() {
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    state = { offset: 0, posted: {}, notePrompts: {} };
  }
  // RK9-222: outreach draft cards live in their own map, keyed by
  // outreach_messages.id; a pre-RK9-222 state.json simply lacks the key.
  state.postedOutreach ??= {};
  return state;
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

// RK9-222: one outreach draft card. `prospect` may be null when the lookup
// failed — the card still renders so the operator can act on the message.
function renderOutreachDraft(companyName, message, prospect, waiting) {
  const who = prospect ? `${prospect.orgName ?? "?"} <${prospect.email ?? "?"}>` : "(prospekti ei saatavilla)";
  let body = typeof message.bodyText === "string" ? message.bodyText : "(ei runkoa)";
  if (body.length > 3000) body = body.slice(0, 2997) + "…";
  const lines = [
    `✉️ Outreach-luonnos — ${companyName}`,
    `Prospekti: ${who}`,
    `Aihe: ${message.subject ?? "?"}`,
    "──────────",
    body,
  ];
  if (waiting > 0) lines.push("──────────", `Jonossa vielä ${waiting} luonnosta.`);
  return lines.join("\n");
}

const buildOutreachMarkup = (messageId) => ({
  inline_keyboard: [
    [
      { text: "✅ Hyväksy", callback_data: `po:a:${messageId}` },
      { text: "❌ Hylkää", callback_data: `po:r:${messageId}` },
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

  if (OUTREACH_ENABLED) {
    try {
      await scanOutreach(companies);
    } catch (e) {
      console.error("scanOutreach:", e.message);
    }
  }
}

// ── RK9-222: outreach drafts — post up to OUTREACH_MAX_OPEN cards, close decided ones
// Parked cards (a failed decision, already shown as ⚠️) stay in the map so the
// draft is not re-posted every scan, but they do not hold an open slot.
const openOutreachCount = () => Object.values(state.postedOutreach).filter((e) => !e.parked).length;

async function scanOutreach(companies) {
  const draftIds = new Set();
  const backlog = []; // { company, message } oldest first, not yet posted

  for (const company of companies) {
    const res = await pcp("GET", `/companies/${company.id}/outreach/messages?status=draft&limit=200`);
    if (!res.ok || !Array.isArray(res.json)) continue;
    // API returns newest first; review oldest first so a batch keeps its order.
    for (const message of [...res.json].reverse()) {
      draftIds.add(message.id);
      if (!state.postedOutreach[message.id]) backlog.push({ company, message });
    }
  }

  // decided elsewhere (CLI review / UI) → close the Telegram card too. A card
  // stuck in `handling` longer than a note prompt may live is treated as free.
  const handlingCutoff = Date.now() - NOTE_PROMPT_TTL_MS;
  for (const [messageId, entry] of Object.entries(state.postedOutreach)) {
    if (entry.handling && (entry.at ?? 0) < handlingCutoff) delete entry.handling;
    if (draftIds.has(messageId) || entry.handling) continue;
    const res = await pcp("GET", `/companies/${entry.companyId}/outreach/messages/${messageId}`);
    const status = res.json?.status;
    if (res.status === 404 || (status && status !== "draft")) {
      await editDone(entry.messageId, `☑️ Käsitelty muualla (${status ?? "poistettu"}).`);
      delete state.postedOutreach[messageId];
      saveState(state);
    }
  }

  let remaining = backlog.length;
  for (const { company, message } of backlog) {
    if (openOutreachCount() >= OUTREACH_MAX_OPEN) break;
    remaining -= 1;
    const prospectRes = await pcp("GET", `/companies/${company.id}/outreach/prospects/${message.prospectId}`);
    const prospect = prospectRes.ok ? prospectRes.json : null;
    const msg = await tg("sendMessage", {
      chat_id: TG_CHAT,
      text: renderOutreachDraft(company.name, message, prospect, remaining),
      reply_markup: buildOutreachMarkup(message.id),
    });
    if (msg?.ok) {
      state.postedOutreach[message.id] = {
        messageId: msg.result.message_id,
        companyId: company.id,
        prospectId: message.prospectId,
        label: prospect ? `${prospect.orgName ?? "?"} <${prospect.email ?? "?"}>` : message.prospectId,
        at: Date.now(),
      };
      saveState(state);
      console.log(`posted outreach draft ${message.id} (${company.name})`);
    } else {
      console.error("sendMessage (outreach) failed:", msg?.description);
      break; // Telegram unhappy — retry next scan rather than hammer it
    }
  }
}

async function doOutreachApprove(messageId, entry) {
  const base = `/companies/${entry.companyId}/outreach`;
  let res = await pcp("POST", `${base}/messages/${messageId}/approve`, {});
  if (res.status === 409 && res.json?.error === "prospect_not_contactable") {
    // A prospect still `new` cannot receive an approved message; approving this
    // draft IS the human decision that the prospect is worth contacting.
    const promoted = await pcp("PATCH", `${base}/prospects/${entry.prospectId}`, { status: "approved" });
    if (promoted.ok) res = await pcp("POST", `${base}/messages/${messageId}/approve`, {});
  }
  if (!res.ok) {
    const why = res.json?.error ? ` — ${res.json.error}` : "";
    await editDone(
      entry.messageId,
      `⚠️ Hyväksyntä epäonnistui (HTTP ${res.status}${why}). Käsittele CLI:llä: paperclipai outreach review\n${entry.label ?? ""}`,
    );
    parkOutreach(messageId, entry);
    return;
  }
  await editDone(entry.messageId, `✅ Hyväksytty — lähtee lähetysikkunassa rampin mukaan.\n${entry.label ?? ""}`);
  delete state.postedOutreach[messageId];
  saveState(state);
}

// A decision that throws (API restart, timeout) must not leave the card in
// `handling` forever — that would hold a cap slot and skip cleanup for good.
async function guardOutreachDecision(messageId, entry, run) {
  try {
    await run();
  } catch (e) {
    console.error("outreach decision:", e.message);
    await editDone(
      entry.messageId,
      `⚠️ Yhteysvirhe (${e.message}). Päätöstä ei kirjattu — käsittele CLI:llä: paperclipai outreach review\n${entry.label ?? ""}`,
    );
    parkOutreach(messageId, entry);
  }
}

function parkOutreach(messageId, entry) {
  delete entry.handling;
  entry.parked = true;
  state.postedOutreach[messageId] = entry;
  saveState(state);
}

async function doOutreachReject(messageId, entry, reason) {
  const res = await pcp("POST", `/companies/${entry.companyId}/outreach/messages/${messageId}/reject`, { reason });
  if (!res.ok) {
    const why = res.json?.error ? ` — ${res.json.error}` : "";
    await editDone(
      entry.messageId,
      `⚠️ Hylkäys epäonnistui (HTTP ${res.status}${why}). Käsittele CLI:llä: paperclipai outreach review\n${entry.label ?? ""}`,
    );
    parkOutreach(messageId, entry);
    return;
  }
  await editDone(entry.messageId, `❌ Hylätty. Perustelu tallennettu (reject_reason):\n${reason}\n${entry.label ?? ""}`);
  delete state.postedOutreach[messageId];
  saveState(state);
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
  const mo = /^po:([ar]):([0-9a-f-]{36})$/.exec(cq.data ?? "");
  if (mo) {
    await handleOutreachCallback(cq, mo[1], mo[2]);
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

// RK9-222: outreach card taps. The card's companyId/prospectId live only in
// state.json (callback_data is capped at 64 bytes), so a card whose state was
// lost cannot be acted on from Telegram — say so instead of guessing.
async function handleOutreachCallback(cq, action, messageId) {
  const entry = state.postedOutreach[messageId];
  if (!entry) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Kortti vanhentunut — käytä CLI:tä." });
    // Only rewrite the card if it still shows buttons; a double tap on an
    // already-decided card must not overwrite its "✅ Hyväksytty" outcome.
    if (cq.message?.reply_markup?.inline_keyboard?.length) {
      await editDone(cq.message.message_id, "⚠️ Kortti vanhentunut (tila hävinnyt). Käsittele CLI:llä: paperclipai outreach review");
    }
    return;
  }
  if (action === "a") {
    entry.handling = true;
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Hyväksytään…" });
    await editDone(entry.messageId, "⏳ Hyväksytään…");
    await guardOutreachDecision(messageId, entry, () => doOutreachApprove(messageId, entry));
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Kirjoita hylkäyssyy vastauksena." });
  const prompt = await tg("sendMessage", {
    chat_id: TG_CHAT,
    text: `❌ Hylkäys — vastaa TÄHÄN viestiin syyllä (tallentuu reject_reason-sarakkeeseen, ohjaa promptin parannusta).`,
    reply_markup: { force_reply: true },
  });
  if (prompt?.ok) {
    state.notePrompts[String(prompt.result.message_id)] = {
      kind: "outreach",
      action: "r",
      outreachMessageId: messageId,
      at: Date.now(),
    };
    entry.handling = true;
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
  if (prompt.kind === "outreach") {
    const entry = state.postedOutreach[prompt.outreachMessageId];
    if (!entry) {
      saveState(state);
      return; // card closed meanwhile (decided elsewhere) — nothing to reject
    }
    // The server caps reject reason at 2000 chars (zod); a longer Telegram
    // reply must not turn into a 400 that discards the operator's text.
    await guardOutreachDecision(prompt.outreachMessageId, entry, () =>
      doOutreachReject(prompt.outreachMessageId, entry, note.slice(0, 2000)),
    );
    return;
  }
  const entry = state.posted[prompt.approvalId] ?? { messageId: prompt.origMessageId };
  await doDecline(prompt.action, prompt.approvalId, entry, note);
}

function pruneNotePrompts() {
  const cutoff = Date.now() - NOTE_PROMPT_TTL_MS;
  for (const [key, p] of Object.entries(state.notePrompts)) {
    if (p.at < cutoff) {
      delete state.notePrompts[key];
      if (p.kind === "outreach") {
        if (state.postedOutreach[p.outreachMessageId]) delete state.postedOutreach[p.outreachMessageId].handling;
      } else if (state.posted[p.approvalId]) {
        delete state.posted[p.approvalId].handling;
      }
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
