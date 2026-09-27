// Periodic escalation: any inbound email whose linked issue is still open
// past the route's escalate_after_hours threshold gets a notification
// emailed to the company's CEO (default: mv@rk9.fi).
//
// We use a simple in-process interval (default 1 hour). Each tick queries
// across ALL companies in one pass — small instances, low cost. If we ever
// scale to dozens of companies with high inbound volume we can switch to a
// per-company scheduled routine.
//
// Persistence: `rk9_email_messages.escalated_at` is the marker. Set it BEFORE
// sending so a restart in the middle does not double-escalate.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyEmailConfig,
  rk9EmailMessages,
  emailRoutes,
  issues,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { EmailService } from "./index.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_CEO_EMAIL = process.env.PAPERCLIP_CEO_EMAIL ?? "mikko-ville.lahti@rk9.fi";

interface EscalationCandidate {
  companyId: string;
  emailMessageId: string;
  issueId: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  fromAddress: string;
  subject: string | null;
  receivedAt: Date | null;
  routeKey: string | null;
  escalateAfterHours: number;
  sendingDomain: string;
}

async function findCandidates(db: Db): Promise<EscalationCandidate[]> {
  // Inbound messages with a linked issue still open AND past escalate_after_hours.
  const rows = await db
    .select({
      companyId: rk9EmailMessages.companyId,
      emailMessageId: rk9EmailMessages.id,
      issueId: rk9EmailMessages.issueId,
      issueTitle: issues.title,
      issueStatus: issues.status,
      fromAddress: rk9EmailMessages.fromAddress,
      subject: rk9EmailMessages.subject,
      receivedAt: rk9EmailMessages.receivedAt,
      routeKey: rk9EmailMessages.routeKey,
      escalateAfterHours: emailRoutes.escalateAfterHours,
      sendingDomain: companyEmailConfig.sendingDomain,
    })
    .from(rk9EmailMessages)
    .leftJoin(issues, eq(rk9EmailMessages.issueId, issues.id))
    .leftJoin(
      emailRoutes,
      and(
        eq(emailRoutes.companyId, rk9EmailMessages.companyId),
        eq(emailRoutes.routeKey, rk9EmailMessages.routeKey),
      ),
    )
    .leftJoin(companyEmailConfig, eq(companyEmailConfig.companyId, rk9EmailMessages.companyId))
    .where(
      and(
        eq(rk9EmailMessages.direction, "inbound"),
        isNull(rk9EmailMessages.escalatedAt),
        // Automated (noreply/bulk) mail never escalates — the Instagram-spam
        // path that flooded the CEO inbox (RK9-81).
        isNull(rk9EmailMessages.classification),
        // received_at + escalate_after_hours hours <= now()
        sql`${rk9EmailMessages.receivedAt} + (${emailRoutes.escalateAfterHours} * interval '1 hour') <= now()`,
      ),
    );

  // Filter: issue must still be open (not done, not cancelled).
  return rows
    .filter((r): r is typeof r & {
      escalateAfterHours: number;
      sendingDomain: string;
    } => r.escalateAfterHours != null && r.sendingDomain != null)
    .filter((r) => {
      if (!r.issueId) return false; // no linked issue → noise; skip
      const status = r.issueStatus ?? "";
      // Backlog = unrouted/catch-all triage queue; it must page nobody.
      return (
        status !== "done" &&
        status !== "cancelled" &&
        status !== "archived" &&
        status !== "backlog"
      );
    });
}

async function escalateOne(
  db: Db,
  service: EmailService,
  candidate: EscalationCandidate,
  ceoEmail: string,
): Promise<void> {
  // Mark escalated_at FIRST to prevent double-fire on a restart mid-flight.
  await db
    .update(rk9EmailMessages)
    .set({ escalatedAt: new Date() })
    .where(eq(rk9EmailMessages.id, candidate.emailMessageId));

  const ageHours = candidate.receivedAt
    ? Math.round((Date.now() - candidate.receivedAt.getTime()) / (60 * 60 * 1000))
    : "?";

  const body = [
    `Tässä yritykseltä saapunut sähköpostipyyntö, johon ei ole vastattu yli ${candidate.escalateAfterHours} tunnissa.`,
    "",
    `**Lähettäjä:** ${candidate.fromAddress}`,
    `**Aihe:** ${candidate.subject ?? "(ei aihetta)"}`,
    `**Saapunut:** ${candidate.receivedAt?.toISOString() ?? "?"} (${ageHours} h sitten)`,
    `**Issue:** ${candidate.issueTitle ?? candidate.issueId ?? "?"} (status: ${candidate.issueStatus ?? "?"})`,
    "",
    "Katso issue Paperclipistä toimenpiteitä varten.",
    "",
    "_Tämä on automaattinen eskalaatio Resend-integraatiosta._",
  ].join("\n");

  // Prefer the inbound route so the escalation keeps company context; if the
  // message has no route, fall back to a conventional noreply route.
  const routeKey = candidate.routeKey ?? "noreply";

  const result = await service.sendEmail({
    companyId: candidate.companyId,
    agentId: null,
    runId: null,
    routeKey,
    to: [ceoEmail],
    subject: `[Eskalaatio] ${candidate.subject ?? "Saapunut sähköposti"}`,
    bodyMarkdown: body,
    templateKey: "system.escalation",
  });

  if (!result.ok) {
    logger.warn(
      {
        companyId: candidate.companyId,
        emailMessageId: candidate.emailMessageId,
        reason: result.reason,
      },
      "escalation send failed",
    );
    // Roll back the marker so the next tick will retry.
    await db
      .update(rk9EmailMessages)
      .set({ escalatedAt: null })
      .where(eq(rk9EmailMessages.id, candidate.emailMessageId));
  } else {
    logger.info(
      {
        companyId: candidate.companyId,
        emailMessageId: candidate.emailMessageId,
      },
      "escalation sent",
    );
  }
}

export interface EmailEscalationCronHandle {
  stop(): void;
  /** Run one tick now (used by tests and on startup). */
  runNow(): Promise<void>;
}

export function startEmailEscalationCron(
  db: Db,
  service: EmailService,
  opts: { intervalMs?: number; ceoEmail?: string } = {},
): EmailEscalationCronHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ceoEmail = opts.ceoEmail ?? DEFAULT_CEO_EMAIL;

  async function tick() {
    try {
      const candidates = await findCandidates(db);
      for (const c of candidates) {
        await escalateOne(db, service, c, ceoEmail);
      }
    } catch (err) {
      logger.error({ err }, "email escalation cron tick failed");
    }
  }

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the process alive just for this timer.
  if (typeof interval.unref === "function") interval.unref();

  logger.info({ intervalMs, ceoEmail }, "email escalation cron started");

  return {
    stop: () => clearInterval(interval),
    runNow: tick,
  };
}
