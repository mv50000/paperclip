// Monitors GitHub webhook delivery health for all RK9 fork repos pointing
// at /api/github/webhooks. Polls each repo's recent deliveries via gh API,
// counts non-200 responses in the last 24h, runs synthetic endpoint probes
// (small + GitHub-PR-sized unsigned POSTs through the real proxy chain), and
// posts a Slack alert if any failures were found.
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

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { createDb, companies } from "@paperclipai/db";
import { createSlackClientService } from "../src/services/slack/client.js";
import { createChannelResolver } from "../src/services/slack/channel-resolver.js";

const execFileAsync = promisify(execFile);

const ALERT_COMPANY_NAME = "SelfEvolvingClaudeCo";
const LOOKBACK_HOURS = 24;
const STATE_FILE =
  process.env.PAPERCLIP_WEBHOOK_MONITOR_STATE ??
  "/var/lib/paperclip/webhook-monitor-state.json";

// Synthetic end-to-end probe of the webhook endpoint. Delivery history alone
// misses failures that only affect real-sized payloads: 2026-08-04 incident —
// /var/lib/nginx/body temp dir lost write perms, so every body larger than
// nginx's in-memory buffer (~16 KB, i.e. every real GitHub PR event) got a
// bare nginx 500 while small diagnostic curls returned a healthy-looking 401.
// The probe POSTs an unsigned small AND a GitHub-PR-sized body; both must
// come back 401 ("missing signature" from the app). Anything else means a
// proxy hop or the app itself is broken for that payload class.
//
// Probes run via curl, not fetch(): /etc/hosts on the paperclip host pins
// paperclip.rk9.fi to itself (no :443 there), so the edge probe needs
// --resolve to hit the real edge nginx with correct TLS SNI + Host.
const PROBE_HOST = "paperclip.rk9.fi";
const PROBE_PATH = "/api/github/webhooks";
// Edge nginx (nginx.rk9.fi) that terminates TLS for the public webhook URL.
const PROBE_EDGE_IP = process.env.PAPERCLIP_WEBHOOK_EDGE_IP ?? "192.168.1.17";
const PROBE_LARGE_BYTES = 64 * 1024; // real PR payloads are ~26–90 KB
const PROBE_TIMEOUT_SECS = 15;
// While the probe keeps failing, re-alert at most this often.
const PROBE_REALERT_HOURS = 6;

// Repos that point their webhook at paperclip.rk9.fi/api/github/webhooks.
// Hook IDs are stable; if a hook is rotated, update here.
// Owner is the repo's CURRENT GitHub owner. Hook ids are stable across an org
// transfer, but the owner in the API path is not — when a repo moves from
// mv50000 to rk9-ai its entry must be re-owned here or the monitor queries the
// wrong owner and goes blind. quantimodo-rust, saatavilla and sunspot were
// transferred to rk9-ai (RK9-26); bk and alli-audit followed (RK9-29).
// paperclip remains on mv50000 as of 2026-06-13 (transfer deferred to RK9-32,
// production-critical public fork). See cicd/docs/org-transfer-fallout.md step 6.
const MONITORED_HOOKS: Array<{ repo: string; hookId: number }> = [
  { repo: "rk9-ai/alli-audit", hookId: 611812560 },
  { repo: "mv50000/paperclip", hookId: 611812570 },
  { repo: "rk9-ai/quantimodo-rust", hookId: 611812559 },
  { repo: "rk9-ai/bk", hookId: 611812567 },
  { repo: "rk9-ai/saatavilla", hookId: 611812556 },
  // mv50000/optimi archived 2026-06-13 (RK9-28) — runner removed, repo read-only.
  { repo: "rk9-ai/sunspot", hookId: 623049264 },
  { repo: "rk9-ai/uutisvertailu", hookId: 655877295 },
  { repo: "rk9-ai/last-shadow", hookId: 657998160 },
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

interface ProbeResult {
  name: string;
  bodyBytes: number;
  status: number | null;
  ok: boolean;
  detail: string;
}

async function probeOnce(
  name: string,
  bodyBytes: number,
  targetArgs: string[],
): Promise<ProbeResult> {
  // Unsigned but structurally GitHub-shaped: JSON body + event headers.
  // The app must reject it with 401 (missing signature) — that proves the
  // request traversed every proxy hop and reached signature verification.
  const body = JSON.stringify({
    zen: "synthetic-probe",
    padding: "x".repeat(Math.max(0, bodyBytes - 64)),
  });
  const args = [
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--max-time",
    String(PROBE_TIMEOUT_SECS),
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-H",
    "X-GitHub-Event: ping",
    "-H",
    "User-Agent: paperclip-webhook-monitor-probe",
    "--data-binary",
    body,
    ...targetArgs,
  ];
  try {
    const { stdout } = await execFileAsync("curl", args);
    const status = Number.parseInt(stdout.trim(), 10) || null;
    return {
      name,
      bodyBytes: body.length,
      status,
      ok: status === 401,
      detail: status === 401 ? "401 as expected" : `HTTP ${status ?? "?"}`,
    };
  } catch (err) {
    // execFile errors embed the full command line (incl. the 64 KB body) in
    // .message — never surface that. curl's exit code is the useful part.
    const code = (err as { code?: number | string }).code;
    const curlExitHints: Record<number, string> = {
      6: "DNS resolution failed",
      7: "connection refused",
      28: "timeout",
      35: "TLS handshake failed",
      52: "empty reply",
      56: "connection reset",
    };
    const detail =
      typeof code === "number"
        ? `curl exit ${code}${curlExitHints[code] ? ` (${curlExitHints[code]})` : ""}`
        : `curl failed: ${code ?? "unknown error"}`;
    return {
      name,
      bodyBytes: body.length,
      status: null,
      ok: false,
      detail,
    };
  }
}

async function probeWebhookEndpoint(): Promise<ProbeResult[]> {
  // Edge probe = full public chain (edge nginx TLS → local nginx → app).
  // Local probe = the hop GitHub traffic hits after the edge; isolates which
  // side is broken when the edge probe fails.
  const edge = [
    "--resolve",
    `${PROBE_HOST}:443:${PROBE_EDGE_IP}`,
    `https://${PROBE_HOST}${PROBE_PATH}`,
  ];
  const local = [
    "-H",
    `Host: ${PROBE_HOST}`,
    `http://127.0.0.1${PROBE_PATH}`,
  ];
  return Promise.all([
    probeOnce("edge-small", 128, edge),
    probeOnce("edge-large", PROBE_LARGE_BYTES, edge),
    probeOnce("local-nginx-large", PROBE_LARGE_BYTES, local),
  ]);
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;
}

function buildProbeBlock(probeFailures: ProbeResult[]) {
  const lines = probeFailures.map(
    (p) =>
      `  • \`${p.name}\` (${formatBytes(p.bodyBytes)} unsigned POST) → *${p.detail}* (expected 401)`,
  );
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `:warning: *Synthetic probe failing* against \`${PROBE_HOST}${PROBE_PATH}\`:\n` +
        lines.join("\n") +
        "\nLarge-body-only failure = proxy request-body buffering broken " +
        "(2026-08-04: `/var/lib/nginx/body` perms after a stray `apt-get install nginx-light` — " +
        "fix: `sudo systemctl restart nginx` on the paperclip host).",
    },
  };
}

