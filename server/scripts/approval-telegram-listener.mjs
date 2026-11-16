// approval-telegram-listener.mjs — Telegram approval gate for Paperclip
// email_send approvals (RK9-85), outreach drafts (RK9-222), voice_action
// approvals (RK9-481) and Aava send requests (RK9-894), plus a plain info card
// per inbound customer email (RK9-667). Mirrors the
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
// voice_action approvals (RK9-481, same `pa:` prefix and endpoints as email_send):
//   A Grok proposal for one issue: a comment with its exact text, or a new status.
//   ✅ Hyväksy   → POST /api/approvals/:id/approve; the server applies the action
//   ❌ Hylkää    → ForceReply prompt; the reply text becomes decisionNote
//   (no ✏️ — a voice proposal is not revised, Grok makes a new one)
//   When the issue has an assignee agent, the card names it ("🔔 herättää"),
//   because an approved action wakes that agent (operator decision, RK9-490).
//
// Aava send requests (RK9-894, same `pa:` prefix and endpoints as email_send):
//   A `request_board_approval` whose payload.kind is "aava_send", created by
//   aava-gate-relay (RK9-903) for a mail the Aava send gate holds. Only the RK9
//   company's approvals get a card (AAVA_TG_COMPANY_PREFIX); every other
//   request_board_approval is ignored, and a tap on one is refused.
//   ✅ Lähetä    → POST /api/approvals/:id/approve. The server sends nothing; the
//                  relay reads the decision and hands it to the gate, which sends
//                  only the stored message whose sha256 matches.
//   ❌ Hylkää    → ForceReply prompt; the reply text becomes decisionNote
//   (no ✏️ — the gate holds one fixed message, a revision has nothing to revise)
//   From, To, subject and body are untrusted text: line breaks, bidi controls
//   and Telegram auto-links (/command, @mention, #tag) are neutralised, and
//   every body line carries a "│ " prefix.
//
// inbound customer email (RK9-667, info card only: no buttons, no callback prefix):
//   A card for every new human inbound message at any company's support inbox, so
//   the operator learns a customer wrote even when the agent closes the ticket
//   without a reply. Automated mail and outreach replies (own watcher) are skipped.
//   The first scan of a company only records a high-water mark; old mail is not
//   posted. If Telegram refuses a card the mark stays put and the next scan retries.
//
// An approve that times out, loses its connection or gets a 5xx (RK9-502) is never sent
// again. The listener reads the approval instead and puts its real state on
// the card: the outcome comment once approved, a fresh card if still pending.
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
//   INBOUND_TG_ENABLED  default 1; "0" disables the inbound customer email source
//   OUTREACH_TG_MAX_OPEN default 5; open outreach draft cards at a time (≥ 1; use
//                       OUTREACH_TG_ENABLED=0 to turn the source off, not 0 here)
//   AAVA_TG_COMPANY_PREFIX default RK9; the company whose aava_send approvals get
//                       a card ("" turns the Aava source off)
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
// RK9-502: how long a timed-out approve waits for the server's outcome comment.
const APPROVE_OUTCOME_WAIT_MS = 30 * 60_000;
// RK9-502: a timed-out approve may still be queued on the server; a pending
// approval counts as "not recorded" only after this long.
const APPROVE_PENDING_GRACE_MS = 60_000;
const OUTREACH_ENABLED = (process.env.OUTREACH_TG_ENABLED ?? "1") !== "0";
const INBOUND_ENABLED = (process.env.INBOUND_TG_ENABLED ?? "1") !== "0";
const OUTREACH_MAX_OPEN = Math.max(1, Number.parseInt(process.env.OUTREACH_TG_MAX_OPEN ?? "5", 10) || 5);
const AAVA_COMPANY_PREFIX = (process.env.AAVA_TG_COMPANY_PREFIX ?? "RK9").trim();

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
  // RK9-667: per-company ISO high-water mark of the inbound email already handled.
  state.inboundSince ??= {};
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
  const lines = [
    `📧 Hyväksyntä — ${companyName}`,
    `Vastaanottaja: ${to}`,
    `Aihe: ${p.subject ?? "?"}`,
  ];
  // RK9-319: the requesting run received untrusted content (e.g. the inbound
  // email this answers). Read the draft for injected instructions.
  const taintLine = renderTaintLine(p.taint);
  if (taintLine) lines.push(taintLine);
  lines.push("──────────", body);
  return lines.join("\n");
}

