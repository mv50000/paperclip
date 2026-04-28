// Resend integraation diagnostiikka. Käytä ennen smoke-testiä, ennen
// rollouttia uudelle yritykselle, tai kun jotain feilaa tuotannossa.
//
// Käyttö:
//
//   # Yhteenveto kaikista yrityksistä — terveysdashboard
//   pnpm tsx scripts/resend-status.ts
//
//   # Yhden yrityksen yksityiskohtainen tila
//   pnpm tsx scripts/resend-status.ts --company-id <uuid>
//
//   # JSON ulostulo (CI/monitoring)
//   pnpm tsx scripts/resend-status.ts --company-id <uuid> --json
//
//   # Vain ne yritykset joilla on Resend-config (verified/pending/disabled)
//   pnpm tsx scripts/resend-status.ts --configured-only
//
// Skripti ON read-only — ei tee mitään muutoksia DB:hen tai Resendiin.

import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  createDb,
  companies,
  companyEmailConfig,
  companySecrets,
  emailMessages,
  emailOutboundAudit,
  emailRoutes,
  emailSuppressionList,
  emailTemplates,
  issues,
} from "@paperclipai/db";
import { secretService } from "../server/src/services/secrets.js";
import { getDomainStatus } from "../server/src/services/email/resend-client.js";
import { computeDeliverabilityRates } from "../server/src/services/email/deliverability-monitor.js";

interface Args {
  companyId: string | null;
  json: boolean;
  configuredOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { companyId: null, json: false, configuredOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--company-id":
        out.companyId = next;
        i++;
        break;
      case "--json":
        out.json = true;
        break;
      case "--configured-only":
        out.configuredOnly = true;
        break;
    }
  }
  return out;
}

interface CompanyStatus {
  companyId: string;
  companyName: string;
  config: {
    present: boolean;
    status: string | null;
    primaryDomain: string | null;
    sendingDomain: string | null;
    resendDomainId: string | null;
    maxPerAgentPerDay: number | null;
    maxPerCompanyPerDay: number | null;
    verifiedAt: string | null;
  };
  secrets: {
    apiKey: boolean;
    signingSecret: boolean;
  };
  resendDomain?: {
    status: "pending" | "verified" | "failed" | "error";
    records?: Array<{ type: string; status: string; name: string }>;
    errorMessage?: string;
  };
  routes: {
    count: number;
    sample: Array<{ localPart: string; domain: string; routeKey: string; assignedAgentId: string | null; escalateAfterHours: number; hasAutoReply: boolean }>;
  };
  templates: {
    count: number;
    keys: string[];
  };
  outbound24h: {
    total: number;
    sent: number;
    bounced: number;
    complained: number;
    bounceRate: number;
    complaintRate: number;
  };
  suppression: {
    count: number;
    breakdown: Record<string, number>;
  };
  pendingEscalations: number;
  recentInbound: Array<{ from: string; subject: string | null; receivedAt: string | null; assignedAgentId: string | null; issueId: string | null }>;
  recentAudit: Array<{ status: string; at: string; subject: string | null; to: string[]; rateLimitHit: boolean; suppressionHit: boolean; errorCode: string | null }>;
  health: "ok" | "warn" | "error" | "not_configured";
  warnings: string[];
}

