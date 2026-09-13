// RK9-194: the outreach-sender daemon. Runs on rk9-prod (NOT paperclip-01) —
// Postfix there is loopback-only (see docs/implementation-notes/outreach-mta.md
// in ~/.claude/hosts/rk9-prod/), so this is the one process allowed to dial
// it. It has no database access: it polls the Paperclip server's machine API
// for fully-composed messages, dials `localhost:25` with the raw SMTP client
// (no nodemailer — see smtp-client.ts's header comment for why), and reports
// the outcome back so the scheduler can apply retry/bounce/suppression logic.
//
// Usage:
//   PAPERCLIP_API_URL=https://paperclip.rk9.fi \
//   OUTREACH_SENDER_API_KEY=... \
//   pnpm tsx scripts/outreach-sender.ts
//
// Environment:
//   PAPERCLIP_API_URL         required, e.g. https://paperclip.rk9.fi
//   OUTREACH_SENDER_API_KEY   required, shared secret (see config.ts)
//   SMTP_HOST                 default: 127.0.0.1
//   SMTP_PORT                 default: 25
//   OUTREACH_SENDER_POLL_MS   default: 30000 (queue-empty poll interval)
//   OUTREACH_SENDER_BATCH     default: 5 (messages fetched per poll)
//
// Exits 1 on missing required config. Runs until killed (SIGINT/SIGTERM).

import { setTimeout as sleep } from "node:timers/promises";
import { jitterMs } from "../src/services/outreach/scheduler-logic.js";
import { sendMail } from "../src/services/outreach/smtp-client.js";

const API_URL = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
const API_KEY = process.env.OUTREACH_SENDER_API_KEY;
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 25);
const POLL_MS = Number(process.env.OUTREACH_SENDER_POLL_MS ?? 30_000);
const BATCH_SIZE = Number(process.env.OUTREACH_SENDER_BATCH ?? 5);

if (!API_URL || !API_KEY) {
  console.error("outreach-sender: PAPERCLIP_API_URL and OUTREACH_SENDER_API_KEY are required");
  process.exit(1);
}

interface SendQueueItem {
  id: string;
  envelopeFrom: string;
  envelopeTo: string;
  raw: string;
}

async function fetchQueue(): Promise<SendQueueItem[]> {
  const res = await fetch(`${API_URL}/api/outreach/send-queue?limit=${BATCH_SIZE}`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`send-queue fetch failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items: SendQueueItem[] };
  return body.items;
}

async function report(id: string, outcome: { outcome: "sent" } | { outcome: "failed"; smtpCode: number; response: string }) {
  const res = await fetch(`${API_URL}/api/outreach/messages/${id}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(outcome),
  });
  if (!res.ok) {
    console.error(`outreach-sender: report for ${id} failed: ${res.status} ${await res.text()}`);
  }
}

async function sendOne(item: SendQueueItem): Promise<void> {
  const result = await sendMail({
    host: SMTP_HOST,
    port: SMTP_PORT,
    envelopeFrom: item.envelopeFrom,
    envelopeTo: item.envelopeTo,
    data: item.raw,
  });
  if (result.ok) {
    console.log(`outreach-sender: sent ${item.id} to ${item.envelopeTo}`);
    await report(item.id, { outcome: "sent" });
  } else {
    console.warn(`outreach-sender: send failed ${item.id} (${result.code}): ${result.response}`);
    await report(item.id, { outcome: "failed", smtpCode: result.code, response: result.response });
  }
}

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function main() {
  console.log(`outreach-sender: polling ${API_URL} every ${POLL_MS}ms, SMTP relay ${SMTP_HOST}:${SMTP_PORT}`);
  while (!stopping) {
    let items: SendQueueItem[] = [];
    try {
      items = await fetchQueue();
    } catch (err) {
      console.error("outreach-sender: poll failed", err);
      await sleep(POLL_MS);
      continue;
    }
    if (items.length === 0) {
      await sleep(POLL_MS);
      continue;
    }
    for (const [index, item] of items.entries()) {
      if (stopping) break;
      await sendOne(item);
      // Jitter BETWEEN sends, not after the last one in a batch.
      if (index < items.length - 1) await sleep(jitterMs());
    }
  }
  console.log("outreach-sender: stopped");
}

await main();
