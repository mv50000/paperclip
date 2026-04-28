// Daily deliverability monitor. For each company with non-trivial outbound
// volume in the last 24 hours, compute bounce_rate + complaint_rate and alert
// the CEO if either exceeds the configured threshold. We don't auto-disable
// sending in v1 — false positives during a single bad batch could lock a
// company out for hours. The CEO gets the alert and decides.

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyEmailConfig, emailMessages } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { EmailService } from "./index.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_BOUNCE_THRESHOLD = 0.05; // 5%
const DEFAULT_MIN_SAMPLE = 20;

export interface DeliverabilityStats {
  companyId: string;
  companyName: string;
  total: number;
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
}

export function computeDeliverabilityRates(stats: {
  total: number;
  bounced: number;
  complained: number;
}): { bounceRate: number; complaintRate: number } {
  if (stats.total === 0) return { bounceRate: 0, complaintRate: 0 };
  return {
    bounceRate: stats.bounced / stats.total,
    complaintRate: stats.complained / stats.total,
  };
}

export function shouldAlert(
  stats: { total: number; bounceRate: number; complaintRate: number },
  thresholds: { minSample: number; bounceThreshold: number; complaintThreshold?: number } = {
    minSample: DEFAULT_MIN_SAMPLE,
    bounceThreshold: DEFAULT_BOUNCE_THRESHOLD,
  },
): { alert: boolean; reason?: "bounce" | "complaint" } {
  if (stats.total < thresholds.minSample) return { alert: false };
  if (stats.bounceRate > thresholds.bounceThreshold) {
    return { alert: true, reason: "bounce" };
  }
  const complaintLimit = thresholds.complaintThreshold ?? thresholds.bounceThreshold / 5;
  if (stats.complaintRate > complaintLimit) {
    return { alert: true, reason: "complaint" };
  }
  return { alert: false };
}

async function gatherStats(db: Db, sinceMs: number): Promise<DeliverabilityStats[]> {
  // Companies that have email config (i.e. could plausibly send). We left-
  // join the count rows so quiet companies report total=0.
  const enabledCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .innerJoin(companyEmailConfig, eq(companyEmailConfig.companyId, companies.id))
    .where(eq(companyEmailConfig.status, "verified"));

  if (enabledCompanies.length === 0) return [];
  const ids = enabledCompanies.map((c) => c.id);

  const since = new Date(Date.now() - sinceMs);

  const rows = await db
    .select({
      companyId: emailMessages.companyId,
      status: emailMessages.status,
      count: sql<number>`count(*)::int`,
    })
    .from(emailMessages)
    .where(
      and(
        inArray(emailMessages.companyId, ids),
        eq(emailMessages.direction, "outbound"),
        gt(emailMessages.createdAt, since),
      ),
    )
    .groupBy(emailMessages.companyId, emailMessages.status);

  const byCompany = new Map<string, { sent: number; bounced: number; complained: number; total: number }>();
  for (const c of enabledCompanies) {
    byCompany.set(c.id, { sent: 0, bounced: 0, complained: 0, total: 0 });
  }
  for (const row of rows) {
    const bucket = byCompany.get(row.companyId);
    if (!bucket) continue;
    if (row.status === "sent") bucket.sent += row.count;
    else if (row.status === "bounced") bucket.bounced += row.count;
    else if (row.status === "complained") bucket.complained += row.count;
    bucket.total += row.count;
  }

  return enabledCompanies.map((c) => {
    const b = byCompany.get(c.id) ?? { sent: 0, bounced: 0, complained: 0, total: 0 };
    const rates = computeDeliverabilityRates(b);
    return {
      companyId: c.id,
      companyName: c.name,
      ...b,
      ...rates,
    };
  });
}

export interface DeliverabilityMonitorHandle {
  stop(): void;
  runNow(): Promise<DeliverabilityStats[]>;
}

export function startDeliverabilityMonitor(
  db: Db,
  service: EmailService,
  opts: {
    intervalMs?: number;
    minSample?: number;
    bounceThreshold?: number;
    ceoEmail?: string;
  } = {},
): DeliverabilityMonitorHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  const bounceThreshold = opts.bounceThreshold ?? DEFAULT_BOUNCE_THRESHOLD;
  const ceoEmail =
    opts.ceoEmail ?? process.env.PAPERCLIP_CEO_EMAIL ?? "mikko-ville.lahti@rk9.fi";

  async function tick(): Promise<DeliverabilityStats[]> {
    let stats: DeliverabilityStats[] = [];
    try {
      stats = await gatherStats(db, intervalMs);
    } catch (err) {
      logger.error({ err }, "deliverability monitor failed to gather stats");
      return [];
    }

    for (const s of stats) {
      const decision = shouldAlert(s, { minSample, bounceThreshold });
      if (!decision.alert) continue;
      const body = [
        `Yrityksen **${s.companyName}** sähköpostien deliverability-luvut viimeisten 24 h ajalta:`,
        "",
        `- Lähetetty: ${s.total}`,
        `- Onnistunut: ${s.sent}`,
        `- Bouncet: ${s.bounced} (${(s.bounceRate * 100).toFixed(1)} %)`,
        `- Complaint: ${s.complained} (${(s.complaintRate * 100).toFixed(1)} %)`,
        "",
        decision.reason === "bounce"
          ? `**Bounce-aste ylittää ${(bounceThreshold * 100).toFixed(0)} %.** Sender reputation on vaarassa — tarkista lähetyslistat ja pysäytä ongelmalliset kampanjat tarvittaessa.`
          : `**Complaint-aste on koholla.** Tämä on vakavin signaali — vastaanottajat merkitsevät viestit roskapostiksi.`,
        "",
        "_Automaattinen hälytys Paperclipin deliverability-monitorista._",
      ].join("\n");

      const result = await service.sendEmail({
        companyId: s.companyId,
        agentId: null,
        runId: null,
        routeKey: "noreply",
        to: [ceoEmail],
        subject: `[Hälytys] ${s.companyName}: bounce-aste ${(s.bounceRate * 100).toFixed(1)} %`,
        bodyMarkdown: body,
        templateKey: "system.deliverability_alert",
      });
      if (!result.ok) {
        logger.warn(
          { companyId: s.companyId, reason: result.reason },
          "deliverability alert send failed",
        );
      } else {
        logger.warn(
          { companyId: s.companyId, bounceRate: s.bounceRate, complaintRate: s.complaintRate },
          "deliverability alert sent",
        );
      }
    }
    return stats;
  }

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof interval.unref === "function") interval.unref();

  logger.info(
    { intervalMs, minSample, bounceThreshold, ceoEmail },
    "deliverability monitor started",
  );
  return {
    stop: () => clearInterval(interval),
    runNow: tick,
  };
}
