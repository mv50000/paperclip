// RK9-197: Prometheus text-exposition-format metrics for the outreach
// pipeline, plus the daily-digest data the host cron script formats and
// sends via `rk9_telegram_send` (see docs/implementation-notes/outreach-metrics.md
// for why this repo doesn't call Telegram directly).
//
// No `prom-client` dependency (CONSTITUTION.md blocks a `pnpm-lock.yaml`
// change on a feature branch — same reasoning `outreach-sender.md` gives for
// hand-rolling the SMTP client instead of pulling in nodemailer) — the text
// format is a handful of lines, so it's built by hand below.
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, emailMessages, outreachEvents, outreachMessages, outreachSequences } from "@paperclipai/db";
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

interface ApprovedWithoutSequenceByCompany {
  companyId: string;
  count: number;
}

export interface OutreachPrometheusMetrics {
  sent: SentByCompanySender[];
  bounce: BounceByType[];
  replyTotal: number;
  unsubscribeTotal: number;
  queueDepth: number;
  senderPaused: SenderPausedGauge[];
  // RK9-224: an `approved` message the scheduler can never reach — it only
  // promotes messages via an active sequence's join (server/src/services/outreach/scheduler.ts).
  // Should stay at 0 now that drafting always resolves a sequence; a nonzero
  // value here means something bypassed that (a direct `POST .../messages` call).
  approvedWithoutSequence: ApprovedWithoutSequenceByCompany[];
  // RK9-234: inbound mail we stored but could not route — the body is safe in
  // `email_messages`, but no issue was opened and nobody owns it. Nonzero means
  // an outreach domain is missing an `email_routes` row. Kept visible here
  // because a prospect's reply going unanswered is the most expensive silence
  // in the pipeline.
  inboundUnrouted: number;
  // RK9-235: replies that could not be threaded back to a message we sent, so
  // they were dropped. Counted from `activity_log`, not a module-level counter
  // — an in-memory tally resets on restart and reports a confident zero.
  // Unknown whether this happens at all; that is what the measurement is for.
  replyUnmatched: number;
}

async function countEventsByType(db: Db, types: string[]) {
  return db
    .select({ type: outreachEvents.type, count: sql<number>`count(*)` })
    .from(outreachEvents)
    .where(inArray(outreachEvents.type, types))
    .groupBy(outreachEvents.type);
}