const TAINT_KIND_LABELS = {
  email_inbound_wake: "saapuva sähköposti",
  email_issue_context: "sähköpostitiketti",
  email_body_read: "luettu sähköpostin runko",
  propagated_wake: "tainted-ajon herätys",
  resumed_session: "tainted-sessio",
};

function renderTaintLine(taint) {
  if (!taint || typeof taint !== "object") return null;
  const kinds = Array.isArray(taint.sources)
    ? [...new Set(taint.sources.map((s) => TAINT_KIND_LABELS[s?.kind] ?? String(s?.kind ?? "?")))]
    : [];
  return `⚠️ Ajo luki epäluotettavaa sisältöä (lähde: ${kinds.length > 0 ? kinds.join(", ") : "tuntematon"})`;
}

const EMAIL_SEND = "email_send";
const VOICE_ACTION = "voice_action";
// RK9-894: Aava send requests ride on the generic board approval type, because
// approving an email_send would make the server send the mail itself.
const BOARD_APPROVAL = "request_board_approval";
const AAVA_SEND = "aava_send";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every character a Telegram client may draw as a line break.
const LINE_BREAK_RE = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

// What a voice card shows. A board actor can request a revision and resubmit
// a new payload between two scans; the approval is then pending again, so a
// changed signature is the only sign that the open card is stale.
const voiceSignature = (payload) => {
  const p = payload ?? {};
  return JSON.stringify([p.action, p.issueId, p.identifier, p.body, p.status]);
};

const buildMarkup = (approvalId, type) => ({
  inline_keyboard: [
    [
      { text: type === BOARD_APPROVAL ? "✅ Lähetä" : "✅ Hyväksy", callback_data: `pa:a:${approvalId}` },
      { text: "❌ Hylkää", callback_data: `pa:r:${approvalId}` },
      ...(type === EMAIL_SEND ? [{ text: "✏️ Revisio", callback_data: `pa:v:${approvalId}` }] : []),
    ],
  ],
});

// One line, at most `max` chars: titles and names must not break the card layout.
const oneLine = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

// ── RK9-894: Aava send requests ───────────────────────────────────────────────
// The relay (RK9-903) writes this exact payload. A payload that breaks the
// contract gets no card: it never reaches the operator half-rendered.
const AAVA_GATE_ID_RE = /^g-[0-9a-f]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@<>"]{1,200}@[^\s@<>"]{1,200}$/;
const isEmail = (v) => typeof v === "string" && EMAIL_RE.test(v);

function isAavaSendPayload(p) {
  return (
    !!p &&
    typeof p === "object" &&
    p.kind === AAVA_SEND &&
    p.version === 1 &&
    typeof p.gateId === "string" &&
    AAVA_GATE_ID_RE.test(p.gateId) &&
    (p.op === "reply" || p.op === "new") &&
    isEmail(p.from) &&
    Array.isArray(p.to) &&
    p.to.length > 0 &&
    p.to.every(isEmail) &&
    typeof p.subject === "string" &&
    typeof p.body === "string" &&
    Array.isArray(p.reasons) &&
    p.reasons.every((r) => typeof r === "string") &&
    typeof p.sha256 === "string" &&
    SHA256_RE.test(p.sha256)
  );
}

// What an Aava card shows, plus the hash the gate checks. A changed signature
// closes the open card and posts a fresh one (same rule as voiceSignature).
const aavaSignature = (payload) => {
  const p = payload ?? {};
  return JSON.stringify([p.gateId, p.op, p.from, p.to, p.subject, p.body, p.reasons, p.sha256]);
};

