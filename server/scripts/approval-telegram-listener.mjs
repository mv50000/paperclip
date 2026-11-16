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

// `rejectOnly`: an Aava card whose content is masked offers ❌ only (RK9-894).
const buildMarkup = (approvalId, type, rejectOnly = false) => ({
  inline_keyboard: [
    [
      ...(rejectOnly
        ? []
        : [{ text: type === BOARD_APPROVAL ? "✅ Lähetä" : "✅ Hyväksy", callback_data: `pa:a:${approvalId}` }]),
      { text: "❌ Hylkää", callback_data: `pa:r:${approvalId}` },
      ...(type === EMAIL_SEND ? [{ text: "✏️ Revisio", callback_data: `pa:v:${approvalId}` }] : []),
    ],
  ],
});

// One line, at most `max` chars: titles and names must not break the card layout.
const oneLine = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  // never leave half of a surrogate pair at the cut: Telegram refuses it
  return text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "…";
};

// ── RK9-894: Aava send requests ───────────────────────────────────────────────
// The relay (RK9-903) writes this exact payload. A payload that breaks the
// contract gets no card: it never reaches the operator half-rendered.
const AAVA_GATE_ID_RE = /^g-[0-9a-f]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@<>"]{1,200}@[^\s@<>"]{1,200}$/;
const isEmail = (v) => typeof v === "string" && EMAIL_RE.test(v);
// The approvals API masks credential-looking values before it answers
// (redactEventPayload, server/src/redaction.ts REDACTED_EVENT_VALUE and
// adapter-utils REDACTED_COMMAND_TEXT_VALUE: both this exact string).
const REDACTED_MARK = "***REDACTED***";

// null: no card. { masked: true }: the card cannot show the message the gate
// would send (a masked value, or no valid sha256), so it offers ❌ only.
function aavaShape(p) {
  if (
    !p ||
    typeof p !== "object" ||
    p.kind !== AAVA_SEND ||
    p.version !== 1 ||
    typeof p.gateId !== "string" ||
    !AAVA_GATE_ID_RE.test(p.gateId) ||
    (p.op !== "reply" && p.op !== "new") ||
    typeof p.from !== "string" ||
    !Array.isArray(p.to) ||
    p.to.length === 0 ||
    !p.to.every((a) => typeof a === "string") ||
    typeof p.subject !== "string" ||
    typeof p.body !== "string" ||
    !Array.isArray(p.reasons) ||
    !p.reasons.every((r) => typeof r === "string")
  ) {
    return null;
  }
  const masked =
    [p.from, ...p.to, p.subject, p.body].some((v) => v.includes(REDACTED_MARK)) ||
    typeof p.sha256 !== "string" ||
    !SHA256_RE.test(p.sha256);
  if (!masked && !(isEmail(p.from) && p.to.every(isEmail))) return null;
  return { masked };
}

// Only an unmasked, contract-true payload may be approved.
const isAavaSendPayload = (p) => aavaShape(p)?.masked === false;

// What an Aava card shows, plus the hash the gate checks. A changed signature
// closes the open card and posts a fresh one (same rule as voiceSignature).
const aavaSignature = (payload) => {
  const p = payload ?? {};
  return JSON.stringify([p.gateId, p.op, p.from, p.to, p.subject, p.body, p.reasons, p.sha256]);
};