export async function collectOutreachPrometheusMetrics(db: Db): Promise<OutreachPrometheusMetrics> {
  const [
    sentRows,
    bounceRows,
    replyRows,
    unsubscribeRows,
    queueDepthRows,
    activePauses,
    identityRows,
    approvedWithoutSequenceRows,
    inboundUnroutedRows,
    replyUnmatchedRows,
  ] = await Promise.all([
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
      db
        .select({ companyId: outreachMessages.companyId, count: sql<number>`count(*)` })
        .from(outreachMessages)
        .where(and(eq(outreachMessages.status, "approved"), isNull(outreachMessages.sequenceId)))
        .groupBy(outreachMessages.companyId),
      db
        .select({ count: sql<number>`count(*)` })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.direction, "inbound"),
            isNull(emailMessages.routeKey),
            isNull(emailMessages.issueId),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)` })
        .from(activityLog)
        .where(eq(activityLog.action, "outreach.reply_unmatched")),
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
    approvedWithoutSequence: approvedWithoutSequenceRows.map((r) => ({ companyId: r.companyId, count: Number(r.count) })),
    inboundUnrouted: Number(inboundUnroutedRows[0]?.count ?? 0),
    replyUnmatched: Number(replyUnmatchedRows[0]?.count ?? 0),
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

  // RK9-224: should stay at 0 — see OutreachPrometheusMetrics.approvedWithoutSequence.
  lines.push("# HELP outreach_approved_without_sequence Approved outreach messages with no sequence attached — the scheduler can never promote these to queued.");
  lines.push("# TYPE outreach_approved_without_sequence gauge");
  for (const r of metrics.approvedWithoutSequence) {
    lines.push(metricLine("outreach_approved_without_sequence", { company: r.companyId }, r.count));
  }

  // RK9-234: should stay at 0 — see OutreachPrometheusMetrics.inboundUnrouted.
  lines.push(
    "# HELP outreach_inbound_unrouted Inbound emails stored without a matching route — the body is kept, but no issue was opened and nobody owns it.",
  );
  lines.push("# TYPE outreach_inbound_unrouted gauge");
  lines.push(`outreach_inbound_unrouted ${metrics.inboundUnrouted}`);

  // RK9-235: measurement, not an alert threshold — we do not yet know whether
  // an unthreadable reply ever happens in practice.
  lines.push(
    "# HELP outreach_inbound_reply_unmatched Replies that could not be threaded back to a sent message and were dropped. Metadata only — the body is not kept (RK9-235 phase 1).",
  );
  lines.push("# TYPE outreach_inbound_reply_unmatched counter");
  lines.push(`outreach_inbound_reply_unmatched ${metrics.replyUnmatched}`);

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
  /** RK9-224: total `approved` messages with no sequence, across all companies — see `outreach_approved_without_sequence`. */
  approvedWithoutSequenceTotal: number;
  /** RK9-234: inbound mail stored with no route — a reply nobody owns. See `outreach_inbound_unrouted`. */
  inboundUnroutedTotal: number;
  /** RK9-235: replies received today that could not be threaded back to a sent message, so they were dropped. See `outreach_inbound_reply_unmatched`. */
  replyUnmatchedToday: number;
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
          // RK9-207: `lt()`, not a raw `sql` template. A raw template binds the
          // `Date` with no column type in scope, so postgres.js gets a `Date`
          // where it expects a string and the whole digest 500s — which is how
          // the daily 08:00 Telegram digest silently never sent a single time.
          lt(outreachMessages.sentAt, range.end),
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
        lt(outreachEvents.occurredAt, range.end),
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

/** RK9-224: total `approved` messages with `sequence_id IS NULL`, across all companies — see `outreach_approved_without_sequence`. */
async function countApprovedWithoutSequence(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(outreachMessages)
    .where(and(eq(outreachMessages.status, "approved"), isNull(outreachMessages.sequenceId)));
  return Number(row?.count ?? 0);
}

/** RK9-234: inbound mail we stored but could not route — see `OutreachPrometheusMetrics.inboundUnrouted`. */
async function countInboundUnrouted(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.direction, "inbound"),
        isNull(emailMessages.routeKey),
        isNull(emailMessages.issueId),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * RK9-235: today's dropped replies. The Prometheus counter is cumulative, as a
 * counter should be; the digest is a report on one day, so it asks the same
 * question with a date range. Reading `activity_log` rather than a process
 * counter is deliberate — a restart must not be able to report a clean zero.
 */
async function countReplyUnmatchedToday(db: Db, range: { start: Date; end: Date }): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.action, "outreach.reply_unmatched"),
        gte(activityLog.createdAt, range.start),
        lt(activityLog.createdAt, range.end),
      ),
    );
  return Number(row?.count ?? 0);
}

function formatDigestText(
  date: string,
  senders: OutreachDigestSenderSummary[],
  dnsblLine: string | null,
  approvedWithoutSequenceTotal: number,
  inboundUnroutedTotal: number,
  replyUnmatchedToday: number,
): string {
  const warningLine =
    approvedWithoutSequenceTotal > 0
      ? `⚠️ ${approvedWithoutSequenceTotal} hyväksyttyä viestiä ilman sekvenssiä — scheduler ei koskaan lähetä niitä (RK9-224).`
      : null;
  // A stored-but-unrouted reply is a human waiting for an answer, so it says
  // where to read it rather than just counting.
  const unroutedLine =
    inboundUnroutedTotal > 0
      ? `⚠️ ${inboundUnroutedTotal} saapunutta viestiä ilman reittiä — runko on tallessa, mutta tikettiä ei avattu eikä kukaan omista niitä (RK9-234).`
      : null;
  // Phase 1 is measurement: this line exists so the number reaches a human
  // daily instead of sitting in Prometheus where nobody is alerting on it.
  const replyUnmatchedLine =
    replyUnmatchedToday > 0
      ? `⚠️ ${replyUnmatchedToday} vastausta joita ei saatu ketjutettua lähettämäämme viestiin — pudotettu, runkoa ei ole tallessa (RK9-235).`
      : null;
  if (senders.length === 0) {
    const empty = `Outreach-digest ${date}: ei aktiivisia lähettäjiä.`;
    const lines = [empty, dnsblLine, warningLine, unroutedLine, replyUnmatchedLine].filter(
      (l): l is string => l !== null,
    );
    return lines.join("\n");
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
  if (warningLine) lines.push(warningLine);
  if (unroutedLine) lines.push(unroutedLine);
  if (replyUnmatchedLine) lines.push(replyUnmatchedLine);
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
  const approvedWithoutSequenceTotal = await countApprovedWithoutSequence(db);
  const inboundUnroutedTotal = await countInboundUnrouted(db);
  const replyUnmatchedToday = await countReplyUnmatchedToday(db, range);

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

  return {
    date,
    senders,
    approvedWithoutSequenceTotal,
    inboundUnroutedTotal,
    replyUnmatchedToday,
    text: formatDigestText(
      date,
      senders,
      formatDnsblDigestLine(getOutreachDnsblState()),
      approvedWithoutSequenceTotal,
      inboundUnroutedTotal,
      replyUnmatchedToday,
    ),
  };
}
