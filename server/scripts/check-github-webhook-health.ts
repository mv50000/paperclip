// Monitors GitHub webhook delivery health for all RK9 fork repos pointing
// at /api/github/webhooks. Polls each repo's recent deliveries via gh API,
// counts non-200 responses in the last 24h, and posts a Slack alert if any
// failures were found.
//
// Why this exists: 2026-04-29 incident — /opt/paperclip got checked out onto
// origin/master (upstream), the github-webhook route disappeared, and PR #78
// merge webhooks returned 404 silently for ~hours. RK-293 stayed open. The
// only signal was buried in /var/log/paperclip.log. This monitor surfaces
// that class of failure within an hour.
//
// Usage:
//   pnpm tsx scripts/check-github-webhook-health.ts
//   pnpm tsx scripts/check-github-webhook-health.ts --json    # machine-readable
//   pnpm tsx scripts/check-github-webhook-health.ts --dry-run # don't post Slack
//
// Environment:
//   GITHUB_TOKEN  - required, used for gh REST calls (GitHub PAT or app token)
//   DATABASE_URL  - inherited from paperclip env, used to read slack secrets
//
// Exits 0 on healthy, 1 on degraded (failures detected), 2 on script error.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, companies } from "@paperclipai/db";
import { createSlackClientService } from "../src/services/slack/client.js";
import { createChannelResolver } from "../src/services/slack/channel-resolver.js";

const ALERT_COMPANY_NAME = "SelfEvolvingClaudeCo";
const LOOKBACK_HOURS = 24;
const STATE_FILE =
  process.env.PAPERCLIP_WEBHOOK_MONITOR_STATE ??
  "/var/lib/paperclip/webhook-monitor-state.json";

// Repos that point their webhook at paperclip.rk9.fi/api/github/webhooks.
// Hook IDs are stable; if a hook is rotated, update here.
const MONITORED_HOOKS: Array<{ repo: string; hookId: number }> = [
  { repo: "mv50000/alli-audit", hookId: 611812560 },
  { repo: "mv50000/paperclip", hookId: 611812570 },
  { repo: "mv50000/quantimodo-rust", hookId: 611812559 },
  { repo: "mv50000/bk", hookId: 611812567 },
  { repo: "mv50000/saatavilla", hookId: 611812556 },
  { repo: "mv50000/optimi", hookId: 611812568 },
  { repo: "mv50000/sunspot", hookId: 623049264 },
];

interface Delivery {
  id: number;
  delivered_at: string;
  status_code: number;
  status: string;
  event: string;
  action: string | null;
  redelivery: boolean;
}

interface RepoHealth {
  repo: string;
  hookId: number;
  recentTotal: number;
  recentFailures: number;
  failingDeliveries: Delivery[];
  error: string | null;
}

interface Args {
  json: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false, dryRun: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

async function ghApi(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchDeliveries(
  repo: string,
  hookId: number,
  token: string,
  cutoffMs: number,
): Promise<Delivery[]> {
  // GitHub paginates hook deliveries with a cursor (returned in Link header),
  // not page numbers. 100 is the cap and almost always covers a 24h window for
  // our repos. If you need more, switch to walking the Link header's `cursor`.
  const items = (await ghApi(
    `/repos/${repo}/hooks/${hookId}/deliveries?per_page=100`,
    token,
  )) as Delivery[];
  if (!Array.isArray(items)) return [];
  return items.filter((d) => new Date(d.delivered_at).getTime() >= cutoffMs);
}

async function checkHook(
  repo: string,
  hookId: number,
  token: string,
  cutoffMs: number,
): Promise<RepoHealth> {
  try {
    const recent = await fetchDeliveries(repo, hookId, token, cutoffMs);
    const failures = recent.filter((d) => d.status_code !== 200);
    return {
      repo,
      hookId,
      recentTotal: recent.length,
      recentFailures: failures.length,
      failingDeliveries: failures.slice(0, 5),
      error: null,
    };
  } catch (err) {
    return {
      repo,
      hookId,
      recentTotal: 0,
      recentFailures: 0,
      failingDeliveries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSlackBlocks(unhealthy: RepoHealth[], lookbackHours: number) {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `:rotating_light: GitHub webhook delivery failures (${lookbackHours}h)`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${unhealthy.length}* repo(s) reporting non-200 webhook responses to ` +
          "`paperclip.rk9.fi/api/github/webhooks`. Likely causes: paperclip down, " +
          "wrong git branch deployed, expired/rotated webhook secret.",
      },
    },
    { type: "divider" },
  ];

  for (const r of unhealthy) {
    const lines: string[] = [];
    lines.push(
      `*<https://github.com/${r.repo}/settings/hooks/${r.hookId}|${r.repo}>* — ${r.recentFailures}/${r.recentTotal} deliveries failed`,
    );
    for (const d of r.failingDeliveries.slice(0, 3)) {
      lines.push(
        `  • \`${d.delivered_at}\` ${d.event}/${d.action ?? "-"} → *${d.status_code}* ${d.status}${d.redelivery ? " _(redelivery)_" : ""}`,
      );
    }
    if (r.failingDeliveries.length > 3) {
      lines.push(`  • _and ${r.failingDeliveries.length - 3} more_`);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          "Diagnosis: `curl -X POST https://paperclip.rk9.fi/api/github/webhooks` should return 401 (signature missing). " +
          "If 404, /opt/paperclip is on the wrong branch — check `sudo -u paperclip git -C /opt/paperclip status`.",
      },
    ],
  });

  return blocks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!token) {
    console.error(
      "GITHUB_TOKEN env var required (gh PAT with repo:hook:read or admin:repo_hook)",
    );
    process.exit(2);
  }

