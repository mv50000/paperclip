// RK9-197: Prometheus text-exposition-format metrics for the outreach
// pipeline, plus the daily-digest data the host cron script formats and
// sends via `rk9_telegram_send` (see docs/implementation-notes/outreach-metrics.md
// for why this repo doesn't call Telegram directly).
//
// No `prom-client` dependency (CONSTITUTION.md blocks a `pnpm-lock.yaml`
// change on a feature branch — same reasoning `outreach-sender.md` gives for
// hand-rolling the SMTP client instead of pulling in nodemailer) — the text
// format is a handful of lines, so it's built by hand below.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { outreachEvents, outreachMessages, outreachSequences } from "@paperclipai/db";
import { effectiveDailyCap, zonedDayRange } from "./scheduler-logic.js";
import { listActivePauses } from "./sender-pauses.js";
import { getOutreachDnsblState, isDnsblListTrustworthy, type OutreachDnsblState } from "./dnsbl.js";

// --- Prometheus /metrics -----------------------------------------------------

interface SentByCompanySender {
  companyId: string;
  senderIdentity: string | null;
  count: number;
}

interface BounceByType {
  type: string;
  count: number;
}

interface SenderPausedGauge {
  senderIdentity: string;
  paused: 0 | 1;
}

export interface OutreachPrometheusMetrics {
  sent: SentByCompanySender[];
  bounce: BounceByType[];
  replyTotal: number;
  unsubscribeTotal: number;
  queueDepth: number;
  senderPaused: SenderPausedGauge[];
}

async function countEventsByType(db: Db, types: string[]) {
  return db
    .select({ type: outreachEvents.type, count: sql<number>`count(*)` })
    .from(outreachEvents)
    .where(inArray(outreachEvents.type, types))
    .groupBy(outreachEvents.type);
}

export async function collectOutreachPrometheusMetrics(db: Db): Promise<OutreachPrometheusMetrics> {
  const [sentRows, bounceRows, replyRows, unsubscribeRows, queueDepthRows, activePauses, identityRows] =
    await Promise.all([
      db
        .select({
          companyId: outreachMessages.companyId,
          senderIdentity: outreachSequences.senderIdentity,
          count: sql<number>`count(*)`,
        })
        .from(outreachMessages)
        .leftJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
        .where(eq(outreachMessages.status, "sent"))
        .groupBy(outreachMessages.companyId, outreachSequences.senderIdentity),
      countEventsByType(db, ["bounce_hard", "bounce_soft"]),
      db.select({ count: sql<number>`count(*)` }).from(outreachEvents).where(eq(outreachEvents.type, "reply")),
      db
        .select({ count: sql<number>`count(*)` })
        .from(outreachEvents)
        .where(eq(outreachEvents.type, "unsubscribe")),
      db.select({ count: sql<number>`count(*)` }).from(outreachMessages).where(eq(outreachMessages.status, "queued")),
      listActivePauses(db),
      db.selectDistinct({ senderIdentity: outreachSequences.senderIdentity }).from(outreachSequences),
    ]);

  const pausedIdentities = new Set(activePauses.map((p) => p.senderIdentity));

  return {
    sent: sentRows.map((r) => ({ companyId: r.companyId, senderIdentity: r.senderIdentity, count: Number(r.count) })),
    bounce: bounceRows.map((r) => ({ type: r.type, count: Number(r.count) })),
    replyTotal: Number(replyRows[0]?.count ?? 0),
    unsubscribeTotal: Number(unsubscribeRows[0]?.count ?? 0),
    queueDepth: Number(queueDepthRows[0]?.count ?? 0),
    senderPaused: identityRows.map((r) => ({
      senderIdentity: r.senderIdentity,
      paused: pausedIdentities.has(r.senderIdentity) ? 1 : 0,
    })),
  };
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return `${name}{${labelStr}} ${value}`;
}