function buildSlackBlocks(
  unhealthy: RepoHealth[],
  probeFailures: ProbeResult[],
  lookbackHours: number,
) {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `:rotating_light: GitHub webhook delivery failures (${lookbackHours}h)`,
      },
    },
  ];
  if (unhealthy.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${unhealthy.length}* repo(s) reporting non-200 webhook responses to ` +
          "`paperclip.rk9.fi/api/github/webhooks`. Likely causes: paperclip down, " +
          "wrong git branch deployed, expired/rotated webhook secret.",
      },
    });
  }
  if (probeFailures.length > 0) {
    blocks.push(buildProbeBlock(probeFailures));
  }
  blocks.push({ type: "divider" });

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
          "Repeat with a >26 KB body (`--data-binary` a big JSON file) — real GitHub payloads are large and can fail alone. " +
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
  const [results, probes] = await Promise.all([
    Promise.all(
      MONITORED_HOOKS.map((h) => checkHook(h.repo, h.hookId, token, cutoffMs)),
    ),
    probeWebhookEndpoint(),
  ]);
  const unhealthy = results.filter((r) => r.recentFailures > 0 || r.error);
  const probeFailures = probes.filter((p) => !p.ok);
  const summary = {
    timestamp: new Date().toISOString(),
    lookbackHours: LOOKBACK_HOURS,
    healthy: results.length - unhealthy.length,
    unhealthy: unhealthy.length,
    probes,
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
    for (const p of probes) {
      const label = `probe:${p.name}`;
      console.log(
        `${label.padEnd(30)} ${p.ok ? "OK    " : "FAIL  "} ${p.detail} (${formatBytes(p.bodyBytes)})`,
      );
    }
    console.log(
      `\nSummary: ${summary.healthy}/${results.length} healthy, ${summary.unhealthy} degraded, probe ${probeFailures.length === 0 ? "OK" : "FAILING"}`,
    );
  }

  if (unhealthy.length === 0 && probeFailures.length === 0) {
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
  let probeAlertedAtIso: string | undefined;
  if (existsSync(STATE_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as {
        alertedDeliveryIds?: number[];
        probeFailureAlertedAt?: string;
      };
      for (const id of raw.alertedDeliveryIds ?? []) seenIds.add(id);
      probeAlertedAtIso = raw.probeFailureAlertedAt;
    } catch {
      // ignore corrupt state
    }
  }
  const probeAlertedAtMs = probeAlertedAtIso
    ? new Date(probeAlertedAtIso).getTime()
    : Number.NaN;
  const shouldAlertProbe =
    probeFailures.length > 0 &&
    (Number.isNaN(probeAlertedAtMs) ||
      probeAlertedAtMs < Date.now() - PROBE_REALERT_HOURS * 3600 * 1000);
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
  if (newUnhealthy.length === 0 && !shouldAlertProbe) {
    if (unhealthy.length > 0) {
      console.log(
        `All ${unhealthy.length} degraded repo(s) already alerted — suppressing.`,
      );
    }
    if (probeFailures.length > 0) {
      console.log(
        `Probe still failing but alerted at ${probeAlertedAtIso} (<${PROBE_REALERT_HOURS}h) — suppressing.`,
      );
    }
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
    const blocks = buildSlackBlocks(newUnhealthy, probeFailures, LOOKBACK_HOURS);
    const fallbackParts: string[] = [];
    if (newUnhealthy.length > 0) {
      fallbackParts.push(
        `GitHub webhook delivery failures: ${newUnhealthy.length} repo(s)`,
      );
    }
    if (probeFailures.length > 0) {
      fallbackParts.push(
        `webhook endpoint probe failing (${probeFailures.map((p) => p.name).join(", ")})`,
      );
    }
    const fallbackText = fallbackParts.join("; ");
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
        writeFileSync(
          STATE_FILE,
          JSON.stringify({
            alertedDeliveryIds: merged,
            // Keep the throttle timestamp while the probe is failing so the
            // healthy path can clear it; refresh it when this alert covered
            // a probe failure.
            probeFailureAlertedAt: shouldAlertProbe
              ? new Date().toISOString()
              : probeAlertedAtIso,
          }),
        );
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