// Bidi overrides/isolates can reorder an address on screen; C0 controls have no
// business in a card.
const UNSAFE_CHARS_RE = /[\u0000-\u0008\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
// Telegram turns /cmd, @name, #tag and $TAG in plain text into tappable
// entities. A WORD JOINER after the sigil keeps the look and breaks the entity.
const AUTOLINK_SIGIL_RE = /([/@#$])(?=[\p{L}\p{N}_])/gu;
const neutralize = (text) => String(text ?? "").replace(UNSAFE_CHARS_RE, "").replace(AUTOLINK_SIGIL_RE, "$1\u2060");
// A header value: one line, neutralised, at most `max` chars.
const headerText = (value, max) => oneLine(neutralize(String(value ?? "").split(LINE_BREAK_RE).join(" ")), max);

const AAVA_REASON_LABELS = {
  "new-recipient": "uusi vastaanottaja",
  "added-recipient": "lisätty vastaanottaja",
  "new-message": "uusi viesti, ei ketjuvastaus",
  cc: "kopio (Cc)",
  "no-dmarc": "lähettäjän DMARC ei läpäissyt",
  "dmarc-fail": "lähettäjän DMARC ei läpäissyt",
  automated: "emoviesti on automaattiposti",
};

function aavaReason(code) {
  const c = String(code);
  if (c.startsWith("screen:")) return `seulasana "${headerText(c.slice("screen:".length), 60)}"`;
  return AAVA_REASON_LABELS[c] ?? headerText(c, 60);
}

// The approvals API masks credential-looking values before it answers
// (redactEventPayload). The gate still sends the original text.
const REDACTED_MARK = "***REDACTED***";
// Telegram's cap is 4096 chars; String#length counts UTF-16 units, which is
// never less than the char count, so this budget leaves room for the footer.
const AAVA_CARD_MAX = 3900;
const AAVA_RECIPIENTS_SHOWN = 20;

function aavaRecipients(to) {
  const shown = to.slice(0, AAVA_RECIPIENTS_SHOWN).map((a) => headerText(a, 200));
  const more = to.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` (+${more} muuta)` : ""}`;
}

// Shown after the decision, so a decided card still says what it was about.
const aavaLabel = (p) => `To: ${headerText(aavaRecipients(p.to), 300)}\nAihe: ${headerText(p.subject, 200) || "(ei aihetta)"}`;

function renderAavaSend(companyName, approval) {
  const p = approval.payload;
  const head = [
    `📨 Aava: lähetys odottaa — ${headerText(companyName, 100)}`,
    `From: ${headerText(p.from, 200)}`,
    `To${p.to.length > 1 ? ` (${p.to.length})` : ""}: ${aavaRecipients(p.to)}`,
    `Aihe: ${headerText(p.subject, 300) || "(ei aihetta)"}`,
    `Tyyppi: ${p.op === "reply" ? "vastaus ketjuun" : "uusi viesti"}`,
    `Syyt: ${p.reasons.length ? p.reasons.map(aavaReason).join(", ") : "(ei syytä)"}`,
  ];
  if (`${p.subject}\n${p.body}`.includes(REDACTED_MARK)) {
    head.push(`⚠️ Viestissä on salaisuudelta näyttävä arvo (${REDACTED_MARK}). Viesti lähtee alkuperäisenä, ei peitettynä.`);
  }
  head.push(`Tunniste: ${p.gateId} · sha256 ${p.sha256.slice(0, 12)}…`, "──────────");

  const bodyLines = p.body.length ? p.body.split(LINE_BREAK_RE) : ["(ei runkoa)"];
  let text = head.join("\n");
  const footer = (shown) =>
    `\n──────────\n✂️ Runko katkaistu: näytetty ${shown} / ${p.body.length} merkkiä. Lue koko viesti Paperclip-UI:sta ennen lähetystä.`;
  const budget = AAVA_CARD_MAX - footer(p.body.length).length;
  let shownChars = 0;
  let truncated = false;
  for (const raw of bodyLines) {
    const line = `\n│ ${neutralize(raw)}`;
    if (text.length + line.length <= budget) {
      text += line;
      shownChars += raw.length + 1;
      continue;
    }
    let part = line.slice(0, Math.max(0, budget - text.length - 1));
    // never leave half of a surrogate pair at the cut
    if (/[\ud800-\udbff]$/.test(part)) part = part.slice(0, -1);
    if (part.length > 3) {
      text += part + "…";
      shownChars += Math.max(0, part.length - 3);
    }
    truncated = true;
    break;
  }
  if (truncated) text += footer(Math.min(shownChars, p.body.length));
  return text;
}

// RK9-481: one voice_action card. The issue and its assignee are read live so
// the card shows the issue as it is now; a lookup that answers with an error
// still renders the card from the payload, and says that the wake target is
// unknown. A lookup that throws skips the card until the next scan.
async function renderVoiceAction(companyName, approval) {
  const p = approval.payload ?? {};
  const issueRes = UUID_RE.test(p.issueId ?? "") ? await pcp("GET", `/issues/${p.issueId}`) : null;
  const issue = issueRes?.ok ? issueRes.json : null;
  const lines = [`🚗 Grok-ehdotus — ${companyName}`];
  if (issue) {
    lines.push(`Tiketti: ${issue.identifier ?? p.identifier ?? "?"} — ${oneLine(issue.title, 200)}`.trimEnd());
  } else {
    lines.push(`Tiketti: ${p.identifier ?? "?"} (tikettiä ei voitu lukea)`);
  }
  if (p.action === "issue_comment") {
    // Never truncated: the operator approves this exact text (≤ 1000 chars by
    // schema). Every line carries a "│ " prefix, so the text cannot pose as a
    // card line (a forged "🔔 herättää" or "Toimi:").
    const body = typeof p.body === "string" ? p.body : "(ei tekstiä)";
    lines.push("Toimi: kommentti", ...body.split(LINE_BREAK_RE).map((line) => `│ ${line}`));
  } else if (p.action === "issue_status") {
    lines.push(`Toimi: tilamuutos ${issue?.status ?? "?"} → ${p.status ?? "?"}`);
  } else {
    lines.push(`Toimi: tuntematon (${String(p.action ?? "?")})`);
  }
  const wake = await renderWakeLine(issue);
  if (wake) lines.push(wake);
  return lines.join("\n");
}

async function renderWakeLine(issue) {
  if (!issue) return "🔔 herättää: ei tiedossa (tikettiä ei voitu lukea)";
  if (!UUID_RE.test(issue.assigneeAgentId ?? "")) return null;
  const agentRes = await pcp("GET", `/agents/${issue.assigneeAgentId}`);
  const name = agentRes.ok && typeof agentRes.json?.name === "string" ? agentRes.json.name : null;
  return `🔔 herättää: ${name ? oneLine(name, 100) : "tiketin assignee-agentti"}`;
}

// RK9-222: one outreach draft card. `prospect` may be null when the lookup
// failed — the card still renders so the operator can act on the message.
function renderOutreachDraft(companyName, message, prospect, waiting) {
  const who = prospect ? `${prospect.orgName ?? "?"} <${prospect.email ?? "?"}>` : "(prospekti ei saatavilla)";
  let body = typeof message.bodyText === "string" ? message.bodyText : "(ei runkoa)";
  if (body.length > 3000) body = body.slice(0, 2997) + "…";
  const lines = [
    `✉️ Outreach-luonnos — ${companyName}`,
    `Prospekti: ${who}`,
    `Sekvenssi: ${message.sequenceName ?? "⚠️ ei sekvenssiä"}`,
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

// ── scan: post new pending email_send / voice_action approvals, clean up decided ones
let companiesCache = { at: 0, list: [] };
async function listCompanies() {
  if (Date.now() - companiesCache.at < 10 * 60_000) return companiesCache.list;
  const res = await pcp("GET", "/companies");
  if (res.ok && Array.isArray(res.json)) {
    companiesCache = {
      at: Date.now(),
      list: res.json.map((c) => ({ id: c.id, name: c.name, issuePrefix: c.issuePrefix })),
    };
  }
  return companiesCache.list;
}

// Which pending approvals get a card. An aava_send that breaks the payload
// contract is logged once per process and skipped.
const badAavaLogged = new Set();
function cardKind(company, approval) {
  if (approval.type === EMAIL_SEND || approval.type === VOICE_ACTION) return approval.type;
  if (approval.type !== BOARD_APPROVAL || approval.payload?.kind !== AAVA_SEND) return null;
  if (!AAVA_COMPANY_PREFIX || company.issuePrefix !== AAVA_COMPANY_PREFIX) return null;
  if (isAavaSendPayload(approval.payload)) return AAVA_SEND;
  if (!badAavaLogged.has(approval.id)) {
    badAavaLogged.add(approval.id);
    console.error(`aava_send approval ${approval.id}: payload breaks the RK9-894 contract — no card`);
  }
  return null;
}

const signatureFor = (kind, payload) =>
  kind === VOICE_ACTION ? voiceSignature(payload) : kind === AAVA_SEND ? aavaSignature(payload) : null;

async function scan() {
  const companies = await listCompanies();
  const pendingIds = new Set();

  for (const company of companies) {
    const res = await pcp("GET", `/companies/${company.id}/approvals?status=pending`);
    if (!res.ok || !Array.isArray(res.json)) continue;
    for (const approval of res.json) {
      const kind = cardKind(company, approval);
      if (!kind) continue;
      pendingIds.add(approval.id);
      const posted = state.posted[approval.id];
      if (posted?.awaitingSince) {
        // RK9-502: a timed-out approve whose approval is still pending: once
        // settled, the old card is closed and a fresh one is posted now, so a
        // queued tap on the old card meets the stale-card check.
        if ((await settleApprove(approval.id, posted)) !== "pending") continue;
      } else if (posted && posted.sig && !posted.handling && posted.sig !== signatureFor(kind, approval.payload)) {
        await editDone(
          posted.messageId,
          kind === AAVA_SEND
            ? "♻️ Lähetyspyyntö muuttui — uusi kortti alla. Tämä kortti ei enää päde."
            : "♻️ Ehdotus muuttui — uusi kortti alla. Tämä kortti ei enää päde.",
        );
        delete state.posted[approval.id];
        saveState(state);
      } else if (posted) {
        continue;
      }
      let text;
      try {
        text =
          kind === VOICE_ACTION
            ? await renderVoiceAction(company.name, approval)
            : kind === AAVA_SEND
              ? renderAavaSend(company.name, approval)
              : renderApproval(company.name, approval);
      } catch (e) {
        console.error(`render approval ${approval.id}:`, e.message);
        continue; // retried next scan; the other cards and the cleanup still run
      }
      const msg = await tg("sendMessage", {
        chat_id: TG_CHAT,
        text,
        reply_markup: buildMarkup(approval.id, approval.type),
        // a URL in an untrusted body must not unfurl a preview into the card
        ...(kind === AAVA_SEND ? { link_preview_options: { is_disabled: true } } : {}),
      });
      if (msg?.ok) {
        const sig = signatureFor(kind, approval.payload);
        state.posted[approval.id] = {
          messageId: msg.result.message_id,
          at: Date.now(),
          type: approval.type,
          ...(sig ? { sig } : {}),
          ...(kind === AAVA_SEND ? { kind: AAVA_SEND, label: aavaLabel(approval.payload) } : {}),
        };
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
    if (entry.awaitingSince) {
      await settleApprove(approvalId, entry);
      continue;
    }
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

  if (INBOUND_ENABLED) {
    try {
      await scanInbound(companies);
    } catch (e) {
      console.error("scanInbound:", e.message);
    }
  }
}

// ── RK9-667: inbound customer email — one info card per new human message ────
const INBOUND_SNIPPET_MAX = 400;
const INBOUND_REPLY_HEADER = /^(on\s.+\swrote:|.+\skirjoitti:?)\s*$/i;

// The /body route returns the text wrapped in <untrusted_email_body ...> tags; show only the text.
// Quoted lines and everything from the first reply header on are the customer's earlier thread.
function inboundSnippet(wrapped) {
  const lines = String(wrapped ?? "").split(/\r?\n/);
  if (lines.length && /^<untrusted_email_body\b/.test(lines[0].trim())) lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === "</untrusted_email_body>") lines.pop();
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Gmail wraps long "On <date>, <name> <address> wrote:" headers over two lines.
    const joined = /^\s*on\s/i.test(line) && i + 1 < lines.length ? `${line.trim()} ${lines[i + 1].trim()}` : line;
    if (INBOUND_REPLY_HEADER.test(line.trim()) || INBOUND_REPLY_HEADER.test(joined.trim())) break;
    if (line.trimStart().startsWith(">")) continue;
    kept.push(line.trimEnd());
  }
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > INBOUND_SNIPPET_MAX) text = text.slice(0, INBOUND_SNIPPET_MAX - 1).trimEnd() + "…";
  return text;
}

function renderInboundCard(companyName, message, snippet, issue) {
  const to = Array.isArray(message.toAddresses) && message.toAddresses.length ? message.toAddresses.join(", ") : "?";
  const lines = [
    `📧 ${companyName} · uusi asiakasviesti`,
    `Lähettäjä: ${message.fromAddress ?? "?"}`,
    `Vastaanottaja: ${to}`,
    `Aihe: ${message.subject || "(ei aihetta)"}`,
  ];
  if (snippet) lines.push("", snippet);
  lines.push("");
  if (issue?.identifier) lines.push(`Tiketti ${issue.identifier} (${issue.status ?? "?"})`);
  lines.push("ℹ️ Agentti käsittelee viestin. Jos se vastaa, luonnos tulee erillisenä hyväksyntäkorttina.");
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3999) + "…" : text;
}

async function scanInbound(companies) {
  for (const company of companies) {
    const mark = state.inboundSince[company.id];
    if (!mark) {
      // first run for this company: never flood old mail
      state.inboundSince[company.id] = new Date().toISOString();
      saveState(state);
      continue;
    }
    const res = await pcp(
      "GET",
      `/companies/${company.id}/email/messages?direction=inbound&since=${encodeURIComponent(mark)}&limit=50`,
    );
    if (!res.ok || !Array.isArray(res.json)) continue;

    for (const message of res.json) {
      // createdAt (insert time) is the paging key of the list route; receivedAt can lag behind it.
      const stamp = message.createdAt;
      const advance = () => {
        const t = Date.parse(stamp ?? "");
        if (!Number.isNaN(t) && t > Date.parse(state.inboundSince[company.id])) state.inboundSince[company.id] = stamp;
        saveState(state);
      };
      if (message.classification === "automated" || message.routeKey === "outreach") {
        advance();
        continue;
      }

      let snippet = "";
      try {
        const body = await pcp("GET", `/companies/${company.id}/email/messages/${message.id}/body`);
        if (body.ok && typeof body.json?.wrapped === "string") snippet = inboundSnippet(body.json.wrapped);
      } catch (e) {
        console.error(`inbound body ${message.id}:`, e.message);
      }
      let issue = null;
      if (message.issueId) {
        try {
          const r = await pcp("GET", `/issues/${message.issueId}`);
          if (r.ok) issue = r.json;
        } catch (e) {
          console.error(`inbound issue ${message.issueId}:`, e.message);
        }
      }

      const msg = await tg("sendMessage", {
        chat_id: TG_CHAT,
        text: renderInboundCard(company.name, message, snippet, issue),
      });
      if (!msg?.ok) {
        console.error("sendMessage (inbound) failed:", msg?.description);
        return; // Telegram unhappy — retry from this message next scan
      }
      advance();
      console.log(`posted inbound ${message.id} (${company.name})`);
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
// The server writes the outcome as the deciding user after the decision. An
// agent may comment on the approval too (RK9-502), so its ✅/⚠️ text and any
// comment from before this decision are not the outcome.
async function latestOutcomeComment(approvalId, approval) {
  const res = await pcp("GET", `/approvals/${approvalId}/comments`);
  if (!res.ok || !Array.isArray(res.json)) return null;
  const decidedAt = Date.parse(approval?.decidedAt ?? "");
  const outcome = [...res.json]
    .reverse()
    .find(
      (c) =>
        /^(✅|⚠️)/.test(c.body ?? "") &&
        !c.authorAgentId &&
        // 60 s slack: decidedAt is the app clock, createdAt the database clock.
        !(Date.parse(c.createdAt ?? "") < decidedAt - 60_000),
    );
  return outcome?.body ?? null;
}

async function doApprove(approvalId, entry) {
  let res;
  try {
    res = await pcp("POST", `/approvals/${approvalId}/approve`, {
      decisionNote: "Hyväksytty Telegramista",
    });
  } catch (e) {
    console.error(`approve ${approvalId}:`, e.message);
    entry.why = e.name === "TimeoutError" ? "aikakatkaisu" : "yhteysvirhe";
    await settleApprove(approvalId, entry);
    return;
  }
  if (res.status >= 500) {
    // The route sets `approved` before its follow-up steps, and one of those
    // may fail: a 5xx leaves the result unknown, like a timeout.
    entry.why = `HTTP ${res.status}`;
    await settleApprove(approvalId, entry);
    return;
  }
  if (!res.ok) {
    await editDone(entry.messageId, `⚠️ Hyväksyntä epäonnistui (HTTP ${res.status}). Käsittele Paperclip-UI:ssa.`);
  } else if (entry.kind === AAVA_SEND) {
    // The server sends nothing for this type: the approval is the outcome.
    await editDone(entry.messageId, aavaApprovedText(entry));
  } else {
    const outcome = (await latestOutcomeComment(approvalId, res.json).catch(() => null)) ?? "✅ Hyväksytty.";
    await editDone(entry.messageId, outcome);
  }
  delete state.posted[approvalId];
  saveState(state);
}

const aavaApprovedText = (entry) =>
  `✅ Hyväksytty. Relay vie päätöksen Aavan portille, ja portti lähettää tallennetun viestin.\n${entry.label ?? ""}`.trimEnd();

// RK9-502: the approve request threw (timeout, connection lost), so its result
// is unknown. svc.approve sets `approved` before it runs the action, and the
// action can outlast the request. Read the approval and show its real state;
// never approve again. Called again by each scan until the card is settled.
// Returns the status it settled on, or null while the row stays open.
async function settleApprove(approvalId, entry) {
  entry.awaitingSince ??= Date.now();
  delete entry.handling;
  state.posted[approvalId] = entry;
  let res = null;
  try {
    res = await pcp("GET", `/approvals/${approvalId}`);
  } catch {
    /* still unreachable — the next scan asks again */
  }
  const status = res?.status === 404 ? "poistettu" : res?.ok ? res.json?.status : null;
  const age = Date.now() - entry.awaitingSince;
  const why = entry.why ?? "virhe";
  let text;
  let settled = true;
  if (!status && age > APPROVE_OUTCOME_WAIT_MS) {
    text = `⚠️ Hyväksynnän tila ei selvinnyt (${why}). Tarkista se Paperclip-UI:sta.`;
  } else if (!status) {
    text = `⚠️ Palvelin ei vastannut (${why}). Hyväksynnän tila ei selvinnyt — kortti päivittyy, kun palvelin vastaa.`;
    settled = false;
  } else if (status === "approved" && entry.kind === AAVA_SEND) {
    text = aavaApprovedText(entry);
  } else if (status === "approved") {
    const outcome = await latestOutcomeComment(approvalId, res.json).catch(() => null);
    if (outcome) {
      text = outcome;
    } else if (age > APPROVE_OUTCOME_WAIT_MS) {
      text = "✅ Hyväksytty. Toteutuksen tulos ei näkynyt — tarkista tiketti Paperclip-UI:sta.";
    } else {
      text = "⏳ Hyväksytty — palvelin toteuttaa vielä. Kortti päivittyy, kun tulos on valmis.";
      settled = false;
    }
  } else if (status === "pending" && age <= APPROVE_PENDING_GRACE_MS) {
    text = `⏳ Hyväksynnän tulos ei selvinnyt (${why}). Tarkistetaan, kirjautuiko hyväksyntä…`;
    settled = false;
  } else if (status === "pending") {
    // The scan posts a fresh card (the full proposal again) right after this.
    text = `⚠️ Hyväksyntä ei kirjautunut (${why}). Se odottaa yhä — uusi kortti tulee tähän chattiin.`;
  } else {
    text = `☑️ Käsitelty muualla (${status}).`;
  }
  if (entry.shown !== text) {
    await editDone(entry.messageId, text);
    entry.shown = text;
  }
  if (settled) delete state.posted[approvalId];
  saveState(state);
  return settled ? status : null;
}

async function doDecline(action, approvalId, entry, note) {
  const path = action === "r" ? "reject" : "request-revision";
  const res = await pcp("POST", `/approvals/${approvalId}/${path}`, { decisionNote: note });
  if (!res.ok) {
    await editDone(entry.messageId, `⚠️ ${path} epäonnistui (HTTP ${res.status}). Käsittele Paperclip-UI:ssa.`);
    delete state.posted[approvalId];
  } else if (action === "r" && entry.type === VOICE_ACTION) {
    await editDone(entry.messageId, `❌ Hylätty. Tikettiin ei tehty muutosta.\n${note}`);
    delete state.posted[approvalId];
  } else if (action === "r" && entry.kind === AAVA_SEND) {
    await editDone(entry.messageId, `❌ Hylätty. Viestiä ei lähetetä.\n${entry.label ? `${entry.label}\n` : ""}${note}`);
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
// A tap on a card whose state row has no type (posted before RK9-481) or is
// gone: the type picks the texts and whether ✏️ is allowed. The approval is
// null when the lookup fails.
async function fetchApproval(approvalId) {
  try {
    const res = await pcp("GET", `/approvals/${approvalId}`);
    return res.ok && typeof res.json?.type === "string" ? res.json : null;
  } catch {
    return null;
  }
}

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
  // RK9-502: an approve already timed out on this card and its state is still
  // being read; any tap (a queued double tap) waits instead of deciding again.
  if (state.posted[approvalId]?.awaitingSince) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Odotetaan palvelimen vastausta — kortti päivittyy." });
    return;
  }
  const entry = state.posted[approvalId] ?? { messageId: cq.message.message_id };
  // Rows posted before RK9-481 and rows lost from state.json carry no type.
  if (!entry.type) {
    const approval = await fetchApproval(approvalId);
    entry.type = approval?.type ?? null;
    if (approval?.type === BOARD_APPROVAL && approval.payload?.kind === AAVA_SEND) entry.kind = AAVA_SEND;
  }
  const isVoice = entry.type === VOICE_ACTION;
  const isAava = entry.kind === AAVA_SEND;

  // RK9-894: this listener only ever posts Aava cards of the generic board
  // type. Any other request_board_approval (e.g. a tool-gateway formal
  // approval) is never decided from Telegram.
  if (entry.type === BOARD_APPROVAL && !isAava) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Tätä hyväksyntää ei käsitellä Telegramissa — käytä Paperclip-UI:ta." });
    return;
  }

  // Only the email_send card has a ✏️ button; a forged `pa:v` must not reach
  // request-revision. An unknown type (state lost, lookup failed) is refused too.
  if (action === "v" && entry.type !== EMAIL_SEND) {
    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: isVoice
        ? "Grok-ehdotukselle ei pyydetä revisiota."
        : isAava
          ? "Aavan lähetykselle ei pyydetä revisiota."
          : "Hyväksynnän tyyppi ei selvinnyt — käsittele Paperclip-UI:ssa.",
    });
    return;
  }

  // A ✅ must come from the card the listener last posted for this approval: an
  // older card (re-posted after a payload change, or an edit that failed)
  // may show text that no longer applies.
  if (action === "a" && state.posted[approvalId] && cq.message?.message_id !== entry.messageId) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Kortti on vanhentunut — käytä uusinta korttia." });
    await editDone(cq.message.message_id, "⚠️ Kortti on vanhentunut. Käytä uusinta korttia.");
    return;
  }

  // RK9-894: ✅ sends mail, so the card must still show what is pending now.
  // A row lost from state.json has no signature to compare: refused, the next
  // scan posts a fresh card.
  if (action === "a" && isAava) {
    const current = await fetchApproval(approvalId);
    const fresh =
      current?.status === "pending" &&
      current.type === BOARD_APPROVAL &&
      isAavaSendPayload(current.payload) &&
      !!entry.sig &&
      aavaSignature(current.payload) === entry.sig;
    if (!fresh) {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "Lähetyspyyntö on muuttunut tai jo käsitelty — käytä uusinta korttia tai Paperclip-UI:ta.",
      });
      return;
    }
  }

  if (action === "a") {
    entry.handling = true;
    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: isVoice || isAava ? "Hyväksytään…" : "Hyväksytään ja lähetetään…",
    });
    await editDone(
      entry.messageId,
      isVoice ? "⏳ Hyväksytään — palvelin toteuttaa…" : isAava ? "⏳ Hyväksytään…" : "⏳ Hyväksytään — palvelin lähettää…",
    );
    await doApprove(approvalId, entry);
    return;
  }

  // reject / revision → ask for the note via ForceReply
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Kirjoita perustelu vastauksena." });
  const prompt = await tg("sendMessage", {
    chat_id: TG_CHAT,
    text:
      action === "r" && isVoice
        ? `❌ Hylkäys — vastaa TÄHÄN viestiin perustelulla (tallentuu decisionNoteksi, tikettiin ei tehdä muutosta).`
        : action === "r" && isAava
          ? `❌ Hylkäys — vastaa TÄHÄN viestiin perustelulla (tallentuu decisionNoteksi, viestiä ei lähetetä).`
          : action === "r"
            ? `❌ Hylkäys — vastaa TÄHÄN viestiin perustelulla (menee agentille decisionNotena).`
            : `✏️ Revisio — vastaa TÄHÄN viestiin ohjeella agentille.`,
    reply_markup: { force_reply: true },
  });
  if (prompt?.ok) {
    state.notePrompts[String(prompt.result.message_id)] = {
      action,
      approvalId,
      origMessageId: state.posted[approvalId]?.messageId ?? cq.message.message_id,
      approvalType: entry.type,
      ...(isAava ? { approvalKind: AAVA_SEND, label: entry.label } : {}),
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
  const entry = state.posted[prompt.approvalId] ?? {
    messageId: prompt.origMessageId,
    type: prompt.approvalType,
    ...(prompt.approvalKind ? { kind: prompt.approvalKind, label: prompt.label } : {}),
  };
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