export function renderOutreachPrometheusText(metrics: OutreachPrometheusMetrics): string {
  const dnsbl = getOutreachDnsblState();
  const lines: string[] = [];

  lines.push("# HELP outreach_sent_total Outreach messages sent, by company and sender identity.");
  lines.push("# TYPE outreach_sent_total counter");
  for (const r of metrics.sent) {
    lines.push(metricLine("outreach_sent_total", { company: r.companyId, sender: r.senderIdentity ?? "unknown" }, r.count));
  }

  lines.push("# HELP outreach_bounce_total Outreach bounce events, by type (bounce_hard, bounce_soft).");
  lines.push("# TYPE outreach_bounce_total counter");
  for (const r of metrics.bounce) {
    lines.push(metricLine("outreach_bounce_total", { type: r.type }, r.count));
  }

  lines.push("# HELP outreach_reply_total Outreach reply events.");
  lines.push("# TYPE outreach_reply_total counter");
  lines.push(`outreach_reply_total ${metrics.replyTotal}`);

  lines.push("# HELP outreach_unsubscribe_total Outreach unsubscribe events.");
  lines.push("# TYPE outreach_unsubscribe_total counter");
  lines.push(`outreach_unsubscribe_total ${metrics.unsubscribeTotal}`);

  lines.push("# HELP outreach_queue_depth Outreach messages currently queued for sending.");
  lines.push("# TYPE outreach_queue_depth gauge");
  lines.push(`outreach_queue_depth ${metrics.queueDepth}`);

  lines.push("# HELP outreach_sender_paused Whether outreach sending is auto-paused for a sender identity (1=paused).");
  lines.push("# TYPE outreach_sender_paused gauge");
  for (const r of metrics.senderPaused) {
    lines.push(metricLine("outreach_sender_paused", { sender: r.senderIdentity }, r.paused));
  }

  // RK9-225: only a list we can currently trust gets to publish a verdict. A
  // refused or failed lookup publishes nothing here — `outreach_dnsbl_list_ok`
  // below is what makes that blindness visible, so a blind list can never look
  // like a clean one (and can never fire `OutreachIpListed` either).
  lines.push("# HELP outreach_ip_listed Whether the outreach sending IP is listed on a DNSBL (1=listed). Only lists whose canary self-test and reputation lookup both succeeded are reported.");
  lines.push("# TYPE outreach_ip_listed gauge");
  for (const r of dnsbl.results) {
    if (!isDnsblListTrustworthy(dnsbl, r.list)) continue;
    lines.push(metricLine("outreach_ip_listed", { list: r.list }, r.listed ? 1 : 0));
  }

  if (dnsbl.selfTests.length > 0) {
    lines.push(
      "# HELP outreach_dnsbl_list_ok Whether this DNSBL can be trusted right now (1=canary self-test and reputation lookup both succeeded, 0=we are blind to this list).",
    );
    lines.push("# TYPE outreach_dnsbl_list_ok gauge");
    for (const r of dnsbl.selfTests) {
      lines.push(metricLine("outreach_dnsbl_list_ok", { list: r.list }, isDnsblListTrustworthy(dnsbl, r.list) ? 1 : 0));
    }
  }

  if (dnsbl.selfTest.ok !== null) {
    lines.push(
      "# HELP outreach_dnsbl_selftest_ok Whether the daily DNSBL canary self-test (127.0.0.2) succeeded (1=ok, 0=the check mechanism itself is broken).",
    );
    lines.push("# TYPE outreach_dnsbl_selftest_ok gauge");
    lines.push(`outreach_dnsbl_selftest_ok ${dnsbl.selfTest.ok ? 1 : 0}`);
  }

  return lines.join("\n") + "\n";
}

// --- Daily digest (consumed by a host cron script — see docs/implementation-notes/outreach-metrics.md) ---

export interface OutreachDigestSenderSummary {
  senderIdentity: string;
  sentToday: number;
  bounceHardToday: number;
  bounceSoftToday: number;
  repliesToday: number;
  unsubscribesToday: number;
  effectiveDailyCap: number | null;
  paused: boolean;
}

export interface OutreachDigest {
  /** Europe/Helsinki calendar date the digest covers, `YYYY-MM-DD`. */
  date: string;
  senders: OutreachDigestSenderSummary[];
  /** Ready-to-send Finnish message text — the host cron script's only job is `rk9_telegram_send "$(curl ... | jq -r .text)"`. */
  text: string;
}