  const cutoffMs = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const results = await Promise.all(
    MONITORED_HOOKS.map((h) => checkHook(h.repo, h.hookId, token, cutoffMs)),
  );
  const unhealthy = results.filter((r) => r.recentFailures > 0 || r.error);
  const summary = {
    timestamp: new Date().toISOString(),
    lookbackHours: LOOKBACK_HOURS,
    healthy: results.length - unhealthy.length,
    unhealthy: unhealthy.length,
    results,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const r of results) {
      const status =
        r.error
          ? `ERR    ${r.error}`
          : r.recentFailures > 0
            ? `DEGRADED  ${r.recentFailures}/${r.recentTotal} failed`
            : `OK     ${r.recentTotal} deliveries, all 200`;
      console.log(`${r.repo.padEnd(30)} ${status}`);
    }
    console.log(
      `\nSummary: ${summary.healthy}/${results.length} healthy, ${summary.unhealthy} degraded`,
    );
  }

  if (unhealthy.length === 0) {
    // Healthy — clear state so the next failure alerts immediately
    if (existsSync(STATE_FILE)) {
      try {
        writeFileSync(STATE_FILE, JSON.stringify({ alertedDeliveryIds: [] }));
      } catch {
        // best-effort, fine if not writable
      }
    }
    process.exit(0);
  }

  // Deduplicate against previously-alerted delivery IDs so we don't spam
  // hourly for the same failures still inside the 24h window.
  const seenIds = new Set<number>();
  if (existsSync(STATE_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as {
        alertedDeliveryIds?: number[];
      };
      for (const id of raw.alertedDeliveryIds ?? []) seenIds.add(id);
    } catch {
      // ignore corrupt state
    }
  }
  const newFailureIds: number[] = [];
  const newUnhealthy = unhealthy
    .map((r) => ({
      ...r,
      failingDeliveries: r.failingDeliveries.filter((d) => !seenIds.has(d.id)),
    }))
    .filter((r) => r.failingDeliveries.length > 0 || r.error);
  for (const r of newUnhealthy) {
    for (const d of r.failingDeliveries) newFailureIds.push(d.id);
  }
  if (newUnhealthy.length === 0) {
    console.log(
      `All ${unhealthy.length} degraded repo(s) already alerted — suppressing.`,
    );
    process.exit(1);
  }

  if (args.dryRun) {
    console.log("--dry-run: skipping Slack alert");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL env var required");
    process.exit(2);
  }
  const db = createDb(dbUrl);
  try {
    const [target] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.name, ALERT_COMPANY_NAME));
    if (!target) {
      console.error(
        `alert company ${ALERT_COMPANY_NAME} not found — alert not posted`,
      );
      process.exit(1);
    }
    const channels = createChannelResolver(db);
    const channel = await channels.resolve(target.id, "company");
    if (!channel) {
      console.error(
        `${ALERT_COMPANY_NAME} has no slack.channel_id secret — alert not posted`,
      );
      process.exit(1);
    }
    const slack = createSlackClientService(db);
    const blocks = buildSlackBlocks(newUnhealthy, LOOKBACK_HOURS);
    const fallbackText = `GitHub webhook delivery failures: ${newUnhealthy.length} repo(s)`;
    const result = await slack.postMessage(target.id, {
      channel,
      text: fallbackText,
      blocks,
    });
    if (result.ok) {
      console.log(`Slack alert posted to ${ALERT_COMPANY_NAME} ts=${result.ts}`);
      try {
        mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        const merged = Array.from(new Set([...seenIds, ...newFailureIds]));
        writeFileSync(STATE_FILE, JSON.stringify({ alertedDeliveryIds: merged }));
      } catch (err) {
        console.warn(`Could not persist state to ${STATE_FILE}:`, err);
      }
    } else {
      console.error(`Slack alert failed: ${result.reason}`);
      process.exit(1);
    }
  } finally {
    if ("end" in db && typeof (db as { end?: () => Promise<void> }).end === "function") {
      await (db as { end: () => Promise<void> }).end();
    }
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