// Bidi overrides/isolates can reorder an address on screen; C0 controls have no
// business in a card.
// Zero-width and other invisible format characters can hide inside an address.
const UNSAFE_CHARS_RE =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Telegram turns /cmd, @name, #tag and $TAG in plain text into tappable
// entities. A WORD JOINER after the sigil keeps the look and breaks the entity.
const AUTOLINK_SIGIL_RE = /([/@#$])(?=[\p{L}\p{N}_])/gu;
// Characters a Telegram client draws as nothing (format characters, Unicode
// default-ignorables, tag characters, variation selectors, Hangul fillers, C0
// controls other than the line breaks). The card strips them, so a message
// that holds any cannot be shown in full (RK9-894 verifier round 2).
const INVISIBLE_RE =
  /[\p{Cf}\u0000-\u0008\u000e-\u001f\u007f\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2060-\u206f\u3164\ufe00-\ufe0f\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;
const neutralize = (text) => String(text ?? "").replace(UNSAFE_CHARS_RE, "").replace(INVISIBLE_RE, "").replace(/\p{Cs}/gu, "").replace(AUTOLINK_SIGIL_RE, "$1\u2060");
// A header value: one line, neutralised, at most `max` chars.
const headerText = (value, max) => oneLine(neutralize(String(value ?? "").split(LINE_BREAK_RE).join(" ")), max);

// <aava-charset>
// RK9-894 (orchestrator, binding after verifier round 4): ✅ is offered only
// when from, to, subject and body consist of a closed list of characters the
// operator can read off the card. Unicode classes are not used on purpose: a
// class such as So holds blanks (U+2800) and line breaks were missed. Emoji
// and other scripts stay ❌-only; the gate normalises outgoing text to the
// same list in a separate ticket. This block is self-contained: the test
// evaluates it on its own and walks U+0000–U+10FFFF through it.
const AAVA_EXTRA_CODE_POINTS = new Set([
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026, 0x20ac,
]);
function isAavaTextCodePoint(cp) {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0x17f && cp !== 0xad) || AAVA_EXTRA_CODE_POINTS.has(cp);
}

// Reason codes as hosts/aava/aava-gate.py emits them (RK9-903, exact strings).
// Maps, not object literals: "constructor" must not resolve to a function.
const AAVA_REASON_LABELS = new Map([
  ["new-recipient", "uusi vastaanottaja"],
  ["added-recipient", "lisätty vastaanottaja"],
  ["own-address", "vastaanottaja on oma osoite"],
  ["brand-address", "vastaanottaja on brändiosoite"],
  ["not-own-address", "osoite ei ole Aavan oma"],
  ["reply-to-mismatch", "Reply-To eroaa lähettäjästä"],
  ["reply-to-bad", "virheellinen Reply-To"],
  ["no-message-id", "emoviestiltä puuttuu Message-ID"],
  ["auto", "emoviesti on automaattiposti"],
  ["caller-hold", "Aava pyysi hyväksyntää"],
  ["free-replies-off", "kaikki posti hyväksytetään"],
]);
const AAVA_DMARC_LABELS = new Map([
  ["no-received", "ei Received-otsaketta"],
  ["no-auth-results", "ei Authentication-Results-otsaketta"],
  ["authserv", "väärä tarkistuspalvelin"],
  ["no-dmarc", "ei DMARC-tulosta"],
  ["ambiguous", "monitulkintainen tulos"],
  ["header-from", "From-otsake ei täsmää"],
]);
const AAVA_REASON_TOKEN_RE = /^[a-z0-9_-]{1,40}$/;
const AAVA_REASONS_MAX = 10;
// A flood of lines pushes the buttons far from the headers (round 5, M1).
const AAVA_BODY_LINES_MAX = 120;
const AAVA_BLANK_LINES_MAX = 2;
// The contract fields plus the relay's four web-UI fields (RK9-903). Any other
// key (cc, bcc, attachments, …) might change what is sent: ✅ is blocked.
const AAVA_PAYLOAD_KEYS = new Set([
  "kind", "version", "gateId", "op", "from", "to", "subject", "body", "reasons", "sha256", "createdAt",
  "title", "summary", "recommendedAction", "proposedComment",
]);

// The plain-language label of a gate reason code, or null for an unknown code.
function aavaReasonLabel(code) {
  if (typeof code !== "string") return null;
  if (AAVA_REASON_LABELS.has(code)) return AAVA_REASON_LABELS.get(code);
  if (code.startsWith("screen:")) {
    const hit = code.slice("screen:".length);
    return AAVA_REASON_TOKEN_RE.test(hit) ? `seula: ${hit}` : null;
  }
  if (code.startsWith("dmarc:")) {
    const why = code.slice("dmarc:".length);
    if (AAVA_DMARC_LABELS.has(why)) return `DMARC ei läpäissyt (${AAVA_DMARC_LABELS.get(why)})`;
    const result = why.startsWith("dmarc-") ? why.slice("dmarc-".length) : "";
    return AAVA_REASON_TOKEN_RE.test(result) ? `DMARC ei läpäissyt (tulos ${result})` : null;
  }
  return null;
}

// Each rule returns { field, rule, codePoint? } for the first thing that blocks ✅.
function aavaTextBlocker(field, value, multiline) {
  const text = multiline ? value.replace(/\r\n/g, "\n") : value;
  // only line breaks and spaces count as empty too (round 5, L1)
  if (/^[\n ]*$/.test(text)) return { field, rule: "empty" };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (multiline && cp === 0x0a) continue;
    if (!isAavaTextCodePoint(cp)) return { field, rule: "char", codePoint: cp };
  }
  if (!multiline && (text.startsWith(" ") || text.endsWith(" "))) return { field, rule: "edge-space" };
  const lines = multiline ? text.split("\n") : [text];
  if (lines.length > AAVA_BODY_LINES_MAX) return { field, rule: "too-many-lines" };
  let blankRun = 0;
  for (const line of lines) {
    if (line.includes("  ")) return { field, rule: "space-run" };
    // the plain-text signature delimiter "-- " is the one line that may end in a space
    if (multiline && line !== "-- " && line.endsWith(" ")) return { field, rule: "trailing-space" };
    blankRun = line === "" ? blankRun + 1 : 0;
    if (blankRun > AAVA_BLANK_LINES_MAX) return { field, rule: "blank-run" };
  }
  return null;
}

function aavaAddressBlocker(field, value) {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp < 0x21 || cp > 0x7e) return { field, rule: "char", codePoint: cp };
  }
  return /^[^@<>"]{1,200}@[^@<>"]{1,200}$/.test(value) ? null : { field, rule: "address" };
}