async function countTodayByIdentity(
  db: Db,
  senderIdentity: string,
  type: "sent_message" | "bounce_hard" | "bounce_soft" | "reply" | "unsubscribe",
  range: { start: Date; end: Date },
): Promise<number> {
  if (type === "sent_message") {
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(outreachMessages)
      .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
      .where(
        and(
          eq(outreachSequences.senderIdentity, senderIdentity),
          eq(outreachMessages.status, "sent"),
          gte(outreachMessages.sentAt, range.start),
          sql`${outreachMessages.sentAt} < ${range.end}`,
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachEvents)
    .innerJoin(outreachMessages, eq(outreachEvents.messageId, outreachMessages.id))
    .innerJoin(outreachSequences, eq(outreachMessages.sequenceId, outreachSequences.id))
    .where(
      and(
        eq(outreachSequences.senderIdentity, senderIdentity),
        eq(outreachEvents.type, type),
        gte(outreachEvents.occurredAt, range.start),
        sql`${outreachEvents.occurredAt} < ${range.end}`,
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/**
 * RK9-225: listings and blind lists are reported separately — "emme tiedä" is
 * not "puhdas". Returns `null` when every list is clean and trustworthy, so a
 * quiet day's digest stays as short as it was before.
 */
function formatDnsblDigestLine(dnsbl: OutreachDnsblState): string | null {
  const listed = dnsbl.results.filter((r) => r.listed && isDnsblListTrustworthy(dnsbl, r.list));
  const blind = dnsbl.selfTests.filter((r) => !isDnsblListTrustworthy(dnsbl, r.list));
  const parts: string[] = [];
  if (listed.length > 0) {
    parts.push(`LISTATTU ${listed.map((r) => `${r.list} (${r.codes.join(",")})`).join(", ")}`);
  }
  if (blind.length > 0) {
    const detail = blind.map((r) => {
      const result = dnsbl.results.find((x) => x.list === r.list);
      return `${r.list} (${r.error ?? result?.error ?? "canary ei listattu"})`;
    });
    parts.push(`kysely ei onnistunut: ${detail.join(", ")}`);
  }
  if (parts.length === 0) return null;
  const ip = dnsbl.productionIp ? ` ${dnsbl.productionIp}` : "";
  return `DNSBL${ip}: ${parts.join(" | ")}`;
}

function formatDigestText(date: string, senders: OutreachDigestSenderSummary[], dnsblLine: string | null): string {
  if (senders.length === 0) {
    const empty = `Outreach-digest ${date}: ei aktiivisia lähettäjiä.`;
    return dnsblLine ? `${empty}\n${dnsblLine}` : empty;
  }
  const lines = [`Outreach-digest ${date}:`];
  for (const s of senders) {
    const status = s.paused ? " [PAUSELLA]" : "";
    const cap = s.effectiveDailyCap !== null ? `, katto ${s.effectiveDailyCap}/pv` : "";
    lines.push(
      `${s.senderIdentity}${status}: lähetetty ${s.sentToday}, bounce ${s.bounceHardToday + s.bounceSoftToday} (${s.bounceHardToday} hard), vastauksia ${s.repliesToday}, unsub ${s.unsubscribesToday}${cap}`,
    );
  }
  if (dnsblLine) lines.push(dnsblLine);
  return lines.join("\n");
}

/** All sequences (active or not) that have sent at least once, so a just-deactivated sender still shows up in today's digest. */
async function digestSenderIdentities(db: Db): Promise<Array<{ senderIdentity: string; dailyCap: number; rampSchedule: unknown; activatedAt: Date | null }>> {
  const rows = await db
    .select({
      senderIdentity: outreachSequences.senderIdentity,
      dailyCap: outreachSequences.dailyCap,
      rampSchedule: outreachSequences.rampSchedule,
      activatedAt: outreachSequences.activatedAt,
      active: outreachSequences.active,
    })
    .from(outreachSequences);
  // One row per identity — prefer an active sequence's ramp/cap when an
  // identity has more than one (paused vs. active sequence sharing it).
  const byIdentity = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byIdentity.get(row.senderIdentity);
    if (!existing || (row.active && !existing.active)) byIdentity.set(row.senderIdentity, row);
  }
  return [...byIdentity.values()];
}

export async function buildOutreachDigest(db: Db, now: Date = new Date()): Promise<OutreachDigest> {
  const tz = "Europe/Helsinki";
  const range = zonedDayRange(tz, now);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // en-CA = YYYY-MM-DD

  const sequenceRows = await digestSenderIdentities(db);
  const activePauses = await listActivePauses(db);
  const pausedIdentities = new Set(activePauses.map((p) => p.senderIdentity));

  const senders: OutreachDigestSenderSummary[] = await Promise.all(
    sequenceRows.map(async (seq) => {
      const [sentToday, bounceHardToday, bounceSoftToday, repliesToday, unsubscribesToday] = await Promise.all([
        countTodayByIdentity(db, seq.senderIdentity, "sent_message", range),
        countTodayByIdentity(db, seq.senderIdentity, "bounce_hard", range),
        countTodayByIdentity(db, seq.senderIdentity, "bounce_soft", range),
        countTodayByIdentity(db, seq.senderIdentity, "reply", range),
        countTodayByIdentity(db, seq.senderIdentity, "unsubscribe", range),
      ]);
      return {
        senderIdentity: seq.senderIdentity,
        sentToday,
        bounceHardToday,
        bounceSoftToday,
        repliesToday,
        unsubscribesToday,
        effectiveDailyCap: effectiveDailyCap(
          { dailyCap: seq.dailyCap, rampSchedule: (seq.rampSchedule as never) ?? [], activatedAt: seq.activatedAt },
          now,
        ),
        paused: pausedIdentities.has(seq.senderIdentity),
      };
    }),
  );
  senders.sort((a, b) => a.senderIdentity.localeCompare(b.senderIdentity));

  return { date, senders, text: formatDigestText(date, senders, formatDnsblDigestLine(getOutreachDnsblState())) };
}