async function checkCompany(
  db: Awaited<ReturnType<typeof createDb>>,
  companyId: string,
  companyName: string,
): Promise<CompanyStatus> {
  const warnings: string[] = [];

  // Email config
  const [config] = await db
    .select()
    .from(companyEmailConfig)
    .where(eq(companyEmailConfig.companyId, companyId));

  // Secrets
  const secretRows = await db
    .select({ name: companySecrets.name })
    .from(companySecrets)
    .where(eq(companySecrets.companyId, companyId));
  const secretNames = new Set(secretRows.map((r) => r.name));
  const hasApiKey = secretNames.has("resend.api_key");
  const hasSigningSecret = secretNames.has("resend.signing_secret");

  // Routes
  const routes = await db
    .select()
    .from(emailRoutes)
    .where(eq(emailRoutes.companyId, companyId));

  // Templates
  const templates = await db
    .select({ key: emailTemplates.key, locale: emailTemplates.locale })
    .from(emailTemplates)
    .where(eq(emailTemplates.companyId, companyId));

  // Outbound 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const outboundRows = await db
    .select({
      status: emailMessages.status,
      count: sql<number>`count(*)::int`,
    })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.companyId, companyId),
        eq(emailMessages.direction, "outbound"),
        gt(emailMessages.createdAt, since),
      ),
    )
    .groupBy(emailMessages.status);
  const counts = { sent: 0, bounced: 0, complained: 0, total: 0 };
  for (const r of outboundRows) {
    if (r.status === "sent") counts.sent += r.count;
    else if (r.status === "bounced") counts.bounced += r.count;
    else if (r.status === "complained") counts.complained += r.count;
    counts.total += r.count;
  }
  const rates = computeDeliverabilityRates(counts);

  // Suppression breakdown
  const suppressions = await db
    .select({ reason: emailSuppressionList.reason })
    .from(emailSuppressionList)
    .where(eq(emailSuppressionList.companyId, companyId));
  const suppressionBreakdown: Record<string, number> = {};
  for (const s of suppressions) {
    suppressionBreakdown[s.reason] = (suppressionBreakdown[s.reason] ?? 0) + 1;
  }

  // Pending escalations: inbound emails past escalate_after_hours, issue still open, not yet escalated.
  const pendingEscalationsRows = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .leftJoin(issues, eq(emailMessages.issueId, issues.id))
    .leftJoin(
      emailRoutes,
      and(
        eq(emailRoutes.companyId, emailMessages.companyId),
        eq(emailRoutes.routeKey, emailMessages.routeKey),
      ),
    )
    .where(
      and(
        eq(emailMessages.companyId, companyId),
        eq(emailMessages.direction, "inbound"),
        sql`${emailMessages.escalatedAt} IS NULL`,
        sql`${emailMessages.receivedAt} + (${emailRoutes.escalateAfterHours} * interval '1 hour') <= now()`,
        sql`${issues.status} NOT IN ('done', 'cancelled', 'archived')`,
      ),
    );
  const pendingEscalations = pendingEscalationsRows.length;

  // Recent inbound (last 5)
  const recentInbound = await db
    .select()
    .from(emailMessages)
    .where(
      and(eq(emailMessages.companyId, companyId), eq(emailMessages.direction, "inbound")),
    )
    .orderBy(desc(emailMessages.receivedAt))
    .limit(5);

  // Recent audit (last 5)
  const recentAudit = await db
    .select()
    .from(emailOutboundAudit)
    .where(eq(emailOutboundAudit.companyId, companyId))
    .orderBy(desc(emailOutboundAudit.createdAt))
    .limit(5);

  // Resend domain status (only if API key + domain id present)
  let resendDomain: CompanyStatus["resendDomain"];
  if (config?.resendDomainId && hasApiKey) {
    try {
      const secrets = secretService(db);
      const apiKeySecret = await secrets.getByName(companyId, "resend.api_key");
      if (apiKeySecret) {
        const apiKey = await secrets.resolveSecretValue(companyId, apiKeySecret.id, "latest");
        const result = await getDomainStatus(apiKey, config.resendDomainId);
        if (result.ok) {
          resendDomain = {
            status: result.domain.status,
            records: result.domain.records.map((r) => ({
              type: r.type,
              status: r.status,
              name: r.name,
            })),
          };
        } else {
          resendDomain = {
            status: "error",
            errorMessage: result.errorMessage ?? `HTTP ${result.status}`,
          };
        }
      }
    } catch (err) {
      resendDomain = {
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Compute health
  let health: CompanyStatus["health"] = "ok";
  if (!config) {
    health = "not_configured";
  } else {
    if (!hasApiKey) warnings.push("resend.api_key secret missing");
    if (!hasSigningSecret) warnings.push("resend.signing_secret secret missing");
    if (config.status !== "verified") warnings.push(`config status is '${config.status}'`);
    if (resendDomain && resendDomain.status !== "verified") {
      warnings.push(`Resend domain status is '${resendDomain.status}'`);
    }
    if (routes.length === 0) warnings.push("no email_routes configured");
    if (rates.bounceRate > 0.05 && counts.total >= 20) {
      warnings.push(`bounce rate ${(rates.bounceRate * 100).toFixed(1)}% exceeds 5% threshold`);
    }
    if (pendingEscalations > 0) {
      warnings.push(`${pendingEscalations} pending escalation(s) waiting for the next cron tick`);
    }
    if (warnings.length === 0) health = "ok";
    else if (
      !hasApiKey ||
      !hasSigningSecret ||
      config.status !== "verified" ||
      (resendDomain && resendDomain.status !== "verified") ||
      rates.bounceRate > 0.05
    ) {
      health = "error";
    } else {
      health = "warn";
    }
  }

  return {
    companyId,
    companyName,
    config: {
      present: Boolean(config),
      status: config?.status ?? null,
      primaryDomain: config?.primaryDomain ?? null,
      sendingDomain: config?.sendingDomain ?? null,
      resendDomainId: config?.resendDomainId ?? null,
      maxPerAgentPerDay: config?.maxPerAgentPerDay ?? null,
      maxPerCompanyPerDay: config?.maxPerCompanyPerDay ?? null,
      verifiedAt: config?.verifiedAt?.toISOString() ?? null,
    },
    secrets: { apiKey: hasApiKey, signingSecret: hasSigningSecret },
    resendDomain,
    routes: {
      count: routes.length,
      sample: routes.slice(0, 10).map((r) => ({
        localPart: r.localPart,
        domain: r.domain,
        routeKey: r.routeKey,
        assignedAgentId: r.assignedAgentId,
        escalateAfterHours: r.escalateAfterHours,
        hasAutoReply: r.autoReplyTemplateId != null,
      })),
    },
    templates: {
      count: templates.length,
      keys: [...new Set(templates.map((t) => `${t.key}:${t.locale}`))].sort(),
    },
    outbound24h: { ...counts, ...rates },
    suppression: { count: suppressions.length, breakdown: suppressionBreakdown },
    pendingEscalations,
    recentInbound: recentInbound.map((m) => ({
      from: m.fromAddress,
      subject: m.subject,
      receivedAt: m.receivedAt?.toISOString() ?? null,
      assignedAgentId: m.assignedAgentId,
      issueId: m.issueId,
    })),
    recentAudit: recentAudit.map((a) => ({
      status: a.status,
      at: a.createdAt.toISOString(),
      subject: a.subject,
      to: a.toAddresses,
      rateLimitHit: a.rateLimitHit,
      suppressionHit: a.suppressionHit,
      errorCode: a.errorCode,
    })),
    health,
    warnings,
  };
}

function healthIcon(health: CompanyStatus["health"]): string {
  switch (health) {
    case "ok":
      return "✓";
    case "warn":
      return "!";
    case "error":
      return "✗";
    case "not_configured":
      return "·";
  }
}

function formatHuman(s: CompanyStatus): string {
  const lines: string[] = [];
  lines.push(`# ${s.companyName} (${s.companyId.slice(0, 8)}…)`);
  lines.push(`  health: ${healthIcon(s.health)} ${s.health}`);
  if (s.warnings.length > 0) {
    for (const w of s.warnings) lines.push(`    ! ${w}`);
  }
  if (!s.config.present) {
    lines.push("  no company_email_config row — run install-resend-skill.ts to set up");
    return lines.join("\n");
  }
  lines.push(
    `  config: status=${s.config.status} domain=${s.config.primaryDomain ?? "?"} sending=${s.config.sendingDomain ?? "?"}`,
  );
  lines.push(
    `  secrets: api_key=${s.secrets.apiKey ? "yes" : "MISSING"} signing_secret=${s.secrets.signingSecret ? "yes" : "MISSING"}`,
  );
  if (s.resendDomain) {
    lines.push(
      `  resend domain: ${s.resendDomain.status}${
        s.resendDomain.errorMessage ? ` (${s.resendDomain.errorMessage})` : ""
      }`,
    );
    if (s.resendDomain.records) {
      for (const r of s.resendDomain.records) {
        lines.push(`    ${r.type.padEnd(6)} ${r.status.padEnd(8)} ${r.name}`);
      }
    }
  }
  lines.push(`  routes: ${s.routes.count} configured`);
  for (const r of s.routes.sample) {
    lines.push(
      `    ${r.localPart}@${r.domain} → routeKey=${r.routeKey} agent=${
        r.assignedAgentId ?? "(none)"
      } escalate=${r.escalateAfterHours}h auto_reply=${r.hasAutoReply ? "yes" : "no"}`,
    );
  }
  lines.push(`  templates: ${s.templates.count} (${s.templates.keys.join(", ")})`);
  lines.push(
    `  outbound 24h: total=${s.outbound24h.total} sent=${s.outbound24h.sent} bounced=${s.outbound24h.bounced} complained=${s.outbound24h.complained} bounce_rate=${(s.outbound24h.bounceRate * 100).toFixed(1)}% complaint_rate=${(s.outbound24h.complaintRate * 100).toFixed(2)}%`,
  );
  if (s.suppression.count > 0) {
    const breakdown = Object.entries(s.suppression.breakdown)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`  suppression: ${s.suppression.count} entries (${breakdown})`);
  } else {
    lines.push(`  suppression: 0 entries`);
  }
  if (s.pendingEscalations > 0) {
    lines.push(`  PENDING ESCALATIONS: ${s.pendingEscalations}`);
  }
  if (s.recentInbound.length > 0) {
    lines.push(`  recent inbound:`);
    for (const m of s.recentInbound) {
      lines.push(`    ${m.receivedAt ?? "?"} from=${m.from} subject="${m.subject ?? ""}"`);
    }
  }
  if (s.recentAudit.length > 0) {
    lines.push(`  recent outbound audit:`);
    for (const a of s.recentAudit) {
      const flags: string[] = [];
      if (a.rateLimitHit) flags.push("RATE_LIMIT");
      if (a.suppressionHit) flags.push("SUPPRESSED");
      if (a.errorCode) flags.push(`err=${a.errorCode}`);
      lines.push(
        `    ${a.at} ${a.status.padEnd(20)} → ${a.to.join(",")} ${flags.length ? `[${flags.join(" ")}]` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await createDb();

  let targets: Array<{ id: string; name: string }>;
  if (args.companyId) {
    const [c] = await db.select().from(companies).where(eq(companies.id, args.companyId));
    if (!c) {
      console.error(`company ${args.companyId} not found`);
      process.exit(2);
    }
    targets = [{ id: c.id, name: c.name }];
  } else {
    const all = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies);
    targets = all;
    if (args.configuredOnly) {
      const configured = await db
        .select({ companyId: companyEmailConfig.companyId })
        .from(companyEmailConfig);
      const ids = new Set(configured.map((c) => c.companyId));
      targets = targets.filter((t) => ids.has(t.id));
    }
  }

  const statuses: CompanyStatus[] = [];
  for (const t of targets) {
    statuses.push(await checkCompany(db, t.id, t.name));
  }

  if (args.json) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  if (statuses.length === 0) {
    console.log("(no matching companies)");
    return;
  }

  if (args.companyId) {
    console.log(formatHuman(statuses[0]));
    return;
  }

  // Multi-company summary
  console.log("# Resend status — all companies\n");
  for (const s of statuses) {
    console.log(
      `${healthIcon(s.health)} ${s.companyName.padEnd(28)} ${s.health.padEnd(15)} ${s.warnings.join("; ") || "(no warnings)"}`,
    );
  }
  const errored = statuses.filter((s) => s.health === "error");
  const warned = statuses.filter((s) => s.health === "warn");
  console.log(
    `\n${statuses.length} companies — ${statuses.filter((s) => s.health === "ok").length} ok, ${warned.length} warn, ${errored.length} error, ${statuses.filter((s) => s.health === "not_configured").length} not configured`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