function aavaReasonsBlocker(reasons) {
  if (reasons.length > AAVA_REASONS_MAX) return { field: "reasons", rule: "too-many" };
  for (const r of reasons) if (aavaReasonLabel(r) === null) return { field: "reasons", rule: "unknown-reason" };
  return null;
}

// null: the character and spacing rules allow ✅. Expects a payload that
// passed aavaShape (strings and arrays of strings).
function aavaApprovalBlocker(p) {
  const unknownKey = Object.keys(p).find((k) => !AAVA_PAYLOAD_KEYS.has(k));
  if (unknownKey !== undefined) return { field: "payload", rule: "unknown-field", key: unknownKey };
  return (
    aavaAddressBlocker("from", p.from) ??
    p.to.reduce((found, a) => found ?? aavaAddressBlocker("to", a), null) ??
    aavaTextBlocker("subject", p.subject, false) ??
    aavaTextBlocker("body", p.body, true) ??
    aavaReasonsBlocker(p.reasons)
  );
}
// </aava-charset>

const AAVA_FIELD_LABELS = { payload: "Payload", from: "From", to: "To", subject: "Aihe", body: "Runko", reasons: "Syyt" };
const AAVA_RULE_TEXTS = {
  empty: "tyhjä",
  "edge-space": "välilyönti alussa tai lopussa",
  "space-run": "useampi välilyönti peräkkäin",
  "trailing-space": "välilyönti rivin lopussa",
  address: "virheellinen osoite",
  "too-many": `yli ${AAVA_REASONS_MAX} syytä`,
  "unknown-reason": "tuntematon syykoodi",
  "too-many-lines": `yli ${AAVA_BODY_LINES_MAX} riviä`,
  "blank-run": `yli ${AAVA_BLANK_LINES_MAX} tyhjää riviä peräkkäin`,
};
const aavaBlockerLine = (b) =>
  `⛔ ✅ estetty — ${AAVA_FIELD_LABELS[b.field]}: ${
    b.rule === "char"
      ? `kielletty merkki U+${b.codePoint.toString(16).toUpperCase().padStart(4, "0")}`
      : b.rule === "unknown-field"
        ? `tuntematon kenttä "${headerText(b.key, 40)}"`
        : AAVA_RULE_TEXTS[b.rule]
  }. Hyväksy Paperclip-UI:ssa, jos viesti on kunnossa.`;

// Display only: an unknown code (which blocks ✅) is shown neutralised.
const aavaReason = (code) => aavaReasonLabel(code) ?? headerText(code, 60);
// Placeholders use ⟨ ⟩, which are outside the list: a card that offers ✅
// can never show text that looks like a placeholder.
const AAVA_EMPTY_SUBJECT = "⟨tyhjä aihe⟩";
const AAVA_EMPTY_BODY = "⟨tyhjä runko⟩";

// Telegram's cap is 4096 chars; String#length counts UTF-16 units, which is
// never less than the char count, so this budget leaves room for the footer.
const AAVA_CARD_MAX = 3900;
const AAVA_RECIPIENTS_SHOWN = 20;
const AAVA_ADDRESS_MAX = 200;
const AAVA_TO_LINE_MAX = 1200;
const AAVA_SUBJECT_MAX = 300;
const AAVA_REASONS_SHOWN = 10;
const AAVA_INCOMPLETE_LINE = "✂️ Kortti ei näytä koko viestiä. Hyväksy se Paperclip-UI:ssa.";

function aavaRecipients(to) {
  const shown = to.slice(0, AAVA_RECIPIENTS_SHOWN).map((a) => headerText(a, AAVA_ADDRESS_MAX));
  const more = to.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` (+${more} muuta)` : ""}`;
}

// Shown after the decision, so a decided card still says what it was about.
const aavaLabel = (p) => `To: ${headerText(aavaRecipients(p.to), 300)}\nAihe: ${headerText(p.subject, 200) || AAVA_EMPTY_SUBJECT}`;

// Every header is bounded, so the head stays near 3000 chars and the body
// always has room. `complete` is false when the card cannot show the whole
// message (masked content, a cut header, hidden recipients, a cut body): the
// operator must not approve what they did not see, so such a card offers ❌
// only and ✅ is refused (orchestrator decision, RK9-894).
function renderAavaSend(companyName, approval, masked) {
  const p = approval.payload;
  let complete = !masked;
  const hdr = (value, max) => {
    if (headerText(value, Infinity).length > max) complete = false;
    return headerText(value, max);
  };

  const recipients = p.to.slice(0, AAVA_RECIPIENTS_SHOWN).map((a) => hdr(a, AAVA_ADDRESS_MAX));
  if (p.to.length > AAVA_RECIPIENTS_SHOWN) complete = false;
  const more = p.to.length > recipients.length ? ` (+${p.to.length - recipients.length} muuta)` : "";
  let toLine = recipients.join(", ");
  if (toLine.length + more.length > AAVA_TO_LINE_MAX) {
    complete = false;
    toLine = oneLine(toLine, AAVA_TO_LINE_MAX - more.length);
  }
  toLine += more;
  const reasons = p.reasons.slice(0, AAVA_REASONS_SHOWN).map(aavaReason);
  if (p.reasons.length > reasons.length) reasons.push(`+${p.reasons.length - reasons.length} muuta`);

  const head = [
    `📨 Aava: lähetys odottaa — ${headerText(companyName, 100)}`,
    `From: ${hdr(p.from, AAVA_ADDRESS_MAX)}`,
    `To${p.to.length > 1 ? ` (${p.to.length})` : ""}: ${toLine}`,
    `Aihe: ${hdr(p.subject, AAVA_SUBJECT_MAX) || AAVA_EMPTY_SUBJECT}`,
    `Tyyppi: ${p.op === "reply" ? "vastaus ketjuun" : "uusi viesti"}`,
    `Syyt: ${reasons.length ? reasons.join(", ") : "⟨ei syitä⟩"}`,
  ];
  if (masked) head.push("⚠️ Sisältöä on peitetty, viesti ei vastaa lähtevää. Tätä ei voi hyväksyä.");
  const blocker = aavaApprovalBlocker(p);
  if (blocker) {
    complete = false;
    head.push(aavaBlockerLine(blocker));
  }
  const tail = [
    `Tunniste: ${p.gateId} · sha256 ${
      typeof p.sha256 === "string" && SHA256_RE.test(p.sha256) ? `${p.sha256.slice(0, 12)}…` : "puuttuu tai virheellinen"
    }`,
    "──────────",
  ];

  // The incomplete line is decided after the body, so its room is reserved
  // now. The title is counted at its longest (company name cut at 100), so
  // `complete` does not depend on the company name: the tap-time check in
  // aavaApprovable renders without it and must reach the same answer.
  const headLength = [`${head[0].split(" — ")[0]} — ${"x".repeat(100)}`, ...head.slice(1), AAVA_INCOMPLETE_LINE, ...tail].join("\n").length;
  const footer = (shown) => `\n──────────\n✂️ Runko katkaistu: näytetty ${shown} / ${p.body.length} merkkiä.`;
  const budget = AAVA_CARD_MAX - headLength - footer(p.body.length).length;
  const bodyLines = p.body.length ? p.body.split(LINE_BREAK_RE) : [AAVA_EMPTY_BODY];
  let body = "";
  let shownChars = 0;
  let truncated = false;
  for (const raw of bodyLines) {
    const line = `\n│ ${neutralize(raw)}`;
    if (body.length + line.length <= budget) {
      body += line;
      shownChars += raw.length + 1;
      continue;
    }
    let part = line.slice(0, Math.max(0, budget - body.length - 1));
    // never leave half of a surrogate pair at the cut
    if (/[\ud800-\udbff]$/.test(part)) part = part.slice(0, -1);
    if (part.length > 3) {
      body += part + "…";
      shownChars += Math.max(0, part.length - 3);
    }
    truncated = true;
    break;
  }
  if (truncated) {
    complete = false;
    body += footer(Math.min(shownChars, p.body.length));
  }
  if (!complete && !masked && !blocker) head.push(AAVA_INCOMPLETE_LINE);
  return { text: [...head, ...tail].join("\n") + body, complete };
}

// RK9-894: the relay creates its approvals with a board key. An agent-created
// approval always carries requestedByAgentId (the route fills in the caller),
// so an aava_send from an agent is a forgery attempt and gets no card.
const isBoardCreated = (approval) => !approval?.requestedByAgentId;

// ✅ is allowed only on a board-created, unmasked, contract-true payload that
// the card can show in full.
const aavaApprovable = (approval) =>
  isBoardCreated(approval) && isAavaSendPayload(approval.payload) && renderAavaSend("", approval, false).complete;

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
  if (aavaShape(approval.payload) && isBoardCreated(approval)) return AAVA_SEND;
  if (!badAavaLogged.has(approval.id)) {
    badAavaLogged.add(approval.id);
    console.error(
      `aava_send approval ${approval.id}: ${
        isBoardCreated(approval) ? "payload breaks the RK9-894 contract" : "created by an agent, not the relay"
      } — no card`,
    );
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
      let rejectOnly = false;
      try {
        if (kind === AAVA_SEND) {
          const card = renderAavaSend(company.name, approval, aavaShape(approval.payload).masked);
          text = card.text;
          rejectOnly = !card.complete;
        } else {
          text =
            kind === VOICE_ACTION ? await renderVoiceAction(company.name, approval) : renderApproval(company.name, approval);
        }
      } catch (e) {
        console.error(`render approval ${approval.id}:`, e.message);
        continue; // retried next scan; the other cards and the cleanup still run
      }
      const msg = await tg("sendMessage", {
        chat_id: TG_CHAT,
        text,
        reply_markup: buildMarkup(approval.id, approval.type, rejectOnly),
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
      // RK9-903: the relay rejects an expired or gate-rejected request with a
      // decisionNote ("Vanhentunut (72 h), relay sulki."); show it on Aava cards.
      const note = entry.kind === AAVA_SEND && typeof res.json?.decisionNote === "string" ? res.json.decisionNote : "";
      await editDone(
        entry.messageId,
        note
          ? `☑️ Käsitelty muualla (${status}): ${headerText(note, 300)}\n${entry.label ?? ""}`.trimEnd()
          : `☑️ Käsitelty muualla (${status ?? "poistettu"}).`,
      );
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

  // A ✅ whose approval type is unknown (state row lost and the lookup failed)
  // cannot pass the per-type checks below: refused.
  if (action === "a" && !entry.type) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Hyväksynnän tyyppi ei selvinnyt — käsittele Paperclip-UI:ssa." });
    return;
  }

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
    const pending = current?.status === "pending" && current.type === BOARD_APPROVAL;
    const fresh = pending && aavaApprovable(current) && !!entry.sig && aavaSignature(current.payload) === entry.sig;
    if (!fresh) {
      const shape = pending ? aavaShape(current.payload) : null;
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: shape?.masked
          ? "Sisältöä on peitetty — tätä ei voi hyväksyä. Hylkää tai käsittele Paperclip-UI:ssa."
          : shape && isBoardCreated(current) && aavaSignature(current.payload) === entry.sig
            ? "Kortti ei näytä koko viestiä — hyväksy se Paperclip-UI:ssa."
            : "Lähetyspyyntö on muuttunut tai jo käsitelty — käytä uusinta korttia tai Paperclip-UI:ta.",
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
